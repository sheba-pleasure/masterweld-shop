/** DEV only. Sends a template and /import menu to the owner's test-bot chat. */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
const config = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(config).mode & 0o077, 0);
for (const line of readFileSync(config, "utf8").split("\n")) {
  const p = line.indexOf("=");
  if (p > 0) process.env[line.slice(0, p)] = line.slice(p + 1);
}
const origin = process.env["PUBLIC_ORIGIN"];
assert.equal(origin, "https://masterweld-dev.138-124-106-211.sslip.io");
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["TELEGRAM_BOT_USERNAME"], "testmw639bot");
process.env["SUPABASE_URL"] = origin + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
const identity = await db.rpc("mw_environment_identity" as never);
assert.deepEqual(identity.data, {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const actor = 7540652678;
const staff = await db.from("staff").select("*").eq("telegram_id", actor).single();
assert.equal(staff.error, null);
assert.equal(staff.data?.active, true);
assert.equal(staff.data?.role, "admin");
const { tg } = await import("../../src/lib/bot/telegram.server");
const me = await (await tg("getMe", {})).json();
assert.equal(me.result.username, "testmw639bot");
const { showCatalogImport } = await import("../../src/lib/import/catalog.server");
const template = await (
  await showCatalogImport(staff.data!, { id: actor, type: "private" }, { op: "template" })
).json();
assert.equal(template.ok, true);
assert.equal(template.result.document.file_name, "import-template.csv");
assert.ok(template.result.caption.startsWith("ТЕСТОВЫЙ МАГАЗИН · DEV"));
const update = {
  update_id: Date.now(),
  message: {
    message_id: 1,
    from: { id: actor },
    chat: { id: actor, type: "private" },
    text: "/import",
  },
};
async function post() {
  const response = await fetch(origin + "/api/public/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": process.env["TELEGRAM_WEBHOOK_SECRET"]!,
    },
    body: JSON.stringify(update),
  });
  assert.equal(response.status, 200);
  return response.json();
}
assert.equal((await post()).ok, true);
const repeated = await post();
assert.equal(repeated.duplicate, true);
for (const path of ["/", "/product/dev-welder", "/import-template.csv"]) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, path);
}
console.log(
  JSON.stringify({
    templateDelivered: true,
    devCaption: true,
    webhook: true,
    duplicateSuppressed: true,
    httpPages: true,
    telegramClientUiVerified: false,
  }),
);
