/** DEV-only training document. Incoming actions simulated; parser/storage/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { DocumentReview } from "../../src/lib/import/review-view";
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
const original = execFileSync("python3", [
  "-c",
  `
import io,sys,zipfile
from xml.sax.saxutils import escape
out=io.BytesIO()
with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:
 z.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Учебный лист" sheetId="1" state="hidden" r:id="r1"/></sheets></workbook>')
 z.writestr("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r1" Target="worksheets/s1.xml"/></Relationships>')
 z.writestr("xl/styles.xml", '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="00000"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>')
 z.writestr("xl/worksheets/s1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c><c r="C1" t="inlineStr"><is><t>price</t></is></c></row><row r="2" hidden="1"><c r="A2" s="1"><v>7</v></c><c r="B2" t="inlineStr"><is><t>ТЕСТ — '+escape(sys.argv[1])+'</t></is></c><c r="C2"><f>1+2</f><v>3</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A4:B4"/></mergeCells></worksheet>')
sys.stdout.buffer.write(out.getvalue())
`,
  String(stamp),
]);
type Intake = IntakeView & { id: string; checksum: string; state: string };
const doc = await call<Intake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: {
    file_name: "ТЕСТ-памятка-таблицы-" + stamp + ".xlsx",
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
      id: "dev-guidance-simulated",
      data,
      from,
      message: { chat, message_id: 1 },
    },
  });
assert.deepEqual(parsed.extraction?.tables[0]?.warnings, [
  "FORMATTED_CELL_REVIEW",
  "FORMULA_NOT_EVALUATED",
  "HIDDEN_ROWS",
  "HIDDEN_SHEET",
  "MERGED_CELLS",
]);
assert.deepEqual(parsed.extraction?.warnings, []);
assert.equal(parsed.extraction?.coverage.complete, true);
const beforeBrowse = reviewFingerprint();
await callback("di:get:" + doc.id);
assert.ok(messages.at(-1)?.text.includes("сверка с оригиналом"));
for (let i = 0; i < 2; i++) await callback("di:checks:" + doc.id + ":0");
const guidance = messages.at(-1)!;
for (const text of [
  "скрытый лист",
  "скрытые строки",
  "объединённые ячейки",
  "не вычислял результат",
  "ведущие нули",
])
  assert.ok(guidance.text.includes(text), text);
assert.ok(guidance.buttons.includes("di:table:" + doc.id + ":0"));
await callback("di:checks:" + doc.id + ":99");
assert.ok(messages.at(-1)?.text.includes("Таблица недоступна"));
assert.equal(reviewFingerprint(), beforeBrowse, "Viewing guidance started or changed a review");
await callback("di:table:" + doc.id + ":0");
const entry = messages.at(-1)!;
const rowKey = entry.buttons.find((b) => b.startsWith("dr:") && b.includes(":checks:"));
assert.ok(rowKey);
const rid = rowKey.split(":")[1]!;
async function get() {
  return call<DocumentReview>("bot_document_review", {
    p_actor: actor,
    p_op: "get",
    p_id: rid,
    p_row: 0,
  });
}
const r = await get();
assert.equal(r.decision, "pending");
assert.ok(!r.import_id);
const beforeRead = JSON.stringify(r),
  beforeReadTables = reviewFingerprint();
await callback(rowKey);
await callback(rowKey);
assert.ok(messages.at(-1)?.text.includes("ведущие нули"));
assert.equal(JSON.stringify(await get()), beforeRead);
assert.equal(reviewFingerprint(), beforeReadTables);
assert.ok(messages.every((m) => !m.question && Array.from(m.text).length <= 3500));
assert.ok(messages.every((m) => m.buttons.every((b) => Buffer.byteLength(b) <= 64)));
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
const folder = new URL("../.state/dev/artifacts/document-guidance-" + stamp + "/", import.meta.url);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const report = {
  ok: true,
  revision: sha,
  documentId: doc.id,
  reviewId: rid,
  rowDecisionUnchanged: true,
  beforeReviewBrowsingUnchanged: true,
  reviewTablesUnchanged: true,
  fiveTableWarningsExplained: true,
  missingTableRecovered: true,
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
