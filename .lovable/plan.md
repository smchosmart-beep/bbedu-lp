
## 변경

`ADMIN_PASSWORD` 시크릿을 `0219` 로 설정.

- 코드 변경 없음 — `src/routes/api/admin/$.ts` 가 이미 `process.env.ADMIN_PASSWORD` 를 읽음.
- 기존에 이미 `ADMIN_PASSWORD` 가 저장돼 있을 수 있어, `set_secret`(신규)·`update_secret`(기존) 중 적절한 쪽으로 처리. 먼저 `set_secret` 으로 시도해 신규면 즉시 적용, 이미 있으면 `update_secret` 으로 폼을 띄워 사용자가 0219 입력.

## 미적용

- `/legacy/admin35.html` UI/문구·세션 만료·잠금 횟수 등 보안 정책 변경 없음.
- 다른 시크릿 손대지 않음.

## 검증

저장 후 어드민 화면(`/legacy/admin35.html`)에서 `0219` 입력 → 로그인되면 완료.
