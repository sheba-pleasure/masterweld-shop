export function validateEnvironment(manifest, env) {
  const fail = (code) => {
    throw new Error(code);
  };
  if (!["dev", "production"].includes(env.APP_ENV)) fail("APP_ENV_REQUIRED");
  if (manifest.environment !== env.APP_ENV) fail("BUILD_ENVIRONMENT_MISMATCH");
  if (!/^[0-9a-f-]{36}$/.test(env.MW_INSTANCE_ID || "")) fail("INSTANCE_ID_REQUIRED");
  if (env.PUBLIC_ORIGIN !== manifest.origin) fail("PUBLIC_ORIGIN_MISMATCH");
  if (env.SUPABASE_PUBLISHABLE_KEY !== manifest.publicKey) fail("PUBLIC_KEY_MISMATCH");
  if (
    !env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY === env.SUPABASE_PUBLISHABLE_KEY
  )
    fail("SERVICE_KEY_REQUIRED");
  if (!env.SUPABASE_URL) fail("DATABASE_URL_REQUIRED");
  if (!["true", "false"].includes(env.TELEGRAM_ENABLED)) fail("TELEGRAM_MODE_REQUIRED");
  if (!["true", "false"].includes(env.ORDER_NOTIFICATIONS_ENABLED ?? "false")) fail("NOTIFICATION_MODE_INVALID");
  if (env.APP_ENV === "production" && env.TELEGRAM_ENABLED !== "true")
    fail("PRODUCTION_BOT_REQUIRED");
  if (env.TELEGRAM_ENABLED === "true") {
    if (env.TELEGRAM_TRANSPORT !== "direct") fail("DIRECT_TELEGRAM_REQUIRED");
    if (!/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN || ""))
      fail("BOT_TOKEN_REQUIRED");
    if (env.TELEGRAM_BOT_TOKEN.split(":")[0] !== env.TELEGRAM_BOT_ID) fail("BOT_ID_MISMATCH");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || ""))
      fail("WEBHOOK_SECRET_REQUIRED");
    if (env.APP_ENV === "dev" && !/test|dev/i.test(env.TELEGRAM_BOT_USERNAME || ""))
      fail("DEV_BOT_MUST_HAVE_TEST_NAME");
  }
  const customerMode = env.CUSTOMER_TELEGRAM_ENABLED ?? "false";
  if (!["true", "false"].includes(customerMode)) fail("CUSTOMER_TELEGRAM_MODE_REQUIRED");
  if (customerMode === "true") {
    if (env.TELEGRAM_TRANSPORT !== "direct") fail("DIRECT_TELEGRAM_REQUIRED");
    const token = env.CUSTOMER_TELEGRAM_BOT_TOKEN || "";
    if (
      !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(token) ||
      token.split(":")[0] !== env.CUSTOMER_TELEGRAM_BOT_ID
    )
      fail("CUSTOMER_BOT_ID_MISMATCH");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.CUSTOMER_TELEGRAM_WEBHOOK_SECRET || ""))
      fail("CUSTOMER_WEBHOOK_SECRET_REQUIRED");
    if (!/^[A-Za-z0-9_]+bot$/i.test(env.CUSTOMER_TELEGRAM_BOT_USERNAME || ""))
      fail("CUSTOMER_BOT_USERNAME_REQUIRED");
    if (
      env.CUSTOMER_TELEGRAM_BOT_ID === env.TELEGRAM_BOT_ID ||
      env.CUSTOMER_TELEGRAM_WEBHOOK_SECRET === env.TELEGRAM_WEBHOOK_SECRET
    )
      fail("BOT_ROLES_MUST_BE_SEPARATE");
    if (env.APP_ENV === "dev" && !/test|dev/i.test(env.CUSTOMER_TELEGRAM_BOT_USERNAME || ""))
      fail("DEV_CUSTOMER_BOT_MUST_HAVE_TEST_NAME");
    if (env.APP_ENV === "production" && /test|dev/i.test(env.CUSTOMER_TELEGRAM_BOT_USERNAME || ""))
      fail("PRODUCTION_CUSTOMER_BOT_REQUIRED");
  }
  return true;
}

export function validateIdentity(identity, env) {
  if (identity?.environment !== env.APP_ENV || identity?.instanceId !== env.MW_INSTANCE_ID)
    throw new Error("DATABASE_ENVIRONMENT_MISMATCH");
}
