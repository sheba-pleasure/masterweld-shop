/** DEV-only training document. Incoming actions simulated; parser/storage/owner delivery real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { DocumentReview } from "../../src/lib/import/review-view";
import type { ImportView } from "../../src/lib/import/catalog-view";
import {
  parseSourceCallback,
  sourceButton,
  type SourceReviewResponse,
} from "../../src/lib/import/primary-source-view";
import type { ModelView } from "../../src/lib/import/model-view";
import type { IntakeView } from "../../src/lib/import/intake-view";
import {
  sourceFactButton,
  sourceFactFamilyButton,
  sourceFactReviewResponse,
  type SourceFactReview,
  type SourceFactAction,
} from "../../src/lib/technical/source-review-view";
import { sourceFactInputFields } from "../../src/lib/technical/source-review-input";
import { families } from "../../src/lib/technical/editor";
import type { TechnicalDocument } from "../../src/lib/technical/schema";
const artifactRoot = new URL("../.state/dev/artifacts/", import.meta.url);
if (existsSync(artifactRoot)) {
  const incomplete = readdirSync(artifactRoot).filter(
    (name) =>
      name.startsWith("source-fact-workflow-") &&
      existsSync(new URL(name + "/started.json", artifactRoot)) &&
      !existsSync(new URL(name + "/result.json", artifactRoot)),
  );
  assert.equal(
    incomplete.length,
    0,
    "Read unfinished receipts before another live rehearsal: " + incomplete.join(", "),
  );
}
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
assert.equal(
  sql(
    "SELECT count(*) FROM source_fact_reviews WHERE actor=7540652678 AND phase IN('reviewing','preview') AND expires_at>now()",
  ),
  "0",
);
assert.equal(
  (await call<{ idle: boolean }>("bot_source_fact_review", { p_actor: actor, p_op: "input" })).idle,
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
const messages: {
  id: number;
  text: string;
  buttons: string[];
  question: boolean;
  keyboard: { text: string; callback_data?: string }[][];
}[] = [];
interface SendBody {
  chat_id: number;
  message_id?: number;
  text: string;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard?: { text: string; callback_data?: string }[][];
  };
}
const originalFetch = globalThis.fetch;
let lastTelegramWrite = 0;
let handoffRequests = 0,
  handoffResponsesLost = 0,
  dropHandoffResponse = false;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.includes("/rpc/bot_source_fact_review") && init?.body) {
    const request = JSON.parse(String(init.body)) as { p_op?: string };
    if (request.p_op === "handoff") {
      handoffRequests++;
      const response = await originalFetch(input, init);
      if (dropHandoffResponse) {
        assert.equal(response.ok, true);
        dropHandoffResponse = false;
        handoffResponsesLost++;
        throw new TypeError("SIMULATED_RESPONSE_LOSS_AFTER_HANDOFF_COMMIT");
      }
      return response;
    }
  }
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
    assert.ok(
      url.startsWith("https://api.telegram.org/bot" + process.env["TELEGRAM_BOT_TOKEN"] + "/"),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 1100 - (Date.now() - lastTelegramWrite))),
    );
    lastTelegramWrite = Date.now();
    const response = await originalFetch(input, init),
      data = await response.clone().json();
    if (url.endsWith("/editMessageText") && !data.ok) return response;
    assert.equal(data.ok, true);
    messages.push({
      id: data.result.message_id,
      text: body.text,
      question: body.reply_markup?.force_reply === true,
      keyboard: body.reply_markup?.inline_keyboard ?? [],
      buttons: (body.reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((b) => b.callback_data)
        .filter((value): value is string => typeof value === "string"),
    });
    writeFileSync(new URL("messages.json", dir), JSON.stringify(messages, null, 2) + "\n", {
      mode: 0o600,
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

const dir = new URL("../.state/dev/artifacts/source-fact-workflow-" + stamp + "/", import.meta.url);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const docs: { id: string; reviewId: string; fingerprint: string }[] = [];
const sku = "TEST-FACTS-" + stamp;
let factReviewId: string | null = null,
  stage = "started";
const editorSessions: string[] = [];
assert.equal(sql("SELECT count(*) FROM products WHERE sku='" + sku + "'"), "0");
function saveStarted() {
  writeFileSync(
    new URL("started.json", dir),
    JSON.stringify({
      sha,
      docs,
      imports: ignoredImports,
      products: ignoredProducts,
      factReviewId,
      editorSessions,
      stage,
    }),
    { mode: 0o600 },
  );
}
saveStarted();
await tg("sendMessage", {
  chat_id: actor,
  text: "🧪 Учебная проверка характеристик. Создам скрытый учебный товар с прежними значениями, исправлю разбор паспорта и проверю отдельное подтверждение переноса. Затем сниму источник и отменю импорт. Товар на витрине не появится. Сообщения получаете только вы.",
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
        reply_to_message: { message_id: m.prompt!.message_id! },
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
    "source_fact_reviews",
    "technical_fact_origins",
    "product_source_reviews",
    "product_document_sources",
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
    ["source_fact_rows", "source_fact_reviews", "review_id"],
    ["source_fact_prompts", "source_fact_reviews", "review_id"],
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

const sourceBytes = Buffer.from(
  "УЧЕБНЫЙ ПАСПОРТ — НЕ ДЛЯ ПРОДАЖИ\nУчебная проверка " +
    stamp +
    ".\nИзготовитель: Учебный изготовитель\nМодель: УЧЕБНАЯ-220\nМодификации нет.\nМаксимальный ток MMA: 160 А\nПН MMA: 60 %\nУсловия ПН: 160 А при 40 °C\nНепроверенный параметр: Требует уточнения\n",
);
type SourceIntake = IntakeView & { id: string; checksum: string; state: string };
let passport = await call<SourceIntake>("bot_document_intake", {
  p_actor: actor,
  p_op: "upload",
  p_payload: {
    file_name: "УЧЕБНЫЙ-паспорт-" + stamp + ".txt",
    base64: sourceBytes.toString("base64"),
  },
});
const passportReceipt = { id: passport.id, reviewId: "", fingerprint: "" };
docs.push(passportReceipt);
saveStarted();
for (let i = 0; i < 60; i++) {
  passport = await call<SourceIntake>("bot_document_intake", {
    p_actor: actor,
    p_op: "get",
    p_id: passport.id,
  });
  if (passport.state === "review") break;
  assert.ok(["queued", "extracting"].includes(passport.state));
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(passport.state, "review");
assert.equal(passport.checksum, createHash("sha256").update(sourceBytes).digest("hex"));
passportReceipt.fingerprint = sql(
  "SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id='" + passport.id + "'",
);
saveStarted();
await callback("pds:home:" + pid);
await callback("pds:new:" + pid);
const recovery = messages.at(-1)!.buttons.find((b) => b.startsWith("pds:g:"));
assert.ok(recovery);
const reviewId = parseSourceCallback(recovery)!.id!;
const getSource = async () =>
  (
    await call<SourceReviewResponse>("bot_product_sources", {
      p_actor: actor,
      p_op: "get",
      p_id: reviewId,
    })
  ).review!;
let r = await getSource();
await callback(sourceButton(r, "docs", 0));
const choose = messages
  .at(-1)!
  .buttons.find((b) => parseSourceCallback(b)?.payload?.["document_id"] === passport.id);
assert.ok(choose);
await callback(choose);
r = await getSource();
assert.equal(r.document?.id, passport.id);
await callback(sourceButton(r, "blocks", 0));
const read = messages.at(-1)!.buttons.find((b) => parseSourceCallback(b)?.view === "read");
assert.ok(read);
await callback(read);
assert.ok(messages.at(-1)!.text.includes("НЕ ДЛЯ ПРОДАЖИ"));
await callback(recovery);
await callback(sourceButton(r, "kind", 0));
r = await getSource();
await callback(sourceButton(r, "preview"));
r = await getSource();
assert.equal(r.phase, "preview");
assert.ok(messages.at(-1)!.text.includes("УЧЕБНАЯ-220"));
const confirmSource = sourceButton(r, "confirm");
assert.ok(messages.at(-1)!.buttons.includes(confirmSource));
await callback(confirmSource);
r = await getSource();
assert.equal(r.phase, "confirmed");
assert.equal(r.usable, true);
const sourceId = r.source_id;
await callback(confirmSource);
assert.equal((await getSource()).source_id, sourceId);
assert.equal(
  sql("SELECT count(*) FROM product_document_sources WHERE review_id='" + reviewId + "'"),
  "1",
);
assert.equal(
  sql(
    "SELECT count(*) FROM staff_audit_log WHERE action='product_source_confirm' AND details->>'review_id'='" +
      reviewId +
      "'",
  ),
  "1",
);

// Seed only this draft training product with an explicit previous technical revision.
type Session = {
  id: string;
  revision: number;
  phase: string;
  data: { document: TechnicalDocument | null; [key: string]: unknown };
  source_binding?: { usable: boolean; total: number; unavailable: number };
};
const currentSession = async () =>
  (
    await call<{ session: Session | null }>("bot_technical_editor", {
      p_staff_telegram_id: actor,
      p_op: "current",
    })
  ).session;
const readSession = async (id: string) =>
  (
    await call<{ session: Session }>("bot_technical_editor", {
      p_staff_telegram_id: actor,
      p_op: "get",
      p_session_id: id,
    })
  ).session;
const productState = () =>
  sql("SELECT status::text||'/'||assortment_decision::text FROM products WHERE id='" + pid + "'");
await callback("te:start:" + pid);
let session = await currentSession();
assert.ok(session);
editorSessions.push(session.id);
stage = "previous_characteristics";
saveStarted();
const baseDocument: TechnicalDocument = {
  family_code: "power_mma",
  sources: [
    {
      key: "manual",
      kind: "synthetic",
      publisher: "Учебный изготовитель",
      model: "УЧЕБНАЯ-220",
      title: "[Учебный] Прежние сведения для проверки сравнения",
      url: "https://example.invalid/source-fact-workflow",
      locator: "Учебная таблица",
      checked_on: new Date().toISOString().slice(0, 10),
      sha256: "",
    },
  ],
  values: [20, 100].map((value, index) => ({
    attribute_code: index ? "mma_current_max_a" : "mma_current_min_a",
    process: "mma" as const,
    state: "known" as const,
    value,
    unit_code: "a",
    context: {},
    source_key: "manual",
  })),
};
session = (
  await call<{ session: Session }>("bot_technical_editor", {
    p_staff_telegram_id: actor,
    p_op: "save",
    p_session_id: session.id,
    p_revision: session.revision,
    p_data: { ...session.data, document: baseDocument },
  })
).session;
await callback("te:" + session.id + ":" + session.revision + ":verified");
session = await readSession(session.id);
assert.equal(session.phase, "preview");
const baselineApply = "te:" + session.id + ":" + session.revision + ":apply";
assert.ok(messages.at(-1)!.buttons.includes(baselineApply));
await callback(baselineApply);
session = await readSession(session.id);
assert.equal(session.phase, "applied");
const baseRevision = sql(
  "SELECT published_revision FROM technical_cards WHERE product_id='" + pid + "'",
);
assert.match(baseRevision, /^[0-9a-f-]{36}$/);
assert.equal(productState(), "draft/review");
await callback(recovery);
r = await getSource();
const familyIndex = families.findIndex((f) => f.code === "power_mma");
assert.ok(familyIndex >= 0);
await callback(sourceFactFamilyButton(r.id, r.revision, Math.floor(familyIndex / 8)));
const startFacts = sourceFactFamilyButton(r.id, r.revision, familyIndex, true);
assert.ok(messages.at(-1)!.buttons.includes(startFacts));
const startMessage = messages.at(-1)!.id;
await callback(startFacts, startMessage);
let f = sourceFactReviewResponse.parse(
  await call("bot_source_fact_review", { p_actor: actor, p_op: "current" }),
);
factReviewId = f.review.id;
stage = "source_fact_review";
saveStarted();
assert.equal(f.document_id, passport.id);
assert.equal(f.document_checksum, passport.checksum);
assert.equal(f.review.product_id, pid);
const getFacts = async (index = 0): Promise<SourceFactReview> =>
  sourceFactReviewResponse.parse(
    await call("bot_source_fact_review", {
      p_actor: actor,
      p_op: "get",
      p_id: factReviewId,
      p_index: index,
    }),
  );
const actFacts = async (action: SourceFactAction, index = 0, ...args: number[]) => {
  const current = await getFacts(index);
  await callback(sourceFactButton(current.review, action, index, ...args));
  return getFacts(index);
};
await callback(startFacts, startMessage);
assert.equal((await getFacts()).review.id, factReviewId);
assert.equal(sql("SELECT count(*) FROM source_fact_reviews WHERE product_id='" + pid + "'"), "1");
const allRows = [];
for (let index = 0; index < f.counts.total; index++) {
  const item = (await getFacts(index)).row;
  assert.ok(item);
  allRows.push(item);
}
const maxRow = allRows.find((x) => x.draft?.attribute_code === "mma_current_max_a")!.row_index;
const dutyRow = allRows.find((x) => x.draft?.attribute_code === "mma_duty_cycle_pct")!.row_index;
assert.notEqual(maxRow, dutyRow);
const originalProposal = structuredClone((await getFacts(maxRow)).row!.proposal);
assert.equal(originalProposal.value, 160);
const sendReply = async (text: string, messageId: number) => {
  await handleUpdate({
    update_id: 1,
    message: {
      message_id: 1000 + messages.length,
      chat,
      from,
      text,
      reply_to_message: { message_id: messageId },
    },
  });
};
async function ask(field: (typeof sourceFactInputFields)[number], index: number) {
  const answer = await actFacts("prompt", index, sourceFactInputFields.indexOf(field));
  assert.ok(answer.prompt?.message_id);
  return answer.prompt.message_id;
}
const publisherQuestion = await ask("publisher", maxRow);
await sendReply("Учебный изготовитель", publisherQuestion);
assert.equal((await getFacts()).review.publisher, "Учебный изготовитель");
for (const item of allRows)
  if (![maxRow, dutyRow].includes(item.row_index)) await actFacts("skip", item.row_index);
await actFacts("preview");
assert.equal((await getFacts()).review.phase, "reviewing");
assert.ok(messages.at(-1)!.text.includes("Остались строки"));
await actFacts("quote", maxRow, 0);
assert.ok(messages.at(-1)!.text.includes("Максимальный ток MMA: 160 А"));
await actFacts("accept", maxRow);
f = await getFacts(maxRow);
assert.equal(f.row!.decision, "accepted");
const oldAccept = sourceFactButton(f.review, "accept", maxRow);
let question = await ask("value", maxRow);
await sendReply("159", question);
f = await getFacts(maxRow);
assert.equal(f.row!.draft!.value, 159);
assert.equal(f.row!.decision, "pending");
const correctedRevision = f.review.revision;
await callback(oldAccept);
assert.equal((await getFacts(maxRow)).review.revision, correctedRevision);
question = await ask("value", maxRow);
await handleUpdate({
  update_id: 1,
  message: { message_id: 1001 + messages.length, chat, from, text: "/cancel" },
});
assert.equal((await getFacts(maxRow)).prompt, null);
assert.equal((await getFacts(maxRow)).row!.draft!.value, 159);
const currentQuestion = await ask("value", maxRow);
assert.notEqual(currentQuestion, question);
await sendReply("160", question);
assert.equal((await getFacts(maxRow)).row!.draft!.value, 159);
assert.equal((await getFacts(maxRow)).prompt!.message_id, currentQuestion);
// Another editor must not steal this question.
await callback("te:start:" + pid);
assert.equal(await currentSession(), null);
assert.equal((await getFacts(maxRow)).prompt!.message_id, currentQuestion);
await sendReply("160", currentQuestion);
assert.deepEqual((await getFacts(maxRow)).row!.proposal, originalProposal);
await actFacts("accept", maxRow);
const incompleteDuty = await getFacts(dutyRow);
await callback(sourceFactButton(incompleteDuty.review, "accept", dutyRow));
assert.equal((await getFacts(dutyRow)).row!.decision, "pending");
for (const [field, value] of [
  ["current_a", "160"],
  ["temperature_c", "40"],
] as const) {
  const prompt = await ask(field, dutyRow);
  await sendReply(value, prompt);
}
const conditionsLocation = await ask("locator", dutyRow);
await sendReply("Строки «ПН MMA» и «Условия ПН» учебного паспорта", conditionsLocation);
await actFacts("accept", dutyRow);
f = await getFacts();
assert.equal(f.counts.accepted, 2);
assert.equal(f.counts.pending, 0);
assert.ok(f.counts.skipped > 0);
const denied = await rpc("bot_source_fact_review", {
  p_actor: 1032243677,
  p_op: "get",
  p_id: factReviewId,
});
assert.ok(denied.error); // No message is sent to this seller.
assert.equal((denied.error as { message: string }).message, "SOURCE_FACT_DENIED");
f = await actFacts("preview");
assert.equal(f.review.phase, "preview");
const plan = f.review.merge_preview;
assert.ok(plan);
assert.deepEqual(plan.before_document, baseDocument);
assert.deepEqual(plan.changes.map((x) => x.kind).sort(), ["added", "replaced", "retained"]);
for (let index = 0; index < plan.changes.length; index++) await actFacts("changes", 0, index);
assert.equal(
  sql("SELECT published_revision FROM technical_cards WHERE product_id='" + pid + "'"),
  baseRevision,
);
assert.equal(sql("SELECT count(*) FROM technical_revisions WHERE product_id='" + pid + "'"), "1");
const beforeHandoffSessions = sql(
  "SELECT count(*) FROM technical_editor_sessions WHERE product_id='" + pid + "'",
);
await actFacts("askhandoff");
assert.equal(
  sql("SELECT count(*) FROM technical_editor_sessions WHERE product_id='" + pid + "'"),
  beforeHandoffSessions,
);
assert.equal(
  sql("SELECT count(*) FROM technical_fact_origins WHERE product_id='" + pid + "'"),
  "0",
);
f = await getFacts();
const confirmHandoff = sourceFactButton(f.review, "handoff");
assert.ok(messages.at(-1)!.buttons.includes(confirmHandoff));
stage = "confirming_handoff";
saveStarted();
// The real database commits once; deliberately lose just that HTTP response.
dropHandoffResponse = true;
await callback(confirmHandoff);
assert.equal(handoffResponsesLost, 1);
f = await getFacts();
assert.equal(f.review.phase, "handed");
const handedSession = f.review.editor_session_id;
assert.ok(handedSession);
editorSessions.push(handedSession);
stage = "handed";
saveStarted();
await callback(confirmHandoff);
await callback(confirmHandoff);
assert.equal(handoffRequests, 1);
assert.equal((await getFacts()).review.editor_session_id, handedSession);
assert.equal(
  sql(
    "SELECT count(*) FROM staff_audit_log WHERE action='source_fact_handoff' AND details->>'review_id'='" +
      factReviewId +
      "'",
  ),
  "1",
);
assert.equal(
  sql("SELECT count(*) FROM technical_fact_origins WHERE review_id='" + factReviewId + "'"),
  "2",
);
session = await readSession(handedSession);
assert.ok(session.data.document);
const handedDocument = session.data.document;
assert.deepEqual(
  {
    ...handedDocument,
    values: handedDocument.values.map((value) => {
      const plain = { ...value };
      delete plain.origin_ref;
      return plain;
    }),
  },
  plan.after_document,
);
assert.equal(handedDocument.values.filter((v) => v.origin_ref).length, 2);
assert.equal(sql("SELECT count(*) FROM technical_revisions WHERE product_id='" + pid + "'"), "1");
assert.equal(productState(), "draft/review");
await callback("te:" + handedSession + ":0:resume");
await callback("te:" + handedSession + ":" + session.revision + ":verified");
session = await readSession(handedSession);
assert.equal(session.phase, "preview");
const finalApply = "te:" + handedSession + ":" + session.revision + ":apply";
assert.ok(messages.at(-1)!.buttons.includes(finalApply));
await callback(finalApply);
await callback(finalApply);
session = await readSession(handedSession);
assert.equal(session.phase, "applied");
const finalRevision = sql(
  "SELECT published_revision FROM technical_cards WHERE product_id='" + pid + "'",
);
assert.notEqual(finalRevision, baseRevision);
assert.equal(sql("SELECT count(*) FROM technical_revisions WHERE product_id='" + pid + "'"), "2");
assert.equal(productState(), "draft/review");
stage = "technical_change_applied";
saveStarted();
r = await getSource();

await callback(sourceButton(r, "askoff"));
r = await getSource();
const withdraw = sourceButton(r, "off");
await callback(withdraw);
await callback(withdraw);
assert.equal((await getSource()).phase, "withdrawn");
await callback(confirmSource);
assert.equal((await getSource()).phase, "withdrawn");
assert.equal((await getSource()).usable, false);

const technicalAfterWithdrawal = await call<{
  card: {
    published: unknown;
    published_revision: string | null;
    source_review: { usable: boolean; unavailable: number };
  };
}>("bot_technical_catalog", { p_staff_telegram_id: actor, p_op: "read", p_product_id: pid });
assert.equal(technicalAfterWithdrawal.card.published, null);
assert.equal(technicalAfterWithdrawal.card.published_revision, null);
assert.equal(technicalAfterWithdrawal.card.source_review.usable, false);
assert.equal(technicalAfterWithdrawal.card.source_review.unavailable, 2);
await callback(finalApply);
assert.equal(
  sql("SELECT published_revision FROM technical_cards WHERE product_id='" + pid + "'"),
  finalRevision,
);
assert.equal(sql("SELECT count(*) FROM technical_revisions WHERE product_id='" + pid + "'"), "2");
await callback("te:proposal:" + finalRevision);
session = await currentSession();
assert.ok(session);
const staleClone = session.id;
editorSessions.push(staleClone);
stage = "withdrawn_source_review";
saveStarted();
assert.equal(session.source_binding?.usable, false);
assert.equal(session.source_binding?.unavailable, 2);
assert.ok(!messages.at(-1)!.buttons.some((b) => b.endsWith(":verified") || b.endsWith(":apply")));
await callback("te:" + session.id + ":" + session.revision + ":verified");
session = await readSession(staleClone);
assert.equal(session.phase, "editing");
await callback("te:" + session.id + ":" + session.revision + ":cancel");
session = await readSession(staleClone);
const cancelClone = "te:" + session.id + ":" + session.revision + ":cancel_now";
assert.ok(messages.at(-1)!.buttons.includes(cancelClone));
await callback(cancelClone);
assert.equal((await readSession(staleClone)).phase, "canceled");
assert.equal(await currentSession(), null);
await callback(confirmHandoff);
assert.equal((await getFacts()).review.editor_session_id, handedSession);
assert.equal(handoffRequests, 1);
assert.equal(
  (await call<{ idle: boolean }>("bot_source_fact_review", { p_actor: actor, p_op: "input" })).idle,
  true,
);
assert.equal(
  sql(
    "SELECT count(*) FROM source_fact_reviews WHERE actor=7540652678 AND phase IN('reviewing','preview')",
  ),
  "0",
);

await callback("ci:undo_preview:" + batch.id);
await callback("ci:undo:" + batch.id);
assert.equal((await getImport(batch.id)).state, "undone");
assert.equal(
  sql("SELECT status::text||'/'||assortment_decision::text FROM products WHERE id='" + pid + "'"),
  "hidden/excluded",
);
assert.equal(
  sql(
    "SELECT count(*) FROM product_source_reviews WHERE actor=7540652678 AND phase IN('draft','preview','withdraw_preview')",
  ),
  "0",
);
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
  text: "✅ Учебная проверка характеристик завершена. Исправления сохранены, старые кнопки не меняют новый шаг. Прежнее нужное значение осталось; перенос создал один черновик даже при потере ответа и повторах. Отзыв источника заблокировал сведения. Импорт отменён, учебный товар скрыт и исключён.",
});
const report = {
  ok: true,
  sourceSha: sha,
  documents: docs,
  imports: ignoredImports,
  products: ignoredProducts,
  reviewId,
  sourceId,
  factReviewId,
  editorSessions,
  baseRevision,
  finalRevision,
  originalQuotePreserved: true,
  humanDecisionsRequired: true,
  correctionWithdrawsAcceptance: true,
  canceledInputPreservesDraft: true,
  staleQuestionAndButtonRejected: true,
  exclusiveEditorQuestion: true,
  retainedPreviousValue: true,
  displayedMergeMatchesDraft: true,
  handoffNeedsSeparateConfirmation: true,
  handoffCreatesNoTechnicalRevision: true,
  handoffRequests,
  handoffResponsesLost,
  responseLossAfterCommitSimulated: true,
  oneHandoffEditor: true,
  oneHandoffAudit: true,
  originCount: 2,
  separateApplyCreatesOneRevision: true,
  withdrawnSourceBlocksUse: true,
  staleCloneCannotApply: true,
  receiptStillPointsToOriginalEditor: true,
  productNeverPublished: true,
  modelShownBeforeConfirmation: true,
  oneSource: true,
  withdrawn: true,
  oldConfirmCannotRestore: true,
  productHiddenExcluded: true,
  previousShopUnchanged: true,
  previousTechnicalDataUnchanged: true,
  previousDocumentsUnchanged: Object.keys(oldDocs).length,
  incomingActionsSimulated: true,
  telegramClientViewed: false,
  realParserDatabaseTelegramDelivery: true,
  messages: messages.map((m) => m.id),
};
stage = "complete";
saveStarted();
writeFileSync(new URL("result.json", dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
