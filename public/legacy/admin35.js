/* 관리자 대시보드 — 모델 설정 · 비용 추적 · HWPX 목록.
   인증은 서버(adminAuth)가 한다. 클라는 비밀번호를 sessionStorage에 보관하고
   모든 요청에 x-admin-pass 헤더로 실어 보낸다(틀리면 서버가 401). */
const PASS_KEY = "lp_admin_pass";
const $ = (id) => document.getElementById(id);

function getPass() { return sessionStorage.getItem(PASS_KEY) || ""; }

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", "x-admin-pass": getPass(), ...(opts.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error("unauthorized"); }
  return res;
}

/* ── 로그인 ── */
function showLogin() { $("login").classList.remove("hidden"); $("dash").classList.add("hidden"); }
function showDash() { $("login").classList.add("hidden"); $("dash").classList.remove("hidden"); }
function logout() { sessionStorage.removeItem(PASS_KEY); showLogin(); }

async function tryLogin(pw) {
  const res = await fetch("/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json", "x-admin-pass": pw },
    body: "{}",
  });
  return res.ok;
}

/* ── 모델: /35는 gemini-3.5-flash 코드 고정 ──
   전역 모델 설정(config/app.geminiModel)을 바꾸면 메인(/)에도 영향가므로, 이 관리자에는 모델 변경 UI를 두지 않는다.
   환율(rate)은 loadCosts가 채운다. */

