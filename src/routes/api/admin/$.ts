// Admin endpoints (legacy compatibility) — model config, costs, login, files.
// Password is checked against ADMIN_PASSWORD env (defaults to "admin" for dev).
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual, createHash } from "node:crypto";
import { PRICING, resolveModelId, estimateCostUsd } from "@/lib/lessonplan-bridge.server";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { generateText } from "ai";

const AVAILABLE_MODELS = [
  "google/gemini-3-flash-preview",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.5",
];

function checkPassword(req: Request): boolean {
  const got = String(req.headers.get("x-admin-pass") ?? "");
  const expected = String(process.env.ADMIN_PASSWORD ?? "admin");
  const a = Buffer.from(createHash("sha256").update(got, "utf8").digest());
  const b = Buffer.from(createHash("sha256").update(expected, "utf8").digest());
  return a.length === b.length && timingSafeEqual(a, b);
}

async function getDefaultModel(): Promise<string> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("app_config")
      .select("value")
      .eq("key", "default_model")
      .maybeSingle();
    const v = data?.value;
    if (typeof v === "string") return resolveModelId(v);
  } catch {
    /* ignore */
  }
  return "google/gemini-3-flash-preview";
}

async function setDefaultModel(model: string): Promise<string> {
  const resolved = resolveModelId(model);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("app_config")
    .upsert({ key: "default_model", value: resolved as never, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return resolved;
}

const KRW_PER_USD = 1500;

async function loadCostByDay(): Promise<Record<string, {
  usd: number;
  calls: number;
  tokens: number;
  sessions: number;
  plans: number;
  models: Record<string, { usd: number; calls: number; tokens: number }>;
}>> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("ai_usage_log")
      .select("ts, model, prompt_tokens, output_tokens, total_tokens")
      .order("ts", { ascending: false })
      .limit(5000);
    const byDay: Record<string, {
      usd: number;
      calls: number;
      tokens: number;
      sessions: number;
      plans: number;
      models: Record<string, { usd: number; calls: number; tokens: number }>;
    }> = {};
    for (const row of data ?? []) {
      const ts = new Date((row as { ts: string }).ts);
      const kstDay = new Date(ts.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const model = (row as { model: string }).model ?? "unknown";
      const p = Number((row as { prompt_tokens: number }).prompt_tokens ?? 0);
      const o = Number((row as { output_tokens: number }).output_tokens ?? 0);
      const t = Number((row as { total_tokens: number }).total_tokens ?? p + o);
      const usd = estimateCostUsd(model, p, o);
      const d = (byDay[kstDay] = byDay[kstDay] || {
        usd: 0, calls: 0, tokens: 0, sessions: 0, plans: 0, models: {},
      });
      d.usd += usd;
      d.calls += 1;
      d.tokens += t;
      const m = (d.models[model] = d.models[model] || { usd: 0, calls: 0, tokens: 0 });
      m.usd += usd;
      m.calls += 1;
      m.tokens += t;
    }
    return byDay;
  } catch {
    return {};
  }
}

export const Route = createFileRoute("/api/admin/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const path = "/" + (params._splat ?? "");
        if (!checkPassword(request)) {
          return Response.json({ error: "인증 실패" }, { status: 401 });
        }
        if (path === "/config") {
          const m = await getDefaultModel();
          return Response.json({
            models: AVAILABLE_MODELS,
            geminiModel: m,
            krwPerUsd: KRW_PER_USD,
            pricing: PRICING,
          });
        }
        if (path === "/costs") {
          const byDay = await loadCostByDay();
          return Response.json({ byDay, krwPerUsd: KRW_PER_USD });
        }
        if (path === "/files") {
          return Response.json({ files: [] });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
      POST: async ({ request, params }) => {
        const path = "/" + (params._splat ?? "");
        if (path === "/login") {
          if (!checkPassword(request)) return Response.json({ error: "인증 실패" }, { status: 401 });
          return Response.json({ ok: true });
        }
        if (!checkPassword(request)) {
          return Response.json({ error: "인증 실패" }, { status: 401 });
        }
        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        if (path === "/config") {
          const next = await setDefaultModel(String(body.geminiModel ?? ""));
          return Response.json({ geminiModel: next, ok: true });
        }
        if (path === "/compare") {
          // { prompt, system, modelIds: [] }
          const apiKey = process.env.LOVABLE_API_KEY;
          if (!apiKey) return Response.json({ error: "LOVABLE_API_KEY 미설정" }, { status: 500 });
          const prompt = String(body.prompt ?? "");
          const system = String(body.system ?? "");
          const modelIds = Array.isArray(body.modelIds) ? (body.modelIds as string[]) : [];
          if (!prompt || modelIds.length === 0) {
            return Response.json({ error: "prompt 와 modelIds 필요" }, { status: 400 });
          }
          const gateway = createLovableAiGatewayProvider(apiKey);
          const results = await Promise.all(
            modelIds.slice(0, 8).map(async (id) => {
              const resolved = resolveModelId(id);
              const start = Date.now();
              try {
                const r = await generateText({
                  model: gateway(resolved),
                  messages: [
                    ...(system ? [{ role: "system" as const, content: system }] : []),
                    { role: "user" as const, content: prompt },
                  ] as never,
                  maxOutputTokens: 4096,
                });
                const usage = r.usage ?? {};
                const p = Number((usage as Record<string, unknown>).inputTokens ?? 0);
                const o = Number((usage as Record<string, unknown>).outputTokens ?? 0);
                const usd = estimateCostUsd(resolved, p, o);
                // log to ai_usage_log
                try {
                  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
                  await supabaseAdmin.from("ai_usage_log").insert({
                    user_id: null,
                    model: resolved,
                    variant: "admin_compare",
                    stage: null,
                    prompt_tokens: p,
                    output_tokens: o,
                    total_tokens: p + o,
                    latency_ms: Date.now() - start,
                    run_id: null,
                    error: null,
                  });
                } catch {
                  /* ignore */
                }
                return {
                  model: resolved,
                  ok: true,
                  text: r.text,
                  promptTokens: p,
                  outputTokens: o,
                  totalTokens: p + o,
                  costUsd: usd,
                  costKrw: Math.round(usd * KRW_PER_USD),
                  latencyMs: Date.now() - start,
                };
              } catch (e) {
                return {
                  model: resolved,
                  ok: false,
                  error: e instanceof Error ? e.message : String(e),
                  latencyMs: Date.now() - start,
                };
              }
            }),
          );
          return Response.json({ results, krwPerUsd: KRW_PER_USD });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    },
  },
});
