import { createClient } from "@supabase/supabase-js";
import { tg } from "../bot/telegram.server";
import { dispatchOne, type NotificationJob, type NotificationStore } from "./notifications.server";
import type { StaffMember } from "../bot/permissions";

export function notificationsEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env["ORDER_NOTIFICATIONS_ENABLED"] !== "true") return false;
  if (
    env["APP_ENV"] !== "dev" ||
    env["TELEGRAM_ENABLED"] !== "true" ||
    env["TELEGRAM_BOT_USERNAME"] !== "testmw639bot" ||
    env["TELEGRAM_BOT_ID"] !== "8996533708"
  ) {
    throw new Error("NOTIFICATION_ENVIRONMENT_MISMATCH");
  }
  return true;
}

export function createNotificationStore(): NotificationStore {
  // Independent server-only schema: not generated Cloud types. Runtime identity is checked before startup.
  const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    },
  });
  return {
    async claim() {
      const { data, error } = await db.rpc("claim_order_notification");
      if (error) throw new Error("NOTIFICATION_CLAIM_FAILED");
      return (data?.[0] ?? null) as NotificationJob | null;
    },
    async staff(id) {
      const { data, error } = await db
        .from("staff")
        .select("telegram_id,name,role,active,elevated")
        .eq("telegram_id", id)
        .maybeSingle();
      if (error) throw new Error("NOTIFICATION_STAFF_READ_FAILED");
      return data as StaffMember | null;
    },
    async order(id) {
      const { data, error } = await db
        .from("shop_orders")
        .select("id,total,status")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error("NOTIFICATION_ORDER_READ_FAILED");
      return data;
    },
    async finish(job, outcome) {
      const { data, error } = await db
        .from("order_notifications")
        .update({ ...outcome, reason: outcome.reason ?? null, updated_at: new Date().toISOString() })
        .eq("order_id", job.order_id)
        .eq("staff_telegram_id", job.staff_telegram_id)
        .eq("claim_token", job.claim_token)
        .eq("state", "sending")
        .select("order_id");
      if (error || data?.length !== 1) throw new Error("NOTIFICATION_ACK_FAILED");
      if (outcome.state === "failed" || outcome.state === "uncertain") {
        console.error("[order-notifications] review required", {
          state: outcome.state,
          reason: outcome.reason,
        });
      }
    },
  };
}

export function startOrderNotifications() {
  if (!notificationsEnabled(process.env)) return;
  const store = createNotificationStore();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const tick = async () => {
    try {
      for (let n = 0; n < 5 && !stopped; n++) {
        const found = await dispatchOne(store, async (message) => {
          const result = await (await tg("sendMessage", message)).json();
          return result?.result?.message_id;
        });
        if (!found) break;
      }
    } catch {
      // No payload, token, customer/staff data or provider response in logs.
      console.error("[order-notifications] worker failed; durable state retained");
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, 2000);
        timer.unref();
      }
    }
  };
  void tick();
}
