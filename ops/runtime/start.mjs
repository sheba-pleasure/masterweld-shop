import { readFileSync } from "node:fs";
import { validateEnvironment, validateIdentity } from "./environment.mjs";
let notifications;
try {
  const env = process.env;
  const manifest = JSON.parse(
    readFileSync(new URL("../../.output/mw-environment.json", import.meta.url), "utf8"),
  );
  validateEnvironment(manifest, env);
  const response = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/mw_environment_identity", {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("DATABASE_IDENTITY_UNAVAILABLE");
  validateIdentity(await response.json(), env);
  if (env.TELEGRAM_ENABLED === "true") {
    const response = await fetch(
      "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getMe",
      { signal: AbortSignal.timeout(10000) },
    );
    const data = await response.json();
    if (
      !response.ok ||
      data.ok !== true ||
      String(data.result.id) !== env.TELEGRAM_BOT_ID ||
      data.result.username !== env.TELEGRAM_BOT_USERNAME
    )
      throw new Error("TELEGRAM_IDENTITY_MISMATCH");
  }
  if (env.CUSTOMER_TELEGRAM_ENABLED === "true") {
    const response = await fetch(
      "https://api.telegram.org/bot" + env.CUSTOMER_TELEGRAM_BOT_TOKEN + "/getMe",
      { signal: AbortSignal.timeout(10000) },
    );
    const data = await response.json();
    if (
      !response.ok ||
      data.ok !== true ||
      String(data.result.id) !== env.CUSTOMER_TELEGRAM_BOT_ID ||
      data.result.username !== env.CUSTOMER_TELEGRAM_BOT_USERNAME
    )
      throw new Error("CUSTOMER_TELEGRAM_IDENTITY_MISMATCH");
  }
  if (env.ORDER_NOTIFICATIONS_ENABLED === "true") {
    notifications = await import("../../.output/order-notifications.mjs");
    notifications.notificationsEnabled(env);
    if (env.APP_ENV === "production") {
      const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getWebhookInfo", {
        signal: AbortSignal.timeout(10000), redirect: "error",
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true || data.result?.url !== env.PUBLIC_ORIGIN + "/api/public/telegram/webhook") {
        throw new Error("NOTIFICATION_WEBHOOK_CUTOVER_REQUIRED");
      }
    }
  }
  console.info("[startup] environment and database identity verified:", env.APP_ENV);
} catch (error) {
  const safe =
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "ENVIRONMENT_CHECK_FAILED";
  console.error("[startup]", safe);
  process.exit(1);
}
await import("../../.output/server/index.mjs");
notifications?.startOrderNotifications();
