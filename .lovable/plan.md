
# 재시도 발생 빈도를 근본적으로 줄이는 대책 (리스크 보완판)

## 배경

`src/routes/api/admin/$.ts` L243–249의 retry 버킷은 같은 `(run_id, stage)` 가 2회 이상 보이면 무조건 누적합니다. 그래서 **성격이 다른 3가지**가 한 통에 섞여 있고, 어떤 게 진짜 낭비인지 안 보입니다.

| 분류 | 발생 위치 | 성격 |
|---|---|---|
| (A) 계획된 캐스케이드 | 검수(99)·최종검토(100): `2.5-flash-lite → 3-flash-preview` 2단계 (`app35.js` L1863~) | 의도된 2회 |
| (B) 서버 tier 폴백 | `chat.ts` L225–256: JSON 파싱 실패 / silent tool-call / MALFORMED → MID→PRIMARY 즉시 재호출 | 모델 신뢰성 부족 |
| (C) 클라 자기수정 루프 | `complete_plan {ok:false}`, "다시 제안" 버튼, `hasStageConflict` | 프롬프트/가드 오작동 |

실제 절감 여지는 **(B)·(C)** 입니다. 아래는 1차 리뷰의 리스크 5종을 모두 반영한 보완판입니다.

---

## 1) 계측 먼저 — DB 마이그레이션을 선행

`ai_usage_log` 테이블에 컬럼이 없는 채로 `fallback_reason` 을 INSERT 하면 **모든 로깅이 실패** → 어드민 비용이 0으로 표시되는 대형 회귀.

순서를 강제합니다.

1. **마이그레이션**(승인 필요):
   ```sql
   ALTER TABLE public.ai_usage_log
     ADD COLUMN IF NOT EXISTS fallback_reason text;
   ```
   기존 GRANT/RLS 유지(컬럼 추가만이라 정책 변경 불필요).
2. **방어 코드**: `logUsageBounded` 에 try/catch 추가 — INSERT 실패 시 `fallback_reason` 키만 빼고 1회 재시도. 마이그레이션 누락 환경에서도 로깅이 죽지 않음.
3. 그 다음에 `chat.ts` 에서 폴백 사유를 함께 기록.

## 2) 어드민에 retry 가시화 (읽기 전용·안전)

`src/routes/api/admin/$.ts`:

- retry 버킷 분류에서 **검수(99·100) 제외**: `seen>=2 && !(stageNum===99 || stageNum===100)`. (검수 2콜은 의도된 캐스케이드)
- `costBuckets` 옆에 신규 필드 `retryByStage: { "<stage>": { calls, krw, reasons: { "silent-toolcall": n, "malformed": n, ... } } }` 추가.
- `admin35.js` 가 새 필드를 모르면 그냥 무시 → 호환.
- **분기점 안내**: 이 변경이 적용된 시각을 어드민 헤더에 한 줄 표기("이 시점 이후 검수는 retry에서 제외"). 과거 수치와 직접 비교 시 혼동 방지.

## 3) 서버 폴백(B) 트리거를 보수적으로 줄이기

`src/routes/api/lessonplan/chat.ts` L225–256:

- **silent-toolcall 임계**: 40 → **24자**(12자는 너무 빡빡해 진짜 침묵 누수). 단 "첫 1턴 한정" 게이트는 **두지 않음**.
- **silent 폴백은 "연속 2회"일 때만**: run 단위 카운터로, 같은 stage에서 toolCalls=0 && text<24 가 **2회 연속** 관측되면 그때 폴백. 1회 우연 침묵으로 인한 비용 폭증·진행 멈춤 모두 방지.
- **JSON 코드펜스 재파싱**: `result.text` 가 ` ```json ... ``` ` 로 감싸져 있으면 펜스 제거 후 한 번 더 `JSON.parse` 시도, 그래도 실패면 폴백. (현재는 무조건 폴백)
- **MALFORMED 폴백**: 유지(실제 에러).
- 모든 폴백 발생 시 `fallback_reason` 을 다음 콜의 `logUsageBounded` 메타에 함께 전달.

## 4) MID→PRIMARY 승격은 데이터 본 뒤 결정 (즉시 적용 X)

