# gemini-3.5-flash → gemini-3-flash-preview 전면 치환

목표: 현재 코드에서 실제 호출에 사용되는 `gemini-3.5-flash` 경로를 모두 `gemini-3-flash-preview`로 변경. 카탈로그/가격표/허용목록에서 모델 자체를 제거하지는 않음(향후 선택 가능성 유지).

## 변경 파일

### 1. `src/lib/lessonplan-bridge.server.ts`
- `PRIMARY_MODEL`: `"google/gemini-3.5-flash"` → `"google/gemini-3-flash-preview"`
- 상단 주석(line 24): PRIMARY 설명을 `gemini-3-flash-preview`로 갱신
- alias 맵(line 8) `"gemini-3.5-flash": "google/gemini-3.5-flash"`는 유지(명시 요청 시 해당 모델 사용 가능)
- 가격표(line 243) 그대로 유지

영향:
- stage 9·10 (PRIMARY 폴스루) → preview
- stage 99 검수 최종 폴백, stage 100 1순위(JSON 명시 PRIMARY) → preview
- 알 수 없는 stage 안전 폴백 → preview
- escalateTier(MID→PRIMARY) 격상 시에도 preview (MID와 동일 모델이 되지만, 토큰/온도 등 tier별 설정은 그대로 유효)

### 2. `public/legacy/app35.js`
- line 9 `FORCE_MODEL = "gemini-3.5-flash"` → `"gemini-3-flash-preview"`
- line 1982 `callOne("gemini-3.5-flash")` → `callOne("gemini-3-flash-preview")`
- line 2205 `tryModels = ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"]` → `["gemini-3-flash-preview", "gemini-2.5-flash"]` (중복 제거)
- line 45 주석의 예시 모델명만 업데이트

### 3. `public/legacy/admin35.html` (line 64) & `public/legacy/admin35.js` (line 31, 356, 387)
- 문서/배지의 "PRIMARY = gemini-3.5-flash" 설명을 "PRIMARY = gemini-3-flash-preview (MID와 동일 모델, tier 설정만 분리)"로 갱신
- "/35는 gemini-3.5-flash 고정" 문구 수정

## 보존
- `src/lib/ai-models.ts` 카탈로그 항목: 유지
- `src/routes/api/admin/$.ts` 허용목록: 유지
- 가격표 엔트리: 유지

## 검증
- 빌드 통과 확인
- preview에서 stage 9/10 진입 시 네트워크 요청 모델 필드가 `google/gemini-3-flash-preview` 인지 1회 확인
