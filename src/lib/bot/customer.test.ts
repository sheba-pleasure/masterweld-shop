import { afterEach, expect, it, vi } from "vitest";
import { customerMessage, shopUrl } from "./customer";
import { telegramConfig } from "./transport-config";
const mock = vi.hoisted(() => ({ tg: vi.fn() }));
vi.mock("./telegram.server", () => ({ tg: mock.tg }));
import { handleCustomerUpdate } from "./customer.server";
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
it("customer controls open the same HTTPS shop and never include staff actions", () => {
  const result = customerMessage("/start", "https://shop.example.test");
  expect(result.reply_markup.keyboard[0]![0]).toEqual({
    text: "🛍 Открыть магазин",
    web_app: { url: "https://shop.example.test/?miniapp=1" },
  });
  expect(JSON.stringify(result)).not.toContain("callback_data");
  expect(() => shopUrl("https://shop.example.test/evil")).toThrow();
  expect(() => shopUrl("http://shop.example.test")).toThrow();
});
it("private buyer receives a shop menu through customer transport even for staff commands", async () => {
  vi.stubEnv("PUBLIC_ORIGIN", "https://shop.example.test");
  await handleCustomerUpdate({
    update_id: 1,
    message: { from: { id: 101 }, chat: { id: 101, type: "private" }, text: "/staff" },
  });
  expect(mock.tg).toHaveBeenCalledWith(
    "sendMessage",
    expect.objectContaining({ chat_id: 101 }),
    "customer",
  );
});
it("group and forged actors never get a shop Web App or a staff lookup", async () => {
  for (const chat of [
    { id: -100, type: "group" },
    { id: 202, type: "private" },
  ])
    await handleCustomerUpdate({
      update_id: 1,
      message: { from: { id: 101 }, chat, text: "/start" },
    });
  expect(mock.tg).not.toHaveBeenCalled();
});
it("forged customer callbacks cannot invoke staff operations", async () => {
  await handleCustomerUpdate({
    update_id: 1,
    callback_query: {
      id: "cb",
      from: { id: 101 },
      data: "elevate_on",
      message: { chat: { id: 101, type: "private" } },
    },
  });
  expect(mock.tg).toHaveBeenCalledExactlyOnceWith(
    "answerCallbackQuery",
    expect.objectContaining({ callback_query_id: "cb" }),
    "customer",
  );
});
it("customer configuration never falls back to a staff token or secret", () => {
  const env = {
    TELEGRAM_TRANSPORT: "direct",
    TELEGRAM_BOT_ID: "11",
    TELEGRAM_BOT_TOKEN: "11:" + "x".repeat(30),
    TELEGRAM_WEBHOOK_SECRET: "s".repeat(40),
    CUSTOMER_TELEGRAM_ENABLED: "true",
    CUSTOMER_TELEGRAM_BOT_ID: "22",
    CUSTOMER_TELEGRAM_BOT_TOKEN: "22:" + "y".repeat(30),
    CUSTOMER_TELEGRAM_WEBHOOK_SECRET: "c".repeat(40),
  };
  expect(telegramConfig(env, "customer").botId).toBe("22");
  expect(() =>
    telegramConfig({ ...env, CUSTOMER_TELEGRAM_BOT_TOKEN: undefined }, "customer"),
  ).toThrow();
  expect(() =>
    telegramConfig(
      { ...env, CUSTOMER_TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET },
      "customer",
    ),
  ).toThrow();
  expect(() =>
    telegramConfig({ ...env, CUSTOMER_TELEGRAM_ENABLED: "false" }, "customer"),
  ).toThrow();
});
