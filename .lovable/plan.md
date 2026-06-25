# 개발 모드: 전체 인증 우회

개발 단계 편의를 위해 `/admin`, `/chat` 모두 로그인 없이 바로 접근할 수 있게 합니다.

## 변경 내용

1. **라우트 이동 (인증 게이트 밖으로)**
   - `src/routes/_authenticated/admin.tsx` → `src/routes/admin.tsx`
   - `src/routes/_authenticated/chat.tsx` → `src/routes/chat.tsx`
   - 각 파일의 `createFileRoute("/_authenticated/...")` → `createFileRoute("/admin")`, `createFileRoute("/chat")`

2. **서버 함수 인증 완화 (개발용)**
   - `src/lib/chat.functions.ts`: `sendChatMessage`, `compareModels` 에서 `requireSupabaseAuth` 제거
     - 대화/메시지 저장은 익명 모드로 건너뛰고, AI Gateway 호출 결과만 반환
     - `ai_usage_log` 에는 `user_id = null` 로 기록
   - `src/lib/admin.functions.ts`: `requireSupabaseAuth` + `has_role` 검사 제거
     - 핸들러 안에서 `supabaseAdmin` 동적 import 로 통계 조회
   - 두 파일 상단에 `// DEV ONLY: no auth — restore before launch` 경고 주석

3. **UI 안내 배너**
   - `/admin`, `/chat` 상단에 "개발 모드 — 인증 우회 중" 노란색 배너
   - 랜딩 페이지의 "로그인/회원가입" CTA → "바로 시작하기"(→ `/chat`) 로 단순화

4. **랜딩 헤더**: 로그인 버튼은 유지하되 보조 링크로 두고, 주요 CTA 는 `/chat` 직접 진입

## 유지되는 것

- `/auth` 페이지, Supabase 인증 인프라, RLS 정책, `_authenticated` 레이아웃 파일은 그대로 보존 → 런칭 전 복구 시 라우트만 다시 옮기면 됨

## 배포 전 복구 체크리스트 (코드 주석에 명시)

- 라우트를 `_authenticated/` 하위로 다시 이동
- `chat.functions.ts`, `admin.functions.ts` 에 `requireSupabaseAuth` (+ admin 은 `has_role('admin')`) 복원
- 개발 모드 배너 제거 및 랜딩 CTA 원복

진행할까요?
