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
const health = await (await fetch(origin + "/api/public/release-health")).json();
assert.equal(health.ready, true);
assert.equal(health.environment, "dev");
assert.match(health.revision, /^[0-9a-f]{40}$/);
execFileSync("git", ["diff", "--exit-code", health.revision, sha, "--", "src"]);
const parserManifest = JSON.parse(
  execFileSync("docker", ["exec", "mw-dev-document-parser", "cat", "/worker/manifest.json"], {
    encoding: "utf8",
  }),
);
assert.equal(parserManifest.environment, "dev");
const expectedParser = process.argv[2];
assert.match(expectedParser ?? "", /^[0-9a-f]{40}$/);
assert.equal(parserManifest.revision, expectedParser);
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
const raw =
  "\n  \nsku  title  price\n\nTEST-LOCATOR-" +
  stamp +
  "  ТЕСТ  10\n \nTEST-LOCATOR-B-" +
  stamp +
  "  ТЕСТ  20\n";
const original = Buffer.from(raw);
const beforeDocuments = JSON.parse(
  sql(
    "SELECT coalesce(jsonb_object_agg(id::text,md5(to_jsonb(d)::text)),'{}') FROM document_intakes d",
  ),
);
type Intake = IntakeView & { id: string; checksum: string; state: string };
const doc = await call<Intake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: {
    file_name: "ТЕСТ-строки-источника-" + stamp + ".txt",
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
      id: "dev-locators-simulated",
      data,
      from,
      message: { chat, message_id: 1 },
    },
  });
const extracted = parsed.extraction as unknown as {
  text_locator_version: number;
  tables: { header_locator: string; row_locators: string[]; rows: string[][] }[];
  blocks: { text: string }[];
};
assert.equal(extracted.text_locator_version, 2);
assert.equal(extracted.blocks[0]?.text, raw);
assert.equal(extracted.tables[0]?.header_locator, "document:1/line:3");
assert.deepEqual(extracted.tables[0]?.row_locators, ["document:1/line:5", "document:1/line:7"]);
const repeated = await call<Intake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: { file_name: "ТЕСТ-повтор-" + stamp + ".txt", base64: original.toString("base64") },
});
assert.equal(repeated.id, doc.id);
assert.equal(JSON.stringify(repeated.extraction), extraction);
const initial = await call<DocumentReview>("bot_document_review", {
  p_actor: actor,
  p_op: "open",
  p_id: doc.id,
  p_row: 0,
});
const rid = initial.id;
const wordBytes = execFileSync("python3", [
  "-c",
  `
import io,sys,zipfile
from xml.sax.saxutils import escape
out=io.BytesIO()
word="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
def cell(text): return '<w:tc><w:p><w:r><w:t>'+escape(text)+'</w:t></w:r></w:p></w:tc>'
body='<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid><w:tr>'+''.join(cell(t) for t in ["Артикул","Название","Цена"])+'</w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>ТЕСТ-А-'+escape(sys.argv[1])+'</w:t></w:r></w:p><w:p><w:r><w:t>ТЕСТ-Б</w:t></w:r></w:p></w:tc>'+cell("100")+'</w:tr></w:tbl>'
with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:
 z.writestr("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr("word/document.xml",'<w:document xmlns:w="'+word+'"><w:body>'+body+'</w:body></w:document>')
sys.stdout.buffer.write(out.getvalue())
`,
  String(stamp),
]);
const wordDocument = await call<Intake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: {
    file_name: "ТЕСТ-структура-Word-" + stamp + ".docx",
    base64: wordBytes.toString("base64"),
  },
});
assert.equal(wordDocument.checksum, createHash("sha256").update(wordBytes).digest("hex"));
let wordParsed = wordDocument;
for (let i = 0; i < 60; i++) {
  wordParsed = await call<Intake>("bot_document_intake", {
    p_actor: actor,
    p_op: "get",
    p_id: wordDocument.id,
  });
  if (wordParsed.state === "review") break;
  assert.ok(["queued", "extracting"].includes(wordParsed.state));
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(wordParsed.state, "review");
assert.equal(
  (wordParsed.extraction as unknown as { docx_table_version: number }).docx_table_version,
  2,
);
const wordExtraction = JSON.stringify(wordParsed.extraction);
const expectedCells = ["ТЕСТ-А-" + stamp + "\nТЕСТ-Б", "", "100"];
assert.deepEqual(wordParsed.extraction?.tables[0]?.rows, [expectedCells]);
const wordReview = await call<DocumentReview>("bot_document_review", {
  p_actor: actor,
  p_op: "open",
  p_id: wordDocument.id,
  p_row: 0,
});
assert.deepEqual(wordReview.cells, expectedCells);
assert.equal(wordReview.decision, "pending");
assert.ok(!wordReview.import_id);
const beforeReadTables = reviewFingerprint();
await callback(`dr:${wordReview.id}:${wordReview.revision}:raw:0`);
assert.ok(messages.at(-1)?.text.includes(expectedCells[0]!));
assert.ok(messages.at(-1)?.text.includes("Цена: 100"));
assert.equal(
  JSON.stringify(
    (
      await call<Intake>("bot_document_intake", {
        p_actor: actor,
        p_op: "get",
        p_id: wordDocument.id,
      })
    ).extraction,
  ),
  wordExtraction,
);
for (const row of [0, 1]) {
  const result = await call<DocumentReview>("bot_document_review", {
    p_actor: actor,
    p_op: "get",
    p_id: rid,
    p_row: row,
  });
  assert.equal(result.locator, row === 0 ? "document:1/line:5" : "document:1/line:7");
  assert.equal(result.decision, "pending");
  assert.ok(!result.import_id);
  await callback(`dr:${rid}:${result.revision}:raw:${row}`);
  assert.ok(messages.at(-1)?.text.includes(result.locator!));
}
assert.equal(reviewFingerprint(), beforeReadTables);
assert.ok(messages.every((m) => !m.question && Array.from(m.text).length <= 3500));
assert.equal(
  (await call<{ idle: boolean }>("bot_document_review", { p_actor: actor, p_op: "input" })).idle,
  true,
);
const afterDocuments = JSON.parse(
  sql(
    "SELECT coalesce(jsonb_object_agg(id::text,md5(to_jsonb(d)::text)),'{}') FROM document_intakes d",
  ),
);
for (const [id, digest] of Object.entries(beforeDocuments))
  assert.equal(afterDocuments[id], digest);
assert.deepEqual(await (await fetch(origin + "/api/public/release-health")).json(), health);
assert.equal(
  JSON.stringify(
    (await call<Intake>("bot_document_intake", { p_actor: actor, p_op: "get", p_id: doc.id }))
      .extraction,
  ),
  extraction,
);
assert.equal(shopFingerprint(), beforeShop);
assert.equal(reviewFingerprint(), beforeReadTables);
const folder = new URL("../.state/dev/artifacts/document-locators-" + stamp + "/", import.meta.url);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const report = {
  ok: true,
  verificationRevision: sha,
  applicationRevision: health.revision,
  parserRevision: parserManifest.revision,
  documentId: doc.id,
  reviewId: rid,
  wordDocumentId: wordDocument.id,
  wordReviewId: wordReview.id,
  wordPriceColumnAndParagraphsPreserved: true,
  rowDecisionUnchanged: true,
  previousDocumentsPreserved: Object.keys(beforeDocuments).length,
  reviewTablesUnchanged: true,
  sourceLineLocators: [5, 7],
  repeatedUploadSameDocument: true,
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