/* ── 비용 (기간·단위 다양화) ── */
let costChart = null;
let RAWCOSTS = { byDay: {}, krwPerUsd: 1500 };           // 서버가 준 일별(모델 중첩) 원자료
function won(usd) { return "₩" + Math.round((usd || 0) * (RAWCOSTS.krwPerUsd || 1500)).toLocaleString(); }
// KST 기준 N일 전(0=오늘)의 날짜 문자열
function kstDay(offsetDays) {
  return new Date(Date.now() + 9 * 3600 * 1000 - (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}
function bucketKey(day, gran) {
  if (gran === "month") return day.slice(0, 7);           // YYYY-MM
  if (gran === "week") {                                   // 주 시작(월요일) 날짜
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10) + "~";
  }
  return day;                                             // 일별
}

async function loadCosts() {
  RAWCOSTS = await (await api("/admin/costs?variant=v35")).json();
  $("rate").textContent = (RAWCOSTS.krwPerUsd || 1500).toLocaleString();
  renderCosts();
}

// 선택한 기간·단위로 byDay에서 합계·모델별·차트를 모두 다시 계산.
function renderCosts() {
  const byDay = RAWCOSTS.byDay || {};
  const period = $("periodSel").value;                    // all|30|7|1
  const gran = $("granSel").value;                        // day|week|month
  const from = period === "all" ? null : kstDay(parseInt(period) - 1); // 오늘 포함 N일
  const days = Object.keys(byDay).filter((d) => d !== "?" && (!from || d >= from)).sort();

  const tot = { usd: 0, calls: 0, tokens: 0, sessions: 0, plans: 0 };
  const byModel = {};
  days.forEach((d) => {
    const bd = byDay[d];
    tot.usd += bd.usd; tot.calls += bd.calls; tot.tokens += bd.tokens; tot.sessions += bd.sessions || 0; tot.plans += bd.plans || 0;
    Object.entries(bd.models || {}).forEach(([m, v]) => {
      const o = (byModel[m] = byModel[m] || { usd: 0, calls: 0, tokens: 0, prompt: 0, output: 0 });
      o.usd += v.usd; o.calls += v.calls; o.tokens += v.tokens;
      o.prompt += v.prompt || 0; o.output += v.output || 0;
    });
  });
  $("cTotalKrw").textContent = won(tot.usd);
  $("cCalls").textContent = tot.calls.toLocaleString();
  $("cTokens").textContent = tot.tokens.toLocaleString();
  $("cAvg").textContent = won(tot.plans ? tot.usd / tot.plans : 0);   // 과정안 1건당 평균(총비용 ÷ 완성 과정안 수)
  $("cSessions").textContent = tot.sessions.toLocaleString();

  // 모델별 표(선택 기간) — prompt/output 분해와 단가 출처 명시
  const tb = $("byModelBody"); tb.innerHTML = "";
  const totalUsd = Object.values(byModel).reduce((s, v) => s + v.usd, 0);
  Object.entries(byModel).sort((a, b) => b[1].usd - a[1].usd).forEach(([m, v]) => {
    const tr = document.createElement("tr"); tr.className = "border-b border-slate-50";
    const pp = (v.prompt || 0).toLocaleString();
    const oo = (v.output || 0).toLocaleString();
    const pct = totalUsd > 0 ? Math.round((v.usd / totalUsd) * 100) : 0;
    tr.innerHTML = `<td class="py-1.5 px-2 font-mono text-[11px]">${esc(m)}</td>
      <td class="text-right px-2">${v.calls.toLocaleString()}</td>
      <td class="text-right px-2 text-slate-500">${pp}</td>
      <td class="text-right px-2 text-slate-500">${oo}</td>
      <td class="text-right px-2 font-medium text-brand-600">${won(v.usd)}</td>
      <td class="text-right px-2 text-slate-400">${pct}%</td>`;
    tb.appendChild(tr);
  });

  // 단계별 표 (stage × model 합산) — 라우팅 효과 추적
  const STAGE_LABEL = {
    "1": "기초정보(교과·학년·단원)", "2": "성취기준", "3": "핵심아이디어", "4": "교과역량",
    "5": "탐구질문", "6": "평가(백워드)", "7": "학습목표/주제", "8": "교수학습모형",
    "9": "전개 활동 세트", "10": "본문(교사/학생활동)", "11": "수업자의도",
    "99": "검수(LLM)", "100": "최종 검토", "?": "(stage 미부착)",
  };
  const stageTb = $("byStageBody");
  if (stageTb) {
    stageTb.innerHTML = "";
    const byStage = RAWCOSTS.byStage || {};
    const totalStageUsd = Object.values(byStage).reduce((s, v) => s + v.usd, 0);
    const FIXED_STAGES = ["1","2","3","4","5","6","7","8","9","10","11","99","100"];
    const stageKeys = FIXED_STAGES.slice();
    if (byStage["?"]) stageKeys.push("?");
    stageKeys.forEach((sk) => {
      const v = byStage[sk] || { usd: 0, calls: 0, prompt: 0, output: 0, models: {} };
      const isEmpty = !v.calls;
      const mainModel = Object.entries(v.models || {}).sort((a, b) => b[1].calls - a[1].calls)[0];
      const mainModelName = mainModel ? mainModel[0].replace("google/", "") : "—";
      const avgKrw = v.calls > 0 ? (v.usd * (RAWCOSTS.krwPerUsd || 1500)) / v.calls : 0;
      const pct = totalStageUsd > 0 ? Math.round((v.usd / totalStageUsd) * 100) : 0;
      const tr = document.createElement("tr");
      tr.className = "border-b border-slate-50" + (isEmpty ? " text-slate-300" : "");
      const dim = isEmpty ? "text-slate-300" : "text-slate-500";
      const dimAccent = isEmpty ? "text-slate-300" : "text-brand-600";
      tr.innerHTML = `<td class="py-1.5 px-2 font-mono text-[11px]">${esc(sk)}</td>
        <td class="px-2 ${isEmpty ? "text-slate-300" : "text-slate-600"}">${esc(STAGE_LABEL[sk] || "?")}</td>
        <td class="px-2 font-mono text-[11px] ${dim}">${esc(mainModelName)}</td>
        <td class="text-right px-2">${v.calls.toLocaleString()}</td>
        <td class="text-right px-2 ${dim}">₩${Math.round(avgKrw).toLocaleString()}</td>
        <td class="text-right px-2 ${dim}">${(v.prompt || 0).toLocaleString()}</td>
        <td class="text-right px-2 ${dim}">${(v.output || 0).toLocaleString()}</td>
        <td class="text-right px-2 font-medium ${dimAccent}">${won(v.usd)}</td>
        <td class="text-right px-2 ${isEmpty ? "text-slate-300" : "text-slate-400"}">${pct}%</td>`;
      stageTb.appendChild(tr);
    });
    // 주석: stage 라벨은 호출 시점의 partialPlan 기준이며, 라우팅 규칙 변경 이전 데이터는 현재 코드와 다를 수 있음.
  }



  // 차트: 기간 내 일자를 단위(일/주/월)로 버킷팅
  const rate = RAWCOSTS.krwPerUsd || 1500;
  const buckets = {};
  days.forEach((d) => { const k = bucketKey(d, gran); buckets[k] = (buckets[k] || 0) + byDay[d].usd; });
  const labels = Object.keys(buckets).sort();
  const data = labels.map((k) => Math.round(buckets[k] * rate));
  if (costChart) costChart.destroy();
  costChart = new Chart($("costChart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "비용(₩)", data, backgroundColor: "#10b981", borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => "₩" + c.parsed.y.toLocaleString() } } },
      scales: { y: { ticks: { callback: (v) => "₩" + Number(v).toLocaleString() } } },
    },
  });
}

