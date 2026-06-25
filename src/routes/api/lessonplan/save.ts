// Persist generated HWPX file to Lovable Cloud Storage (private `hwpx` bucket)
// and record metadata in `public.hwpx_files`. Used by legacy app35.js.
import { createFileRoute } from "@tanstack/react-router";
import { estimateCostUsd } from "@/lib/lessonplan-bridge.server";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const KRW_PER_USD = 1500;

function sanitizeName(name: string): string {
  const base = String(name || "").replace(/[\\/]/g, "_").trim();
  const cleaned = base.replace(/[^\p{L}\p{N}._\- ]/gu, "").slice(0, 120);
  return cleaned || "lesson-plan.hwpx";
}

export const Route = createFileRoute("/api/lessonplan/save")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
        }

        const fileName = sanitizeName(String(body.fileName ?? ""));
        const fileBase64 = String(body.fileBase64 ?? "");
        if (!fileBase64) return Response.json({ error: "fileBase64 누락" }, { status: 400 });

        let bytes: Buffer;
        try {
          bytes = Buffer.from(fileBase64, "base64");
        } catch {
          return Response.json({ error: "base64 디코드 실패" }, { status: 400 });
        }
        if (bytes.length === 0 || bytes.length > MAX_BYTES) {
          return Response.json({ error: "파일 크기 오류 (0 < size <= 5MB)" }, { status: 413 });
        }

        const variant = body.variant ? String(body.variant) : null;
        const model = body.model ? String(body.model) : null;
        const meta = (body.meta && typeof body.meta === "object" ? body.meta : {}) as Record<
          string,
          unknown
        >;
        const usage = (body.usage && typeof body.usage === "object" ? body.usage : {}) as Record<
          string,
          unknown
        >;
        const verifyUsd = Number(body.verifyUsd ?? 0) || 0;
        const promptTokens = Number(usage.prompt ?? 0) || 0;
        const outputTokens = Number(usage.output ?? 0) || 0;
        const costUsd =
          estimateCostUsd(model ?? "", promptTokens, outputTokens) + Math.max(0, verifyUsd);
        const costKrw = Math.round(costUsd * KRW_PER_USD);

        const now = new Date();
        const yyyy = now.getUTCFullYear();
        const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
        const uuid = crypto.randomUUID();
        const storagePath = `${yyyy}/${mm}/${uuid}-${fileName}`;

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const up = await supabaseAdmin.storage
            .from("hwpx")
            .upload(storagePath, bytes, {
              contentType: "application/vnd.hancom.hwpx",
              upsert: false,
            });
          if (up.error) {
            return Response.json(
              { error: "스토리지 업로드 실패", detail: up.error.message },
              { status: 502 },
            );
          }

          const ins = await supabaseAdmin
            .from("hwpx_files")
            .insert({
              file_name: fileName,
              storage_path: storagePath,
              variant,
              model,
              meta: meta as never,
              usage: usage as never,
              cost_usd: costUsd,
              cost_krw: costKrw,
            })
            .select("id")
            .single();
          if (ins.error) {
            // Best-effort cleanup of orphan object
            await supabaseAdmin.storage.from("hwpx").remove([storagePath]);
            return Response.json(
              { error: "메타 저장 실패", detail: ins.error.message },
              { status: 500 },
            );
          }

          return Response.json({ ok: true, id: ins.data.id });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return Response.json({ error: "서버 오류", detail: message.slice(0, 500) }, { status: 500 });
        }
      },
    },
  },
});
