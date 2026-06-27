/* 교수·학습 과정안 챗봇 — 좌우 분할 뷰 */

const API_URL = "/api/lessonplan/chat";
const INTER_API_URL = "/api/lessonplan/inter";
// === /35 분기 ===
// 모델 성능 문제로 3.5-flash 고정 버전. 메인(2.5-flash, Interactions)과 코드를 분리해
// 이 파일에서 가드·프롬프트를 자유롭게 단순화한다. 트래픽은 variant="v35"로 분리 집계(관리자 admin35).
const VARIANT = "v35";
const FORCE_MODEL = "gemini-3.5-flash";
// 35 분기는 generateContent 경로(USE_INTER=false) — 프록시 /chat의 explicit 컨텍스트 캐시(시스템프롬프트+함수정의를 캐시 단가)와
// buildAPIMessages의 오래된 RAG 결과 압축으로 입력 토큰·비용을 줄인다. Interactions로 되돌리려면 true로만 바꾸면 됨.
const USE_INTER = false;

const REQUIRED_FIELDS = [
  "교과","학년","학기","단원","차시","교과서쪽수",
  "대상학급","일시","교수학습모형","교과역량",
  "영역","성취기준","핵심아이디어",
  "탐구질문","학습목표","학습주제","수행과제","수업자의도",
  "평가범주","평가방법","평가요소","평가수준상","평가수준중","평가수준하","피드백",
  "도입_학습형태","도입_활동명","도입_교사활동","도입_학생활동","도입_시간","도입_자료유의평가",
  "전개_학습형태","전개_활동명","전개_교사활동","전개_학생활동","전개_시간","전개_자료유의평가",
  "정리_학습형태","정리_활동명","정리_교사활동","정리_학생활동","정리_시간","정리_자료유의평가",
];

const STAGES = ["도입", "전개", "정리"];
const SUB_FIELDS = ["학습형태", "활동명", "교사활동", "학생활동", "자료유의평가", "시간"];
// 활동 추가/삭제 시 함께 옮길 sub 필드(선택적 '단계' 포함). computeMissing엔 쓰지 않음(단계는 필수 아님).
const SUB_FIELDS_MOVE = [...SUB_FIELDS, "단계"];
const subKey = (stage, i, field) => `${stage}_sub${i}_${field}`;
// 수업자가 직접 입력하는 행정 정보 — 빈 셀 게이트·품질 검수에서 제외
const ADMIN_FIELDS = ["차시", "교과서쪽수", "대상학급", "일시"];

const state = {
  datasets: null,
  messages: [],
  plan: null,
  partialPlan: {},
  loading: false,
  subEditedStages: new Set(),
  tangooSeq: 0,
  pendingCall: null,   // present_choices 대기: { tool_call_id, name, cardArgs }
  callSeq: 0,          // tool_call id 생성용
  recentlyUpdated: new Set(),   // 직전 update_plan으로 바뀐 필드 키 — 미리보기 셀 강조용
  usage: { calls: 0, prompt: 0, output: 0, cached: 0 },   // 세션 누적 토큰(합계 — 호환용)
  usageByModel: {},   // 모델별 누적 토큰: {"google/gemini-3.5-flash":{prompt,output,calls}, ...} — 2-Tier 라우팅 정확 환산용
  verifyUsd: 0,          // 세션 누적 품질 검수 비용(USD) — 검수 호출 _usd 누적, 저장 시 단건 비용에 합산(검수 모델 단가 서버 환산본)
  reviewNote: null,      // 방금 외부 검토자(🔎)가 준 의견 — 이걸 본 교사가 다음에 발화하면 그 발화와 함께 1회 본 대화 맥락에 주입(독립 검토라 메인 LLM은 모르므로)
  confirmedChoices: new Set(),   // 사용자가 확정한 CHOICE_PLAN_KEY(normField)들 — LLM이 이미 끝낸 항목 카드를 다시 띄우면(같은 단계 반복·이전 단계로 되돌아감) 가드로 차단
  regenCount: {},                 // field(normField) → "다시 제안" 누른 횟수 (run 단위, 최대 3)
  completeBlocked: false,         // complete_plan 2회 ok:false 후 잠금 (이 run에서 자동 재호출 차단)
  interactionId: null,           // [USE_INTER] previous_interaction_id — 서버가 대화 보관, 클라는 이 ID만 이어 전달
  interInput: null,              // [USE_INTER] 다음 callLLMInter에 보낼 input(첫 턴=user 문자열, 이후=function_result 배열)
  runId: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : ("r" + Date.now() + "-" + Math.random().toString(36).slice(2, 10)),
};

/* ====================== 시스템 프롬프트 (CORE + STAGE_GUIDE 분리) ======================
   토큰 절감: CORE는 매 턴 주입, STAGE_GUIDES는 현재 stage ±1만 동적 주입.
   세부 규칙·★ 안내문은 원문 그대로 보존(라우팅·로직 변경 없음). 회귀 시 FORCE_FULL_PROMPT=true. */

const FORCE_FULL_PROMPT = false;

const CORE_PROMPT = `당신은 한국 초등 교사의 2022 개정 교육과정 기반 교수·학습 과정안 작성을 돕는 조교입니다. 하나의 자연스러운 대화로 과정안을 완성하며, 데이터 조회와 화면 표시는 제공된 함수(도구)로 합니다.

[함수 사용]
- 교육과정 데이터(성취기준·교과역량·핵심 아이디어·고려 사항)는 반드시 RAG 함수를 호출해 받은 원문(코드+문장) 안에서 골라 그대로 씁니다. 어떤 교과든(통합교과 포함) 먼저 RAG 함수로 확인하세요 — 통합교과의 성취기준도 find_standards가 [2바··]/[2슬··]/[2즐··] 코드 원문으로 제공합니다. RAG 결과가 비어 있고 note가 있을 때만(데이터 없는 교과·영역) note 지시대로 그 차시 맥락의 후보를 직접 만들어 제시합니다.
- 보기 중 고르게 할 때는 present_choices로 선택 카드를 띄웁니다. present_choices를 호출하면 턴이 끝나고, 사용자의 선택이 함수 응답으로 돌아옵니다.
  · intro는 맥락에 맞게 자연스럽게. 정답이 정해지지 않은 항목(탐구질문 등)은 "이렇게 제안드려요, 고르시거나 다듬어 주세요"처럼 제안형으로.
  · 당신이 직접 만든 후보(탐구질문·활동명·모형·평가요소 등)는 allow_regenerate=true로, 서로 다른 선택지를 3개 이상 담습니다. RAG 고정 데이터(성취기준·핵심아이디어·교과역량)는 allow_regenerate 없이.
- 미리보기에 값을 반영할 때는 update_plan으로, 이번에 새로 정하거나 바뀐 필드만 넣습니다(이미 확정된 필드를 다시 보내거나 빈 값으로 덮지 않도록).
- update_plan만 하는 작성 단계(학습목표, 교수·학습 활동, 수업자 의도)는 미리보기 반영 후 "확인하시고 다음으로 진행할까요?"처럼 한 줄 확인을 받고 넘어갑니다. (선택 카드 단계는 카드 선택이 곧 진행입니다.)
- 모든 설계가 끝나면(수업자 의도까지) complete_plan을 호출해 완료 처리합니다.
- 변경 내역·이유를 물으면("어떻게 고쳤어?·왜 바꿨어?·설명해 줘") 함수를 호출하지 않고 글로만, 무엇을 왜 어떻게 바꿨는지 항목별로 설명합니다(complete_plan 이후에도). 사용자가 "그만 고치라"고 하면 수정을 멈추고 묻는 말에만 답합니다.
- 도구 호출 자체나 도구 결과(JSON)는 사용자에게 텍스트로 다시 적지 마세요. "[도구 결과: …]"·"{\"fields\": …}"·"{\"ok\": true}" 같은 줄을 채팅 답변에 넣지 않습니다. 도구 호출은 함수 호출로만 실행하고, 의미(무엇을·왜)는 한국어 한 줄 요약으로만 전달합니다.
- 도구는 도구 호출로만 표현합니다. 본문에 \`present_choices(...)\` · \`update_plan(...)\` · \`태그:\` · \`호출:\` 같은 함수 표기를 절대 적지 마세요(적었더라도 사용자에게는 보이지 않으며, 카드도 뜨지 않습니다).
- 사용자는 카드 대신 입력창에 말로 답할 수도 있습니다("'교과역량'에 대한 사용자 답변: 정보활용능력"). 그 답을 해당 항목의 선택으로 받아, 필요하면 RAG 결과에 맞게 다듬어(예: "정보" → "정보 활용 능력") update_plan으로 반영하고 다음 단계로 진행합니다.

[정보 수집]
각 단계에서 필요한 정보가 부족하거나 답이 모호하면, 부족한 부분만 한 가지씩 되물어 충분히 모은 뒤 진행합니다. 사용자가 "알아서"라고 해도 핵심 정보는 한 번 확인하고, 끝내 답이 없으면 합리적 기본값을 제안하며 확인받습니다. 이미 말한 정보는 다시 묻지 않습니다.

[권장 진행 순서] 한 번에 한 가지씩 확인하며 진행합니다. 각 단계의 세부 규칙은 진행 상황에 맞춰 별도 안내됩니다(아래 '[N단계 세부]' 블록 참고).
1. 기본 정보 (학년·교과·학기·단원·차시 학습 내용).
2. 성취기준 (find_standards).
3. 핵심 아이디어 (list_core_ideas).
4. 교과 역량 (list_competencies).
5. 탐구 질문 (직접 생성, 3개 후보).
6. 평가 계획 — 백워드 설계 ⓪~③, 각 평가 범주마다 ㄱ→ㄴ→ㄷ→ㄹ.
7. 학습목표·학습주제.
8. 교수·학습 모형 (list_lesson_models).
9. 전개 활동 구성 (세트 2~3개 제안).
10. 교수·학습 활동 (도입·전개·정리 작성).
11. 수업자 의도 → 검토 → 완료 (complete_plan).

사용자가 질문하거나 순서를 바꾸자고 하면 유연하게 따르세요. 위는 권장 순서입니다.

[사용자 직접 입력 다듬기]
present_choices에서 사용자가 직접 입력(custom_input)하면 "○○ 라는 말씀이시지요?"처럼 의도를 한 문장으로 되짚고, 그 표현을 해당 필드에 맞게 다듬어 반영합니다. 어색하면 다듬은 후보를 present_choices로 다시 제시해도 됩니다.

[2022 개정 교육과정 용어]
- 핵심 아이디어: 영역을 아우르며 일반화할 수 있는 내용을 핵심적으로 진술한 것.
- 탐구 질문: 호기심을 자극하고 다양한 관점·해석을 유도하는 질문(예/아니오로 답하지 않음).
- 성취기준: 배울 내용과 기대 능력을 결합한 기준.
- 내용 요소 = 지식·이해 / 과정·기능 / 가치·태도.
- 평가 요소: 성취기준 도달의 증거로 학생이 보여줄 핵심 내용. 명사형(동명사 '~기')으로 진술(예: "~알기/쓰기/비교하기").
- 성취수준 상/중/하: 도달 정도를 세 단계로, 모두 학생이 '할 수 있는 것·도달 정도'로 긍정적으로 진술하고, '하'도 능력의 범위·정도('기초적·일부·도움을 받아·제한적')로 표현(교육부 2022 개정 진술 방식).

[필드 작성 규칙]
- 교사활동: ◉(주요) ◦(세부) -(발문) 위계 기호, 항목마다 줄바꿈(\\n).
- 학생활동: 예상 반응 위주로, ◦(주요 반응)와 -(세부) 글머리를 붙여 항목마다 줄바꿈(\\n). 교사활동의 ◉◦-처럼 글머리 기호로 항목을 구분합니다.
- 자료유의평가: "(자)내용\\n(유)내용\\n(평)내용" 형식. 각 줄은 (자)/(유)/(평) 라벨로 시작하고 콜론 없이 바로 붙여 씁니다(예: "(자)활동 안내 슬라이드\\n(유)모둠별 진도 차이에 유의\\n(평)관찰 평가"). 약물 기호(㉶)는 시스템이 HWPX에서 자동 변환합니다.
- 시간(분)은 숫자로: 통합 키 "도입_시간"/"전개_시간"/"정리_시간", 다중 활동이면 "전개_sub{i}_시간"(예: "5","15","10").
- 전개에 활동이 여러 개면 "전개_num_subs"(개수, 정수)와 활동마다 "전개_sub{i}_단계","전개_sub{i}_학습형태","전개_sub{i}_활동명","전개_sub{i}_교사활동","전개_sub{i}_학생활동","전개_sub{i}_시간","전개_sub{i}_자료유의평가"를 씁니다. 활동이 1개면 통합 키(전개_단계·전개_학습형태 등). 다중 활동(sub)은 전개에만 씁니다.
- "단계"는 8단계 교수·학습 모형의 단계명(예: "자유 탐색")을 짧게 적는 칸입니다(미리보기 학습형태 위에 표시). 모형·단계가 없으면 비웁니다.
- 도입과 정리는 활동이 하나입니다 — 통합 키(도입_교사활동·정리_교사활동 등)만 쓰고 ◉◦- 위계 기호로 단일 활동을 작성합니다(도입_num_subs·정리_num_subs 키나 "(활동 N)" 마커 없이).
- sub 키 본문은 ◉ ◦ -로 시작합니다("[활동 N]" 헤더는 미리보기 카드가 표시하므로 본문에 넣지 않습니다).
- 차시·교과서쪽수·대상학급·일시는 비워 둡니다(임의 생성하지 않음).

[채팅 길이]
우측 미리보기가 주 출력 공간입니다. 채팅은 짧게(보통 1~3문장). 상세 내용은 update_plan으로 보내고, 반영 후 채팅엔 "미리보기에 반영했어요, 확인해 주세요." 정도면 충분합니다.

[톤]
친근하고 자연스러운 존댓말. 사용자가 쓴 표현·용어를 보존하고, 한 응답은 짧고 명확하게.`;

const STAGE_GUIDES = {
  1: `기본 정보: 학년·교과·학기·단원·차시 학습 내용을 대화로 확인.
   ★ 시작 시 사용자가 '[이번 차시에 대한 제 생각]'으로 적은 의도·아이디어·강조점을 끝까지 존중해, 차시 파악은 물론 탐구질문·모형·전개 활동·평가 설계 전반에 반영하세요. (적힌 내용이 차시를 특정하기에 모호하면 무엇을 다루는지 한 번 더 확인합니다.)
   ★ 단원은 시작 폼에서 받으므로, 차시 학습 내용을 길게 캐묻기보다 교사가 적은 주제·아이디어를 맥락 삼아 바로 2단계(성취기준)로 진행하세요. find_standards로 그 단원의 성취기준을 받아 제시하면 됩니다 — 통합교과처럼 단원 단위로 성취기준이 정해진 경우 차시를 먼저 정하지 않아도 됩니다. (차시 학습 내용은 이후 단계에서 구체화되고 교사가 재구성하므로, 단원명 자체를 차시 학습 내용으로 적지는 않습니다.)
   ★ 교사가 "이 단원에서 무엇을 배우나요?"라고 물으면 시스템이 제공한 '단원학습내용'(교과서 차시 목록)을 채팅 텍스트로 참고용으로 안내하세요(present_choices 카드 대신 — 교사가 자유롭게 재구성합니다. 단원명만 보고 학습 내용을 지어내지 않습니다).
   (차시 번호·교과서 쪽수·대상 학급·일시는 수업자가 직접 입력하는 행정 정보입니다.) 파악되면 update_plan으로 교과·학년·학기·단원 반영.`,

  2: `성취기준: find_standards 호출 → 받은 후보 중 이 차시에 맞는 것을 present_choices(multi=true, allow_custom=true)로 제시 → update_plan(성취기준). find_standards 결과에 '단원학습내용'(차시 목록)이 오면 사용자가 말한 수업 주제와 대조해 차시 맥락 파악·환각 방지에 활용합니다. 사용자 메시지에 출판사(예: "아이스크림미디어 교과서")가 있으면 find_standards에 함께 전달하세요. 성취기준은 옵션·값 모두 코드(예: [4과09-01])를 맨 앞에 포함한 원문 전체로 씁니다("[코드] 본문" 형식 그대로). 사용자가 직접 입력(custom)한 성취기준은 목록에 없거나 표현이 달라도 교사의 재구성이므로 그대로 존중합니다. 영역은 데이터에서 고른 성취기준이면 시스템이 단원의 영역으로 자동 반영하므로, 따로 묻거나 update_plan하지 않습니다(단, 직접 입력해 매칭이 안 되면 코드가 있으면 그 영역을, 없으면 알맞은 영역을 한 번 확인해 update_plan(영역)으로 반영). 성취기준을 고르면 시스템이 '성취기준 해설'과 '적용 시 고려 사항'을 자동 안내하므로, 같은 응답에서 바로 3단계로 진행하세요(list_considerations로 다시 안내할 필요 없음).`,

  3: `핵심 아이디어: list_core_ideas(교과, 영역) → present_choices(multi=true, allow_custom=true) → update_plan(핵심아이디어). 교육과정에 제시된 것을 고르는 항목이므로, 실제 데이터(note 없음)면 intro를 "2022 개정 교육과정에 제시된 핵심 아이디어 중에서 고르시거나 직접 입력해 주세요"로, 데이터 없는 교과(note 있음)면 "이 차시 맥락에 맞게 제안한 핵심 아이디어예요"로 안내합니다. 어느 경우든 allow_custom=true로 교사가 직접 추가·재구성할 수 있게 합니다.`,

  4: `교과 역량: list_competencies(교과) → present_choices(multi=true) → update_plan(교과역량).`,

  5: `탐구 질문: 핵심아이디어·성취기준에 연결된, 정답 찾기가 아닌 질문 후보 3개를 만들어 present_choices(multi=true, allow_custom=true, allow_regenerate=true)로 제안형 intro와 함께 제시 → update_plan(탐구질문). 예: "성취기준과 핵심 아이디어를 바탕으로 이런 탐구 질문을 제안드려요. 마음에 드는 것을 고르시거나 직접 다듬어 적어 주세요."`,

  6: `평가 계획 (백워드 설계 — ⓪~③을 하나씩 present_choices로 확정하며 진행):
   ★ 진입 안내: 탐구 질문 직후 ⓪ 카드를 띄우기 전에, 백워드 설계를 시작한다는 안내를 한 번 보냅니다. '영속적 이해'·'수용 가능한 증거'는 생소하니 풀어서 안내하세요. 예: "평가 계획을 백워드 설계로 먼저 세워 볼게요. 학생이 무엇을 이해하고 할 수 있어야 하는지 정한 뒤 그 확인 방법을 정하는 방식이에요. 먼저 오래 기억하길 바라는 영속적 이해와 그것을 확인할 수용 가능한 증거를 찾아보겠습니다."
   ⓪ 영속적 이해: 핵심 아이디어(영역 수준)를 이 차시 수준으로 구체화한 영속적 이해 후보 2~3개를 present_choices(field="영속적 이해", multi=false, allow_custom=true, allow_regenerate=true)로 제시 → 확정. (본질적 질문은 앞서 정한 탐구 질문을 사용합니다.)
   ① 수용 가능한 증거: 영속적 이해·탐구 질문 도달을 확인할 산출물·관찰 장면 후보 2~3개를 present_choices(field="수용 가능한 증거", multi=false, allow_custom=true, allow_regenerate=true)로 제시 → 확정.
   ② 수행 과제: 위 증거를 담는 수행 과제 안을 present_choices(field="수행 과제", multi=false, allow_custom=true, allow_regenerate=true)로 제시 → update_plan("수행과제").
   ※ ⓪~①은 문서 칸이 없으니 present_choices로 확정만 받고 update_plan하지 않습니다(② 수행 과제만 반영).
   ③ 평가 범주: present_choices(field=평가범주, options=["지식·이해","과정·기능","가치·태도"], multi=true)로 받고, 고른 각 범주(i=1,2,…)마다 아래 ㄱ→ㄴ→ㄷ→ㄹ을 **한 번에 하나씩** 진행합니다 — 한 항목을 present_choices(또는 update_plan)로 처리하고 그 결과(사용자 선택·반영)를 받은 뒤에만 다음 항목으로 넘어갑니다. 한 응답에 한 항목만 다루고(특히 성취수준 '상'을 present_choices로 받은 뒤에 피드백으로 넘어갑니다), 성취수준·피드백을 한꺼번에 몰아 update_plan하지 않습니다:
      ㄱ. 평가요소: present_choices(field="평가요소", allow_custom=true) → update_plan("평가{i}_요소"). 평가요소는 명사형(동명사 '~기')으로 적습니다(예: "한글 자모의 이름과 소릿값 알기", "받침이 있는 글자 쓰기", "수평잡기 활동으로 물체 무게 비교하기"). 한 범주에 여럿이면 명사형으로 각각 쉼표·줄바꿈 구분. 사용자가 직접 입력해도 명사형으로 다듬어 반영합니다.
      ㄴ. 평가방법: present_choices(field="평가방법", multi=true, allow_custom=true, allow_regenerate=true)로 그 범주·요소에 맞는 방법 후보(관찰·수행·서술형/논술형·구술·자기·동료·포트폴리오 평가 등)를 제시 → update_plan("평가{i}_방법", 여러 개면 쉼표로 이어 적기).
      ㄷ. 성취수준: '상' 기준만 present_choices(allow_custom)로 받고, '중'·'하'는 자동 작성 → 한 번의 update_plan으로 "평가{i}_수준상","평가{i}_수준중","평가{i}_수준하" 함께 반영.
         ★ 성취수준 진술(교육부 2022 개정 지침): 상·중·하 모두 학생이 '도달한 정도와 할 수 있는 것'을 긍정적·기능적으로 진술하고, 세 수준을 능력의 범위·깊이·자립도로 구분합니다.
         · 상: 개념 이해가 깊고, 다양한 맥락에 능숙하게 적용하며 범위가 넓다.
         · 중: 개념을 이해하고 핵심을 수행하며, 일부 맥락에 적용한다.
         · 하: 기초 개념을 일부 이해하고, 도움을 받아 일부를 수행하며, 적용 범위가 제한적이다.
         어휘는 상="깊이·능숙·다양한·넓음", 중="보통·기본적·일부 맥락", 하="기초적·일부·도움을 받아·제한적"을 씁니다.
      ㄹ. 피드백 (오직 '하' 수준 학생 지원): '하' 수준(기초만 도달) 학생이 다음 단계로 나아가도록 교사가 도울 방안을 update_plan("평가{i}_피드백")으로 반영합니다(상·중 칭찬·확장은 넣지 않음). 그 평가요소에서 어려운 부분을 기초부터 다시 안내·예시·단계적 발문으로 돕는 구체적 지원을 '~하도록 한다/안내한다' 형태의 한 문장으로, 수준 표시 없이 지원 내용만 적습니다(피드백 항목 자체가 '하' 지원이므로 '(하)' 접두는 붙이지 않습니다). 예: '합동과 관련된 수학 용어를 다시 상기시키고 설명해 보도록 한다.'
      평가 키는 범주가 1개여도 인덱스를 붙이고("평가1_범주","평가1_요소","평가1_방법","평가1_수준상","평가1_수준중","평가1_수준하","평가1_피드백"), update_plan에 "평가_num"(범주 수)을 함께 넣습니다.`,

  7: `학습목표·학습주제: 학습목표 후보 3개(Tyler식 "~할 수 있다.", 성취기준·핵심아이디어·탐구질문에 근거해 초점이 다른 3개)를 present_choices(field="학습목표", multi=false, allow_custom=true, allow_regenerate=true)로 제시 → 고른 학습목표와 거기서 도출한 학습주제(명사형)를 한 번의 update_plan에 "학습목표"·"학습주제" 둘 다 넣어 반영합니다("학습목표" 키를 함께 넣는 것을 잊지 마세요).`,

  8: `교수·학습 모형: list_lesson_models(교과)를 먼저 호출하고, 받은 목록에서 학습목표·평가에 맞는 4~6개를 present_choices(multi=false, allow_none=true)로 제시합니다. 각 옵션은 "모형명 (1단계 → 2단계 → …)"처럼 단계 흐름을 곁들이고(단계 없는 모형은 모형명만), 모형은 RAG 목록에 있는 것만 씁니다. update_plan("교수학습모형")에는 모형명만(괄호 단계 제외) 저장합니다. 고른 모형의 단계는 9·10단계 전개 활동의 뼈대로 씁니다.`,

  9: `전개 활동 구성: 8단계에서 고른 모형의 단계를 전개 활동의 뼈대로 삼습니다. 단계가 있으면 그 흐름에 대응해 구성하고, 없으면 학습목표에 맞게 자유 구성합니다. 활동 흐름(세트)을 2~3개 제안하되, 한 옵션 = 한 세트(활동 2~3개 묶음)로 present_choices(multi=false, allow_regenerate=true)에 담고, 각 옵션은 "① 활동명1 → ② 활동명2 → ③ 활동명3" 형태로 적습니다. 고른 세트의 활동들로 10단계 전개_sub를 구성합니다.`,

  10: `교수·학습 활동: 고른 세트로 도입·전개·정리를 작성해 반영합니다. update_plan은 단계별로 나눠 작게 호출하세요(한 호출에 모든 단계를 몰아넣으면 함수 인자 생성이 깨집니다 — MALFORMED_FUNCTION_CALL): ①도입(도입_* + "전개_num_subs"), ②전개 활동을 하나씩(전개_sub1_* → 전개_sub2_* …, 각 호출에 그 활동의 필드만), ③정리(정리_*). 각 update_plan의 fields 배열에는 한 단계(또는 한 전개 활동)의 필드만 담아 작게 유지합니다(각 value는 여러 줄·기호를 그대로 적고 JSON으로 다시 감싸지 않습니다). 각 단계·활동마다 학습형태·교사활동(◉◦-)·학생활동·시간(분)·자료유의평가를 모두 채우고, 도입·전개·정리 세 단계의 교사활동·학생활동을 쌍으로 채웁니다(정리 단계 포함). 전개에 활동이 여러 개면 "전개_num_subs"와 활동마다 "전개_sub{i}_교사활동/학생활동/시간/자료유의평가"를 넣습니다. 8단계 모형의 단계명을 각 활동의 '단계' 키에 대응시킵니다(다중="전개_sub{i}_단계", 단일·도입·정리="전개_단계"/"도입_단계"/"정리_단계"; 단계명은 모형 단계만 짧게, 활동명과 분리; 단계 없는 모형·미선택이면 비움). ★시간 합은 정확히 40분(±0): 도입 5 / 전개 25~30 / 정리 5. update_plan 결과에 warn이 오거나 합이 40이 아니면 가장 긴 전개_sub{i}_시간만 보정해서 즉시 update_plan을 다시 호출하세요. 채팅 본문에 "fields: [...]"나 {"fields":...} 같은 JSON을 절대 적지 마세요(도구 호출만으로 표현). 활동 반영 후 반드시 11단계로 진행합니다. ★ 이 단계에서는 절대 complete_plan을 호출하지 마세요 — 검수는 11단계 끝에서 수행합니다.`,

  11: `수업자 의도 → 검토 → 완료: ★ 10단계에서 곧장 complete_plan을 호출하면 안 됩니다. 반드시 본 단계에서 "수업자의도"를 먼저 update_plan으로 저장한 뒤에만 complete_plan을 호출합니다. 완성된 설계를 바탕으로 수업자 의도(왜 이렇게 설계했는지, 주안점)를 3~5문장으로 update_plan("수업자의도"). 그다음 "이제 전체 과정안을 검토하겠습니다."라고 한 줄 안내하고 complete_plan을 호출합니다(검토는 complete_plan이 수행하므로 따로 점검 보고하지 않습니다). complete_plan이 ok:true면 완료를 알리고, ok:false면 지적 사항을 사용자에게 간단히 전한 뒤 update_plan으로 고쳐 다시 complete_plan을 호출합니다(ok:true를 받기 전에는 "완료됐습니다"라고 하지 않습니다).`,
};

