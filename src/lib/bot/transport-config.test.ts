import { describe, expect, it } from "vitest";
import { telegramConfig } from "./transport-config";
const direct = {
  APP_ENV: "dev",
  TELEGRAM_TRANSPORT: "direct",
  TELEGRAM_BOT_TOKEN: "12345:abcdefghijklmnopqrstuvwxyz",
  TELEGRAM_BOT_ID: "12345",
  TELEGRAM_WEBHOOK_SECRET: "a".repeat(40),
};
describe("environment-specific Telegram transport", () => {
  it("uses the direct bot and independent webhook secret", () => {
    expect(telegramConfig(direct).baseUrl).toBe(
      "https://api.telegram.org/bot" + direct.TELEGRAM_BOT_TOKEN,
    );
    expect(telegramConfig(direct).secret).toBe(direct.TELEGRAM_WEBHOOK_SECRET);
  });
  it("rejects legacy connector credentials even without APP_ENV", () => {
    expect(() => telegramConfig({ LOVABLE_API_KEY: "x", TELEGRAM_API_KEY: "y" })).toThrow(
      "TELEGRAM_TRANSPORT_REQUIRED",
    );
    expect(() => telegramConfig({ ...direct, TELEGRAM_TRANSPORT: "lovable" })).toThrow(
      "TELEGRAM_TRANSPORT_REQUIRED",
    );
  });
  it("never falls back to Cloud in dev", () =>
    expect(() =>
      telegramConfig({ APP_ENV: "dev", LOVABLE_API_KEY: "x", TELEGRAM_API_KEY: "y" }),
    ).toThrow());
  it("rejects a token for another bot", () =>
    expect(() => telegramConfig({ ...direct, TELEGRAM_BOT_ID: "999" })).toThrow());
  it("rejects disabled delivery", () =>
    expect(() => telegramConfig({ ...direct, TELEGRAM_ENABLED: "false" })).toThrow());
  it("rejects absent independent webhook secret", () =>
    expect(() => telegramConfig({ ...direct, TELEGRAM_WEBHOOK_SECRET: "" })).toThrow());
});