/* ── HWPX 목록 (정렬) ── */
const COLS = [
  { key: "createdAt", label: "생성일시", type: "num" },
  { key: "학년", label: "학년" }, { key: "학기", label: "학기" }, { key: "교과", label: "교과" },
  { key: "단원", label: "단원" }, { key: "성취기준", label: "성취기준" },
  { key: "수업주제", label: "수업주제" },
  { key: "모델", label: "대표모델" },
  { key: "krw", label: "저장시 ₩", type: "num" },
  { key: "krwLogged", label: "로그 재계산 ₩", type: "num" },
  { key: "diff", label: "격차", type: "num" },
];
let FILES = [];
let sortKey = "createdAt", sortDir = -1;

function renderHead() {
  const tr = document.createElement("tr");
  COLS.forEach((c) => {
    const th = document.createElement("th");
    th.className = "sortable text-left py-2 px-2 whitespace-nowrap";
    const arrow = sortKey === c.key ? `<span class="arrow">${sortDir === 1 ? "▲" : "▼"}</span>` : "";
    th.innerHTML = `${esc(c.label)} ${arrow}`;
    th.onclick = () => { if (sortKey === c.key) sortDir *= -1; else { sortKey = c.key; sortDir = 1; } renderFiles(); };
    tr.appendChild(th);
  });
  const thd = document.createElement("th"); thd.className = "text-right py-2 px-2"; thd.textContent = "다운로드";
  tr.appendChild(thd);
  $("fileHead").innerHTML = ""; $("fileHead").appendChild(tr);
}

