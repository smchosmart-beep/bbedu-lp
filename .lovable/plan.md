# 평가·전개활동 단계만 gemini-3.5-flash로 복귀

## 배경
전면 치환 후 두 가지 품질 저하 확인:
1. 학생 활동 예시가 질문형으로 나오는 등 어색함 → **stage 10 (전개 학생활동)** 품질 저하
2. 활동 3안 제안이 1안으로 단순화 → **stage 9·10 (활동 제안)** 다양성 저하
3. 활동 주제의 상위 결정인 **평가 과제 제안/선정 (stage 6)** 도 품질 유지 필요

## 변경 (역방향, 부분 롤백)

### 1. `src/lib/lessonplan-bridge.server.ts`
- `PRIMARY_MODEL`: `google/gemini-3-flash-preview` → **`google/gemini-3.5-flash`** (원복)
- `MID_MODEL`, `LITE_MODEL`: `gemini-3-flash-preview` 유지
- `VERIFY_B_MODEL`: `gemini-3-flash-preview` 유지
- `PRIMARY_STAGES = new Set([6, 9, 10])` — 평가 + 전개활동을 명시적으로 PRIMARY로 라우팅
- `MID_STAGES`에서 `6` 제거 → `[5, 7, 11]`
- `pickTier` 의 마지막 `return "PRIMARY"` (unknown 폴백) → **`return "MID"`** 로 변경
  - 사유: stage 1~11·99·100이 완전 커버되어 unknown 진입은 신규/버그 경로뿐. 의도치 않은 호출이 가장 비싼 모델로 새지 않도록 안전한 기본값(preview)으로 통일
- 주석 갱신: "PRIMARY = gemini-3.5-flash (평가·전개활동만), 그 외 = gemini-3-flash-preview"

결과:
| 단계 | 모델 |
|---|---|
| 1~4, 8 (LITE) | gemini-3-flash-preview |
| 5, 7, 11 (MID) | gemini-3-flash-preview |
| **6 평가, 9·10 전개활동 (PRIMARY)** | **gemini-3.5-flash** |
| 99 검수 A차 | gemini-2.5-flash-lite (변동 없음) |
| 99 검수 B차 | gemini-3-flash-preview (변동 없음) |
| 100 최종검토 1순위 | client 명시 모델 유지 (현재 preview) |
| unknown 폴백 | **gemini-3-flash-preview (MID)** |

### 2. `public/legacy/app35.js`
- line 9 `FORCE_MODEL`: `gemini-3-flash-preview` → **`gemini-3.5-flash`** (원복)
  - 사유: `/35` 페이지의 직접 호출 흐름 기본 모델이며, 사용자 보고가 이 페이지 기준
- line 1982 검수 폴백 `callOne("gemini-3-flash-preview")` → **`gemini-3.5-flash`** (원복)
- line 2205 `tryModels`: `["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"]` (3.5 재추가, 1순위)
- line 45 주석 모델명도 원복

### 3. `public/legacy/admin35.html` & `public/legacy/admin35.js`
- 설명 갱신:
  - PRIMARY (stage 6·9·10 = 평가·전개활동) = gemini-3.5-flash
  - MID (stage 5·7·11 = 탐구질문·학습목표·수업자의도) = gemini-3-flash-preview
  - LITE (stage 1~4·8) = gemini-3-flash-preview
  - 검수 1차 = 2.5-flash-lite, 2차/최종검토 = 3-flash-preview
  - unknown 폴백 = gemini-3-flash-preview (MID)

## 비용 영향
- stage 6·9·10이 가장 토큰을 많이 쓰는 구간 → 3.5-flash 복귀 시 직전 대비 비용 ↑ (preview 대비 약 3배)
- 단, 치환 이전(stage 9·10이 PRIMARY 폴스루로 이미 3.5-flash였던 상태) 대비로는 stage 6만 추가 상승 → 전체 영향은 제한적
- unknown 경로를 MID로 내려 신규 stage 추가 시 비용 사고 위험 제거

## 보존
- 카탈로그, 가격표, allowlist: 변동 없음
- escalateTier, tierConfig: 변동 없음 (MID→PRIMARY 격상 시 3.5-flash로 올라가는 안전망 자동 복구)

## 검증
- 빌드 통과
- preview에서 stage 6·9·10 호출 시 네트워크 model 필드가 `google/gemini-3.5-flash` 인지 1회 확인
- stage 5·7·11 호출 시 `google/gemini-3-flash-preview` 유지 확인
