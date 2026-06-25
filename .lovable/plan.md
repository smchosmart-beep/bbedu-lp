## 정체 확인

해당 항목은 `hwpx_files` 테이블의 단일 행입니다.

- **id**: `d2072ef6-90d2-4d3b-8896-d3ff77481300`
- **file_name**: `테스트.hwpx`
- **created_at**: 2026-06-25 13:49 UTC
- **meta**: 3학년 2학기 / 과학 / 자석 / [4과10-01] / 자석 분류
- **model**: `gemini-3.5-flash`, **cost_krw**: ₩5
- **storage_path**: `hwpx` 버킷의 `2026/06/1098ae2b-abe0-4866-87b6-4101301cec95.hwpx`

`ai_usage_log`에는 이 row와 연결된 흔적이 없고(같은 시각 호출 기록 0건), `conversations`/`messages`도 모두 0건입니다. 파일명이 `테스트.hwpx`이고 비용도 ₩5인 점으로 보아 초기 업로드 경로 테스트 1건이 남아있던 것입니다.

## 처리

1. Supabase Storage `hwpx` 버킷에서 `2026/06/1098ae2b-abe0-4866-87b6-4101301cec95.hwpx` 객체 삭제
2. `DELETE FROM public.hwpx_files WHERE id = 'd2072ef6-90d2-4d3b-8896-d3ff77481300';`

코드 변경 없음. 어드민 UI에 개별 행 삭제 버튼이 필요한 경우는 별도 plan으로 분리합니다(이번에는 1건뿐이라 직접 삭제만).

## 확인

- 삭제 후 `SELECT count(*) FROM hwpx_files` → 4 가 되는지 검증
- 어드민 비용 화면 새로고침해 해당 행이 사라졌는지 확인
