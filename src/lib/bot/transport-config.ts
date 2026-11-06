import { createHash } from "node:crypto";

export function telegramConfig(env: Record<string, string | undefined>) {
  if (env.TELEGRAM_ENABLED === "false") throw new Error("TELEGRAM_DISABLED");
  if (env.TELEGRAM_TRANSPORT === "direct") {
    const token = env.TELEGRAM_BOT_TOKEN;
    const secret = env.TELEGRAM_WEBHOOK_SECRET;
    if (
      !token ||
      !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(token) ||
      token.split(":")[0] !== env.TELEGRAM_BOT_ID ||
      !secret ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(secret)
    )
      throw new Error("TELEGRAM_CONFIG_INVALID");
    return {
      baseUrl: `https://api.telegram.org/bot${token}`,
      headers: {} as Record<string, string>,
      secret,
    };
  }
  // Explicit environment deployments never fall back to a Cloud connection.
  if (env.APP_ENV || (env.TELEGRAM_TRANSPORT && env.TELEGRAM_TRANSPORT !== "lovable"))
    throw new Error("TELEGRAM_TRANSPORT_REQUIRED");
  const key = env.TELEGRAM_API_KEY;
  if (!key || !env.LOVABLE_API_KEY) throw new Error("TELEGRAM_CONFIG_INVALID");
  return {
    baseUrl: "https://connector-gateway.lovable.dev/telegram",
    headers: { Authorization: `Bearer ${env.LOVABLE_API_KEY}`, "X-Connection-Api-Key": key },
    secret: createHash("sha256").update(`telegram-webhook:${key}`).digest("base64url"),
  };
}
