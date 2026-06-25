import { createFileRoute, Link } from "@tanstack/react-router";

const STAGES = [
  { num: "01", title: "기본 정보", desc: "학년·교과·단원·차시 학습 내용을 대화로 정리합니다.", tint: "bg-tint-cream" },
  { num: "02", title: "성취기준 · 핵심 아이디어", desc: "교육과정 원문을 RAG로 가져와 차시에 맞는 성취기준을 골라요.", tint: "bg-tint-sky" },
  { num: "03", title: "탐구 질문 · 학습 목표", desc: "수업의 큰 질문과 도달할 학습 목표를 함께 설계합니다.", tint: "bg-tint-lavender" },
  { num: "04", title: "교수·학습 모형 · 활동 흐름", desc: "모형 단계에 맞춘 활동 세트를 추천받고 고릅니다.", tint: "bg-tint-mint" },
  { num: "05", title: "도입 · 전개 · 정리 활동", desc: "각 단계의 교사·학생 활동, 자료, 시간을 차근차근 채웁니다.", tint: "bg-tint-peach" },
  { num: "06", title: "평가 · 피드백 · HWPX 출력", desc: "수행 평가 기준과 피드백까지 마치고 한글 양식으로 내려받아요.", tint: "bg-tint-rose" },
];

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "질문이 있는 교수·학습 과정안 도우미" },
      { name: "description", content: "2022 개정 교육과정 기반 교수·학습 과정안 설계 AI 도우미. 다양한 LLM을 직접 비교하며 사용할 수 있습니다." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero — dark navy band */}
      <header className="bg-[var(--brand-navy)] text-white">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground font-bold">?</div>
            <div className="text-sm font-semibold tracking-tight">교수·학습 과정안 도우미</div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link to="/auth" className="rounded-full px-4 py-2 text-white/80 hover:text-white">로그인</Link>
            <Link to="/chat" className="rounded-full bg-primary px-5 py-2 font-medium hover:bg-primary/90">시작하기</Link>
          </div>
        </nav>

        <div className="mx-auto max-w-7xl px-6 pb-28 pt-16 md:pt-24 lg:pt-28">
          <p className="text-micro-up text-white/60">2026 서울특별시북부교육지원청 · AI 수업 설계</p>
          <h1 className="text-hero mt-6 max-w-4xl">
            질문으로 시작하는
            <br />
            <span className="text-primary">교수·학습 과정안</span> 설계
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-white/70">
            2022 개정 교육과정 데이터를 바탕으로, 챗봇이 6단계 흐름을 따라 한 차시 수업을 함께 설계합니다.
            Google Gemini와 OpenAI GPT 시리즈를 자유롭게 갈아끼우며 결과를 비교해 보세요.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link to="/chat" className="rounded-full bg-primary px-7 py-3.5 text-base font-semibold text-primary-foreground hover:bg-primary/90">
              지금 설계 시작하기 →
            </Link>
            <Link to="/auth" className="rounded-full border border-white/20 px-7 py-3.5 text-base font-semibold text-white hover:bg-white/10">
              로그인 / 가입
            </Link>
          </div>
        </div>
      </header>

      {/* Workflow */}
      <section className="mx-auto max-w-7xl px-6 py-24">
        <div className="mb-12 flex items-end justify-between gap-6">
          <div>
            <p className="text-micro-up text-muted-foreground">6단계 워크플로</p>
            <h2 className="text-display-lg mt-3 max-w-3xl">대화로 한 단계씩 채워가는 한 차시 과정안</h2>
          </div>
          <p className="hidden max-w-sm text-muted-foreground md:block">
            각 단계마다 챗봇이 필요한 정보를 묻고, 교육과정 원문에서 후보를 추려 제시합니다.
          </p>
        </div>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {STAGES.map((s) => (
            <article key={s.num} className={`${s.tint} rounded-3xl p-7 transition hover:-translate-y-1 hover:shadow-lg`}>
              <div className="text-micro-up text-foreground/60">Step {s.num}</div>
              <h3 className="mt-3 text-xl font-semibold leading-snug">{s.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-foreground/70">{s.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Model selector callout */}
      <section className="bg-surface">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 py-24 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="text-micro-up text-muted-foreground">모델 비교 모드</p>
            <h2 className="text-display-lg mt-3">같은 질문, 17개 LLM의 답을 한눈에</h2>
            <p className="mt-5 text-lg text-muted-foreground">
              Google Gemini 7종, OpenAI GPT 10종 — 챗봇 화면에서 모델을 자유롭게 바꾸거나
              최대 6개를 동시에 호출해 응답·토큰·지연 시간을 비교할 수 있습니다.
            </p>
            <Link to="/chat" className="mt-8 inline-flex items-center gap-2 rounded-full bg-foreground px-6 py-3 text-sm font-semibold text-background hover:opacity-90">
              비교 모드 열기 →
            </Link>
          </div>
          <div className="rounded-3xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 border-b border-border pb-3 text-sm text-muted-foreground">
              <div className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <div className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <div className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-3">model-compare.chat</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {[
                ["Gemini 3 Flash", "bg-tint-sky"],
                ["GPT-5.5", "bg-tint-lavender"],
                ["Gemini 2.5 Pro", "bg-tint-mint"],
                ["GPT-5.4 Mini", "bg-tint-peach"],
              ].map(([name, tint]) => (
                <div key={name} className={`${tint} rounded-2xl p-4 text-sm`}>
                  <div className="font-semibold">{name}</div>
                  <div className="mt-1 text-xs text-foreground/60">출력 · 토큰 · 지연 비교</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-muted-foreground">
          <div>© 2026 서울특별시북부교육지원청 · 교수·학습 과정안 도우미</div>
          <div className="flex gap-5">
            <Link to="/chat" className="hover:text-foreground">챗봇</Link>
            <Link to="/auth" className="hover:text-foreground">로그인</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
