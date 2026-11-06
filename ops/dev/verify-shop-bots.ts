/** Real DEV transport/storage; incoming Telegram Updates and callback acknowledgements are simulated. */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
const envPath = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(envPath).mode & 0o077, 0);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const p = line.indexOf("=");
  if (p > 0) process.env[line.slice(0, p)] = line.slice(p + 1);
}
const origin = process.env["PUBLIC_ORIGIN"];
assert.equal(origin, "https://masterweld-dev.138-124-106-211.sslip.io");
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["TELEGRAM_BOT_USERNAME"], "testmw639bot");
assert.equal(process.env["TELEGRAM_BOT_ID"], "8996533708");
process.env["SUPABASE_URL"] = origin + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
const identity = await db.rpc("mw_environment_identity" as never);
assert.deepEqual(identity.data, {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const actor = 7540652678;
const member = await db.from("staff").select("active,role").eq("telegram_id", actor).single();
assert.deepEqual(member.data, { active: true, role: "admin" });
const { tg } = await import("../../src/lib/bot/telegram.server");
assert.equal((await (await tg("getMe", {})).json()).result.username, "testmw639bot");
let seq = Date.now();
const update = {
  update_id: ++seq,
  message: { from: { id: actor }, chat: { id: actor, type: "private" }, text: "/shop" },
};
async function post(body: unknown) {
  const r = await fetch(origin + "/api/public/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": process.env["TELEGRAM_WEBHOOK_SECRET"]!,
    },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200);
  return r.json();
}
assert.equal((await post(update)).ok, true);
assert.equal((await post(update)).duplicate, true);
const rows = await db
  .from("shop_orders")
  .select("id,status,name")
  .eq("name", "DEV QA Telegram Mirror")
  .order("created_at", { ascending: false })
  .limit(1);
assert.equal(rows.error, null);
assert.equal(rows.data?.length, 1);
const order = rows.data![0]!;
const flowPath = new URL("../.state/dev/artifacts/telegram-shop-flow.json", import.meta.url);
const flow = JSON.parse(readFileSync(flowPath, "utf8"));
assert.ok(flow.confirmation.includes("#" + order.id.slice(0, 8)));
assert.ok(["new", "processing"].includes(order.status));
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  if (String(input).endsWith("/answerCallbackQuery") && String(init?.body).includes("mw-mirror-qa"))
    return Promise.resolve(Response.json({ ok: true, result: true }));
  return originalFetch(input, init);
}) as typeof fetch;
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const { claimBotUpdate } = await import("../../src/lib/bot/claim.server");
const { processClaimedUpdate } = await import("../../src/lib/bot/webhook-processing");
const callback = {
  update_id: ++seq,
  callback_query: {
    id: "mw-mirror-qa",
    data: "st:" + order.id + ":processing",
    from: { id: actor },
    message: { chat: { id: actor, type: "private" } },
  },
};
async function apply() {
  return processClaimedUpdate(
    callback.update_id,
    { claim: (id) => claimBotUpdate("8996533708", id, "staff") },
    () => handleUpdate(callback),
  );
}
if (order.status === "new") {
  assert.equal((await apply()).status, 200);
  assert.equal((await (await apply()).json()).duplicate, true);
}
const result = await db.from("shop_orders").select("status").eq("id", order.id).single();
assert.equal(result.data?.status, "processing");
const events = await db
  .from("order_events")
  .select("id", { count: "exact", head: true })
  .eq("order_id", order.id);
assert.equal(events.error, null);
assert.equal(events.count, 1);
flow.orderId = order.id;
flow.staffStatus = "processing";
flow.singleStatusEvent = true;
flow.webhookDuplicateSuppressed = true;
writeFileSync(
  new URL("../.state/dev/artifacts/telegram-shop-staff.json", import.meta.url),
  JSON.stringify(flow),
);
console.log(
  JSON.stringify({
    orderNumber: "#" + order.id.slice(0, 8),
    status: "processing",
    singleEvent: true,
    shopButtonDelivered: true,
    duplicateSuppressed: true,
    telegramClient: false,
  }),
);
