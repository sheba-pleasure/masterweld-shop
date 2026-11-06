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
const messages: { messageId: number; text: string; buttons: string[] }[] = [];
const realFetch = globalThis.fetch;
let readBarrier: { waiting: number; promise: Promise<void>; release: () => void } | null = null;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  // Incoming callbacks are simulated; their acknowledgements cannot reach Telegram.
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/answerCallbackQuery"))
    return Response.json({ ok: true, result: true });
  if (readBarrier && url.includes("/bot_editor_states?") && (!init?.method || init.method === "GET") && url.includes("select=*")) {
    const barrier = readBarrier;
    const response = await realFetch(input, init);
    barrier.waiting += 1;
    if (barrier.waiting === 2) { readBarrier = null; barrier.release(); }
    await barrier.promise;
    return response;
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
async function race(a: () => Promise<unknown>, b: () => Promise<unknown>) {
  let release!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    const timer = setTimeout(() => reject(new Error("STATE_READ_BARRIER_TIMEOUT")), 8000);
    timer.unref();
  });
  readBarrier = { waiting: 0, promise, release };
  await Promise.all([a(), b()]);
  assert.equal(readBarrier, null);
}
function pending() {
  return JSON.parse(sql("SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM pending_actions s WHERE staff_telegram_id=7540652678;")) as { id: string; consumed_at: string | null; outcome: string | null }[];
}
const beforePending = pending();
await command("/new");
const first = ordinary();
await command("/new");
assert.deepEqual(ordinary(), first);
assert.ok(messages.at(-1)?.text.includes("Текущий ввод сохранён"));
await race(() => command("ТЕСТ — первый ответ"), () => command("ТЕСТ — второй ответ"));
assert.equal(ordinary().state, "new_sku");
assert.ok(["ТЕСТ — первый ответ", "ТЕСТ — второй ответ"].includes(ordinary().data.title));
assert.equal(messages.filter(m => m.text.includes("Этот шаг уже изменился")).length, 1);
await command("-");
await command("100");
const confirm = ordinary();
assert.equal(confirm.state, "new_confirm");
assert.ok(confirm.data._revision);
await callback("nd:c");
assert.deepEqual(ordinary(), confirm);
assert.ok(messages.at(-1)?.text.includes("Этот шаг уже изменился"));
await callback("nd:x:" + confirm.data._revision);
assert.ok(ordinary().consumed_at);
await callback("et:cat:" + productId);
const category = ordinary();
assert.equal(category.state, "pick_cat");
await callback("ec:0");
assert.deepEqual(ordinary(), category);
const currentCategory = JSON.parse(sql("SELECT to_jsonb(category_id) FROM products WHERE id='20000000-0000-4000-8000-000000000001';"));
const index = category.data.cats.findIndex((c: { id: string }) => c.id !== currentCategory);
assert.ok(index >= 0);
await race(() => callback("ec:" + index + ":" + category.data._revision),
  () => callback("ec:" + index + ":" + category.data._revision));
const added = pending().filter(p => !beforePending.some(old => old.id === p.id));
assert.equal(added.length, 1);
assert.equal(added[0]!.consumed_at, null);
await callback("pcx:" + added[0]!.id);
const afterPending = pending();
assert.equal(afterPending.find(p => p.id === added[0]!.id)?.outcome, "canceled");
assert.deepEqual(afterPending.filter(p => p.id !== added[0]!.id), beforePending);
assert.ok(ordinary().consumed_at);
assert.equal(unchanged(), before);
const report = { environment: "dev", sourceSha: sha, incomingCommands: "simulated",
  realHttpsDatabase: true, realTelegram: true, forcedConcurrentReads: true,
  activeInputPreserved: true, concurrentDraftStepSingleWinner: true,
  legacyConfirmationRejected: true, legacyCategoryRejected: true,
  concurrentCategoryPreviewSingleWinner: true, pendingCanceled: added[0]!.id,
  noActiveDialogsRemain: true, productsOrdersNotificationsAndPublishedTechnicalUnchanged: true, messages };
const directory = new URL("../.state/dev/artifacts/catalog-input-claims-" + Date.now() + "/", import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(new URL("result.json", directory), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ verified: true, report: directory.pathname + "result.json",
  messages: messages.map(m => m.messageId), sourceSha: sha }));
