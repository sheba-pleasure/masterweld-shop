import { describe, expect, it, vi } from "vitest";
import {
  dispatchOne,
  notificationMessage,
  type NotificationJob,
  type NotificationOutcome,
  type NotificationStore,
} from "./notifications.server";
import { TelegramDeliveryError } from "../bot/telegram.server";
import type { StaffMember } from "../bot/permissions";
import { notificationsEnabled } from "./notification-worker.server";

const order = { id: "10000000-0000-4000-8000-000000000001", total: 900, status: "new" };
function fixture(role: StaffMember["role"] = "seller") {
  let state = "pending";
  const job: NotificationJob = {
    order_id: order.id,
    staff_telegram_id: 42,
    claim_token: "claim",
    attempts: 1,
  };
  const member: StaffMember = {
    telegram_id: 42,
    name: "staff",
    role,
    elevated: false,
    active: true,
  };
  const store: NotificationStore = {
    claim: vi.fn(async () => {
      if (state !== "pending") return null;
      state = "sending";
      return job;
    }),
    order: vi.fn(async () => ({ ...order })),
    staff: vi.fn(async () => member),
    finish: vi.fn(async (_job, result) => {
      state = result.state;
    }),
  };
  return { store, job, member, state: () => state };
}
describe("durable order notifications", () => {
  it.each(["admin", "director", "seller"] as const)(
    "notifies active %s without elevating rights",
    async (role) => {
      const f = fixture(role);
      const send = vi.fn(async () => 12);
      await dispatchOne(f.store, send);
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: 42,
          reply_markup: { inline_keyboard: [[{ callback_data: "order:" + order.id }]] },
        }),
      );
      expect(f.store.finish).toHaveBeenCalledWith(f.job, {
        state: "sent",
        telegram_message_id: 12,
      });
    },
  );
  it("concurrent/repeated workers cannot reuse a claimed job", async () => {
    const f = fixture();
    const send = vi.fn(async () => 12);
    await Promise.all([dispatchOne(f.store, send), dispatchOne(f.store, send)]);
    await dispatchOne(f.store, send);
    expect(send).toHaveBeenCalledOnce();
  });
  it.each(["inactive", "missing", "different", "group", "unknown_role"])(
    "denies %s at dispatch",
    async (kind) => {
      const f = fixture();
      const send = vi.fn(async () => 12);
      if (kind === "inactive") f.member.active = false;
      if (kind === "missing") vi.mocked(f.store.staff).mockResolvedValue(null);
      if (kind === "different") f.member.telegram_id = 77;
      if (kind === "group") f.job.staff_telegram_id = -42;
      if (kind === "unknown_role") f.member.role = "viewer" as StaffMember["role"];
      await dispatchOne(f.store, send);
      expect(send).not.toHaveBeenCalled();
      expect(f.state()).toBe("skipped");
    },
  );
  it("already processed order does not trigger a stale new-order alert", async () => {
    const f = fixture();
    vi.mocked(f.store.order).mockResolvedValue({ ...order, status: "processing" });
    const send = vi.fn(async () => 12);
    await dispatchOne(f.store, send);
    expect(send).not.toHaveBeenCalled();
    expect(f.state()).toBe("skipped");
  });
  it("failure before send can be retried, with bounded attempts", async () => {
    const f = fixture();
    vi.mocked(f.store.staff).mockRejectedValue(new Error("offline"));
    const send = vi.fn(async () => 12);
    await dispatchOne(f.store, send, 0);
    expect(f.state()).toBe("pending");
    f.job.attempts = 3;
    await dispatchOne(f.store, send, 0);
    expect(f.state()).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    new TelegramDeliveryError("network", true),
    new TelegramDeliveryError("http", true, 503),
    new TelegramDeliveryError("protocol", false, 200),
  ])("uncertain delivery is retained, never retried", async (error) => {
    const f = fixture();
    const send = vi.fn().mockRejectedValue(error);
    await dispatchOne(f.store, send);
    await dispatchOne(f.store, send);
    expect(f.state()).toBe("uncertain");
    expect(send).toHaveBeenCalledOnce();
  });
  it("successful Telegram send followed by DB failure is not resent", async () => {
    const f = fixture();
    vi.mocked(f.store.finish).mockRejectedValue(new Error("db down"));
    const send = vi.fn(async () => 12);
    await expect(dispatchOne(f.store, send)).rejects.toThrow("db down");
    await dispatchOne(f.store, send);
    expect(send).toHaveBeenCalledOnce();
    expect(f.state()).toBe("sending");
  });
  it("429 honors retry_after, then stops at the third rejected attempt", async () => {
    const f = fixture();
    const send = vi.fn().mockRejectedValue(new TelegramDeliveryError("http", true, 429, 300));
    await dispatchOne(f.store, send, 0);
    expect(f.store.finish).toHaveBeenCalledWith(f.job, {
      state: "pending",
      reason: "rate_limit",
      available_at: "1970-01-01T00:05:00.000Z",
    });
    f.job.attempts = 3;
    await dispatchOne(f.store, send, 300000);
    expect(f.state()).toBe("failed");
  });
  it("permanent rejection and 429 without valid delay are not retried", async () => {
    for (const status of [403, 429]) {
      const f = fixture();
      const send = vi.fn().mockRejectedValue(new TelegramDeliveryError("http", false, status));
      await dispatchOne(f.store, send);
      expect(f.state()).toBe("failed");
    }
  });
  it("does not disclose shopper name, phone, items or costs in the notification", () => {
    const message = notificationMessage(order, 42);
    expect(message.text).toContain("#10000000");
    expect(message.text).toContain("900");
    expect(Object.keys(message)).toEqual(["chat_id", "text", "reply_markup"]);
  });
  it("worker is opt-in and refuses production or another bot", () => {
    expect(notificationsEnabled({ APP_ENV: "dev" })).toBe(false);
    const env = {
      ORDER_NOTIFICATIONS_ENABLED: "true",
      APP_ENV: "dev",
      TELEGRAM_ENABLED: "true",
      TELEGRAM_BOT_USERNAME: "testmw639bot",
      TELEGRAM_BOT_ID: "8996533708",
    };
    expect(notificationsEnabled(env)).toBe(true);
    expect(() => notificationsEnabled({ ...env, APP_ENV: "production" })).toThrow();
    expect(() => notificationsEnabled({ ...env, TELEGRAM_BOT_USERNAME: "otherbot" })).toThrow();
  });
});
