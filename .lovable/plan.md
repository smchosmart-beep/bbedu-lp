## 목표

생성된 HWPX 파일을 Lovable Cloud Storage(비공개 버킷)에 보관하고, 관리자 화면의 "파일" 탭에서 목록·다운로드가 동작하게 한다. 관리자 비밀번호 기본값은 `admin` 그대로 유지.

## 구현 단계

### 1. Cloud Storage 버킷 + 메타 테이블

- 비공개 버킷 `hwpx` 생성 (`supabase--storage_create_bucket`, public=false).
- 마이그레이션으로 `public.hwpx_files` 테이블 + RLS + storage.objects 정책 추가:

  | 컬럼 | 타입 | 비고 |
  |---|---|---|
  | id | uuid PK | 기본 gen_random_uuid |
  | file_name | text | 클라이언트가 보낸 파일명 |
  | storage_path | text | `hwpx/YYYY/MM/{uuid}-{filename}` |
  | variant | text | 예: `v35` |
  | model | text | 고정 모델(`gemini-3.5-flash` 등) |
  | meta | jsonb | 학년/학기/교과/단원/성취기준/수업주제 |
  | usage | jsonb | calls/prompt/output/cached |
  | cost_usd | numeric | 모델 단가 × 토큰 + verifyUsd |
  | cost_krw | numeric | usd × 1500 |
  | created_at | timestamptz |  |

  - RLS: admin만 select/insert/delete (`has_role(auth.uid(), 'admin')`). service_role은 전체.
  - storage.objects 정책: `bucket_id = 'hwpx'` 인 객체에 대해 admin만 select (서버는 service_role로 동작하므로 충분).
  - GRANT: SELECT, INSERT, DELETE → authenticated; ALL → service_role.

### 2. `/api/lessonplan/save` 실제 구현

현재 빈 stub인 `src/routes/api/lessonplan/save.ts`를 다음 로직으로 교체:

1. body: `{ fileName, fileBase64, variant, model, meta, usage, verifyUsd }`
2. base64 → Buffer 디코드 (입력 검증: fileName 안전화, 최대 5 MB 제한).
3. `supabaseAdmin.storage.from('hwpx').upload(path, bytes, { contentType: 'application/vnd.hancom.hwpx', upsert: false })`.
4. cost 계산: `estimateCostUsd(model, prompt, output) + verifyUsd`, KRW = round(usd × 1500).
5. `hwpx_files` insert.
6. 200 OK `{ ok:true, id }`.

### 3. 관리자 파일 목록 + 다운로드 (`/api/admin/$`)

`src/routes/api/admin/$.ts`의 splat 분기 확장:

- `GET /admin/files` → `hwpx_files` 최근 200건 select, admin.js가 기대하는 모양으로 매핑:
  ```ts
  items: [{
    id, fileName, createdAt, 모델: model, krw: cost_krw, calls: usage.calls,
    토큰: { prompt, output, cached },
    학년, 학기, 교과, 단원, 성취기준, 수업주제,
  }]
  ```
- `GET /admin/files/{id}/download` → 행 조회 → `supabaseAdmin.storage.from('hwpx').download(storage_path)` → 바이트를 그대로 `Response` (Content-Type `application/vnd.hancom.hwpx`, Content-Disposition `attachment; filename*=UTF-8''{fileName}`). admin.js는 `res.blob()`로 그대로 받음.
- 두 라우트 모두 `checkPassword(request)` 우선 통과.

### 4. 동작 검증 (Playwright)

- 사용자 화면에서 welcome → 수 차례 chat → 미리보기에 충분히 채워졌을 때 HWPX 다운로드 클릭 → 네트워크에서 `/api/lessonplan/save` 200 확인 + Storage 객체 생성 확인.
- 관리자 로그인 → "파일" 탭 → 위 항목 표시 → "받기" 클릭 시 .hwpx 다운로드.

### 5. 변경하지 않는 것

- 관리자 비밀번호: 기본 `admin` 유지 (`ADMIN_PASSWORD` env 미설정 시 동일).
- 사용자/관리자 UI 마크업: 손대지 않음(legacy 그대로). API 응답 모양만 admin.js 기대 키에 맞춤.
- 기존 `ai_usage_log` 흐름: 그대로(저장 호출은 별개의 비용 합산 — 원본도 동일).

## 기술 메모

- `supabaseAdmin`은 `*.functions.ts`/route 파일에서 **동적 import**(현 코드 패턴 유지).
- 5 MB 상한 + fileName sanitization(`[^A-Za-z0-9._가-힣\- ]` 제거)로 경로 인젝션 방지.
- storage 경로에 UUID 접두사를 두어 충돌 회피, 동시에 사용자 친화 파일명은 `file_name` 컬럼/Content-Disposition로 보존.
- 비용 환산 단가는 이미 `PRICING`/`estimateCostUsd`가 있으므로 그대로 사용.
