/** DEV only. Real DB and Telegram delivery to owner; incoming callbacks are simulated. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { StaffMember } from "../../src/lib/bot/permissions";
const env = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(env).mode & 0o077, 0);
for (const line of readFileSync(env, "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
const actor = 7540652678;
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["PUBLIC_ORIGIN"], origin);
assert.equal(process.env["TELEGRAM_BOT_ID"], "8996533708");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal((await (await fetch(origin + "/api/public/release-health")).json()).revision, sha);
process.env["SUPABASE_URL"] = origin + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
assert.deepEqual((await db.rpc("mw_environment_identity" as never)).data, {
  environment: "dev", instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const { can } = await import("../../src/lib/bot/permissions");
const staff = await db.from("staff").select("*").eq("active", true);
assert.equal(staff.error, null);
const sellers = (staff.data as StaffMember[]).filter((m) => m.role === "seller");
assert.equal(sellers.length, 7);
for (const seller of sellers) {
  assert.equal(can(seller, "view_costs"), true);
  for (const p of ["edit_prices", "manage_staff", "import_prices"] as const)
    assert.equal(can(seller, p), false);
}
assert.equal(staff.data?.find((m) => m.telegram_id === actor)?.role, "admin");
const publicResult = await fetch(origin + "/backend/rest/v1/product_costs?select=cost_price", {
  headers: { apikey: process.env["SUPABASE_PUBLISHABLE_KEY"]!,
    Authorization: "Bearer " + process.env["SUPABASE_PUBLISHABLE_KEY"]! },
});
assert.ok([401, 403].includes(publicResult.status) || (publicResult.ok && JSON.stringify(await publicResult.json()) === "[]"));
const costs = await db.from("product_costs").select("product_id,cost_price").not("cost_price", "is", null).limit(1);
assert.equal(costs.error, null);
assert.ok(costs.data?.[0]);
const pricedId = costs.data[0].product_id;
const missingId = "20000000-0000-4000-8000-000000000001";
assert.equal((await db.from("product_costs").select("cost_price").eq("product_id", missingId).maybeSingle()).data, null);
function snapshot() {
  return execFileSync("docker", ["exec", "-i", "mw-dev-db", "psql", "-U", "postgres",
    "-d", "masterweld_dev", "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], {
    input: `SELECT jsonb_build_object(
      'products',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM products r),
      'costs',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY product_id)::text) FROM product_costs r),
      'staff',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY telegram_id)::text) FROM staff r),
      'orders',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM shop_orders r),
      'pending',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM pending_actions r),
      'notifications',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id)::text) FROM order_notifications r));`,
    encoding: "utf8",
  }).trim();
}
const before = snapshot();
const { tg } = await import("../../src/lib/bot/telegram.server");
const me = await (await tg("getMe", {})).json();
assert.equal(me.result.id, 8996533708);
assert.equal(me.result.username, "testmw639bot");
const messages: { messageId: number; text: string; buttons: string[] }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/answerCallbackQuery"))
    return Response.json({ ok: true, result: true });
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/sendMessage")) {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, actor, "QA never contacts employees");
    const response = await realFetch(input, init), result = await response.clone().json();
    assert.equal(result.ok, true);
    messages.push({
      messageId: result.result.message_id, text: body.text,
      buttons: (body.reply_markup?.inline_keyboard ?? []).flat().map((b: { callback_data: string }) => b.callback_data),
    });
    return response;
  }
  return realFetch(input, init);
}) as typeof fetch;
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
let sequence = Date.now();
async function callback(data: string) {
  await handleUpdate({
    update_id: ++sequence, callback_query: {
      id: "dev-simulated", data, from: { id: actor },
      message: { message_id: sequence, chat: { id: actor, type: "private" } },
    },
  });
}
const { sellerMenu } = await import("../../src/lib/bot/staff-guide");
const preview = sellerMenu("учебный продавец");
await tg("sendMessage", { chat_id: actor, text: "ПРОВЕРКА: меню продавца\n\n" + preview.text,
  reply_markup: { inline_keyboard: preview.rows } });
await callback("cost:" + pricedId);
assert.ok(messages.at(-1)?.text.includes("Закупочная цена:"));
assert.ok(!messages.at(-1)?.text.includes("пока не указана"));
assert.ok(messages.at(-1)?.buttons.includes("prd:" + pricedId));
await callback("cost:" + missingId);
assert.ok(messages.at(-1)?.text.includes("пока не указана"));
await callback("ps:" + missingId);
assert.ok(messages.at(-1)?.buttons.includes("pxs:" + missingId + ":s1"));
assert.ok(messages.at(-1)?.buttons.includes("pxs:" + missingId + ":s0"));
await callback("guide:home");
assert.ok(messages.at(-1)?.buttons.includes("guide:input"));
assert.equal(snapshot(), before);
const audit = await db.from("staff_audit_log").select("action").eq("telegram_id", actor)
  .eq("action", "product_cost_read").limit(10);
assert.equal(audit.error, null);
assert.ok(audit.data && audit.data.length >= 2);
const folder = new URL("../.state/dev/artifacts/seller-costs-" + Date.now() + "/", import.meta.url);
mkdirSync(folder, { recursive: true, mode: 0o700 });
writeFileSync(new URL("result.json", folder), JSON.stringify({
  sourceSha: sha, environment: "dev", privateCosts: true, sevenSellersCanReadCosts: true,
  noPriceImportStaffWritesGranted: true, publicCostsDenied: true,
  businessDataUnchanged: true, actualTelegramDeliveryToOwner: true,
  incomingCallbacks: "simulated", employeeLoginsAndVisualClient: "not tested", messages,
}, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ verified: true, report: folder.pathname + "result.json",
  sourceSha: sha, deliveredMessages: messages.map((m) => m.messageId) }));
