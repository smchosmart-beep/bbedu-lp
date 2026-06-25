## 목표

어드민 `📋 챗봇 워크플로 & 프롬프트` 모달의 설명을 **3-Tier 라우팅(1단계 보수)** 현행 코드와 일치시키기.

수정 파일: `public/legacy/admin35.js` (모달 본문 HTML 상수 `WORKFLOW_INTRO`)

## 반영할 최신 사실

| Tier | 모델 | 적용 stage |
|---|---|---|
| PRIMARY | `gemini-3.5-flash` (16K/0.7) | 9(전개), 10(본문) |
| MID | `gemini-3-flash-preview` (12K/0.7) | 5, 6, 7, 11(수업자의도), 99(검수), 100(최종검토) |
| LITE | `gemini-3-flash-preview` (8K/0.5) | 1, 2, 3, 4, 8 |

폴백: MALFORMED / JSON 파싱 실패 시 한 tier 격상(최대 1회). 단계 충돌 시 `hasStageConflict`로 격상. 비상 스위치: `FORCE_PRIMARY`, `STAGE6_FORCE_PRIMARY`, `STAGE11_FORCE_PRIMARY`, `VERIFY_FORCE_PRIMARY`.

## 편집 내용 (3곳)

### 1) 개요 문단 (line 305)
"2-Tier 모델 라우팅(중요 단계 5·6·7·9·10·11 = …PRIMARY / RAG·단순 단계 1~4·8 = …CHEAP)"
→ "**3-Tier 모델 라우팅**: PRIMARY `gemini-3.5-flash` = 단계 9·10 / MID `gemini-3-flash-preview` = 단계 5·6·7·11·검수·최종검토 / LITE `gemini-3-flash-preview`(8K) = 단계 1~4·8"
나머지(`detectStage`, `hasStageConflict`, 폴백, CORE+STAGE_GUIDES, variant=v35)는 유지.

### 2) 주요 기능 라우팅 불릿 (line 336)
"2-Tier 라우팅 (/35) — …" 항목을 3-Tier 설명으로 교체. PRIMARY/MID/LITE 모델·단계 매핑과 "한 tier 격상(최대 1회) 폴백", `FORCE_PRIMARY`/stage별 플래그로 즉시 롤백 가능 문구 포함.

### 3) 2-Step A/B 검증 불릿 (line 338) — 폐기
검수(99)·최종검토(100)는 이제 MID 단일 호출이며 `2.5-flash-lite` A단계는 더 이상 쓰지 않음. 해당 불릿을 다음으로 교체:
"**완료 검토(MID 단일 호출)** — 검수·최종검토는 `gemini-3-flash-preview`로 호출, JSON 파싱 실패 시에만 PRIMARY로 1회 자동 폴백. 회귀 시 `VERIFY_FORCE_PRIMARY=true`로 즉시 PRIMARY 복원."

## 미적용

- `public/legacy/admin.html`(메인 admin)의 동일 모달은 v35 전용 텍스트가 아니므로 손대지 않음.
- 진행 흐름 / 사용 함수 / 정확성·안전장치 섹션은 변경 없음.
- 서버 라우팅 코드, 클라이언트 동작 코드 변경 없음(문서 동기화만).

## 검증

배포 후 어드민 `워크플로 확인하기` 모달을 열어 3-Tier 표 텍스트와 검수 불릿이 갱신된 것 확인.
