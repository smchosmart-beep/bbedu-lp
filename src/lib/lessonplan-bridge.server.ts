// Gemini-shape <-> OpenAI-compatible bridge for legacy /api/lessonplan/chat
// The legacy client sends Gemini-style { messages, tools, model } and expects
// { content, functionCalls, usage }. We adapt it to Lovable AI Gateway.

type AnyObj = Record<string, unknown>;

const VENDOR_PREFIX_MAP: Record<string, string> = {
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
  "gemini-2.5-pro": "google/gemini-2.5-pro",
  "gemini-2.5-flash": "google/gemini-2.5-flash",
  "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite",
};

export function resolveModelId(raw?: string | null): string {
  if (!raw) return "google/gemini-3-flash-preview";
  if (raw.includes("/")) return raw;
  return VENDOR_PREFIX_MAP[raw] ?? `google/${raw}`;
}

// === 비용 최적화: 2-Tier 라우팅 ===
export const PRIMARY_MODEL = "google/gemini-3.5-flash";
export const CHEAP_MODEL = "google/gemini-3-flash-preview";
export const VERIFY_A_MODEL = "google/gemini-2.5-flash-lite";
export const VERIFY_B_MODEL = "google/gemini-3-flash-preview";

// PRIMARY 라우팅 단계: 5(탐구질문), 6(평가 sticky), 7(학습목표), 9(전개 세트), 10(본문), 11(수업자의도/검토)
const PRIMARY_STAGES = new Set([5, 6, 7, 9, 10, 11]);

export type Tier = "PRIMARY" | "CHEAP";

// 롤백 스위치 — true 로 바꾸면 전부 PRIMARY
const FORCE_PRIMARY = false;

export function pickTier(stage: number | null | undefined): Tier {
  if (FORCE_PRIMARY) return "PRIMARY";
  if (!stage || !Number.isFinite(stage)) return "PRIMARY"; // SSoT 누락 → PRIMARY fallback
  return PRIMARY_STAGES.has(stage) ? "PRIMARY" : "CHEAP";
}

export function pickModelForTier(tier: Tier, requested?: string | null): string {
  if (tier === "PRIMARY") return requested ? resolveModelId(requested) : PRIMARY_MODEL;
  return CHEAP_MODEL;
}

// T1: 최근 메시지에서 stage 와 후속 단계 필드명 충돌 감지 → PRIMARY 강등
export function hasStageConflict(stage: number | null | undefined, messages: unknown): boolean {
  if (!stage || !Array.isArray(messages)) return false;
  const lastFew = messages.slice(-3);
  const blob = lastFew
    .map((m) => {
      const mm = m as AnyObj;
      return typeof mm.content === "string" ? (mm.content as string) : JSON.stringify(mm.content ?? "");
    })
    .join("\n");
  if (stage <= 4 && /(평가\d+_|학습목표|전개_sub\d+_|수업자의도)/.test(blob)) return true;
  if (stage <= 5 && /(수업자의도|전개_sub\d+_(교사활동|학생활동))/.test(blob)) return true;
  return false;
}

// T2: tier 별 출력 토큰 / 온도
export function tierConfig(tier: Tier) {
  if (tier === "PRIMARY") return { temperature: 0.7, maxOutputTokens: 16000 };
  return { temperature: 0.5, maxOutputTokens: 8000 };
}

// MALFORMED / JSON_PARSE 신호: 다음 시도는 PRIMARY 로
export function isMalformedSignal(message: string): boolean {
  return /MALFORMED_FUNCTION_CALL|JSON_PARSE|JSON\s*parse\s*failed|invalid\s+function\s+call/i.test(
    message || "",
  );
}

// Convert Gemini tools [{functionDeclarations:[...]}] to OpenAI tools
export function geminiToolsToOpenAI(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: unknown[] = [];
  for (const t of tools) {
    const decls = (t as AnyObj)?.functionDeclarations;
    if (Array.isArray(decls)) {
      for (const d of decls) {
        const dd = d as AnyObj;
        out.push({
          type: "function",
          function: {
            name: dd.name,
            description: dd.description ?? "",
            parameters: dd.parameters ?? { type: "object", properties: {} },
          },
        });
      }
    }
  }
  return out.length ? out : undefined;
}

