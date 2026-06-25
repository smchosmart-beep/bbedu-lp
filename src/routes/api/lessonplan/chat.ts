// Legacy Firebase /api/lessonplan/chat compatibility endpoint, served by Lovable AI Gateway.
import { createFileRoute } from "@tanstack/react-router";
import { generateText, jsonSchema, tool as aiTool } from "ai";
import {
  adaptMessages,
  estimateCostUsd,
  geminiToolsToOpenAI,
  hasStageConflict,
  isMalformedSignal,
  pickModelForTier,
  pickTier,
  resolveModelId,
  tierConfig,
  toolCallsToGemini,
  type Tier,
} from "@/lib/lessonplan-bridge.server";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

const MIN_TOKENS = 500;
const MAX_TOKENS = 32_768;

async function logUsage(row: {
  model: string;
  variant: string | null;
  prompt: number;
  output: number;
  total: number;
  latency_ms: number;
  cost_usd: number;
  error: string | null;
}) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("ai_usage_log").insert({
      user_id: null,
      model: row.model,
      variant: row.variant,
      stage: null,
      prompt_tokens: row.prompt,
      output_tokens: row.output,
      total_tokens: row.total,
      latency_ms: row.latency_ms,
      run_id: null,
      error: row.error,
    });
  } catch {
    /* ignore */
  }
  void row.cost_usd;
}

export const Route = createFileRoute("/api/lessonplan/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.LOVABLE_API_KEY;
        if (!apiKey) {
          return Response.json({ error: "LOVABLE_API_KEY 미설정" }, { status: 500 });
        }

        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
        }

        const {
          messages,
          tools,
          maxTokens,
          model,
          variant,
          json,
          system,
          user,
        } = body as {
          messages?: unknown;
          tools?: unknown;
          maxTokens?: number;
          model?: string;
          variant?: string;
          json?: boolean;
          system?: string;
          user?: string;
        };

        // Build messages array
        let oaiMessages: { role: "system" | "user" | "assistant"; content: string }[] = [];
        if (Array.isArray(messages) && messages.length > 0) {
          oaiMessages = adaptMessages(messages);
        } else if (system && user) {
          oaiMessages = [
            { role: "system", content: String(system).slice(0, 2000) },
            { role: "user", content: String(user).slice(0, 8000) },
          ];
        } else {
          return Response.json({ error: "messages 또는 system/user 필요" }, { status: 400 });
        }

        if (oaiMessages.length === 0) {
          return Response.json({ error: "user 메시지가 필요합니다" }, { status: 400 });
        }

        const resolvedModel = resolveModelId(model);
        const openaiTools = geminiToolsToOpenAI(tools);
        const tokenCap = Math.max(MIN_TOKENS, Math.min(Number(maxTokens) || 4000, MAX_TOKENS));

        const gateway = createLovableAiGatewayProvider(apiKey);

        const start = Date.now();
        try {
          // Convert tools to AI SDK shape (object keyed by tool name)
          let aiTools: Record<string, ReturnType<typeof aiTool>> | undefined;
          if (openaiTools && openaiTools.length > 0) {
            aiTools = {};
            for (const t of openaiTools) {
              const fn = ((t as Record<string, unknown>).function ?? {}) as {
                name?: string;
                description?: string;
                parameters?: unknown;
              };
              if (!fn.name) continue;
              aiTools[fn.name] = aiTool({
                description: fn.description ?? "",
                inputSchema: jsonSchema(
                  (fn.parameters as Parameters<typeof jsonSchema>[0]) ?? {
                    type: "object",
                    properties: {},
                  },
                ),
              });
            }
          }

          const result = await generateText({
            model: gateway(resolvedModel),
            messages: oaiMessages as never,
            maxOutputTokens: tokenCap,
            temperature: 0.7,
            ...(aiTools ? { tools: aiTools as never, toolChoice: "auto" as never } : {}),
            ...(json
              ? ({
                  providerOptions: {
                    openaiCompatible: { response_format: { type: "json_object" } },
                  },
                } as never)
              : {}),
          });

          const latency = Date.now() - start;
          const usage = result.usage ?? {};
          const promptTokens = Number((usage as Record<string, unknown>).inputTokens ?? 0);
          const outputTokens = Number((usage as Record<string, unknown>).outputTokens ?? 0);
          const totalTokens = Number(
            (usage as Record<string, unknown>).totalTokens ?? promptTokens + outputTokens,
          );
          const costUsd = estimateCostUsd(resolvedModel, promptTokens, outputTokens);

          void logUsage({
            model: resolvedModel,
            variant: variant ?? null,
            prompt: promptTokens,
            output: outputTokens,
            total: totalTokens,
            latency_ms: latency,
            cost_usd: costUsd,
            error: null,
          });

          // Adapt AI SDK toolCalls -> legacy Gemini-style functionCalls
          const sdkToolCalls = (result as unknown as { toolCalls?: unknown[] }).toolCalls ?? [];
          const functionCalls = sdkToolCalls
            .map((tc) => {
              const t = tc as { toolName?: string; input?: unknown };
              if (!t.toolName) return null;
              const args =
                typeof t.input === "string"
                  ? (() => {
                      try {
                        return JSON.parse(t.input as string);
                      } catch {
                        return {};
                      }
                    })()
                  : t.input ?? {};
              return { name: t.toolName, args };
            })
            .filter(Boolean);

          // JSON mode: client expects parsed JSON merged with _usd
          if (json && functionCalls.length === 0) {
            try {
              const parsed = JSON.parse(result.text);
              return Response.json({ ...parsed, _usd: costUsd });
            } catch {
              return Response.json(
                { error: "JSON 파싱 실패", raw: result.text.slice(0, 1000) },
                { status: 502 },
              );
            }
          }

          // Legacy shape — usage uses Gemini camelCase keys app35.js reads
          return Response.json({
            content: result.text || "",
            functionCalls,
            usage: {
              promptTokenCount: promptTokens,
              candidatesTokenCount: outputTokens,
              cachedContentTokenCount: 0,
              totalTokenCount: totalTokens,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void logUsage({
            model: resolvedModel,
            variant: variant ?? null,
            prompt: 0,
            output: 0,
            total: 0,
            latency_ms: Date.now() - start,
            cost_usd: 0,
            error: message.slice(0, 500),
          });
          // Try to classify rate-limit / blocked / etc by message; default 502
          const status = /\b429\b/.test(message) ? 429 : /\b402\b/.test(message) ? 402 : 502;
          return Response.json({ error: `AI Gateway 오류`, detail: message.slice(0, 500) }, { status });
        }
      },
    },
  },
});
