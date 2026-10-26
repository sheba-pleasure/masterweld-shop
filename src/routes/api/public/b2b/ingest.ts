import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/b2b/ingest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleIngestion } = await import("@/lib/b2b/endpoint.server");
        return handleIngestion(request, {
          token: process.env["B2B_INGEST_TOKEN"],
          liveEnabled: false,
        });
      },
    },
  },
});
