# 비용을 정확하게 계산하는 관리자 화면 재구현 계획

## 진단 요약 (앞선 검증 결과)
- 311원으로 표시된 과정안의 실제 계산: `(275052×0.5 + 22683×3.0)/1e6 = 0.2056 USD` → **fallback 단가(3-flash-preview)로 계산됨**.
- 원인: `app35.js`가 `model:"gemini-3.5-flash"`(prefix 없음)로 보내고 `PRICING`은 `"google/gemini-3.5-flash"` 키 → `estimateCostUsd`가 못 찾고 `{in:0.5, out:3.0}`로 fallback. 검수비(`verifyUsd ≈ 0.0017`)만 합산되어 0.207268로 저장.
- 같은 토큰을 3.5-flash 단가로 환산하면 0.6167 USD ≈ **925원** — 현재 표시의 약 3배.
- 추가 문제: 2-Tier 라우팅으로 콜마다 실제 사용 모델이 다른데 `hwpx_files.usage`는 단일 모델 단가로 합산. 또 `ai_usage_log`에 36 콜 중 0건만 기록(해당 과정안 생성 시간대) → 사후 검증조차 불가.

## 설계 원칙
1. **SSoT = `ai_usage_log`**. 비용은 항상 콜 단위 로그를 모델별로 집계해서 계산. `hwpx_files.cost_usd`는 표시용 캐시일 뿐 신뢰의 근원이 아님.
2. **모델 ID는 항상 `vendor/model` 정규형**으로 저장·조회. 클라가 보내는 raw 값을 즉시 `resolveModelId()`로 정규화.
3. **단가표(`PRICING`)는 서버 단일 출처**. 어드민이 GET `/admin/config`로 받아 그대로 표시.
4. **관리자 화면은 두 값(저장 시 캐시 vs 로그 재계산)을 나란히 보여주고 격차를 표시**해서 회계 신뢰성을 가시화.

## 1단계 — 서버 수정 (정확성 확보)

### 1.1 `lessonplan-bridge.server.ts`
- `estimateCostUsd(model, p, o)`: `PRICING[resolveModelId(model)] ?? PRICING[model] ?? { in:0.5, out:3.0 }` 순으로 조회. fallback 시 콘솔에 `[pricing-miss] model=...` 1회 경고.

### 1.2 `chat.ts`
- 응답 본문에 `modelUsed: modelInUse` 추가(클라가 모델별 토큰 누적에 사용).
- `logUsage` 내부 catch에서 `console.error("[ai_usage_log insert failed]", err)`로 가시화.

### 1.3 `save.ts` — 모델별 환산으로 시그니처 확장
- 기존: `usage:{prompt,output}` + 단일 `model` → 단일 단가 환산.
- 신규: `usageByModel: { "google/gemini-3.5-flash":{prompt,output,calls}, "google/gemini-3-flash-preview":{...} }` 받기. 각 모델별로 `estimateCostUsd` 호출 후 합산. 하위 호환 위해 구 형식도 처리(들어오면 단일 모델 환산).
- `model` 컬럼에는 "비중이 가장 큰 모델"을 저장(요약 표시용), 정확한 분해는 `usage` JSON에 그대로 보관.

### 1.4 `loadCostByDay` (`admin/$.ts`)
- 모델 정규화 후 단가 조회(1.1과 동일 로직).
- `models` 맵 키도 `resolveModelId()` 정규형으로 일원화 → "google/gemini-3.5-flash"와 "gemini-3.5-flash"가 따로 집계되는 현상 제거.
- 기간 필터 추가: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (기본 최근 30일). 현재 `limit(5000)`만으로는 누락 가능.

### 1.5 `/admin/files` 응답 보강
- `usage` JSON에서 모델별 토큰이 있으면 `byModel`로 펼쳐 반환.
- `krw_logged`(같은 `run_id`의 `ai_usage_log` 재계산값) 필드 추가. `run_id`가 있는 경우 백엔드에서 join 후 합산.

### 1.6 마이그레이션 (필요 시)
- `ai_usage_log` GRANT 점검: `GRANT SELECT, INSERT ON public.ai_usage_log TO service_role;`이 누락돼 보임 → 보강 마이그레이션. 기록 누락(36→0)의 잠재 원인.

