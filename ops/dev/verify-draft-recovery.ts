/** DEV only: actual storage and Telegram sendMessage; incoming commands are simulated. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { StaffMember } from "../../src/lib/bot/permissions";
const envPath = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(envPath).mode & 0o077, 0);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const origin = "https://masterweld-dev.138-124-106-211.sslip.io", actor = 7540652678;
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["PUBLIC_ORIGIN"], origin);
assert.equal(process.env["TELEGRAM_BOT_ID"], "8996533708");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal((await (await fetch(origin + "/api/public/release-health")).json()).revision, sha);
process.env["SUPABASE_URL"] = origin + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
assert.deepEqual((await db.rpc("mw_environment_identity" as never)).data,
  { environment: "dev", instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49" });
const memberResult = await db.from("staff").select("*").eq("telegram_id", actor).single();
assert.equal(memberResult.error, null);
const member = memberResult.data as StaffMember;
assert.equal(member.active, true);
assert.equal(member.role, "admin");
const productId = "20000000-0000-4000-8000-000000000001";
const product = await db.from("products").select("sku,title").eq("id", productId).single();
assert.equal(product.data?.sku, "DEV-001");
assert.equal(product.data?.title, "ТЕСТ — сварочный аппарат");
const { tg } = await import("../../src/lib/bot/telegram.server");
const me = await (await tg("getMe", {})).json();
assert.equal(me.result.id, 8996533708);
assert.equal(me.result.username, "testmw639bot");
const rpc = db.rpc.bind(db) as unknown as
  (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: unknown }>;
async function editor(op: string) {
  const r = await rpc("bot_technical_editor", { p_staff_telegram_id: actor, p_op: op });
  assert.equal(r.error, null);
  return r.data.session;
}
function sql(query: string) {
  return execFileSync("docker", ["exec", "-i", "mw-dev-db", "psql", "-U", "postgres",
    "-d", "masterweld_dev", "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], { input: query, encoding: "utf8" }).trim();
}
function ordinary() {
  return JSON.parse(sql("SELECT coalesce((SELECT to_jsonb(s) FROM bot_editor_states s WHERE staff_telegram_id=7540652678),'null'::jsonb);"));
}
function unchanged() {
  return sql(`SELECT jsonb_build_object(
    'products',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM products r),
    'orders',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM shop_orders r),
    'notifications',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id)::text) FROM order_notifications r),
    'technical',(SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]'::jsonb)::text) FROM technical_cards r));`);
}
const previous = ordinary();
assert.ok(!previous || previous.consumed_at || Date.parse(previous.expires_at) <= Date.now(),
  "Do not replace the owner's unfinished ordinary input");
assert.equal(await editor("current"), null, "Do not replace the owner's technical draft");
const before = unchanged();

assert.equal(Number(sql("SELECT count(*) FROM assortment_batches WHERE staff_telegram_id=7540652678 AND state IN ('selecting','preview','undo_preview');")),0,
  "Do not replace the owner's assortment work");
const sku = "DEV-RECOVERY-" + Date.now();
const messages: { messageId: number; text: string; buttons: string[] }[] = [];
let loseNextResult = false;
let committed: { product_id: string; revision: string } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/answerCallbackQuery"))
    return Response.json({ ok: true, result: true });
  if (url.includes("/rpc/bot_finish_draft") && loseNextResult) {
    loseNextResult = false;
    const response = await realFetch(input, init);
    assert.ok(response.ok);
    committed = await response.json();
    // The database really commits; the application receives no result.
    return Response.json({ message: "SIMULATED_RESPONSE_LOSS" }, { status: 503 });
  }
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/sendMessage")) {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, actor);
    const response = await realFetch(input, init), result = await response.clone().json();
    assert.equal(result.ok, true);
    messages.push({ messageId: result.result.message_id, text: body.text,
      buttons: (body.reply_markup?.inline_keyboard ?? []).flat().map((b: { callback_data: string }) => b.callback_data) });
    return response;
  }
  return realFetch(input, init);
}) as typeof fetch;
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const chat = { id: actor, type: "private" }, from = { id: actor };
const command = (text: string) => {
  const prompt = text.startsWith("/") ? null : ordinary()?.data?._prompt_message_id;
  return handleUpdate({ update_id: 1, message: { text, from, chat,
    ...(prompt ? { reply_to_message: { message_id: prompt } } : {}) } });
};
const callback = (data: string) => handleUpdate({ update_id: 2,
  callback_query: { id: "dev-simulated", data, from, message: { chat, message_id: 1 } } });
await command("/new");
await command("ТЕСТ — восстановление черновика после обрыва");
await command(sku);
await command("100");
const confirmation = ordinary();
assert.equal(confirmation.state, "new_confirm");
const revision = confirmation.data._revision;
loseNextResult = true;
await callback("nd:c:" + revision);
assert.ok(committed);
const created = committed as { product_id: string; revision: string };
assert.match(created.product_id,/^[0-9a-f-]{36}$/);
assert.equal(created.revision, revision);
assert.ok(messages.at(-1)?.text.includes("пока не подтверждён"));
const retry = messages.at(-1)!.buttons[0]!;
assert.equal(retry, "nd:c:" + revision);
assert.ok(ordinary().consumed_at);
execFileSync("docker", ["restart", "mw-dev-app"], { stdio: "pipe" });
let ready = false;
for (let i=0; i<60; i++) {
  try {
    const r = await fetch(origin + "/api/public/release-health");
    if (r.ok && (await r.json()).revision === sha) { ready=true; break; }
  } catch { /* bounded readiness polling */ }
  await new Promise(resolve => setTimeout(resolve,500));
}
assert.ok(ready);
await command("/new");
const later = ordinary();
await callback(retry);
assert.deepEqual(ordinary(), later);
assert.ok(messages.some(m => m.text.includes("Черновик уже создан")));
assert.equal(Number(sql("SELECT count(*) FROM products WHERE sku='" + sku + "';")),1);
assert.equal(Number(sql("SELECT count(*) FROM staff_audit_log WHERE action='draft_created' AND details->>'product_id'='" + created.product_id + "';")),1);
assert.equal(Number(sql("SELECT count(*) FROM bot_draft_results WHERE revision='" + revision + "';")),1);
await command("/cancel");
assert.ok(ordinary().consumed_at);
// Archive only this explicitly synthetic card through the ordinary audited bulk path.
async function assortment(op: string, batch?: string, value="", rev?: number) {
  const r = await rpc("bot_assortment",{p_staff_telegram_id:actor,p_op:op,p_batch_id:batch??null,
    p_value:value,p_query:sku,p_revision:rev??null});
  assert.equal(r.error,null); return r.data;
}
let selection = await assortment("start",undefined,"all");
const batch = selection.id;
assert.match(batch,/^[0-9a-f-]{36}$/);
assert.equal(selection.items.length,1);
assert.equal(selection.items[0].sku,sku);
assert.equal(sql("SELECT product_id FROM assortment_batch_items WHERE batch_id=\'" + batch + "\';"),created.product_id);
selection = await assortment("all",batch);
selection = await assortment("preview",batch,"exclude",selection.revision);
await assortment("apply",batch);
assert.equal(sql("SELECT status||':'||assortment_decision FROM products WHERE id='" + created.product_id + "';"),"hidden:excluded");
const after = JSON.parse(unchanged());
after.products = sql("SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM products r WHERE id<>'" + created.product_id + "';");
assert.deepEqual(after,JSON.parse(before));
const report = { environment:"dev",sourceSha:sha,incomingCommands:"simulated",realHttpsDatabase:true,
  realTelegram:true,responseLostAfterActualCommit:true,devAppRestarted:true,
  recoveredSameProduct:true,oneProductOneAuditOneReceipt:true,laterInputPreserved:true,
  previousProductsOrdersNotificationsTechnicalUnchanged:true,noActiveInputRemains:true,
  productId:created.product_id,sku,revision,assortmentBatch:batch,testProductExcluded:true,messages };
const directory = new URL("../.state/dev/artifacts/draft-recovery-"+Date.now()+"/",import.meta.url);
mkdirSync(directory,{recursive:true,mode:0o700});
writeFileSync(new URL("result.json",directory),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({verified:true,report:directory.pathname+"result.json",sourceSha:sha,
  productId:created.product_id,messages:messages.map(m=>m.messageId)}));
