import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "관리자 · 교수·학습 과정안 도우미" }] }),
  beforeLoad: () => {
    throw redirect({ href: "/legacy/admin.html" });
  },
  component: () => null,
});
