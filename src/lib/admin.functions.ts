// DEV ONLY: no auth — restore requireSupabaseAuth + has_role('admin') before launch.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isValidModel } from "./ai-models";

export const getUsageStats = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ days: z.number().int().min(1).max(90).default(14) }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const since = new Date(Date.now() - data.days * 86400_000).toISOString();
    const { data: rows, error } = await supabaseAdmin
      .from("ai_usage_log")
      .select("ts, model, prompt_tokens, output_tokens, total_tokens, latency_ms, variant, error")
      .gte("ts", since)
      .order("ts", { ascending: false })
      .limit(5000);
    if (error) throw error;
    return rows ?? [];
  });

export const getDefaultModel = createServerFn({ method: "GET" }).handler(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
  const { data } = await supabase.from("app_config").select("value").eq("key", "default_model").maybeSingle();
  return (data?.value as string | undefined) ?? null;
});

export const setDefaultModel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ modelId: z.string() }).parse(input))
  .handler(async ({ data }) => {
    if (!isValidModel(data.modelId)) throw new Error("지원되지 않는 모델입니다");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("app_config")
      .upsert({ key: "default_model", value: data.modelId, updated_at: new Date().toISOString() });
    if (error) throw error;
    return { ok: true, modelId: data.modelId };
  });
