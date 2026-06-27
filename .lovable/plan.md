# 단계 A + B3 — 리스크 검토 결과 (적용 전 보정사항 포함)

## A. 지표 정정 (낮은 리스크)

### 검토 결과 — 안전
- `costBuckets`에 `multiturn` 필드 추가는 표시 전용. 기존 admin 행은 옵셔널 체이닝(`f.costBuckets?.multiturn?.krw ?? 0`)으로 안전 폴백.
- 집계 분류는 상호배타로 설계:
  - 회귀(retry) 우선 매칭: `fallback_reason !== null` → retry 버킷에만
  - 그 외 + (run_id, stage) seen ≥2 → multiturn 버킷에만
  - 검수(99·100)는 둘 다 제외 (기존 verify 버킷 유지)
- DB 스키마 변경 0건. RLS 영향 0건. 서버비 영향 0건.

### 잠재 부작용 — 없음
- `retryByStage.reasons` 통계: 진짜 회귀만 잡히므로 0건이 되어도 정상. fallback 알람 임계가 별도로 있다면 새 정의 기준으로 재설정 필요 (현재 그런 알람은 없음 확인됨).

---

## B3. 콜 수 제한 — 리스크 발견 + 보정

### B3-1. present_choices 반복 상한 — **보정 필요**

**리스크:**
1. 사용자가 명시적으로 `regenerate` 버튼을 눌러 다른 후보를 요청한 경우까지 카운트되면 UX 손상 (특히 stage 6 `평가요소`처럼 교사가 여러 번 다듬는 게 정상인 항목).
2. 차단 후 LLM이 그래도 다시 호출하면 무한 retry → 비용 폭증.
3. `runConversation`과 `runConversationInter` 두 루프 모두 적용 안 하면 inter 변형에서 회피됨.

**보정:**
- 카운트는 **"같은 field·LLM 자발적 재호출"만** (사용자 regenerate 응답으로 인한 재호출은 제외) — `state.pendingCall` 직전 user_message가 `{regenerate:true}`였는지로 분기.
- 차단 시: tool 응답으로 `{error:"choices_cap", note:"이 항목은 후보 제시 2회 한도에 도달했습니다. 사용자 직접 입력을 받거나 다음 단계로 진행하세요."}` 주입 → 기존 `guardHits` 안전착지가 무한루프 차단.
- 두 루프에 동일 가드 적용.
- 회귀 스위치: `MAX_CHOICES_PER_FIELD = Infinity`.
- 검수(stage 99·100)는 present_choices 안 쓰므로 영향 없음. 확인됨.

### B3-2. RAG 결과 캐시 — **효과 재평가 필요 → 축소**

**리스크/정확한 효과:**
- LLM이 `list_*`/`find_*`를 다시 호출하면 클라이언트가 백엔드 fetch만 건너뛰고 캐시 결과를 tool 메시지로 push. **다음 LLM 콜은 여전히 1회 발생** — 즉 LLM 비용은 거의 줄지 않음(절감되는 건 외부 fetch 지연 + tool 결과 일부 토큰 중복 누적 정도).
- 사용자가 의도적으로 다시 보고 싶을 때(다른 인자로) 인자가 달라 캐시 미스 → 영향 없음 ✓.

**보정 (효과를 위로 끌어올림):**
- 캐시 hit 시 tool 응답에 `cached:true`와 함께 짧은 system hint 1줄 추가: "이미 같은 후보를 받았으니 추가 RAG 호출 없이 present_choices로 바로 정리하세요." → LLM이 추가 RAG 호출을 stop 하는 행동 유도.
- 효과 기댓값을 plan에서 "콜 수 30~50% 감소" → "**RAG 외부 호출 절감 + LLM 콜 5~15% 감소(보수)**"로 정직하게 정정.
- 세션 메모리만 사용(localStorage X) — stage 전환 시 해당 stage 캐시 삭제. 메모리 누수 위험 없음.

