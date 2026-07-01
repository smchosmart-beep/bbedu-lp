# HWPX 목록 표 컬럼 정리 + 대표모델 컬럼 삭제

`/legacy/admin35.html`의 "생성된 HWPX" 표에서 (1) 단원·성취기준·수업주제 셀이 한 글자씩 세로로 쪼개져 보이는 문제 수정, (2) **대표모델 컬럼 삭제**로 공간 확보.

## 원인
- `.nn-table td/th`에 `word-break` 규칙이 없어서 브라우저가 CJK 텍스트를 글자 단위로 줄바꿈함
- `table-layout: auto` 상태에서 성취기준(220px)·수업주제(180px)·대표모델이 여유 폭을 다 가져가 단원 컬럼이 한두 글자 폭까지 줄어들어 세로로 쌓임

## 변경

### 1. `public/legacy/admin35.js`
- `COLS` 배열에서 `{ key: "모델", label: "대표모델" }` 제거
- `renderFiles()`의 tr.innerHTML에서 `<td ... title="${esc(mlabel.tip)}">${esc(mlabel.label)}</td>` 줄 삭제
- 사용되지 않는 `dominantModelsLabel()` 호출부(`const mlabel = …`)도 제거

### 2. `public/legacy/admin.js` (같은 HWPX 표)
- 같은 방식으로 대표모델 컬럼 제거 (실제 컬럼 정의 위치 확인 후 동일 처리)

### 3. `public/legacy/styles.css` — `.nn-table` 블록 보강
- `.nn-table th, .nn-table td`에 `word-break: keep-all; overflow-wrap: anywhere;` 추가 → 한 글자씩 잘리는 현상 제거
- `.nn-table thead th`에 `white-space: nowrap;` → 헤더는 항상 한 줄
- 새 유틸 `.nn-table-files` (HWPX 표 전용, nth-child 폭 지정):
  ```
  1 생성일시 130px | 2 학년 52 | 3 학기 52 | 4 교과 56
  5 단원 min 140px (auto)     | 6 성취기준 220px (truncate)
  7 수업주제 170px (truncate)  | 8~10 저장₩/로그₩/격차 각 90 우측
  11 다운로드 70px
  ```
  대표모델 삭제로 컬럼 수는 12 → 11개.

### 4. `admin35.html` / `admin.html`
- HWPX 표의 `<table class="nn-table">`에 `nn-table-files` 클래스 추가

### 5. 캐시 버전 상향
- `styles.css?v=65 → v=66`을 `admin35.html`, `admin.html`, `index.html`, `35.html`, `inter.html`에 일괄 반영
- `admin35.js`, `admin.js`도 `?v` 상향

## 검증
Playwright로 `/legacy/admin35.html` 로그인 후 대시보드 스크린샷을 찍어
- 단원 셀이 가로로 자연스럽게 표시되는지
- 대표모델 컬럼이 사라져 여백에 여유가 생겼는지
확인.
