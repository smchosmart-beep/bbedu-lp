# 비용 진단 강화 + 검수 비용 검토

## 사전 확인: 옵션 2(검수 모델 절감)는 사실상 이미 적용됨

`src/lib/lessonplan-bridge.server.ts`를 재확인한 결과:

```
L48: const VERIFY_FORCE_PRIMARY = false;
L57: if (stage === 99 || stage === 100) return "MID";  // = 3-flash-preview
```

검수(stage 99)·최종검토(stage 100)는 **서버 라우팅에서 이미 MID(3-flash-preview)로 강제 다운그레이드**되어 있습니다. 클라이언트가 어떤 모델을 요청해도 서버가 덮어씁니다. 즉 옵션 2의 핵심(검수 PRIMARY → MID, 비용 ~1/3)은 이미 시행 중이라 추가 절감 여지가 없습니다.

> 이번 계획에서는 **옵션 1(진단 강화)만 구현**하고, 그 결과로 노출되는 데이터를 보고 "검수 호출이 너무 잦다/본문 토큰이 너무 크다" 같은 추가 절감 방향을 다음 턴에 결정하는 것이 안전합니다.

---

## 옵션 1: 비용 구성 툴팁(본문 / 검수 / 재시도)

서버 SSoT(`ai_usage_log`)에는 `stage`·`run_id`가 이미 저장돼 있으므로 추가 스키마 변경 없이 분해 가능합니다.

### 분류 규칙

| 분류 | 조건 |
|---|---|
| **본문(build)** | `stage` ∈ 1..95 의 모든 호출 |
| **검수(verify)** | `stage` = 99 또는 100 |
| **재시도(retry, 추정)** | 같은 `(run_id, stage)`에서 2회 이상 호출 시 2회차부터 |

재시도는 별도 플래그가 없어 "동일 run_id+stage 중복 호출" 휴리스틱입니다 — 툴팁에 "추정" 표기.

### 서버 변경 — `src/routes/api/admin/$.ts` (`/files` 핸들러)

`krwLoggedByRun` 집계 루프(현재 L215–227)에 stage별 누적을 추가:

```ts
type RunAgg = {
  usd: number; calls: number;
  byModel: Record<string, {...}>;
  // 신규
  byBucket: { build: { usd: number; calls: number };
              verify: { usd: number; calls: number };
              retry:  { usd: number; calls: number } };
  stageSeen: Record<string, number>;  // `${stage}` → count
};
```

루프 안에서 `r.stage` 기준 버킷 분배:
- `stage === 99 || stage === 100` → verify
- 그 외 → build
- `stageSeen[stage]++`; 2회차부터는 같은 USD를 `retry` 버킷에도 더함(중복 합산이 아니라 "이 중 재시도로 쓰인 비용" 별도 집계 — UI에서 정보용)

`select`에 `stage` 컬럼 추가:
```ts
.select("run_id, model, stage, prompt_tokens, output_tokens")
```

응답 item에 추가 필드:
```ts
costBuckets: logged ? {
  build:  { krw: round(logged.byBucket.build.usd  * KRW),  calls },
  verify: { krw: round(logged.byBucket.verify.usd * KRW),  calls },
  retry:  { krw: round(logged.byBucket.retry.usd  * KRW),  calls },
} : null,
```

### 클라이언트 변경 — `public/legacy/admin35.js`

1. **새 헬퍼** `costBreakdownTip(f)` 추가:
   ```
   ─ 비용 구성 (로그 SSoT 기준) ─
   본문    ₩XXX  (n콜)
   검수    ₩YYY  (m콜)
   재시도† ₩ZZZ  (k콜)   † 같은 stage 중복 호출 추정
   ─────────────
   합계    ₩...
   ```
   `f.costBuckets` 없으면 기존 `tip` 그대로 폴백.

2. **로그 재계산 셀(L264)** `title`을 기존 모델별 분해 + 비용 구성 합본으로 교체:
   ```js
   const fullTip = `${tip}\n\n${costBreakdownTip(f)}`;
   ```

3. **재시도 시각 배지(선택, 가벼움):** retry.calls ≥ 1 인 행의 "로그 재계산" 셀 옆에 `🔁{n}` 작은 배지 표시. 클릭 없이 hover 툴팁만.

4. **캐시 버스트:** `admin35.html`의 `admin35.js?v=3` → `?v=4`.

### 영향 범위

- DB 스키마 변경 없음 (기존 `stage` 컬럼 활용).
- `ai_usage_log` 추가 read 1개 컬럼(`stage`)만 늘어남 — 쿼리 비용 미미.
- 본문/검수/재시도 분해는 응답에만 추가, 기존 필드 모두 유지 → 다른 화면 영향 없음.
- 단건 비용 계산 자체는 변경 없음(`save.ts` 그대로).

### 검증

1. `/admin35` 새로고침 → 비용 셀 hover 시 "본문/검수/재시도" 분해 노출.
2. 사회 ₩563 케이스: 본문 vs 검수 비중을 즉시 확인 가능.
3. 같은 run_id에 검수 호출이 여러 번 있는 행은 retry > 0으로 표시되는지 확인.
4. `costBuckets`가 null인 구버전 행(run_id 없음/로그 매칭 실패)은 기존 툴팁만 표시되고 깨지지 않는지 확인.

---

## 변경 파일 요약

- `src/routes/api/admin/$.ts` — `/files` 응답에 `costBuckets` 추가 (stage 컬럼 SELECT + 버킷 집계)
- `public/legacy/admin35.js` — `costBreakdownTip` 헬퍼, 비용 셀 툴팁 확장, 재시도 배지
- `public/legacy/admin35.html` — `admin35.js?v=4`
- `.lovable/plan.md` — 본 계획 반영

승인하시면 위대로 적용하겠습니다. 옵션 2는 위 분해 결과를 본 뒤 (예: "검수가 전체 비용의 40% 이상이면 검수 1패스로 축소" 같은 데이터 기반 결정) 다음 턴에서 다루는 것을 권장합니다.
