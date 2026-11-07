/** DEV-only training document. Incoming actions simulated; parser/storage/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { DocumentReview } from "../../src/lib/import/review-view";
import type { ImportView } from "../../src/lib/import/catalog-view";
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
      id: "dev-legacy-xls-simulated",
      data,
      from,
      message: { chat, message_id: messages.at(-1)!.id },
    },
  });

const dir = new URL("../.state/dev/artifacts/legacy-excel-intake-" + stamp + "/", import.meta.url);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const docs: { id: string; reviewId: string; fingerprint: string }[] = [];

const fixture = JSON.parse(
  readFileSync(new URL("../intake/fixtures/legacy-excel.json", import.meta.url), "utf8"),
) as { file_name: string; base64: string; sha256: string };
assert.match(fixture.sha256, /^[0-9a-f]{64}$/);
assert.equal(
  createHash("sha256").update(Buffer.from(fixture.base64, "base64")).digest("hex"),
  fixture.sha256,
);
assert.equal(
  sql("SELECT count(*) FROM document_intakes WHERE checksum='" + fixture.sha256 + "'"),
  "0",
  "Fixture already uploaded; inspect the previous rehearsal instead of replaying it",
);
assert.equal(
  sql("SELECT count(*) FROM products WHERE sku IN ('TEST-XLS-001','TEST-XLS-FORMULA')"),
  "0",
);
function saveStarted() {
  writeFileSync(
    new URL("started.json", dir),
    JSON.stringify({ sha, docs, imports: ignoredImports, fixture: fixture.sha256 }),
    { mode: 0o600 },
  );
}
saveStarted();
await tg("sendMessage", {
  chat_id: actor,
  text: "🧪 Учебная проверка старого Excel. Проверю, что формула блокирует импорт, затем вручную внесу проверенную цену. Товары не будут созданы.",
});
type Intake = IntakeView & { id: string; checksum: string; state: string };
let d = await call<Intake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: { file_name: fixture.file_name, base64: fixture.base64 },
});
assert.equal(d.checksum, fixture.sha256);
const receipt = { id: d.id, reviewId: "", fingerprint: "" };
docs.push(receipt);
saveStarted();
for (let i = 0; i < 90; i++) {
  d = await call<Intake>("bot_document_intake", { p_actor: actor, p_op: "get", p_id: d.id });
  if (d.state === "review") break;
  assert.ok(["queued", "extracting"].includes(d.state));
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(d.state, "review");
receipt.fingerprint = sql(
  "SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + d.id + "'",
);
const extraction = JSON.parse(
  sql("SELECT extraction::text FROM document_intakes WHERE id='" + d.id + "'"),
);
assert.equal(extraction.xls_table_version, 1);
assert.equal(extraction.sha256, fixture.sha256);
assert.deepEqual(extraction.tables[0].row_locators, ["sheet:1/row:2", "sheet:1/row:3"]);
assert.deepEqual(extraction.tables[0].rows[0], ["TEST-XLS-001", "Учебный аппарат", "10"]);
assert.equal(extraction.tables[0].rows[1][2], "=Формула XLS: введите проверенное значение");
assert.equal(extraction.tables[0].formula_cells[0].locator, "sheet:1/row:3/column:3");
await callback("di:get:" + d.id);
await callback("di:checks:" + d.id + ":0");
assert.match(messages.at(-1)!.text, /Сохранённое число не используется/);
await callback("di:table:" + d.id + ":0");
let r = await call<DocumentReview>("bot_document_review", {
  p_actor: actor,
  p_op: "open",
  p_id: d.id,
  p_row: 0,
});
const rid = r.id;
receipt.reviewId = rid;
saveStarted();
const review = (row = 0) =>
  call<DocumentReview>("bot_document_review", {
    p_actor: actor,
    p_op: "get",
    p_id: rid,
    p_row: row,
  });
const getImport = (id: string) =>
  call<ImportView>("bot_catalog_import", { p_actor: actor, p_op: "get", p_id: id });
for (const row of [0, 1]) {
  r = await review(row);
  await callback(`dr:${rid}:${r.revision}:approve:${row}`);
}
r = await review();
assert.equal(r.counts.approved, 2);
async function handoffAndPreview() {
  const current = await review();
  await callback(`dr:${rid}:${current.revision}:handoff:0`);
  const handed = await review();
  assert.ok(handed.import_id);
  ignoredImports.push(handed.import_id);
  saveStarted();
  let batch = await getImport(handed.import_id);
  await callback(`ci:preview:${batch.id}:${batch.revision}`);
  batch = await getImport(batch.id);
  assert.equal(batch.state, "preview");
  return batch;
}
async function returnToReview(batch: ImportView) {
  await callback(`ci:rp:${batch.id}:${batch.revision}`);
  const button = messages.at(-1)!.buttons.find((b) => b.startsWith("ci:rr:"));
  assert.ok(button);
  await callback(button);
  assert.equal((await getImport(batch.id)).state, "canceled");
  assert.equal((await review()).import_id, null);
}
const blocked = await handoffAndPreview();
assert.equal(blocked.counts.error, 1);
assert.ok(blocked.items.find((i) => i.sku === "TEST-XLS-FORMULA")?.errors.includes("FORMULA"));
const denied = await rpc("bot_catalog_import", {
  p_actor: actor,
  p_op: "apply",
  p_id: blocked.id,
  p_revision: blocked.revision,
});
assert.ok(denied.error);
assert.match(JSON.stringify(denied.error), /IMPORT_BLOCKED/);
assert.equal((await getImport(blocked.id)).state, "preview");
await returnToReview(blocked);
r = await review(1);
await callback(`dr:${rid}:${r.revision}:edit:1:2`);
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
    text: "15",
    reply_to_message: { message_id: input.prompt.message_id, chat },
  },
});
r = await review(1);
assert.equal(r.cells[2], "15");
assert.equal(r.original[2], "=Формула XLS: введите проверенное значение");
assert.equal(r.decision, "pending");
assert.equal((await review(0)).decision, "approved");
await callback(`dr:${rid}:${r.revision}:approve:1`);
const corrected = await handoffAndPreview();
assert.equal(corrected.counts.error, 0);
assert.equal(corrected.counts.new, 2);
assert.equal(corrected.items.find((i) => i.sku === "TEST-XLS-FORMULA")?.after_product?.price, 15);
assert.equal(corrected.items.find((i) => i.sku === "TEST-XLS-001")?.after_product?.price, 10);
await returnToReview(corrected);
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
assert.equal(
  sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + d.id + "'"),
  receipt.fingerprint,
);
assert.equal(
  sql("SELECT count(*) FROM products WHERE sku IN ('TEST-XLS-001','TEST-XLS-FORMULA')"),
  "0",
);
await tg("sendMessage", {
  chat_id: actor,
  text: "✅ Учебный XLS проверен. Формула заблокировала импорт. После ручного исправления и подтверждения новый предпросмотр показал цену 15. Оба предпросмотра отменены; товары не создавались. Документ сохранён для просмотра.",
});
const report = {
  ok: true,
  sourceSha: sha,
  documents: docs,
  imports: ignoredImports,
  formulaBlockedApply: true,
  manualCorrectionPrice: 15,
  approvalWithdrawnOnEdit: true,
  bothCanceled: true,
  productsCreated: 0,
  existingShopUnchanged: true,
  previousDocumentsUnchanged: Object.keys(oldDocs).length,
  originalUnchanged: true,
  realParserDatabaseTelegramDelivery: true,
  incomingActionsSimulated: true,
  telegramClientViewed: false,
  messages: messages.map((m) => m.id),
};
writeFileSync(new URL("result.json", dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