### B3-3. stage 6 RAG 횟수 가드 — **보정 필요**

**리스크:**
1. soft hint("present_choices로 정리하세요")는 LLM이 무시 가능 — 효과 없을 수 있음.
2. **검수(99)**가 RAG 안 쓰는 건 OK, 그러나 stage 6에서 평가 ⓪~③ 4단계 진행 중 각각 1~2회 RAG 정상 호출이 있을 수 있어 4회 상한이 너무 빡빡할 수 있음.

**보정:**
- 상한 4 → **6** 으로 시작 (보수). 실측 후 조정.
- soft hint + **다음 turn부터는 `list_*`/`find_*` tool을 messages에서 임시 비표시** 옵션은 위험하므로 채택 안 함(LLM이 도구 정의 누락에 혼란).
- 대신 상한 초과 시 RAG 호출이 들어오면 tool 응답으로 `{stop:true, note:"RAG 충분히 조회했습니다. 보유 후보로 present_choices를 호출하세요."}` 주입. 기존 `guardHits` 안전착지로 무한루프 방지.

### B3-4. 콘솔 로그만 — 무해 ✓

---

## C. 다른 기능에 미치는 악영향 점검

| 기능 | 영향 |
|---|---|
| 검수 99·100 캐스케이드 | RAG·present_choices 안 씀 → 영향 없음 ✓ |
| stage 11 수업자의도 (preview 모델 예외) | RAG·present_choices 안 씀 → 영향 없음 ✓ |
| stage 10 update_plan 활동별 분할 | retry로 잘못 잡혔던 것이 multiturn 으로 이동 → 표시만 바뀜 ✓ |
| 서버 escalateTier 폴백 | fallback_reason 기록 그대로, retry 버킷에 정확히 집계 ✓ |
| runConversationInter 변형 | 두 루프 모두 동일 가드 적용 필수 (위 B3-1 보정 반영) |
| ai_usage_log RLS·스키마 | 변경 없음 ✓ |
| admin 다른 표시(byModel 등) | 무관 ✓ |
| 다운로드(HWPX) 흐름 | 무관 ✓ |
| save·session-start 라우트 | 무관 ✓ |

---

## D. 서버비 과다 부과 위험 — 없음

- B3는 모두 **클라이언트 가드** (회귀 시 1줄 비활성화 가능).
- 잘못 동작해도 "콜이 더 일어남"이 아닌 "원래대로 일어남" → **상방 비용 위험 0**.
- 단, B3-1 차단 후 LLM이 무한 재시도하는 시나리오만 위험 → `guardHits` 안전착지(이미 존재)가 막아줌 + tool 응답에 `error/stop` 명시로 LLM이 진행 단계로 넘어가도록 유도.

---

## E. 적용 순서 (안전)

1. **A 먼저** (지표 정정만, 코드 회귀 0%)
2. admin에서 "재시도(회귀) 0건" 확인 → 멀티턴 분리 표시 검증
3. **B3-2** (RAG 캐시 + cached:true hint) — 가장 안전
4. **B3-1·B3-3** (가드 적용) — 1세션 실측
5. 1~2일 사용 후 stage 6 콜 수·비용 측정 → 단계 C(입력 토큰 다이어트) 결정

## 변경 파일 (최종)
- `src/routes/api/admin/$.ts` — multiturn 버킷 추가, retry 정의 변경
- `public/legacy/admin35.js` — 표시 라벨/툴팁 정정
- `public/legacy/app35.js` — B3 가드 3종 + 두 루프(runConversation·runConversationInter) 동시 반영
- `.lovable/plan.md` — 본 내용으로 갱신

## 결론
- 적용 OK. 단, B3-1·B3-3 보정사항(regenerate 제외·상한 6·stop 응답)을 반영해 진행.
- B3-2의 LLM 비용 절감 효과는 보수적으로(5~15%) 잡고, stage 6의 본질 절감은 단계 C(입력 토큰 다이어트)에서 다룸.