1~3 적용 후 1~2일 운영 → `retryByStage` 에서 `fallback_reason != null` 비율이 **15% 이상**인 stage 만 `MID_STAGES` 에서 제거. 콜당 단가가 약 3배 오르므로 "절감 ≥ 단가 증가" 사전 추산 후 적용. 코드 변경은 `lessonplan-bridge.server.ts` 1줄.

## 5) 클라 자기수정 루프(C) 차단 — UX 안전판 포함

`public/legacy/app35.js`:

- **`complete_plan {ok:false}` 가 같은 run에서 연속 2회** → 자동 재호출 정지 + "수업자 의도를 직접 작성해 주세요" 모달 표시 + **run 단위 락**(`state.completeBlocked=true`)으로 추가 메시지가 와도 자동 complete 시도 안 함. 사용자가 모달에서 의도 작성하면 락 해제.
- **"다시 제안" 버튼**: 카운터 표시(예: "다시 제안 (2/3)"), 3회 초과 시 비활성화 + 툴팁 "비용 절약을 위해 이번 항목은 직접 수정해 주세요". **새 차시 시작 시 카운터 리셋**.
- **격상 잠금** (`hasStageConflict`): "격상 시도 1회"가 아니라 **"격상 후 후속 콜이 정상 응답 1회"** 일 때만 잠금. 격상 직후 또 실패하면 한 번 더 허용 → 모델이 잘못된 stage에 영구히 머무는 사고 방지.

## 적용 순서 (회귀 최소화)

1. 마이그레이션(`fallback_reason` 컬럼) → 승인 후 적용.
2. `logUsageBounded` 방어 try/catch.
3. `chat.ts` 폴백 임계·연속2회·코드펜스·메타 기록.
4. `admin/$.ts` retry 버킷 재정의 + `retryByStage`.
5. `app35.js` 클라 안전판(complete 락, 다시 제안 상한, 격상 잠금).
6. (관찰 후) `MID_STAGES` 조정.

각 단계는 독립 배포 가능. 1·2가 먼저 들어가야 3 이후가 안전.

---

## 변경 파일

- 마이그레이션: `ai_usage_log` 컬럼 1개 추가
- `src/lib/chat.functions.ts` 또는 `chat.ts` 내 `logUsageBounded`: 방어 catch + 신규 필드
- `src/routes/api/lessonplan/chat.ts`: 폴백 휴리스틱·연속2회·코드펜스
- `src/routes/api/admin/$.ts`: retry 버킷 제외 조건 + `retryByStage`
- `public/legacy/app35.js`: complete 락, 다시 제안 상한, 격상 잠금 (UI 카운터·툴팁 포함)
- `src/lib/lessonplan-bridge.server.ts`: (후속) `MID_STAGES` 조정
- `.lovable/plan.md`

## 검증

1. 마이그레이션 후 신규 차시 1건 → 어드민 비용·토큰이 정상 표시되는지(0원 회귀 아님 확인).
2. `retryByStage` 에 stage별 사유가 보이고, 검수가 retry로 안 잡히는지.
3. 짧은 정상 응답(13~23자)에서 silent 폴백이 1회로 끝나는지(연속 2회 룰).
4. 사용자가 "다시 제안" 4번째 누르면 비활성화되는지, 새 차시에서 리셋되는지.
5. `complete_plan` 연속 2회 ok:false 시 모달 + 락이 작동하는지.
6. 2~3 차시 운영 후 `retryByStage` 의 `fallback_reason` 분포 보고 6번(MID→PRIMARY) 적용 여부 결정.

## 비용 기대 효과

- (B) 폴백: 코드펜스 재파싱 + 연속2회 룰로 본문 stage 같은 단계 중복호출 **50~70% 감소** 예상.
- (C) 자기수정 루프: 한 차시 같은 stage 5+회 호출되는 최악 케이스 제거.
- 검수 retry 분리 표시로 "진짜 낭비"가 보여, 다음 라운드 최적화 의사결정이 정확해짐.

## 안 하는 것

- 전체 PRIMARY 복귀(비용 3배), 검수 1단계 단축(누락 위험), silent-toolcall 임계 12자(누수 위험) — 모두 채택하지 않음.
