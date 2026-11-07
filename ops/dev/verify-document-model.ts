/** DEV-only training document. Incoming actions simulated; parser/storage/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { DocumentReview } from "../../src/lib/import/review-view";
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
function shopFingerprint() {
  return sql(`SELECT jsonb_object_agg(name,digest) FROM (
    SELECT 'products' name,md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) digest FROM products r UNION ALL
    SELECT 'costs',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]')::text) FROM product_costs r UNION ALL
    SELECT 'orders',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM shop_orders r UNION ALL
    SELECT 'notifications',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id),'[]')::text) FROM order_notifications r UNION ALL
    SELECT 'staff',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY telegram_id),'[]')::text) FROM staff r UNION ALL
    SELECT 'imports',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM catalog_imports r) s`);
}

const beforeShop = shopFingerprint(),
  stamp = Date.now();
const previousDocs = sql(
  "SELECT coalesce(jsonb_object_agg(id::text,md5(to_jsonb(d)::text)),'{}') FROM document_intakes d",
);
const bytes = Buffer.from(
  "sku\ttitle\tprice\nTEST-MODEL-" + stamp + "\tУчебный производитель МОДЕЛЬ-220\t10\n",
);
type Intake = IntakeView & { id: string; checksum: string; state: string };
const doc = await call<Intake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: { file_name: "ТЕСТ-модель-" + stamp + ".tsv", base64: bytes.toString("base64") },
});
assert.equal(doc.checksum, createHash("sha256").update(bytes).digest("hex"));
const dir = new URL("../.state/dev/artifacts/document-model-" + stamp + "/", import.meta.url);
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(new URL("started.json", dir), JSON.stringify({ documentId: doc.id, sha }), {
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
const initial = await call<DocumentReview>("bot_document_review", {
  p_actor: actor,
  p_op: "open",
  p_id: doc.id,
  p_row: 0,
});
const rid = initial.id;
async function getRow() {
  return call<DocumentReview>("bot_document_review", {
    p_actor: actor,
    p_op: "get",
    p_id: rid,
    p_row: 0,
  });
}
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
      id: "dev-model-simulated",
      data,
      from,
      message: { chat, message_id: 1 },
    },
  });

async function clickModel(op: string) {
  const r = await getModel();
  await callback(`dm:${rid}:${r.revision}:${op}:0`);
  return getModel();
}
async function reply(text: string, messageId: number) {
  await handleUpdate({
    update_id: 1,
    message: {
      message_id: 999,
      chat,
      from,
      text,
      reply_to_message: { message_id: messageId, chat },
    },
  });
}
await callback(`dr:${rid}:${initial.revision}:approve:0`);
let r = await getRow();
assert.equal(r.decision, "approved");
await callback(`dr:${rid}:${r.revision}:get:0`);
assert.ok(messages.at(-1)?.buttons.includes(`dm:${rid}:0:get:0`));
await clickModel("get");
let m = await clickModel("start");
assert.equal(m.focus, 0);
assert.ok(m.prompt?.message_id);
await reply("Учебный производитель", m.prompt!.message_id!);
m = await getModel();
assert.equal(m.manufacturer, "Учебный производитель");
assert.equal(m.focus, 1);
await reply("МОДЕЛЬ-220", m.prompt!.message_id!);
m = await getModel();
assert.equal(m.model, "МОДЕЛЬ-220");
assert.equal(m.variant_mode, "unknown");
assert.equal(m.prompt, null);
assert.ok(!messages.at(-1)?.buttons.some((b) => b.includes(":confirm:")));
m = await clickModel("novar");
const confirmation = `dm:${rid}:${m.revision}:confirm:0`;
await callback(confirmation);
m = await getModel();
assert.equal(m.usable, true);
await callback(confirmation);
assert.equal((await getModel()).revision, m.revision);
assert.equal((await getModel()).history.length, 1);
await clickModel("history");
assert.ok(messages.at(-1)?.text.includes("История не заменяет текущее состояние"));
const modelBeforeRead = JSON.stringify(await getModel());
await callback(`dr:${rid}:${r.revision}:values:0:0`);
assert.equal(JSON.stringify(await getModel()), modelBeforeRead);
r = await getRow();
await callback(`dr:${rid}:${r.revision}:edit:0:1`);
const prompt = await call<{ prompt: { message_id: number } }>("bot_document_review", {
  p_actor: actor,
  p_op: "input",
});
await reply("Учебный производитель МОДЕЛЬ-380", prompt.prompt.message_id);
r = await getRow();
await callback(`dr:${rid}:${r.revision}:approve:0`);
m = await clickModel("get");
assert.equal(m.stale, true);
assert.equal(m.usable, false);
assert.ok(messages.at(-1)?.text.includes("Исходная строка изменилась"));
await callback(confirmation);
assert.equal((await getModel()).usable, false);
m = await clickModel("start");
assert.equal(m.manufacturer, "");
assert.equal(m.model, "");
m = await clickModel("uncertain");
assert.equal(m.state, "needs_review");
assert.equal(m.prompt, null);
assert.equal(m.history.length, 2);
assert.equal((await getRow()).import_id, null);
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
  humanModelConfirmed: true,
  duplicateDecisionPrevented: true,
  sourceChangeInvalidates: true,
  finalState: m.state,
  originalUnchanged: true,
  previousDocumentsUnchanged: true,
  shopUnchanged: true,
  noImport: true,
  messages: messages.map((x) => x.id),
  incoming: "simulated",
  telegramClientVisual: false,
};
writeFileSync(new URL("result.json", dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
writeFileSync(new URL("messages.json", dir), JSON.stringify(messages, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(report));
