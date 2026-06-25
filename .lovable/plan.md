목표: 최근 적용된 2-Tier 라우팅·stage 태그·A/B 검증 구조에 맞춰 챗봇의 SYSTEM_PROMPT 및 워크플로 텍스트를 정비한다.
범위는 프롬프트/문서 정비에 한정하며, 모델·라우팅 로직(이미 구현됨)은 변경하지 않는다.

## 현재 상태 (확인됨)
- `public/legacy/app35.js`의 `SYSTEM_PROMPT`는 단일 ~5KB 블록(라인 54~131). 매 턴 전체 주입.
- `detectStage()` 클라 SSoT 존재, stage는 서버로 전달되어 PRIMARY/CHEAP 라우팅에 사용.
- A/B 검증(2.5-flash-lite → 3-flash-preview)은 `verifyPlanQuality()`에 이미 구현. 사용자 프롬프트엔 "한 번의 검토"로만 기술되어 있어 문제는 없음.
- `.lovable/plan.md` 2번 항목("SYSTEM_PROMPT 분할")이 코드에 미반영 상태 — 이번 작업의 핵심.

## 변경 계획

### 1. SYSTEM_PROMPT를 CORE + STAGE_GUIDE로 분리 (app35.js)

**CORE (~2.5KB, 매 턴 주입):** 단계 독립 규칙만 보존.
- [함수 사용] 전체
- [정보 수집]
- [사용자 직접 입력 다듬기]
- [2022 개정 교육과정 용어]
- [필드 작성 규칙] 전체 (교사활동·학생활동·자료유의평가·시간·sub키·단계키·도입/정리 단일·차시 비움 규칙)
- [채팅 길이], [톤]
- [권장 진행 순서] 머리말 1~2줄 + 단계 목록(1~11) 한 줄 요약(현 라인 71~101의 첫 문장만 추출). "각 단계의 세부 규칙은 진행 시 추가로 안내된다"는 한 줄.

**STAGE_GUIDE (현재 stage ±1만 주입):** stage별 디테일.
- `STAGE_GUIDES = { 1: "...", 2: "...", ..., 11: "..." }` 객체로 정의.
- 각 항목은 현 SYSTEM_PROMPT 라인 71~101의 해당 단계 본문(★ 안내 포함) 그대로 옮김.
- stage 6은 ⓪~③·ㄱ~ㄹ 디테일이 길어 단독 1KB 수준.

**조립 함수:**
```js
function buildSystemPrompt(stage) {
  const guides = [stage - 1, stage, stage + 1]
    .filter(s => s >= 1 && s <= 11)
    .map(s => `[${s}단계 세부]\n${STAGE_GUIDES[s]}`)
    .join("\n\n");
  return `${CORE_PROMPT}\n\n${guides}`;
}
```

**주입 위치:**
- `callLLM()` (라인 1071~): `messages[0]`이 system이면 매 턴 `buildSystemPrompt(stage)`로 교체 후 전송.
- `callLLMInter()` (라인 1126~): `system` 필드를 `buildSystemPrompt(detectStage(state.partialPlan))`로 동적 생성.
- 세션 시작/복원 지점(라인 1208, 2410)의 초기 system도 `buildSystemPrompt(1)`로 생성.

### 2. 권장 진행 순서 머리말의 stage 일관성 검증

`detectStage()`가 보는 필드 키와 워크플로 단계 번호 간 매핑이 일치하는지 한 번 점검:
- 단계 1~11이 `detectStage` 분기와 정확히 1:1 대응되는지 확인.
- 불일치 발견 시 STAGE_GUIDE 본문 또는 detectStage 분기 중 워크플로 본문이 정답이므로 detectStage 코멘트만 보강(로직 변경 X).

### 3. CORE 내 검증 안내 문구 정비

현 11단계 문장의 "complete_plan이 수행하므로 따로 점검 보고하지 않습니다"는 그대로 유지(A/B 분리는 서버 내부 구현이라 모델에 노출 불필요). 추가 변경 없음.

### 4. 검수(🔎) 프롬프트 점검

`runReview()`/검수 프롬프트(라인 2018 부근)에 stage 의존 표현이 있는지 확인. 검수는 항상 전체 plan 기준이므로 stage 라우팅과 무관 — 변경 없음 예상이나 1회 grep 확인.

### 5. 토큰 절감 추정

- 매 턴 system 토큰: 약 5KB → 2.5KB(CORE) + 0.5~1KB(STAGE_GUIDE 1~3개) = **2.5~3.5KB**.
- 입력 토큰 약 30~40% 절감(단계당 평균).

## 영향 범위
- 수정 파일: `public/legacy/app35.js` 단일.
- 서버(`chat.ts`, `bridge.server.ts`, `inter.ts`)·DB·도구 선언 변경 없음.
- 검증/라우팅 로직 변경 없음 (이미 구현됨).

## 검증 방법
1. 빌드 후 `/legacy/35.html` 로드 → 1~11단계 시나리오 1사이클 실행, 단계 전환 시 system이 stage에 맞게 바뀌는지 console.log로 1회 확인 (배포 후 제거).
2. `ai_usage_log`에서 평균 prompt_tokens가 30%+ 줄었는지 비교.
3. 6단계 ㄱ→ㄴ→ㄷ→ㄹ 진행이 sticky하게 PRIMARY로 유지되는지 라우팅 가드와 함께 확인.
4. 회귀 시 `buildSystemPrompt`가 항상 전체 STAGE_GUIDES를 합쳐 반환하도록 1줄 토글(`FORCE_FULL_PROMPT=true`)로 즉시 롤백.
