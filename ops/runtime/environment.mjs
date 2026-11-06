export function validateEnvironment(manifest, env) {
  const fail = (code) => { throw new Error(code); };
  if (!["dev", "production"].includes(env.APP_ENV)) fail("APP_ENV_REQUIRED");
  if (manifest.environment !== env.APP_ENV) fail("BUILD_ENVIRONMENT_MISMATCH");
  if (!/^[0-9a-f-]{36}$/.test(env.MW_INSTANCE_ID || "")) fail("INSTANCE_ID_REQUIRED");
  if (env.PUBLIC_ORIGIN !== manifest.origin) fail("PUBLIC_ORIGIN_MISMATCH");
  if (env.SUPABASE_PUBLISHABLE_KEY !== manifest.publicKey) fail("PUBLIC_KEY_MISMATCH");
  if (!env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY === env.SUPABASE_PUBLISHABLE_KEY)
    fail("SERVICE_KEY_REQUIRED");
  if (!env.SUPABASE_URL) fail("DATABASE_URL_REQUIRED");
  if (!["true", "false"].includes(env.TELEGRAM_ENABLED)) fail("TELEGRAM_MODE_REQUIRED");
  if (env.APP_ENV === "production" && env.TELEGRAM_ENABLED !== "true") fail("PRODUCTION_BOT_REQUIRED");
  if (env.TELEGRAM_ENABLED === "true") {
    if (env.TELEGRAM_TRANSPORT !== "direct") fail("DIRECT_TELEGRAM_REQUIRED");
    if (!/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN || "")) fail("BOT_TOKEN_REQUIRED");
    if (env.TELEGRAM_BOT_TOKEN.split(":")[0] !== env.TELEGRAM_BOT_ID) fail("BOT_ID_MISMATCH");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || "")) fail("WEBHOOK_SECRET_REQUIRED");
    if (env.APP_ENV === "dev" && !/test|dev/i.test(env.TELEGRAM_BOT_USERNAME || ""))
      fail("DEV_BOT_MUST_HAVE_TEST_NAME");
  }
  return true;
}

export function validateIdentity(identity, env) {
  if (identity?.environment !== env.APP_ENV || identity?.instanceId !== env.MW_INSTANCE_ID)
    throw new Error("DATABASE_ENVIRONMENT_MISMATCH");
}