// 출력 토큰 기준 사용 모델 라벨 — 단일이면 그대로, 복수면 "A + B(혼합)"
function dominantModelsLabel(f) {
  const src = f.byModelLogged || f.byModelClient || null;
  let models = [];
  if (src && typeof src === "object") {
    models = Object.entries(src)
      .map(([k, v]) => ({ id: String(k), out: Number((v && v.output) || 0) }))
      .filter((m) => m.id)
      .sort((a, b) => b.out - a.out);
  }
  if (models.length === 0) {
    const single = f.모델 ? String(f.모델) : "";
    return { label: single || "—", tip: single || "" };
  }
  const short = (id) => id.replace(/^[^/]+\//, "");
  if (models.length === 1) {
    return { label: models[0].id, tip: models[0].id };
  }
  const top2 = models.slice(0, 2).map((m) => short(m.id));
  const rest = models.length - 2;
  const head = top2.join(" + ") + (rest > 0 ? ` 외 ${rest}` : "");
  return { label: `${head}(혼합)`, tip: models.map((m) => m.id).join(", ") };
}

// 모델별 분해 툴팁 — 로그 SSoT가 있으면 그걸, 없으면 클라가 저장한 byModel을 표시
function byModelTip(f) {
  const src = f.byModelLogged || f.byModelClient || null;
  if (!src) return "(모델별 분해 없음 — 구 버전 데이터)";
  return Object.entries(src).sort((a, b) => (b[1].output || 0) - (a[1].output || 0)).map(([m, v]) => {
    const pp = Number(v.prompt || 0).toLocaleString();
    const oo = Number(v.output || 0).toLocaleString();
    const cc = Number(v.calls || 0);
    return `${m}: ${cc}콜 · 입력 ${pp} · 출력 ${oo}`;
  }).join("\n");
}

function renderFiles() {
  renderHead();
  // diff = 격차(원). 양수면 로그 SSoT가 저장값보다 큼.
  const enriched = FILES.map((f) => {
    const diff = (f.krwLogged != null) ? (Number(f.krwLogged) - Number(f.krw || 0)) : null;
    return { ...f, diff };
  });
  const col = COLS.find((c) => c.key === sortKey) || COLS[0];
  const arr = [...enriched].sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (col.type === "num") { x = Number(x || 0); y = Number(y || 0); return (x - y) * sortDir; }
    return String(x || "").localeCompare(String(y || ""), "ko") * sortDir;
  });
  const tb = $("fileBody"); tb.innerHTML = "";
  arr.forEach((f) => {
    const tr = document.createElement("tr");
    // 격차 50원 이상이면 노란 하이라이트(저장 단가 vs 콜 SSoT 불일치 — 회계 신뢰성 시각화)
    const big = f.diff != null && Math.abs(f.diff) >= 50;
    tr.className = "border-b border-slate-50 hover:bg-slate-50" + (big ? " bg-amber-50" : "");
    const dt = f.createdAt ? new Date(f.createdAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "—";
    const tk = f.토큰 || {};
    const tip = `${(f.calls || 0)}회 호출(클라 합계) · 입력 ${(tk.prompt || 0).toLocaleString()} · 출력 ${(tk.output || 0).toLocaleString()}\n\n— 모델별 분해 —\n${byModelTip(f)}\n\nrun_id: ${f.runId || "(없음)"}\n로그 매칭 콜: ${f.loggedCalls || 0}`;
    const costCell = f.krw ? `₩${Number(f.krw).toLocaleString()}` : "—";
    const loggedCell = (f.krwLogged != null)
      ? `₩${Number(f.krwLogged).toLocaleString()} <span class="text-[10px] text-slate-400">(${f.loggedCalls || 0}콜)</span>`
      : `<span class="text-slate-300">—</span>`;
    const diffCell = (f.diff != null)
      ? `<span class="${f.diff > 0 ? "text-rose-600" : f.diff < 0 ? "text-sky-600" : "text-slate-400"}">${f.diff > 0 ? "+" : ""}${f.diff.toLocaleString()}</span>`
      : `<span class="text-slate-300">—</span>`;
    const mlabel = dominantModelsLabel(f);
    tr.innerHTML =
      `<td class="py-1.5 px-2 whitespace-nowrap text-slate-500">${esc(dt)}</td>
       <td class="px-2">${esc(f.학년)}</td><td class="px-2">${esc(f.학기)}</td><td class="px-2">${esc(f.교과)}</td>
       <td class="px-2">${esc(f.단원)}</td>
       <td class="px-2 max-w-[220px] truncate" title="${esc(f.성취기준)}">${esc(f.성취기준)}</td>
       <td class="px-2 max-w-[180px] truncate" title="${esc(f.수업주제)}">${esc(f.수업주제)}</td>
       <td class="px-2 whitespace-nowrap text-slate-600" title="${esc(mlabel.tip)}">${esc(mlabel.label)}</td>
       <td class="px-2 text-right whitespace-nowrap text-slate-500" title="${esc(tip)}">${esc(costCell)}</td>
       <td class="px-2 text-right whitespace-nowrap text-brand-600 font-medium" title="${esc(tip)}">${loggedCell}</td>
       <td class="px-2 text-right whitespace-nowrap font-medium">${diffCell}</td>
       <td class="text-right px-2"></td>`;
    const btn = document.createElement("button");
    btn.className = "text-brand-600 hover:underline whitespace-nowrap";
    btn.textContent = "⬇ 받기";
    btn.onclick = () => downloadFile(f.id, f.fileName);
    tr.lastElementChild.appendChild(btn);
    tb.appendChild(tr);
  });
  $("fileCount").textContent = `(${arr.length}건)`;
  $("fileEmpty").classList.toggle("hidden", arr.length > 0);
}

