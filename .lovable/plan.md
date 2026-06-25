# 9·10단계 모델을 MID(3-flash-preview)로 다운그레이드 (테스트용)

## 변경 내용

`src/lib/lessonplan-bridge.server.ts` L35 한 줄만 수정:

```diff
- const PRIMARY_STAGES = new Set([9, 10]); // 전개 세트, 본문 전개
+ const PRIMARY_STAGES = new Set<number>(); // (테스트) 9·10도 MID로 강제 — 회귀 시 [9, 10] 복원
```

결과: stage 9·10이 PRIMARY_STAGES에 매칭되지 않아 라우터 함수의 마지막 분기인 MID(`gemini-3-flash-preview`)로 떨어집니다.

## 다른 단계 영향 없음

- stage 6 → `STAGE6_FORCE_PRIMARY=false` 이므로 기존대로 MID 유지.
- stage 11 → `STAGE11_FORCE_PRIMARY=false` → MID 유지.
- stage 99·100 (검수·최종검토) → 명시 분기로 MID 유지.
- 알 수 없는 stage / stage 누락 → 여전히 PRIMARY 폴백(안전망).

즉 **9·10만** 전이됨.

## 안전 장치

라우터 함수에는 이미 **MALFORMED/JSON_PARSE 폴백** 로직(파일 내 L99 부근)이 있어, MID가 형식 위반을 내면 다음 시도가 PRIMARY로 자동 격상됩니다. 따라서 다운그레이드로 인한 형식 깨짐은 자동 복구되며, 비용 절감 vs 재시도 비용은 어드민 비용 분해 툴팁(직전 턴 적용)으로 곧바로 검증 가능합니다.

## 검증 절차 (사용자가 직접)

1. 새 차시를 빌드하고 9·10단계 통과시키기.
2. `/admin35`에서 해당 행 비용 셀 hover → "본문" 줄이 모두 3-flash-preview 단가로 잡히는지(₩가 이전 대비 1/3 수준으로 떨어지는지) 확인.
3. "재시도" 줄 콜 수가 비정상적으로 늘지 않았는지 확인(늘면 MID가 형식 위반을 자주 내고 폴백된 신호 → 롤백 검토).
4. HWPX 미리보기에서 ◉◦- 위계, `(자)(유)(평)` 라벨, `전개_sub*` 키 누락 여부 확인.

## 롤백

L35 한 줄을 `new Set([9, 10])`로 되돌리면 즉시 원복.

## 변경 파일

- `src/lib/lessonplan-bridge.server.ts` (1줄)
- `.lovable/plan.md`
