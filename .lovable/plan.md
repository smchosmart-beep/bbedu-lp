## 진단

채팅에 `태그: present_choices(field="학습목표", ..., options=[...])`가 그대로 적히고 카드가 안 뜨는 사례.

- **카드 미렌더**: 모델이 `present_choices`를 실제 도구 호출이 아닌 본문 텍스트로 적음 → `runChat`의 "no functionCalls" 분기로 떨어짐. 기존 `choiceRetried` 가드는 "고르/선택해 주세요" 안내 멘트에는 반응하지만, 함수 호출 표기까지 적어버린 케이스는 별도로 보정하지 않아 텍스트가 그대로 표시됨.
- **표시 누출**: 이전 plan A의 5개 청소 규칙은 모두 줄 단위 JSON에만 매칭 → `present_choices(...)`/`태그: present_choices(...)` 형태는 통과.

## 안전성 메모(검토 결과 반영)

- 서버 `adaptMessages`는 `role:"tool"`을 항상 user 텍스트로 변환하므로 `tool_call_id` 페어링 부재로 인한 400 위험은 없음 → 누출 케이스도 정상 카드와 동일하게 `state.pendingCall + showChoiceCard` 패턴을 그대로 써도 안전.
- 다만 모델이 "메타 설명"으로 `present_choices(...)`를 본문에 적는 오탐을 막기 위해 **field가 비어있지 않고 옵션 ≥ 3개**일 때만 카드를 렌더(아니면 폴백).
- 청소 정규식의 `[\s\S]*?`는 여러 줄을 잘라낼 위험이 있어 `[^\n]*?`로 한 줄 한정.

## 적용할 변경 (모두 `public/legacy/app35.js`)

### A. 누출 → 즉시 카드 렌더 (`runChat`의 no-functionCalls 분기, 1384~1408줄)
`choiceRetried` 분기 직전에 추가:

```js
const leak = parseLeakedPresentChoices(content || "");
// 오탐 가드: field 있고 옵션 3개 이상일 때만 렌더, 아니면 폴백.
if (leak && leak.field && Array.isArray(leak.options) && leak.options.length >= 3) {
  if (loader) { removeLoader(loader); loader = null; }
  // 다음 턴 보정 신호(히스토리에만 — 화면에는 안 보임)
  state.messages.push({
    role: "user",
    content: "이전 응답에서 present_choices를 텍스트로 적었습니다. 앞으로는 반드시 실제 함수 호출로만 표현하세요. 이번엔 클라이언트가 텍스트에서 후보를 파싱해 카드를 띄웠습니다.",
  });
  const id = `call_${state.callSeq++}`;
  const cardArgs = {
    field: leak.field,
    intro: leak.intro || "",
    options: leak.options,
    multi: !!leak.multi,
    custom: leak.allow_custom !== false,
    none: !!leak.allow_none,
    regenerate: !!leak.allow_regenerate,
  };
  state.pendingCall = { tool_call_id: id, name: "present_choices", cardArgs };
  showChoiceCard(cardArgs);
  state.loading = false; setComposerEnabled(true); updateProgress(); saveState();
  return;
}
```

새 헬퍼 `parseLeakedPresentChoices(text)`:
- `(?:태그|호출|도구\s*호출)?\s*:?\s*present_choices\s*\(([\s\S]*?)\)\s*$`(m 플래그)로 인자 블록 추출.
- 인자 블록에서 `field\s*=\s*"([^"]+)"`, `multi`/`allow_custom`/`allow_none`/`allow_regenerate`의 `=\s*(true|false)`, `intro\s*=\s*"([^"]*)"` 추출.
- `options\s*=\s*\[([\s\S]*?)\]`에서 `"((?:[^"\\]|\\.)*)"` 전부 캡처해 배열로.
- 파싱 실패·옵션 부족 시 `null`.

### B. 표시 청소 규칙 보강 — `addBot()` (327~338줄)
- `^[ \t]*(?:태그|호출|도구\s*호출)\s*:\s*(?:present_choices|update_plan|complete_plan|regenerate_choices)\b[^\n]*$` (gm) 제거.
- `^[ \t]*(?:present_choices|update_plan|complete_plan|regenerate_choices)\s*\([^\n]*\)\s*$` (gm) 제거.
- 한 줄 한정(`[^\n]*`)·도구명 화이트리스트로 한국어 본문 오탐·과잉 컷 방지.
- 기존 5개 규칙과 동일하게 `state.messages` 히스토리는 원문 유지 → 모델 맥락 손실 없음.

### C. 재요청 문구 강화 — `choiceRetried` 분기(1389~1394줄)
재요청 user 메시지 끝에 한 문장:
- "도구는 채팅 본문에 텍스트(예: '태그: present_choices(...)')로 적지 말고 반드시 실제 함수 호출로 보내세요."

### D. 시스템 프롬프트 한 문장 추가 (공통 운영 규칙)
- "도구는 도구 호출로만 표현합니다. 본문에 `present_choices(...)` · `update_plan(...)` · `태그:` · `호출:` 같은 함수 표기를 절대 적지 마세요(적었더라도 사용자에게는 보이지 않으며, 카드도 뜨지 않습니다)."

## 영향 검토

- **A**: 정상 흐름(도구 호출) 분기와 코드 경로가 분리되어 충돌 없음. `state.pendingCall`·`showChoiceCard`는 기존과 동일한 형태로 만들어 `onChoiceSubmit` → `answerPendingCall` 경로가 그대로 동작(서버 `adaptMessages`가 tool→user 변환하므로 페어링 안전). 오탐 가드(field 필수 + 옵션 ≥3)로 메타 설명을 카드로 잘못 띄울 위험 차단. 파싱 실패는 `null` → 기존 `choiceRetried` 재요청 경로로 안전 폴백.
- **B**: 표시 전용, 한 줄 한정, 도구명 화이트리스트 → 오탐·과잉 컷 위험 낮음.
- **C/D**: 입력 토큰 영향 미미.
- **다른 기능**: 시간 게이트, 3-Tier 라우팅, escalation lock, complete_plan 2회 차단, confirmedChoices 가드와 모두 무관(텍스트 분기에서만 동작). `confirmedChoices`는 사용자가 카드에서 선택하면 기존 `onChoiceSubmit` 로직(2044~2050줄)이 그대로 동작해 확정·가드 기록.
- **서버비**: 누출당 재요청 1회(LLM 호출 1회)가 0회로 줄어 **절감**. 추가 비용 없음.

## 변경 파일
- `public/legacy/app35.js`
  - `addBot()` 정규식 2개 추가 (B)
  - `parseLeakedPresentChoices()` 헬퍼 신설 (A)
  - `runChat` no-functionCalls 분기 상단에 A 처리 삽입
  - `choiceRetried` 분기 재요청 문구 한 문장 보강 (C)
  - 공통 운영 규칙 시스템 프롬프트 한 문장 추가 (D)

## 검증
1. 첨부 누출 시나리오 재현 → 학습목표 후보 3개가 즉시 카드(직접 입력 포함)로 뜨는지.
2. 카드에서 후보 선택 → 다음 턴에 LLM이 `update_plan(학습목표·학습주제)`을 정상 호출하고 미리보기 반영되는지.
3. 정상 흐름(실제 함수 호출 present_choices) → 변화 없음.
4. 모델이 메타 설명으로 `present_choices(...)`를 본문에 적은 경우(예: 옵션 2개 또는 field 누락) → 오발 카드가 안 뜨고 기존 `choiceRetried`로 1회 재요청되며, 화면에는 누출 텍스트가 안 보이는지(B 효과).
