import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
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
  conversationId: z.string().uuid().optional(),
  messages: z.array(MessageSchema).min(1),
  model: z.string().optional(),
  stage: z.string().optional(),
  maxTokens: z.number().int().optional(),
  persist: z.boolean().optional(),
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

async function resolveModel(supabase: import("@supabase/supabase-js").SupabaseClient, requested?: string) {
  if (requested && isValidModel(requested)) return requested;
  const { data } = await supabase.from("app_config").select("value").eq("key", "default_model").maybeSingle();
  const v = data?.value;
  if (typeof v === "string" && isValidModel(v)) return v;
  return DEFAULT_MODEL_ID;
}

export const sendChatMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SendInput.parse(input))
  .handler(async ({ data, context }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY 미설정");

    const { supabase, userId } = context;
    const model = await resolveModel(supabase, data.model);
    const messages = trimMessages(data.messages);
    const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(data.maxTokens ?? 4000, MAX_OUTPUT_TOKENS));

    const result = await runModel(apiKey, model, messages, maxTokens);

    // fire-and-forget usage log
    void supabase.from("ai_usage_log").insert({
      user_id: userId,
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

    // optional persistence
    let conversationId = data.conversationId;
    if (data.persist) {
      if (!conversationId) {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const title = (lastUser?.content ?? "새 대화").slice(0, 60);
        const { data: conv, error } = await supabase
          .from("conversations")
          .insert({ user_id: userId, title, stage: data.stage ?? null })
          .select("id")
          .single();
        if (error) throw error;
        conversationId = conv.id;
      }
      const userMsg = messages[messages.length - 1];
      await supabase.from("messages").insert([
        { conversation_id: conversationId, role: userMsg.role, content: { text: userMsg.content }, model: null },
        { conversation_id: conversationId, role: "assistant", content: { text: result.text }, model },
      ]);
      await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    }

    return {
      conversationId: conversationId ?? null,
      model,
      text: result.text,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  });

export const compareModels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CompareInput.parse(input))
  .handler(async ({ data, context }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY 미설정");
    const { supabase, userId } = context;

    const ids = data.modelIds.filter(isValidModel).slice(0, MAX_COMPARE_MODELS);
    if (ids.length === 0) throw new Error("유효한 모델이 없습니다");

    const messages = trimMessages(data.messages);
    const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(data.maxTokens ?? 4000, MAX_OUTPUT_TOKENS));

    const results = await Promise.all(
      ids.map(async (id) => {
        const r = await runModel(apiKey, id, messages, maxTokens);
        void supabase.from("ai_usage_log").insert({
          user_id: userId,
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

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("conversations")
      .select("id, title, stage, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return data ?? [];
  });

export const getConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: conv } = await context.supabase
      .from("conversations").select("*").eq("id", data.id).single();
    const { data: msgs } = await context.supabase
      .from("messages").select("*").eq("conversation_id", data.id).order("created_at");
    return { conversation: conv, messages: msgs ?? [] };
  });

export const getModelCatalog = createServerFn({ method: "GET" }).handler(async () => AI_MODELS);
