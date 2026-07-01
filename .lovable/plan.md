## 목표
`public/legacy/` 챗봇 화면(index.html + inter.html + 공용 styles.css + app35.js/app.js 위저드 렌더)을 DESIGN.md의 **Nintendo.com 2001 "console chrome"** 미학으로 풀 재현. 외부 웹폰트 로드 없이 시스템 Arial/Helvetica만 사용.

## 시각 규칙 (핵심)

- **색 팔레트** (styles.css CSS 변수로 선언):
  - canvas #7a8aba · periwinkle #8ba1d4 · sky #9fbee7 · lavender #acace7 · ice #c0d5e6 · platinum #dedede · surface #fff
  - chrome-indigo #3d4f97 · muted-indigo #60619c · hairline #5a5f8c
  - carbon #21242e · ink #21242e · ink-soft #3d4f97
  - primary(red) #e60012 · signal(orange) #f68d1f · amber #ecab37 · nav-gold #e48600
- **타이포**: `font-family: Arial, Helvetica, sans-serif` 로 통일. 헤딩·라벨은 `uppercase` + `letter-spacing: .5px` + `font-weight: 700`. 히어로 워드마크는 `Arial Black` + `-webkit-text-stroke: 2px #21242e` + `text-shadow: 3px 3px 0 #21242e`. 한글 라벨은 대문자 변환 없이 letter-spacing만 적용(가독성).
- **베벨 플레이트**: 모든 카드/패널에 `border-top: 1px solid rgba(255,255,255,.55); border-left: 1px solid rgba(255,255,255,.35); border-right: 1px solid #3d4f97; border-bottom: 1px solid #3d4f97;` — 위=하이라이트, 아래=chrome-indigo 그림자 라인.
- **모서리**: 기본 `border-radius: 0`. 큰 외곽 패널은 **chamfer**(45° 잘림) `clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)`. 로고 필/라디오/원형 화살표 버튼만 `border-radius: 999px`. 소형 카드 2~4px.
- **하프톤 도트 텍스처**(carbon 슬래브 전용): `background-image: radial-gradient(rgba(255,255,255,.08) 1px, transparent 1.2px); background-size: 4px 4px;` 위에 `#21242e` 배경.
- **역할별 색 배정**:
  - 헤더 슬래브·푸터 스트립·다크 버튼 → carbon + 하프톤
  - 로고 자리 "질문이 있는 …" 타이틀 상자 → 흰 pill + primary 레드 텍스트
  - 관리자/새로 시작 등 상단 chip → amber, 카본 텍스트
  - Submit/보내기/⬇ HWPX/이 수업 설계 시작 → signal 오렌지, 흰 텍스트
  - 검증(🔎) 등 유틸 → amber
  - 위저드 완료 스텝 = amber, 현재 스텝 = signal-orange 원형 배지, 예정 = platinum + chrome-indigo 링
  - 상단 진행 스텝 사이 연결선 = chrome-indigo dotted 1px (`border-top: 1px dotted #60619c`)
  - 채팅 봇 말풍선 = 흰 카드 + chrome-indigo bevel + 좌측 4px signal 오렌지 인디케이터
  - 사용자 말풍선 = amber 배경 + carbon 텍스트 (초록 대신)
  - 좌우 패널 배경 = platinum(#dedede) + bevel, 바깥 workspace 배경 = canvas periwinkle
  - 좁은 미리보기 표 헤더 = canvas-soft(#9fbee7), 셀 = surface, 테두리 = hairline
- **버튼 프레스**: `:active`에서 top-highlight 제거 + `translate(1px,1px)` (딸깍하는 하드웨어 느낌).
- **애니메이션**: 셀 업데이트 하이라이트를 초록 대신 amber(#ecab37→transparent)로 변경. focus/hover 링 색도 signal orange로.
- **스피너**: 회전 링 색을 signal-orange로.

## 파일 변경

### 1) `public/legacy/index.html` + `public/legacy/inter.html`
- Pretendard CDN `<link>` 제거 (외부 폰트 로드 금지).
- `tailwind.config` 의 `fontFamily.sans` 를 `['Arial','Helvetica','sans-serif']` 로, `colors.brand` 팔레트를 위 팔레트 토큰으로 교체(50~700 을 lavender/sky/canvas/signal/amber/nav-gold/primary 로 매핑).
- `<body>` 클래스에서 `font-sans antialiased bg-slate-50 text-slate-900` 는 유지하되 색은 CSS로 덮어씀 (`background: var(--canvas)`).
- 헤더 구조 마크업은 그대로 두고 CSS 클래스만 재정의 — 헤더가 carbon-navy 슬래브 + 하프톤이 되도록 `<header>` 에 클래스 `nn-nav` 추가.
- `<h1>` 텍스트를 감싸는 wrapper에 `nn-logo-pill` 클래스 부여(빨간 pill).
- Start form 컨테이너에 `nn-panel nn-chamfer`, `.sf-field` / `.sf-submit` 는 CSS에서 재스타일.
- 우측 미리보기 헤더 라벨은 canvas metal bar 스타일.
- `styles.css?v=59` → `?v=60`, `app35.js?v=7` → `?v=8` (변경 없어도 캐시버스팅).

### 2) `public/legacy/styles.css` — **전면 재작성**
아래 순서로 재작성:
1. `:root { --canvas: #7a8aba; --periwinkle: … ; --carbon:… ; --primary:…; --signal:…; --amber:… ; --nav-gold:…; --chrome-indigo:…; --muted-indigo:…; --hairline:…; --platinum:…; --surface:#fff; --ink:#21242e; --ink-soft:#3d4f97; }`
2. `body` 배경을 `var(--canvas)` + Arial 강제.
3. 유틸 클래스: `.nn-panel`(bevel), `.nn-chamfer`(clip-path 8px), `.nn-carbon`(carbon + halftone), `.nn-label`(uppercase Arial Bold 11px letter-spacing .5px color chrome-indigo), `.nn-hero-word`(Arial Black + text-stroke + shadow), `.nn-btn-primary`(amber), `.nn-btn-submit`(signal), `.nn-btn-secondary`(carbon), `.nn-btn-icon-arrow`(원형 signal + ▶), `.nn-logo-pill`.
4. 기존 클래스 완전 재정의:
   - `.msg-bubble` 라운드 4px + bevel; `.msg-bot` 흰 카드 + 좌측 4px signal 인디케이터; `.msg-user` amber 배경 carbon 텍스트 + 우측 4px indigo 그림자.
   - `.sf-field` 흰 카드 + hairline 1px + 2px sharp corners; `:focus` signal orange 링. `.sf-label` chrome-indigo uppercase.
   - `.sf-submit` → `.nn-btn-submit` 매핑(signal 오렌지, 흰 텍스트, sharp).
   - `.choice-btn` amber 배경 + carbon 텍스트, sharp, hover 시 nav-gold.
   - `.step-pill` (레거시) 는 남기되 결국 새 wizard가 사용하는 `.wizard/.wz-step/.wz-num/.wz-bar/.wz-label` 를 Nintendo 스타일로 재정의:
     - 각 `.wz-num` 20px sharp 2px 사각형 대신 원형(로고 pill 일관성)으로 유지하되 배경/링을 palette 색으로.
     - done → amber 채움 + carbon 체크; current → signal 오렌지 채움 + white 숫자 + 3px halo; todo → surface + hairline + chrome-indigo 숫자.
     - `.wz-bar` dotted 1px muted-indigo, done 이면 solid amber 2px.
     - 라벨은 uppercase 필요 없음(한글); 대신 chrome-indigo + tracking .3px.
   - 진행 컨테이너 `#progress .wizard` 를 canvas-soft(#9fbee7) subnav-strip 위에 얹은 것처럼 `background: var(--canvas-soft); padding: 6px 10px; border-top/bottom: 1px solid var(--chrome-indigo)/rgba(255,255,255,.5);`.
   - `.markdown` 링크는 nav-gold, 코드 블록은 carbon+halftone, blockquote 경계는 chrome-indigo dotted.
   - `.tangoo-*` (선택 카드) → 흰 카드 + hairline, 선택 시 signal orange 링·amber tint; submit·regen 은 `.nn-btn-submit` 스타일.
   - `.std-add-btn` amber 카드 + carbon 텍스트.
   - `.spinner` border-top-color signal orange.
   - `.plan-doc` 문서 표: 
     - `.plan-tbl th` 배경 canvas-soft, 텍스트 chrome-indigo uppercase, border 1px solid hairline.
     - `.plan-tbl td` border hairline. 
     - `.tcell:focus` signal orange 링, `.tcell:hover` platinum 배경.
     - `@keyframes cellUpdated` → amber(#ecab37) → transparent.
     - `.plan-add-sub-btn.t-mini` dashed amber; `.plan-del-sub-btn:hover` primary red.
     - `.t-step` 초록 계열 → chrome-indigo 배경 + surface 텍스트 (모형 단계명 배지가 metal chip 처럼).
     - `.t-form` 라벨 소형 배지 → platinum + hairline.
5. 하단 `.sym-c` 등은 색만 chrome-indigo로 조정, 나머지 로직 유지.
6. 미디어쿼리 유지 (`.wz-label` <900px 숨김).

### 3) `public/legacy/app35.js` + `public/legacy/app.js` (동일 위저드)
- 마크업 변경 없음. 다만 `renderProgress` 에서 done 스텝 숫자 대신 이미 넣은 "✓" 유지 — 그대로.
- `.msg-user` 등 인라인 색 지정이 있는지 확인 — 없음(Tailwind bg-brand-500만 사용). Tailwind config 교체가 되면 브랜드 계열 유틸이 새 팔레트로 자동 렌더.
- 참고: Tailwind CDN 이 브랜드 색을 리컴파일하도록 `<script>tailwind.config = {...}</script>` 순서상 CDN 스크립트 이후 · CSS 이전에 위치하는지 확인(이미 그러함).

### 4) `public/legacy/35.html` / `admin.html` / `admin35.html`
- 이 턴에서는 챗봇 화면만 대상 — 관리자 대시보드는 스코프 밖(사용자 확인 답변에 따라 챗봇 화면 전체로 한정). 후속 요청 시 별도 진행.

## 회귀·리스크

- **기능 영향 0**: 스크립트 로직·서버 호출·이벤트 위임(`data-key` 셀 편집)·HWPX 매핑 모두 CSS 이름 유지로 그대로 작동.
- **가독성**: 한글 UI에 uppercase는 라벨/버튼 텍스트 중 영문·기호에만 실효(한글은 자연스레 무시됨). 본문 12~14px Arial + 한글은 시스템 fallback 이라 렌더 문제 없음.
- **Tailwind CDN + config 재정의**: 기존 `brand-500/600/700` 유틸이 signal/nav-gold/carbon으로 자연 매핑되므로 인라인 클래스 다시 손볼 필요 없음.
- **웰컴 폼 대비**: 흰 카드 + platinum 배경, submit signal 오렌지 → WCAG AA 대비 통과.
- **미리보기 편집 시 focus 링**: 초록 → signal orange 로 이동 (사용자 이미 시각적 각성 요소로 기대).
- **비용/서버**: 순수 프론트 스타일 변경. LLM/스토리지 무관.

## 검증

1. `node --check public/legacy/app35.js` (스타일 변경만이지만 캐시버스팅 후 파싱 확인).
2. Playwright: `http://localhost:8080/legacy/index.html` 진입 → 헤더·welcome 폼 스크린샷; 시작 폼 제출 → 위저드·채팅·미리보기 스크린샷; 성취기준 셀 편집 → focus 색 signal orange 확인.
3. 콘솔 에러/네트워크 404(폰트 제거로 인한) 없음 확인.

승인하시면 위 계획대로 반영하겠습니다.