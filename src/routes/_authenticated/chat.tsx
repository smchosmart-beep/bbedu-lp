import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { sendChatMessage, compareModels } from "@/lib/chat.functions";
import { AI_MODELS, DEFAULT_MODEL_ID, MAX_COMPARE_MODELS, TIER_LABEL, VENDOR_LABEL, type ModelInfo } from "@/lib/ai-models";

export const Route = createFileRoute("/_authenticated/chat")({
  head: () => ({ meta: [{ title: "챗봇 · 교수·학습 과정안 도우미" }] }),
  component: ChatPage,
});

type ChatMsg = { role: "user" | "assistant"; content: string; model?: string };
type CompareResult = { modelId: string; ok: boolean; text?: string; error?: string; latencyMs: number; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };

const FAVORITES_KEY = "bbedu.favorites";
const LAST_MODEL_KEY = "bbedu.lastModel";

function ModelBadge({ model }: { model: ModelInfo }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {VENDOR_LABEL[model.vendor]} · {TIER_LABEL[model.tier]}
    </span>
  );
}

function ChatPage() {
  const sendFn = useServerFn(sendChatMessage);
  const compareFn = useServerFn(compareModels);

  const [systemPrompt, setSystemPrompt] = useState<string>("당신은 한국 초등 교사가 2022 개정 교육과정에 따른 교수·학습 과정안을 설계하도록 돕는 친절한 조교입니다. 한 번에 한 가지씩 질문하고, 구체적인 예시를 들어 설명합니다.");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [model, setModel] = useState<string>(DEFAULT_MODEL_ID);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([DEFAULT_MODEL_ID, "openai/gpt-5-mini"]);
  const [compareResults, setCompareResults] = useState<CompareResult[] | null>(null);

  useEffect(() => {
    try {
      const last = localStorage.getItem(LAST_MODEL_KEY);
      if (last && AI_MODELS.some((m) => m.id === last)) setModel(last);
      const favs = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
      if (Array.isArray(favs)) setFavorites(favs.filter((id) => AI_MODELS.some((m) => m.id === id)));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { try { localStorage.setItem(LAST_MODEL_KEY, model); } catch { /* ignore */ } }, [model]);
  useEffect(() => { try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch { /* ignore */ } }, [favorites]);

  function toggleFavorite(id: string) {
    setFavorites((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = AI_MODELS.filter((m) =>
      !term || m.id.toLowerCase().includes(term) || m.label.toLowerCase().includes(term) || m.description.toLowerCase().includes(term),
    );
    return {
      favorites: filtered.filter((m) => favorites.includes(m.id)),
      google: filtered.filter((m) => m.vendor === "google"),
      openai: filtered.filter((m) => m.vendor === "openai"),
    };
  }, [favorites, search]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    const userMsg: ChatMsg = { role: "user", content: text };
    const nextMsgs = [...messages, userMsg];
    setMessages(nextMsgs);
    setInput("");
    setBusy(true);
    try {
      if (compareMode) {
        setCompareResults(null);
        const payloadMessages = [
          { role: "system" as const, content: systemPrompt },
          ...nextMsgs.map((m) => ({ role: m.role, content: m.content })),
        ];
        const out = await compareFn({ data: { messages: payloadMessages, modelIds: compareIds } });
        setCompareResults(out.results);
        // append a placeholder assistant card-marker
        setMessages((cur) => [...cur, { role: "assistant", content: "🧪 비교 모드 결과는 오른쪽 카드를 확인하세요.", model: "compare" }]);
      } else {
        const payloadMessages = [
          { role: "system" as const, content: systemPrompt },
          ...nextMsgs.map((m) => ({ role: m.role, content: m.content })),
        ];
        const out = await sendFn({ data: { messages: payloadMessages, model } });
        setMessages((cur) => [...cur, { role: "assistant", content: out.text, model: out.model }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleCompareId(id: string) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPARE_MODELS) return prev;
      return [...prev, id];
    });
  }

  return (
    <div className="grid h-[calc(100vh-57px)] grid-cols-1 lg:grid-cols-[1fr_360px]">
      {/* Main chat column */}
      <div className="flex min-h-0 flex-col">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-5 py-3">
          <div className="relative">
            <button onClick={() => setPickerOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm hover:bg-surface">
              <span className="text-micro-up text-muted-foreground">모델</span>
              <span className="font-semibold">{AI_MODELS.find((m) => m.id === model)?.label ?? model}</span>
              <span className="text-muted-foreground">▾</span>
            </button>
            {pickerOpen && (
              <div className="absolute left-0 top-full z-20 mt-2 w-[420px] rounded-2xl border border-border bg-popover p-3 shadow-xl">
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="모델 검색…"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                />
                <div className="mt-3 max-h-[420px] space-y-3 overflow-y-auto">
                  {grouped.favorites.length > 0 && (
                    <ModelGroup title="즐겨찾기" models={grouped.favorites} selected={model} onSelect={(id) => { setModel(id); setPickerOpen(false); }} favorites={favorites} onToggleFav={toggleFavorite} />
                  )}
                  <ModelGroup title="Google Gemini" models={grouped.google} selected={model} onSelect={(id) => { setModel(id); setPickerOpen(false); }} favorites={favorites} onToggleFav={toggleFavorite} />
                  <ModelGroup title="OpenAI GPT" models={grouped.openai} selected={model} onSelect={(id) => { setModel(id); setPickerOpen(false); }} favorites={favorites} onToggleFav={toggleFavorite} />
                </div>
              </div>
            )}
          </div>

          <label className="ml-2 inline-flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={compareMode} onChange={(e) => { setCompareMode(e.target.checked); setCompareResults(null); }} />
            <span className="font-medium">비교 모드</span>
            {compareMode && <span className="text-xs text-muted-foreground">({compareIds.length}/{MAX_COMPARE_MODELS} 선택)</span>}
          </label>

          <button onClick={() => { setMessages([]); setCompareResults(null); setError(null); }}
            className="ml-auto rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface">↺ 대화 초기화</button>
        </div>

        {/* Compare model picker */}
        {compareMode && (
          <div className="border-b border-border bg-surface px-5 py-3">
            <div className="mb-2 text-micro-up text-muted-foreground">비교할 모델 ({compareIds.length}/{MAX_COMPARE_MODELS})</div>
            <div className="flex flex-wrap gap-2">
              {AI_MODELS.map((m) => {
                const on = compareIds.includes(m.id);
                const disabled = !on && compareIds.length >= MAX_COMPARE_MODELS;
                return (
                  <button key={m.id} disabled={disabled} onClick={() => toggleCompareId(m.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-accent"} ${disabled ? "opacity-40" : ""}`}>
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto bg-background px-5 py-6">
          <div className="mx-auto max-w-3xl space-y-4">
            {messages.length === 0 && (
              <div className="rounded-3xl border border-border bg-card p-10 text-center">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary text-3xl font-bold text-primary-foreground">?</div>
                <h2 className="mt-4 text-xl font-bold">어떤 수업을 함께 설계해 볼까요?</h2>
                <p className="mt-2 text-sm text-muted-foreground">학년·교과·단원과 이번 차시 주제를 자유롭게 알려주세요.</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-card border border-border"}`}>
                  {m.role === "assistant" && m.model && m.model !== "compare" && (
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{m.model}</div>
                  )}
                  {m.content}
                </div>
              </div>
            ))}
            {busy && <div className="text-sm text-muted-foreground">생성 중…</div>}
            {error && <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-card px-5 py-4">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={2} placeholder="메시지를 입력하세요 (Shift+Enter 줄바꿈)"
              className="flex-1 resize-none rounded-2xl border border-input bg-background px-4 py-3 text-sm outline-none focus:border-ring" />
            <button onClick={send} disabled={busy || !input.trim()}
              className="rounded-2xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              보내기
            </button>
          </div>
        </div>
      </div>

      {/* Right panel — compare results & system prompt */}
      <aside className="hidden border-l border-border bg-surface lg:flex lg:flex-col">
        <div className="border-b border-border px-5 py-4">
          <div className="text-micro-up text-muted-foreground">시스템 프롬프트</div>
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4}
            className="mt-2 w-full resize-none rounded-xl border border-input bg-background p-2 text-xs leading-relaxed outline-none focus:border-ring" />
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="text-micro-up text-muted-foreground">{compareMode ? "비교 결과" : "선택한 모델"}</div>
          {!compareMode ? (
            <div className="mt-3 rounded-2xl border border-border bg-card p-4">
              <div className="text-sm font-semibold">{AI_MODELS.find((m) => m.id === model)?.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{model}</div>
              <p className="mt-3 text-xs leading-relaxed text-foreground/70">{AI_MODELS.find((m) => m.id === model)?.description}</p>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {compareResults?.map((r) => {
                const m = AI_MODELS.find((x) => x.id === r.modelId);
                return (
                  <div key={r.modelId} className="rounded-2xl border border-border bg-card p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold">{m?.label ?? r.modelId}</div>
                      <div className="text-[10px] text-muted-foreground">{r.latencyMs}ms</div>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      in {r.usage?.inputTokens ?? "—"} · out {r.usage?.outputTokens ?? "—"}
                    </div>
                    <div className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-background p-2 text-[11px] leading-relaxed">
                      {r.ok ? r.text : <span className="text-destructive">에러: {r.error}</span>}
                    </div>
                  </div>
                );
              }) ?? <div className="text-xs text-muted-foreground">메시지를 보내면 결과가 여기에 표시됩니다.</div>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function ModelGroup({ title, models, selected, onSelect, favorites, onToggleFav }: {
  title: string; models: ModelInfo[]; selected: string;
  onSelect: (id: string) => void; favorites: string[]; onToggleFav: (id: string) => void;
}) {
  if (models.length === 0) return null;
  return (
    <div>
      <div className="px-1 pb-1 text-micro-up text-muted-foreground">{title}</div>
      <div className="space-y-1">
        {models.map((m) => (
          <div key={m.id} className={`flex items-start gap-2 rounded-xl px-2 py-2 hover:bg-accent ${selected === m.id ? "bg-accent" : ""}`}>
            <button onClick={() => onToggleFav(m.id)} className="mt-0.5 text-base leading-none">
              {favorites.includes(m.id) ? "★" : "☆"}
            </button>
            <button onClick={() => onSelect(m.id)} className="flex-1 text-left">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{m.label}</span>
                <ModelBadge model={m} />
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{m.description}</div>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
