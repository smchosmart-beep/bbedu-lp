
# 원본 zip 1:1 이식 계획

지금 구현된 ChatGPT 스타일 일반 챗 UI를 폐기하고, `bbedu-lp-main.zip` 의 **질문이 있는 교수·학습 과정안 도우미** 를 그대로 옮깁니다. 모델은 Lovable AI Gateway 로 통일, 모델 비교는 관리자에만 남깁니다.

---

## 1. 사용자 화면 (`/` = 원본 `index.html` 그대로)

원본의 좌우 분할 레이아웃·6단계 흐름·tool calling·HWPX 다운로드까지 모두 포팅.

### 1-1. 상단 헤더 + 진행 단계 바
- 로고(`logo.png`) + "질문이 있는 교수·학습 과정안 도우미" + "2026 서울특별시북부교육지원청"
- 우측: `🔒 관리자` / `↺ 새로 시작`
- 6단계 진행 표시(기본정보 → 교육과정 분석 → 탐구질문 → 학습목표 → 활동 → 평가)

### 1-2. Welcome 화면 (기본정보 입력 폼)
- "어떤 수업을 함께 설계해 볼까요?" 카드
- 입력: 학년 / 학기 / 교과 / 출판사 / 단원(드롭다운+직접입력) / 수업 주제·아이디어(textarea)
- "이 수업 설계 시작하기 →" 제출 시 작업 공간으로 전환

### 1-3. 작업 공간 (좌우 분할)
- **좌측 46%: 채팅 패널**
  - 메시지 영역(마크다운 + KaTeX 수식 + `present_choices` 카드 인라인 렌더)
  - quickArea(빠른 답변 칩)
  - composer(autoresize textarea + 보내기)
- **우측: 과정안 미리보기 패널**
  - `📄 미리보기 및 직접 수정` (셀 클릭 인라인 편집)
  - `🔎 검증` / `⬇ HWPX 다운로드` 버튼
  - 60+개 `REQUIRED_FIELDS` 를 원본과 동일한 표 구조로 표시(도입/전개/정리 sub-activity 추가/삭제 포함)

### 1-4. 챗봇 워크플로 (`app.js` 1:1 포팅)
- 시스템 프롬프트 그대로 사용
- Tool functions: `find_standards`, `find_competencies`, `find_core_ideas`, `find_considerations`, `find_unit_contents`, `present_choices`, `update_plan` 전부 포팅
- `state` 머신(messages / plan / partialPlan / pendingCall / interactionId / usage 등) 그대로
- Interactions API 패턴(`previous_interaction_id` 로 서버 stateful) → TanStack 서버 함수로 어댑트
- `recentlyUpdated` 셀 하이라이트, `confirmedChoices` 가드, KaTeX auto-render, marked 마크다운 모두 유지

### 1-5. HWPX 빌드/다운로드
- `public/data/template.hwpx` 등 5종 템플릿 그대로 유지(이미 복사됨)
- 클라이언트 JSZip 으로 placeholder 치환 → 다운로드 (원본 `app.js` 의 `buildHwpx()` 로직 이식)

---

## 2. 관리자 화면 (`/admin` — 원본 `admin.html` + 모델 비교 추가)

원본 admin 의 모든 섹션 이식 + "모델 비교" 섹션 신설.

### 2-1. 모델 설정 (원본 그대로)
- 서비스 기본 모델 드롭다운 (Lovable AI Gateway 전체 카탈로그, `app_config.default_model`)
- "📋 워크플로 확인하기" 모달

### 2-2. 비용 추적 (원본 그대로)
- 기간(전체/30/7/1) · 단위(일/주/월) 셀렉트
- KPI 4개: 총 비용(₩) / 총 호출 / 총 토큰 / 과정안 1건당 평균
- Chart.js 라인 차트(시간별 비용/호출)
- 모델별·단계별 사용량 테이블 (정렬 가능)
- 환율 1 USD = 1,500 ₩ 기본

### 2-3. 모델 비교 (신규 — 사용자가 요청한 형태)
- 프롬프트 textarea + 시스템 프롬프트 옵션
- 체크박스로 비교 대상 모델 N개 선택 (Lovable Gateway 카탈로그 전체)
- "실행" → 모델별로 병렬 호출
- 결과 카드: 모델명 · 응답(접기/펼치기) · 지연시간 · prompt/output 토큰 · **예상 비용**(모델 단가 × 토큰 → USD/KRW)
- 결과는 `ai_usage_log` 에도 `variant='admin_compare'` 로 기록되어 비용 추적에 합산됨

