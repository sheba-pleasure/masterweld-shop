/**
 * Explicit live DEV integration. Incoming updates are simulated; all DB work
 * and sendMessage deliveries are real. Only acknowledgement of synthetic
 * callback IDs is stubbed: Telegram cannot acknowledge a nonexistent click.
 * Never call this a Telegram-client/UI test.
 * Usage: bun ops/dev/verify-order-flow.ts <order UUID> <DEV QA E2E buyer name>
 */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { TgUpdate } from "../../src/lib/bot/handler.server";

const orderId = process.argv[2] ?? "";
const buyer = process.argv[3] ?? "";
assert.match(orderId, /^[0-9a-f-]{36}$/);
assert.match(buyer, /^DEV QA E2E-[A-Z0-9-]+$/);
const path = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(path).mode & 0o077, 0);
for (const line of readFileSync(path, "utf8").split("\n")) {
  const at = line.indexOf("=");
  if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1);
}
assert.equal(process.env.APP_ENV, "dev");
assert.equal(process.env.TELEGRAM_BOT_USERNAME, "testmw639bot");
assert.equal(process.env.PUBLIC_ORIGIN, "https://masterweld-dev.138-124-106-211.sslip.io");
// Host-run integration reaches the same isolated REST service through Caddy.
process.env.SUPABASE_URL = process.env.PUBLIC_ORIGIN + "/backend";
const { supabaseAdmin } = await import("../../src/integrations/supabase/client.server");
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const { processClaimedUpdate } = await import("../../src/lib/bot/webhook-processing");
const meResponse = await fetch(
  "https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN + "/getMe",
);
const me = await meResponse.json();
assert.equal(me.ok, true);
assert.equal(me.result.username, "testmw639bot");
assert.equal(String(me.result.id), process.env.TELEGRAM_BOT_ID);
const identity = await supabaseAdmin.rpc("mw_environment_identity" as never);
assert.equal(identity.error, null);
assert.deepEqual(identity.data, {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const actor = 7540652678; // Explicitly authorized owner/test chat, never a recipient list.
const staff = await supabaseAdmin
  .from("staff")
  .select("role,active")
  .eq("telegram_id", actor)
  .single();
assert.equal(staff.error, null);
assert.equal(staff.data?.active, true);
assert.equal(staff.data?.role, "admin");
const order = await supabaseAdmin
  .from("shop_orders")
  .select("id,name,status")
  .eq("id", orderId)
  .single();
assert.equal(order.error, null);
assert.equal(order.data?.name, buyer);
assert.equal(order.data?.status, "new", "Only a fresh, browser-created QA order may be changed");

type Delivered = {
  text?: string;
  reply_markup?: { inline_keyboard?: { text: string; callback_data: string }[][] };
};
const delivered: Delivered[] = [];
let keyboardAccepted = false;
let ackStubs = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/bot")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (
      url.endsWith("/answerCallbackQuery") &&
      String(body.callback_query_id).startsWith("mw-dev-qa-")
    ) {
      ackStubs++;
      return Response.json({ ok: true, result: true });
    }
    if (url.endsWith("/sendMessage"))
      assert.equal(body.chat_id, actor, "Never send to another chat");
    const response = await originalFetch(input, init);
    const data = await response.clone().json();
    assert.equal(data.ok, true, "Telegram delivery must succeed");
    if (url.endsWith("/sendMessage")) {
      assert.equal(body.chat_id, actor, "Never send to another chat");
      delivered.push(data.result);
      if (body.reply_markup?.is_persistent === true) keyboardAccepted = true;
    }
    return response;
  }
  return originalFetch(input, init);
}) as typeof fetch;
let sequence = Date.now() * 10;
const claimStore = {
  claim: async (update_id: number) => {
    const { error } = await supabaseAdmin.from("telegram_updates").insert({ update_id });
    return { error };
  },
};
async function run(update: TgUpdate) {
  const result = await processClaimedUpdate(update.update_id, claimStore, () =>
    handleUpdate(update),
  );
  assert.equal(result.status, 200);
  assert.equal((await result.json()).ok, true);
}
function message(text: string): TgUpdate {
  return {
    update_id: ++sequence,
    message: { text, from: { id: actor }, chat: { id: actor, type: "private" } },
  };
}
function callback(data: string): TgUpdate {
  return {
    update_id: ++sequence,
    callback_query: {
      id: "mw-dev-qa-" + sequence,
      data,
      from: { id: actor },
      message: { chat: { id: actor, type: "private" } },
    },
  };
}
function latestButton(value: string) {
  const button = delivered
    .at(-1)
    ?.reply_markup?.inline_keyboard?.flat()
    .find((b) => b.callback_data === value);
  assert.ok(button, "Expected action must be present in the actual Telegram response");
  return button.callback_data;
}
try {
  await run(message("/menu"));
  assert.equal(keyboardAccepted, true);
  await run(callback("deliveries"));
  assert.match(delivered.at(-1)?.text ?? "", /Уведомления/);
  await run(message("🧾 Заказы"));
  await run(callback(latestButton("order:" + orderId)));
  assert.match(delivered.at(-1)?.text ?? "", /МСК/);
  const transition = callback(latestButton("st:" + orderId + ":processing"));
  await run(transition);
  const finalOrder = await supabaseAdmin
    .from("shop_orders")
    .select("status")
    .eq("id", orderId)
    .single();
  assert.equal(finalOrder.data?.status, "processing");
  assert.match(delivered.at(-1)?.text ?? "", /в обработке/);
  const beforeReplay = delivered.length;
  const duplicate = await processClaimedUpdate(transition.update_id, claimStore, () =>
    handleUpdate(transition),
  );
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(delivered.length, beforeReplay, "Replay must not repeat delivery");
  const events = await supabaseAdmin
    .from("order_events")
    .select("to_status,staff_telegram_id")
    .eq("order_id", orderId);
  assert.equal(events.error, null);
  assert.equal(events.data?.length, 1);
  assert.equal(events.data?.[0].to_status, "processing");
  const report = {
    checkedAt: new Date().toISOString(),
    order: "#" + orderId.slice(0, 8),
    orderId,
    status: "processing",
    actualTelegramMessages: delivered.length,
    persistentKeyboardAccepted: keyboardAccepted,
    auditEvents: events.data.length,
    duplicateRejected: true,
    incomingUpdates: "simulated",
    syntheticCallbackAcknowledgements: ackStubs,
    telegramClientUiVerified: false,
  };
  writeFileSync(
    new URL("../.state/dev/artifacts/order-flow.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  globalThis.fetch = originalFetch;
}
