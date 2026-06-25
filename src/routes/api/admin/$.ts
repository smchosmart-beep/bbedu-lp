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

async function loadCostByDay(
  variant?: string | null,
  fromISO?: string | null,
  toISO?: string | null,
): Promise<Record<string, {
  usd: number;
  calls: number;
  tokens: number;
  sessions: number;
  plans: number;
  models: Record<string, { usd: number; calls: number; tokens: number; prompt: number; output: number }>;
}>> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("ai_usage_log")
      .select("ts, model, prompt_tokens, output_tokens, total_tokens, run_id, variant")
      .order("ts", { ascending: false })
      .limit(20000);
    if (variant) q = q.eq("variant", variant);
    if (fromISO) q = q.gte("ts", fromISO);
    if (toISO) q = q.lte("ts", toISO);
    const { data } = await q;
    const byDay: Record<string, {
      usd: number;
      calls: number;
      tokens: number;
      sessions: number;
      plans: number;
      models: Record<string, { usd: number; calls: number; tokens: number; prompt: number; output: number }>;
      _runs?: Set<string>;
    }> = {};
    for (const row of data ?? []) {
      const r = row as { ts: string; model: string; prompt_tokens: number; output_tokens: number; total_tokens: number; run_id: string | null };
      const ts = new Date(r.ts);
      const kstDay = new Date(ts.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      // 모델 ID 정규형으로 통일 — 'gemini-3.5-flash'와 'google/gemini-3.5-flash'가 따로 집계되는 현상 차단
      const model = resolveModelId(r.model ?? "unknown");
      const p = Number(r.prompt_tokens ?? 0);
      const o = Number(r.output_tokens ?? 0);
      const t = Number(r.total_tokens ?? p + o);
      const usd = estimateCostUsd(model, p, o);
      const d = (byDay[kstDay] = byDay[kstDay] || {
        usd: 0, calls: 0, tokens: 0, sessions: 0, plans: 0, models: {}, _runs: new Set<string>(),
      });
      d.usd += usd;
      d.calls += 1;
      d.tokens += t;
      if (r.run_id) d._runs!.add(r.run_id);
      const m = (d.models[model] = d.models[model] || { usd: 0, calls: 0, tokens: 0, prompt: 0, output: 0 });
      m.usd += usd;
      m.calls += 1;
      m.tokens += t;
      m.prompt += p;
      m.output += o;
    }
    // hwpx_files 일별 count → plans
    try {
      let hq = supabaseAdmin.from("hwpx_files").select("created_at, variant").limit(20000);
      if (variant) hq = hq.eq("variant", variant);
      if (fromISO) hq = hq.gte("created_at", fromISO);
      if (toISO) hq = hq.lte("created_at", toISO);
      const { data: hrows } = await hq;
      for (const hr of hrows ?? []) {
        const ts = new Date((hr as { created_at: string }).created_at);
        const kstDay = new Date(ts.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
        const d = (byDay[kstDay] = byDay[kstDay] || {
          usd: 0, calls: 0, tokens: 0, sessions: 0, plans: 0, models: {}, _runs: new Set<string>(),
        });
        d.plans += 1;
      }
    } catch {
      /* ignore */
    }
    // sessions = distinct run_id 수
    for (const k of Object.keys(byDay)) {
      byDay[k].sessions = byDay[k]._runs ? byDay[k]._runs!.size : 0;
      delete byDay[k]._runs;
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
          const url = new URL(request.url);
          const variant = url.searchParams.get("variant");
          const from = url.searchParams.get("from"); // YYYY-MM-DD (KST)
          const to = url.searchParams.get("to");
          const fromISO = from ? new Date(from + "T00:00:00+09:00").toISOString() : null;
          const toISO = to ? new Date(to + "T23:59:59+09:00").toISOString() : null;
          const byDay = await loadCostByDay(variant, fromISO, toISO);
          return Response.json({ byDay, krwPerUsd: KRW_PER_USD, pricing: PRICING });
        }
        if (path === "/files") {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { data, error } = await supabaseAdmin
              .from("hwpx_files")
              .select("id, file_name, created_at, model, cost_krw, cost_usd, usage, meta")
              .order("created_at", { ascending: false })
              .limit(200);
            if (error) {
              return Response.json({ items: [], error: error.message });
            }
            // run_id별로 ai_usage_log를 lookup해서 콜 단위 SSoT 재계산값을 함께 반환.
            const runIds = (data ?? [])
              .map((r) => {
                const m = (r.meta ?? {}) as Record<string, unknown>;
                const rid = m.run_id ?? m.runId;
                return typeof rid === "string" && rid ? rid : null;
              })
              .filter((x): x is string => !!x);
            const krwLoggedByRun: Record<string, { usd: number; calls: number; byModel: Record<string, { prompt: number; output: number; calls: number; usd: number }> }> = {};
            if (runIds.length > 0) {
              const { data: logs } = await supabaseAdmin
                .from("ai_usage_log")
                .select("run_id, model, prompt_tokens, output_tokens")
                .in("run_id", runIds)
                .limit(50000);
              for (const row of logs ?? []) {
                const r = row as { run_id: string; model: string; prompt_tokens: number; output_tokens: number };
                if (!r.run_id) continue;
                const mid = resolveModelId(r.model ?? "unknown");
                const p = Number(r.prompt_tokens ?? 0);
                const o = Number(r.output_tokens ?? 0);
                const usd = estimateCostUsd(mid, p, o);
                const entry = (krwLoggedByRun[r.run_id] ||= { usd: 0, calls: 0, byModel: {} });
                entry.usd += usd;
                entry.calls += 1;
                const mb = (entry.byModel[mid] ||= { prompt: 0, output: 0, calls: 0, usd: 0 });
                mb.prompt += p; mb.output += o; mb.calls += 1; mb.usd += usd;
              }
            }
            const items = (data ?? []).map((r) => {
              const u = (r.usage ?? {}) as Record<string, unknown>;
              const m = (r.meta ?? {}) as Record<string, unknown>;
              const rid = (m.run_id ?? m.runId) as string | undefined;
              const logged = rid ? krwLoggedByRun[rid] : null;
              const krwLogged = logged ? Math.round(logged.usd * KRW_PER_USD) : null;
              const byModelClient = (u.byModel ?? null) as Record<string, unknown> | null;
              return {
                id: r.id,
                fileName: r.file_name,
                createdAt: r.created_at,
                모델: r.model ?? "",
                krw: Number(r.cost_krw ?? 0),
                krwLogged,
                loggedCalls: logged ? logged.calls : 0,
                byModelLogged: logged ? logged.byModel : null,
                byModelClient,
                runId: rid ?? null,
                calls: Number(u.calls ?? 0),
                토큰: {
                  prompt: Number(u.prompt ?? 0),
                  output: Number(u.output ?? 0),
                  cached: Number(u.cached ?? 0),
                },
                학년: String(m["학년"] ?? ""),
                학기: String(m["학기"] ?? ""),
                교과: String(m["교과"] ?? ""),
                단원: String(m["단원"] ?? ""),
                성취기준: String(m["성취기준"] ?? ""),
                수업주제: String(m["수업주제"] ?? ""),
              };
            });
            return Response.json({ items, krwPerUsd: KRW_PER_USD });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return Response.json({ items: [], error: message });
          }
        }
        // 진단 — 최근 N시간 동안 ai_usage_log insert 건수(빨강 배너용)
        if (path === "/diag") {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const url = new URL(request.url);
            const variant = url.searchParams.get("variant");
            const hours = Math.max(1, Math.min(168, Number(url.searchParams.get("hours") ?? 24)));
            const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
            let q = supabaseAdmin.from("ai_usage_log").select("id", { count: "exact", head: true }).gte("ts", since);
            if (variant) q = q.eq("variant", variant);
            const { count } = await q;
            let pq = supabaseAdmin.from("hwpx_files").select("id", { count: "exact", head: true }).gte("created_at", since);
            if (variant) pq = pq.eq("variant", variant);
            const { count: plansCount } = await pq;
            return Response.json({ hours, logRows: count ?? 0, plans: plansCount ?? 0 });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) });
          }
        }
        // /files/{id}/download
        const dl = path.match(/^\/files\/([^/]+)\/download$/);
        if (dl) {
          const id = dl[1];
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { data: row, error: rowErr } = await supabaseAdmin
              .from("hwpx_files")
              .select("file_name, storage_path")
              .eq("id", id)
              .maybeSingle();
            if (rowErr || !row) {
              return new Response("not found", { status: 404 });
            }
            const { data: blob, error: dlErr } = await supabaseAdmin.storage
              .from("hwpx")
              .download(row.storage_path);
            if (dlErr || !blob) {
              return new Response("download failed: " + (dlErr?.message ?? ""), { status: 502 });
            }
            const buf = Buffer.from(await blob.arrayBuffer());
            const encoded = encodeURIComponent(row.file_name);
            return new Response(buf, {
              status: 200,
              headers: {
                "Content-Type": "application/vnd.hancom.hwpx",
                "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
                "Cache-Control": "no-store",
              },
            });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return new Response("error: " + message, { status: 500 });
          }
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