### 2-4. 모델 단가 테이블
- `src/lib/model-pricing.ts` 신설 (per-1M-token USD 단가, 관리자 비용 추정에 사용)

---

## 3. 인증

- **사용자 화면(`/`)**: 로그인 없이 사용 (개발 모드 유지). 단, 노란 dev 배너는 제거 — 원본은 헤더만.
- **관리자(`/admin`)**: 원본처럼 단순 비밀번호 게이트 (env `ADMIN_PASSWORD`). Supabase RLS 가 아닌 서버 함수에서 비밀번호 검증 후 세션 쿠키.
  - 추후 Supabase `has_role('admin')` 로 교체할 수 있게 어댑터 패턴 유지.

---

## 4. 모델 정책

- **모두 Lovable AI Gateway 경유** (사용자 답변 반영)
- 사용자 화면은 관리자가 정한 `default_model` 하나만 사용 (원본 동작과 동일 — 사용자는 모델을 못 고름)
- `src/lib/ai-models.ts` 의 카탈로그를 Lovable AI Gateway 지원 전체 모델(`google/gemini-3-flash-preview`, `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gpt-5`, `gpt-5-mini`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, ...)로 확장
- 기본값: `google/gemini-3-flash-preview`

---

## 5. 데이터 / 백엔드

- `public/data/*.json` 은 이미 복사됨 (achievement / units / core_ideas / considerations / unit_contents / units_xref 등). 누락분 zip 에서 추가 복사.
- `ai_usage_log` 테이블 그대로 사용 (이미 존재). `variant` 컬럼으로 `chat`/`compare`/`admin_compare`/`verify` 구분.
- `app_config` 에 `default_model`, `admin_password_hash`, `usd_krw_rate` 키 사용.
- 사용자 화면이 익명 모드이므로 conversation/message 영구 저장은 생략 (원본도 Firestore 에 저장은 검토용/내보내기용 — 이 단계에선 생략, 추후 옵션).

---

## 6. 기술 세부 (개발자용)

### 파일 구조
```
src/routes/
  index.tsx             # welcome + workspace (좌우 분할) — 신규 작성
  admin.tsx             # 모델설정 + 비용 + 비교 — 재작성
  api/chat.ts           # tool-calling 스트리밍 (server route)
src/lib/
  workflow/
    system-prompt.ts    # 원본 SYSTEM_PROMPT
    tools.ts            # find_standards, present_choices, update_plan 등 정의
    rag.ts              # JSON 데이터 조회 (achievement/units/...)
    fields.ts           # REQUIRED_FIELDS, STAGES, SUB_FIELDS
  hwpx/
    build.ts            # JSZip placeholder 치환
  pricing.ts            # 모델별 토큰 단가
  chat.functions.ts     # sendChatTurn (tool loop 실행)
  admin.functions.ts    # getUsageStats, setDefaultModel, compareModels
src/components/
  workspace/
    ChatPanel.tsx
    PreviewPanel.tsx    # 60+ 필드 테이블, 인라인 편집
    ChoiceCard.tsx      # present_choices 렌더
    ProgressBar.tsx
  admin/
    ModelSettings.tsx
    CostTracker.tsx     # Chart.js
    ModelCompare.tsx
```

### 의존성 추가
- `jszip`, `marked`, `katex`, `chart.js`, `react-chartjs-2`, `dompurify`

### 마이그레이션
- `app_config` 키 보강: `default_model`, `admin_password_hash`, `usd_krw_rate` 시드
- `ai_usage_log` 에 `cost_usd numeric` 컬럼 추가 (모델 단가 × 토큰을 서버에서 환산해 저장)

---

## 7. 작업 순서

1. 의존성 설치 + zip 의 남은 데이터/이미지(logo.png, favicon, 추가 json) 복사
2. DB 마이그레이션 (`cost_usd` 컬럼, app_config 시드)
3. `workflow/` (시스템 프롬프트, tools, RAG, fields) 이식
4. 서버: `api/chat.ts` tool-loop + 비용 환산 후 `ai_usage_log` 기록
5. 사용자 화면: welcome 폼 → workspace(ChatPanel + PreviewPanel) — 원본 UI 100% 매칭
6. HWPX 빌드/다운로드
7. 🔎 검증 기능
8. 관리자: 모델 설정, 비용 추적(Chart.js), 모델 비교(신규)
9. 관리자 비밀번호 게이트
10. 랜딩 dev 배너 제거 / 원본 헤더로 교체

분량이 매우 큼 — 한 응답에서 끝나지 않을 수 있고, 중간 빌드/타입체크에서 멈춰가며 진행합니다.

진행할까요?
