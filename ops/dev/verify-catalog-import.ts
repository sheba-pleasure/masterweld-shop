/**
 * Explicit DEV integration. Real CSV upload/download + Telegram responses + DB.
 * Incoming private-chat Updates are simulated; this is not a Telegram client UI test.
 * prepare applies a 3-row fixture; resume verifies persistence and rollback after restart.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { TgUpdate } from "../../src/lib/bot/handler.server";
const phase = process.argv[2];
assert.ok(phase === "prepare" || phase === "resume");
const path = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(path).mode & 0o077, 0);
for (const line of readFileSync(path, "utf8").split("\n")) {
  const p = line.indexOf("=");
  if (p > 0) process.env[line.slice(0, p)] = line.slice(p + 1);
}
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["TELEGRAM_BOT_USERNAME"], "testmw639bot");
assert.equal(process.env["PUBLIC_ORIGIN"], "https://masterweld-dev.138-124-106-211.sslip.io");
process.env["SUPABASE_URL"] = process.env["PUBLIC_ORIGIN"] + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const { processClaimedUpdate } = await import("../../src/lib/bot/webhook-processing");
const identity = await db.rpc("mw_environment_identity" as never);
assert.deepEqual(identity.data, {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const actor = 7540652678;
const member = await db.from("staff").select("role,active").eq("telegram_id", actor).single();
assert.deepEqual(member.data, { role: "admin", active: true });
const base = "https://api.telegram.org/bot" + process.env["TELEGRAM_BOT_TOKEN"];
const me = await (await fetch(base + "/getMe")).json();
assert.equal(me.result.username, "testmw639bot");
assert.equal(String(me.result.id), process.env["TELEGRAM_BOT_ID"]);
type Message = {
  message_id: number;
  text: string;
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
};
let current: Message | undefined;
let seq = Date.now() * 10;
const originalFetch = globalThis.fetch;
let deliveries = 0,
  downloads = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/file/bot")) {
    downloads++;
    return originalFetch(input, init);
  }
  if (!url.startsWith(base + "/") || init?.body instanceof FormData)
    return originalFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (
    url.endsWith("/answerCallbackQuery") &&
    String(body.callback_query_id).startsWith("mw-import-qa-")
  )
    return Response.json({ ok: true, result: true });
  assert.ok(
    ["/sendMessage", "/editMessageText", "/getFile"].some((method) => url.endsWith(method)),
  );
  if (!url.endsWith("/getFile")) assert.equal(body.chat_id, actor);
  const response = await originalFetch(input, init);
  const data = await response.clone().json();
  assert.equal(data.ok, true, "Telegram must acknowledge delivery");
  if (!url.endsWith("/getFile")) {
    current = data.result;
    deliveries++;
  }
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
function button(prefix: string) {
  const b = current?.reply_markup.inline_keyboard
    .flat()
    .find((b) => b.callback_data.startsWith(prefix));
  assert.ok(b, "Expected button " + prefix);
  return b.callback_data;
}
async function click(data: string, edit = true) {
  await run({
    update_id: ++seq,
    callback_query: {
      id: "mw-import-qa-" + seq,
      data,
      from: { id: actor },
      message: {
        chat: { id: actor, type: "private" },
        ...(edit && current ? { message_id: current.message_id } : {}),
      },
    },
  });
}
async function orderHash() {
  const result = await db.from("shop_orders").select("id,items,total,status").order("id");
  assert.equal(result.error, null);
  return createHash("sha256").update(JSON.stringify(result.data)).digest("hex");
}
async function audits(id: string) {
  const result = await db
    .from("staff_audit_log")
    .select("action")
    .contains("details", { batch_id: id });
  assert.equal(result.error, null);
  return result.data!.map((x) => x.action).sort();
}
type Evidence = {
  batch: string;
  prefix: string;
  excludedId: string;
  ordersHash: string;
  preparedAt: string;
};
const artifact = new URL("../.state/dev/artifacts/catalog-import-flow.json", import.meta.url);
try {
  if (phase === "prepare") {
    const prefix = "QAIMPORT" + Date.now();
    const created = await db
      .from("products")
      .insert({
        slug: prefix.toLowerCase(),
        sku: prefix + "-EX",
        title: "DEV учебный исключённый товар",
        price: 100,
        status: "hidden",
      })
      .select("id")
      .single();
    assert.equal(created.error, null);
    const excludedId = created.data!.id;
    const marked = await db
      .from("products")
      .update({ assortment_decision: "excluded" } as never)
      .eq("id", excludedId);
    assert.equal(marked.error, null);
    const hash = await orderHash();
    const csv =
      "Артикул;Название;Розничная цена;Закупочная цена;Количество\n" +
      prefix +
      "-EX;DEV учебный исключённый обновлён;120,50;80,00;5\n" +
      prefix +
      "-NEW1;DEV учебный новый один;150,00;100,00;2\n" +
      prefix +
      "-NEW2;DEV учебный новый два;200,00;140,00;0\n";
    const form = new FormData();
    form.set("chat_id", String(actor));
    form.set(
      "caption",
      "ТЕСТОВЫЙ МАГАЗИН · DEV. Учебный CSV: три вымышленные строки для проверки импорта и отката.",
    );
    form.set("document", new Blob([csv], { type: "text/csv" }), "dev-import-qa.csv");
    const upload = await (
      await originalFetch(base + "/sendDocument", { method: "POST", body: form })
    ).json();
    assert.equal(upload.ok, true);
    const doc = upload.result.document;
    assert.ok(doc.file_id);
    await run({
      update_id: ++seq,
      message: {
        from: { id: actor },
        chat: { id: actor, type: "private" },
        document: {
          file_id: doc.file_id,
          file_name: doc.file_name,
          file_size: doc.file_size,
          mime_type: doc.mime_type,
        },
      },
    });
    assert.equal(downloads, 1);
    assert.match(current!.text, /Настройка импорта/);
    const batch = button("ci:preview:").split(":")[2]!;
    await click(button("ci:field:" + batch + ":3"));
    await click(button("ci:map:" + batch + ":3:2:"));
    await click(button("ci:preview:"));
    assert.match(current!.text, /Новых: 2; изменятся: 1/);
    assert.match(current!.text, /Исключённых товаров в файле: 1/);
    const confirm = button("ci:apply:");
    await click(confirm);
    assert.match(current!.text, /Импорт сохранён/);
    await click(confirm, false);
    assert.deepEqual(await audits(batch), ["catalog_import_apply"]);
    const updated = await db.from("products").select("price,status").eq("id", excludedId).single();
    assert.equal(updated.data?.price, 120.5);
    assert.equal(updated.data?.status, "hidden");
    const newRows = await db
      .from("products")
      .select("id,status")
      .in("sku", [prefix + "-NEW1", prefix + "-NEW2"]);
    assert.equal(newRows.data?.length, 2);
    assert.ok(newRows.data!.every((p) => p.status === "draft"));
    assert.equal(await orderHash(), hash);
    const evidence: Evidence = {
      batch,
      prefix,
      excludedId,
      ordersHash: hash,
      preparedAt: new Date().toISOString(),
    };
    writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    console.log(
      JSON.stringify({
        phase,
        csvUploadedAndDownloaded: true,
        deliveries,
        newDrafts: 2,
        excludedKeptHidden: true,
        applyAuditRows: 1,
      }),
    );
  } else {
    const evidence: Evidence = JSON.parse(readFileSync(artifact, "utf8"));
    assert.match(evidence.prefix, /^QAIMPORT[0-9]+$/);
    await click("ci:get:" + evidence.batch, false);
    assert.match(current!.text, /Импорт сохранён/);
    await click(button("ci:undo_preview:"));
    assert.match(current!.text, /Новые карточки будут скрыты/);
    await click(button("ci:undo:"));
    assert.match(current!.text, /Прежние импортированные значения восстановлены/);
    await click("ci:undo:" + evidence.batch, false);
    assert.deepEqual(await audits(evidence.batch), ["catalog_import_apply", "catalog_import_undo"]);
    const old = await db
      .from("products")
      .select("title,price,status")
      .eq("id", evidence.excludedId)
      .single();
    assert.deepEqual(old.data, {
      title: "DEV учебный исключённый товар",
      price: 100,
      status: "hidden",
    });
    const newRows = await db
      .from("products")
      .select("id,status")
      .in("sku", [evidence.prefix + "-NEW1", evidence.prefix + "-NEW2"]);
    assert.equal(newRows.data?.length, 2);
    assert.ok(newRows.data!.every((p) => p.status === "hidden"));
    assert.equal(await orderHash(), evidence.ordersHash);
    writeFileSync(
      artifact,
      JSON.stringify(
        {
          ...evidence,
          resumedAt: new Date().toISOString(),
          recoveredAfterRestart: true,
          undoAuditRows: 1,
          newCardsArchived: true,
          excludedRemainsHidden: true,
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
        deliveries,
        recoveredAfterRestart: true,
        undoAuditRows: 1,
        newCardsArchived: true,
        excludedRemainsHidden: true,
        ordersPreserved: true,
      }),
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}
