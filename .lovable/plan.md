
## 데이터 vs 코드 불일치 (같은 세션 run_id `372e3899…`, 2026-06-25 16:05~16:07)

```text
시각        stage  적재된 model              기대(코드 기준)
16:05:59~9  stage 9  flash-preview  ×5   →  3.5-flash (PRIMARY)
16:07:23~37 stage 11 3.5-flash      ×3   →  flash-preview (MID)
16:07:29,31 stage 99 2.5-flash-lite ×2   →  flash-preview (MID, stage===99 가드)
```

**3건 전부 "한 단계 위/아래로 어긋남"** — 우연이 아니라 같은 원인이 의심됨.

## 가설 (검증 필요)

### H1. 가장 유력: `chat.ts` 의 stage 라우팅 분기가 현재 배포본에 없거나, 다른 버전이 돌고 있다
- 현재 소스 (`src/routes/api/lessonplan/chat.ts` L127~141) 의 분기 적용 전 빌드가 운영 중이면 → `useExplicitModel` 이 사실상 항상 true (clientmodel = FORCE_MODEL 그대로) → stage 9/11 둘 다 3.5-flash 였어야. 절반만 맞음.
- 검증: `stack_modern--invoke-server-function` 으로 stage 9·11·99 각각 1회씩 모의 호출 → `modelUsed` 응답 확인. published vs preview 차이 확인.

### H2. `app35.js` 클라가 stage 를 늦게/앞당겨 보낸다 (off-by-one)
- 같은 turn 안에서 `detectStage()` 가 호출 시점의 partialPlan 상태로 stage 를 계산 → LLM 응답 후 update_plan 이 적용되기 **전** 다음 호출의 stage 라벨이 매겨질 수 있음.
- 검증: `app35.js` 의 `callLLM` 호출 직전 stage 계산 위치와, 응답 후 `update_plan` 적용 순서를 추적해 "현재 stage" 가 한 단계 뒤처지는지 확인. 만약 그렇다면 실제 라우팅은 코드대로(stage 9→PRIMARY, 11→MID)였고, **로그의 stage 라벨이 한 박자 늦은** 것 → 데이터가 거꾸로 보이는 이유 설명됨.
  - stage 9 로 적재 = 실제로는 stage 8(LITE→flash-preview) 호출
  - stage 11 로 적재 = 실제로는 stage 9·10(PRIMARY→3.5-flash) 호출
  - stage 99 lite 2건 = 실제 검수(A=lite)이지만 stage 라벨이 99로 정상 — 이건 H1으로만 설명됨

→ H2 가 stage 9·11 을 설명, H1(또는 H1 변형) 이 stage 99 를 설명할 가능성. **두 원인 동시 작용**이 가장 일관됨.

## 진단 단계 (순서)

1. **현재 배포본 분기 확인** — `invoke-server-function` 으로 `/api/lessonplan/chat` 에 `{messages, stage:9, model:"gemini-3.5-flash"}` (json 없음) 호출, 응답 `modelUsed` 확인. PRIMARY 라우팅이면 H1 기각.
2. **검수 경로 stage 99 격리 테스트** — 같은 엔드포인트에 `{json:true, stage:99, model:"gemini-2.5-flash-lite"}` 호출 → `_model` 확인. lite 가 돌아오면 chat.ts L139 의 `stage !== 99` 가드가 실제로 우회되고 있다는 증거 (resolveModelId 분기를 거치는 추가 경로 존재).
3. **클라 stage 산정 시점 추적** — `public/legacy/app35.js` 에서 `detectStage()` 호출 → `callLLM` body 생성 → 응답 적용 순서를 한 곳에서 읽어, "응답 직전 partialPlan" 기준인지 "응답 직후" 기준인지 확정.
4. **결과 종합** — H1/H2 확정 후 어느 쪽을 고칠지 결정.

## 수정 시나리오 (진단 결과에 따라 적용)

- **H1 확정 시**: `chat.ts` 의 검수 stage 99/100 가드를 좀 더 단단히 — `forceTier===undefined && (stage===99||stage===100)` 일 때 `model` 무시하고 무조건 MID(flash-preview) 강제. 또는 검수 흐름이 의도적으로 lite 를 쓰는 것이라면 **stage 99 만 `useExplicitModel = true`** 로 허용. (검수 A=lite 가 의도면 후자, 비용 절약 차원이라 후자 추천)
- **H2 확정 시**: `app35.js` 의 callLLM 호출 직전 `stage = detectStage(partialPlan)` 을 **응답 적용 직후** 한 번 더 갱신해서 SSoT 정렬, 또는 서버에서 `stage` 를 신뢰하지 않고 messages 마지막 user 턴에서 재계산. 클라 1줄 수정이 더 작음.

## 산출물

- 진단 결과를 admin35 stage 표 하단에 1줄 주석 (예: "라벨이 한 박자 늦을 수 있음 — 22년 11월 기준") 으로 명시
- H1/H2 원인이 확정된 항목만 코드 수정. 미확정 부분은 코드 손대지 않음.

## 미적용

- 신규 테이블, 신규 admin 차트, 라우팅 규칙 변경(PRIMARY/MID/LITE 매핑) — 사용자가 요청하지 않음.
- 과거 적재 데이터 보정 — 라벨이 어긋난 과거 행은 그대로 둠 (수정 시점 이후 데이터만 정확).