async function loadFiles() {
  const d = await (await api("/admin/files?variant=v35")).json();
  FILES = d.items || [];
  renderFiles();
}

async function downloadFile(id, fileName) {
  try {
    const res = await api(`/admin/files/${id}/download`);
    if (!res.ok) throw new Error("다운로드 실패");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fileName || `${id}.hwpx`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { alert("다운로드 실패: " + e.message); }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}

// 진단 — 최근 24h ai_usage_log 기록 누락·격차 신호를 배너로 노출
async function loadDiag() {
  try {
    const d = await (await api("/admin/diag?variant=v35&hours=24")).json();
    const banner = $("diagBanner");
    if (!banner) return;
    const logRows = Number(d.logRows || 0);
    const plans = Number(d.plans || 0);
    // 최근 24h에 과정안은 생성됐는데 콜 로그가 0건이면 적색 (logUsage 인서트 실패 의심)
    if (plans > 0 && logRows === 0) {
      banner.className = "rounded-2xl px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-800";
      banner.innerHTML = `⚠ 최근 24시간 콜 로그 누락 감지 — 과정안 ${plans}건이 생성됐지만 <code>ai_usage_log</code>에 기록이 0건입니다. 비용 재계산이 동작하지 않으니 서버 로그(<code>[ai_usage_log insert failed]</code>)를 확인해 주세요.`;
      banner.classList.remove("hidden");
    } else if (logRows > 0 && plans === 0) {
      banner.classList.add("hidden");   // 콜은 있고 완성 과정안만 0건 — 정상
    } else if (logRows === 0 && plans === 0) {
      banner.classList.add("hidden");
    } else {
      banner.className = "rounded-2xl px-4 py-3 text-sm bg-emerald-50 border border-emerald-200 text-emerald-800";
      banner.innerHTML = `✓ 최근 24시간 콜 로그 ${logRows.toLocaleString()}건 · 완성 과정안 ${plans.toLocaleString()}건 (정상)`;
      banner.classList.remove("hidden");
    }
  } catch (e) { /* 무시 */ }
}

async function loadAll() {
  showDash();
  try { await Promise.all([loadCosts(), loadFiles(), loadDiag()]); }
  catch (e) { /* 401이면 logout 처리됨 */ }
}

/* ── 워크플로 / 프롬프트 문서 모달 ── */
const WORKFLOW_INTRO = `
  <div>
    <h3 class="font-semibold text-slate-800 mb-1">개요</h3>
    <p class="leading-relaxed">단일 LLM 대화 + <b>함수 호출(function calling)</b>로 과정안을 완성합니다. 정확성이 필요한 교육과정 데이터는 RAG 함수로 조회하고, 화면 표시·확정은 UI/제어 함수로 처리합니다. 이 버전(<code>/35</code>)은 <b>3-Tier 모델 라우팅</b>으로 동작합니다 — <b>PRIMARY</b> <code>gemini-3.5-flash</code> = 단계 9(전개)·10(본문), <b>MID</b> <code>gemini-3-flash-preview</code> = 단계 5·6·7·11(수업자의도)·검수(99)·최종검토(100), <b>LITE</b> <code>gemini-3-flash-preview</code>(8K) = 단계 1~4·8. 클라이언트 <code>detectStage()</code> SSoT와 서버 <code>hasStageConflict</code> 가드로 단계 충돌 시 한 tier 자동 격상, <code>MALFORMED</code>·JSON 파싱 실패 시에도 한 tier 격상으로 1회 폴백합니다. 시스템 프롬프트는 <b>CORE(상시) + STAGE_GUIDES(현재 stage ±1)</b>로 동적 조립해 입력 토큰을 약 30~40% 절감합니다. 트래픽은 <code>variant=v35</code>로 메인과 분리 집계됩니다.</p>
  </div>
  <div>
    <h3 class="font-semibold text-slate-800 mb-1">진행 흐름</h3>
    <p class="leading-relaxed text-slate-600">기본정보 → 성취기준 → 핵심 아이디어 → 교과 역량 → 탐구 질문 → 백워드 평가(영속적 이해·수용 가능한 증거·수행 과제·평가 범주/요소/방법/성취수준/피드백) → 학습목표·학습주제 → 교수·학습 모형 → 전개 활동 흐름 → 교수·학습 활동(도입/전개/정리) → 수업자 의도 → 검토·완료</p>
  </div>
  <div>
    <h3 class="font-semibold text-slate-800 mb-1">사용 함수</h3>
    <div class="overflow-x-auto">
    <table class="w-full text-[12px] border border-slate-200 rounded">
      <thead class="bg-slate-50 text-slate-500"><tr><th class="text-left px-2 py-1">함수</th><th class="text-left px-2 py-1">구분</th><th class="text-left px-2 py-1">역할</th></tr></thead>
      <tbody>
        <tr class="border-t border-slate-100"><td class="px-2 py-1 font-mono">find_standards</td><td class="px-2 py-1">RAG</td><td class="px-2 py-1">교과·학년·학기·단원으로 성취기준 후보 조회</td></tr>
        <tr class="border-t border-slate-100"><td class="px-2 py-1 font-mono">list_core_ideas</td><td class="px-2 py-1">RAG</td><td class="px-2 py-1">교과·영역 핵심 아이디어 조회</td></tr>
        <tr class="border-t border-slate-100"><td class="px-2 py-1 font-mono">list_competencies</td><td class="px-2 py-1">RAG</td><td class="px-2 py-1">교과 역량 목록 조회</td></tr>
        <tr class="border-t border-slate-100"><td class="px-2 py-1 font-mono">list_considerations</td><td class="px-2 py-1">RAG</td><td class="px-2 py-1">성취기준 적용 시 고려사항 조회</td></tr>
        <tr class="border-t border-slate-100"><td class="px-2 py-1 font-mono">list_lesson_models</td><td class="px-2 py-1">RAG</td><td class="px-2 py-1">교과별 교수·학습 모형(단계) 조회</td></tr>
        <tr class="border-t border-slate-100"><td class="px-2 py-1 font-mono">present_choices</td><td class="px-2 py-1">UI</td><td class="px-2 py-1">선택 카드 표시 → 사용자 선택 대기</td></tr>
        <tr class="border-t border-slate-100"><td class="px-2 py-1 font-mono">update_plan</td><td class="px-2 py-1">UI</td><td class="px-2 py-1">우측 미리보기 과정안 필드 갱신</td></tr>
        <tr class="border-t border-slate-100"><td class="px-2 py-1 font-mono">complete_plan</td><td class="px-2 py-1">제어</td><td class="px-2 py-1">검토(빈칸·품질 점검) 후 완료 처리</td></tr>
      </tbody>
    </table>
    </div>
  </div>
  <div>
    <h3 class="font-semibold text-slate-800 mb-1">주요 기능</h3>
    <ul class="list-disc pl-5 space-y-0.5 text-slate-600 leading-relaxed">
      <li><b>실시간 미리보기·직접 수정</b> — 오른쪽 패널에 과정안이 실시간 표시되고, 칸을 눌러 직접 고칠 수 있음</li>
      <li><b>HWPX 다운로드</b> — 완성 시 한글 문서(.hwpx) 생성(활동 수에 맞춰 템플릿 자동 선택)</li>
      <li><b>검증(🔎) 버튼</b> — 현재 과정안의 빈 칸·흐름·무의미 값을 점검해 안내</li>
      <li><b>세션 자동 저장·복원</b> — 새로고침해도 이어서 진행(localStorage)</li>
      <li><b>3-Tier 라우팅 (/35)</b> — PRIMARY <code>gemini-3.5-flash</code>(단계 9·10), MID <code>gemini-3-flash-preview</code>(단계 5·6·7·11·검수·최종검토), LITE <code>gemini-3-flash-preview</code> 8K(단계 1~4·8). 단계 충돌·MALFORMED·JSON 파싱 실패 시 한 tier 자동 격상(최대 1회). <code>FORCE_PRIMARY=true</code> 또는 <code>STAGE6_/STAGE11_/VERIFY_FORCE_PRIMARY</code>로 즉시 롤백</li>
      <li><b>동적 시스템 프롬프트</b> — CORE(상시) + STAGE_GUIDES(현재 stage ±1)만 주입해 입력 토큰 ~30~40% 절감. 회귀 시 <code>FORCE_FULL_PROMPT=true</code>로 전체 주입 복원</li>
      <li><b>완료 검토(MID 단일 호출)</b> — 검수(99)·최종검토(100)는 <code>gemini-3-flash-preview</code>로 1회 호출, JSON 파싱 실패 시에만 PRIMARY로 1회 자동 폴백. 회귀 시 <code>VERIFY_FORCE_PRIMARY=true</code>로 즉시 PRIMARY 복원</li>
      <li><b>variant 분리 집계</b> — <code>variant=v35</code>로 메인과 분리 집계</li>
      <li><b>시작 화면 자유 입력</b> — 주제뿐 아니라 수업 의도·아이디어·강조점을 적으면 설계 전반에 반영</li>
    </ul>
  </div>
  <div>
    <h3 class="font-semibold text-slate-800 mb-1">정확성 · 안전장치</h3>
    <ul class="list-disc pl-5 space-y-0.5 text-slate-600 leading-relaxed">
      <li><b>RAG로 환각 0</b> — 성취기준·핵심아이디어·교과역량·교수학습모형·고려사항은 내장 데이터에서만 제시(지어내지 않음)</li>
      <li><b>환각 키 차단</b> — 모델이 잘못된 필드 키(예: a__역량)를 만들면 무시</li>
      <li><b>반복·되돌아가기 차단</b> — 이미 확정한 항목 카드를 다시 띄우지 않음. 반복되면 안전 착지(안내 후 중단)</li>
      <li><b>생성 후보 최소 3개</b> — 탐구질문·평가방법 등 직접 생성 후보가 부족하면 재요청</li>
      <li><b>완료 검토 게이트</b> — 빈 칸·무의미 값이 있으면 완료를 막고 보완을 유도</li>
      <li><b>성취수준 긍정 진술</b> — 교육부 방식으로 '하'에도 결핍 표현(미숙·부족) 금지</li>
      <li><b>군더더기 멘트 숨김</b> — 함수 호출 동반 절차 멘트는 표시하지 않고 카드·미리보기만 노출</li>
      <li><b>LLM 오류 재시도</b> — 일시 오류 시 자동 재시도 + 상황별 한국어 안내</li>
    </ul>
  </div>
  <div>
    <h3 class="font-semibold text-slate-800 mb-1">교육과정 데이터 (RAG)</h3>
    <p class="text-slate-600 leading-relaxed">단원 마스터(성취기준·영역·단원학습내용), 교과 역량, 핵심 아이디어, 성취기준 적용 시 고려사항, 교과별 교수·학습 모형(단계)을 내장하여 2022 개정 교육과정 원문 기반으로 제시합니다. 통합교과 등 데이터가 없는 경우에만 모델이 차시 맥락에 맞게 직접 생성합니다.</p>
    <p class="text-slate-500 mt-2 mb-1">사용 중인 RAG 데이터 파일(내려받기):</p>
    <ul class="list-disc pl-5 space-y-0.5 text-slate-600 leading-relaxed">
      <li><a href="./data/lesson_units.json" download class="text-brand-600 hover:underline font-mono">lesson_units.json</a> — 단원 마스터(성취기준·영역·단원학습내용)</li>
      <li><a href="./data/achievement.json" download class="text-brand-600 hover:underline font-mono">achievement.json</a> — 성취기준 + 해설</li>
      <li><a href="./data/standard_guidance.json" download class="text-brand-600 hover:underline font-mono">standard_guidance.json</a> — 성취기준 해설·적용 시 고려사항 안내</li>
      <li><a href="./data/core_ideas.json" download class="text-brand-600 hover:underline font-mono">core_ideas.json</a> — 핵심 아이디어</li>
      <li><a href="./data/core_ideas_extended.json" download class="text-brand-600 hover:underline font-mono">core_ideas_extended.json</a> — 핵심 아이디어(확장)</li>
      <li><a href="./data/subject_competencies.json" download class="text-brand-600 hover:underline font-mono">subject_competencies.json</a> — 교과 역량</li>
      <li><a href="./data/considerations.json" download class="text-brand-600 hover:underline font-mono">considerations.json</a> — 성취기준 적용 시 고려사항</li>
      <li><a href="./data/lesson_models.json" download class="text-brand-600 hover:underline font-mono">lesson_models.json</a> — 과목별 교수·학습 모형(단계)</li>
    </ul>
  </div>
  <div>
    <h3 class="font-semibold text-slate-800 mb-1">이런 것도 합니다</h3>
    <ul class="list-disc pl-5 space-y-0.5 text-slate-600 leading-relaxed">
      <li><b>성취기준 해설·고려사항 자동 안내</b> — 성취기준을 고르면 교육과정 원문의 성취기준 해설과 적용 시 고려사항을 그 자리에서 자동 표시</li>
      <li><b>백워드 설계(UbD) 평가</b> — '학생이 무엇을 이해/할 수 있어야 하는가(영속적 이해)'부터 거꾸로 설계하고, 수용 가능한 증거·수행 과제를 거쳐 평가 계획을 구성</li>
      <li><b>모형 단계 → 전개 활동 뼈대</b> — 고른 교수·학습 모형의 단계를 활동 표 '학습 단계'에 표시하고 전개 활동 구성에 반영</li>
      <li><b>유연한 응답</b> — 선택 카드 대신 입력창에 말로 답하거나, '🔄 다른 후보 추천받기'로 새 후보를 받을 수 있음</li>
      <li><b>행정 정보 비자동</b> — 차시·교과서 쪽수·대상 학급·일시는 임의 생성하지 않고 교사가 직접 입력(오기입 방지)</li>
      <li><b>문서 품질 자동화</b> — 평가요소 명사형(~기), 자료·유의점·평가 (자)(유)(평) 약물 변환, 교사·학생 활동 위계 기호(◉◦-) 자동 정리</li>
    </ul>
  </div>`;

let workflowLoaded = false;
function openWorkflow() {
  $("workflowModal").classList.remove("hidden");
  if (!workflowLoaded) loadWorkflowDoc();
}
function closeWorkflow() { $("workflowModal").classList.add("hidden"); }

async function loadWorkflowDoc() {
  const body = $("workflowBody");
  try {
    // 실제 운영 중인 app.js에서 시스템 프롬프트 원문을 추출 → 항상 최신과 동기화
    const src = await (await fetch("./app35.js?t=" + Date.now(), { cache: "no-store" })).text();
    const m = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    const prompt = m ? m[1] : "(시스템 프롬프트를 추출하지 못했습니다)";
    body.innerHTML = WORKFLOW_INTRO +
      `<div>
        <h3 class="font-semibold text-slate-800 mb-1">실제 시스템 프롬프트 (전문 · app35.js에서 추출)</h3>
        <pre class="whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded-xl p-3 text-[12px] leading-relaxed">${esc(prompt)}</pre>
      </div>`;
    workflowLoaded = true;
  } catch (e) {
    body.innerHTML = `<p class="text-red-500">불러오기 실패: ${esc(e.message)}</p>`;
  }
}

/* ── 부트스트랩 ── */
document.addEventListener("DOMContentLoaded", () => {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("pw").value;
    $("loginErr").classList.add("hidden");
    if (await tryLogin(pw)) { sessionStorage.setItem(PASS_KEY, pw); $("pw").value = ""; loadAll(); }
    else $("loginErr").classList.remove("hidden");
  });
  $("logoutBtn").addEventListener("click", logout);
  $("refreshBtn").addEventListener("click", loadFiles);
  $("periodSel").addEventListener("change", renderCosts);
  $("granSel").addEventListener("change", renderCosts);
  $("workflowBtn").addEventListener("click", openWorkflow);
  $("workflowClose").addEventListener("click", closeWorkflow);
  $("workflowOverlay").addEventListener("click", closeWorkflow);

  // 이미 로그인되어 있으면(세션) 바로 대시보드 시도
  if (getPass()) loadAll(); else showLogin();
});
