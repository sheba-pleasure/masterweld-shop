import { createFileRoute } from "@tanstack/react-router";
import { receiveTelegramWebhook } from "@/lib/bot/webhook.server";

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: { handlers: { POST: ({ request }) => receiveTelegramWebhook(request, "staff") } },
});