function buildSystemPrompt(stage) {
  const s = Math.max(1, Math.min(11, parseInt(stage) || 1));
  if (FORCE_FULL_PROMPT) {
    const all = Object.keys(STAGE_GUIDES).map(k => `[${k}단계 세부]\n${STAGE_GUIDES[k]}`).join("\n\n");
    return `${CORE_PROMPT}\n\n${all}`;
  }
  const window = [s - 1, s, s + 1].filter(n => n >= 1 && n <= 11);
  const guides = window.map(n => `[${n}단계 세부]\n${STAGE_GUIDES[n]}`).join("\n\n");
  return `${CORE_PROMPT}\n\n${guides}`;
}

// 하위 호환: 기존 참조가 남아 있어도 동작하도록 초기값 제공(저장 메시지에 들어가는 system은 매 턴 buildSystemPrompt로 교체됨)
const SYSTEM_PROMPT = buildSystemPrompt(1);


/* ====================== 함수(도구) 선언 ====================== */
/* Gemini function calling 형식. 프록시가 그대로 Gemini에 전달한다.
   RAG 4개(데이터 조회) + UI/제어 3개(present_choices·update_plan·complete_plan). */
const TOOLS = [{ functionDeclarations: [
  { name: "find_standards",
    description: "교과·학년·학기·단원으로 2022 개정 교육과정의 실제 성취기준 후보 목록을 조회한다. 성취기준은 반드시 이 결과 안에서만 골라야 한다(지어내지 말 것). 각 항목에 성취기준 원문·영역·해설이 포함된다.",
    parameters: { type: "object", properties: {
      교과: { type: "string", description: "예: 사회, 수학, 국어" },
      학년: { type: "integer", description: "1~6" },
      학기: { type: "integer", description: "1 또는 2" },
      단원: { type: "string", description: "단원명 또는 차시 주제(있으면 더 정확히 좁혀짐)" },
      출판사: { type: "string", description: "교과서 출판사(사용자가 알려준 경우만). 5~6학년 단원 정밀 매칭에 사용." },
    }, required: ["교과", "학년"] } },
  { name: "list_competencies",
    description: "해당 교과의 2022 개정 공식 교과 역량 목록을 조회한다. 교과 역량은 이 목록 안에서만 골라야 한다.",
    parameters: { type: "object", properties: {
      교과: { type: "string" },
    }, required: ["교과"] } },
  { name: "list_core_ideas",
    description: "교과·영역의 핵심 아이디어 문장 목록을 조회한다. 핵심 아이디어는 이 결과 안에서만 골라야 한다.",
    parameters: { type: "object", properties: {
      교과: { type: "string" },
      영역: { type: "string", description: "성취기준에서 자동 결정된 영역(쉼표로 여러 개 가능)" },
    }, required: ["교과", "영역"] } },
  { name: "list_considerations",
    description: "교과·영역·학년의 성취기준 적용 시 고려사항을 조회한다(참고용).",
    parameters: { type: "object", properties: {
      교과: { type: "string" },
      영역: { type: "string" },
      학년: { type: "integer" },
    }, required: ["교과", "영역"] } },
  { name: "list_lesson_models",
    description: "해당 교과의 실제 교수·학습 모형(수업 모형) 목록을 조회한다. 각 모형은 단계명 흐름(절차) 또는 한 줄 설명을 포함한다. 교수·학습 모형은 이 목록 안에서만 골라야 한다(지어내지 말 것). 고른 모형의 단계는 전개 활동 구성의 뼈대로 쓴다.",
    parameters: { type: "object", properties: {
      교과: { type: "string" },
    }, required: ["교과"] } },
  { name: "present_choices",
    description: "사용자에게 선택 카드를 띄운다. 이 함수를 호출하면 당신의 턴은 즉시 끝나고, 사용자가 카드에서 고른 결과(selected 배열, custom_input, none)가 함수 응답으로 다음 턴에 전달된다. 채팅에 번호 목록을 직접 쓰지 말고 항상 이 함수를 사용할 것.",
    parameters: { type: "object", properties: {
      field: { type: "string", description: "선택 대상 라벨. 예: 성취기준, 교과역량, 핵심아이디어, 탐구질문, 평가범주, 평가요소, 교수학습모형, 활동명" },
      intro: { type: "string", description: "카드 위에 보일 짧은 안내 문장(1~2문장)" },
      options: { type: "array", items: { type: "string" }, description: "후보 목록(각 항목 하나의 값)" },
      multi: { type: "boolean", description: "true=여러 개 선택 허용" },
      allow_custom: { type: "boolean", description: "직접 입력 허용(기본 true)" },
      allow_none: { type: "boolean", description: "'선택 안 함' 허용(기본 false)" },
      allow_regenerate: { type: "boolean", description: "'다른 후보 추천받기' 버튼 표시. 정답이 없고 네가 직접 만든 후보(탐구질문·활동명·교수학습모형·평가요소 등)일 때 true. RAG로 받은 고정 데이터(성취기준·핵심아이디어·교과역량)는 false." },
    }, required: ["field", "intro", "options"] } },
  { name: "update_plan",
    description: "오른쪽 미리보기 과정안의 필드를 갱신한다. 확정된 값은 반드시 이 함수로 반영할 것.",
    parameters: { type: "object", properties: {
      fields: {
        type: "array",
        description: '갱신할 필드 목록. 각 항목은 {"key":필드명,"value":값}. value는 일반 문자열로 그대로 적는다(여러 줄·기호 포함, JSON으로 다시 감싸지 마라). 예: [{"key":"학습목표","value":"…할 수 있다."},{"key":"전개_sub1_교사활동","value":"◉ 활동명\\n◦ 세부 활동"}]',
        items: { type: "object", properties: {
          key: { type: "string", description: "필드명(예: 학습목표, 전개_num_subs, 전개_sub1_교사활동)" },
          value: { type: "string", description: "필드 값(여러 줄·기호 그대로, 추가 이스케이프 불필요)" },
        }, required: ["key", "value"] },
      },
    }, required: ["fields"] } },
  { name: "complete_plan",
    description: "모든 설계가 끝났을 때 호출한다. 과정안을 완료 처리하고 HWPX 다운로드를 안내한다.",
    parameters: { type: "object", properties: {} } },
]}];

/* ====================== DOM helpers ====================== */
const chatEl     = () => document.getElementById("chat");
const inputEl    = () => document.getElementById("input");
const sendBtnEl  = () => document.getElementById("sendBtn");
const quickAreaEl= () => document.getElementById("quickArea");
const progressEl = () => document.getElementById("progress").firstElementChild;
const previewEl  = () => document.getElementById("planPreview");
const dlBtnEl    = () => document.getElementById("dlBtn");
const welcomeEl   = () => document.getElementById("welcome");
const workspaceEl = () => document.getElementById("workspace");

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]
  );
}
function renderMarkdown(s) {
  s = String(s || "");
  // LaTeX 수식($$...$$, $...$)을 placeholder로 빼두어 marked가 안쪽(_, * 등)을 건드리지 않게 한다.
  // marked 처리 후 복원하고, addMsg에서 KaTeX(renderMathInElement)가 실제 렌더한다.
  const maths = [];
  s = s.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => { maths.push(m); return `\u0000M${maths.length - 1}\u0000`; });
  // CommonMark는 **'…'** / *'…'* 처럼 강조 기호 안쪽 경계가 따옴표면 강조를 적용하지 않는다
  // (flanking 규칙). LLM이 자주 이렇게 출력하므로 따옴표를 강조 밖으로 옮겨 정상 렌더되게 한다.
  s = s.replace(/\*\*\s*(['"“”‘’])(.+?)\1\s*\*\*/g, "$1**$2**$1");          // 볼드+따옴표
  s = s.replace(/(?<!\*)\*\s*(['"“”‘’])(.+?)\1\s*\*(?!\*)/g, "$1*$2*$1");   // 이탤릭+따옴표(** 제외)
  // **[코드]**한글 — 닫는 ** 앞이 ]구두점·뒤가 한글이면 볼드가 안 닫힘 → 직접 <strong>으로 치환
  s = s.replace(/\*\*(\[[^\]\n]+\])\*\*/g, "<strong>$1</strong>");
  let html = (typeof marked !== "undefined") ? marked.parse(s) : escapeHTML(s).replace(/\n/g, "<br>");
  html = html.replace(/\u0000M(\d+)\u0000/g, (_, i) => maths[+i]);   // 수식 복원
  return html;
}

function scrollBottom() {
  const el = chatEl();
  setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }), 30);
}

function addMsg(html, role = "bot") {
  const wrap = document.createElement("div");
  wrap.className = role === "user" ? "flex justify-end" : "flex justify-start";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble " + (role === "user" ? "msg-user" : "msg-bot markdown");
  bubble.innerHTML = html;
  wrap.appendChild(bubble);
  chatEl().appendChild(wrap);
  scrollBottom();
  return bubble;
}

// 말풍선 안의 LaTeX 수식($$...$$, $...$, \(...\), \[...\])을 KaTeX로 렌더
function renderMath(el) {
  if (typeof renderMathInElement !== "function") return;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
      output: "html",   // MathML 생략 — Chromium native MathML이 레이아웃 높이를 키워 페이지가 늘어나는 문제 방지
    });
  } catch (e) { /* 수식 파싱 실패 시 원문 유지 */ }
}

/* 자료·유의점·평가 레이블 약어 변환 (표시 전용)
   ㉶ 자료: → [원안 자]  유의점: → [원안 유]:  평가: → [원안 평]:
   sym-h(display:none)는 시각적으로 숨기지만 getEditableText가 텍스트로 추출해 원본 복원.
   평가: 는 "자료·유의점·평가:" 복합 레이블 안에서 오변환 방지를 위해
   앞 글자가 ·(가운뎃점)인 경우 제외(lookbehind). */
function styleLabels(text) {
  return String(text)
    // 자료: → (자) (㉶ 약물 유무 무관. sym-h '료:'로 추출 시 '자료:' 복원)
    .replace(/㉶?\s*자료\s*:/g, '<span class="sym-c">자</span><span class="sym-h">료:</span>')
    // 유의점:
    .replace(/유의점\s*:/g, '<span class="sym-c">유</span><span class="sym-h">의점</span>:')
    // 평가: — 앞이 · 인 경우(자료·유의점·평가:) 제외
    .replace(/(?<![·])평가\s*:/g, '<span class="sym-c">평</span><span class="sym-h">가</span>:');
}

function addBot(text) {
  // AI가 채팅 텍스트에 \n을 두 글자 그대로 출력할 경우 실제 줄바꿈으로 변환
  let raw = String(text || "").replace(/\\n/g, '\n');
  // 모델이 자기 도구 호출/결과를 자연어로 에코하는 경우 방어선:
  // "[도구 결과: …]" 줄과 바로 뒤이은 JSON-only 줄을 제거. (드물게 [도구 호출: …]도 동일 처리)
  raw = raw.replace(/^[ \t]*\[도구 (?:결과|호출)\s*:[^\n]*\n?(?:[ \t]*[\{\[][^\n]*[\}\]][ \t]*\n?)?/gm, '');
  // update_plan 인자/도구 결과를 본문에 그대로 적어버리는 누출 줄 제거 (히스토리는 원문 유지)
  raw = raw.replace(/^[ \t]*fields\s*:\s*[\[\{].*$/gm, '');
  raw = raw.replace(/^[ \t]*\{?\s*"fields"\s*:[\s\S]*?\]\s*\}?\s*$/gm, '');
  raw = raw.replace(/^[ \t]*\[?\s*\{\s*"key"\s*:[\s\S]*?\}\s*\]?\s*$/gm, '');
  raw = raw.replace(/^[ \t]*\{?\s*"ok"\s*:\s*(?:true|false)[\s\S]*?\}\s*$/gm, '');
  // 함수 호출형/레이블형 누출(예: "태그: present_choices(...)", "update_plan(...)") — 한 줄 한정·도구명 화이트리스트
  raw = raw.replace(/^[ \t]*(?:태그|호출|도구\s*호출)\s*:\s*(?:present_choices|update_plan|complete_plan|regenerate_choices)\b[^\n]*$/gm, '');
  raw = raw.replace(/^[ \t]*(?:present_choices|update_plan|complete_plan|regenerate_choices)\s*\([^\n]*\)\s*$/gm, '');
  raw = raw.replace(/\n{3,}/g, '\n\n').trim();
  const processed = styleLabels(raw);
  const bubble = addMsg(renderMarkdown(processed));
  renderMath(bubble);   // 수식은 봇 메시지에만 — user(escape됨)·loader(스피너)는 LaTeX 없음
  return bubble;
}
function addUser(text) { return addMsg(escapeHTML(text), "user"); }

/* 모델이 present_choices를 본문 텍스트로 적은 경우를 파싱.
   성공 시 {field, intro, options[], multi, allow_custom, allow_none, allow_regenerate} 반환, 실패 시 null. */
function parseLeakedPresentChoices(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/present_choices\s*\(([\s\S]*?)\)\s*$/m);
  if (!m) return null;
  const body = m[1];
  const pick = (re) => { const x = body.match(re); return x ? x[1] : null; };
  const pickBool = (re) => { const x = body.match(re); return x ? x[1] === "true" : undefined; };
  const field = pick(/\bfield\s*=\s*"([^"]+)"/);
  const intro = pick(/\bintro\s*=\s*"((?:[^"\\]|\\.)*)"/) || "";
  const multi = pickBool(/\bmulti\s*=\s*(true|false)/);
  const allow_custom = pickBool(/\ballow_custom\s*=\s*(true|false)/);
  const allow_none = pickBool(/\ballow_none\s*=\s*(true|false)/);
  const allow_regenerate = pickBool(/\ballow_regenerate\s*=\s*(true|false)/);
  const optsBlock = body.match(/\boptions\s*=\s*\[([\s\S]*?)\]/);
  if (!optsBlock) return null;
  const options = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let mm;
  while ((mm = re.exec(optsBlock[1])) !== null) {
    options.push(mm[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  if (!field || options.length === 0) return null;
  return { field, intro, options, multi, allow_custom, allow_none, allow_regenerate };
}


function addLoader() {
  return addMsg(`<span class="spinner"></span> <span class="loader-text text-slate-500 text-sm">생각 중…</span>`);
}
function setLoaderText(node, text) {
  const t = node?.querySelector?.(".loader-text");
  if (t) t.textContent = text;
}
function removeLoader(node) {
  if (node?.parentNode?.parentNode) node.parentNode.parentNode.removeChild(node.parentNode);
}

function setComposerEnabled(enabled) {
  inputEl().disabled = !enabled;
  sendBtnEl().disabled = !enabled;
  if (enabled) inputEl().focus();
}

function clearQuick()   { quickAreaEl().innerHTML = ""; }

function renderProgress(pct) {
  const p = progressEl();
  const filled = Math.max(0, Math.min(1, pct));
  p.innerHTML = `<div class="step-pill done" style="flex:${filled}"></div><div class="step-pill" style="flex:${1-filled}"></div>`;
}

/* ====================== 우측 미리보기 ====================== */

function pVal(key) {
  const v = state.partialPlan[key];
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}

/* contenteditable에서 순수 텍스트 추출 (br → \n, HTML 제거) */
function getEditableText(el) {
  return el.innerHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}

/* 편집 가능한 표 셀 내용 (contenteditable + data-key 유지 — 이벤트 위임 대상) */
function pCell(key, extraClass = "") {
  const v = pVal(key);
  const content = v ? styleLabels(escapeHTML(String(v))).replace(/\n/g, "<br>") : "";
  const hl = state.recentlyUpdated.has(key) ? " cell-updated" : "";
  return `<div class="tcell ${extraClass}${hl}" contenteditable="true" data-key="${escapeHTML(key)}" data-placeholder="—">${content}</div>`;
}

/* 활동 마커가 있는 줄 단위로 텍스트를 분할. 마커가 2개 미만이면 null 반환.
   인식 형식: [활동 N]  (활동 N)  활동 N:  활동 N.  활동 N -  활동 N\s
   반환: [{ header, 활동명, body }] — 활동명은 마커 라인의 나머지 텍스트, body는 마커 라인 제외 */
function splitByActivityHeader(text) {
  if (!text) return null;
  const lines    = String(text).split('\n');
  const markerRe = /(?:[\[\(]활동\s*([1-9])[\]\)]|활동\s*([1-9])\s*[:.\-\s])/;
  const actStarts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(markerRe);
    if (m) {
      const num = parseInt(m[1] || m[2]);
      if (!actStarts.some(a => a.num === num)) {
        // 마커 뒤 텍스트를 활동명으로 추출
        const afterMarker = lines[i].slice(m.index + m[0].length).trim();
        const 활동명 = afterMarker.replace(/^[\])\s]+/, '').trim();
        actStarts.push({ lineIdx: i, num, 활동명 });
      }
    }
  }
  actStarts.sort((a, b) => a.num - b.num);
  if (actStarts.length < 2) return null;
  const parts = [];
  for (let g = 0; g < actStarts.length; g++) {
    const start = actStarts[g].lineIdx;
    const end   = g + 1 < actStarts.length ? actStarts[g + 1].lineIdx : lines.length;
    // 헤더 라인(start) 제외, 이후 줄만 body
    parts.push({ header: `활동 ${actStarts[g].num}`, 활동명: actStarts[g].활동명, body: lines.slice(start + 1, end).join('\n').trim() });
  }
  return parts;
}

