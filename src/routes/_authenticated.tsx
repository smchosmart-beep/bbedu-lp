import { createFileRoute, Outlet, redirect, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isCurrentUserAdmin } from "@/lib/admin.functions";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/auth" });
  },
  component: AuthLayout,
});

function AuthLayout() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    void isCurrentUserAdmin().then((v) => setIsAdmin(Boolean(v))).catch(() => setIsAdmin(false));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) void router.navigate({ to: "/auth" });
    });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  async function logout() {
    await supabase.auth.signOut();
    void router.navigate({ to: "/" });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border bg-card px-6 py-3">
        <Link to="/" className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground text-sm font-bold">?</div>
          <span className="text-sm font-semibold">교수·학습 과정안 도우미</span>
        </Link>
        <nav className="ml-6 flex items-center gap-1 text-sm">
          <Link to="/chat" activeProps={{ className: "bg-accent text-accent-foreground" }}
            className="rounded-full px-3 py-1.5 text-muted-foreground hover:text-foreground">챗봇</Link>
          {isAdmin && (
            <Link to="/admin" activeProps={{ className: "bg-accent text-accent-foreground" }}
              className="rounded-full px-3 py-1.5 text-muted-foreground hover:text-foreground">관리자</Link>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {email && <span className="hidden sm:inline">{email}</span>}
          <button onClick={logout} className="rounded-full border border-border px-3 py-1.5 hover:bg-surface">로그아웃</button>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
