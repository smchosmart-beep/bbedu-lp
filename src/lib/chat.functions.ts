// DEV ONLY: no auth — restore requireSupabaseAuth + per-user persistence before launch.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AI_MODELS, DEFAULT_MODEL_ID, MAX_COMPARE_MODELS, isValidModel } from "./ai-models";

const PER_MSG_CAP = 40_000;
const TOTAL_CAP = 250_000;
const MIN_OUTPUT_TOKENS = 500;
const MAX_OUTPUT_TOKENS = 32_768;

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const SendInput = z.object({
  messages: z.array(MessageSchema).min(1),
  model: z.string().optional(),
  stage: z.string().optional(),
  maxTokens: z.number().int().optional(),
});

const CompareInput = z.object({
  messages: z.array(MessageSchema).min(1),
  modelIds: z.array(z.string()).min(1).max(MAX_COMPARE_MODELS),
  stage: z.string().optional(),
  maxTokens: z.number().int().optional(),
});

function trimMessages(messages: { role: string; content: string }[]) {
  let total = 0;
  const out: { role: "system" | "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const c = (m.content ?? "").slice(0, PER_MSG_CAP);
    total += c.length;
    if (total > TOTAL_CAP) break;
    out.push({ role: m.role as "system" | "user" | "assistant", content: c });
  }
  return out;
}

async function runModel(
  apiKey: string,
  modelId: string,
  messages: { role: string; content: string }[],
  maxTokens: number,
) {
  const { generateText } = await import("ai");
  const { createLovableAiGatewayProvider } = await import("./ai-gateway.server");
  const gateway = createLovableAiGatewayProvider(apiKey);
  const start = Date.now();
  try {
    const result = await generateText({
      model: gateway(modelId),
      messages: messages as never,
      maxOutputTokens: maxTokens,
    });
    return {
      ok: true as const,
      text: result.text,
      usage: result.usage,
      runId: gateway.getRunId(),
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false as const, error: msg, latencyMs: Date.now() - start };
  }
}

async function resolveModel(requested?: string) {
  if (requested && isValidModel(requested)) return requested;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    });
    const { data } = await supabase.from("app_config").select("value").eq("key", "default_model").maybeSingle();
    const v = data?.value;
    if (typeof v === "string" && isValidModel(v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_MODEL_ID;
}

async function logUsage(row: {
  user_id: null;
  model: string;
  stage: string | null;
  variant: string;
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  latency_ms: number;
  run_id: string | null;
  error: string | null;
}) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("ai_usage_log").insert(row);
  } catch { /* ignore */ }
}

export const sendChatMessage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => SendInput.parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY 미설정");

    const model = await resolveModel(data.model);
    const messages = trimMessages(data.messages);
    const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(data.maxTokens ?? 4000, MAX_OUTPUT_TOKENS));

    const result = await runModel(apiKey, model, messages, maxTokens);

    void logUsage({
      user_id: null,
      model,
      stage: data.stage ?? null,
      variant: "chat",
      prompt_tokens: result.ok ? Number(result.usage?.inputTokens ?? 0) : 0,
      output_tokens: result.ok ? Number(result.usage?.outputTokens ?? 0) : 0,
      total_tokens: result.ok ? Number(result.usage?.totalTokens ?? 0) : 0,
      latency_ms: result.latencyMs,
      run_id: result.ok ? (result.runId ?? null) : null,
      error: result.ok ? null : result.error.slice(0, 500),
    });

    if (!result.ok) throw new Error(result.error);

    return {
      model,
      text: result.text,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  });

export const compareModels = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CompareInput.parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY 미설정");

    const ids = data.modelIds.filter(isValidModel).slice(0, MAX_COMPARE_MODELS);
    if (ids.length === 0) throw new Error("유효한 모델이 없습니다");

    const messages = trimMessages(data.messages);
    const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(data.maxTokens ?? 4000, MAX_OUTPUT_TOKENS));

    const results = await Promise.all(
      ids.map(async (id) => {
        const r = await runModel(apiKey, id, messages, maxTokens);
        void logUsage({
          user_id: null,
          model: id,
          stage: data.stage ?? null,
          variant: "compare",
          prompt_tokens: r.ok ? Number(r.usage?.inputTokens ?? 0) : 0,
          output_tokens: r.ok ? Number(r.usage?.outputTokens ?? 0) : 0,
          total_tokens: r.ok ? Number(r.usage?.totalTokens ?? 0) : 0,
          latency_ms: r.latencyMs,
          run_id: r.ok ? (r.runId ?? null) : null,
          error: r.ok ? null : r.error.slice(0, 500),
        });
        return r.ok
          ? { modelId: id, ok: true as const, text: r.text, usage: r.usage, latencyMs: r.latencyMs }
          : { modelId: id, ok: false as const, error: r.error, latencyMs: r.latencyMs };
      }),
    );

    return { results };
  });

export const getModelCatalog = createServerFn({ method: "GET" }).handler(async () => AI_MODELS);