/* 부모 키(교사활동 등) → sub-key로 파싱. 이미 분할된 경우나 사용자가 직접 편집한 단계는 건너뜀 */
function syncSubKeysFromParent(stage) {
  if (stage !== "전개") return;   // 도입·정리는 항상 단일 활동 — 다중 분할 금지
  if (state.subEditedStages.has(stage)) return;
  // AI가 직접 sub-key를 설정했거나 이미 분할된 경우 재파싱 생략
  const existingN = parseInt(state.partialPlan[`${stage}_num_subs`]) || 0;
  if (existingN >= 2) return;

  const teacher  = state.partialPlan[`${stage}_교사활동`]    || "";
  const student  = state.partialPlan[`${stage}_학생활동`]    || "";
  const material = state.partialPlan[`${stage}_자료유의평가`] || "";
  const tSubs = splitByActivityHeader(teacher);
  const sSubs = splitByActivityHeader(student);
  const mSubs = splitByActivityHeader(material);
  const n = Math.max(tSubs?.length ?? 0, sSubs?.length ?? 0, mSubs?.length ?? 0);
  if (n >= 2) {
    state.partialPlan[`${stage}_num_subs`] = n;
    const totalMin = parseInt(state.partialPlan[`${stage}_시간`]) || 0;
    const base     = totalMin > 0 ? Math.floor(totalMin / n) : 0;
    for (let i = 1; i <= n; i++) {
      // 헤더에서 추출한 활동명 설정 (없으면 덮어쓰지 않음)
      if (tSubs?.[i-1]?.활동명) state.partialPlan[`${stage}_sub${i}_활동명`] = tSubs[i-1].활동명;
      state.partialPlan[`${stage}_sub${i}_교사활동`]    = tSubs?.[i-1]?.body ?? "";
      // 학생활동·자료에 마커가 없으면: 첫 번째 활동에 전체 내용, 나머지는 빈 칸
      state.partialPlan[`${stage}_sub${i}_학생활동`]    = sSubs
        ? (sSubs[i-1]?.body ?? "")
        : (i === 1 ? student : "");
      state.partialPlan[`${stage}_sub${i}_자료유의평가`] = mSubs
        ? (mSubs[i-1]?.body ?? "")
        : (i === 1 ? material : "");
      if (totalMin > 0) {
        state.partialPlan[`${stage}_sub${i}_시간`] =
          i === n ? String(totalMin - base * (n - 1)) : String(base);
      }
    }
  } else {
    state.partialPlan[`${stage}_num_subs`] = 1;
  }
}

/* sub-key → 부모 키 재구성 (HWPX 빌드 직전 및 sub-key 편집 시 호출) */
function syncParentFromSubKeys(stage) {
  const n = state.partialPlan[`${stage}_num_subs`] || 1;
  if (n < 2) return;
  const teachers = [], students = [], materials = [];
  for (let i = 1; i <= n; i++) {
    const actName = (state.partialPlan[`${stage}_sub${i}_활동명`] || "").trim();
    const headerLine = actName ? `(활동 ${i}) ${actName}` : `(활동 ${i})`;
    teachers .push(`${headerLine}\n${(state.partialPlan[`${stage}_sub${i}_교사활동`]    || "").trim()}`);
    students .push(`(활동 ${i})\n${(state.partialPlan[`${stage}_sub${i}_학생활동`]    || "").trim()}`);
    materials.push(`(활동 ${i})\n${(state.partialPlan[`${stage}_sub${i}_자료유의평가`] || "").trim()}`);
  }
  state.partialPlan[`${stage}_교사활동`]    = teachers .join("\n\n");
  state.partialPlan[`${stage}_학생활동`]    = students .join("\n\n");
  state.partialPlan[`${stage}_자료유의평가`] = materials.join("\n\n");
}

/* 교수·학습 활동 표의 한 단계(도입/전개/정리) 행(tr)들을 생성.
   열: [학습단계+학습형태] [교사] [학생] [시간] [자료유의평가] */
function activityRows(stage) {
  const s       = escapeHTML(stage);
  // 도입·정리는 항상 단일 활동. 다중 sub는 전개에만.
  const numSubs = stage === "전개" ? (state.partialPlan[`${stage}_num_subs`] || 1) : 1;

  // 단일 활동: 한 행
  if (numSubs < 2) {
    const splitBtn = stage === "전개"
      ? `<button class="plan-add-sub-btn t-mini" data-stage="${s}">+ 활동 나누기</button>` : "";
    return `<tr>
      <td class="t-stage">
        <div class="t-stage-name">${s}</div>
        <div class="t-step-label">단계</div>
        ${pCell(`${stage}_단계`, "t-step")}
        <div class="t-form-label">학습형태</div>
        ${pCell(`${stage}_학습형태`, "t-form")}
        ${splitBtn}
      </td>
      <td>${pCell(`${stage}_교사활동`)}</td>
      <td>${pCell(`${stage}_학생활동`)}</td>
      <td class="t-time">${pCell(`${stage}_시간`)}</td>
      <td>${pCell(`${stage}_자료유의평가`)}</td>
    </tr>`;
  }

  // 여러 활동: 활동마다 한 행. 학습형태는 각 행의 학습단계(라벨) 셀에 위치.
  let rows = "";
  for (let i = 1; i <= numSubs; i++) {
    rows += `<tr>
      <td class="t-stage">
        ${i === 1 ? `<div class="t-stage-name">${s}</div>` : ""}
        <div class="t-step-label">단계</div>
        ${pCell(`${stage}_sub${i}_단계`, "t-step")}
        <div class="t-form-label">학습형태</div>
        ${pCell(`${stage}_sub${i}_학습형태`, "t-form")}
        ${i === 1 && numSubs < 5 ? `<button class="plan-add-sub-btn t-mini" data-stage="${s}">+ 활동</button>` : ""}
      </td>
      <td class="t-teacher">
        <div class="t-act-head">
          <span class="t-act-line"><span class="t-act-no">활동 ${i}.</span>${pCell(`${stage}_sub${i}_활동명`, "t-inline t-actname")}</span>
          <button class="plan-del-sub-btn" data-stage="${s}" data-idx="${i}">✕</button>
        </div>
        ${pCell(`${stage}_sub${i}_교사활동`)}
      </td>
      <td>${pCell(`${stage}_sub${i}_학생활동`)}</td>
      <td class="t-time">${pCell(`${stage}_sub${i}_시간`)}</td>
      <td>${pCell(`${stage}_sub${i}_자료유의평가`)}</td>
    </tr>`;
  }
  return rows;
}

// 여러 update_plan 호출이 연달아 와도 microtask로 합쳐 renderPlanPreview를 1번만 실행.
let _renderScheduled = false;
function scheduleRender() {
  if (_renderScheduled) return;
  _renderScheduled = true;
  queueMicrotask(() => {
    _renderScheduled = false;
    renderPlanPreview();
  });
}

function renderPlanPreview() {
  // 사용자가 우측 패널을 편집 중이면 덮어쓰지 않음
  if (previewEl().contains(document.activeElement) &&
      document.activeElement.hasAttribute("contenteditable")) return;

  // 부모 키 → sub-key 동기화 (사용자 미편집 단계만)
  for (const stage of STAGES) syncSubKeysFromParent(stage);

  const subj = pVal("교과") || "　";
  // 평가 계획 — 선택한 범주 수만큼 행
  const evalN = parseInt(state.partialPlan.평가_num) || 0;
  const evalRow = (i) => `
        <tr>
          <td class="t-eval-cat">${pCell(`평가${i}_범주`, "t-inline")}<span class="t-paren">(${pCell(`평가${i}_방법`, "t-minline")})</span></td>
          <td>${pCell(`평가${i}_요소`)}</td>
          <td>${pCell(`평가${i}_수준상`)}</td>
          <td>${pCell(`평가${i}_수준중`)}</td>
          <td>${pCell(`평가${i}_수준하`)}</td>
          <td>${pCell(`평가${i}_피드백`)}</td>
        </tr>`;
  const evalRowsHtml = evalN > 0 ? Array.from({ length: evalN }, (_, k) => evalRow(k + 1)).join("") : evalRow(1);
  const evalRowspan = 2 + (evalN || 1);

  previewEl().innerHTML = `
    <div class="plan-doc">
      <h2 class="plan-doc-title">(${escapeHTML(subj)}과) 교수·학습 과정안</h2>

      <!-- 기본 정보 -->
      <table class="plan-tbl">
        <colgroup><col style="width:13%"><col style="width:22%"><col style="width:13%"><col style="width:18%"><col style="width:13%"><col style="width:21%"></colgroup>
        <tr>
          <th>단원</th><td>${pCell("단원")}</td>
          <th>대상 학급</th><td>${pCell("대상학급")}</td>
          <th>일시</th><td>${pCell("일시")}</td>
        </tr>
        <tr>
          <th>차시<br><span class="th-sub">(교과서 쪽수)</span></th>
          <td>${pCell("차시", "t-inline")}<span class="t-paren">(${pCell("교과서쪽수", "t-inline")})</span></td>
          <th>교수학습 모형</th>
          <td colspan="3">${pCell("교수학습모형")}</td>
        </tr>
      </table>

      <!-- 교육과정 분석 -->
      <table class="plan-tbl">
        <colgroup><col style="width:8%"><col style="width:18%"><col style="width:74%"></colgroup>
        <tr><th class="th-vert" rowspan="5">교육<br>과정<br>분석</th><th>교과 역량</th><td>${pCell("교과역량")}</td></tr>
        <tr><th>영역</th><td>${pCell("영역")}</td></tr>
        <tr><th>핵심 아이디어</th><td>${pCell("핵심아이디어")}</td></tr>
        <tr><th>성취기준 <button type="button" class="std-add-btn">+ 추가</button></th>
          <td>${pCell("성취기준")}<select class="std-add-sel" style="display:none"></select></td></tr>
        <tr><th>탐구 질문</th><td>${pCell("탐구질문")}</td></tr>
      </table>

      <!-- 학습 목표 / 주제 / 의도 -->
      <table class="plan-tbl">
        <colgroup><col style="width:26%"><col style="width:74%"></colgroup>
        <tr><th>학습 목표</th><td>${pCell("학습목표")}</td></tr>
        <tr><th>학습 주제</th><td>${pCell("학습주제")}</td></tr>
        <tr><th>수업자의 의도<br><span class="th-sub">(수업·평가 주안점)</span></th><td>${pCell("수업자의도")}</td></tr>
        <tr><th>수행 과제</th><td>${pCell("수행과제")}</td></tr>
      </table>

      <!-- 평가 계획 -->
      <table class="plan-tbl">
        <colgroup><col style="width:8%"><col style="width:18%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:18%"></colgroup>
        <tr>
          <th class="th-vert" rowspan="${evalRowspan}">평가<br>계획</th>
          <th rowspan="2">범주<br><span class="th-sub">(평가방법)</span></th>
          <th rowspan="2">평가요소</th>
          <th colspan="3">수준</th>
          <th rowspan="2">피드백</th>
        </tr>
        <tr><th>상</th><th>중</th><th>하</th></tr>
        ${evalRowsHtml}
      </table>

      <!-- 교수·학습 활동 -->
      <table class="plan-tbl plan-act-tbl">
        <colgroup><col style="width:11%"><col style="width:33%"><col style="width:30%"><col style="width:8%"><col style="width:18%"></colgroup>
        <tr>
          <th rowspan="2">학습 단계<br><span class="th-sub">학습형태</span></th>
          <th colspan="2">교수·학습 활동</th>
          <th rowspan="2">시간<br><span class="th-sub">(분)</span></th>
          <th rowspan="2" class="t-th-sym"><span class="sym-c">자</span>료<br><span class="sym-c">유</span>의점<br><span class="sym-c">평</span>가</th>
        </tr>
        <tr><th>교사</th><th>학생</th></tr>
        ${activityRows("도입")}
        ${activityRows("전개")}
        ${activityRows("정리")}
      </table>

    </div>`;

  // 강조 클래스는 위 innerHTML에 이미 박혔으므로(애니메이션 1회 재생) set은 비운다.
  // 갱신된 첫 셀을 미리보기 패널 중앙으로 직접 스크롤(scrollIntoView는 이 컨테이너를 못 잡음).
  if (state.recentlyUpdated.size) {
    const pp = previewEl();
    const first = pp.querySelector(".cell-updated");
    if (first) {
      const r = first.getBoundingClientRect();
      const top = pp.scrollTop + (r.top - pp.getBoundingClientRect().top) - pp.clientHeight / 2 + r.height / 2;
      pp.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    state.recentlyUpdated.clear();
  }
}

/* 우측 패널 편집 이벤트 — DOMContentLoaded 후 한 번만 등록 */
function initPreviewEvents() {
  const preview = previewEl();

  // 붙여넣기 시 서식 제거 (순수 텍스트만)
  preview.addEventListener("paste", (e) => {
    if (!e.target.closest("[data-key]")) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  // 입력할 때마다 state 동기화
  preview.addEventListener("input", (e) => {
    const el = e.target.closest("[data-key]");
    if (!el) return;
    const key  = el.dataset.key;
    const text = getEditableText(el);
    if (text) state.partialPlan[key] = text;
    else      delete state.partialPlan[key];
    // sub-key 편집 시 부모 키도 재구성
    const subMatch = key.match(/^(도입|전개|정리)_sub\d+_/);
    if (subMatch) {
      const stage = subMatch[1];
      state.subEditedStages.add(stage);
      syncParentFromSubKeys(stage);
    }
  });

  // Enter: 줄바꿈 삽입 (div 생성 방지)
  preview.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.closest("[data-key]")) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
    }
  });

  // 미리보기 성취기준 '+ 추가' → 교과·학년군 성취기준 드롭다운(기존 보존하며 append)
  preview.addEventListener("change", (e) => {
    const sel = e.target.closest(".std-add-sel");
    if (!sel || !sel.value) return;
    const cur = (state.partialPlan.성취기준 || "").trim();
    state.partialPlan.성취기준 = cur ? cur + "\n" + sel.value : sel.value;
    scheduleRender();   // 재렌더 — 기존 내용 보존 + 새 성취기준 추가
  });

  // 활동 추가 / 삭제 버튼
  preview.addEventListener("click", (e) => {
    const stdBtn = e.target.closest(".std-add-btn");
    if (stdBtn) {
      const sel = stdBtn.closest("tr").querySelector(".std-add-sel");
      const show = sel.style.display === "none";
      if (show && sel.options.length === 0) {
        const existing = state.partialPlan.성취기준 || "";
        const all = listAllStandards(state.partialPlan.교과, state.partialPlan.학년)
          .filter((s) => { const m = s.match(/\[[^\]]+\]/); return !m || !existing.includes(m[0]); });
        sel.add(new Option("— 교과·학년군 성취기준 선택 —", ""));
        for (const s of all) sel.add(new Option(s, s));
      }
      sel.style.display = show ? "block" : "none";
      if (show) sel.focus();
      return;
    }

    const addBtn = e.target.closest(".plan-add-sub-btn");
    if (addBtn) {
      const stage = addBtn.dataset.stage;
      const n = state.partialPlan[`${stage}_num_subs`] || 1;
      const newN = Math.min(5, n + 1);
      if (n === 1) {
        for (const f of SUB_FIELDS_MOVE) {
          state.partialPlan[subKey(stage, 1, f)] = state.partialPlan[`${stage}_${f}`] || "";
        }
      }
      for (const f of SUB_FIELDS_MOVE) {
        state.partialPlan[subKey(stage, newN, f)] = "";
      }
      state.partialPlan[`${stage}_num_subs`] = newN;
      state.subEditedStages.add(stage);
      syncParentFromSubKeys(stage);
      renderPlanPreview();
      return;
    }

    const delBtn = e.target.closest(".plan-del-sub-btn");
    if (delBtn) {
      const stage = delBtn.dataset.stage;
      const idx   = parseInt(delBtn.dataset.idx);
      const n     = state.partialPlan[`${stage}_num_subs`] || 1;
      if (n <= 1) return;
      for (let i = idx; i < n; i++) {
        for (const f of SUB_FIELDS_MOVE) {
          state.partialPlan[subKey(stage, i, f)] = state.partialPlan[subKey(stage, i + 1, f)] || "";
        }
      }
      for (const f of SUB_FIELDS_MOVE) {
        delete state.partialPlan[subKey(stage, n, f)];
      }
      const newN = n - 1;
      state.partialPlan[`${stage}_num_subs`] = newN;
      state.subEditedStages.add(stage);
      if (newN === 1) {
        // 단일 활동으로 복귀: sub1을 부모로 옮기고 sub 키 잔재 제거.
        // (오염된 기존 부모값으로 폴백하면 "(활동 1)\n\n(활동 2)" 같은 헤더 잔재가 남음)
        for (const f of SUB_FIELDS_MOVE) {
          state.partialPlan[`${stage}_${f}`] = state.partialPlan[subKey(stage, 1, f)] || "";
          delete state.partialPlan[subKey(stage, 1, f)];
        }
      } else {
        syncParentFromSubKeys(stage);
      }
      renderPlanPreview();
    }
  });
}

/* ====================== 범용 선택 카드 (present_choices) ====================== */

/**
 * 선택 카드 렌더 (단일/다중 선택 + 직접 입력 + 선택 안 함).
 * 선택 완료 시 onChoiceSubmit으로 present_choices 함수 응답을 구성한다.
 */
function showChoiceCard(c) {
  const id    = ++state.tangooSeq;
  const gName = `ch_${id}`;
  const type  = c.multi ? "checkbox" : "radio";
  const intro = c.intro || `${c.field} 중에서 골라 주세요.`;

  // 옵션 텍스트의 줄바꿈(\n 리터럴·실제·\r) 정리 — LLM이 옵션에 줄바꿈을 넣어 카드에 "\n"이 글자로 보이는 문제 방지
  c.options = (c.options || []).map((o) => String(o).replace(/\\n|\\r|[\n\r]/g, " ").replace(/\s{2,}/g, " ").trim());

  const optHtml = c.options.map((o, i) => `
    <label class="tangoo-option">
      <input type="${type}" name="${gName}" value="${i}">
      <span>${escapeHTML(o)}</span>
    </label>`).join("");
  const noneHtml = c.none ? `
    <label class="tangoo-option tangoo-custom-label">
      <input type="${type}" name="${gName}" value="none">
      <span>— 선택 안 함</span>
    </label>` : "";
  const customHtml = c.custom ? `
    <label class="tangoo-option tangoo-custom-label">
      <input type="${type}" name="${gName}" value="custom">
      <span>✏ 직접 입력${c.multi ? " (추가)" : ""}</span>
    </label>` : "";

  const regenHtml = c.regenerate
    ? `<button class="choice-btn tangoo-regen">🔄 다른 후보 추천받기</button>` : "";

  // 성취기준 카드: 교과·학년군 전체 성취기준을 드롭다운으로 검색해 추가
  const isStandard = /성취\s*기준/.test(c.field);
  const searchHtml = isStandard
    ? `<div class="tangoo-search">
         <button type="button" class="choice-btn tangoo-search-btn">🔍 검색하여 추가</button>
         <select class="tangoo-std-select" style="display:none"></select>
       </div>` : "";

  const card = document.createElement("div");
  card.className = "msg-bot msg-bubble tangoo-card";
  card.innerHTML = `
    <div class="markdown tangoo-intro">${renderMarkdown(intro)}</div>
    <div class="tangoo-options">${optHtml}${noneHtml}${customHtml}</div>
    ${searchHtml}
    <textarea class="tangoo-textarea" id="ch-ta-${id}"
      placeholder="${escapeHTML(c.field)} 직접 입력…" rows="2"></textarea>
    <div class="tangoo-actions">
      <button class="tangoo-submit" disabled>이대로 선택</button>
      ${regenHtml}
    </div>`;

  const wrap = document.createElement("div");
  wrap.className = "flex justify-start";
  wrap.appendChild(card);
  chatEl().appendChild(wrap);
  scrollBottom();

  const submitBtn = card.querySelector(".tangoo-submit");
  const regenBtn  = card.querySelector(".tangoo-regen");
  const textarea  = card.querySelector(`#ch-ta-${id}`);
  const optionsBox = card.querySelector(".tangoo-options");
  const inputs    = [...card.querySelectorAll(`input[name="${gName}"]`)];

  const refresh = () => {
    submitBtn.disabled = !inputs.some((x) => x.checked);
    inputs.forEach((x) => x.closest(".tangoo-option").classList.toggle("selected", x.checked));
    const customOn = inputs.some((x) => x.value === "custom" && x.checked);
    textarea.style.display = customOn ? "block" : "none";
    if (customOn) textarea.focus();
  };
  inputs.forEach((x) => x.addEventListener("change", refresh));

  // 검색하여 추가로 들어온 성취기준을 카드 옵션(체크된 상태)으로 동적 추가
  const customLabel = optionsBox.querySelector(".tangoo-custom-label");
  function addPickedOption(text) {
    const idx = c.options.length;
    c.options.push(text);
    const label = document.createElement("label");
    label.className = "tangoo-option";
    const inp = document.createElement("input");
    inp.type = type; inp.name = gName; inp.value = String(idx); inp.checked = true;
    const span = document.createElement("span"); span.textContent = text;
    label.append(inp, span);
    optionsBox.insertBefore(label, customLabel || null);
    inp.addEventListener("change", refresh);
    inputs.push(inp);
    refresh();
  }

  if (isStandard) {
    const searchBtn = card.querySelector(".tangoo-search-btn");
    const sel = card.querySelector(".tangoo-std-select");
    const existing = new Set(c.options);
    const all = listAllStandards(state.partialPlan.교과, state.partialPlan.학년).filter((s) => !existing.has(s));
    const setEmpty = () => { searchBtn.disabled = true; searchBtn.textContent = "🔍 추가할 성취기준 없음"; sel.style.display = "none"; };
    if (!all.length) setEmpty();
    sel.add(new Option("— 교과·학년군 성취기준 선택 —", ""));
    for (const s of all) sel.add(new Option(s, s));   // DOM API — XSS 안전, value 원문 보존
    searchBtn.addEventListener("click", () => {
      const show = sel.style.display === "none";
      sel.style.display = show ? "block" : "none";
      if (show) sel.focus();
    });
    sel.addEventListener("change", () => {
      const v = sel.value; if (!v) return;
      addPickedOption(v);
      const opt = [...sel.options].find((o) => o.value === v);
      if (opt) opt.remove();
      sel.value = "";
      if (sel.options.length <= 1) setEmpty();
    });
  }

  submitBtn.addEventListener("click", () => {
    const checked = inputs.filter((x) => x.checked);
    if (!checked.length) return;
    const picks = [];
    let pickedNone = false, customText = "";
    for (const x of checked) {
      if (x.value === "custom") {
        const t = textarea.value.trim();
        if (!t) { textarea.focus(); return; }
        customText = t;
      } else if (x.value === "none") {
        pickedNone = true;
      } else {
        picks.push(c.options[parseInt(x.value)]);
      }
    }
    inputs.forEach((x) => x.disabled = true);
    textarea.disabled = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "✓ 선택 완료";
    submitBtn.classList.add("done");
    if (regenBtn) regenBtn.disabled = true;

    onChoiceSubmit(c.field, picks, pickedNone, customText);
  });

  // 다른 후보 추천받기 — 같은 항목으로 새 후보를 다시 요청 (run 단위 3회 상한)
  if (regenBtn) {
    const REGEN_MAX = 3;
    const fldNorm = normField(c.field);
    const used = (state.regenCount[fldNorm] || 0);
    if (used > 0) {
      regenBtn.textContent = `🔄 다른 후보 추천받기 (${used}/${REGEN_MAX})`;
    }
    if (used >= REGEN_MAX) {
      regenBtn.disabled = true;
      regenBtn.title = "비용 절약을 위해 이번 항목은 직접 입력해 주세요.";
      regenBtn.textContent = `🔄 추천 한도 도달 (${REGEN_MAX}/${REGEN_MAX})`;
    } else {
      regenBtn.addEventListener("click", () => {
        if (!state.pendingCall) return;
        state.regenCount[fldNorm] = (state.regenCount[fldNorm] || 0) + 1;
        inputs.forEach((x) => x.disabled = true);
        textarea.disabled = true;
        submitBtn.disabled = true;
        regenBtn.disabled = true;
        regenBtn.textContent = `🔄 다시 추천 중… (${state.regenCount[fldNorm]}/${REGEN_MAX})`;
        state.confirmedChoices.delete(fldNorm);   // 사용자가 이 항목의 다른 후보를 요청 → 그 항목만 가드 해제
        addUser(`다른 ${c.field} 후보를 추천해 주세요`);
        state._lastUserRegen = true;   // B3-1: 직후 LLM의 present_choices 재호출은 카운트 제외
        answerPendingCall({ field: c.field, regenerate: true });
      });
    }
  }
}

