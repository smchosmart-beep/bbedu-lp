// Legacy Firebase /api/lessonplan/chat compatibility endpoint, served by Lovable AI Gateway.
import { createFileRoute } from "@tanstack/react-router";
import { generateText, jsonSchema, tool as aiTool } from "ai";
import {
  adaptMessages,
  escalateTier,
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
  stage: string | null;
  run_id: string | null;
  prompt: number;
  output: number;
  total: number;
  latency_ms: number;
  cost_usd: number;
  error: string | null;
}) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("ai_usage_log").insert({
      user_id: null,
      model: row.model,
      variant: row.variant,
      stage: row.stage,
      prompt_tokens: row.prompt,
      output_tokens: row.output,
      total_tokens: row.total,
      latency_ms: row.latency_ms,
      run_id: row.run_id,
      error: row.error,
    });
    if (error) console.error("[ai_usage_log insert failed]", error.message);
  } catch (e) {
    console.error("[ai_usage_log insert threw]", e instanceof Error ? e.message : String(e));
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
          stage,
          runId,
          forceTier,
        } = body as {
          messages?: unknown;
          tools?: unknown;
          maxTokens?: number;
          model?: string;
          variant?: string;
          json?: boolean;
          system?: string;
          user?: string;
          stage?: number;
          runId?: string;
          forceTier?: Tier;
        };
        const stageStr = typeof stage === "number" && Number.isFinite(stage) ? String(stage) : null;
        const runIdStr = typeof runId === "string" && runId.trim() ? runId.trim().slice(0, 64) : null;
        // Step 0 진단: stage 누락 호출 추적 (라우팅 변경 효과 측정의 SSoT)
        if (!stageStr) {
          console.warn(`[stage-missing] variant=${variant ?? "?"} runId=${runIdStr ?? "?"} json=${!!json} hasModel=${!!model}`);
        }



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

        // === Tier 결정 (T1 충돌 가드 포함) ===
        // - json 요청(검수)은 호출자가 forceTier 또는 명시 model 로 직접 모델 선택
        // - 그 외 일반 챗 호출은 stage 기반 PRIMARY/CHEAP 라우팅
        let tier: Tier;
        if (forceTier === "PRIMARY" || forceTier === "CHEAP") {
          tier = forceTier;
        } else if (json && model) {
          // 검수 등 명시 모델 — 클라가 요청한 model 그대로 사용 (tier 무시)
          tier = "PRIMARY";
        } else {
          tier = pickTier(typeof stage === "number" ? stage : null);
          if (tier === "CHEAP" && hasStageConflict(stage, messages)) tier = "PRIMARY";
        }

        // 모델 결정: json+model 명시면 그 모델, 아니면 tier 별 디폴트
        const resolvedModel = json && model ? resolveModelId(model) : pickModelForTier(tier, model);
        const tcfg = tierConfig(tier);
        const openaiTools = geminiToolsToOpenAI(tools);
        const tokenCap = Math.max(
          MIN_TOKENS,
          Math.min(Number(maxTokens) || tcfg.maxOutputTokens, MAX_TOKENS, tcfg.maxOutputTokens),
        );

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

          // === 실행 + MALFORMED 시 PRIMARY 재시도 ===
          let modelInUse = resolvedModel;
          let tcfgInUse = tcfg;
          let result;
          let triedFallback = false;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            try {
              result = await generateText({
                model: gateway(modelInUse),
                messages: oaiMessages as never,
                maxOutputTokens: tokenCap,
                temperature: tcfgInUse.temperature,
                ...(aiTools ? { tools: aiTools as never, toolChoice: "auto" as never } : {}),
                ...(json
                  ? ({
                      providerOptions: {
                        openaiCompatible: { response_format: { type: "json_object" } },
                      },
                    } as never)
                  : {}),
              });
              // CHEAP 시도 후 결과가 비어 있거나 JSON 모드인데 파싱 불가 → PRIMARY 폴백
              if (!triedFallback && tier === "CHEAP" && json) {
                try {
                  JSON.parse(result.text || "");
                } catch {
                  triedFallback = true;
                  modelInUse = pickModelForTier("PRIMARY", model);
                  tcfgInUse = tierConfig("PRIMARY");
                  continue;
                }
              }
              break;
            } catch (innerErr) {
              const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
              if (!triedFallback && tier === "CHEAP" && isMalformedSignal(msg)) {
                triedFallback = true;
                modelInUse = pickModelForTier("PRIMARY", model);
                tcfgInUse = tierConfig("PRIMARY");
                continue;
              }
              throw innerErr;
            }
          }

          const latency = Date.now() - start;
          const usage = result.usage ?? {};
          const promptTokens = Number((usage as Record<string, unknown>).inputTokens ?? 0);
          const outputTokens = Number((usage as Record<string, unknown>).outputTokens ?? 0);
          const totalTokens = Number(
            (usage as Record<string, unknown>).totalTokens ?? promptTokens + outputTokens,
          );
          const costUsd = estimateCostUsd(modelInUse, promptTokens, outputTokens);

          void logUsage({
            model: modelInUse,
            variant: variant ?? null,
            stage: stageStr,
            run_id: runIdStr,
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

          // JSON mode: client expects parsed JSON merged with _usd / _model
          if (json && functionCalls.length === 0) {
            try {
              const parsed = JSON.parse(result.text);
              return Response.json({ ...parsed, _usd: costUsd, _model: modelInUse });
            } catch {
              return Response.json(
                { error: "JSON 파싱 실패", raw: result.text.slice(0, 1000) },
                { status: 502 },
              );
            }
          }

          // Legacy shape — includes modelUsed so the client can attribute tokens per model.
          return Response.json({
            content: result.text || "",
            functionCalls,
            modelUsed: modelInUse,
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
            stage: stageStr,
            run_id: runIdStr,
            prompt: 0,
            output: 0,
            total: 0,
            latency_ms: Date.now() - start,
            cost_usd: 0,
            error: message.slice(0, 500),
          });
          const status = /\b429\b/.test(message) ? 429 : /\b402\b/.test(message) ? 402 : 502;
          return Response.json({ error: `AI Gateway 오류`, detail: message.slice(0, 500) }, { status });
        }
      },
    },
  },
});
