# 옵션 2 + 옵션 3 적용 시 리스크 재검토

코드 실측(`detectStage` L1153~1179, `callLLM` L1197, `buildAPIMessages` L1092~1115, `buildSystemPrompt` L160~169, HWPX 매핑 L2598~2603) 기준.

## ✅ 안전 확인된 사항

1. **detectStage 가 stage 6 sticky** — 평가{i} 한 칸이라도 비면 6 반환(L1161~1167). 옵션 2 압축이 "stage 6 진행 중에만" 작동하도록 조건 걸기 적합. 사용자가 평가 칸을 수동으로 비우는 엣지 케이스에도 자동 6 복귀 → 압축 재적용. ✓
2. **HWPX/미리보기는 평가1_* 직접 참조**(L2598~2603, L602, L1161) 하지만 모두 **렌더 경로**(stage ≠ 6 시점에 동작). 압축은 `buildAPIMessages` 의 LLM 페이로드 생성 시점에만 작동 → HWPX·미리보기 무영향. ✓
3. **complete_plan 검수(L2084, stage=99)**: 별도 system 으로 `JSON.stringify(fields)` 를 user 메시지로 보내 검사. `buildAPIMessages` 경유 X → 옵션 2/3 무영향. ✓
4. **stage 5/7 윈도우에 stage 6 가 곁가지로 포함**(L173 `[s-1,s,s+1]`): 옵션 3 의 INTRO/CATEGORY 분기를 `buildSystemPrompt` 안에서 stage 6 본문 생성 시점에 적용하면 그대로 윈도우에 반영됨. 곁 윈도우에서는 보수적으로 INTRO 만 → 회귀 없음. ✓
5. **fallback 안전망**: 압축 결과 길이 ≥ 원본 이면 원본 사용 → 역증가 차단.

## ⚠ 주의 필요 / 보강 가드

1. **이전 범주 라벨 요약 시 "현재 작업 중 i" 판정**
   - 가장 최근 i = 평가{i}_* 중 일부만 채워진 최대 i. **이 i 의 키는 절대 압축하지 말 것**. LLM 이 ㄴ→ㄷ→ㄹ 진행 중 직전에 자기가 정한 요소·방법을 system 에서 잃으면 일관성 깨짐(예: ㄷ 성취수준이 ㄱ 평가요소를 참조하지 못해 어휘 회귀).
   - 가드: `평가{i}_요소` 만 채워졌고 `평가{i}_방법` 비었으면 i=현재 작업 중 → 원본 유지.

2. **옵션 3 INTRO→CATEGORY 전환 기준**
   - 트리거를 단순히 "수행과제 채워짐" 으로 잡으면, ② 직후 ③ 카드 띄우기 전 1턴이 CATEGORY 가이드로 바뀜. 그 1턴에 LLM 이 ⓪/① 컨텍스트를 잃을 위험.
   - 가드: **`수행과제` AND (`평가_num` 정의됨 OR 평가1_범주 존재)** 시에만 CATEGORY 단독. 둘 사이 전이 1턴은 INTRO+CATEGORY 함께 주입(여전히 원본 1,500자보다 짧음).
   - stage 5 곁 윈도우는 INTRO 만. stage 7 곁은 가이드 자체를 제거(이미 stage 6 끝나서 partialPlan 에 모든 평가 채워짐 → CATEGORY 도 불필요). 추가 절감.

3. **callLLM 의 system 교체(L1199~1200)** 가 매 턴 `buildSystemPrompt(stage)` 로 덮어씀. 옵션 3 분기를 `buildSystemPrompt` 안에 두면 일관 적용. partialPlan 의존을 함수 인자에 직접 받아도 됨(현 함수는 partialPlan 미참조 — 인자 추가 또는 함수 내부에서 `state.partialPlan` 직접 읽기).

4. **압축 직렬화 한정**: `state.partialPlan` 자체를 변형하지 말 것(다른 곳에서 참조). `buildAPIMessages` 안에서 `filled` 의 평가 키만 가공한 새 객체를 만들어 JSON 화. ✓

## 💸 서버비 역증 시나리오

- **옵션 2**: 압축 로직 버그로 원본보다 큰 JSON 생성 → fallback 가드가 차단. 가드 누락 시 +5~10%. → 가드 필수.
- **옵션 3**: 잘못된 트리거로 INTRO 가 너무 일찍 빠지면 ⓪/① 회귀 → 사용자 재작업 1~2턴 = 콜 +1~2회. 가드 2번으로 차단.
- **API 400 등 에러 재시도 위험 없음**: messages 구조·tool_call 페어링 변경 없음(시스템 메시지 내용만 변경, 도구 호출은 무관). ✓

## 🔌 다른 기능 영향

| 영역 | 영향 |
|---|---|
| 미리보기 렌더 | 없음 (state.partialPlan 변형 안 함) |
| HWPX 생성 | 없음 (렌더 시 원본 키 직접 참조) |
| admin/35 통계 | 없음 (토큰·콜수 자연 감소만) |
| complete_plan 검수 | 없음 (별도 경로) |
| 1차·1-B 적용분 | 충돌 없음 (다른 함수·다른 블록 수정) |
| 1-A(보류 중) | 충돌 없음 — 1-A 는 messages 윈도잉, 본 plan 은 system 메시지 슬림화. 독립적으로 합쳐도 안전. |
| RAG 캐시(B3-2) | 없음 |
| stage 6 RAG 가드(STAGE6_RAG_MAX=6) | 없음 |

## 종합 결론

가드(현재 작업 i 보존, INTRO/CATEGORY 전환 조건 2단계, fallback 길이 체크) 3개만 정확히 넣으면 **오작동·비용 역증·타 기능 영향 모두 무시할 수준**. 옵션 2+3 합산 기대 효과 **stage 6 입력 토큰 -25~40%, 전체 평균 -10~15%** 정도. 산출물 형태·UI·사양 변경 없음.

승인하시면 위 가드 포함해 적용하겠습니다.
