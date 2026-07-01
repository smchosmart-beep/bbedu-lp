## 목표
상단 진행 바(현재 percent-only)를 **7단계 위저드 스테퍼**로 교체해, 사용자가 지금 어느 단계인지·몇 단계 남았는지 한눈에 볼 수 있게 한다.

## 7단계 그룹핑 (내부 stage 1~11 → 노출 7단계)

| # | 라벨 | 내부 stage |
|---|---|---|
| 1 | 기본 정보 | 1 |
| 2 | 성취기준 | 2 |
| 3 | 핵심 아이디어·역량 | 3~4 |
| 4 | 탐구 질문 | 5 |
| 5 | 평가 계획 | 6 |
| 6 | 학습목표·수업모형 | 7~8 |
| 7 | 교수·학습 활동·마무리 | 9~11 |

완료 조건: `state.plan` 존재(=complete_plan ok) 시 7단계 모두 done.

## 변경 파일

### 1) `public/legacy/index.html` (및 `inter.html` 동일 반영)
- 헤더의 `#progress` 컨테이너는 유지. 내부는 JS가 채움. 시작 화면(welcome)에서는 숨김.

### 2) `public/legacy/styles.css`
- 기존 `.step-pill` 규칙은 남기되 위저드용 클래스 추가:
  - `.wizard` (flex, gap, items-center)
  - `.wz-step` (원형 인덱스 + 라벨, 상태별 색)
  - `.wz-step.done` (초록 채움), `.wz-step.current` (초록 링·굵은 라벨), `.wz-step.todo` (회색)
  - `.wz-bar` (스텝 사이 연결선, done이면 초록)
  - 라벨은 `text-[11px]`, 좁은 폭에서 라벨 숨김(`@media (max-width: 720px) .wz-label { display:none }`) — 원+번호만 표시.

### 3) `public/legacy/app35.js`
- 상단에 상수 추가:
  ```js
  const WIZARD_STEPS = [
    { label: "기본 정보",         stages: [1] },
    { label: "성취기준",           stages: [2] },
    { label: "핵심 아이디어·역량", stages: [3,4] },
    { label: "탐구 질문",          stages: [5] },
    { label: "평가 계획",          stages: [6] },
    { label: "학습목표·수업모형",  stages: [7,8] },
    { label: "교수·학습 활동",     stages: [9,10,11] },
  ];
  function stageToWizardIdx(stage) { /* 매핑, plan 완료면 7 */ }
  ```
- `renderProgress(pct)` 를 유지하되 내부 구현을 **위저드 렌더**로 교체:
  - `detectStage(state.partialPlan)` 로 현재 stage 산출 → 위저드 인덱스 계산.
  - `state.plan` 있으면 모든 스텝 done, 아니면 idx 미만은 done, idx는 current, 초과는 todo.
  - 마크업: 각 스텝은 `<div class="wz-step [done|current|todo]"><span class="wz-num">i</span><span class="wz-label">라벨</span></div>`, 스텝 사이 `<div class="wz-bar [done]"></div>`.
  - 툴팁(`title`)에 "N/7단계 · 라벨"·"현재 내부 stage k" 표기(디버깅·안내 목적).
- `renderProgress` 호출부 3곳(라인 1368, 1373 부근) 그대로 유지 — pct 인자는 무시하고 내부적으로 stage 기준으로 다시 계산.

## 회귀·비용 리스크
- LLM 호출·프롬프트·툴 페이로드 변경 없음 → 서버비 영향 0.
- HWPX/미리보기/1-A·1-B/옵션 2·3 모두 무관(순수 상단 UI).
- `detectStage` 는 매 턴 이미 호출됨(추가 비용 무의미).
- welcome 화면일 때만 위저드 숨김 처리 유지(현 `#progress` 는 workspace 전환 후 자연 표시).

## 검증
1. Node.js `--check` 로 app35.js 파싱 통과.
2. Playwright: `/legacy/index.html` 진입 → welcome 폼 제출 → 위저드 7개 원 표시·1번 current 확인 → 미리보기 편집으로 성취기준 채워지면 2번 current로 이동 스크린샷.

승인하시면 위 계획대로 반영하겠습니다.