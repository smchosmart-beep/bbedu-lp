// Legacy stub: original Firebase fn persisted HWPX + metadata to Storage/Firestore.
// We just acknowledge so the client download flow completes without errors.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/lessonplan/save")({
  server: {
    handlers: {
      POST: async () => Response.json({ ok: true }),
    },
  },
});
