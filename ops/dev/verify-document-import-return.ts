/** DEV-only training document. Incoming actions simulated; parser/storage/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { DocumentReview } from "../../src/lib/import/review-view";
import type { ImportView } from "../../src/lib/import/catalog-view";
import type { ModelView } from "../../src/lib/import/model-view";
import type { IntakeView } from "../../src/lib/import/intake-view";
const envPath = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(envPath).mode & 0o077, 0);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const origin = "https://masterweld-dev.138-124-106-211.sslip.io",
  actor = 7540652678;
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["PUBLIC_ORIGIN"], origin);
assert.equal(process.env["TELEGRAM_BOT_ID"], "8996533708");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal((await (await fetch(origin + "/api/public/release-health")).json()).revision, sha);
process.env["SUPABASE_URL"] = origin + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
assert.deepEqual((await db.rpc("mw_environment_identity" as never)).data, {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const { tg } = await import("../../src/lib/bot/telegram.server");
assert.equal((await (await tg("getMe", {})).json()).result.username, "testmw639bot");
const rpc = db.rpc.bind(db) as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await rpc(name, args);
  assert.equal(r.error, null);
  return r.data as T;
}
function sql(query: string) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "mw-dev-db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "masterweld_dev",
      "-X",
      "-Atq",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: query, encoding: "utf8" },
  ).trim();
}
assert.equal(
  sql("SELECT count(*) FROM staff WHERE telegram_id=7540652678 AND active AND role='admin'"),
  "1",
);
assert.equal(
  sql(
    "SELECT count(*) FROM bot_editor_states WHERE staff_telegram_id=7540652678 AND consumed_at IS NULL AND expires_at>now()",
  ),
  "0",
);
assert.equal(
  (
    await call<{ session: unknown }>("bot_technical_editor", {
      p_staff_telegram_id: actor,
      p_op: "current",
    })
  ).session,
  null,
);
assert.equal(
  (await call<{ idle: boolean }>("bot_document_review", { p_actor: actor, p_op: "input" })).idle,
  true,
);
const ignoredProducts: string[] = [];
const ignoredImports: string[] = [];
function shopFingerprint() {
  const skipProducts = ignoredProducts.length
    ? "WHERE id NOT IN (" +
      ignoredProducts
        .map((id) => {
          assert.match(id, /^[0-9a-f-]{36}$/);
          return "'" + id + "'";
        })
        .join(",") +
      ")"
    : "";
  const skipImport = ignoredImports.length
    ? "WHERE id NOT IN (" +
      ignoredImports
        .map((id) => {
          assert.match(id, /^[0-9a-f-]{36}$/);
          return "'" + id + "'";
        })
        .join(",") +
      ")"
    : "";
  return sql(`SELECT jsonb_object_agg(name,digest) FROM (
    SELECT 'products' name,md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) digest FROM products r ${skipProducts} UNION ALL
    SELECT 'costs',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]')::text) FROM product_costs r UNION ALL
    SELECT 'orders',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM shop_orders r UNION ALL
    SELECT 'notifications',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id),'[]')::text) FROM order_notifications r UNION ALL
    SELECT 'staff',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY telegram_id),'[]')::text) FROM staff r UNION ALL
    SELECT 'imports',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM catalog_imports r ${skipImport}) s`);
}

const beforeShop = shopFingerprint(),
  stamp = Date.now();
const previousDocs = sql(
  "SELECT coalesce(jsonb_object_agg(id::text,md5(to_jsonb(d)::text)),'{}') FROM document_intakes d",
);
const messages: { id: number; text: string; buttons: string[]; question: boolean }[] = [];
interface SendBody {
  chat_id: number;
  message_id?: number;
  text: string;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard?: { callback_data: string }[][];
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/answerCallbackQuery"))
    return Response.json({ ok: true, result: true });
  if (
    url.startsWith("https://api.telegram.org/") &&
    (url.endsWith("/sendMessage") || url.endsWith("/editMessageText"))
  ) {
    const body = JSON.parse(String(init?.body)) as SendBody;
    assert.equal(body.chat_id, actor);
    if (url.endsWith("/editMessageText"))
      assert.ok(
        messages.some((m) => m.id === body.message_id),
        "Only this rehearsal’s messages may be edited",
      );
    const response = await originalFetch(input, init),
      data = await response.clone().json();
    if (url.endsWith("/editMessageText") && !data.ok) return response;
    assert.equal(data.ok, true);
    messages.push({
      id: data.result.message_id,
      text: body.text,
      question: body.reply_markup?.force_reply === true,
      buttons: (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data),
    });
    return response;
  }
  return originalFetch(input, init);
}) as typeof fetch;
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const chat = { id: actor, type: "private" },
  from = { id: actor };
const callback = (data: string) =>
  handleUpdate({
    update_id: 1,
    callback_query: {
      id: "dev-document-return-simulated",
      data,
      from,
      message: { chat, message_id: messages.at(-1)!.id },
    },
  });

const dir = new URL(
  "../.state/dev/artifacts/document-import-return-" + stamp + "/",
  import.meta.url,
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const docs: { id: string; reviewId: string; fingerprint: string }[] = [];
const sku = "TEST-RETURN-" + stamp;
assert.equal(sql("SELECT count(*) FROM products WHERE sku='" + sku + "'"), "0");
function saveStarted() {
  writeFileSync(
    new URL("started.json", dir),
    JSON.stringify({ sha, docs, imports: ignoredImports, products: ignoredProducts }),
    { mode: 0o600 },
  );
}
saveStarted();
await tg("sendMessage", {
  chat_id: actor,
  text: "🧪 Учебная проверка исправления документа. Вернусь из предпросмотра, исправлю артикул и проверю новый предпросмотр. Товары в магазине не изменятся.",
});
async function document(modelName: string) {
  const bytes = Buffer.from(
    "sku\ttitle\tprice\tmodel\n" + sku + "\tУчебное исправление документа\t10\t" + modelName + "\n",
  );
  type Intake = IntakeView & { id: string; checksum: string; state: string };
  let d = await call<Intake>("bot_document_intake", {
    p_actor: actor,
    p_op: "upload",
    p_payload: {
      file_name: "ТЕСТ-исправление-" + modelName + "-" + stamp + ".tsv",
      base64: bytes.toString("base64"),
    },
  });
  assert.equal(d.checksum, createHash("sha256").update(bytes).digest("hex"));
  const receipt = { id: d.id, reviewId: "", fingerprint: "" };
  docs.push(receipt);
  saveStarted();
  for (let i = 0; i < 60; i++) {
    d = await call<Intake>("bot_document_intake", { p_actor: actor, p_op: "get", p_id: d.id });
    if (d.state === "review") break;
    assert.ok(["queued", "extracting"].includes(d.state));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(d.state, "review");
  receipt.fingerprint = sql(
    "SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + d.id + "'",
  );
  let r = await call<DocumentReview>("bot_document_review", {
    p_actor: actor,
    p_op: "open",
    p_id: d.id,
    p_row: 0,
  });
  receipt.reviewId = r.id;
  saveStarted();
  r = await call<DocumentReview>("bot_document_review", {
    p_actor: actor,
    p_op: "approve",
    p_id: r.id,
    p_revision: r.revision,
    p_row: 0,
  });
  const getModel = () =>
    call<ModelView>("bot_document_model", { p_actor: actor, p_op: "get", p_id: r.id, p_row: 0 });
  await callback(`dm:${r.id}:0:start:0`);
  let m = await getModel();
  for (const value of ["Учебный изготовитель", modelName]) {
    assert.ok(m.prompt?.message_id);
    await handleUpdate({
      update_id: 1,
      message: {
        message_id: 999,
        chat,
        from,
        text: value,
        reply_to_message: { message_id: m.prompt!.message_id!, chat },
      },
    });
    m = await getModel();
  }
  await callback(`dm:${r.id}:${m.revision}:novar:0`);
  m = await getModel();
  await callback(`dm:${r.id}:${m.revision}:confirm:0`);
  assert.equal((await getModel()).usable, true);
  const handed = await call<{ import_id: string }>("bot_document_review", {
    p_actor: actor,
    p_op: "handoff",
    p_id: r.id,
    p_revision: r.revision,
  });
  const bid = handed.import_id;
  ignoredImports.push(bid);
  saveStarted();
  let b = await getImport(bid);
  await callback(`ci:preview:${bid}:${b.revision}`);
  b = await getImport(bid);
  assert.equal(b.model_count, 1);
  return b;
}
function getImport(id: string) {
  return call<ImportView>("bot_catalog_import", { p_actor: actor, p_op: "get", p_id: id });
}

const first = await document("МОДЕЛЬ-220");
const rid = docs[0]!.reviewId;
const review = () =>
  call<DocumentReview>("bot_document_review", { p_actor: actor, p_op: "get", p_id: rid });
const frozenSource = sql(
  "SELECT md5(source::text) FROM catalog_imports WHERE id='" + first.id + "'",
);
assert.equal(first.document_can_return, true);
await callback(`ci:rp:${first.id}:${first.revision}`);
const confirmButton = messages.at(-1)!.buttons.find((b) => b.startsWith("ci:rr:"));
assert.ok(confirmButton);
assert.equal((await getImport(first.id)).state, "preview");
await callback(confirmButton);
assert.equal((await getImport(first.id)).state, "canceled");
let r = await review();
assert.equal(r.import_id, null);
assert.equal(r.legacy_import_id, null);
assert.ok(messages.at(-1)!.buttons.some((b) => b.startsWith(`dr:${rid}:`)));
const returnedRevision = r.revision;
await callback(confirmButton);
assert.equal((await review()).revision, returnedRevision);
await callback(`dr:${rid}:${r.revision}:edit:0:0`);
const input = await call<{ prompt: { message_id: number } }>("bot_document_review", {
  p_actor: actor,
  p_op: "input",
});
assert.ok(input.prompt.message_id);
await handleUpdate({
  update_id: 1,
  message: {
    message_id: 999,
    chat,
    from,
    text: sku + "-FIX",
    reply_to_message: { message_id: input.prompt.message_id, chat },
  },
});
r = await review();
assert.equal(r.cells[0], sku + "-FIX");
assert.equal(r.decision, "pending");
assert.equal(
  (await call<ModelView>("bot_document_model", { p_actor: actor, p_op: "get", p_id: rid })).usable,
  false,
);
await callback(`dr:${rid}:${r.revision}:approve:0`);
r = await review();
await callback(`dr:${rid}:${r.revision}:handoff:0`);
r = await review();
assert.ok(r.import_id);
const nextId = r.import_id!;
assert.notEqual(nextId, first.id);
ignoredImports.push(nextId);
saveStarted();
let next = await getImport(nextId);
assert.equal(next.state, "config");
await callback(`ci:preview:${nextId}:${next.revision}`);
next = await getImport(nextId);
assert.equal(next.state, "preview");
assert.equal(next.items[0]!.sku, sku + "-FIX");
// A repeated old return only opens current state. It cannot cancel the next import.
await callback(confirmButton);
assert.equal((await review()).import_id, nextId);
assert.equal((await getImport(nextId)).state, "preview");
assert.equal(
  sql("SELECT count(*) FROM document_import_returns WHERE import_id='" + first.id + "'"),
  "1",
);
assert.equal(
  sql("SELECT md5(source::text) FROM catalog_imports WHERE id='" + first.id + "'"),
  frozenSource,
);
// Leave a reviewed editable training document, with neither preview applied.
await callback(`ci:rp:${nextId}:${next.revision}`);
const nextConfirm = messages.at(-1)!.buttons.find((b) => b.startsWith("ci:rr:"));
assert.ok(nextConfirm);
await callback(nextConfirm);
assert.equal((await getImport(nextId)).state, "canceled");
assert.equal((await review()).import_id, null);
assert.equal(
  (await call<{ idle: boolean }>("bot_document_review", { p_actor: actor, p_op: "input" })).idle,
  true,
);
assert.equal(shopFingerprint(), beforeShop);
const oldDocs = JSON.parse(previousDocs) as Record<string, string>;
for (const [id, hash] of Object.entries(oldDocs))
  assert.equal(
    sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + id + "'"),
    hash,
  );
for (const d of docs)
  assert.equal(
    sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + d.id + "'"),
    d.fingerprint,
  );
await tg("sendMessage", {
  chat_id: actor,
  text: "✅ Учебная проверка завершена. Артикул исправлен без повторной загрузки. Новый предпросмотр показал исправление; старая кнопка его не отменила. Оба учебных предпросмотра отменены, каталог не менялся. Документ сохранён для просмотра.",
});
const report = {
  ok: true,
  sourceSha: sha,
  documents: docs,
  imports: ignoredImports,
  bothCanceled: true,
  receipts: 2,
  productsCreated: 0,
  existingShopUnchanged: true,
  previousDocumentsUnchanged: Object.keys(oldDocs).length,
  originalUnchanged: true,
  duplicateReturnSafe: true,
  oldButtonCannotCancelNextImport: true,
  realParserDatabaseTelegramDelivery: true,
  incomingActionsSimulated: true,
  telegramClientViewed: false,
  messages: messages.map((m) => m.id),
};
writeFileSync(new URL("result.json", dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
