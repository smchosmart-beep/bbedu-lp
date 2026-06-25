## 목표

업로드한 `bbedu-lp-main` 백엔드(Express + Gemini 프록시)를 **Lovable Cloud + Lovable AI Gateway**로 이식하고, **Notion 디자인 시스템(notion.md)** 을 그대로 적용한 신규 UI에서 6단계 챗봇 흐름 + HWPX 다운로드 + 관리자 대시보드를 제공합니다. **AI Gateway가 지원하는 텍스트 모델 전체를 셀렉터·비교 모드에 노출**해 자유롭게 갈아끼우며 테스트할 수 있게 합니다.

## 1. 인프라

- **Lovable Cloud** 활성화 (DB + Auth + 시크릿)
- **Lovable AI Gateway** — `LOVABLE_API_KEY` 자동 발급
- `bbedu-lp-main/public/data/*.json` 11개 + `template.hwpx` 5개 → `public/data/`로 복사

## 2. 모델 카탈로그 — 가능한 모든 텍스트 LLM (`src/lib/ai-models.ts`)

Lovable AI Gateway 카탈로그의 **텍스트(T,I→T) 모델 16종 전부** 등록. (멀티모달 입력은 추후 확장 가능, 우선 텍스트 출력 가능 모델만)

**Google Gemini (7종)**
- `google/gemini-3-flash-preview` ★기본
- `google/gemini-3.1-flash-lite`
- `google/gemini-3.5-flash`
- `google/gemini-3.1-pro-preview`
- `google/gemini-2.5-pro`
- `google/gemini-2.5-flash`
- `google/gemini-2.5-flash-lite`

**OpenAI GPT (9종)**
- `openai/gpt-5`, `openai/gpt-5-mini`, `openai/gpt-5-nano`
- `openai/gpt-5.2`
- `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.4-nano`, `openai/gpt-5.4-pro`
- `openai/gpt-5.5`, `openai/gpt-5.5-pro`

각 항목에 `{ id, label, vendor, tier(flash|lite|nano|mini|pro|standard), description, suggestedFor[] }` 메타 부여. UI에서 vendor·tier별 그룹·필터, 즐겨찾기, 마지막 사용 모델 기억(localStorage). 모델 변경 시 해당 모델 docs에 맞춰 파라미터 검증(불필요 필드 제거)은 서버에서 수행.

**비교 모드**: 최대 6개까지 동시 선택 → 병렬 호출, 카드별로 출력·토큰·지연·credit 표시. (모델 수가 많으므로 한 번에 너무 많이 고르지 않도록 상한)

## 3. 디자인 시스템 — Notion (notion.md 기반)

`src/styles.css`에 Notion 토큰 매핑. shadcn 의미 토큰(`--background`, `--primary` 등)을 Notion 값으로 재정의, 컴포넌트 하드코딩 hex 금지.

- 컬러: `--background canvas`, `--surface #f6f5f4`, `--foreground #1a1a1a`, `--primary #5645d4`(Notion purple), `--brand-navy #0a1530`(히어로), `--link #0075de`, 액센트(orange/pink/purple/teal/green/yellow/brown), 카드 tint 8종(peach/rose/mint/lavender/sky/yellow/cream/gray), semantic
- 타이포: **Inter Variable**(Notion Sans 대체) — `text-hero` 80/-2px, `display-lg` 56, `h1-h5` 48/36/28/22/18, `body` 16, `caption` 13, `micro-up` 11/600/1px
- spacing: xxs 4 ~ hero 120 / rounded: xs 4 ~ xxxl 24 + full
- Button variant: `primary`(purple pill), `dark`, `secondary`(outline), `on-dark`, `ghost`, `link`
- Card variant: `base`, `feature-*` 8 tint, `agent-tile`, `template`
- 랜딩: 짙은 네이비 히어로 밴드 + sticky-note dot + mesh wire SVG + 퍼플 pill CTA + 6단계 워크플로 파스텔 카드 그리드(기본정보=cream, 분석=sky, 탐구질문=lavender, 목표=mint, 활동=peach, 평가=rose) + 챗봇 mockup

## 4. 데이터베이스 (Lovable Cloud)

```
user_roles(id, user_id→auth.users, role app_role, UNIQUE(user_id,role))
  + has_role(uuid, app_role) SECURITY DEFINER
app_config(key text PK, value jsonb)           -- default_model, enabled_models[]
ai_usage_log(id, ts, user_id, model, stage, variant,
             prompt_tokens, output_tokens, total_tokens,
             credits, latency_ms, run_id)
rate_limit(ip, window_start, count, PK(ip,window_start))
conversations(id, user_id, title, created_at)
messages(id, conversation_id, role, content jsonb, model, created_at)
```
모두 `GRANT` + RLS. `ai_usage_log`/`app_config`/`rate_limit`는 admin 전용 SELECT/UPDATE.

## 5. 서버 함수 (`createServerFn`, AI SDK + Lovable AI Gateway)

- `src/lib/ai-gateway.server.ts` — 지식 베이스 표준 `createLovableAiGatewayProvider` 그대로
- `src/lib/chat.functions.ts`
  - `sendChatMessage({ conversationId, messages, stage, model })` — `requireSupabaseAuth`, 레이트리밋, 입력 캡(40K/250K), `generateText`, `ai_usage_log` 적재, run_id 헤더 보존
  - `compareModels({ messages, stage, modelIds[] })` — 병렬 `generateText`, 카드별 결과·토큰·지연 반환 (서버에서 modelIds를 카탈로그로 검증)
- `src/lib/admin.functions.ts` — `getUsageStats`, `setDefaultModel`, `setEnabledModels` (admin 권한 검증)

## 6. 라우트 / UI

- `/` — Notion 스타일 랜딩 (네이비 히어로 + 파스텔 6단계 카드 + CTA)
- `/auth` — 이메일+비번
- `/_authenticated/chat`, `/_authenticated/chat/$id` — 챗봇
  - 헤더: **모델 셀렉터(검색·vendor 그룹·tier 배지·즐겨찾기)** + 비교 모드 토글(최대 6개)
  - 좌: 대화 목록 / 중앙: 메시지+composer / 우: 6단계 진행
  - HWPX 다운로드는 클라이언트 JSZip+DOMParser placeholder 치환
- `/_authenticated/admin` — 사용량 표·라인차트(recharts), 모델별 통계, 기본 모델·활성 모델 토글

## 7. 작업 순서

1. Lovable Cloud 활성화 + `LOVABLE_API_KEY` 확인
2. 마이그레이션(테이블 + GRANT + RLS + `has_role`)
3. `public/data/` 자료 복사
4. Notion 디자인 토큰화(styles.css, Inter, Button/Card variant)
5. AI Gateway 헬퍼 + `ai-models.ts` 카탈로그 16종 + `chat.functions.ts` + `compareModels`
6. 랜딩(`/`)
7. `/auth`
8. `/chat` — 모델 셀렉터·비교 모드 먼저
9. 6단계 워크플로 + 시스템 프롬프트 포팅
10. HWPX 패키징
11. `/admin` 대시보드

## 확인할 점

- 첫 admin 계정 이메일 (가입 후 SQL 한 줄로 role 부여)
- HWPX 기본 양식은 `template.hwpx` 사용 가정