// sub_교사/학생/자료 본문 첫 줄이 "◉? [활동 N] 활동명" 같은 헤더면 제거.
// 미리보기 카드 헤더에 이미 "활동 N"이 표시되므로 본문 헤더는 중복.
function sanitizeSubActivityHeaders(patch) {
  const headerRe = /^\s*[◉◯●○]?\s*[\[\(]?\s*활동\s*[1-9][\]\)]?\s*[:.\-]?\s*.*$/;
  for (const key of Object.keys(patch)) {
    if (!/_sub\d+_(교사활동|학생활동|자료유의평가)$/.test(key)) continue;
    const v = patch[key];
    if (typeof v !== "string" || !v) continue;
    const lines = v.split("\n");
    if (lines.length > 1 && headerRe.test(lines[0])) {
      patch[key] = lines.slice(1).join("\n").trim();
    }
  }
}

/* ====================== 데이터 ====================== */

async function loadDatasets() {
  const [core, considerations, achievements, coreExt, subjectCompetencies, lessonUnits, lessonModels, standardGuidance] = await Promise.all([
    fetch("./data/core_ideas.json").then((r) => r.json()),
    fetch("./data/considerations.json").then((r) => r.json()),
    fetch("./data/achievement.json").then((r) => r.json()),
    fetch("./data/core_ideas_extended.json", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
    fetch("./data/subject_competencies.json").then((r) => r.json()).catch(() => ({})),
    fetch("./data/lesson_units.json", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
    fetch("./data/lesson_models.json").then((r) => r.json()).catch(() => ({})),
    fetch("./data/standard_guidance.json", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
  ]);
  state.datasets = { core, considerations, achievements, coreExt, subjectCompetencies, lessonUnits, lessonModels, standardGuidance };
}

function normalizeArea(s) { return String(s || "").replace(/[·⋅]/g, "·").trim(); }
function gradeToBand(g) {
  if (g <= 2) return "1~2학년";
  if (g <= 4) return "3~4학년";
  return "5~6학년";
}

// 통합 lesson_units에서 단원 정밀 매칭(출판사 일치 우선) → 성취기준·영역·단원학습내용 보유
function findLessonUnit(subject, grade, semester, unitMention, publisher) {
  const lu = state.datasets.lessonUnits || [];
  let cands = lu.filter((u) =>
    u.과목 === subject && u.학년 === grade &&
    (u.학기 == null || semester === 0 || u.학기 === semester));
  if (publisher) {
    const p = cands.filter((u) => u.출판사 === publisher);
    if (p.length) cands = p;   // 출판사 일치분 우선(없으면 전체 후보 유지)
  }
  if (!unitMention || !cands.length) return null;
  const norm = (s) => String(s || "").replace(/\s/g, "");
  const m = norm(unitMention);
  // 단원명 부분 매칭(양방향: "자연수의 혼합 계산" ↔ "1. 자연수의 혼합 계산")
  for (const u of cands) {
    const un = norm(u.단원명);
    if (un && (m.includes(un) || un.includes(m))) return u;
  }
  // 단원 번호 매칭("3단원"·"3." 등)
  const nm = String(unitMention).match(/(\d+)\s*단원|^\s*(\d+)[.\s]/);
  const num = nm && (nm[1] || nm[2]);
  if (num) {
    const found = cands.find((u) => new RegExp(`^\\s*${num}[.\\s-]`).test(u.단원명));
    if (found) return found;
  }
  return null;
}

function findCoreIdeas(subject, areaText) {
  const areas = String(areaText || "").split(",").map(normalizeArea);
  const out = [];
  const seen = new Set();
  for (const c of state.datasets.core || []) {
    if (c.교과 === subject && areas.includes(normalizeArea(c.영역))) {
      const idea = c["핵심 아이디어"];
      if (idea && !seen.has(idea)) { out.push(idea); seen.add(idea); }
    }
  }
  for (const c of state.datasets.coreExt || []) {
    if (c.교과 === subject && areas.includes(normalizeArea(c.영역))) {
      // 교육과정 원문 핵심 아이디어만 선택지에 제시한다. '초등재진술'은 교육과정 원문이 아니라 초등 수준 보조 풀이라
      // 선택지에 섞으면 "교육과정에 없는 핵심 아이디어"가 끼어 보인다(교사가 풀어쓰려면 카드의 '직접 입력'으로).
      const idea = c["핵심 아이디어"];
      if (idea && !seen.has(idea)) { out.push(idea); seen.add(idea); }
    }
  }
  return out;
}

function findConsiderations(subject, areaText, band) {
  const areas = String(areaText || "").split(",").map(normalizeArea);
  return state.datasets.considerations
    .filter((c) => c.교과 === subject && areas.includes(normalizeArea(c.영역)) && (!band || c.학년군 === band))
    .map((c) => c["성취기준 적용 시 고려사항"]);
}


/* ====================== LLM 호출 ====================== */

/* 현재 미리보기 상태를 system 메시지로 주입한 메시지 배열을 만든다.
   오래된 RAG 조회 결과는 압축해 보낸다(토큰 절감) — 선택된 값은 plan·선택 메시지에 이미
   반영돼 원본 목록이 더 필요 없다. present_choices 결과는 영속적 이해처럼 plan에 없는
   확정값의 유일한 기록이므로 압축하지 않는다. */
const RAG_TOOL_NAMES = new Set(["find_standards", "list_competencies", "list_core_ideas", "list_considerations", "list_lesson_models"]);
const RAG_KEEP_RECENT = 2;   // 최근 N개의 RAG 결과는 원본 유지(현재 단계가 참조 중일 수 있음)
function buildAPIMessages() {
  const msgs = [...state.messages];
  const ragIdxs = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "tool" && RAG_TOOL_NAMES.has(msgs[i].name)) ragIdxs.push(i);
  }
  for (const i of ragIdxs.slice(0, -RAG_KEEP_RECENT)) {
    msgs[i] = { ...msgs[i], content: JSON.stringify({ note: "이전 단계의 조회 결과(생략됨) — 선택된 값은 이미 과정안에 반영되어 있음" }) };
  }
  const filled = Object.fromEntries(
    Object.entries(state.partialPlan).filter(
      ([k, v]) => v !== "" && v !== null && v !== undefined && !/_num_subs$/.test(k)
    )
  );
  if (Object.keys(filled).length > 0) {
    msgs.push({
      role: "system",
      content:
        "[현재 미리보기 상태 — 사용자가 직접 수정했을 수 있습니다. 이 값이 최신입니다. 이미 채워진 필드는 다시 묻지 마세요.]\n" +
        JSON.stringify(filled),
    });
  }
  return msgs;
}

/* ── LLM 호출 오류 처리: 일시 오류는 재시도, 영구 오류는 코드별 안내 ── */
const LLM_RETRY_DELAYS = [800, 1600, 3200];   // 일시 오류 최대 3회 재시도(지수 백오프, ms)
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 502/503 응답이 안전 필터 차단인지(재시도해도 동일 → 영구 취급) 판별
function isBlockedBody(body) {
  return /응답\s*없음|SAFETY|RECITATION|PROHIBITED|blockReason/i.test(body || "");
}
// status(0=네트워크 실패)·응답 본문 → 구조적 LLM 오류. err.kind로 catch에서 분기.
function classifyLLM(status, body) {
  const e = new Error("LLM 호출 실패 (" + status + ")");
  e.llm = true; e.status = status;
  if (status === 0)            { e.kind = "network";    e.code = "NET"; }
  else if (status === 429)     { e.kind = "ratelimit";  e.code = 429; }
  else if (status === 502 || status === 503) { e.kind = isBlockedBody(body) ? "blocked" : "overload"; e.code = status; }
  else if (status >= 500)      { e.kind = "server";     e.code = status; }
  else if (status === 400 || status === 401 || status === 403 || status === 413) { e.kind = "badrequest"; e.code = status; }
  else                         { e.kind = "unknown";    e.code = status; }
  return e;
}
// 사용자에게 보일 한국어 안내(끝에 식별 코드 [NNN] 부착)
function llmErrorMessage(err) {
  const code = err && err.code != null ? ` [${err.code}]` : "";
  switch (err && err.kind) {
    case "network":   return `인터넷 연결이 불안정한 것 같아요. 연결을 확인하고 다시 시도해 주세요.${code}`;
    case "ratelimit": return `짧은 사이에 요청이 많았어요. ${err.retryAfter ? err.retryAfter + "초 후" : "잠시 후"} 다시 시도해 주세요.${code}`;
    case "overload":  return `지금 AI 서버가 붐비고 있어요. 잠시 후 다시 시도해 주세요.${code}`;
    case "blocked":   return `입력 내용이 안전 필터에 걸렸어요. 표현을 바꿔 다시 시도해 주세요.${code}`;
    case "server":    return `서버에서 처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.${code}`;
    case "badrequest":return `요청을 처리하지 못했어요. 새로 시작하거나 관리자에게 문의해 주세요.${code}`;
    default:          return `알 수 없는 오류가 발생했어요. 잠시 후 다시 시도해 주세요.${code}`;
  }
}

/* === 비용 최적화: 현재 진행 단계 추정 (1~11) ===
   서버 라우팅(PRIMARY/CHEAP)의 SSoT. partialPlan 채워진 정도로 단계 판정. */
function detectStage(p) {
  p = p || {};
  if (!p.교과 || !p.학년 || !p.단원) return 1;
  if (!p.성취기준) return 2;
  if (!p.핵심아이디어) return 3;
  if (!p.교과역량) return 4;
  if (!p.탐구질문) return 5;
  // 6: 평가 — 어느 한 평가{i} 필드라도 미완이면 6 (sticky)
  const evalNum = parseInt(p.평가_num) || 0;
  if (evalNum === 0) return 6;
  for (let i = 1; i <= evalNum; i++) {
    if (!p[`평가${i}_요소`] || !p[`평가${i}_방법`] ||
        !p[`평가${i}_수준상`] || !p[`평가${i}_수준중`] || !p[`평가${i}_수준하`] ||
        !p[`평가${i}_피드백`]) return 6;
  }
  if (!p.학습목표 || !p.학습주제) return 7;
  if (!p.교수학습모형) return 8;
  if (!p["전개_활동명"] && !p["전개_sub1_활동명"]) return 9;
  const needs10 = !p["도입_교사활동"] || !p["정리_교사활동"];
  const subs = parseInt(p.전개_num_subs) || 1;
  if (needs10) return 10;
  if (subs >= 2) {
    for (let i = 1; i <= subs; i++) if (!p[`전개_sub${i}_교사활동`]) return 10;
  } else if (!p["전개_교사활동"]) return 10;
  if (!p.수업자의도) return 11;
  return 11;
}

/* 모델별 토큰 분해 누적 — 서버 응답의 modelUsed로 어느 모델이 실제 사용됐는지 정확히 기록.
   응답에 modelUsed가 없으면(구버전 서버) FORCE_MODEL을 폴백으로 사용. 키는 vendor/model 정규형. */
function normalizeModelId(m) {
  if (!m) return "google/" + FORCE_MODEL;
  return String(m).includes("/") ? String(m) : "google/" + String(m);
}
function accumUsageByModel(modelUsed, prompt, output) {
  const key = normalizeModelId(modelUsed);
  const x = (state.usageByModel[key] = state.usageByModel[key] || { prompt: 0, output: 0, calls: 0 });
  x.prompt += Number(prompt) || 0;
  x.output += Number(output) || 0;
  x.calls += 1;
}

/* function calling 지원 호출 — { content, functionCalls } 반환. onRetry(n,total,status)로 재시도 진행 통지 */
async function callLLM(messages, maxTokens = 16000, onRetry = null) {
  const stage = detectStage(state.partialPlan);
  // 매 턴 stage에 맞는 system으로 교체 (CORE + STAGE_GUIDE ±1)
  if (Array.isArray(messages) && messages[0] && messages[0].role === "system") {
    messages = [{ role: "system", content: buildSystemPrompt(stage) }, ...messages.slice(1)];
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, tools: TOOLS, maxTokens, model: FORCE_MODEL, variant: VARIANT, stage, runId: state.runId }),
      });
    } catch (netErr) {
      // 네트워크 실패(서버 도달 못 함) — 일시 오류로 보고 재시도
      if (attempt < LLM_RETRY_DELAYS.length) {
        if (onRetry) onRetry(attempt + 1, LLM_RETRY_DELAYS.length, 0);
        await sleep(LLM_RETRY_DELAYS[attempt]);
        continue;
      }
      throw classifyLLM(0, "");
    }
    if (res.ok) {
      const data = await res.json();
      const u = data.usage;   // 세션 누적(이 과정안 생성에 든 토큰) — 저장 시 서버가 모델별 단가 환산
      if (u) {
        const p = u.promptTokenCount || 0;
        const o = u.candidatesTokenCount || 0;
        state.usage.calls += 1;
        state.usage.prompt += p;
        state.usage.output += o;
        state.usage.cached += u.cachedContentTokenCount || 0;
        accumUsageByModel(data.modelUsed, p, o);
      }
      return { content: data.content || "", functionCalls: data.functionCalls || [] };
    }
    // 오류 응답: 408/429/5xx는 일시 오류로 재시도(안전 필터 차단 502/503은 제외)
    const body = await res.text();
    const status = res.status;
    const transient = (status === 408 || status === 429 || status >= 500) && !isBlockedBody(body);
    if (transient && attempt < LLM_RETRY_DELAYS.length) {
      let delay = LLM_RETRY_DELAYS[attempt];
      if (status === 429) {
        const ra = parseInt(res.headers.get("Retry-After"), 10);
        if (ra > 0) delay = Math.min(ra * 1000, 10000);   // 서버 지정 대기 존중(최대 10초)
      }
      if (onRetry) onRetry(attempt + 1, LLM_RETRY_DELAYS.length, status);
      await sleep(delay);
      continue;
    }
    const err = classifyLLM(status, body);
    if (status === 429) {
      const ra = parseInt(res.headers.get("Retry-After"), 10);
      if (ra > 0) err.retryAfter = ra;
    }
    throw err;
  }
}

/* [USE_INTER] Interactions API 호출 — 클라는 previous_interaction_id + 현재 input만 보낸다(히스토리는 서버 보관).
   input: 첫 턴=user 문자열, 이후=function_result 배열. 응답 functionCalls는 callId(서버 step id)를 포함. */
async function callLLMInter(input, onRetry = null) {
  const stage = detectStage(state.partialPlan);
  const systemPrompt = buildSystemPrompt(stage);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(INTER_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previousInteractionId: state.interactionId, input, system: systemPrompt, tools: TOOLS, maxTokens: 16000, model: FORCE_MODEL, variant: VARIANT, stage, runId: state.runId }),
      });
    } catch (netErr) {
      if (attempt < LLM_RETRY_DELAYS.length) { if (onRetry) onRetry(attempt + 1, LLM_RETRY_DELAYS.length, 0); await sleep(LLM_RETRY_DELAYS[attempt]); continue; }
      throw classifyLLM(0, "");
    }
    if (res.ok) {
      const data = await res.json();
      const u = data.usage;   // Interactions usage: total_input/output/cached/thought_tokens
      if (u) {
        state.usage.calls += 1;
        state.usage.prompt += u.total_input_tokens || 0;
        state.usage.output += (u.total_output_tokens || 0) + (u.total_thought_tokens || 0);   // thinking은 출력 과금
        state.usage.cached += u.total_cached_tokens || 0;
      }
      if (data.interactionId) state.interactionId = data.interactionId;
      return { content: data.content || "", functionCalls: data.functionCalls || [] };
    }
    const body = await res.text();
    const status = res.status;
    const transient = (status === 408 || status === 429 || status >= 500) && !isBlockedBody(body);
    if (transient && attempt < LLM_RETRY_DELAYS.length) {
      let delay = LLM_RETRY_DELAYS[attempt];
      if (status === 429) { const ra = parseInt(res.headers.get("Retry-After"), 10); if (ra > 0) delay = Math.min(ra * 1000, 10000); }
      if (onRetry) onRetry(attempt + 1, LLM_RETRY_DELAYS.length, status);
      await sleep(delay);
      continue;
    }
    const err = classifyLLM(status, body);
    if (status === 429) { const ra = parseInt(res.headers.get("Retry-After"), 10); if (ra > 0) err.retryAfter = ra; }
    throw err;
  }
}

/* ====================== 메시지 흐름 (LLM 주도 + function calling) ====================== */

const MAX_TOOL_LOOPS = 12;   // 한 사용자 발화당 function call 연쇄 상한
const PROGRESS_FIELDS = ["교과", "성취기준", "핵심아이디어", "탐구질문", "학습목표", "평가요소", "교수학습모형", "전개_활동명", "수업자의도"];

function updateProgress() {
  if (state.plan) return renderProgress(1);
  const p = state.partialPlan;
  // PROGRESS_FIELDS 중 키에 "_"가 든 건 전개_활동명 하나 — 다중 활동이면 sub1로 폴백
  const filled = (k) => p[k] || (k === "전개_활동명" && p["전개_sub1_활동명"]);
  const done = PROGRESS_FIELDS.filter(filled).length;
  renderProgress(Math.min(0.97, done / PROGRESS_FIELDS.length));
}

/* ── 세션 영속화 (localStorage) — 새로고침·창 닫기 후 복원 ── */
const SAVE_KEY = "lessonplan_session_v35";   // /35 전용 키 — 같은 도메인의 메인(/) 세션과 분리
function saveState() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      partialPlan: state.partialPlan,
      messages: state.messages,
      plan: state.plan,
      pendingCall: state.pendingCall,
      callSeq: state.callSeq,
      subEditedStages: [...state.subEditedStages],
      usage: state.usage,
      usageByModel: state.usageByModel,
      interactionId: state.interactionId,   // [USE_INTER] 서버 대화 참조 ID
      runId: state.runId,
    }));
  } catch (e) { /* 용량 초과 등은 무시 */ }
}
function clearSavedState() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }
function loadSavedState() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
    if (!s) return false;
    // USE_INTER는 interactionId가 있는 세션만 복원(기존 generateContent 세션은 이어가기 불가 → 새로 시작 유도)
    const valid = USE_INTER
      ? !!s.interactionId
      : (Array.isArray(s.messages) && s.messages.some((m) => m.role !== "system"));
    if (!valid) return false;
    state.partialPlan = s.partialPlan || {};
    state.messages = Array.isArray(s.messages) ? s.messages : [{ role: "system", content: SYSTEM_PROMPT }];
    state.interactionId = s.interactionId || null;
    state.plan = s.plan || null;
    state.pendingCall = s.pendingCall || null;
    state.callSeq = s.callSeq || 0;
    state.subEditedStages = new Set(s.subEditedStages || []);
    state.usage = s.usage || { calls: 0, prompt: 0, output: 0, cached: 0 };
    state.usageByModel = s.usageByModel || {};
    if (s.runId) state.runId = s.runId;
    // 이미 채워진 CHOICE 항목은 확정된 것으로 보고 가드를 복원(새로고침 후 되돌아가기 반복 방지)
    state.confirmedChoices = new Set([...CHOICE_PLAN_KEYS].filter((k) => state.partialPlan[k] != null && String(state.partialPlan[k]).trim() !== ""));
    return true;
  } catch (e) { return false; }
}

// 저장된 세션을 화면에 복원하고 대화를 재개
async function restoreSession() {
  chatEl().innerHTML = "";
  renderPlanPreview();
  for (const m of state.messages) {
    if (m.role === "user") addUser(m.content);
    else if (m.role === "assistant" && m.content) addBot(m.content);
  }
  updateProgress();
  setComposerEnabled(true);
  addBot("📂 이전에 작성하던 내용을 불러왔어요. 이어서 진행합니다.");
  // 선택 카드를 띄운 채 종료됐다면 카드를 다시 렌더
  if (!state.plan && state.pendingCall && state.pendingCall.cardArgs) showChoiceCard(state.pendingCall.cardArgs);
}

// 입력창 전송 — 사용자 발화를 히스토리에 넣고 대화 루프 실행
// hiddenContext: 화면 user 버블엔 안 보이지만 모델 맥락엔 덧붙일 텍스트(클라가 미리 조회한 RAG 결과 등)
async function handleUserInput(text, hiddenContext) {
  if (!text.trim() || state.loading) return;
  state.confirmedChoices.clear();   // 사용자가 새로 말하면 가드 전체 해제(특정 항목을 바꾸려는 의도일 수 있음)
  if (state.pendingCall) {
    // 선택 카드가 떠 있는데 사용자가 입력창으로 답하면, 그 발화를 카드 응답으로 흡수
    // (무엇에 대한 답인지 field 맥락을 함께 넘겨 LLM이 카드를 반복하지 않게 한다)
    addUser(text);
    answerPendingCall({ user_message: text, field: state.pendingCall.cardArgs && state.pendingCall.cardArgs.field });
    return;
  }
  addUser(text);
  // 외부 검토자(🔎)가 방금 의견을 줬다면, 그 의견을 이 발화와 함께 메인 대화 맥락에 1회 주입한다.
  // (검토는 독립 LLM이라 메인 LLM이 의견 내용을 모름. 화면엔 사용자 원문만 보이고, 맥락엔 의견+요청이 함께 간다.)
  let toSend = text;
  if (state.reviewNote) {
    toSend = `[방금 외부 검토자가 준 검토 의견]\n${state.reviewNote}\n\n[이 검토 의견을 읽은 교사의 말]\n${text}`;
    state.reviewNote = null;   // 1회만 — 이후엔 서버 맥락/히스토리에 이미 포함됨
  }
  if (hiddenContext) toSend += hiddenContext;   // 화면엔 안 보이지만 모델 맥락엔 포함(클라가 미리 조회한 RAG 결과)
  if (USE_INTER) state.interInput = toSend;
  else state.messages.push({ role: "user", content: toSend });
  await runConversation();
}

