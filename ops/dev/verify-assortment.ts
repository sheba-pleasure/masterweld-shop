/**
 * Explicit DEV integration, only the owner's chat. Synthetic incoming updates;
 * real PostgREST transactions and Telegram send/edit delivery. Never a client UI test.
 * prepare: creates two draft QA cards, previews/applies exclusion, saves evidence.
 * resume: after app restart, replays safely, undoes, then archives these QA cards again.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { TgUpdate } from "../../src/lib/bot/handler.server";
const phase = process.argv[2];
assert.ok(phase === "prepare" || phase === "resume");
const env = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(env).mode & 0o077, 0);
for (const line of readFileSync(env, "utf8").split("\n")) {
  const pos = line.indexOf("=");
  if (pos > 0) process.env[line.slice(0, pos)] = line.slice(pos + 1);
}
assert.equal(process.env.APP_ENV, "dev");
assert.equal(process.env.TELEGRAM_BOT_USERNAME, "testmw639bot");
assert.equal(process.env.PUBLIC_ORIGIN, "https://masterweld-dev.138-124-106-211.sslip.io");
process.env.SUPABASE_URL = process.env.PUBLIC_ORIGIN + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const { processClaimedUpdate } = await import("../../src/lib/bot/webhook-processing");
const identity = await db.rpc("mw_environment_identity" as never);
assert.deepEqual(identity.data, {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const me = await (
  await fetch("https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN + "/getMe")
).json();
assert.equal(me.result.username, "testmw639bot");
assert.equal(String(me.result.id), process.env.TELEGRAM_BOT_ID);
const actor = 7540652678;
const member = await db.from("staff").select("role,active").eq("telegram_id", actor).single();
assert.deepEqual(member.data, { role: "admin", active: true });
type Message = {
  message_id: number;
  text: string;
  reply_markup: { inline_keyboard: { callback_data: string; text: string }[][] };
};
const delivered: Message[] = [];
let current: Message | undefined;
const originalFetch = globalThis.fetch;
let sequence = Date.now() * 10;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.telegram.org/bot")) return originalFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (
    url.endsWith("/answerCallbackQuery") &&
    String(body.callback_query_id).startsWith("mw-assort-qa-")
  )
    return Response.json({ ok: true, result: true });
  assert.ok(url.endsWith("/sendMessage") || url.endsWith("/editMessageText"));
  assert.equal(body.chat_id, actor);
  const response = await originalFetch(input, init);
  const data = await response.clone().json();
  assert.equal(data.ok, true, "Telegram must acknowledge delivery");
  delivered.push(data.result);
  current = data.result;
  return response;
}) as typeof fetch;
async function run(update: TgUpdate) {
  const result = await processClaimedUpdate(
    update.update_id,
    {
      claim: async (update_id) => {
        const { error } = await db.from("telegram_updates").insert({ update_id });
        return { error };
      },
    },
    () => handleUpdate(update),
  );
  assert.equal(result.status, 200);
}
async function command(text: string) {
  await run({
    update_id: ++sequence,
    message: { text, from: { id: actor }, chat: { id: actor, type: "private" } },
  });
}
function button(prefix: string) {
  const found = current?.reply_markup.inline_keyboard
    .flat()
    .find((b) => b.callback_data.startsWith(prefix));
  assert.ok(found, "Expected button " + prefix);
  return found.callback_data;
}
async function click(data: string, edit = true) {
  await run({
    update_id: ++sequence,
    callback_query: {
      id: "mw-assort-qa-" + sequence,
      data,
      from: { id: actor },
      message: {
        chat: { id: actor, type: "private" },
        ...(edit && current ? { message_id: current.message_id } : {}),
      },
    },
  });
}
async function ordersHash() {
  const rows = await db.from("shop_orders").select("id,items,total,status").order("id");
  assert.equal(rows.error, null);
  return createHash("sha256").update(JSON.stringify(rows.data)).digest("hex");
}
async function audits(batchId: string) {
  const result = await db
    .from("staff_audit_log")
    .select("action")
    .contains("details", { batch_id: batchId });
  assert.equal(result.error, null);
  return result.data!.map((r) => r.action);
}
const artifact = new URL("../.state/dev/artifacts/assortment-flow.json", import.meta.url);
type Evidence = {
  query: string;
  batch: string;
  productIds: string[];
  ordersHash: string;
  preparedAt: string;
  resumedAt?: string;
};
try {
  let evidence: Evidence;
  if (phase === "prepare") {
    const query = "QAASSORT" + Date.now();
    const products = await db
      .from("products")
      .insert(
        [1, 2].map((i) => ({
          slug: query.toLowerCase() + "-" + i,
          title: "DEV учебный ассортимент " + query + " " + i,
          sku: query + "-" + i,
          price: 1,
          status: "draft" as const,
        })),
      )
      .select("id");
    assert.equal(products.error, null);
    assert.equal(products.data?.length, 2);
    const hash = await ordersHash();
    await command("/assort " + query);
    const batch = button("as:all:").split(":")[2]!;
    await click(button("as:all:"));
    assert.match(current!.text, /Выбрано: 2/);
    await click(button("as:preview:" + batch + ":exclude:"));
    assert.match(current!.text, /сохранятся/);
    const confirmation = button("as:apply:");
    await click(confirmation);
    assert.match(current!.text, /Изменения сохранены/);
    assert.deepEqual(await audits(batch), ["assortment_apply"]);
    assert.equal(await ordersHash(), hash);
    evidence = {
      query,
      batch,
      productIds: products.data!.map((p) => p.id),
      ordersHash: hash,
      preparedAt: new Date().toISOString(),
    };
    writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    console.log(
      JSON.stringify({
        phase,
        products: 2,
        applied: true,
        auditRows: 1,
        delivered: delivered.length,
        savedForRestart: true,
      }),
    );
  } else {
    evidence = JSON.parse(readFileSync(artifact, "utf8"));
    assert.match(evidence.query, /^QAASSORT[0-9]+$/);
    await click("as:get:" + evidence.batch, false);
    assert.match(current!.text, /Изменения сохранены/);
    await click("as:apply:" + evidence.batch, false); // new message, same durable result
    assert.deepEqual(await audits(evidence.batch), ["assortment_apply"]);
    await click(button("as:undo_preview:"));
    assert.match(current!.text, /Отмена вернёт/);
    await click(button("as:undo:"));
    assert.match(current!.text, /Прежние решения и видимость восстановлены/);
    assert.deepEqual((await audits(evidence.batch)).sort(), [
      "assortment_apply",
      "assortment_undo",
    ]);
    const restored = await db.from("products").select("id,status").in("id", evidence.productIds);
    assert.ok(restored.data?.every((p) => p.status === "draft"));
    assert.equal(await ordersHash(), evidence.ordersHash);
    // Leave only our test cards archived; do not touch the existing three DEV products.
    await command("/assort " + evidence.query);
    await click(button("as:all:"));
    await click(button("as:preview:").replace(/:(sell|exclude|review|hide):/, ":exclude:"));
    await click(button("as:apply:"));
    const archived = await db.from("products").select("id,status").in("id", evidence.productIds);
    assert.ok(archived.data?.every((p) => p.status === "hidden"));
    evidence.resumedAt = new Date().toISOString();
    writeFileSync(
      artifact,
      JSON.stringify(
        {
          ...evidence,
          recoveredAfterRestart: true,
          replayAuditRows: 1,
          undoAuditRows: 1,
          qaCardsArchived: true,
          ordersPreserved: true,
          incomingUpdates: "simulated",
          telegramClientUiVerified: false,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        phase,
        recovered: true,
        replayAuditRows: 1,
        undoAuditRows: 1,
        qaCardsArchived: true,
        ordersPreserved: true,
        delivered: delivered.length,
      }),
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}
