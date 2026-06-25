# 비용 추적 데이터 점검 결과

결론부터: **목업이 아니라 실제 `ai_usage_log` 테이블 데이터**입니다 (현재 17행, 그 중 `variant='v35'` 11행). 다만 표시 로직에 3가지 결함이 있어 "가짜처럼" 보입니다.

## 발견된 문제

### P1. `variant=v35` 필터가 서버에서 무시됨 (가장 큰 문제)
- 클라(`admin35.js:54`)는 `/admin/costs?variant=v35`로 호출하지만,
- 서버(`src/routes/api/admin/$.ts:126-129`)의 `loadCostByDay()`는 쿼리스트링을 읽지 않고 **모든 행을 합산**해서 반환.
- → /35 대시보드에 메인(`/`) 트래픽까지 섞여 표시됨. 분리 집계라는 모달 설명과 실제 동작 불일치.

### P2. "세션 수" / "과정안 수"가 항상 0
- `loadCostByDay`가 `sessions`, `plans` 필드를 0으로 초기화만 하고 **한 번도 증가시키지 않음** (라인 92-101).
- 게다가 `chat.ts`의 `logUsage()`가 `run_id: null`을 하드코딩 → DB에 세션 식별자 자체가 없어 distinct count 불가.
- → 비용 ₩76인데 "세션 수 0"으로 표시되어 모순돼 보임.

### P3. `stage` 컬럼도 항상 null
- `chat.ts:33`이 `stage: null` 하드코딩. 클라가 `stage`를 body로 보내지만 로그에 기록되지 않음.
- → 추후 단계별 비용 분석(2-Tier 라우팅 효과 검증) 불가.

## 수정 계획

### 1. 서버: `loadCostByDay`가 variant 필터 받기
- 시그니처를 `loadCostByDay(variant?: string)`로 바꾸고, GET 핸들러에서 `new URL(request.url).searchParams.get("variant")`를 읽어 전달.
- Supabase 쿼리에 `.eq("variant", variant)` 조건 추가 (값 있을 때만).

### 2. 서버: 세션·과정안 집계
- 같은 쿼리에서 `run_id`도 SELECT 한 뒤, 일자별 `Set<run_id>` 크기를 `sessions`로 집계.
- `plans`는 별도 신호가 없으므로 우선 `hwpx_files` 테이블의 `created_at` 일자별 count를 합쳐 채움(완료 = 1과정안 기준).

### 3. 서버: `logUsage`가 stage·run_id 기록
- `chat.ts` POST 핸들러: body에서 `runId`(클라가 세션 식별자로 보내는 값) 받아 `logUsage`에 전달, `stage`도 그대로 저장.
- 클라(`app35.js`)에서 세션 시작 시 `crypto.randomUUID()`로 `runId` 1회 생성 → 이후 모든 `/api/lessonplan/chat` 호출에 `runId`, `stage` 포함.
- `inter.ts`도 동일하게 보강(있을 경우).

### 4. (옵션) 모달 문구
- "세션 수"·"과정안 수"가 의미하는 바를 모달에 한 줄 보강(세션=run_id 단위 대화, 과정안=HWPX 생성 완료 건수).

## 검증
- 수정 후 /35 페이지: 총 비용·일별 차트가 v35만 합산되어 줄어들고, 세션 수가 1 이상으로 표시되는지 확인.
- `select variant, count(*) from ai_usage_log group by variant`로 신규 행이 variant='v35'로 기록되는지 확인.
- 2-Tier 라우팅 효과 분석을 위해 `select stage, model, sum(prompt_tokens), count(*) from ai_usage_log where variant='v35' group by 1,2 order by 1` 쿼리가 의미 있게 반환되는지 확인.

## 영향 범위
- 수정 파일: `src/routes/api/admin/$.ts`, `src/routes/api/lessonplan/chat.ts`, `src/routes/api/lessonplan/inter.ts`(해당 시), `public/legacy/app35.js`, `public/legacy/admin35.js`(모달 문구 한 줄).
- DB 마이그레이션 없음 — `ai_usage_log`에 `variant`/`stage`/`run_id` 컬럼은 이미 존재.