/* ── 대화 루프: LLM 호출 → functionCall 실행 → 재호출, present_choices면 중단 ── */
async function runConversation() {
  if (USE_INTER) return runConversationInter();   // Interactions 방식은 별도 루프(기존 경로 무손상)
  if (state.loading) return;
  state.loading = true;
  setComposerEnabled(false);
  let loader = addLoader();
  let exhausted = true;     // break/return 없이 루프를 다 돌면 true (무한 함수호출 방어)
  let choiceRetried = false;  // "골라 주세요"라 해놓고 카드를 안 띄운 경우 1회만 재요청
  let updateRetried = false;  // "반영/수정했다"고 해놓고 update_plan을 빠뜨린 경우 1회만 재요청
  let updatedThisTurn = false; // 이 턴에서 update_plan이 실제로 한 번이라도 호출됐는지
  let emptyChoiceRetried = false; // present_choices를 빈 options로 호출(후보 누락)한 경우 1회만 재요청
  let fewChoiceRetried = false;   // 생성 후보(allow_regenerate)가 3개 미만이면 1회만 더 요청
  let guardHits = 0;          // 이미 확정된 항목 카드를 반복 차단한 횟수 — 임계 초과 시 무한루프로 보고 안전 착지
  try {
    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const { content, functionCalls } = await callLLM(buildAPIMessages(), 16000, (n, total, status) => {
        if (!loader) return;
        const msg = status === 0   ? `연결이 불안정해 다시 시도하고 있어요… (${n}/${total})`
                  : status === 429 ? `요청이 많아 잠시 후 다시 시도하고 있어요… (${n}/${total})`
                  :                  `AI 서버가 붐벼 다시 시도하고 있어요… (${n}/${total})`;
        setLoaderText(loader, msg);
      });

      if (!functionCalls.length) {
        // 순수 텍스트 응답 — 턴 종료(또는 재요청). 재요청을 유발한 '잘못된' 텍스트는 화면에 표시하지 않고
        // 스피너만 유지한다(올바른 결과만 보이게). 히스토리(state.messages)에는 남겨 모델 맥락 유지.
        state.messages.push({ role: "assistant", content: content || "" });
        // 누출 처리: 모델이 present_choices를 함수 호출이 아니라 텍스트로 적은 경우 — 파싱해 즉시 카드를 띄운다.
        // (오탐 가드: field가 있고 옵션이 3개 이상일 때만 렌더; 그 외엔 폴백.)
        const leak = parseLeakedPresentChoices(content || "");
        if (leak && leak.field && Array.isArray(leak.options) && leak.options.length >= 3) {
          if (loader) { removeLoader(loader); loader = null; }
          state.messages.push({
            role: "user",
            content: "이전 응답에서 present_choices를 텍스트로 적었습니다. 앞으로는 반드시 실제 함수 호출로만 표현하세요. 이번엔 클라이언트가 텍스트에서 후보를 파싱해 카드를 띄웠습니다.",
          });
          const _leakId = `call_${state.callSeq++}`;
          const cardArgs = {
            field: leak.field,
            intro: leak.intro || "",
            options: leak.options,
            multi: !!leak.multi,
            custom: leak.allow_custom !== false,
            none: !!leak.allow_none,
            regenerate: !!leak.allow_regenerate,
          };
          state.pendingCall = { tool_call_id: _leakId, name: "present_choices", cardArgs };
          showChoiceCard(cardArgs);
          state.loading = false; setComposerEnabled(true); updateProgress(); saveState();
          return;
        }
        // "골라/선택해/제안" 안내 또는 본문에 후보 불릿이 ≥2개 있으면서 present_choices를 빠뜨렸으면 1회 자동 재요청
        {
          const _txt = content || "";
          const _bulletCount = (_txt.match(/^[ \t]*(?:[-*•]|[①-⑩]|\d+[.)])\s+\S/gm) || []).length;
          const _hasChoicePhrase = /(골라|고르|선택|제안|추천|후보|마음에\s*드는|다음\s*중|세\s*가지|3\s*가지|두\s*가지|2\s*가지)/.test(_txt);
          if (!choiceRetried && ((_hasChoicePhrase && _bulletCount >= 2) || /(골라|선택해|선택하여|고르)\s*주세요|고르세요|추천해\s*드립니다|선택해\s*주십시오/.test(_txt))) {
            choiceRetried = true;
            state.messages.push({ role: "user", content: "방금 안내한 항목의 선택지를 지금 present_choices 카드로 띄워 주세요(채팅에 번호·불릿으로 나열하지 말고). 도구는 채팅 본문에 텍스트로 적지 말고 반드시 실제 함수 호출로 보내세요." });
            if (!loader) loader = addLoader();
            continue;
          }
        }
        // "반영/수정/채웠다"고 말해놓고 이 턴에 update_plan을 한 번도 안 불렀으면 1회 재요청.
        // (값을 정/수정했다 선언했는데 미리보기 미반영 → 사용자가 본 ~5% 누락. 빈칸·옛 값 stale 모두 해당)
        if (!updateRetried && !updatedThisTurn &&
            /(반영|수정|변경|업데이트|보완|기입|입력|작성|추가)(했|하였|해\s*드렸|해\s*두었|해\s*놨)|채웠|고쳤|바꿨|넣었|적었/.test(content || "") &&
            !/이미\s*(반영|수정|입력|작성)|되어\s*있|반영(돼|되어)\s*있/.test(content || "")) {
          updateRetried = true;
          state.messages.push({ role: "user", content: "방금 미리보기에 반영/수정했다고 하셨는데 update_plan 함수 호출이 없었습니다. 바뀐 필드만 지금 update_plan으로 보내 주세요(채팅에 본문을 다시 나열하지 말고)." });
          if (!loader) loader = addLoader();
          continue;
        }
        // 재요청 없이 정상 종료 — 이제 텍스트 표시
        if (content && content.trim()) { removeLoader(loader); loader = null; addBot(content.trim()); }
        exhausted = false;
        break;
      }

      // functionCall 동반 멘트(목록입니다/반영했어요/골라주세요 등 절차 멘트)는 화면에 표시하지 않는다.
      // 카드·미리보기가 주 출력이라 절차 멘트는 장황·중복만 됨. (히스토리 state.messages에는 아래에서 남겨 모델 맥락 유지)
      // functionCall 처리: present_choices 전까지 실행, present_choices면 카드 띄우고 중단
      const toolCalls = [];
      const toolResults = [];
      let pending = null;
      for (const fc of functionCalls) {
        const id = `call_${state.callSeq++}`;
        toolCalls.push({ id, type: "function", function: { name: fc.name, arguments: JSON.stringify(fc.args || {}) } });
        if (fc.name === "present_choices") { pending = { id, args: fc.args || {} }; break; }
        // complete_plan은 독립 LLM 검수가 있어 async — await로 처리, 그 외는 동기 runTool
        const res = fc.name === "complete_plan" ? await doCompletePlan() : runTool(fc.name, fc.args || {});
        if (fc.name === "update_plan") updatedThisTurn = true;
        if (fc.name === "complete_plan") state.completeFails = res && res.ok ? 0 : (state.completeFails || 0) + 1;
        toolResults.push({ id, name: fc.name, content: JSON.stringify(res) });
      }
      state.messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
      for (const tr of toolResults) {
        state.messages.push({ role: "tool", tool_call_id: tr.id, name: tr.name, content: tr.content });
      }
      // 가드: complete_plan이 연속 2회 ok:false면 자동 재호출을 멈추고 사용자에게 위임.
      // state.completeBlocked=true 로 잠궈 이 run에서 더 이상 자동 complete_plan 시도를 막는다.
      if ((state.completeFails || 0) >= 2) {
        if (loader) { removeLoader(loader); loader = null; }
        state.completeBlocked = true;
        addBot("자동 검토를 2회 통과하지 못했어요. 오른쪽 미리보기에서 비어 있거나 어색한 칸(특히 '수업자 의도')을 직접 확인·수정하신 뒤 ⬇ HWPX 다운로드를 눌러 주세요. 추가 자동 재시도는 비용 절약을 위해 멈췄습니다.");
        state.completeFails = 0;
        exhausted = false;
        break;
      }

      if (pending) {
        // 가드: 방금 확정한 CHOICE_PLAN_KEY를 LLM이 곧바로 다시 present_choices하면(모델이 "다시 묻지 마"
        // 지시를 무시한 무한반복) 카드를 띄우지 않고 "이미 그 값으로 확정됨" tool 결과를 주입해 다음으로 민다.
        // (프록시가 selected를 "사용자가 …선택, 확정, 다시 묻지 마"로 변환하므로 프록시 수정 불필요.)
        const fld = normField(pending.args.field);
        if (fld && state.confirmedChoices.has(fld) && state.partialPlan[fld]) {
          guardHits++;
          // 안전 착지: 거부 신호를 주는데도 모델이 같은 확정 항목 카드를 계속(누적 3회) 재호출하면
          // 무한루프로 보고 멈춘다. 사용자가 입력창으로 진행을 지시하면 가드가 풀려 이어진다.
          if (guardHits >= 3) {
            if (loader) { removeLoader(loader); loader = null; }
            addBot(`'${pending.args.field}'은(는) 이미 '${state.partialPlan[fld]}'(으)로 선택하셨어요. 다음 단계로 진행하려면 아래 입력창에 "다음으로 진행해줘"라고 적어 주세요.`);
            exhausted = false;
            break;
          }
          // 거부형 신호(already_confirmed) — 프록시가 "이미 확정, 다시 묻지 말고 다음 단계로"로 변환한다.
          // (기존 selected 주입은 모델이 '또 선택받음'으로 오해해 같은 카드를 무한 재호출하는 원인이었다.)
          state.messages.push({
            role: "tool", tool_call_id: pending.id, name: "present_choices",
            content: JSON.stringify({ field: pending.args.field, already_confirmed: state.partialPlan[fld] }),
          });
          if (!loader) loader = addLoader();
          continue;   // confirmedChoices는 유지(연속 반복·되돌아가기 모두 차단)
        }
        if (loader) { removeLoader(loader); loader = null; }
        const a = pending.args;
        let opts = Array.isArray(a.options) ? a.options.filter(Boolean) : [];
        // LLM이 데이터 고정 항목을 빈 options로 호출하면 클라가 RAG 데이터로 채운다(빈 카드 방지)
        if (opts.length === 0) opts = fallbackOptions(a.field);
        // 가드: 후보를 못 채웠고(LLM 누락) RAG 폴백도 없으면(탐구질문 등 생성 항목) 빈 카드가 뜬다 →
        // 카드 대신 "후보를 채워 다시 호출"을 1회 요청한다. (실패가 반복되면 그냥 카드를 띄워 직접 입력 유도)
        if (opts.length === 0 && !emptyChoiceRetried) {
          emptyChoiceRetried = true;
          state.messages.push({
            role: "tool", tool_call_id: pending.id, name: "present_choices",
            content: JSON.stringify({ error: "options 비어 있음", field: a.field, note: `'${a.field}'의 선택 후보 3~5개를 options 배열에 직접 채워 present_choices를 다시 호출하세요. 빈 options로는 카드를 띄울 수 없습니다.` }),
          });
          if (!loader) loader = addLoader();
          continue;
        }
        // 가드: 네가 직접 만드는 후보(allow_regenerate)는 최소 3개여야 한다 — 1~2개만 오면 1회 더 요청
        if (a.allow_regenerate === true && opts.length > 0 && opts.length < 3 && !fewChoiceRetried) {
          fewChoiceRetried = true;
          state.messages.push({
            role: "tool", tool_call_id: pending.id, name: "present_choices",
            content: JSON.stringify({ error: "선택지 부족", field: a.field, note: `'${a.field}' 후보가 ${opts.length}개뿐입니다. 관점을 달리해 서로 다른 후보를 최소 3개 만들어 options에 담아 present_choices를 다시 호출하세요.` }),
          });
          if (!loader) loader = addLoader();
          continue;
        }
        // B3-1: present_choices LLM 자발 재호출 상한 — 차단 시 카드 대신 stop 응답 주입
        if (_b3ChoicesCapHit(detectStage(state.partialPlan), a.field || "")) {
          state.messages.push({
            role: "tool", tool_call_id: pending.id, name: "present_choices",
            content: JSON.stringify({ error: "choices_cap", field: a.field, note: `'${a.field}' 항목은 후보 제시 ${MAX_CHOICES_PER_FIELD}회 한도에 도달했습니다. 새 카드를 띄우지 말고, 보유 후보로 사용자에게 직접 입력을 받거나 다음 단계로 진행하세요.` }),
          });
          if (!loader) loader = addLoader();
          continue;
        }
        const cardArgs = {
          field:   a.field || "항목",
          intro:   a.intro || "",
          options: opts,
          multi:   !!a.multi,
          custom:  a.allow_custom !== false,
          none:    !!a.allow_none,
          regenerate: !!a.allow_regenerate,
        };
        state.pendingCall = { tool_call_id: pending.id, name: "present_choices", cardArgs };
        showChoiceCard(cardArgs);
        state.loading = false; setComposerEnabled(true); updateProgress(); saveState();
        return;
      }
      // tool 실행 후 LLM 재호출
      if (!loader) loader = addLoader();
    }
    if (exhausted) {
      // 함수호출이 끝없이 반복돼 상한에 도달(예: 데이터를 못 찾아 같은 RAG 재시도). 안내하고 멈춘다.
      if (loader) { removeLoader(loader); loader = null; }
      addBot("처리가 예상보다 길어졌어요. 학년·학기·교과·단원을 조금 더 구체적으로 알려 주시거나 다시 시도해 주세요.");
    }
  } catch (e) {
    if (loader) removeLoader(loader);
    // LLM 호출 오류는 코드별 안내, 그 외(runTool·buildHWPX 등)는 일반 문구
    addBot(e && e.llm ? llmErrorMessage(e) : ("요청 처리 중 오류가 발생했습니다.\n" + (e.message || e)));
  } finally {
    if (loader) removeLoader(loader);
    state.loading = false;
    setComposerEnabled(true);
    updateProgress();
    saveState();
  }
}

/* [USE_INTER] Interactions 대화 루프 — generateContent 루프(runConversation)와 같은 가드(confirmedChoices·
   guardHits 안전착지·choiceRetried·updateRetried·complete 3회·빈옵션)를 적용하되, 결과 전달을 messages.push가
   아니라 function_result 배열(다음 input)로 한다. 히스토리는 서버가 previous_interaction_id로 보관. */
async function runConversationInter() {
  if (state.loading) return;
  state.loading = true;
  setComposerEnabled(false);
  let loader = addLoader();
  let exhausted = true;
  let choiceRetried = false, updateRetried = false, updatedThisTurn = false, emptyChoiceRetried = false, fewChoiceRetried = false, guardHits = 0;
  const onRetry = (n, total, status) => {
    if (!loader) return;
    const msg = status === 0 ? `연결이 불안정해 다시 시도하고 있어요… (${n}/${total})`
              : status === 429 ? `요청이 많아 잠시 후 다시 시도하고 있어요… (${n}/${total})`
              : `AI 서버가 붐벼 다시 시도하고 있어요… (${n}/${total})`;
    setLoaderText(loader, msg);
  };
  try {
    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const input = state.interInput;
      state.interInput = null;
      if (input == null) { exhausted = false; break; }   // 보낼 입력이 없으면 종료(턴 끝)

      const { content, functionCalls } = await callLLMInter(input, onRetry);

      if (!functionCalls.length) {
        // 순수 텍스트 응답 — 턴 종료(또는 재요청). 재요청을 유발한 '잘못된' 텍스트는 표시하지 않고 스피너만 유지.
        {
          const _txt = content || "";
          const _bulletCount = (_txt.match(/^[ \t]*(?:[-*•]|[①-⑩]|\d+[.)])\s+\S/gm) || []).length;
          const _hasChoicePhrase = /(골라|고르|선택|제안|추천|후보|마음에\s*드는|다음\s*중|세\s*가지|3\s*가지|두\s*가지|2\s*가지)/.test(_txt);
          if (!choiceRetried && ((_hasChoicePhrase && _bulletCount >= 2) || /(골라|선택해|선택하여|고르)\s*주세요|고르세요|추천해\s*드립니다|선택해\s*주십시오/.test(_txt))) {
            choiceRetried = true;
            state.interInput = "방금 안내한 항목의 선택지를 지금 present_choices 카드로 띄워 주세요(채팅에 번호·불릿으로 나열하지 말고). 도구는 본문 텍스트로 적지 말고 반드시 실제 함수 호출로 보내세요.";
            if (!loader) loader = addLoader();
            continue;
          }
        }
        if (!updateRetried && !updatedThisTurn &&
            /(반영|수정|변경|업데이트|보완|기입|입력|작성|추가)(했|하였|해\s*드렸|해\s*두었|해\s*놨)|채웠|고쳤|바꿨|넣었|적었/.test(content || "") &&
            !/이미\s*(반영|수정|입력|작성)|되어\s*있|반영(돼|되어)\s*있/.test(content || "")) {
          updateRetried = true;
          state.interInput = "방금 미리보기에 반영/수정했다고 하셨는데 update_plan 함수 호출이 없었습니다. 바뀐 필드만 지금 update_plan으로 보내 주세요(채팅에 본문을 다시 나열하지 말고).";
          if (!loader) loader = addLoader();
          continue;
        }
        // 재요청 없이 정상 종료 — 이제 텍스트 표시
        if (content && content.trim()) { removeLoader(loader); loader = null; addBot(content.trim()); }
        exhausted = false;
        break;
      }

      // functionCall 동반 멘트(목록입니다/반영했어요/골라주세요 등 절차 멘트)는 화면에 표시하지 않는다 — 카드·미리보기가 주 출력.
      // functionCall 처리: present_choices 전까지 실행해 function_result 누적, present_choices면 카드 띄우고 중단
      const results = [];
      let pending = null;
      for (const fc of functionCalls) {
        if (fc.name === "present_choices") { pending = { callId: fc.callId, args: fc.args || {} }; break; }
        const res = fc.name === "complete_plan" ? await doCompletePlan() : runTool(fc.name, fc.args || {});
        if (fc.name === "update_plan") updatedThisTurn = true;
        if (fc.name === "complete_plan") state.completeFails = res && res.ok ? 0 : (state.completeFails || 0) + 1;
        results.push({ type: "function_result", name: fc.name, call_id: fc.callId, result: [{ type: "text", text: JSON.stringify(res) }] });
      }

      if ((state.completeFails || 0) >= 2) {
        if (loader) { removeLoader(loader); loader = null; }
        state.completeBlocked = true;
        addBot("자동 검토를 2회 통과하지 못했어요. 오른쪽 미리보기에서 비어 있거나 어색한 칸(특히 '수업자 의도')을 직접 확인·수정하신 뒤 ⬇ HWPX 다운로드를 눌러 주세요. 추가 자동 재시도는 비용 절약을 위해 멈췄습니다.");
        state.completeFails = 0; exhausted = false; break;
      }

      if (pending) {
        const fld = normField(pending.args.field);
        // 되돌아가기 가드: 이미 확정된 항목 카드를 또 띄우면 거부 신호(already_confirmed), 3회면 안전 착지
        if (fld && state.confirmedChoices.has(fld) && state.partialPlan[fld]) {
          guardHits++;
          if (guardHits >= 3) {
            if (loader) { removeLoader(loader); loader = null; }
            addBot(`'${pending.args.field}'은(는) 이미 '${state.partialPlan[fld]}'(으)로 선택하셨어요. 다음 단계로 진행하려면 아래 입력창에 "다음으로 진행해줘"라고 적어 주세요.`);
            exhausted = false; break;
          }
          results.push({ type: "function_result", name: "present_choices", call_id: pending.callId,
            result: [{ type: "text", text: JSON.stringify({ field: pending.args.field, already_confirmed: state.partialPlan[fld] }) }] });
          state.interInput = results;
          if (!loader) loader = addLoader();
          continue;
        }
        if (loader) { removeLoader(loader); loader = null; }
        const a = pending.args;
        let opts = Array.isArray(a.options) ? a.options.filter(Boolean) : [];
        if (opts.length === 0) opts = fallbackOptions(a.field);
        if (opts.length === 0 && !emptyChoiceRetried) {
          emptyChoiceRetried = true;
          results.push({ type: "function_result", name: "present_choices", call_id: pending.callId,
            result: [{ type: "text", text: JSON.stringify({ error: "options 비어 있음", field: a.field, note: `'${a.field}'의 선택 후보 3~5개를 options 배열에 직접 채워 present_choices를 다시 호출하세요. 빈 options로는 카드를 띄울 수 없습니다.` }) }] });
          state.interInput = results;
          if (!loader) loader = addLoader();
          continue;
        }
        // 가드: 네가 직접 만드는 후보(allow_regenerate)는 최소 3개여야 한다 — 1~2개만 오면 1회 더 요청
        if (a.allow_regenerate === true && opts.length > 0 && opts.length < 3 && !fewChoiceRetried) {
          fewChoiceRetried = true;
          results.push({ type: "function_result", name: "present_choices", call_id: pending.callId,
            result: [{ type: "text", text: JSON.stringify({ error: "선택지 부족", field: a.field, note: `'${a.field}' 후보가 ${opts.length}개뿐입니다. 관점을 달리해 서로 다른 후보를 최소 3개 만들어 options에 담아 present_choices를 다시 호출하세요.` }) }] });
          state.interInput = results;
          if (!loader) loader = addLoader();
          continue;
        }
        // B3-1: present_choices LLM 자발 재호출 상한 — 차단 시 카드 대신 stop 응답 주입
        if (_b3ChoicesCapHit(detectStage(state.partialPlan), a.field || "")) {
          results.push({ type: "function_result", name: "present_choices", call_id: pending.callId,
            result: [{ type: "text", text: JSON.stringify({ error: "choices_cap", field: a.field, note: `'${a.field}' 항목은 후보 제시 ${MAX_CHOICES_PER_FIELD}회 한도에 도달했습니다. 새 카드를 띄우지 말고, 보유 후보로 사용자에게 직접 입력을 받거나 다음 단계로 진행하세요.` }) }] });
          state.interInput = results;
          if (!loader) loader = addLoader();
          continue;
        }
        const cardArgs = {
          field: a.field || "항목", intro: a.intro || "", options: opts,
          multi: !!a.multi, custom: a.allow_custom !== false, none: !!a.allow_none, regenerate: !!a.allow_regenerate,
        };
        // prevResults: present_choices 전에 실행된 function_result들 — 사용자 선택 후 함께 보냄
        state.pendingCall = { callId: pending.callId, name: "present_choices", cardArgs, prevResults: results };
        showChoiceCard(cardArgs);
        state.loading = false; setComposerEnabled(true); updateProgress(); saveState();
        return;
      }

      // tool 실행 결과(function_result들)를 다음 input으로 → 재호출
      state.interInput = results;
      if (!loader) loader = addLoader();
    }
    if (exhausted) {
      if (loader) { removeLoader(loader); loader = null; }
      addBot("처리가 예상보다 길어졌어요. 학년·학기·교과·단원을 조금 더 구체적으로 알려 주시거나 다시 시도해 주세요.");
    }
  } catch (e) {
    if (loader) removeLoader(loader);
    addBot(e && e.llm ? llmErrorMessage(e) : ("요청 처리 중 오류가 발생했습니다.\n" + (e.message || e)));
  } finally {
    if (loader) removeLoader(loader);
    state.loading = false;
    setComposerEnabled(true);
    updateProgress();
    saveState();
  }
}

