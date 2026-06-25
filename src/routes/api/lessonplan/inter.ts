// Legacy stub: Interactions API (stateful). Not used by production app35.js path,
// kept so any client that probes /inter doesn't 404.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/lessonplan/inter")({
  server: {
    handlers: {
      POST: async () =>
        Response.json(
          { error: "Interactions API는 이 환경에서 비활성입니다. /api/lessonplan/chat 을 사용하세요." },
          { status: 501 },
        ),
    },
  },
});
