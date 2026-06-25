import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isValidModel } from "./ai-models";

async function requireAdmin(ctx: { supabase: import("@supabase/supabase-js").SupabaseClient; userId: string }) {
  const { data, error } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "admin" });
  if (error) throw error;
  if (!data) throw new Error("관리자 권한이 필요합니다");
}

export const isCurrentUserAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
    return Boolean(data);
  });

export const getUsageStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ days: z.number().int().min(1).max(90).default(14) }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const since = new Date(Date.now() - data.days * 86400_000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("ai_usage_log")
      .select("ts, model, prompt_tokens, output_tokens, total_tokens, latency_ms, variant, error")
      .gte("ts", since)
      .order("ts", { ascending: false })
      .limit(5000);
    if (error) throw error;
    return rows ?? [];
  });

export const getDefaultModel = createServerFn({ method: "GET" }).handler(async () => {
  // public read of app_config
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
  const { data } = await supabase.from("app_config").select("value").eq("key", "default_model").maybeSingle();
  return (data?.value as string | undefined) ?? null;
});

export const setDefaultModel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ modelId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    if (!isValidModel(data.modelId)) throw new Error("지원되지 않는 모델입니다");
    const { error } = await context.supabase
      .from("app_config")
      .upsert({ key: "default_model", value: data.modelId, updated_at: new Date().toISOString() });
    if (error) throw error;
    return { ok: true, modelId: data.modelId };
  });