// 데이터 고정 항목(교과역량·성취기준·핵심아이디어)에서 LLM이 옵션을 빠뜨렸을 때 클라가 채움
function fallbackOptions(field) {
  const f = String(field || "");
  const p = state.partialPlan;
  try {
    if (/역량/.test(f)) return (state.datasets.subjectCompetencies || {})[p.교과] || [];
    if (/성취\s*기준/.test(f)) return (ragFindStandards({ 교과: p.교과, 학년: p.학년, 학기: p.학기, 단원: p.단원, 출판사: p.출판사 }).standards || []).map((s) => s.성취기준);
    if (/핵심\s*아이디어/.test(f)) return ragListCoreIdeas({ 교과: p.교과, 영역: p.영역 }).core_ideas || [];
  } catch (e) { /* 데이터 미비 시 빈 옵션 */ }
  return [];
}

/* ── tool 디스패치 (동기) ── */
/* === B3 가드: stage 6·9·10 멀티콜 절감 ===
   B3-1 present_choices 반복 상한, B3-2 RAG 결과 캐시, B3-3 stage 6 RAG 횟수 가드.
   회귀 시 1줄 비활성화: 아래 *_ENABLED 를 false 로. */
const RAG_CACHE_ENABLED = true;
const RAG_COUNT_GUARD_ENABLED = true;
const CHOICES_CAP_ENABLED = true;
const MAX_CHOICES_PER_FIELD = 2;      // LLM 자발적 재호출 한도(사용자 regenerate 응답은 제외)
const STAGE6_RAG_MAX = 6;             // stage 6 RAG 누적 호출 상한(보수)
// 세션-내 가드 상태: stage 전환 시 부분 리셋
const _b3 = {
  ragCache: new Map(),        // key="stage|name|argsJSON" → result(JSON.parse 결과)
  ragCount: {},               // stage → RAG 누적 호출 수
  choicesCount: {},           // "stage|field" → LLM 자발 호출 누적 수
  lastStage: null,
};
function _b3MaybeRotate(stage) {
  if (stage == null) return;
  if (_b3.lastStage !== stage) {
    // 직전 stage 캐시·카운터 정리(현재 stage 키만 남김)
    const keep = String(stage);
    for (const k of Array.from(_b3.ragCache.keys())) {
      if (!k.startsWith(keep + "|")) _b3.ragCache.delete(k);
    }
    _b3.lastStage = stage;
  }
}
function _b3StableKey(obj) {
  try {
    if (!obj || typeof obj !== "object") return JSON.stringify(obj ?? null);
    const keys = Object.keys(obj).sort();
    const norm = {};
    for (const k of keys) norm[k] = obj[k];
    return JSON.stringify(norm);
  } catch { return ""; }
}
const _RAG_NAMES = new Set(["find_standards", "list_competencies", "list_core_ideas", "list_considerations", "list_lesson_models"]);

function runTool(name, args) {
  try {
    // === B3 가드 진입(RAG에만 적용) ===
    const stage = detectStage(state.partialPlan);
    if (_RAG_NAMES.has(name)) {
      _b3MaybeRotate(stage);
      // B3-3: stage 6 RAG 누적 상한
      if (RAG_COUNT_GUARD_ENABLED && stage === 6) {
        const used = _b3.ragCount[6] || 0;
        if (used >= STAGE6_RAG_MAX) {
          console.warn(`[b3-rag-cap] stage=6 used=${used} name=${name} — stop hint 주입`);
          return { stop: true, note: "RAG 충분히 조회했습니다. 보유 후보로 present_choices를 호출하거나, 평가 단계의 다음 항목으로 진행하세요." };
        }
      }
      // B3-2: 같은 stage·같은 인자 캐시 hit
      if (RAG_CACHE_ENABLED && stage != null) {
        const key = `${stage}|${name}|${_b3StableKey(args)}`;
        if (_b3.ragCache.has(key)) {
          console.warn(`[b3-rag-cache-hit] stage=${stage} name=${name}`);
          const cached = _b3.ragCache.get(key);
          // hint를 result에 같이 실어, 다음 LLM 콜이 추가 RAG 없이 present_choices로 정리하도록 유도
          return { ...cached, cached: true, hint: "이미 동일 인자로 받은 결과를 재사용합니다. 추가 RAG 호출 없이 present_choices로 정리하세요." };
        }
      }
      // 카운트는 실제 실행 직전에 증가
      _b3.ragCount[stage] = (_b3.ragCount[stage] || 0) + 1;
    }

    let res;
    switch (name) {
      case "find_standards":      res = ragFindStandards(args); break;
      case "list_competencies":   res = ragListCompetencies(args); break;
      case "list_core_ideas":     res = ragListCoreIdeas(args); break;
      case "list_considerations": res = ragListConsiderations(args); break;
      case "list_lesson_models":  res = ragListLessonModels(args); break;
      case "update_plan":         res = doUpdatePlan(args); break;
      // complete_plan은 async(LLM 검수 포함)라 runConversation에서 await로 직접 처리
      default:                    res = { error: `unknown tool: ${name}` };
    }

    // RAG 결과 캐싱(에러는 캐시 안 함)
    if (RAG_CACHE_ENABLED && _RAG_NAMES.has(name) && stage != null && res && !res.error) {
      const key = `${stage}|${name}|${_b3StableKey(args)}`;
      _b3.ragCache.set(key, res);
    }
    return res;
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// B3-1: present_choices 진입 시 호출. true 반환 시 카드 표시 차단.
// user-regenerate(사용자 "다시 제안") 응답으로 인한 재호출은 카운트하지 않음.
function _b3ChoicesCapHit(stage, field) {
  if (!CHOICES_CAP_ENABLED || stage == null || !field) return false;
  const key = `${stage}|${field}`;
  const wasUserRegen = !!state._lastUserRegen;
  // 사용자 regenerate 응답으로 인한 직후 호출은 카운트에서 제외
  if (wasUserRegen) {
    state._lastUserRegen = false;
    return false;
  }
  const n = (_b3.choicesCount[key] = (_b3.choicesCount[key] || 0) + 1);
  if (n > MAX_CHOICES_PER_FIELD) {
    console.warn(`[b3-choices-cap] stage=${stage} field=${field} count=${n}`);
    return true;
  }
  return false;
}


/* ── RAG: 교육과정 데이터 조회 (환각 0) ── */
function ragFindStandards({ 교과, 학년, 학기, 단원, 출판사 }) {
  const subj = 교과, g = parseInt(학년) || 0, sem = parseInt(학기) || 0;
  const band = gradeToBand(g);
  const ach = state.datasets.achievements || [];
  // 0) 통합 lesson_units 단원 정밀 매칭 (성취기준 다수 + 영역 + 단원학습내용 보유)
  const lu = findLessonUnit(subj, g, sem, 단원 || "", 출판사);
  if (lu && Array.isArray(lu.성취기준) && lu.성취기준.length) {
    const std = lu.성취기준.map((s) => {
      const m = s.match(/\[(\d+[가-힣]+\d{2}-\d{2})\]/);
      const f = m ? ach.find((a) => (a["성취기준"] || "").startsWith(`[${m[1]}]`)) : null;
      return { 성취기준: s, 영역: lu.영역 || (f ? f["영역"] : ""), 해설: f ? (f["성취기준 해설"] || "") : "" };
    });
    return { source: "lesson_units", 단원: lu.단원명, 출판사: lu.출판사, 영역: lu.영역, 단원학습내용: lu.단원학습내용, standards: std };
  }
  // 1) 폴백: 교과+학년 전체.
  // achievement.json의 "학년" 형식이 교과마다 다름 — 사회는 "5~6학년"(학년군), 수학은 "6학년 2학기"(학년별).
  // 둘 다 잡으려면 학년군("5~6학년")과 학년("6학년") 두 형식으로 매칭한다.
  const gradeStr = g ? `${g}학년` : "";
  const list = ach
    .filter((a) => {
      // 통합교과는 achievement에 "바른생활/슬기로운생활/즐거운생활"로 저장되어 교과명이 다르다 → 통합교과면 셋 다 매칭(단원 매칭 실패 시 0건 방지).
      const subjOk = a["교과"] === subj || (subj === "통합교과" && ["바른생활", "슬기로운생활", "즐거운생활"].includes(a["교과"]));
      if (!subjOk) return false;
      const y = String(a["학년"] || "");
      return y.includes(band) || (gradeStr && y.includes(gradeStr));
    })
    // 폴백은 교과·학년 전체(24~30건)라 해설 전문을 실으면 3~6.5K자 — 80자로 잘라 토큰 절감
    .map((a) => ({ 성취기준: a["성취기준"], 영역: a["영역"], 해설: String(a["성취기준 해설"] || "").slice(0, 80) }));
  return { source: "achievement_all", 교과: subj, 학년: g, count: list.length, standards: list };
}

// 교과·학년군의 모든 성취기준 원문 목록(중복 제거). 검색하여 추가 드롭다운용.
function listAllStandards(교과, 학년) {
  if (!교과) return [];
  const g = parseInt(학년) || 0;
  const band = gradeToBand(g);
  const gradeStr = g ? `${g}학년` : "";
  const seen = new Set();
  const out = [];
  for (const a of state.datasets.achievements || []) {
    if (a["교과"] !== 교과) continue;
    const y = String(a["학년"] || "");
    if (!(y.includes(band) || (gradeStr && y.includes(gradeStr)))) continue;
    const s = a["성취기준"];
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function ragListCompetencies({ 교과 }) {
  const comps = (state.datasets.subjectCompetencies || {})[교과] || [];
  if (!comps.length) {
    // 통합교과(바른생활·슬기로운생활·즐거운생활) 등은 공식 교과역량 목록이 없다 → LLM이 직접 생성
    return { 교과, competencies: [], note: `'${교과}'는 2022 개정 공식 교과역량 목록이 없는 교과입니다. 이 차시 학습 맥락에 맞는 역량·태도 2~3개를 네가 직접 만들어 present_choices의 options에 채워 제시하세요.` };
  }
  return { 교과, competencies: comps };
}

function ragListCoreIdeas({ 교과, 영역 }) {
  const ideas = [];
  findCoreIdeas(교과, 영역).forEach((r) => {
    const parts = String(r).match(/[^.]+\.(?=\s|$)/g);
    const items = (parts && parts.length > 1) ? parts : [r];
    items.forEach((s) => { const t = s.trim(); if (t && !ideas.includes(t)) ideas.push(t); });
  });
  if (!ideas.length) {
    return { 교과, 영역, core_ideas: [], note: `'${교과}'(${영역 || "통합교과"})의 핵심 아이디어 데이터가 없습니다. 성취기준과 차시 맥락에 맞는 핵심 아이디어 2~3개를 네가 직접 만들어 present_choices의 options에 채우세요.` };
  }
  return { 교과, 영역, core_ideas: ideas };
}

function ragListConsiderations({ 교과, 영역, 학년 }) {
  const band = gradeToBand(parseInt(학년) || 0);
  return { 교과, 영역, 학년군: band, considerations: findConsiderations(교과, 영역, band) };
}

// 과목별 교수·학습 모형 목록. 다단계 모형은 단계명 흐름을, 단계 없는 모형은 한 줄 설명을 반환.
// (단계 상세 설명은 lesson_models.json에 보존하되 토큰 절약을 위해 RAG에선 단계명만 싣는다.)
function ragListLessonModels({ 교과 }) {
  const models = (state.datasets.lessonModels || {})[교과] || [];
  if (!models.length) {
    return { 교과, models: [], note: `'${교과}'의 교수·학습 모형 데이터가 없습니다. 이 교과·차시에 적합한 일반 모형 4~5개를 네가 직접 제시하세요.` };
  }
  return {
    교과,
    models: models.map((m) => {
      const o = { 모형: m.모형, 출처: m.출처 };
      if (Array.isArray(m.단계) && m.단계.length) o.단계 = m.단계.map((s) => s.단계명);
      else if (m.설명) o.설명 = String(m.설명).slice(0, 80);
      return o;
    }),
  };
}

/* ── 미리보기 갱신 ── */
// 미리보기·HWPX는 인덱스 평가 키(평가1_*)를 기준으로 한다.
// LLM이 인덱스 없는 키(평가범주 등)로 보내면 평가1_*로 정규화한다(안전망).
const EVAL_KEY_MAP = {
  "평가범주": "평가1_범주", "평가요소": "평가1_요소", "평가방법": "평가1_방법",
  "평가수준상": "평가1_수준상", "평가수준중": "평가1_수준중", "평가수준하": "평가1_수준하",
  "피드백": "평가1_피드백",
};
function normalizeEvalKeys(fields) {
  for (const [from, to] of Object.entries(EVAL_KEY_MAP)) {
    if (from in fields && !(to in fields)) { fields[to] = fields[from]; delete fields[from]; }
  }
}

// obj의 키 중 정규식 1번째 캡처가 숫자인 것들의 최대 인덱스 (평가{i}_ / 전개_sub{i}_ 카운트 보정용)
function maxKeyIndex(obj, re) {
  let n = 0;
  for (const k of Object.keys(obj)) { const m = k.match(re); if (m) n = Math.max(n, parseInt(m[1])); }
  return n;
}

function doUpdatePlan(args) {
  let fields;
  if (Array.isArray(args.fields)) {
    // 새 구조: [{key, value}] — value가 순수 문자열이라 이중 JSON 이스케이프가 없어 MALFORMED를 피한다
    fields = {};
    for (const f of args.fields) {
      if (f && typeof f.key === "string") fields[f.key] = f.value;
    }
  } else {
    // 하위호환: fields_json(JSON 문자열)
    try { fields = JSON.parse(args.fields_json || "{}"); }
    catch (e) { return { ok: false, error: "fields 파싱 실패" }; }
  }
  if (!fields || typeof fields !== "object") return { ok: false, error: "fields는 객체여야 함" };
  sanitizeSubActivityHeaders(fields);
  normalizeEvalKeys(fields);
  // 빈 값으로 기존 값을 지우지 않는다 — LLM이 다른 필드 갱신 중 확정된 필드를 빈 값으로
  // 함께 보내 데이터가 사라지던 문제 방지. (의도적 삭제는 미리보기에서 직접 편집)
  const reflected = [];   // 실제 미리보기에 반영된 키
  const ignored = [];     // 형식이 잘못돼 무시된 환각 키
  for (const [k, v] of Object.entries(fields)) {
    // 정당한 plan 키는 전부 한글로 시작한다 → 한글로 시작하지 않는 키(LLM이 환각한 'a__역량'·'a__111'
    // 같은 쓰레기. 'a__역량'은 한글을 '포함'해 기존 한글포함 검사를 빠져나갔다)는 무시해
    // 미리보기·검토(complete_plan)가 오염되지 않게 한다.
    if (!/^[가-힣]/.test(k)) { ignored.push(k); continue; }
    const isEmpty  = v == null || String(v).trim() === "";
    const hadValue = state.partialPlan[k] != null && String(state.partialPlan[k]).trim() !== "";
    if (isEmpty && hadValue) continue;
    // 기계적 보정(모델에 재요청하지 않고 클라가 직접 고침 — 토큰 0):
    // ① 모델이 이중 이스케이프로 보낸 literal "\n"(백슬래시+n 텍스트)을 실제 줄바꿈으로 치환.
    let val = typeof v === "string" ? v.replace(/\\n/g, "\n") : v;
    // ② 학생활동에 글머리(◦-)가 없는 평문 여러 줄이면 각 줄에 ◦를 붙여 위계 통일(이미 글머리 있거나 한 줄이면 그대로).
    if (/_학생활동$/.test(k) && !isEmpty) {
      const lines = String(val).split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1 && !lines.some((l) => /^[◉◦∘●○•\-]/.test(l))) val = lines.map((l) => "◦ " + l).join("\n");
    }
    // ③ 피드백 앞의 '(하)' 수준 표시 제거 — 피드백 항목 자체가 '하' 지원이라 불필요(기계적 제거).
    if (/^평가\d+_피드백$/.test(k) && typeof val === "string") val = val.replace(/^\s*\(\s*하\s*\)\s*/, "");
    state.partialPlan[k] = val;
    if (!isEmpty) state.recentlyUpdated.add(k);   // 비지 않은 갱신만 미리보기에서 강조
    reflected.push(k);
  }
  // LLM이 평가_num·전개_num_subs를 빠뜨려도 인덱스 키의 최대값으로 보정 → 미리보기 행·HWPX 템플릿 선택
  const maxEval = maxKeyIndex(state.partialPlan, /^평가(\d+)_/);
  if (maxEval > 0 && (parseInt(state.partialPlan.평가_num) || 0) < maxEval) state.partialPlan.평가_num = maxEval;
  const maxSub = maxKeyIndex(state.partialPlan, /^전개_sub(\d+)_/);
  if (maxSub >= 2 && (parseInt(state.partialPlan.전개_num_subs) || 0) !== maxSub) state.partialPlan.전개_num_subs = maxSub;
  scheduleRender();
  // 무시된 환각 키는 updated에서 빼고 알린다 — 모델이 'a__역량 저장 성공'으로 오해해 같은 단계를 반복하지 않게.
  const result = { ok: true, updated: reflected };
  if (ignored.length) result.note = `다음 키는 형식이 잘못되어(정상 필드명은 한글로 시작) 무시되었습니다: ${ignored.join(", ")}. 해당 값이 정상 필드(예: 교과역량)에 이미 반영돼 있으면 다시 보내지 말고 다음 단계로 진행하세요.`;
  // 시간 키를 건드린 경우 합 점검(소프트 경고) — 차단하지 않고 모델에 즉시 피드백
  if (reflected.some((k) => /_시간$/.test(k))) {
    const tnum = (k) => { const n = parseInt(String(state.partialPlan[k] || "").replace(/[^0-9]/g, ""), 10); return n > 0 ? n : 0; };
    let sum = tnum("도입_시간") + tnum("정리_시간");
    const nSub = parseInt(state.partialPlan.전개_num_subs) || 0;
    if (nSub >= 2) { for (let i = 1; i <= nSub; i++) sum += tnum(`전개_sub${i}_시간`); }
    else sum += tnum("전개_시간");
    if (sum > 0 && sum !== 40) {
      const delta = sum - 40;
      const target = nSub >= 2 ? `전개_sub${nSub}_시간` : "전개_시간";
      result.warn = delta > 0
        ? `시간 합 ${sum}분(40 초과 ${delta}분). 가장 긴 전개 활동(${target}) 시간을 ${delta}분 줄여 다시 update_plan하세요. 채팅 본문에 fields JSON을 적지 말고 도구 호출만 사용.`
        : `시간 합 ${sum}분(40 미만 ${-delta}분). 가장 긴 전개 활동(${target}) 시간을 ${-delta}분 늘려 다시 update_plan하세요.`;
    }
  }
  return result;
}

// 완료 직전, 독립 LLM(tools 없는 json 검수)으로 각 셀값이 의미 있는지 점검한다.
// 비용 최적화 (T 보정): A=2.5-flash-lite(스키마/포맷·저비용) → 이슈 없으면 B=3-flash-preview 로 일관성 재확인,
//                       A 가 이슈를 잡았으면 그것만 채택(추가 호출 없음). 두 모델 모두 실패하면 3.5-flash 최종 폴백.
// 행정 정보(차시·교과서쪽수·대상학급·일시)는 제외.
async function verifyPlanQuality() {
  const fields = {};
  for (const [k, v] of Object.entries(state.partialPlan)) {
    if (v == null || String(v).trim() === "" || ADMIN_FIELDS.includes(k) || /_num/.test(k)) continue;
    fields[k] = v;
  }
  const sys = "너는 초등 교수·학습 과정안 검수자다. 아래 JSON 값 중 '명백히 잘못된 것'만 골라 보고하라.\n" +
    "오직 다음만 문제다: placeholder·임시문구(\"...\",\"예시\",\"내용 입력\",\"TODO\"), 빈 괄호만 있는 값, 글자가 깨졌거나 문장이 중간에 잘린 값.\n" +
    "표현·문체·중복·교육적 적절성·요소 간 유사성·동문서답 여부는 문제로 보지 마라(조금이라도 애매하면 문제 아님으로 처리). 대상학급·일시·차시는 검증 대상이 아니다.\n" +
    "반드시 아래 JSON만 출력하라: {\"issues\":[{\"field\":\"필드명\",\"reason\":\"한 줄 이유\"}]}. 문제가 없으면 {\"issues\":[]}.";
  const baseBody = { messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(fields) }], json: true, maxTokens: 2000, variant: VARIANT, stage: 99, runId: state.runId };

  async function callOne(model) {
    try {
      const res = await fetch(API_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseBody, model }),
      });
      if (!res.ok) return { ok: false };
      const data = await res.json();
      state.verifyUsd = (state.verifyUsd || 0) + (data._usd || 0);
      const issues = (data.issues || []).filter((x) => x && x.field).map((x) => `${x.field}(${x.reason || "부적절"})`);
      return { ok: true, issues };
    } catch { return { ok: false }; }
  }

  // A: 2.5-flash-lite (가장 저렴) — 스키마/명백한 결함 1차
  let a = await callOne("gemini-2.5-flash-lite");
  if (!a.ok) { await sleep(500); a = await callOne("gemini-2.5-flash-lite"); }   // 일시 오류 1회 재시도

  // A 가 이슈를 잡았으면 그대로 채택 (B 호출 절약)
  if (a.ok && a.issues.length > 0) return { issues: a.issues, unavailable: false };

  // B: 3-flash-preview (중급, 일관성 재확인). A 가 비어있을 때만 호출.
  let b = await callOne("gemini-3-flash-preview");
  if (!b.ok) { await sleep(500); b = await callOne("gemini-3-flash-preview"); }

  if (a.ok && b.ok) {
    // 두 결과 합집합 (둘 다 본 결함만 보고하고 싶다면 교집합으로 바꿀 수 있음 — 현재는 합집합 = 보수적)
    const merged = Array.from(new Set([...(a.issues || []), ...(b.issues || [])]));
    return { issues: merged, unavailable: false };
  }
  if (b.ok) return { issues: b.issues, unavailable: false };
  if (a.ok) return { issues: a.issues, unavailable: false };

  // 둘 다 실패 → gemini-3.5-flash 최종 폴백
  const c = await callOne("gemini-3.5-flash");
  if (c.ok) return { issues: c.issues, unavailable: false };
  return { issues: [], unavailable: true };
}

