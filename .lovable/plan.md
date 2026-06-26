# MID/LITE/검수 단계 → gemini-2.5-flash 전환 (stage 11만 preview 유지)

## 배경
정형·짧은 출력 단계는 GA 안정 모델인 `gemini-2.5-flash`로 충분하다는 판단. preview 대비 약 20~40% 비용 절감 + GA 안정성. stage 11(수업자의도)만 reflection 서술 품질 보호를 위해 preview 유지.

## 최종 라우팅

| 단계 | 모델 |
|---|---|
| 1~4, 8 (LITE) | **gemini-2.5-flash** |
| 5, 7 (MID) | **gemini-2.5-flash** |
| **11 (수업자의도)** | **gemini-3-flash-preview** (예외 유지) |
| 6, 9, 10 (PRIMARY) | gemini-3.5-flash (변동 없음) |
| 99 검수 A차 | gemini-2.5-flash-lite (변동 없음) |
| 99 검수 B차 | **gemini-2.5-flash** |
| 100 최종검토 1순위 (client 명시) | **gemini-2.5-flash** |
| unknown 폴백 | **gemini-2.5-flash** (MID로) |

## 변경

### 1. `src/lib/lessonplan-bridge.server.ts`
- `MID_MODEL`: `gemini-3-flash-preview` → **`gemini-2.5-flash`**
- `LITE_MODEL`: `gemini-3-flash-preview` → **`gemini-2.5-flash`**
- `VERIFY_B_MODEL`: `gemini-3-flash-preview` → **`gemini-2.5-flash`**
- 새 상수 `STAGE11_MODEL = "google/gemini-3-flash-preview"` 추가 (수업자의도 전용)
- `pickModelForTier(tier, requested, stage?)` 시그니처 확장 (선택적 stage 인자)
  - tier=MID & stage=11 → `STAGE11_MODEL` 반환
  - 그 외는 기존 로직
- 호출부 `chat.ts` 2곳에 stage 인자 전달
- 주석 갱신: "MID/LITE/검수 = 2.5-flash, stage 11만 preview 예외"

### 2. `public/legacy/app35.js`
- line 2205 검수 폴백 `tryModels`: `["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"]` → **`["gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3.5-flash"]`** (1순위 변경: 2.5-flash 우선, 실패 시 preview→3.5-flash로 격상)
- line 1982 최종 폴백 모델 `gemini-3.5-flash` 유지 (다른 모델 다 실패한 후 안전망)

### 3. `public/legacy/admin35.html` & `admin35.js`
- 설명 갱신:
  - PRIMARY (6·9·10) = gemini-3.5-flash
  - MID (5·7) = gemini-2.5-flash
  - **MID 예외 (11 수업자의도) = gemini-3-flash-preview**
  - LITE (1~4·8) = gemini-2.5-flash
  - 검수 1차 = 2.5-flash-lite, 검수 2차/최종검토 = gemini-2.5-flash
  - unknown 폴백 = gemini-2.5-flash

## 비용 영향 (대략)
| | 이전 (preview) | 이후 (2.5-flash) | 절감 |
|---|---|---|---|
| MID/LITE/검수 토큰 단가 | in 0.5 / out 3.0 | in 0.3 / out 2.5 | ~17~40% |
- 전체 호출 중 MID/LITE/검수 비중을 감안하면 세션당 비용 **추가 15~25% 절감** 예상
- PRIMARY(6·9·10)와 stage 11은 변동 없음 → 품질 핵심 단계 보호

## 보존
- `PRIMARY_MODEL` (3.5-flash), `VERIFY_A_MODEL` (2.5-flash-lite), 가격표, allowlist
- escalateTier 격상 안전망: LITE→MID→PRIMARY 자동 격상은 그대로 작동
- 가격표에 `gemini-2.5-flash` 엔트리 이미 존재 (in 0.3 / out 2.5)

## 검증
- 빌드 통과
- preview에서 다음 stage 별로 네트워크 model 필드 1회씩 확인:
  - stage 5 또는 7 → `google/gemini-2.5-flash`
  - stage 11 → `google/gemini-3-flash-preview` (예외)
  - stage 9 또는 10 → `google/gemini-3.5-flash`
  - stage 99/100 → `google/gemini-2.5-flash` (또는 A차 2.5-flash-lite)
