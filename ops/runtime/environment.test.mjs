import test from "node:test";
import assert from "node:assert/strict";
import { validateEnvironment, validateIdentity } from "./environment.mjs";
const manifest = { environment: "dev", origin: "https://dev.example.test", publicKey: "dev-anon" };
const env = { APP_ENV: "dev", PUBLIC_ORIGIN: manifest.origin, SUPABASE_PUBLISHABLE_KEY: "dev-anon",
  SUPABASE_SERVICE_ROLE_KEY: "dev-service", MW_INSTANCE_ID: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
  SUPABASE_URL: "http://dev-api:8080", TELEGRAM_ENABLED: "false" };
test("isolated dev can run without a bot while onboarding", () => assert.equal(validateEnvironment(manifest, env), true));
for (const [field, value, code] of [
  ["APP_ENV", "production", "BUILD_ENVIRONMENT_MISMATCH"],
  ["PUBLIC_ORIGIN", "https://shop.example.test", "PUBLIC_ORIGIN_MISMATCH"],
  ["SUPABASE_PUBLISHABLE_KEY", "prod-anon", "PUBLIC_KEY_MISMATCH"],
  ["SUPABASE_SERVICE_ROLE_KEY", "dev-anon", "SERVICE_KEY_REQUIRED"],
  ["TELEGRAM_ENABLED", "", "TELEGRAM_MODE_REQUIRED"],
]) test("reject " + field, () => assert.throws(() => validateEnvironment(manifest, {...env, [field]: value}), new RegExp(code)));
test("reject production DB even with a matching URL/key", () => assert.throws(() => validateIdentity({environment:"production",instanceId:env.MW_INSTANCE_ID},env)));
test("reject another dev database", () => assert.throws(() => validateIdentity({environment:"dev",instanceId:"other"},env)));
test("accept correct DB identity", () => validateIdentity({environment:"dev",instanceId:env.MW_INSTANCE_ID},env));
test("production cannot launch without a verified bot", () => assert.throws(() => validateEnvironment({...manifest,environment:"production"},{...env,APP_ENV:"production"}),/PRODUCTION_BOT_REQUIRED/));