/* ── 완료 처리: 완료는 '검토 통과'여야 한다 — 빈 셀 게이트 + 독립 LLM 무의미값 검수를 모두 통과해야 plan 확정 ── */
async function doCompletePlan() {
  // 락: 이전 자동 검토 2회 실패로 사용자에게 위임된 run은 더 이상 자동 검수/완료를 진행하지 않는다.
  if (state.completeBlocked) {
    return { ok: false, error: "자동 검토가 잠겨 있습니다. 사용자가 미리보기에서 직접 수정 후 다운로드하도록 안내하고, complete_plan을 추가로 호출하지 마세요." };
  }
  // 0) 데이터 모델 가드: 11단계 누락(수업자의도) 등 단계 점프 방지.
  //    DOM 기반 computeMissing은 placeholder/잔존 텍스트로 우회될 수 있으므로
  //    핵심 필드는 state.partialPlan 값을 직접 검사한다.
  const CORE_REQUIRED = ["학습목표", "학습주제", "수업자의도"];
  const coreEmpty = CORE_REQUIRED.filter((k) => !String(state.partialPlan[k] || "").trim());
  if (coreEmpty.length) {
    return { ok: false, error: `다음 항목이 비어 있어 완료할 수 없습니다: ${coreEmpty.join(", ")}. update_plan으로 채운 뒤 다시 complete_plan을 호출하세요. 특히 '수업자의도'는 11단계에서 3~5문장으로 직접 작성해야 합니다(이 단계를 건너뛰지 마세요).` };
  }
  // 1) 빈 셀 게이트
  const missing = computeMissing();
  if (missing.length) {
    return { ok: false, error: `아직 비어 있는 항목이 있어 완료할 수 없습니다: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " 외" : ""}. 이 항목들을 update_plan으로 채운 뒤 다시 complete_plan을 호출하세요.` };
  }
  // 1.5) 시간 합 게이트(기계적, LLM 호출 전) — 도입+전개(활동별 sub 합)+정리 시간 합이 약 40분인지 코드로 검증.
  const tnum = (k) => { const n = parseInt(String(state.partialPlan[k] || "").replace(/[^0-9]/g, ""), 10); return n > 0 ? n : 0; };
  let timeSum = tnum("도입_시간") + tnum("정리_시간");
  const nSub = parseInt(state.partialPlan.전개_num_subs) || 0;
  if (nSub >= 2) { for (let i = 1; i <= nSub; i++) timeSum += tnum(`전개_sub${i}_시간`); }
  else timeSum += tnum("전개_시간");
  if (timeSum > 0 && timeSum !== 40) {
    const delta = timeSum - 40;
    const target = nSub >= 2 ? `전개_sub${nSub}_시간` : "전개_시간";
    const hint = delta > 0
      ? `${delta}분 초과 — 가장 긴 전개 활동(예: ${target}) 시간을 ${delta}분 줄여 update_plan으로 다시 보내세요.`
      : `${-delta}분 부족 — 가장 긴 전개 활동(예: ${target}) 시간을 ${-delta}분 늘려 update_plan으로 다시 보내세요.`;
    return { ok: false, error: `도입·전개·정리 시간 합이 ${timeSum}분입니다(정확히 40분이어야 함). ${hint} 보정 후 다시 complete_plan을 호출하세요.` };
  }
  // 2) 독립 LLM 품질 검수(A=lite → B=preview, 폴백 3.5-flash). 무의미·placeholder 값이 있으면 완료 거부.
  const v = await verifyPlanQuality();
  if (v.unavailable) {
    return { ok: false, error: "지금 AI 자동 검토가 일시적으로 어려워요(검토 서버가 잠시 붐빕니다). 지금 바로 다시 시도하지 말고, 사용자에게 '잠시 후 다시 완료를 시도해 주세요'라고 안내하세요." };
  }
  if (v.issues.length) {
    return { ok: false, error: `검토를 통과하지 못했습니다. 다음 값이 부적절하거나 무의미합니다 — ${v.issues.join(" / ")}. 해당 필드를 update_plan으로 제대로 고친 뒤 다시 complete_plan을 호출하세요. (아직 '완료'라고 안내하지 마세요.)` };
  }
  for (const stage of STAGES) syncParentFromSubKeys(stage);
  state.plan = { ...state.partialPlan };
  scheduleRender();
  updateProgress();   // 진행률 100%
  registerCompletedPlan();   // 검증 통과 → 완성 등록(다운로드 안 해도 집계·비용 잡힘). fire-and-forget.
  return { ok: true };
}

/* present_choices 응답을 messages에 넣고 대화 재개 */
function answerPendingCall(responseObj) {
  if (!state.pendingCall) return;
  const pc = state.pendingCall;
  state.pendingCall = null;
  if (USE_INTER) {
    // present_choices 전에 실행된 function_result들(prevResults) + 이번 선택 결과를 함께 다음 input으로
    const results = (pc.prevResults || []).slice();
    results.push({ type: "function_result", name: pc.name, call_id: pc.callId, result: [{ type: "text", text: JSON.stringify(responseObj) }] });
    state.interInput = results;
  } else {
    state.messages.push({ role: "tool", tool_call_id: pc.tool_call_id, name: pc.name, content: JSON.stringify(responseObj) });
  }
  runConversation();
}

// present_choices의 field 라벨(공백·중점 변형 무관) → 클라가 직접 반영하는 plan 키.
// 단순 반영 가능한 필드만. (성취기준=영역 자동결정, 평가=후속 대화 → LLM이 처리)
const CHOICE_PLAN_KEYS = new Set(["교과역량", "핵심아이디어", "탐구질문", "교수학습모형", "수행과제"]);
const normField = (f) => String(f || "").replace(/[\s·]/g, "");

// 선택 카드 제출 콜백 — present_choices 함수 응답을 구성해 대화 재개
// 선택한 성취기준의 해설·적용 시 고려 사항을 원문 그대로 안내(standard_guidance.json, LLM 무관).
function showStandardGuidance(selected) {
  const guide = (state.datasets && state.datasets.standardGuidance) || {};
  for (const item of selected) {
    const m = String(item).match(/\[(\d+[가-힣]+\d{2}[-–—]\d{2})\]/);
    if (!m) {
      addBot("✏ 직접 재구성하신 성취기준은 교사가 작성한 것이라, 2022 개정 교육과정에 제시된 별도의 해설·적용 시 고려 사항이 없습니다.");
      continue;
    }
    const code = `[${m[1].replace(/[–—]/g, "-")}]`;
    const g = guide[code];
    if (g && g.안내문구) {
      addBot(`📖 **${code}**\n\n${g.안내문구}`);
    } else {
      addBot(`📖 **${code}**: 2022 개정 교육과정에 제시된 해설·적용 시 고려 사항을 찾지 못했습니다.`);
    }
  }
}

function onChoiceSubmit(field, picks, pickedNone, customText) {
  if (!state.pendingCall) return;
  const selected = picks.slice();
  if (customText) selected.push(customText);
  const parts = [];
  if (selected.length) parts.push(selected.join(", "));
  if (pickedNone) parts.push("선택 안 함");
  addUser(`${field}: ${parts.join(" / ") || "—"}`);

  // 성취기준 선택 시: 해설·적용 시 고려 사항을 원문 그대로 자동 안내(클라 직접, LLM 무관)
  if (/성취\s*기준/.test(field) && selected.length) {
    showStandardGuidance(selected);
    // 영역은 데이터 단원에서 클라가 자동 반영해 LLM 영역 환각(예: 'a__1111')을 차단한다.
    // 직접 입력(custom) 성취기준은 단원 매칭이 안 될 수 있어 제외 → 그 경우만 LLM/사용자가 정한다.
    if (!customText) {
      const p = state.partialPlan;
      const lu = findLessonUnit(p.교과, parseInt(p.학년) || 0, parseInt(p.학기) || 0, p.단원 || "", p.출판사 || "");
      if (lu && lu.영역) doUpdatePlan({ fields: [{ key: "영역", value: lu.영역 }] });
    }
  }

  // 단순 데이터 필드는 클라가 직접 미리보기에 반영(doUpdatePlan 위임) — LLM이 update_plan을
  // 빠뜨리고 같은 카드를 다시 띄우는 문제를 차단. (직접입력은 LLM이 다듬어야 해서 제외)
  const key = CHOICE_PLAN_KEYS.has(normField(field)) ? normField(field) : null;
  if (key && selected.length && !customText) {
    const value = selected.join(key === "핵심아이디어" ? "\n" : ", ");
    doUpdatePlan({ fields: [{ key, value }] });
    state.confirmedChoices.add(key);   // 확정 — LLM이 이 항목(또는 앞서 끝낸 다른 항목)을 또 present_choices하면 runConversation이 가드
  } else if (key && customText) {
    state.confirmedChoices.delete(key);  // 직접입력은 LLM이 다듬어 반영·재제시할 수 있으니 그 항목만 가드 해제
  }

  answerPendingCall({
    field,
    selected,
    custom_input: customText || null,
    none: !!pickedNone,
  });
}

/* 검증 통과(complete_plan ok) 시 완성으로 보고 자동 등록 — 다운로드 여부와 무관하게 1회. 토큰·메타·HWPX 파일 저장. */
async function registerCompletedPlan() {
  if (state.registered) return;
  state.registered = true;
  try {
    for (const stage of STAGES) syncParentFromSubKeys(stage);
    const p = state.partialPlan;
    const blob = await buildHWPX(p);
    const fname = `교수학습과정안_${p.교과||""}${p.학년||""}-${p.학기||""}_${String(p.단원||"").replace(/[\\/:*?"<>|]/g,"")}.hwpx`;
    saveLessonPlan(blob, fname, p);
  } catch (e) { state.registered = false; console.warn("완성 등록 실패(다운로드 시 재시도):", e); }
}

/* HWPX 다운로드 — 미리보기 입력값(state.partialPlan) 기준. 등록은 검증 통과 시 자동, 여기선 파일 받기(+미등록이면 등록). */
async function downloadHWPX() {
  const dlBtn = dlBtnEl();
  try {
    dlBtn.disabled = true;
    dlBtn.textContent = "생성 중…";
    // sub-key → 부모 키 재구성 (HWPX 빌드 전)
    for (const stage of STAGES) syncParentFromSubKeys(stage);
    const blob = await buildHWPX(state.partialPlan);
    const url  = URL.createObjectURL(blob);
    const p    = state.partialPlan;
    const fname = `교수학습과정안_${p.교과||""}${p.학년||""}-${p.학기||""}_${String(p.단원||"").replace(/[\\/:*?"<>|]/g,"")}.hwpx`;
    const a = document.createElement("a");
    a.href = url; a.download = fname; a.click();
    if (!state.registered) { state.registered = true; saveLessonPlan(blob, fname, p); }   // 검증 통과 시 이미 등록됐으면 중복 저장 방지
  } catch (e) {
    addBot("HWPX 생성 실패: " + e.message);
  } finally {
    dlBtn.disabled = false;
    dlBtn.textContent = "⬇ HWPX 다운로드";
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// 생성된 HWPX + 메타(학년·학기·교과·단원·성취기준·수업주제)를 서버에 저장. 모델은 서버가 기록.
async function saveLessonPlan(blob, fileName, p) {
  try {
    const fileBase64 = await blobToBase64(blob);
    await fetch("/api/lessonplan/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName, fileBase64, variant: VARIANT, model: FORCE_MODEL,   // /35: variant 분리 저장 + 호환용 단일 model 단가도 전달
        meta: {
          학년: p.학년 || "", 학기: p.학기 || "", 교과: p.교과 || "", 단원: p.단원 || "",
          성취기준: p.성취기준 || "", 수업주제: p.수업주제 || p.학습주제 || "",
          run_id: state.runId,   // ai_usage_log와 cross-check용 — 어드민이 SSoT 재계산 KRW를 보여줌
        },
        usage: { ...state.usage },   // 합계(호환)
        usageByModel: { ...state.usageByModel },   // 모델별 분해 → 서버가 콜 단가로 정확 환산
        verifyUsd: state.verifyUsd || 0,   // 누적 품질 검수 비용 → 서버가 단건 비용에 합산
      }),
    });
  } catch (e) { console.warn("과정안 저장 실패(다운로드는 완료):", e); }
}

/* 검증 버튼 — 전체 수업 흐름·빈 칸·무의미한 값을 LLM이 검토해 채팅으로 알려준다.
   빈 칸은 computeMissing으로 확정 전달하고, 흐름·무의미값은 LLM이 미리보기 상태를 보고 판단. */
// 외부 검토자(독립 LLM) 시스템 프롬프트 — 대화 맥락과 무관하게 plan만 객관 검토(자기 편향 제거).
const REVIEW_SYS =
  "너는 초등 교수·학습 과정안을 처음 보는 외부 검토자다. 2022 개정 교육과정에 정통한 수석교사·장학사의 시선으로, 작성한 교사에게 도움이 되도록 객관적이고 친근한 존댓말로 검토 의견을 준다.\n" +
  "[검토 관점] ① 수업 흐름의 정합성 — 성취기준 ↔ 핵심 아이디어·탐구 질문 ↔ 학습목표 ↔ 평가 ↔ 도입/전개/정리 활동이 일관되게 이어지는가. ② 내용의 충실성과 교육적 적절성 — 차시 수준에 맞고 학생 활동이 구체적인가. ③ 평가가 성취기준 도달을 잘 확인하고 피드백이 실질적인가.\n" +
  "[방식] 먼저 잘된 점을 1~2가지 구체적으로 짚어 칭찬하고, 이어서 개선하면 좋을 점을 1~3가지 '왜 그런지'와 '이렇게 해 보면 좋겠다'는 대안을 곁들여 제안한다. 단정적 채점이 아니라 동료 교사의 조언처럼. 전체 3~5문단 또는 불릿으로 간결하게.\n" +
  "[이 양식의 약속] '피드백' 항목은 이 과정안에서 의도적으로 '하' 수준(기초만 도달) 학생을 다음 단계로 끌어올리기 위한 교사의 지원 방안만 한 문장으로 적는 양식이다(수준 표시 없이 지원 내용만). 따라서 '상·중 수준에 대한 피드백이 없다/모든 수준의 피드백을 적어야 한다'고 지적하거나 추가하라고 권하지 마라. 피드백은 그 '하' 지원 방안이 구체적이고 실효적인지만 본다.\n" +
  "[금지] 내부 데이터 필드명·키(예: 전개_sub1_교사활동, 평가1_요소)·시스템 동작·HWPX·다운로드 같은 기술적·개발자스러운 표현은 절대 쓰지 마라. 빈 칸 지적은 하지 마라(별도로 안내됨). 오직 과정안에 적힌 교육 내용만 교육과정 관점에서 본다.\n" +
  "[출력] 반드시 {\"feedback\":\"마크다운 텍스트\"} 형식의 JSON만 출력한다.";

// 검토용 독립 LLM 호출 — 3.5-flash → 3-flash-preview → 2.5-flash 순으로 폴백, 모두 실패하면 unavailable.
async function runExternalReview() {
  const fields = {};
  for (const [k, v] of Object.entries(state.partialPlan)) {
    if (v == null || String(v).trim() === "" || ADMIN_FIELDS.includes(k) || /_num/.test(k)) continue;
    fields[k] = v;
  }
  const reqBody = {
    messages: [{ role: "system", content: REVIEW_SYS }, { role: "user", content: "다음 교수·학습 과정안을 검토해 주세요(JSON):\n" + JSON.stringify(fields) }],
    json: true, maxTokens: 1500, stage: 100, runId: state.runId,
  };
  const tryModels = ["gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3.5-flash"];
  for (const model of tryModels) {
    try {
      const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...reqBody, model, variant: VARIANT }) });
      if (res.ok) {
        const data = await res.json();
        if (data && data.feedback) return { feedback: String(data.feedback) };
      }
    } catch (e) { /* 다음 모델로 폴백 */ }
  }
  return { unavailable: true };
}

