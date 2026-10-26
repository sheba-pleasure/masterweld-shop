import { createFileRoute } from "@tanstack/react-router";

// Protected by the WEBMASTER_DIAG_KEY secret sent in the x-diag-key header.
export const Route = createFileRoute("/api/public/webmaster-diagnostics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expected = process.env["WEBMASTER_DIAG_KEY"];
        const given = request.headers.get("x-diag-key");
        if (!expected || !given || given !== expected) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const { runWebmasterDiagnostics } = await import("@/lib/yandex-webmaster.server");
        const url = new URL(request.url);
        const executedFrom = `app server (${url.host}), cf-ray=${request.headers.get("cf-ray") ?? "n/a"}`;
        const result = await runWebmasterDiagnostics(executedFrom);
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
