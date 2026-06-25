
## 초기화 대상

| 테이블 | 현재 행 수 | 처리 |
|---|---|---|
| `ai_usage_log` | 79 | **전체 삭제 (TRUNCATE)** — 어드민 비용/단계 표의 원천 |
| `hwpx_files` | 4 | **유지** — 실제 생성된 한글 파일 메타데이터, 비용 추적과 별개 자료 |

## 실행 방법

`psql`은 select/insert만 허용되므로 **DELETE는 마이그레이션**으로 처리:

```sql
-- supabase/migrations/<timestamp>_reset_ai_usage_log.sql
TRUNCATE TABLE public.ai_usage_log;
```

`TRUNCATE`로 79건 즉시 비우고, 이후 새 수업안 생성부터 다시 적재되면 정합화된 라우팅(stage 9→PRIMARY, 11→MID, 99 검수 lite→flash-preview) 효과를 깨끗하게 측정 가능.

## 확인 안내

마이그레이션 적용 후 어드민 비용 화면을 새로고침하면 모든 stage 가 0건 회색 행으로 리셋된 상태가 나타남. 그 상태에서 `/legacy/35.html` 로 수업안 1개 끝까지 생성해보고 다시 비용 표를 보면 stage 1~11·99·100 라우팅 효과를 한 세션 단위로 깨끗이 추적 가능.

## 미적용

- `hwpx_files` (파일 메타·비용) 보존
- `conversations`/`messages` (대화 본문) 보존 — 이번 요청은 "비용 추적" 한정
- 라우팅 규칙·어드민 UI 변경 없음