async function reviewPlan() {
  if (state.loading) return;
  const missing = computeMissing();
  addUser("🔎 지금까지 작성한 과정안을 검토해 주세요");
  // 빈 칸은 클라이언트가 기계적으로 직접 안내(LLM 누락·환각 없이 확정).
  if (missing.length) {
    const labels = missing.slice(0, 14).map(prettyField);
    addBot(
      `먼저, 미리보기에 **아직 비어 있는 칸이 ${missing.length}곳** 있어요. 이 부분을 채우면 더 완성도 높은 과정안이 됩니다.\n` +
      labels.map((l) => `• ${l}`).join("\n") +
      (missing.length > 14 ? `\n• …외 ${missing.length - 14}곳` : "") +
      `\n\n채팅으로 내용을 알려 주시면 바로 반영해 드릴게요. 아래에 외부 검토자의 의견도 이어서 알려 드릴게요.`
    );
  }
  // 외부 검토자(독립 LLM) — 대화 맥락에 끌리지 않게 plan만 객관 검토. 결과는 안내만(자동 수정은 하지 않음).
  state.loading = true; setComposerEnabled(false);
  let loader = addLoader();
  setLoaderText(loader, "외부 검토자가 살펴보는 중…");
  try {
    const review = await runExternalReview();
    removeLoader(loader); loader = null;
    if (review.unavailable) addBot("지금 검토 도우미가 일시적으로 붐벼요. 잠시 후 🔎 검증을 다시 눌러 주세요.");
    else { addBot(review.feedback); state.reviewNote = review.feedback; }   // 교사가 이 의견을 보고 다음에 말하면 메인 대화 맥락에 함께 전달
  } catch (e) {
    addBot("검토 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
  } finally {
    if (loader) removeLoader(loader);
    state.loading = false; setComposerEnabled(true);
  }
}

// 미입력 항목 계산 — 실제 데이터 구조(평가 인덱스 키·전개 sub 키) 인식.
// 행정 정보(차시·교과서쪽수·대상학급·일시)는 수업자가 다운로드 전 직접 입력하므로 경고 제외.
// 미리보기 키 → 사람이 읽는 라벨(빈 칸 안내용 — 내부 키 노출 방지)
function prettyField(k) {
  const s = String(k)
    .replace(/^평가(\d+)_/, "평가$1 ")
    .replace(/^(도입|전개|정리)_sub(\d+)_/, "$1 활동$2 ")
    .replace(/^(도입|전개|정리)_/, "$1 ")
    .replace(/_/g, " ")
    .replace("자료유의평가", "자료·유의점·평가")
    .replace("수준상", "성취수준 상").replace("수준중", "성취수준 중").replace("수준하", "성취수준 하")
    .replace("교사활동", "교사 활동").replace("학생활동", "학생 활동").replace("학습형태", "학습 형태")
    .replace("학습목표", "학습 목표").replace("학습주제", "학습 주제").replace("수업자의도", "수업자 의도")
    .replace("수행과제", "수행 과제").replace("교과역량", "교과 역량").replace("핵심아이디어", "핵심 아이디어")
    .replace("탐구질문", "탐구 질문").replace("교수학습모형", "교수·학습 모형");
  return s.trim();
}

// 기계적 빈 칸 검출: 미리보기에 '실제로 렌더된' 셀([data-key]) 중 빈 것.
// state 메타(평가_num·num_subs)에 의존하지 않으므로, 미리보기에 보이는 빈 칸/미반영 칸을 정확히 잡는다.
function computeMissing() {
  const root = previewEl();
  if (!root) return [];
  renderPlanPreview();   // 최신 state로 렌더해 DOM과 일치시킨 뒤 검사
  const seen = new Set();
  const missing = [];
  for (const c of root.querySelectorAll("[data-key]")) {
    const key = c.dataset.key;
    if (seen.has(key)) continue; seen.add(key);
    if (ADMIN_FIELDS.includes(key)) continue;   // 행정(차시·쪽수·학급·일시) — 수업자 직접 입력
    if (/_단계$/.test(key)) continue;           // 모형 단계명 — 선택 입력
    if (c.textContent.trim() === "") missing.push(key);
  }
  return missing;
}


/* ====================== HWPX 생성 ====================== */

function xmlEscape(s) {
  return String(s ?? "").replace(/[&<>]/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[m]
  );
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeMultiline(text) {
  let t = String(text || "");
  if (!t) return t;
  t = t.replace(/\s*([◉◯●○◦∘])\s*/g, "\n$1 ");
  t = t.replace(/\s*(㉶|㉤|㉧|㉽)\s*/g, "\n$1 ");
  t = t.replace(/(?:^|\s)(자료\s*:|유의(?:점)?\s*:|평가\s*:)/g, "\n$1");
  t = t.replace(/(?:^|\s)-\s+(?=\S)/g, "\n- ");
  // \n\n (활동 구분용 빈 줄) 은 보존. 3줄 이상의 과다 줄바꿈만 2줄로 압축.
  t = t.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  return t;
}

function applyPlaceholder(xml, key, value) {
  const text  = normalizeMultiline(value);
  const lines = text.split("\n");

  if (lines.length === 1) {
    return xml.replace(new RegExp(escapeRegex(key), "g"), xmlEscape(text));
  }

  const escapedKey = escapeRegex(key);
  const pPattern = new RegExp(
    `<hp:p\\b[^>]*>(?:(?!<hp:p\\b)[\\s\\S])*?${escapedKey}(?:(?!<hp:p\\b)[\\s\\S])*?</hp:p>`, "g"
  );
  const replaced = xml.replace(pPattern, (match) =>
    lines.map((line) => match.replace(key, xmlEscape(line))).join("")
  );
  if (replaced === xml) {
    console.warn(`[applyPlaceholder] no innermost <hp:p> match for ${key}`);
    return xml.replace(new RegExp(escapedKey, "g"), xmlEscape(text.replace(/\n/g, " ")));
  }
  return replaced;
}

// 자료유의평가 텍스트를 자료/유의점/평가 항목으로 분리.
// 라벨이 없는 첫 줄은 자료로 간주. 한 항목이 여러 줄이면 공백으로 합쳐 한 hp:p에 박는다.
function parseSourcesNotes(text) {
  let t = String(text || "").replace(/\\n/g, "\n");
  // 한 줄에 (자)…(유)…(평)…이 붙어 있으면 각 라벨 앞에서 줄바꿈
  t = t.replace(/\s*([(（]\s*[자유평]\s*[)）])/g, "\n$1").replace(/^\n+/, "");
  if (!t.trim()) return [];

  const result = { 자료: "", 유의점: "", 평가: "" };
  const LABEL = { 자: "자료", 유: "유의점", 평: "평가" };
  let current = null;
  for (const rawLine of t.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let m;
    // 새 형식 (자)/(유)/(평) — 콜론 유무 무관, 라벨 뒤 내용 붙여쓰기
    if ((m = line.match(/^[(（]\s*([자유평])\s*[)）]\s*[:：]?\s*(.*)$/))) {
      current = LABEL[m[1]]; result[current] = m[2];
    // 구 형식 호환: ㉶ 자료: / 유의점: / 평가:
    } else if ((m = line.match(/^(?:㉶\s*)?자료\s*[:：]\s*(.*)$/))) {
      current = "자료"; result.자료 = m[1];
    } else if ((m = line.match(/^유의(?:점)?\s*[:：]\s*(.*)$/))) {
      current = "유의점"; result.유의점 = m[1];
    } else if ((m = line.match(/^평가\s*[:：]\s*(.*)$/))) {
      current = "평가"; result.평가 = m[1];
    } else if (current) {
      result[current] += (result[current] ? " " : "") + line;
    } else {
      current = "자료";
      result.자료 = line.replace(/^㉶\s*/, "");
    }
  }
  return ["자료", "유의점", "평가"]
    .map((type) => ({ type, value: result[type].trim() }))
    .filter((item) => item.value);
}

// 양식의 hp:compose 패턴 — 한컴 약물기호 컨트롤 노드. charPrCnt=10, 모든 charPr를
// 4294967295(fallback)로 두면 둘러싸인 hp:run의 charPrIDRef를 상속해 안전.
function composeNode(text) {
  const filler = '<hp:charPr prIDRef="4294967295"/>'.repeat(10);
  return `<hp:compose circleType="SHAPE_CIRCLE" charSz="-3" composeType="SPREAD" charPrCnt="10" composeText="${text}">${filler}</hp:compose>`;
}

// 자료유의평가 placeholder 전용. 자료=㉶ 텍스트, 유의점=hp:compose("유"), 평가=hp:compose("평").
// placeholder hp:p를 항목 수만큼 복제하고, 각 복제본의 첫 hp:t를 변형한다.
function applyComposePlaceholder(xml, key, value) {
  const items = parseSourcesNotes(value);
  if (items.length === 0) {
    return applyPlaceholder(xml, key, "");
  }

  const escapedKey = escapeRegex(key);
  const pPattern = new RegExp(
    `<hp:p\\b[^>]*>(?:(?!<hp:p\\b)[\\s\\S])*?${escapedKey}(?:(?!<hp:p\\b)[\\s\\S])*?</hp:p>`,
    "g"
  );

  const replaced = xml.replace(pPattern, (match) => {
    return items.map((item) => {
      if (item.type === "자료") {
        // value에 이미 ㉶가 있으면 제거(중복 "㉶ ㉶" 방지)
        const v = item.value.replace(/㉶/g, "").trim();
        return match.replace(new RegExp(escapedKey, "g"), xmlEscape("㉶ " + v));
      }
      const compose = composeNode(item.type === "유의점" ? "유" : "평");
      const tPattern = new RegExp(
        `(<hp:run\\b[^>]*>)((?:(?!<hp:t\\b)[\\s\\S])*?)<hp:t\\b([^>]*)>[\\s\\S]*?</hp:t>`
      );
      return match.replace(tPattern,
        `$1$2${compose}<hp:t$3> ${xmlEscape(item.value)}</hp:t>`
      );
    }).join("");
  });

  if (replaced === xml) {
    console.warn(`[applyComposePlaceholder] no match for ${key}; falling back to inline`);
    return applyPlaceholder(xml, key, items.map((i) => `${i.type}: ${i.value}`).join("\n"));
  }
  return replaced;
}

async function buildHWPX(plan) {
  // 전개 활동 수에 따라 템플릿 선택: 2~5개 → template{N}.hwpx, 1개·6개+ → 기본
  const numSubs  = parseInt(plan.전개_num_subs) || 1;
  const useMulti = numSubs >= 2 && numSubs <= 5;
  const tmplName = useMulti ? `template${numSubs}.hwpx` : "template.hwpx";

  const resp = await fetch(`./data/${tmplName}?v=17`);
  if (!resp.ok) throw new Error(`${tmplName} 로드 실패`);
  const zip = await JSZip.loadAsync(await resp.arrayBuffer());
  const sectionFile = zip.file("Contents/section0.xml");
  if (!sectionFile) throw new Error("section0.xml 없음");
  let xml = await sectionFile.async("string");

  // 교사활동 칸 맨 앞 활동 헤더 처리.
  // 전개 다중 활동(idx 有): "◉ 활동 N. 활동명"을 본문 위에 항상 부착(본문이 ◉로 시작해도 활동명 누락 방지).
  // 도입·정리(idx 無, 단일 활동): 본문이 있으면 본문만 둔다(활동명이 본문 첫 줄과 겹쳐 중복 출력되는 것 방지).
  //   본문이 비었을 때만 활동명을 ◉ 헤더로 넣는다.
  function combineTeacher(name, body, idx) {
    body = String(body || "");
    name = String(name || "").trim().replace(/^활동\s*\d+\.?\s*/, "");   // 중복 번호 접두 제거
    if (idx) {
      const head = `활동 ${idx}.${name ? " " + name : ""}`;
      return body ? `◉ ${head}\n${body}` : `◉ ${head}`;
    }
    return body || (name ? `◉ ${name}` : "");
  }

  const map = {
    "{{교과}}": plan.교과, "{{단원}}": plan.단원, "{{대상학급}}": plan.대상학급,
    "{{일시}}": plan.일시, "{{차시}}": plan.차시, "{{교과서쪽수}}": plan.교과서쪽수,
    "{{교수학습모형}}": plan.교수학습모형, "{{교과역량}}": plan.교과역량,
    "{{영역}}": plan.영역, "{{핵심아이디어}}": plan.핵심아이디어,
    "{{성취기준}}": plan.성취기준, "{{탐구질문}}": plan.탐구질문,
    "{{학습목표}}": plan.학습목표, "{{학습주제}}": plan.학습주제, "{{수행과제}}": plan.수행과제,
    // 평가는 인덱스 키(평가1_*)가 정본(doUpdatePlan이 정규화) — HWPX 템플릿은 평가 행 1개라 첫 범주로 채운다.
    "{{수업자의도}}": plan.수업자의도, "{{평가범주}}": plan.평가1_범주,
    "{{평가방법}}": plan.평가1_방법, "{{평가요소}}": plan.평가1_요소,
    "{{평가수준상}}": plan.평가1_수준상, "{{평가수준중}}": plan.평가1_수준중,
    "{{평가수준하}}": plan.평가1_수준하, "{{피드백}}": plan.평가1_피드백,
    "{{도입_단계}}": plan.도입_단계 || "",
    "{{도입_학습형태}}": plan.도입_학습형태 || "전체", "{{도입_활동명}}": plan.도입_활동명,
    "{{도입_교사활동}}": combineTeacher(plan.도입_활동명, plan.도입_교사활동),
    "{{도입_학생활동}}": plan.도입_학생활동, "{{도입_시간}}": plan.도입_시간,
    "{{정리_단계}}": plan.정리_단계 || "",
    "{{정리_학습형태}}": plan.정리_학습형태 || "전체",
    "{{정리_교사활동}}": combineTeacher(plan.정리_활동명, plan.정리_교사활동),
    "{{정리_학생활동}}": plan.정리_학생활동, "{{정리_시간}}": plan.정리_시간,
    // 자료유의평가(도입·정리·전개)는 hp:compose 삽입 필요 — map 처리 후 별도 호출
  };

  // 전개: 멀티 템플릿이면 활동별 키, 아니면 통합 키
  // 명명 규칙: 학습형태·시간은 전개{i}_..., 교사·학생활동은 전개_...{i}
  if (useMulti) {
    for (let i = 1; i <= numSubs; i++) {
      map[`{{전개${i}_단계}}`]     = plan[`전개_sub${i}_단계`] || "";
      map[`{{전개${i}_학습형태}}`] = plan[`전개_sub${i}_학습형태`] || "전체";
      map[`{{전개_교사활동${i}}}`] = combineTeacher(plan[`전개_sub${i}_활동명`], plan[`전개_sub${i}_교사활동`], i);
      map[`{{전개_학생활동${i}}}`] = plan[`전개_sub${i}_학생활동`];
      map[`{{전개${i}_시간}}`]     = plan[`전개_sub${i}_시간`];
    }
  } else {
    map["{{전개_단계}}"]     = plan.전개_단계 || "";
    map["{{전개_학습형태}}"] = plan.전개_학습형태 || "전체";
    map["{{전개_교사활동}}"] = combineTeacher(plan.전개_활동명, plan.전개_교사활동);
    map["{{전개_학생활동}}"] = plan.전개_학생활동;
    map["{{전개_시간}}"]     = plan.전개_시간;
  }
  for (const [k, v] of Object.entries(map)) xml = applyPlaceholder(xml, k, v);

  // 자료·유의점·평가 (hp:compose)
  xml = applyComposePlaceholder(xml, "{{도입_자료유의평가}}", plan.도입_자료유의평가);
  xml = applyComposePlaceholder(xml, "{{정리_자료유의평가}}", plan.정리_자료유의평가);
  if (useMulti) {
    for (let i = 1; i <= numSubs; i++) {
      xml = applyComposePlaceholder(xml, `{{전개${i}_자료유의평가}}`, plan[`전개_sub${i}_자료유의평가`]);
    }
  } else {
    xml = applyComposePlaceholder(xml, "{{전개_자료유의평가}}", plan.전개_자료유의평가);
  }

  // 텍스트 치환으로 길이가 바뀌면 linesegarray(레이아웃 캐시)의 textpos/vertpos가 무효화되어
  // 한글이 긴 텍스트 셀의 레이아웃을 못 잡는다(표가 렌더 안 됨). 제거하면 한글이 열 때 재계산.
  xml = xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "").replace(/<hp:linesegarray\s*\/>/g, "");

  zip.file("Contents/section0.xml", xml);
  return zip.generateAsync({ type: "blob", mimeType: "application/hwp+zip", compression: "DEFLATE" });
}

/* ====================== 시작 ====================== */

// 학년군별 노출 교과 (2022 개정 초등 편제)
const SUBJECTS_BY_GRADE = {
  low:  ["국어", "수학", "통합교과"],                                                  // 1~2학년 (바/슬/즐을 통합교과 단일로)
  mid:  ["국어", "도덕", "사회", "수학", "과학", "체육", "음악", "미술", "영어"],          // 3~4학년 (실과 없음)
  high: ["국어", "도덕", "사회", "수학", "과학", "실과", "체육", "음악", "미술", "영어"],  // 5~6학년
};
function subjectsForGrade(gradeStr) {
  const g = parseInt(gradeStr) || 3;
  return g <= 2 ? SUBJECTS_BY_GRADE.low : g <= 4 ? SUBJECTS_BY_GRADE.mid : SUBJECTS_BY_GRADE.high;
}
// 선택된 학년에 맞춰 교과 드롭다운 옵션을 다시 채운다(학년을 바꿔도 같은 교과면 선택 유지).
function populateSubjects() {
  const sel = document.getElementById("sfSubject");
  if (!sel) return;
  const prev = sel.value;
  const list = subjectsForGrade(document.getElementById("sfGrade").value);
  sel.replaceChildren(...list.map((s) => { const o = document.createElement("option"); o.textContent = s; return o; }));
  if (list.includes(prev)) sel.value = prev;
}

// 출판사·단원 드롭다운 (unit_contents 기반)
const SF_OTHER = "__other__";    // 목록에 없는 출판사 → 단원 직접 입력
const SF_CUSTOM = "__custom__";  // 단원 직접 입력(프로젝트·교사 설정 단원)

function populatePublishers() {
  const sel = document.getElementById("sfPublisher");
  if (!sel) return;
  const g = parseInt(document.getElementById("sfGrade").value) || 0;
  const sem = parseInt(document.getElementById("sfSemester").value) || 0;
  const subj = document.getElementById("sfSubject").value;
  const lu = (state.datasets && state.datasets.lessonUnits) || [];
  // 현재 학년·학기·교과에 데이터가 있는 출판사만 노출
  const pubs = [...new Set(lu.filter((u) =>
    u.과목 === subj && u.학년 === g && (u.학기 == null || u.학기 === sem)
  ).map((u) => u.출판사).filter(Boolean))].sort();
  const opts = [...pubs.map((p) => ({ v: p, t: p })), { v: SF_OTHER, t: "기타(목록에 없는 출판사)" }];
  sel.replaceChildren(...opts.map((o) => { const e = document.createElement("option"); e.value = o.v; e.textContent = o.t; return e; }));
  // 학년·학기·교과가 바뀌면 출판사는 이전 선택을 유지하지 않고 항상 최상단 선택지로 초기화
  sel.value = opts[0].v;
}

function currentPublisher() {
  const sel = document.getElementById("sfPublisher");
  return sel && sel.value !== SF_OTHER ? sel.value : "";
}

function currentUnit() {
  const sel = document.getElementById("sfUnitSel");
  const txt = document.getElementById("sfUnit");
  if (!sel || sel.classList.contains("hidden") || sel.value === SF_CUSTOM) return txt.value.trim();
  return sel.value;
}

// 출판사·학년·학기·교과로 단원 드롭다운을 채운다. '기타' 출판사거나 데이터가 없으면 단원 직접 입력(text).
// 단원 표시 순서 = lesson_units.json 저장 순서(build_lesson_units.py가 교과서 목차 순서로 정렬).
function populateUnits() {
  const sel = document.getElementById("sfUnitSel");
  const txt = document.getElementById("sfUnit");
  if (!sel) return;
  const g = parseInt(document.getElementById("sfGrade").value) || 0;
  const sem = parseInt(document.getElementById("sfSemester").value) || 0;
  const subj = document.getElementById("sfSubject").value;
  const pub = document.getElementById("sfPublisher").value;
  const lu = (state.datasets && state.datasets.lessonUnits) || [];
  // 데이터 출판사 선택분 / '기타'면 출판사 없는 단원(도덕·통합 등)
  const units = [...new Set(lu.filter((u) =>
    u.과목 === subj && u.학년 === g && (u.학기 == null || u.학기 === sem) &&
    (pub === SF_OTHER ? !u.출판사 : u.출판사 === pub)
  ).map((u) => u.단원명))];
  if (!units.length) {
    sel.classList.add("hidden");
    txt.classList.remove("hidden");
  } else {
    const opts = [...units.map((u) => ({ v: u, t: u })), { v: SF_CUSTOM, t: "✏ 직접 입력 (프로젝트·교사 설정 단원)" }];
    sel.replaceChildren(...opts.map((o) => { const e = document.createElement("option"); e.value = o.v; e.textContent = o.t; return e; }));
    sel.classList.remove("hidden");
    toggleUnitInput();
  }
}

function toggleUnitInput() {
  const sel = document.getElementById("sfUnitSel");
  const txt = document.getElementById("sfUnit");
  if (!sel) return;
  if (sel.classList.contains("hidden")) { txt.classList.remove("hidden"); return; }
  txt.classList.toggle("hidden", sel.value !== SF_CUSTOM);
}

// 시작 화면(기본 정보 입력)으로 돌아가 새 세션을 준비한다.
// 헤더 버튼 토글: 시작 화면=「관리자」, 작업 공간=「새로 시작」
function setHeaderButtons(welcome) {
  const a = document.getElementById("adminBtn");
  const r = document.getElementById("resetBtn");
  if (a) a.classList.toggle("hidden", !welcome);
  if (r) r.classList.toggle("hidden", welcome);
}

function showWelcome() {
  clearSavedState();
  state.messages  = [{ role: "system", content: SYSTEM_PROMPT }];
  state.plan      = null;
  state.partialPlan = {};
  state.subEditedStages = new Set();
  state.pendingCall = null;
  state.callSeq = 0;
  state.usage = { calls: 0, prompt: 0, output: 0, cached: 0 };
  state.usageByModel = {};
  state.verifyUsd = 0;
  state.reviewNote = null;
  state.completeFails = 0;
  state.completeBlocked = false;
  state.regenCount = {};
  state.confirmedChoices = new Set();
  state.registered = false;   // 새 세션 — 검증 통과 시 다시 등록 가능
  state.interactionId = null;
  state.interInput = null;
  state.runId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : ("r" + Date.now() + "-" + Math.random().toString(36).slice(2, 10));
  chatEl().innerHTML = "";
  clearQuick();
  setComposerEnabled(false);
  renderPlanPreview();
  updateProgress();
  workspaceEl().classList.add("hidden");
  welcomeEl().classList.remove("hidden");
  setHeaderButtons(true);
  const form = document.getElementById("startForm");
  if (form) {
    form.reset();
    populateSubjects(); populatePublishers(); populateUnits();
    document.getElementById("sfTopic").focus();
  }
}

// 시작 폼 제출 → 확정 기본 정보를 미리보기에 반영하고 대화를 시작한다.
async function submitStart() {
  const grade     = document.getElementById("sfGrade").value;
  const sem       = document.getElementById("sfSemester").value;
  const subject   = document.getElementById("sfSubject").value;
  const publisher = currentPublisher();
  const unit      = currentUnit();
  const topic     = document.getElementById("sfTopic").value.trim();
  if (!unit) { document.getElementById("sfUnit").classList.remove("hidden"); document.getElementById("sfUnit").focus(); return; }
  if (!topic) { document.getElementById("sfTopic").focus(); return; }

  // 확정 정보를 미리보기·HWPX에 바로 반영
  state.partialPlan.학년 = grade;
  state.partialPlan.학기 = sem;
  state.partialPlan.교과 = subject;
  state.partialPlan.단원 = unit;
  state.partialPlan.수업주제 = topic;   // 시작 폼의 차시 주제(저장 메타·미렌더 필드)
  if (publisher) state.partialPlan.출판사 = publisher;

  welcomeEl().classList.add("hidden");
  workspaceEl().classList.remove("hidden");
  setHeaderButtons(false);
  renderPlanPreview();
  updateProgress();
  setComposerEnabled(true);

  const pubTxt = publisher ? ` (${publisher} 교과서)` : "";
  const firstMsg = `${grade} ${sem} ${subject}${pubTxt} '${unit}' 단원으로 수업을 설계하려고 해요.\n\n[이번 차시에 대한 제 생각]\n${topic}`;
  // 단원이 확정됐으니 클라가 미리 RAG(성취기준·단원학습내용)를 조회해 모델 맥락에만 공급한다(화면 user 버블엔 안 보임).
  // 2.5-flash가 특히 통합교과에서 find_standards를 빠뜨려 "성취기준이 없다"고 하는 문제를, 데이터를 손에 쥐여 주어 해소.
  const lu0 = findLessonUnit(subject, parseInt(grade) || 0, parseInt(sem) || 0, unit, publisher);
  let hidden = "";
  if (lu0) {
    const 차시 = Array.isArray(lu0.단원학습내용) ? lu0.단원학습내용 : [];
    const 성취 = Array.isArray(lu0.성취기준) ? lu0.성취기준 : [];
    const 핵심 = lu0.영역 ? (ragListCoreIdeas({ 교과: subject, 영역: lu0.영역 }).core_ideas || []) : [];
    if (차시.length || 성취.length || 핵심.length) {
      hidden = `\n\n[시스템이 교육과정 데이터에서 미리 조회한 '${unit}' 단원 정보 — 화면에는 표시되지 않습니다. 아래 데이터를 근거로 진행하고 지어내지 마세요.]`;
      if (차시.length) hidden += `\n· 교과서 차시 학습 내용 목록(참고용 — present_choices 카드로 만들지 말고, 교사가 물으면 텍스트로만 안내. 교사가 자유롭게 재구성·입력합니다): ` + 차시.map((c, i) => `${i + 1}) ${c}`).join("  ");
      if (성취.length) hidden += `\n· 이 단원의 성취기준(코드 포함 원문): ` + 성취.join("  /  ") + `\n  → 통합교과를 포함해 이 단원에는 성취기준이 분명히 있습니다. 단원이 이미 확정됐으니 차시 학습 내용을 먼저 캐묻지 말고, "성취기준이 없다/관련 교과를 통합한다"고 하거나 교과를 먼저 고르라고 되묻지도 말고, 바로 위 성취기준을 present_choices(multi=true, allow_custom=true, 코드 포함 원문 그대로)로 제시해 고르게 하세요.`;
      if (핵심.length) hidden += `\n· 이 단원(영역 '${lu0.영역}')의 핵심 아이디어(2022 개정 교육과정 원문): ` + 핵심.join("  /  ") + `\n  → 통합교과를 포함해 이 단원에는 핵심 아이디어가 분명히 있습니다. "핵심 아이디어가 없다"고 하지 말고, 성취기준 선택 뒤 핵심 아이디어 단계에서 위 항목을 present_choices(multi=true, allow_custom=true)로 제시해 고르게 하세요. **이 핵심 아이디어는 교육과정 원문이므로 intro를 "2022 개정 교육과정에 제시된 핵심 아이디어 중에서 고르시거나 추가할 내용을 직접 입력해 주세요"처럼 쓰고, "(차시 맥락에 맞게) 제안한"이라고 하지 마세요.**`;
    }
  }
  // 시작 화면을 넘어 설계를 시작 — 세션 카운트(HWPX 미완료여도 집계). fire-and-forget.
  fetch("/api/lessonplan/session-start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variant: VARIANT }) }).catch(() => {});
  await handleUserInput(firstMsg, hidden);
}

document.addEventListener("DOMContentLoaded", async () => {
  if (typeof marked !== "undefined") marked.setOptions({ breaks: true, gfm: true });
  try { await loadDatasets(); }
  catch (e) { addBot("데이터 로드 실패: " + e.message); return; }
  initPreviewEvents();
  dlBtnEl().addEventListener("click", downloadHWPX);
  document.getElementById("reviewBtn").addEventListener("click", reviewPlan);
  if (loadSavedState()) {
    welcomeEl().classList.add("hidden");
    workspaceEl().classList.remove("hidden");
    setHeaderButtons(false);
    await restoreSession();
  } else {
    showWelcome();
  }

  document.getElementById("resetBtn").addEventListener("click", () => showWelcome());
  document.getElementById("adminBtn").addEventListener("click", () => { location.href = "admin35.html"; });
  document.getElementById("startForm").addEventListener("submit", (e) => { e.preventDefault(); submitStart(); });
  document.getElementById("sfGrade").addEventListener("change", () => { populateSubjects(); populatePublishers(); populateUnits(); });
  document.getElementById("sfSubject").addEventListener("change", () => { populatePublishers(); populateUnits(); });
  document.getElementById("sfSemester").addEventListener("change", () => { populatePublishers(); populateUnits(); });
  document.getElementById("sfPublisher").addEventListener("change", populateUnits);
  document.getElementById("sfUnitSel").addEventListener("change", toggleUnitInput);
  populateSubjects(); populatePublishers(); populateUnits();

  function autoResizeInput() {
    const el = inputEl();
    el.style.height = "auto";
    el.style.height = Math.min(160, Math.max(38, el.scrollHeight)) + "px";
  }

  sendBtnEl().addEventListener("click", () => {
    const v = inputEl().value;
    inputEl().value = "";
    autoResizeInput();
    handleUserInput(v);
  });
  inputEl().addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtnEl().click(); }
  });
  inputEl().addEventListener("input", autoResizeInput);
});