## 2단계 — 클라이언트 수정

### 2.1 `app35.js`
- `state.usageByModel = {}` 신설. 채팅/검수 응답 받을 때 `data.modelUsed`와 `data.usage`로 누적:
  ```js
  const m = data.modelUsed || resolveDefault();
  const x = (state.usageByModel[m] ||= {prompt:0,output:0,calls:0});
  x.prompt += data.usage.promptTokenCount;
  x.output += data.usage.candidatesTokenCount;
  x.calls += 1;
  ```
- 세션 시작/복원/리셋 시 `usageByModel` 동기화.
- `saveLessonPlan()` 호출 시 `usageByModel`을 `save.ts`로 전송. 기존 `usage` 단일 합도 호환용으로 같이 보냄.
- `model: FORCE_MODEL` 전송 시 `"google/gemini-3.5-flash"` 정규형으로 통일.

## 3단계 — 관리자 화면 재구성 (`public/legacy/admin35.js`/`admin35.html`)

### 3.1 비용 카드 — 일별 표 재설계
열 구성:
| 날짜 | 세션 | 과정안 | 콜 | 토큰 | 비용(로그 재계산) |
|---|---|---|---|---|---|
- 모든 비용은 `ai_usage_log` 모델별 분해 → KRW 환산. 단일 평균 단가 표시 금지.

### 3.2 모델별 분해 패널 (신규)
- 선택 일자/기간에 대해 `model | calls | prompt | output | USD | KRW | %` 표.
- 단가 출처를 명시: "단가표 v{PRICING 버전 해시 또는 갱신일}".

### 3.3 과정안 목록 — 격차 컬럼 추가
열: `생성시각 | 파일명 | 메타 | 저장시 KRW | 로그 재계산 KRW | 격차`.
- "격차" 절댓값 ≥ 50원이면 행을 노랗게 강조.
- 행 펼치면 모델별 토큰 분해와 각 단가 표시.

### 3.4 단가/환율 패널
- `/admin/config` 응답의 `PRICING`과 `KRW_PER_USD`를 그대로 표로 표시(읽기 전용). 모달 안내 문구를 "표시 비용은 위 단가표를 기준으로 한 추정치이며, 실제 청구액은 게이트웨이 정산 기준과 다를 수 있습니다."로 명확화.

### 3.5 진단 배너 (신규)
화면 상단에 작은 배너로 다음 신호를 노출:
- 최근 24h에 `ai_usage_log` insert가 0건이면 빨강 배너 "콜 로그 누락 감지".
- `hwpx_files.cost_usd`와 로그 재계산값 격차 비율이 일정 임계(예: 30%) 이상이면 노랑 배너.

## 4단계 — 검증
1. 새 과정안 1건 생성 → `/admin/files`에서 `저장시 KRW`와 `로그 재계산 KRW`가 ±5% 이내로 일치하는지 확인.
2. 동일 토큰(275052 / 22683)을 모델 분해 없이 3.5-flash 단가만 적용했을 때 ~925원이 나오는지 단위 환산 수기 검증.
3. `select model, sum(prompt_tokens)*p/1e6 + sum(output_tokens)*o/1e6 from ai_usage_log group by model` SQL을 별도 노트북 셀에서 돌려 화면 합계와 비교.

## 영향 파일
- `src/lib/lessonplan-bridge.server.ts` — `estimateCostUsd` 정규화.
- `src/routes/api/lessonplan/chat.ts` — `modelUsed` 응답, 에러 로깅.
- `src/routes/api/lessonplan/save.ts` — `usageByModel` 처리.
- `src/routes/api/admin/$.ts` — `loadCostByDay`, `/files` 응답 보강, 기간 필터.
- `public/legacy/app35.js` — `usageByModel` 누적 및 저장 호출.
- `public/legacy/admin35.js`, `public/legacy/admin35.html` — 화면 재구성.
- 마이그레이션 1건(필요 시): `ai_usage_log` GRANT 보강.

## 비범위 (이번에 안 함)
- 단가표 자동 동기화(게이트웨이 가격 변동 자동 반영).
- 사용자/조직 단위 비용 분해.
- 비용 알림(슬랙/이메일).

필요하면 1·2단계만 먼저 머지하고 3·4단계는 후속 PR로 분리할 수 있습니다.
