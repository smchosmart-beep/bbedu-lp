# 모델 변경 없이 비용 절감 — 보정판 (회귀 위험 검토 반영)

원안의 위험 항목(1-C 잘라내기, 2-A 출력캡 축소, 3-A verify B 생략, 3-D 6→4)을 제외·보정.
보수적 추정 절감: **세션당 -25~35% USD** (모델·라우팅 변경 0, 회귀 위험 ≈ 0).

각 항목은 회귀 시 1줄 비활성화 스위치 동봉 (B3 가드와 동일 패턴).

---

## 1차 (안전·즉시 적용)

### 1-D. RAG 보존 정책 축소 — `RAG_KEEP_RECENT 2 → 1`
- 위치: `public/legacy/app35.js` L1084
- 가장 최근 1개만 원본 유지, 그 외 RAG tool 메시지는 `"이전 단계 조회 결과(생략)"` stub.
- 안전 근거: `_b3.ragCache`(L1822~)가 같은 stage·인자에 캐시 hit으로 무료 복구.
- 스위치: 상수 1줄.

### 1-E. RAG 응답 트리밍 (클라 측, 환각 0 유지)
- `ragFindStandards` L1889: `lesson_units` 경로의 `해설` 전문 → 80자 컷(폴백 경로 L1906와 동일 규칙으로 통일). 사용자가 보는 해설은 `showStandardGuidance`(L2190)가 클라에서 `standard_guidance.json` 원문 안내 — LLM 인풋만 줄어듦.
- `ragListLessonModels` L1957: **단계가 있는 모형만** `설명` 제거. 단계 없는 모형은 설명이 유일한 선별 신호라 유지.
- 스위치: 함수 내부 `LEAN_*` 상수.

### 3-B. `complete_plan` 클라 사전 차단 (verify LLM 호출 0회)
- 위치: `doCompletePlan` L2119, `verifyPlanQuality` 호출 전.
- 정규식 매칭 시 verify 호출 없이 즉시 error 반환:
  `placeholder|예시|TODO|^\s*\(\s*\)\s*$` (보수적. `\.{3,}`는 합법 말줄임과 충돌해 제외).
- LLM에 정확한 필드명·이유 반환 → 1회 update_plan으로 회복.
- 스위치: `PRE_VERIFY_GATE = true`.

### 3-C. stage 10 단일 `update_plan` 강제
- STAGE_GUIDES[10] L162~ 끝에 한 줄 추가: "도입·전개·정리 모든 활동을 **단 한 번의 update_plan**으로 한꺼번에 반영하세요. 활동별로 update_plan을 분할 호출하지 마세요."
- `update_plan` description(L237)에도 "한 응답에서 1회만 권장" 추가.
- 효과: stage 10 콜 수 평균 3→1, 매 콜의 시스템+히스토리 재전송(2~3K 입력) 절감.

### 2-B. 채팅 길이 룰 강화 (CORE 1줄)
- CORE_PROMPT [채팅 길이] 항(L117~118)에 추가: "한 응답은 최대 3문장. 도구 호출을 포함하면 1문장으로."
- 출력 토큰 평균 -10~15%.

### 3-D 대체: 캐시 hit를 stage 6 RAG 카운트에서 제외
- 원안(6→4)은 통합교과·역량 없는 교과에서 backward 설계 강제 중단 위험 → 제외.
- 대신 `runTool` L1832에서 캐시 hit는 `_b3.ragCount[stage]++`를 건너뛰도록 수정.
- 효과: 정상 진행은 그대로, 같은 인자 반복은 무료 + 카운트도 안 소모 → 실질 한도 여유 ↑, 실제 신규 호출만 6회 한도.

---

## 2차 (1차 24h 안정 확인 후)

### 1-A 보정. STAGE 윈도우: `stage-1, stage, stage+1` → `stage, stage+1`
- 원안의 "현재만" 은 stage 전이 1턴 누락(예: 5→6 진입 시 6단계 ★ 진입 안내 멘트 사라짐) 위험.
- 보정: **끝난 단계(stage-1) 제거만**. partialPlan으로 직전 단계 결과는 LLM이 복구 가능.
- 효과: stage 6(2.5K자) 진입 후 stage-1=5(0.23K) 제거. stage 10 진입 시 stage-1=9(0.27K) 제거. 평균 -0.3~0.7K자/턴.
- 스위치: `STAGE_WINDOW_TIGHT = true` (false면 ±1 복귀).

