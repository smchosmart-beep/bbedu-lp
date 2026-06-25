import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Legend, CartesianGrid } from "recharts";
import { getUsageStats, setDefaultModel, isCurrentUserAdmin } from "@/lib/admin.functions";
import { AI_MODELS } from "@/lib/ai-models";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ title: "관리자 · 사용량" }] }),
  component: AdminPage,
});

function AdminPage() {
  const usageFn = useServerFn(getUsageStats);
  const setModelFn = useServerFn(setDefaultModel);
  const adminFn = useServerFn(isCurrentUserAdmin);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [days, setDays] = useState(14);
  const [rows, setRows] = useState<Array<{ ts: string; model: string; prompt_tokens: number; output_tokens: number; total_tokens: number; latency_ms: number; variant: string; error: string | null }>>([]);
  const [defaultModel, setDefault] = useState(AI_MODELS[0].id);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void adminFn().then((ok) => setAllowed(Boolean(ok))).catch(() => setAllowed(false));
  }, [adminFn]);

  useEffect(() => {
    if (!allowed) return;
    void usageFn({ data: { days } })
      .then((r) => setRows(r as never))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [allowed, days, usageFn]);

  const byDay = useMemo(() => {
    const map = new Map<string, { day: string; calls: number; tokens: number }>();
    for (const r of rows) {
      const day = r.ts.slice(0, 10);
      const cur = map.get(day) || { day, calls: 0, tokens: 0 };
      cur.calls += 1; cur.tokens += r.total_tokens || 0;
      map.set(day, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [rows]);

  const byModel = useMemo(() => {
    const map = new Map<string, { model: string; calls: number; tokens: number; avgLatency: number; totalLatency: number; errors: number }>();
    for (const r of rows) {
      const cur = map.get(r.model) || { model: r.model, calls: 0, tokens: 0, avgLatency: 0, totalLatency: 0, errors: 0 };
      cur.calls += 1;
      cur.tokens += r.total_tokens || 0;
      cur.totalLatency += r.latency_ms || 0;
      if (r.error) cur.errors += 1;
      map.set(r.model, cur);
    }
    const arr = Array.from(map.values()).map((m) => ({ ...m, avgLatency: m.calls > 0 ? Math.round(m.totalLatency / m.calls) : 0 }));
    return arr.sort((a, b) => b.calls - a.calls);
  }, [rows]);

  async function save() {
    setSavedMsg(null); setError(null);
    try {
      await setModelFn({ data: { modelId: defaultModel } });
      setSavedMsg("기본 모델이 저장되었습니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (allowed === null) return <div className="p-10 text-sm text-muted-foreground">권한 확인 중…</div>;
  if (!allowed) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-bold">관리자 권한이 필요합니다</h1>
        <p className="mt-3 text-muted-foreground">관리자에게 권한 부여를 요청해 주세요.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-micro-up text-muted-foreground">관리자</p>
          <h1 className="text-display-lg mt-2">사용량 대시보드</h1>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm text-muted-foreground">기간</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-input bg-background px-3 py-1.5 text-sm">
            <option value={7}>7일</option>
            <option value={14}>14일</option>
            <option value={30}>30일</option>
            <option value={90}>90일</option>
          </select>
        </div>
      </div>

      {error && <div className="mt-6 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}

      <section className="mt-8 rounded-3xl border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">기본 모델</h2>
        <p className="mt-1 text-sm text-muted-foreground">새 챗봇 호출에서 사용자가 모델을 지정하지 않을 때 적용됩니다.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <select value={defaultModel} onChange={(e) => setDefault(e.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm">
            {AI_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.id})</option>)}
          </select>
          <button onClick={save} className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground">저장</button>
          {savedMsg && <span className="text-xs text-emerald-600">{savedMsg}</span>}
        </div>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-3xl border border-border bg-card p-6">
          <h3 className="text-sm font-semibold">일별 호출 수</h3>
          <div className="mt-4 h-64">
            <ResponsiveContainer>
              <LineChart data={byDay}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="day" stroke="var(--muted-foreground)" fontSize={11} />
                <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                <Tooltip />
                <Line type="monotone" dataKey="calls" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-3xl border border-border bg-card p-6">
          <h3 className="text-sm font-semibold">일별 토큰 사용량</h3>
          <div className="mt-4 h-64">
            <ResponsiveContainer>
              <BarChart data={byDay}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="day" stroke="var(--muted-foreground)" fontSize={11} />
                <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                <Tooltip />
                <Legend />
                <Bar dataKey="tokens" fill="var(--chart-2)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-3xl border border-border bg-card p-6">
        <h3 className="text-sm font-semibold">모델별 통계</h3>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2">모델</th>
                <th className="py-2">호출</th>
                <th className="py-2">총 토큰</th>
                <th className="py-2">평균 지연(ms)</th>
                <th className="py-2">오류</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((m) => (
                <tr key={m.model} className="border-b border-border/60">
                  <td className="py-2 font-medium">{m.model}</td>
                  <td className="py-2">{m.calls}</td>
                  <td className="py-2">{m.tokens.toLocaleString()}</td>
                  <td className="py-2">{m.avgLatency}</td>
                  <td className="py-2">{m.errors}</td>
                </tr>
              ))}
              {byModel.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">아직 데이터가 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
