# 적용 완료: 단계 A(지표 정정) + 단계 B3(콜 수 제한)

## 단계 A — "재시도" 지표 정정 ✅

### `src/routes/api/admin/$.ts`
- `byBucket`에 `multiturn: { usd, calls }` 추가 (기존 build/verify/retry 유지)
- 분류 로직(상호배타):
  - `fallback_reason !== null` → **retry**(진짜 회귀)
  - 그 외 + 같은 (run_id, stage) seen ≥2 + 검수(99·100) 제외 → **multiturn**(정상)
- `multiturnByStage` 추가, 응답에 포함

### `public/legacy/admin35.js`
- 툴팁: "본문/검수/재시도†(회귀)/멀티턴‡(정상)/합계" 4줄로 분리
- 배지: retry 회귀는 🔁{n} rose-600, multiturn 정상은 ⇄{n} slate-400 (약하게)
- 주석 정정: † fallback_reason 있는 진짜 회귀, ‡ 정상 multi-turn

## 단계 B3 — 콜 수 제한 ✅

### 새 가드(`public/legacy/app35.js`, runTool 직전)
- `RAG_CACHE_ENABLED = true` — 같은 stage·같은 인자 RAG 결과 캐시. hit 시 `{cached:true, hint:"…"}` 주입
- `RAG_COUNT_GUARD_ENABLED = true`, `STAGE6_RAG_MAX = 6` — stage 6 RAG 누적 6회 도달 시 stop hint 주입
- `CHOICES_CAP_ENABLED = true`, `MAX_CHOICES_PER_FIELD = 2` — 같은 field LLM 자발 재호출 2회 초과 차단
- `state._lastUserRegen` 플래그 — 사용자 "다른 후보 추천" 직후 1회는 카운트 제외(보정사항)

### 두 루프 모두 적용
- `runConversation` (L1549~) — 카드 표시 직전 cap 체크 → tool 메시지로 `{error:"choices_cap"}` 주입
- `runConversationInter` (L1696~) — 동일 가드, function_result로 주입

### 보존 / 안전장치
- 회귀 시 1줄 비활성화: `*_ENABLED = false`
- 기존 `guardHits` 안전착지 그대로 → 무한루프 방지
- stage 전환 시 직전 stage의 RAG 캐시만 자동 삭제(`_b3MaybeRotate`)
- 검수(99·100)·stage 11(수업자의도)은 RAG/present_choices 미사용 → 영향 0

## 검증
- 빌드: tsgo --noEmit 통과
- admin /35 새로고침: "재시도(회귀) 0건" + "멀티턴(정상)에 기존 ~440원 이동" 확인 가능
- 1세션 진행 후 콘솔에서 `[b3-rag-cache-hit]` / `[b3-rag-cap]` / `[b3-choices-cap]` 로그 확인

## 단계 C 보류
A·B 효과를 1~2일 실측한 뒤 stage 6 입력 토큰 다이어트 결정.