### 1-B 보정. CORE 2분할 (3분할 X)
- `CORE_ALWAYS`(약 1.8K자) — 함수 사용·정보 수집·진행 순서·용어·톤·채팅 길이.
- `CORE_LATE`(약 2K자) — `[필드 작성 규칙]`(◉◦-, sub키, 시간, 차시 비움). **stage ≥ 8일 때만** 주입.
- 평가 sub키 규칙(`평가{i}_*`)은 이미 STAGE_GUIDES[6] 내부에 있어 별도 `CORE_EVAL` 분리 불필요.
- 효과: stage 1~7에서 -1.8K자/턴 (~600 토큰).
- 스위치: `CORE_SPLIT_ENABLED = true`.

### 1-C 대체. partialPlan 평가 필드 1줄 압축 (자르기 X)
- 원안의 stage별 필드 잘라내기는 confirmedChoices 가드와 상호작용해 present_choices 재호출 유발 위험 + `MAX_CHOICES_PER_FIELD=Infinity`(L1776)라 차단 불가 → 제외.
- 대안: `buildAPIMessages` L1094에서 평가 6×N 필드를 `"평가{i}: 요소=X · 방법=Y · 상=… · 중=… · 하=… · 피드백=…"` 1줄/범주로 압축. 미리보기·HWPX는 무관(상태만 LLM 인풋 가공).
- 평가 외 다른 필드는 그대로.
- 효과: stage 7~11에서 평가 입력 -50~70%(범주 3개·각 200자 → 100자).
- 스위치: `EVAL_FIELDS_COMPACT = true`.

---

## 제외 (위험 > 효과)

- **2-A 출력 토큰 캡 축소**: 청구는 실제 출력 토큰 기준이라 직접 절감 없음. stage 10 자동작성 절단 시 빈 셀 → 재시도로 역증 가능. **현행 16K/12K/8K 유지**.
- **3-A verify B 콜 생략**: 절감은 세션당 1콜뿐인 반면 잘린 문장·placeholder 검출 안전망이 약화. 대신 "A의 issues가 3개 이상이면 B 생략"으로 약하게 절감(차후 검토).
- **3-D 원안 (stage 6 RAG_MAX 6→4)**: 통합교과 backward 설계 중단 위험. 위 "캐시 hit 카운트 제외"로 실질 효과 대체.
- **Gemini prompt caching**: Lovable AI Gateway → OpenRouter 경유 `google/gemini-*` 캐싱 미공식 지원. 모델 변경 없이는 불가.

---

## 적용 순서

1. **1차 (한 묶음, 빌드 1회)**: 1-D, 1-E, 3-B, 3-C, 2-B, 3-D 대체. 빌드 통과 후 1세션 수동 진행 확인.
2. **2차 (24h 후)**: 1-A 보정, 1-B 보정, 1-C 대체. 각 단계 적용 후 admin `/35` 의 stage별 평균 입력 토큰·fallback_reason 빈도 확인.

## 측정

- Baseline: 직전 7일 byBucket(input tokens/stage), fallback_reason 카운트.
- 적용 24h 후 비교 지표:
  - stage 6·10 평균 입력 토큰 (-25~35% 목표)
  - stage 10 평균 콜 수 (3→1 목표)
  - silent-toolcall / json-parse 격상 빈도 (증가 시 1-A·1-B 과도)
  - verify B 호출 수 (3-B로 감소 기대)
- 회귀 신호: 격상 빈도 2배 이상 / 완료 후 빈 셀 신고 / 사용자가 "이미 정한 거 또 물어봄" 보고 → 해당 스위치 1줄 OFF.

---

## 이전 적용 이력 (보존)

### 단계 A — "재시도" 지표 정정 ✅
- `src/routes/api/admin/$.ts` byBucket에 multiturn 분리, admin35.js 배지 정정.

### 단계 B3 — 콜 수 제한 ✅
- RAG_CACHE_ENABLED · STAGE6_RAG_MAX · CHOICES_CAP(현재 Infinity로 회귀 무효화). `_b3MaybeRotate`로 stage 전환 시 캐시 회전.

### tool_choice 강제 (stage 2~9) ✅
- `safeToolChoice` + `forceTool = stage 2~9` — 텍스트-only 후보 나열 회귀 차단. stage 10은 auto(자동작성).
