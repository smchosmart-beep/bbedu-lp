// Legacy stub: session-start was a fire-and-forget analytics ping.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/lessonplan/session-start")({
  server: {
    handlers: {
      POST: async () => Response.json({ ok: true }),
    },
  },
});
