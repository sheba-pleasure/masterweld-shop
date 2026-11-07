import { can, type StaffMember } from "../bot/permissions";
import { TelegramDeliveryError } from "../bot/telegram.server";

export interface NotificationJob {
  order_id: string;
  staff_telegram_id: number;
  claim_token: string;
  attempts: number;
}
export interface NotificationOrder {
  id: string;
  total: number;
  status: string;
}
export interface NotificationOutcome {
  state: "sent" | "skipped" | "failed" | "uncertain" | "pending";
  reason?:
    | "no_access"
    | "order_not_new"
    | "rate_limit"
    | "delivery_rejected"
    | "delivery_uncertain"
    | "read_failed";
  telegram_message_id?: number;
  available_at?: string;
}
export interface NotificationStore {
  claim(): Promise<NotificationJob | null>;
  staff(id: number): Promise<StaffMember | null>;
  order(id: string): Promise<NotificationOrder | null>;
  finish(job: NotificationJob, outcome: NotificationOutcome): Promise<void>;
}
export function notificationMessage(order: NotificationOrder, recipient: number) {
  return {
    chat_id: recipient,
    text: `🆕 Новый заказ #${order.id.slice(0, 8)}\n\n💰 Сумма: ${Math.round(Number(order.total)).toLocaleString("ru-RU")} ₽\n\n👇 Откройте заказ и возьмите его в обработку.`,
    reply_markup: {
      inline_keyboard: [[{ text: "📄 Открыть заказ", callback_data: `order:${order.id}` }]],
    },
  };
}

// Deliberately no automatic retry after timeout, 5xx, malformed success or persistence failure:
// Telegram sendMessage has no idempotency key. A repeat could send a second message.
export async function dispatchOne(
  store: NotificationStore,
  send: (message: ReturnType<typeof notificationMessage>) => Promise<number>,
  now: () => number = Date.now,
): Promise<boolean> {
  const job = await store.claim();
  if (!job) return false;
  let staff: StaffMember | null;
  let order: NotificationOrder | null;
  try {
    order = await store.order(job.order_id);
    // Read identity/authorization last, immediately before dispatch.
    staff = await store.staff(job.staff_telegram_id);
  } catch {
    await store.finish(job, {
      state: job.attempts < 3 ? "pending" : "failed",
      reason: "read_failed",
      available_at: new Date(now() + 60_000).toISOString(),
    });
    return true;
  }
  if (
    !Number.isSafeInteger(job.staff_telegram_id) ||
    job.staff_telegram_id <= 0 ||
    !staff ||
    staff.telegram_id !== job.staff_telegram_id ||
    !can(staff, "manage_orders")
  ) {
    await store.finish(job, { state: "skipped", reason: "no_access" });
    return true;
  }
  if (!order || order.status !== "new") {
    await store.finish(job, { state: "skipped", reason: "order_not_new" });
    return true;
  }
  let messageId: number;
  try {
    messageId = await send(notificationMessage(order, job.staff_telegram_id));
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("INVALID_MESSAGE_ID");
  } catch (error) {
    const knownRejection =
      error instanceof TelegramDeliveryError &&
      (error.kind === "api" || error.kind === "http") &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500;
    if (
      knownRejection &&
      error.status === 429 &&
      error.retryAfterSeconds !== undefined &&
      job.attempts < 3
    ) {
      await store.finish(job, {
        state: "pending",
        reason: "rate_limit",
        available_at: new Date(
          now() + Math.max(60, error.retryAfterSeconds ?? 60) * 1000,
        ).toISOString(),
      });
    } else {
      await store.finish(job, {
        state:
          knownRejection ||
          (error instanceof TelegramDeliveryError && error.kind === "configuration")
            ? "failed"
            : "uncertain",
        reason: knownRejection ? "delivery_rejected" : "delivery_uncertain",
      });
    }
    return true;
  }
  // Do not catch a failed acknowledgement as a reason to re-send.
  await store.finish(job, { state: "sent", telegram_message_id: messageId });
  return true;
}
