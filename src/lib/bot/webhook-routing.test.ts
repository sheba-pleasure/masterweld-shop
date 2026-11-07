import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), staff: vi.fn(), customer: vi.fn() }));
vi.mock("./claim.server", () => ({ claimBotUpdate: mocks.claim }));
vi.mock("./handler.server", () => ({ handleUpdate: mocks.staff }));
vi.mock("./customer.server", () => ({ handleCustomerUpdate: mocks.customer }));
import { receiveTelegramWebhook } from "./webhook.server";
import type { BotRole } from "./transport-config";
const staffSecret = "s".repeat(40),
  customerSecret = "c".repeat(40);
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({
    TELEGRAM_ENABLED: "true",
    TELEGRAM_TRANSPORT: "direct",
    TELEGRAM_BOT_ID: "11",
    TELEGRAM_BOT_TOKEN: "11:" + "x".repeat(30),
    TELEGRAM_WEBHOOK_SECRET: staffSecret,
    CUSTOMER_TELEGRAM_ENABLED: "true",
    CUSTOMER_TELEGRAM_BOT_ID: "22",
    CUSTOMER_TELEGRAM_BOT_TOKEN: "22:" + "y".repeat(30),
    CUSTOMER_TELEGRAM_WEBHOOK_SECRET: customerSecret,
  }))
    vi.stubEnv(key, value);
  mocks.claim.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());
const req = (secret: string, body = JSON.stringify({ update_id: 7 })) =>
  new Request("https://shop.example.test/hook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body,
  });
it.each([
  ["staff", customerSecret],
  ["customer", staffSecret],
] as [BotRole, string][])("rejects a cross-role secret on %s", async (role, secret) => {
  expect((await receiveTelegramWebhook(req(secret), role)).status).toBe(401);
  expect(mocks.claim).not.toHaveBeenCalled();
});
it("same update ID is scoped to the actual bot and routes stay separate", async () => {
  await receiveTelegramWebhook(req(staffSecret), "staff");
  await receiveTelegramWebhook(req(customerSecret), "customer");
  expect(mocks.claim.mock.calls).toEqual([
    ["11", 7, "staff"],
    ["22", 7, "customer"],
  ]);
  expect(mocks.staff).toHaveBeenCalledTimes(1);
  expect(mocks.customer).toHaveBeenCalledTimes(1);
});
it("duplicate receipt never replays either handler", async () => {
  mocks.claim.mockResolvedValue({ error: { code: "23505" } });
  expect(await (await receiveTelegramWebhook(req(customerSecret), "customer")).json()).toEqual({
    ok: true,
    duplicate: true,
  });
  expect(mocks.customer).not.toHaveBeenCalled();
});
it("malformed and oversized updates never enter storage", async () => {
  expect((await receiveTelegramWebhook(req(staffSecret, "null"), "staff")).status).toBe(400);
  expect((await receiveTelegramWebhook(req(staffSecret, " ".repeat(262145)), "staff")).status).toBe(
    413,
  );
  expect(mocks.claim).not.toHaveBeenCalled();
});
