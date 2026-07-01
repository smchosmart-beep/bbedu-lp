# 관리자 대시보드 디자인 통일

메인 챗봇(`index.html`, `35.html`)에서 사용하는 Nintendo-console-chrome 스타일(Arial, 골드/레드/네이비 팔레트, `nn-*` 베벨 크롬 컴포넌트)을 `admin.html`과 `admin35.html`에도 그대로 적용합니다. 기능/스크립트/DOM id는 건드리지 않고 오직 스킨만 변경합니다.

## 대상 파일
- `public/legacy/admin.html`
- `public/legacy/admin35.html`
- `public/legacy/styles.css` (관리자 전용 유틸 몇 개 추가 — 표/카드/토큰 배지)

## 주요 변경 사항

1. **폰트/색 시스템 통일**
   - Pretendard CDN 로드 제거, Arial만 사용 (챗봇과 동일)
   - Tailwind config의 emerald 계열 `brand` 색을 챗봇과 동일한 브랜드 팔레트(앰버·시그널·네이비·레드)로 교체
   - `styles.css?v=65`를 admin에도 링크 (캐시 버전 일괄 상향)

2. **레이아웃 셸 교체**
   - 상단에 챗봇과 동일한 `nn-nav` 헤더 삽입 — 로고(logo.png) + "관리자 대시보드" 타이틀 필(`nn-logo-pill`) + 우측 `nn-chip` 버튼(← 앱 / 로그아웃 / 3.5 버전 배지)
   - 본문 배경은 `--canvas` (인디고 그레이), 컨테이너는 `max-w-6xl mx-auto px-5 py-6`
   - 하단에 챗봇과 동일한 `nn-footer` ("◆ 2026 서울특별시북부교육지원청") 삽입

3. **로그인 게이트 재스킨**
   - 흰 카드 → `nn-panel nn-chamfer` 베벨 플레이트
   - 자물쇠 배지 아이콘: `nn-hero-badge` 스타일(레드 그라디언트 + 골드 반짝임 ✦) 재사용
   - 입력창 → `sf-field`, 로그인 버튼 → `nn-btn-submit`, 뒤로가기 링크 → `nn-fineprint`
   - 에러 문구는 브랜드 레드(`--primary`) 유지

4. **대시보드 섹션 재스킨**
   - 각 `section.bg-white rounded-3xl shadow-card` → `nn-panel nn-chamfer p-5` (라운드 제거, 베벨 크롬)
   - 섹션 제목: `nn-panel-title` (⚙️ 모델 / 💰 비용 추적 / 📄 생성된 HWPX / 🧪 모델 비교)
   - KPI 카드(총 비용/호출/토큰/평균/세션): `nn-panel` 미니 변형 + 앰버 강조 숫자, 슬레이트 대신 브랜드 토큰 사용
   - 셀렉트(`periodSel`, `granSel`, `modelSel`)와 인풋: `sf-field` 스타일로 통일
   - 액션 버튼:
     - 주요(저장·실행·워크플로 확인): `nn-btn-submit` (앰버)
     - 보조(새로고침·로그아웃·← 앱): `nn-chip` (베벨 골드)
   - 진단 배너(`#diagBanner`): 레드/앰버 배경 + 베벨 테두리

5. **표 스타일 통일**
   - `styles.css`에 `.nn-table` 유틸 추가: `border-collapse`, 헤더 배경 `--ice`, 헤더 텍스트 `--chrome-indigo`, 행 하단선 `--hairline` 점선, 정렬 가능 헤더는 hover 시 `--lavender`
   - `admin.js` / `admin35.js`가 뿌리는 tbody 내용은 그대로 표시되도록 셀렉터·id 유지

6. **워크플로 모달 재스킨**
   - 오버레이 유지, 다이얼로그를 `nn-panel nn-chamfer`로 교체
   - 헤더 하단 구분선 `--hairline`, 닫기 버튼은 `nn-chip`

## 기술 세부

- Tailwind CDN + tailwind.config 유지 (기존 클래스 유틸 사용을 위해). `brand` 색만 다음으로 교체:
  ```
  brand: { 50:'#c0d5e6', 100:'#acace7', 200:'#9fbee7', 300:'#8ba1d4',
           400:'#ecab37', 500:'#f68d1f', 600:'#e48600', 700:'#e60012' }
  ```
- `boxShadow.card`도 챗봇과 동일한 인디고 하드섀도로 교체
- `<link rel="stylesheet" href="./styles.css?v=65">` 를 두 admin 파일에 추가하고, `index.html` / `35.html` / `inter.html`의 캐시 버전도 v=65로 상향
- JS 파일(`admin.js`, `admin35.js`) 및 모든 DOM id/class hook은 변경하지 않음 → 기능·데이터 흐름 그대로

## 검증
- Playwright로 `/legacy/admin35.html`, `/legacy/admin.html` 로그인 화면과 대시보드(더미 상태) 스크린샷을 찍어 챗봇 화면과 톤이 동일한지 확인
