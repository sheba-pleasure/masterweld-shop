export type BotRole = "staff" | "customer";

export function telegramConfig(
  source: Record<string, string | undefined>,
  role: BotRole = "staff",
) {
  const env =
    role === "staff"
      ? source
      : {
          TELEGRAM_ENABLED: source.CUSTOMER_TELEGRAM_ENABLED ?? "false",
          TELEGRAM_TRANSPORT: source.TELEGRAM_TRANSPORT,
          TELEGRAM_BOT_TOKEN: source.CUSTOMER_TELEGRAM_BOT_TOKEN,
          TELEGRAM_BOT_ID: source.CUSTOMER_TELEGRAM_BOT_ID,
          TELEGRAM_WEBHOOK_SECRET: source.CUSTOMER_TELEGRAM_WEBHOOK_SECRET,
        };
  if (
    role === "customer" &&
    (env.TELEGRAM_BOT_ID === source.TELEGRAM_BOT_ID ||
      env.TELEGRAM_WEBHOOK_SECRET === source.TELEGRAM_WEBHOOK_SECRET)
  )
    throw new Error("TELEGRAM_ROLES_MUST_BE_SEPARATE");
  if (env.TELEGRAM_ENABLED === "false") throw new Error("TELEGRAM_DISABLED");
  if (env.TELEGRAM_TRANSPORT !== "direct") throw new Error("TELEGRAM_TRANSPORT_REQUIRED");
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
    botId: token.split(":")[0]!,
    baseUrl: `https://api.telegram.org/bot${token}`,
    headers: {} as Record<string, string>,
    secret,
  };
}
