## 변경

`public/legacy/admin35.js` 단 한 곳만 수정. 서버 응답 변경/마이그레이션 없음.

### 표시 규칙

각 행마다 사용한 모델 집합을 다음 우선순위로 추출:
1. `f.byModelLogged` (ai_usage_log SSoT — 가장 신뢰도 높음)
2. 없으면 `f.byModelClient` (저장 시 클라가 보낸 분해)
3. 둘 다 없으면 `f.모델` 단일값 (구버전 fallback)

추출한 모델들을 **출력 토큰 내림차순**으로 정렬해 라벨링:

- 단일 모델: `google/gemini-3-flash-preview` (현재와 동일)
- 2개 이상: `gemini-3.5-flash + gemini-3-flash-preview(혼합)`
  - vendor prefix(`google/`)는 제거해 가독성 확보, 원본은 title 툴팁에 보존
  - 3개 이상이면 출력 상위 2개 + `외 N`: `gemini-3.5-flash + gemini-3-flash-preview 외 1(혼합)`

### 코드 변경 범위

`public/legacy/admin35.js`:
- 새 헬퍼 `dominantModelsLabel(f)` 추가 — 위 규칙 구현. (`byModelTip` 바로 위)
- L237 `<td>...${esc(f.모델 || "—")}</td>` → 라벨/툴팁 사용:
  ```
  <td class="px-2 whitespace-nowrap text-slate-600" title="${esc(rawModelsTip)}">${esc(label)}</td>
  ```

추가/삭제 컬럼 없음, 정렬 키 그대로 (`모델` 키는 라벨 문자열로 비교 — 혼합 행끼리도 직관적으로 묶임).

### 영향 / 안전성

- 서버·DB·저장 로직 미변경 → 기존 행/신규 행 모두 동일하게 재계산해서 표시.
- `ai_usage_log` 비어있던 구 행은 byModelClient → 단일 model fallback 순으로 동작.
- 캐시 무효화: `admin35.html` 의 `<script src="./admin35.js?v=2">` 를 `?v=3` 으로 bump.

### 검증

1. 어드민 새로고침 → 화면상 단일 모델 행은 그대로, 혼합 행은 `… + …(혼합)`.
2. 마우스 오버 시 title 툴팁에 원본 모델 ID 보임.
3. 모델 컬럼 정렬 클릭 → 라벨 기준 정렬 정상 동작.