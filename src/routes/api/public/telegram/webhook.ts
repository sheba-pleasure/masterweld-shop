import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { processClaimedUpdate } from "@/lib/bot/webhook-processing";

function safeEqual(a: string, b: string) {
  const l = Buffer.from(a),
    r = Buffer.from(b);
  return l.length === r.length && timingSafeEqual(l, r);
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env["TELEGRAM_API_KEY"];
        if (!key) return new Response("Not configured", { status: 500 });
        const expected = createHash("sha256").update(`telegram-webhook:${key}`).digest("base64url");
        if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", expected)) {
          return new Response("Unauthorized", { status: 401 });
        }
        let update;
        try {
          update = await request.json();
        } catch {
          return new Response("Invalid update", { status: 400 });
        }
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0)
          return new Response("Invalid update", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        return processClaimedUpdate(
          update.update_id,
          {
            claim: async (id) => supabaseAdmin.from("telegram_updates").insert({ update_id: id }),
          },
          async () => {
            const { handleUpdate } = await import("@/lib/bot/handler.server");
            await handleUpdate(update);
          },
        );
      },
    },
  },
});
