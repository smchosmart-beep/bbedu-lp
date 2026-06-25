# 챗봇 비용 최적화 플랜 (T1~T3 보정 반영 최종본)

목표: 교수학습과정안 1건 비용 ~800원 → ~480원 (≈40%↓), 품질 유지.

## 1. 2-Tier 모델 라우팅

- **PRIMARY**: `gemini-3.5-flash` (품질 중요 단계)
- **CHEAP**: `gemini-3-flash-preview` (단순 단계, ~3배 저렴)

### 라우팅 규칙 (SSoT: 클라이언트 stage 태그 단일 소스)

| 단계/상황 | 모델 |
|---|---|
| 5/7/9 후보 생성, 10 본문 작성, 11 최종 점검, 검증 트리거 | PRIMARY |
| 6 평가 (카테고리 진입 → ㄹ 피드백, **sticky**) | PRIMARY |
| RAG 중재, `present_choices`, 단순 필드 업데이트 | CHEAP |
| 클라이언트 태그 누락 | PRIMARY (fallback) |
| `MALFORMED_FUNCTION_CALL` / `JSON_PARSE_FAILURE` | PRIMARY 재시도 |

### Step 6 sticky 범위 (T3)
- 진입: 해당 카테고리의 `present_choices` 응답 시점
- 종료: 해당 카테고리 마지막 `ㄹ` 피드백 `update_plan` 완료 시점
- 그 사이 모든 턴 PRIMARY 고정 (카테고리 ㄱ→ㄴ→ㄷ→ㄹ 일관성 보장)

### 서버측 충돌 가드 (T1)
`bridge.server.ts`에 경량 가드 추가:
- `update_plan` 필드명과 클라이언트 stage 태그가 명백히 불일치하면 (예: `evaluate1_*` 필드 업데이트인데 stage=2)
- → 해당 턴 PRIMARY + STAGE_GUIDE 전체 주입으로 fallback
- 재추정 X, 충돌 감지만 수행 (단일 SSoT 원칙 유지)

## 2. SYSTEM_PROMPT 분할

- **CORE** (~2.5KB, 항상 주입): 전 단계 필드 작성 규칙, 톤/길이, 11단계 순서·핵심 산출물, 사용자 입력 정제 규칙
- **STAGE_GUIDE** (~0.5~1KB, 현재 단계 ±1만): "어떻게" 디테일만

## 3. 히스토리 압축

- `compressHistory(messages, currentStage)`
- 트리거 조건: `currentStage ≠ 4턴전 stage` **AND** `4턴 이상 경과`
- 동일 단계 내 압축 비활성 (RAG 후보 보존, 특히 6.ㄴ가 6.ㄱ 후보 사용)
- `update_plan` 값은 풀로 유지
- `complete_plan` 검증은 풀 컨텍스트 복원

## 4. 검증 2-Step 분리

- **A** (포맷/스키마): `gemini-2.5-flash-lite`
- **B** (일관성): `gemini-3-flash-preview`
- 둘 다 통과해야 OK. A 실패 시 B 재실행. 결과는 서버에서 `{ok, issues}` 단일 응답 머지.
- 8회 호출 → 최대 4회로 축소.
- A의 `json_object` 호환성: 출시 후 20샘플 측정, 실패율 >10% 시 A→`3-flash-preview`, B→`3.5-flash` 승격.

## 5. 토큰/온도 (T2 반영)

| 모델 | maxOutputTokens | temperature |
|---|---|---|
| PRIMARY | 16000 | 0.7 |
| CHEAP | **8000** (T2: 4000→8000, `find_standards` 대용량 RAG 대응) | 0.5 |

CHEAP 상한 증가는 이론상 상한일 뿐, 평균 출력엔 영향 미미.

## 6. 수정 파일

- `src/lib/lessonplan-bridge.server.ts` — 라우팅, 충돌 가드, A/B 머지, 압축
- `src/routes/api/lessonplan/chat.ts` — 모델 선택 진입점
- `public/legacy/app35.js` — stage 태그 송신, CORE/STAGE_GUIDE 분할 주입
- `public/legacy/admin35.js` + `src/routes/api/admin/$.ts` — 비교 시뮬레이터 탭 (별도)
- DB 스키마 변경 없음

## 7. 검증 절차

1. **베이스라인**: 현 운영 모드에서 3~5사이클 풀 생성, `ai_usage_log` 평균 비용/턴수/실패율 기록
2. **A/B**: Playwright로 동일 시나리오 신규 라우팅 사이클 3~5회, 비용·검증 통과율·HWPX 필드 품질 비교
3. **A 호환성 가드**: 20샘플 후 실패율 >10% 시 모델 승격
4. **롤백**: `pickModel()` 내 `FORCE_PRIMARY=true` 한 줄로 즉시 전부 PRIMARY 복귀

## 기술 메모

- 모든 모델 ID는 `google/` prefix 포함, Lovable AI Gateway allowlist 준수
- 비용 측정은 `ai_usage_log`의 `total_credits` 합산 (사이클 단위 그룹)
- SSoT: 서버는 stage 재추정 안 함, 클라이언트 태그가 진실. 단 충돌 감지 시 PRIMARY fallback만 수행
