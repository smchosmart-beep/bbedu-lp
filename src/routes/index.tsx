import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "질문이 있는 교수·학습 과정안 도우미" }] }),
  beforeLoad: () => {
    throw redirect({ href: "/legacy/index.html" });
  },
  component: () => null,
});
