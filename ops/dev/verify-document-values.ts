/** DEV-only training document. Incoming actions simulated; parser/storage/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { DocumentReview } from "../../src/lib/import/review-view";
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
function shopFingerprint() {
  return sql(`SELECT jsonb_object_agg(name,digest) FROM (
    SELECT 'products' name,md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) digest FROM products r UNION ALL
    SELECT 'costs',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]')::text) FROM product_costs r UNION ALL
    SELECT 'orders',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM shop_orders r UNION ALL
    SELECT 'notifications',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id),'[]')::text) FROM order_notifications r UNION ALL
    SELECT 'staff',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY telegram_id),'[]')::text) FROM staff r UNION ALL
    SELECT 'imports',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM catalog_imports r) s`);
}
function reviewFingerprint() {
  return sql(`SELECT jsonb_object_agg(name,digest) FROM (
    SELECT 'reviews' name,md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) digest FROM document_reviews r UNION ALL
    SELECT 'rows',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY review_id,row_index),'[]')::text) FROM document_review_rows r UNION ALL
    SELECT 'prompts',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY actor),'[]')::text) FROM document_review_prompts r UNION ALL
    SELECT 'changes',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM document_structure_changes r) s`);
}
const beforeShop = shopFingerprint(),
  stamp = Date.now();
const rawValue =
  "ТЕСТ — исходное значение. " + "Длинный учебный текст. ".repeat(70) + " Конец: МОДЕЛЬ-380.";
const savedValue =
  "ТЕСТ — исправленное значение. " +
  "Сверенное учебное описание. ".repeat(60) +
  " Конец: МОДЕЛЬ-220.";
assert.ok(rawValue.length <= 2000 && savedValue.length <= 2000);
const original = Buffer.from("sku\ttitle\nDEV-VIEW-" + stamp + "\t" + rawValue + "\n");
interface Intake {
  id: string;
  checksum: string;
  state: string;
  extraction: unknown;
}
const doc = await call<Intake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: {
    file_name: "ТЕСТ-полный-просмотр-" + stamp + ".tsv",
    base64: original.toString("base64"),
  },
});
assert.equal(doc.checksum, createHash("sha256").update(original).digest("hex"));
let parsed: Intake = doc;
for (let i = 0; i < 60; i++) {
  parsed = await call<Intake>("bot_document_intake", { p_actor: actor, p_op: "get", p_id: doc.id });
  if (parsed.state === "review") break;
  assert.ok(["queued", "extracting"].includes(parsed.state));
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(parsed.state, "review");
const extraction = JSON.stringify(parsed.extraction);
const messages: { id: number; text: string; buttons: string[]; question: boolean }[] = [];
interface SendBody {
  chat_id: number;
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
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/sendMessage")) {
    const body = JSON.parse(String(init?.body)) as SendBody;
    assert.equal(body.chat_id, actor);
    const response = await originalFetch(input, init),
      data = await response.clone().json();
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
      id: "dev-values-simulated",
      data,
      from,
      message: { chat, message_id: 1 },
    },
  });
const initial = await call<DocumentReview>("bot_document_review", {
  p_actor: actor,
  p_op: "open",
  p_id: doc.id,
  p_row: 0,
});
const rid = initial.id;
async function get() {
  return call<DocumentReview>("bot_document_review", {
    p_actor: actor,
    p_op: "get",
    p_id: rid,
    p_row: 0,
  });
}
function key(r: DocumentReview, op: string, col?: number) {
  return `dr:${r.id}:${r.revision}:${op}:${r.row}${col === undefined ? "" : ":" + col}`;
}
await callback(key(initial, "edit", 1));
const question = messages.find((m) => m.question);
assert.ok(question);
await handleUpdate({
  update_id: 2,
  message: { chat, from, text: savedValue, reply_to_message: { message_id: question.id } },
});
let r = await get();
assert.equal(r.cells[1], savedValue);
assert.equal(r.original[1], rawValue);
await callback(key(r, "approve"));
r = await get();
assert.equal(r.decision, "approved");
assert.equal(
  (await call<{ idle: boolean }>("bot_document_review", { p_actor: actor, p_op: "input" })).idle,
  true,
);
assert.ok(!r.import_id);
const beforeReadTables = reviewFingerprint();
const beforeRead = JSON.stringify(r),
  start = messages.length;
for (const op of ["values", "full", "orig", "full"]) {
  await callback(key(r, op, op === "values" ? 0 : 1));
  assert.equal(JSON.stringify(await get()), beforeRead, "Read changed review/approval");
}
const shown = messages.slice(start);
assert.ok(shown.some((m) => m.text.includes(savedValue)));
assert.ok(shown.some((m) => m.text.includes(rawValue)));
assert.ok(shown.every((m) => !m.question && Array.from(m.text).length <= 3500));
assert.ok(shown.every((m) => m.buttons.every((b) => Buffer.byteLength(b) <= 64)));
assert.equal(
  (await call<{ idle: boolean }>("bot_document_review", { p_actor: actor, p_op: "input" })).idle,
  true,
);
assert.equal(
  JSON.stringify(
    (await call<Intake>("bot_document_intake", { p_actor: actor, p_op: "get", p_id: doc.id }))
      .extraction,
  ),
  extraction,
);
assert.equal(shopFingerprint(), beforeShop);
assert.equal(reviewFingerprint(), beforeReadTables);
const folder = new URL("../.state/dev/artifacts/document-values-" + stamp + "/", import.meta.url);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const report = {
  ok: true,
  revision: sha,
  documentId: doc.id,
  reviewId: rid,
  approvedReviewUnchanged: true,
  reviewTablesUnchanged: true,
  fullSavedAndOriginalDelivered: true,
  originalExtractionUnchanged: true,
  noActiveQuestion: true,
  shopFingerprintsUnchanged: true,
  importCreated: false,
  incomingActionsSimulated: true,
  telegramClientVisuallyChecked: false,
  messages: messages.map((m) => m.id),
};
writeFileSync(new URL("result.json", folder), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(report));
