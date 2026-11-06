/** Real DEV database and Telegram edits; incoming callbacks/acknowledgements are simulated. */
import assert from "node:assert/strict";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
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
const orderId = "19a06d36-c192-49c1-8397-ffbc38f60baf";
const member = await db.from("staff").select("active,role").eq("telegram_id", actor).single();
assert.deepEqual(member.data, { active: true, role: "admin" });
const order = await db.from("shop_orders").select("id,status,name").eq("id", orderId).single();
assert.equal(order.error, null);
assert.equal(order.data?.name, "DEV QA Telegram Mirror");
assert.equal(order.data?.status, "new", "Run once only: do not reset an already processed order");
async function eventCount() {
  const result = await db
    .from("order_events")
    .select("id", { count: "exact", head: true })
    .eq("order_id", orderId);
  assert.equal(result.error, null);
  return result.count;
}
assert.equal(await eventCount(), 0);
async function notification() {
  const result = await db
    .from("order_notifications" as never)
    .select("state,attempts,telegram_message_id")
    .eq("order_id", orderId)
    .single();
  assert.equal(result.error, null);
  return result.data;
}
const beforeNotification = await notification();
const { tg } = await import("../../src/lib/bot/telegram.server");
const me = await (await tg("getMe", {})).json();
assert.equal(me.result.id, 8996533708);
assert.equal(me.result.username, "testmw639bot");

const messages: {
  method: string;
  messageId?: number;
  text?: string;
  rows?: unknown;
  ok: boolean;
}[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  // Only callback acknowledgement is simulated; no database/edit/send call is intercepted.
  if (url.endsWith("/answerCallbackQuery") && String(init?.body).includes("mw-card-qa"))
    return Response.json({ ok: true, result: true });
  const response = await originalFetch(input, init);
  if (
    url.startsWith("https://api.telegram.org/") &&
    (url.endsWith("/sendMessage") || url.endsWith("/editMessageText"))
  ) {
    const payload = await response.clone().json();
    messages.push({
      method: url.endsWith("/editMessageText") ? "edit" : "send",
      messageId: payload.result?.message_id,
      text: payload.result?.text,
      rows: payload.result?.reply_markup,
      ok: payload.ok === true,
    });
  }
  return response;
}) as typeof fetch;
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const { claimBotUpdate } = await import("../../src/lib/bot/claim.server");
const { processClaimedUpdate } = await import("../../src/lib/bot/webhook-processing");
let seq = Date.now();
function update(data: string, messageId?: number) {
  return {
    update_id: ++seq,
    callback_query: {
      id: "mw-card-qa-" + seq,
      data,
      from: { id: actor },
      message: { message_id: messageId, chat: { id: actor, type: "private" } },
    },
  };
}
async function apply(value: ReturnType<typeof update>) {
  const response = await processClaimedUpdate(
    value.update_id,
    { claim: (id) => claimBotUpdate("8996533708", id, "staff") },
    () => handleUpdate(value),
  );
  assert.equal(response.status, 200);
  return response.json();
}
assert.equal((await apply(update("order:" + orderId))).ok, true);
const messageId = messages.at(-1)!.messageId!;
assert.ok(Number.isSafeInteger(messageId) && messageId > 0);
assert.ok(messages.at(-1)!.text?.includes("Статус: новый"));
const change = update("st:" + orderId + ":processing", messageId);
assert.equal((await apply(change)).ok, true);
assert.equal(messages.at(-1)!.method, "edit");
assert.equal(messages.at(-1)!.messageId, messageId);
assert.ok(messages.at(-1)!.text?.includes("Статус: в обработке"));
assert.ok(!JSON.stringify(messages.at(-1)!.rows).includes(":" + orderId + ":processing"));
const afterEdit = messages.length;
assert.equal((await apply(change)).duplicate, true);
assert.equal(messages.length, afterEdit);
assert.equal(await eventCount(), 1);
await apply(update("st:" + orderId + ":processing", messageId));
assert.ok(messages.at(-1)!.text?.includes("Заказ уже «в обработке»."));
assert.equal(await eventCount(), 1);
await apply(update("stc:" + orderId + ":canceled", messageId));
assert.ok(messages.at(-1)!.text?.includes("Подтвердите"));
await apply(update("order:" + orderId, messageId));
assert.ok(messages.at(-1)!.text?.includes("Статус: в обработке"));
// Same text/keyboard: Telegram rejects a no-op edit; the handler must not send another card.
await apply(update("order:" + orderId, messageId));
assert.equal(messages.at(-1)!.ok, false);
assert.equal(messages.filter((m) => m.method === "send").length, 1);
assert.ok(messages.filter((m) => m.ok).every((m) => m.messageId === messageId));
assert.equal(await eventCount(), 1);
assert.deepEqual(await notification(), beforeNotification);
const result = await db.from("shop_orders").select("status").eq("id", orderId).single();
assert.equal(result.data?.status, "processing");
const report = {
  environment: "dev",
  orderId,
  messageId,
  status: "processing",
  statusEvents: 1,
  sentCards: 1,
  successfulEdits: messages.filter((m) => m.method === "edit" && m.ok).length,
  repeatedUpdateSuppressed: true,
  staleActionNoMutation: true,
  confirmationCanceledWithoutMutation: true,
  unchangedEditNoDuplicate: true,
  originalNotificationUnchanged: true,
  incomingCallbacksSimulated: true,
  telegramClient: false,
  telegramTransport: "real",
  database: "real isolated DEV",
};
const directory = new URL("../.state/dev/artifacts/order-card-refresh-20261106/", import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(new URL("result.json", directory), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(report));
