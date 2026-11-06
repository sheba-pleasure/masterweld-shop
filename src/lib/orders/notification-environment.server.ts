import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

const CONTROL = "/run/mw-workers/active.json";
const DEV_INSTANCE = "3a6a67bc-5ce6-46a4-af72-e6ab78800e49";

export function notificationsEnabled(env: NodeJS.ProcessEnv): boolean {
  const enabled = env["ORDER_NOTIFICATIONS_ENABLED"] ?? "false";
  if (!["true", "false"].includes(enabled)) throw new Error("NOTIFICATION_MODE_INVALID");
  if (enabled === "false") return false;
  const production = env["APP_ENV"] === "production";
  const id = production ? "8861999166" : "8996533708";
  const username = production ? "masterweldermanagerbot" : "testmw639bot";
  if (
    !["dev", "production"].includes(env["APP_ENV"] ?? "") ||
    env["TELEGRAM_ENABLED"] !== "true" ||
    env["TELEGRAM_TRANSPORT"] !== "direct" ||
    env["TELEGRAM_BOT_USERNAME"] !== username ||
    env["TELEGRAM_BOT_ID"] !== id ||
    env["TELEGRAM_BOT_TOKEN"]?.split(":")[0] !== id
  ) throw new Error("NOTIFICATION_ENVIRONMENT_MISMATCH");
  if (production && (
    env["PUBLIC_ORIGIN"] !== "https://shop.masterweld.ru" ||
    env["SUPABASE_URL"] !== "http://mw-prod-api:8080" ||
    !env["MW_INSTANCE_ID"] || env["MW_INSTANCE_ID"] === DEV_INSTANCE ||
    !/^[0-9a-f]{40}$/.test(env["RELEASE_SHA"] ?? "") ||
    !["a", "b"].includes(env["MW_RELEASE_SLOT"] ?? "")
  )) throw new Error("NOTIFICATION_PRODUCTION_RELEASE_REQUIRED");
  return true;
}

export function readWorkerControl(): unknown {
  const fd = openSync(CONTROL, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 || (stat.mode & 0o022)) throw new Error("UNSAFE_CONTROL");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

// A standby release never claims work. Missing/malformed control pauses it.
// A previously claimed in-flight send may finish; its durable receipt must not be replayed.
export function notificationWorkerActive(
  env: NodeJS.ProcessEnv,
  read: () => unknown = readWorkerControl,
): boolean {
  if (!notificationsEnabled(env)) return false;
  if (env["APP_ENV"] === "dev") return true;
  try {
    const control = read();
    return !!control && typeof control === "object" &&
      "sha" in control && control.sha === env["RELEASE_SHA"] &&
      "slot" in control && control.slot === env["MW_RELEASE_SLOT"];
  } catch {
    return false;
  }
}
