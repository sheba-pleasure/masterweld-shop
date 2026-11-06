import test from "node:test";
import assert from "node:assert/strict";
import {
  validateEnvironment,
  validateIdentity,
  validateNotificationWebhook,
} from "./environment.mjs";
const manifest = { environment: "dev", origin: "https://dev.example.test", publicKey: "dev-anon" };
const env = {
  APP_ENV: "dev",
  PUBLIC_ORIGIN: manifest.origin,
  SUPABASE_PUBLISHABLE_KEY: "dev-anon",
  SUPABASE_SERVICE_ROLE_KEY: "dev-service",
  MW_INSTANCE_ID: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
  SUPABASE_URL: "http://dev-api:8080",
  TELEGRAM_ENABLED: "false",
};
const customer = {
  ...env,
  TELEGRAM_TRANSPORT: "direct",
  CUSTOMER_TELEGRAM_ENABLED: "true",
  CUSTOMER_TELEGRAM_BOT_ID: "22",
  CUSTOMER_TELEGRAM_BOT_TOKEN: "22:" + "c".repeat(30),
  CUSTOMER_TELEGRAM_BOT_USERNAME: "customer_test_bot",
  CUSTOMER_TELEGRAM_WEBHOOK_SECRET: "c".repeat(40),
};
test("separate test customer bot is valid", () =>
  assert.equal(validateEnvironment(manifest, customer), true));
test("production customer token cannot be mounted in DEV", () =>
  assert.throws(
    () =>
      validateEnvironment(manifest, { ...customer, CUSTOMER_TELEGRAM_BOT_USERNAME: "msvarbot" }),
    /DEV_CUSTOMER_BOT/,
  ));
test("customer and staff identities cannot overlap", () =>
  assert.throws(
    () => validateEnvironment(manifest, { ...customer, TELEGRAM_BOT_ID: "22" }),
    /BOT_ROLES_MUST_BE_SEPARATE/,
  ));
test("customer and staff webhook secrets cannot overlap", () =>
  assert.throws(
    () =>
      validateEnvironment(manifest, {
        ...customer,
        TELEGRAM_WEBHOOK_SECRET: customer.CUSTOMER_TELEGRAM_WEBHOOK_SECRET,
      }),
    /BOT_ROLES_MUST_BE_SEPARATE/,
  ));
test("isolated dev can run without a bot while onboarding", () =>
  assert.equal(validateEnvironment(manifest, env), true));
for (const [field, value, code] of [
  ["APP_ENV", "production", "BUILD_ENVIRONMENT_MISMATCH"],
  ["PUBLIC_ORIGIN", "https://shop.example.test", "PUBLIC_ORIGIN_MISMATCH"],
  ["SUPABASE_PUBLISHABLE_KEY", "prod-anon", "PUBLIC_KEY_MISMATCH"],
  ["SUPABASE_SERVICE_ROLE_KEY", "dev-anon", "SERVICE_KEY_REQUIRED"],
  ["TELEGRAM_ENABLED", "", "TELEGRAM_MODE_REQUIRED"],
  ["ORDER_NOTIFICATIONS_ENABLED", "yes", "NOTIFICATION_MODE_INVALID"],
])
  test("reject " + field, () =>
    assert.throws(
      () => validateEnvironment(manifest, { ...env, [field]: value }),
      new RegExp(code),
    ),
  );
test("reject production DB even with a matching URL/key", () =>
  assert.throws(() =>
    validateIdentity({ environment: "production", instanceId: env.MW_INSTANCE_ID }, env),
  ));
test("reject another dev database", () =>
  assert.throws(() => validateIdentity({ environment: "dev", instanceId: "other" }, env)));
test("accept correct DB identity", () =>
  validateIdentity({ environment: "dev", instanceId: env.MW_INSTANCE_ID }, env));
test("production notifications require the exact new staff webhook", () => {
  const alerts = {
    APP_ENV: "production",
    ORDER_NOTIFICATIONS_ENABLED: "true",
    PUBLIC_ORIGIN: "https://shop.masterweld.ru",
  };
  for (const payload of [
    null,
    { ok: false },
    { ok: true, result: { url: "" } },
    { ok: true, result: { url: "https://old.example.test/webhook" } },
    { ok: true, result: { url: alerts.PUBLIC_ORIGIN + "/api/public/telegram/customer" } },
  ])
    assert.throws(
      () => validateNotificationWebhook(payload, alerts),
      /NOTIFICATION_WEBHOOK_CUTOVER_REQUIRED/,
    );
  validateNotificationWebhook(
    { ok: true, result: { url: alerts.PUBLIC_ORIGIN + "/api/public/telegram/webhook" } },
    alerts,
  );
  validateNotificationWebhook(null, { ...alerts, ORDER_NOTIFICATIONS_ENABLED: "false" });
});
test("production cannot launch without a verified bot", () =>
  assert.throws(
    () =>
      validateEnvironment(
        { ...manifest, environment: "production" },
        { ...env, APP_ENV: "production" },
      ),
    /PRODUCTION_BOT_REQUIRED/,
  ));
