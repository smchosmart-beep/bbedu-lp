## 변경 요지 (1단계 보수 적용)

PRIMARY(`gemini-3.5-flash`)는 **Stage 9(전개 sub 생성) + Stage 10(본문 전개)** 두 곳만 유지. 그 외 본문성 stage(11·검수·최종검토)는 MID(`gemini-3-flash-preview`)로 강등.

Stage 10은 안정 확인 후 별도 plan에서 강등 여부 재검토.

## 새 라우팅 매트릭스

| Tier | 모델 | 단가 (in/out USD/M) | Stage |
|---|---|---|---|
| PRIMARY | `gemini-3.5-flash` | 1.5 / 9.0 | **9, 10** |
| MID | `gemini-3-flash-preview` | 0.5 / 3.0 | 5, 6, 7, **11**, **99(검수)**, **100(최종검토)** |
| LITE | `gemini-3-flash-preview` (8K, 0.5) | 0.5 / 3.0 | 1, 2, 3, 4, 8 |

## 비용 효과 (예상)

- 현재 PRIMARY 호출 ~28건 중 Stage 11·99·100 합산 약 6~10건이 MID로 강등
- **803원/건 → 약 600~680원/건 (15~25% 절감)**
- 2단계(Stage 10 강등)에서 추가 절감 여지 확보

## 안전장치

1. **Stage별 강제 PRIMARY 플래그 3종 추가** (회귀 시 1줄로 즉시 복원):
   - `STAGE11_FORCE_PRIMARY`
   - `VERIFY_FORCE_PRIMARY` (stage 99·100 동시 제어)
   - `STAGE6_FORCE_PRIMARY` (기존 유지)
2. **기존 폴백 그대로 유효**: JSON 파싱 실패·MALFORMED·침묵 실패 시 MID→PRIMARY 자동 격상 (최대 1회).
3. **전역 비상 스위치 `FORCE_PRIMARY`** 유지.

## 검증 절차

1. 배포 후 동일 단원으로 2~3건 생성
2. Admin Cost View에서 stage별 ₩/콜 분포 확인 — Stage 11·99·100이 모두 MID 단가로 기록되는지
3. 생성된 출력 직접 검토:
   - **수업자의도(11)**: 문장 자연스러움, 교사 어조, 앞 단계 정합성
   - **검수 결과(99)**: JSON 구조 완전성, 형식 위반 탐지율
   - **최종검토(100)**: 항목별 점검 누락 여부
4. 회귀 발견 시 해당 플래그 `= true`로 즉시 롤백

## 기술 세부 (편집 1파일)

**`src/lib/lessonplan-bridge.server.ts`** 만 수정. 클라이언트(`app35.js`)·DB·다른 라우트 변경 없음.

```ts
// 변경 전
const PRIMARY_STAGES = new Set([10, 11]);
const MID_STAGES = new Set([5, 6, 7, 9]);
const LITE_STAGES = new Set([1, 2, 3, 4, 8]);
const STAGE6_FORCE_PRIMARY = false;

// 변경 후
const PRIMARY_STAGES = new Set([9, 10]);            // 전개·본문
const MID_STAGES = new Set([5, 6, 7, 11]);          // 수업자의도 추가
const LITE_STAGES = new Set([1, 2, 3, 4, 8]);
const STAGE6_FORCE_PRIMARY = false;
const STAGE11_FORCE_PRIMARY = false;  // 수업자의도 회귀 시 true
const VERIFY_FORCE_PRIMARY = false;   // 검수·최종검토 회귀 시 true
```

`pickTier()` 보강:
```ts
if (stage === 6 && STAGE6_FORCE_PRIMARY) return "PRIMARY";
if (stage === 11 && STAGE11_FORCE_PRIMARY) return "PRIMARY";
if ((stage === 99 || stage === 100) && VERIFY_FORCE_PRIMARY) return "PRIMARY";
// stage 99/100을 MID로 명시 매핑 (현재는 unknown → PRIMARY로 떨어짐)
if (stage === 99 || stage === 100) return "MID";
```

**`src/routes/api/lessonplan/chat.ts`** `json && model` 분기 조정 — 검수·검토만 서버 라우팅 우선:
```ts
// 변경 전
} else if (json && model) {
  tier = "PRIMARY";
}
const resolvedModel = json && model ? resolveModelId(model) : pickModelForTier(tier, model);

// 변경 후
} else if (json && model && stage !== 99 && stage !== 100) {
  // 그 외 JSON 호출(향후 추가될 수 있음)은 호환 위해 명시 모델 존중
  tier = "PRIMARY";
} else {
  tier = pickTier(typeof stage === "number" ? stage : null);
  if (tier !== "PRIMARY" && hasStageConflict(stage, messages)) tier = escalateTier(tier);
}

const useExplicitModel = json && model && stage !== 99 && stage !== 100;
const resolvedModel = useExplicitModel ? resolveModelId(model) : pickModelForTier(tier, model);
```

## 미적용 (이번 단계)

- **Stage 10(본문)**: PRIMARY 유지. 2~3건 검증 후 별도 plan에서 강등 여부 결정.
- 클라이언트 코드 변경 없음
- DB 스키마 변경 없음
- 어드민 UI는 이미 stage별 분포 표시 가능
