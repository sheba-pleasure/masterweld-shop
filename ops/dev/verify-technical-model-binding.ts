/** DEV-only training document. Incoming actions simulated; parser/storage/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { DocumentReview } from "../../src/lib/import/review-view";
import type { ImportView } from "../../src/lib/import/catalog-view";
import type { ProductModelChoice } from "../../src/lib/import/model-choice-view";
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
const callback = (data: string, messageId = messages.at(-1)!.id) =>
  handleUpdate({
    update_id: 1,
    callback_query: {
      id: "dev-technical-model-simulated",
      data,
      from,
      message: { chat, message_id: messageId },
    },
  });

const dir = new URL(
  "../.state/dev/artifacts/technical-model-binding-" + stamp + "/",
  import.meta.url,
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const docs: { id: string; reviewId: string; fingerprint: string }[] = [];
const sku = "TEST-TECHMODEL-" + stamp;
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
  text: "🧪 Учебная проверка связи модели и характеристик. Создам скрытый учебный товар, проверю подтверждение, смену модели и старые кнопки. Затем отменю импорт. Сообщения получаете только вы.",
});
async function document(modelName: string) {
  const bytes = Buffer.from(
    "sku\ttitle\tprice\tmodel\n" + sku + "\tУчебный выбор модели\t10\t" + modelName + "\n",
  );
  type Intake = IntakeView & { id: string; checksum: string; state: string };
  let d = await call<Intake>("bot_document_intake", {
    p_actor: actor,
    p_op: "upload",
    p_payload: {
      file_name: "ТЕСТ-выбор-модели-" + modelName + "-" + stamp + ".tsv",
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

function technicalFingerprint() {
  const exclude = ignoredProducts.length
    ? " WHERE product_id NOT IN (" + ignoredProducts.map((id) => "'" + id + "'").join(",") + ")"
    : "";
  const names = [
    "technical_cards",
    "technical_changes",
    "technical_revisions",
    "technical_editor_sessions",
    "technical_identity_events",
    "technical_model_generations",
    "product_model_choices",
    "product_model_selection",
  ];
  const digest = names.map(
    (name) =>
      "SELECT '" +
      name +
      "' name,md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]')::text) digest FROM " +
      name +
      " r" +
      exclude,
  );
  for (const [name, target, key] of [
    ["technical_editor_models", "technical_editor_sessions", "session_id"],
    ["technical_change_models", "technical_changes", "change_id"],
  ])
    digest.push(
      "SELECT '" +
        name +
        "' name,md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]')::text) digest FROM " +
        name +
        " r JOIN " +
        target +
        " t ON t.id=r." +
        key +
        exclude,
    );
  return sql("SELECT jsonb_object_agg(name,digest) FROM (" + digest.join(" UNION ALL ") + ") s");
}
const previousTechnical = technicalFingerprint();
let batch = await document("УЧЕБНАЯ-220");
await callback("ci:apply:" + batch.id + ":" + batch.revision);
batch = await getImport(batch.id);
assert.equal(batch.state, "applied");
const pid = sql(
  "SELECT product_id FROM catalog_import_items WHERE batch_id='" + batch.id + "' AND line=2",
);
assert.match(pid, /^[0-9a-f-]{36}$/);
ignoredProducts.push(pid);
saveStarted();
assert.equal(sql("SELECT status FROM products WHERE id='" + pid + "'"), "draft");
await callback("mp:" + pid + ":0");
await callback("pm:pick:" + batch.id + ":2");
const pick = messages.at(-1)!.buttons.find((b) => b.startsWith("pm:confirm:"));
assert.ok(pick);
await callback(pick);
const context = () =>
  call<{
    card: {
      model_context: { state: string; identity: { model: string } };
      model_review: { required: boolean };
      published_revision: string | null;
    };
  }>("bot_technical_catalog", { p_staff_telegram_id: actor, p_op: "read", p_product_id: pid });
assert.equal((await context()).card.model_context.identity.model, "УЧЕБНАЯ-220");
await callback("te:open:" + pid);
assert.ok(
  messages.some(
    (m) => m.text.includes("УЧЕБНАЯ-220") && m.text.includes("Характеристики проверяются"),
  ),
);
await callback("te:start:" + pid);
type Session = {
  id: string;
  revision: number;
  phase: string;
  data: Record<string, unknown>;
  model_binding: { matches: boolean; captured: unknown };
};
const currentSession = () =>
  call<{ session: Session }>("bot_technical_editor", {
    p_staff_telegram_id: actor,
    p_op: "current",
  });
let session = (await currentSession()).session;
assert.ok(session.model_binding.matches);
const doc = {
  family_code: "power_mma",
  sources: [
    {
      key: "manual",
      kind: "synthetic",
      publisher: "Учебный изготовитель",
      model: "УЧЕБНАЯ-220",
      title: "[Учебный] Не паспорт настоящего товара",
      url: "https://example.invalid/model-binding",
      locator: "Учебная таблица 1",
      checked_on: new Date().toISOString().slice(0, 10),
      sha256: "",
    },
  ],
  values: [
    {
      attribute_code: "mma_current_max_a",
      process: "mma",
      state: "known",
      value: 100,
      unit_code: "a",
      context: {},
      source_key: "manual",
    },
  ],
};
session = (
  await call<{ session: Session }>("bot_technical_editor", {
    p_staff_telegram_id: actor,
    p_op: "save",
    p_session_id: session.id,
    p_revision: session.revision,
    p_data: { ...session.data, document: doc },
  })
).session;
await callback("te:" + session.id + ":" + session.revision + ":verified");
session = (await currentSession()).session;
assert.equal(session.phase, "preview");
const apply = "te:" + session.id + ":" + session.revision + ":apply";
assert.ok(messages.at(-1)!.buttons.includes(apply));
assert.ok(messages.at(-1)!.text.includes("УЧЕБНАЯ-220"));
await callback(apply);
const readSession = () =>
  call<{ session: Session }>("bot_technical_editor", {
    p_staff_telegram_id: actor,
    p_op: "get",
    p_session_id: session.id,
  });
session = (await readSession()).session;
assert.equal(session.phase, "applied");
const revision = (await context()).card.published_revision;
assert.ok(revision);
await callback(apply);
assert.equal((await context()).card.published_revision, revision);
assert.equal(sql("SELECT count(*) FROM technical_revisions WHERE product_id='" + pid + "'"), "1");
assert.equal(
  sql(
    "SELECT count(*) FROM technical_change_models m JOIN technical_changes c ON c.id=m.change_id WHERE c.product_id='" +
      pid +
      "'",
  ),
  "1",
);
await callback("pm:clear:" + pid);
const clear = messages.at(-1)!.buttons.find((b) => b.startsWith("pm:confirm:"));
assert.ok(clear);
await callback(clear);
const card = (await context()).card;
assert.equal(card.model_context.state, "withdrawn");
assert.equal(card.model_review.required, true);
assert.equal(card.published_revision, null);
await callback(apply); // Receipt replay does not restore technical publication.
assert.equal((await context()).card.published_revision, null);
await callback("te:open:" + pid);
assert.ok(messages.at(-1)!.buttons.includes("te:proposal:" + revision));
await callback("ci:undo_preview:" + batch.id);
await callback("ci:undo:" + batch.id);
assert.equal((await getImport(batch.id)).state, "undone");
assert.equal(
  sql("SELECT status::text||'/'||assortment_decision::text FROM products WHERE id='" + pid + "'"),
  "hidden/excluded",
);
assert.equal((await currentSession()).session, null);
assert.equal(
  (await call<{ idle: boolean }>("bot_document_review", { p_actor: actor, p_op: "input" })).idle,
  true,
);
assert.equal(shopFingerprint(), beforeShop);
assert.equal(technicalFingerprint(), previousTechnical);
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
  text: "✅ Учебная проверка завершена. Модель показана перед подтверждением характеристик. Повтор сохранил одну редакцию; снятие выбора модели скрыло её, старая кнопка не вернула сведения. Учебный импорт отменён, товар скрыт и исключён. Прежние товары и заказы не изменились.",
});
const report = {
  ok: true,
  sourceSha: sha,
  documents: docs,
  imports: ignoredImports,
  products: ignoredProducts,
  session: session.id,
  revision,
  modelShownBeforeConfirmation: true,
  oneBoundRevision: true,
  withdrawalHidesFacts: true,
  oldApplyCannotRepublish: true,
  productHiddenExcluded: true,
  previousShopUnchanged: true,
  previousTechnicalDataUnchanged: true,
  previousDocumentsUnchanged: Object.keys(oldDocs).length,
  incomingActionsSimulated: true,
  telegramClientViewed: false,
  realParserDatabaseTelegramDelivery: true,
  messages: messages.map((m) => m.id),
};
writeFileSync(new URL("result.json", dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
