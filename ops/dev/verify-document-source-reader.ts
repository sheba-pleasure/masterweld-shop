/** DEV-only read rehearsal: incoming actions simulated, parser/database/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
) => Promise<{ data: IntakeView | null; error: unknown }>;
async function intake(op: string, id?: string, payload: Record<string, unknown> = {}) {
  const r = await rpc("bot_document_intake", {
    p_actor: actor,
    p_op: op,
    p_id: id,
    p_payload: payload,
  });
  assert.equal(r.error, null);
  assert.ok(r.data?.ok);
  return r.data;
}
function sql(query: string) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "mw-dev-db",
      "psql",
      "-X",
      "-Atq",
      "-U",
      "postgres",
      "-d",
      "masterweld_dev",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: query, encoding: "utf8" },
  ).trim();
}
assert.equal(
  sql("SELECT count(*) FROM staff WHERE telegram_id=7540652678 AND role='admin' AND active"),
  "1",
);
const tables = JSON.parse(
  sql(
    "SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN('staff_audit_log','document_intakes')",
  ),
) as string[];
function fingerprint() {
  const result: Record<string, string> = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_][a-z0-9_]*$/);
    result[table] = sql(
      "SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]')::text) FROM " +
        table +
        " r",
    );
  }
  return result;
}
const before = fingerprint();
const previousDocs = JSON.parse(
  sql(
    "SELECT coalesce(jsonb_object_agg(id::text,md5(to_jsonb(d)::text)),'{}') FROM document_intakes d",
  ),
) as Record<string, string>;
const stamp = Date.now(),
  dir = new URL("../.state/dev/artifacts/document-source-reader-" + stamp + "/", import.meta.url);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const raw =
  "УЧЕБНЫЙ ПАСПОРТ " +
  stamp +
  "\nЭто тест чтения, не характеристики настоящего товара.\n" +
  "Модель aB-007 🧰. Пример 160 A — учебный текст, не подтверждённое значение.\n".repeat(42) +
  "\nПоследняя строка.  ";
const bytes = Buffer.from(raw),
  checksum = createHash("sha256").update(bytes).digest("hex");
writeFileSync(new URL("started.json", dir), JSON.stringify({ sha, checksum, stamp }), {
  mode: 0o600,
});
const messages: { id: number; text: string; buttons: string[] }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/answerCallbackQuery"))
    return Response.json({ ok: true, result: true });
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/sendMessage")) {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, actor);
    assert.ok(body.text.length <= 4096);
    const response = await originalFetch(input, init),
      data = await response.clone().json();
    assert.equal(data.ok, true);
    messages.push({
      id: data.result.message_id,
      text: body.text,
      buttons: (body.reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((b: { callback_data: string }) => b.callback_data),
    });
    return response;
  }
  return originalFetch(input, init);
}) as typeof fetch;
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const callback = (data: string) =>
  handleUpdate({
    update_id: 1,
    callback_query: {
      id: "dev-source-reader-simulated",
      data,
      from: { id: actor },
      message: { chat: { id: actor, type: "private" }, message_id: messages.at(-1)!.id },
    },
  });
await tg("sendMessage", {
  chat_id: actor,
  text: "🧪 Проверю чтение учебного паспорта прямо в боте: список фрагментов, длинный текст и исходную страницу PDF. Товары, решения и импорт не изменяются.",
});
let d = await intake("upload", undefined, {
  file_name: "ТЕСТ-паспорт-для-чтения-" + stamp + ".txt",
  base64: bytes.toString("base64"),
});
assert.ok(d.id);
writeFileSync(
  new URL("started.json", dir),
  JSON.stringify({ sha, checksum, stamp, documentId: d.id }),
  { mode: 0o600 },
);
for (let i = 0; i < 60 && d.state !== "review"; i++) {
  assert.ok(["queued", "extracting"].includes(d.state!));
  await new Promise((resolve) => setTimeout(resolve, 500));
  d = await intake("get", d.id);
}
assert.equal(d.state, "review");
assert.equal(d.checksum, checksum);
assert.equal(d.extraction?.blocks[0]?.text, raw);
const documentFingerprint = sql(
  "SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + d.id + "'",
);
await callback("di:get:" + d.id);
assert.ok(messages.at(-1)!.buttons.includes("di:blocks:" + d.id + ":0"));
await callback("di:blocks:" + d.id + ":0");
assert.ok(messages.at(-1)!.buttons.includes("di:read:" + d.id + ":0:0"));
const { SOURCE_PART_SIZE } = await import("../../src/lib/import/source-reader");
const partCount = Math.ceil(Array.from(raw).length / SOURCE_PART_SIZE),
  parts: string[] = [];
for (let part = 0; part < partCount; part++) {
  await callback("di:read:" + d.id + ":0:" + part);
  const message = messages.at(-1)!;
  assert.ok(message.buttons.includes("di:original:" + d.id));
  parts.push(message.text.split("—— Текст источника ——\n")[1]!);
}
assert.equal(parts.join(""), raw);
const firstCallback = "di:read:" + d.id + ":0:0";
await callback(firstCallback);
const first = messages.at(-1)!.text;
await callback(firstCallback);
assert.equal(messages.at(-1)!.text, first);
await callback("di:read:" + d.id + ":0:999999");
assert.ok(messages.at(-1)!.text.includes("недоступна"));
// Read an already-preserved synthetic scan; never rewrite or reprocess it.
const pdfId = "8d06d59a-c0d0-498a-98c7-1b961f5c6ac4";
const pdf = await intake("get", pdfId);
assert.equal(pdf.file_name, "training-scan.pdf");
assert.equal(pdf.extraction?.blocks[0]?.locator, "page:1");
await callback("di:blocks:" + pdfId + ":0");
await callback("di:read:" + pdfId + ":0:0");
assert.ok(messages.at(-1)!.text.includes("Страница файла 1"));
assert.ok(messages.at(-1)!.text.includes("распознан со скана"));
const original = await intake("original", d.id);
assert.equal(
  createHash("sha256").update(Buffer.from(original.original_base64!, "base64")).digest("hex"),
  checksum,
);
assert.deepEqual(fingerprint(), before);
for (const [id, hash] of Object.entries(previousDocs))
  assert.equal(
    sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + id + "'"),
    hash,
  );
assert.equal(
  sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + d.id + "'"),
  documentFingerprint,
);
await tg("sendMessage", {
  chat_id: actor,
  text: "✅ Чтение проверено. Все части учебного текста сохранились без потери символов. PDF открылся с номером страницы и предупреждением OCR. Товары, цены, заказы, решения и импорты не изменились.",
});
const report = {
  ok: true,
  sourceSha: sha,
  documentId: d.id,
  checksum,
  pdfId,
  parts: partCount,
  sourceCharactersPreserved: true,
  invalidPartNotSubstituted: true,
  repeatReadSameText: true,
  originalUnchanged: true,
  allOtherPublicTablesUnchanged: tables.length,
  previousDocumentsUnchanged: Object.keys(previousDocs).length,
  incomingActionsSimulated: true,
  telegramClientViewed: false,
  messages: messages.map((m) => m.id),
};
writeFileSync(new URL("result.json", dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