// Convert legacy client messages to OpenAI chat messages.
// Strategy mirrors original Firebase fn: collapse tool history to plain text
// to dodge tool_call_id pairing requirements and keep model focused.
export function adaptMessages(
  messages: unknown,
): { role: "system" | "user" | "assistant"; content: string }[] {
  if (!Array.isArray(messages)) return [];
  const out: { role: "system" | "user" | "assistant"; content: string }[] = [];

  const PER_MSG_CAP = 40_000;
  const TOTAL_CAP = 250_000;
  let total = 0;

  const push = (role: "system" | "user" | "assistant", content: string) => {
    const c = String(content ?? "").slice(0, PER_MSG_CAP);
    if (!c) return;
    total += c.length;
    if (total > TOTAL_CAP) return;
    out.push({ role, content: c });
  };

  for (const raw of messages) {
    const m = raw as AnyObj;
    if (!m || typeof m !== "object") continue;
    const role = String(m.role ?? "");

    if (role === "system") {
      push("system", String(m.content ?? ""));
      continue;
    }

    if (role === "tool") {
      const name = String(m.name ?? "fn");
      let obj: AnyObj | null = null;
      try {
        obj = typeof m.content === "string" ? (JSON.parse(m.content as string) as AnyObj) : (m.content as AnyObj);
      } catch {
        obj = null;
      }
      if (name === "present_choices" && obj) {
        if (obj.already_confirmed) {
          push(
            "user",
            `'${obj.field || "항목"}'은(는) 이미 '${obj.already_confirmed}'(으)로 확정되어 미리보기에 반영되어 있습니다. 이 항목은 끝났으니 present_choices로 다시 묻지 말고, 그 값을 그대로 둔 채 [권장 진행 순서]의 다음 단계로 바로 넘어가세요.`,
          );
          continue;
        }
        if (obj.regenerate) {
          push("user", `'${obj.field || "항목"}'의 다른 후보를 다시 추천해 주세요. 앞서 제시한 것과 겹치지 않는 새로운 후보로 present_choices를 다시 호출하세요.`);
          continue;
        }
        if (obj.user_message) {
          const f = obj.field ? `'${obj.field}'에 대한 사용자 답변: ` : "";
          push("user", `${f}${obj.user_message}`);
          continue;
        }
        const selArr = Array.isArray(obj.selected) ? (obj.selected as unknown[]).filter(Boolean) : [];
        const sel = selArr.join(", ");
        let line = `사용자가 '${obj.field || "항목"}' 항목에서 다음을 선택했습니다: ${sel || "(선택 없음)"}`;
        if (obj.none) line += " / '선택 안 함'";
        if (obj.custom_input) line += ` (이 중 "${obj.custom_input}"은(는) 사용자가 직접 입력한 표현이니, 의도를 짧게 되짚고 다듬어 반영하세요)`;
        line += ` — 이 선택은 확정입니다. update_plan으로 반영하고 곧바로 다음 단계로 진행하세요. 같은 '${obj.field || "항목"}' 항목을 present_choices로 다시 묻거나 RAG(list_*/find_*)를 다시 호출하지 마세요.`;
        push("user", line);
        continue;
      }
      const txt = typeof m.content === "string" ? (m.content as string) : JSON.stringify(m.content);
      push("user", `[도구 결과: ${name}]\n${txt}`);
      continue;
    }

    if (role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0) {
      if (typeof m.content === "string" && (m.content as string).trim()) {
        push("assistant", (m.content as string).trim());
      }
      continue;
    }

    if (role === "user" || role === "assistant") {
      push(role, String(m.content ?? ""));
    } else {
      push("user", String(m.content ?? ""));
    }
  }

  return out;
}

// Adapt OpenAI tool_calls -> legacy Gemini-shape functionCalls
export function toolCallsToGemini(toolCalls: unknown): { name: string; args: AnyObj }[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: { name: string; args: AnyObj }[] = [];
  for (const tc of toolCalls) {
    const t = tc as AnyObj;
    const fn = (t.function as AnyObj) || {};
    const name = String(fn.name ?? "");
    if (!name) continue;
    let args: AnyObj = {};
    const rawArgs = fn.arguments;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as AnyObj;
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as AnyObj;
    }
    out.push({ name, args });
  }
  return out;
}

// USD per 1M tokens — keep in sync with admin Cost view
export const PRICING: Record<string, { in: number; out: number }> = {
  "google/gemini-3.5-flash": { in: 1.5, out: 9.0 },
  "google/gemini-3.1-pro-preview": { in: 2.0, out: 12.0 },
  "google/gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "google/gemini-3-flash-preview": { in: 0.5, out: 3.0 },
  "google/gemini-2.5-pro": { in: 1.25, out: 10.0 },
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "openai/gpt-5": { in: 1.25, out: 10.0 },
  "openai/gpt-5-mini": { in: 0.25, out: 2.0 },
  "openai/gpt-5-nano": { in: 0.05, out: 0.4 },
  "openai/gpt-5.4": { in: 2.5, out: 20.0 },
  "openai/gpt-5.4-mini": { in: 0.5, out: 4.0 },
  "openai/gpt-5.4-nano": { in: 0.1, out: 0.8 },
  "openai/gpt-5.5": { in: 3.0, out: 25.0 },
};

export function estimateCostUsd(model: string, promptTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { in: 0.5, out: 3.0 };
  return (promptTokens * p.in + outputTokens * p.out) / 1e6;
}
