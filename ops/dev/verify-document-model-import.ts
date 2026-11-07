/** DEV-only training document. Incoming actions simulated; parser/storage/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { DocumentReview } from "../../src/lib/import/review-view";
import type { ImportView } from "../../src/lib/import/catalog-view";
import type { ProductModelLinks } from "../../src/lib/import/model-links-view";
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
let ignoredImport = "";
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
  const skipImport = ignoredImport ? "WHERE id <> '" + ignoredImport + "'" : "";
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
const skuA = "TEST-MODEL-LINK-" + stamp,
  skuB = "TEST-MODEL-NONE-" + stamp;
assert.equal(
  sql("SELECT count(*) FROM products WHERE sku IN ('" + skuA + "','" + skuB + "')"),
  "0",
);
const bytes = Buffer.from(
  "sku\ttitle\tprice\n" +
    skuA +
    "\tУчебная модель-220\t10\n" +
    skuB +
    "\tУчебный товар без модели\t20\n",
);
type Intake = IntakeView & { id: string; checksum: string; state: string };
const doc = await call<Intake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: { file_name: "ТЕСТ-связь-модели-" + stamp + ".tsv", base64: bytes.toString("base64") },
});
assert.equal(doc.checksum, createHash("sha256").update(bytes).digest("hex"));
const dir = new URL(
  "../.state/dev/artifacts/document-model-import-" + stamp + "/",
  import.meta.url,
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(new URL("started.json", dir), JSON.stringify({ sha, documentId: doc.id }), {
  mode: 0o600,
});
let parsed = doc;
for (let i = 0; i < 60; i++) {
  parsed = await call<Intake>("bot_document_intake", { p_actor: actor, p_op: "get", p_id: doc.id });
  if (parsed.state === "review") break;
  assert.ok(["queued", "extracting"].includes(parsed.state));
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(parsed.state, "review");
const originalFingerprint = sql(
  "SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + doc.id + "'",
);
let review = await call<DocumentReview>("bot_document_review", {
  p_actor: actor,
  p_op: "open",
  p_id: doc.id,
  p_row: 0,
});
const rid = review.id;
for (const row of [0, 1])
  review = await call<DocumentReview>("bot_document_review", {
    p_actor: actor,
    p_op: "approve",
    p_id: rid,
    p_row: row,
    p_revision: review.revision,
  });
async function getModel() {
  return call<ModelView>("bot_document_model", {
    p_actor: actor,
    p_op: "get",
    p_id: rid,
    p_row: 0,
  });
}
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
      id: "dev-model-import-simulated",
      data,
      from,
      message: { chat, message_id: messages.at(-1)!.id },
    },
  });

await tg("sendMessage", {
  chat_id: actor,
  text: "🧪 Учебная проверка связи документа с товаром. Используются только новые тестовые товары; импорт будет отменён.",
});
await callback(`dm:${rid}:0:start:0`);
let m = await getModel();
for (const value of ["Учебный изготовитель", "МОДЕЛЬ-220"]) {
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
await callback(`dm:${rid}:${m.revision}:novar:0`);
m = await getModel();
await callback(`dm:${rid}:${m.revision}:confirm:0`);
m = await getModel();
assert.equal(m.usable, true);
const handed = await call<{ import_id: string }>("bot_document_review", {
  p_actor: actor,
  p_op: "handoff",
  p_id: rid,
  p_revision: review.revision,
});
const bid = handed.import_id;
ignoredImport = bid;
async function getImport() {
  return call<ImportView>("bot_catalog_import", { p_actor: actor, p_op: "get", p_id: bid });
}
let batch = await getImport();
await callback(`ci:preview:${bid}:${batch.revision}`);
batch = await getImport();
assert.equal(batch.model_count, 1);
assert.equal(batch.items[0]?.document_model?.identity?.model, "МОДЕЛЬ-220");
assert.equal(batch.items[1]?.document_model?.state, "unconfirmed");
assert.ok(messages.at(-1)?.text.includes("Модель не подтверждена"));
m = await getModel();
await callback(`dm:${rid}:${m.revision}:uncertain:0`);
await callback(`ci:apply:${bid}:${batch.revision}`);
assert.equal((await getImport()).state, "preview");
assert.ok(messages.at(-1)?.text.includes("Решение о модели изменилось"));
assert.ok(messages.at(-1)?.buttons.includes(`ci:get:${bid}:0`));
m = await getModel();
await callback(`dm:${rid}:${m.revision}:confirm:0`);
m = await getModel();
await callback(`ci:preview:${bid}:${batch.revision}`);
batch = await getImport();
const apply = `ci:apply:${bid}:${batch.revision}`;
await callback(apply);
batch = await getImport();
assert.equal(batch.state, "applied");
for (const sku of [skuA, skuB]) {
  const p = JSON.parse(sql("SELECT to_jsonb(p) FROM products p WHERE sku='" + sku + "'"));
  assert.equal(p.status, "draft");
  assert.equal(p.assortment_decision, "review");
  ignoredProducts.push(p.id);
}
assert.equal(ignoredProducts.length, 2);
const linkedHash = sql(
  "SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY line)::text) FROM document_import_model_links q WHERE batch_id='" +
    bid +
    "'",
);
await callback(apply);
assert.equal(
  sql(
    "SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY line)::text) FROM document_import_model_links q WHERE batch_id='" +
      bid +
      "'",
  ),
  linkedHash,
);
const pid = ignoredProducts[0]!;
await callback(`prd:${pid}`);
assert.ok(messages.at(-1)?.buttons.includes(`mp:${pid}:0`));
await callback(`mp:${pid}:0`);
assert.ok(messages.at(-1)?.text.includes("Связь с источником сохранена"));
assert.ok(messages.at(-1)?.buttons.includes(`di:original:${doc.id}`));
const proof = await call<ProductModelLinks>("bot_product_document_models", {
  p_actor: actor,
  p_product: pid,
  p_page: 0,
});
assert.equal(proof.items[0]?.identity?.model, "МОДЕЛЬ-220");
assert.equal(proof.items[0]?.row, 0);
assert.equal(proof.conflicting, false);
await callback(`mp:${ignoredProducts[1]}:0`);
assert.ok(messages.at(-1)?.text.includes("Модель не подтверждена"));
await callback(`ci:undo_preview:${bid}`);
await callback(`ci:undo:${bid}`);
assert.equal((await getImport()).state, "undone");
for (const pid of ignoredProducts) {
  const p = JSON.parse(sql("SELECT to_jsonb(p) FROM products p WHERE id='" + pid + "'"));
  assert.equal(p.status, "hidden");
  assert.equal(p.assortment_decision, "excluded");
}
await callback(`mp:${pid}:0`);
assert.ok(messages.at(-1)?.text.includes("Импорт отменён"));
assert.ok(messages.at(-1)?.text.includes("Товар исключён"));
assert.equal(shopFingerprint(), beforeShop);
assert.equal(
  sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + doc.id + "'"),
  originalFingerprint,
);
assert.equal(
  sql(
    "SELECT coalesce(jsonb_object_agg(id::text,md5(to_jsonb(d)::text)),'{}') FROM document_intakes d WHERE id<>'" +
      doc.id +
      "'",
  ),
  previousDocs,
);
assert.equal(
  (await call<{ idle: boolean }>("bot_document_review", { p_actor: actor, p_op: "input" })).idle,
  true,
);
globalThis.fetch = originalFetch;
const report = {
  ok: true,
  sha,
  documentId: doc.id,
  reviewId: rid,
  importId: bid,
  products: ignoredProducts,
  stalePreviewRejected: true,
  duplicateApplyPrevented: true,
  confirmedAndUnknownVisible: true,
  finalImport: "undone",
  newProducts: "hidden/excluded",
  priorShopUnchanged: true,
  originalUnchanged: true,
  previousDocumentsUnchanged: true,
  messages: messages.map((x) => x.id),
  incoming: "simulated",
  telegramClientVisual: false,
};
writeFileSync(new URL("result.json", dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
writeFileSync(new URL("messages.json", dir), JSON.stringify(messages, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(report));
