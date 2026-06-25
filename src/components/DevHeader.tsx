import { Link } from "@tanstack/react-router";

export function DevHeader({ active }: { active: "chat" | "admin" | null }) {
  return (
    <>
      <div className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900">
        개발 모드 — 인증 우회 중 (배포 전 복구 필요)
      </div>
      <header className="flex items-center gap-3 border-b border-border bg-card px-6 py-3">
        <Link to="/" className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground text-sm font-bold">?</div>
          <span className="text-sm font-semibold">교수·학습 과정안 도우미</span>
        </Link>
        <nav className="ml-6 flex items-center gap-1 text-sm">
          <Link
            to="/chat"
            className={`rounded-full px-3 py-1.5 ${active === "chat" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            챗봇
          </Link>
          <Link
            to="/admin"
            className={`rounded-full px-3 py-1.5 ${active === "admin" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            관리자
          </Link>
        </nav>
      </header>
    </>
  );
}
