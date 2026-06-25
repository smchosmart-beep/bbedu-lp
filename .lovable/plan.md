## 원인 요약

- 게이트웨이 로그에는 방금 호출이 정상 기록되어 있으나 `public.ai_usage_log` 는 0행. 어드민 단계별 표는 이 테이블만 보므로 모든 stage가 0/회색.
- 원인: `src/routes/api/lessonplan/chat.ts` 의 `void logUsage(...)` → 곧바로 `Response.json(...)` 반환. Cloudflare Worker는 응답 반환 시 추적되지 않은 비동기 작업을 종료시키므로 Supabase insert가 완주하지 못함.

## 변경

`src/routes/api/lessonplan/chat.ts` 만 수정. 두 호출 지점(성공 경로 L255 / 에러 경로 L319)을 `void` → `await + 2초 타임아웃 race` 로 교체.

도우미 함수 1개를 파일 상단(logUsage 아래)에 추가:
```ts
async function logUsageBounded(row: Parameters<typeof logUsage>[0]) {
  await Promise.race([
    logUsage(row),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        console.warn("[ai_usage_log] insert timed out (>2s) — skipped");
        resolve();
      }, 2000),
    ),
  ]);
}
```

두 호출 지점은 `await logUsageBounded({...})` 로 변경. 인자 형태/필드 동일.

## 안전성

- logUsage 내부 try/catch는 그대로 — insert 실패도 본 응답을 깨지 않음.
- non-streaming 경로(`generateText` → `Response.json`)라 await가 스트리밍 흐름을 차단할 일 없음.
- 정상 시 TTFB +30~80ms. Supabase 장애 시에도 본 응답 지연 ≤ 2초 보장.
- AI Gateway 호출 횟수/토큰 변동 없음 → 서버비 영향 0.
- 영향 범위: `/api/lessonplan/chat` 하나. `/legacy/35.html`(app35.js) 와 `/legacy/index.html`(app.js) 모두 이 라우트를 쓰므로 양쪽 모두 로그가 정상화됨.
- `src/lib/chat.functions.ts`의 동일 패턴은 이번 범위 밖. (현재 어드민 비용표가 비어 보이는 직접 원인은 chat.ts 쪽이며, chat.functions.ts는 TanStack 경로 전용이라 별 건 발생 시 따로 처리.)

## 검증

1. 빌드 후 `/legacy/35.html`에서 짧은 한 단계만 호출.
2. `select stage, model, count(*) from ai_usage_log group by 1,2 order by 1;` 행이 생기는지 확인.
3. `/legacy/admin35.html` 단계별 표에서 해당 stage 행이 색상·숫자로 표시되는지 확인.
4. 의도적 부하 테스트는 생략 (타임아웃은 코드상 보장).