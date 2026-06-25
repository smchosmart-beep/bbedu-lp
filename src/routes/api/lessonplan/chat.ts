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

        // === Tier 결정 ===
        // - 검수(99)·최종검토(100): client가 명시한 model을 그대로 사용.
        //   검수 흐름은 app35.js L1863~ 에서 의도적으로 2.5-flash-lite → 3-flash-preview
        //   2단계 호출로 비용을 최적화함. 서버에서 MID 강제로 덮어쓰면 lite 절약 효과 사라짐.
        // - 그 외 JSON 호출(forceTier 없음, model 명시): 호환을 위해 client model 그대로(PRIMARY).
        // - 그 외 일반 챗 호출: stage 기반 PRIMARY/MID/LITE 라우팅.
        let tier: Tier;
        if (forceTier === "PRIMARY" || forceTier === "MID" || forceTier === "LITE") {
          tier = forceTier;
        } else if (json && model) {
          tier = "PRIMARY";
        } else {
          tier = pickTier(typeof stage === "number" ? stage : null);
          if (tier !== "PRIMARY" && hasStageConflict(stage, messages)) tier = escalateTier(tier);
        }

        // 모델 결정: 위에서 PRIMARY 로 떨어진 명시 JSON 호출은 client model 그대로
        const useExplicitModel = json && !!model && forceTier === undefined;
        const resolvedModel = useExplicitModel ? resolveModelId(model!) : pickModelForTier(tier, model);

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

          // === 실행 + 폴백 ===
          // 폴백 조건 (한 단계 격상, 최대 1회):
          //   (1) JSON 모드인데 파싱 실패
          //   (2) tools 제공됐는데 functionCalls=0 이고 content가 너무 짧음(<40자) — 침묵 실패
          //   (3) MALFORMED_FUNCTION_CALL 류 에러
          let tierInUse = tier;
          let modelInUse = resolvedModel;
          let tcfgInUse = tcfg;
          let result;
          let triedFallback = false;
          const escalate = () => {
            triedFallback = true;
            tierInUse = escalateTier(tierInUse);
            modelInUse = pickModelForTier(tierInUse, model);
            tcfgInUse = tierConfig(tierInUse);
          };
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
              if (!triedFallback && tierInUse !== "PRIMARY") {
                // (1) JSON 파싱 실패
                if (json) {
                  try {
                    JSON.parse(result.text || "");
                  } catch {
                    console.warn(`[tier-fallback] reason=json-parse from=${tierInUse} stage=${stageStr}`);
                    escalate();
                    continue;
                  }
                }
                // (2) tool-call 침묵 실패
                if (aiTools) {
                  const tc = (result as unknown as { toolCalls?: unknown[] }).toolCalls ?? [];
                  const textLen = (result.text || "").trim().length;
                  if (tc.length === 0 && textLen < 40) {
                    console.warn(`[tier-fallback] reason=silent-toolcall from=${tierInUse} stage=${stageStr} textLen=${textLen}`);
                    escalate();
                    continue;
                  }
                }
              }
              break;
            } catch (innerErr) {
              const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
              if (!triedFallback && tierInUse !== "PRIMARY" && isMalformedSignal(msg)) {
                console.warn(`[tier-fallback] reason=malformed from=${tierInUse} stage=${stageStr}`);
                escalate();
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
              // 502 대신 200 + fallback 신호 — 프론트 흰화면 방지
              return Response.json({
                error: "JSON 파싱 실패",
                fallback: true,
                raw: result.text.slice(0, 1000),
                _model: modelInUse,
              });
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
          console.error("[lessonplan/chat] gateway error:", message);
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
          // 429/402 는 그대로 노출(클라가 분기), 그 외 업스트림 오류는 200 + fallback 으로 다운그레이드
          // → Lovable 프록시가 502를 RUNTIME_ERROR/blank screen 으로 처리하는 걸 방지
          if (/\b429\b/.test(message)) {
            return Response.json({ error: "rate limited", detail: message.slice(0, 500) }, { status: 429 });
          }
          if (/\b402\b/.test(message)) {
            return Response.json({ error: "credits exhausted", detail: message.slice(0, 500) }, { status: 402 });
          }
          return Response.json({
            error: "AI Gateway 오류",
            fallback: true,
            detail: message.slice(0, 500),
          });
        }
      },
    },
  },
});
