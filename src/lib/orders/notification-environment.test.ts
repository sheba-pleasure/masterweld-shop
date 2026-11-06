import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  notificationsEnabled,
  notificationWorkerActive,
  readWorkerControl,
} from "./notification-environment.server";
import { dispatchNotificationBatch } from "./notification-worker.server";
import type { NotificationStore } from "./notifications.server";

const production = {
  ORDER_NOTIFICATIONS_ENABLED: "true",
  APP_ENV: "production",
  TELEGRAM_ENABLED: "true",
  TELEGRAM_TRANSPORT: "direct",
  TELEGRAM_BOT_USERNAME: "masterweldermanagerbot",
  TELEGRAM_BOT_ID: "8861999166",
  TELEGRAM_BOT_TOKEN: "8861999166:" + "fake".repeat(8),
  PUBLIC_ORIGIN: "https://shop.masterweld.ru",
  SUPABASE_URL: "http://mw-prod-api:8080",
  MW_INSTANCE_ID: "isolated-production-fixture",
  RELEASE_SHA: "a".repeat(40),
  MW_RELEASE_SLOT: "a",
};
describe("production notifications activation", () => {
  it("is off without explicit opt-in and does not read the control file", () => {
    const read = vi.fn();
    expect(notificationWorkerActive({}, read)).toBe(false);
    expect(
      notificationWorkerActive({ ...production, ORDER_NOTIFICATIONS_ENABLED: "false" }, read),
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["ORDER_NOTIFICATIONS_ENABLED", "yes"],
    ["APP_ENV", "dev"],
    ["TELEGRAM_ENABLED", "false"],
    ["TELEGRAM_TRANSPORT", "lovable"],
    ["TELEGRAM_BOT_ID", "9168738475"],
    ["TELEGRAM_BOT_USERNAME", "msvarbot"],
    ["TELEGRAM_BOT_TOKEN", "8996533708:" + "fake".repeat(8)],
    ["PUBLIC_ORIGIN", "https://masterweld-dev.138-124-106-211.sslip.io"],
    ["SUPABASE_URL", "http://mw-dev-api:8080"],
    ["MW_INSTANCE_ID", "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"],
    ["RELEASE_SHA", "short"],
    ["MW_RELEASE_SLOT", ""],
  ])("refuses mismatched %s before claiming", (key, value) => {
    expect(() => notificationsEnabled({ ...production, [key]: value })).toThrow();
  });
  it("only the exact active slot AND SHA may claim, including rollback to an older version", () => {
    const old = { ...production, MW_RELEASE_SLOT: "b", RELEASE_SHA: "b".repeat(40) };
    let control: unknown = { slot: "a", sha: production.RELEASE_SHA };
    const read = () => control;
    expect(notificationWorkerActive(production, read)).toBe(true);
    expect(notificationWorkerActive(old, read)).toBe(false);
    control = {};
    expect(notificationWorkerActive(production, read)).toBe(false);
    expect(notificationWorkerActive(old, read)).toBe(false);
    control = { slot: "b", sha: old.RELEASE_SHA };
    expect(notificationWorkerActive(production, read)).toBe(false);
    expect(notificationWorkerActive(old, read)).toBe(true);
    expect(notificationWorkerActive({ ...old, MW_RELEASE_SLOT: "a" }, read)).toBe(false);
  });
  it.each([null, [], {}, { slot: "a" }, { slot: "a", sha: "other" }])(
    "invalid control pauses claims: %j",
    (control) => {
      expect(notificationWorkerActive(production, () => control)).toBe(false);
    },
  );
  it("unreadable/missing control pauses without changing pending jobs", () => {
    expect(
      notificationWorkerActive(production, () => {
        throw new Error("offline");
      }),
    ).toBe(false);
  });
});

describe("control file safety", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "mw-worker-control-"));
    dirs.push(dir);
    const path = join(dir, "active.json");
    writeFileSync(path, JSON.stringify({ slot: "a", sha: production.RELEASE_SHA }), {
      mode: 0o644,
    });
    return { dir, path, read: () => readWorkerControl(path) };
  }
  it("reads an ordinary owner-writable file", () => {
    const f = fixture();
    expect(notificationWorkerActive(production, f.read)).toBe(true);
  });
  it.each(["symlink", "writable", "oversize", "malformed", "directory"])(
    "rejects %s control",
    (kind) => {
      const f = fixture();
      if (kind === "symlink") {
        const link = join(f.dir, "link");
        symlinkSync(f.path, link);
        f.read = () => readWorkerControl(link);
      } else if (kind === "writable") chmodSync(f.path, 0o666);
      else if (kind === "oversize") writeFileSync(f.path, " ".repeat(257));
      else if (kind === "malformed") writeFileSync(f.path, "{");
      else f.read = () => readWorkerControl(f.dir);
      expect(notificationWorkerActive(production, f.read)).toBe(false);
    },
  );
});

describe("worker switching during a batch", () => {
  it("standby never claims; in-flight finishes once and old worker does not claim the next order", async () => {
    let active = false;
    const store: NotificationStore = {
      claim: vi.fn(async () => ({
        order_id: "order",
        staff_telegram_id: 42,
        claim_token: "token",
        attempts: 1,
      })),
      order: vi.fn(async () => ({ id: "order", total: 10, status: "new" })),
      staff: vi.fn(async () => ({
        telegram_id: 42,
        name: "fixture",
        role: "seller",
        active: true,
        elevated: false,
      })),
      finish: vi.fn(async () => {}),
    };
    const send = vi.fn(async () => {
      active = false;
      return 123;
    });
    await dispatchNotificationBatch(store, send, () => active);
    expect(store.claim).not.toHaveBeenCalled();
    active = true;
    await dispatchNotificationBatch(store, send, () => active);
    await dispatchNotificationBatch(store, send, () => active);
    expect(store.claim).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), {
      state: "sent",
      telegram_message_id: 123,
    });
  });
});
