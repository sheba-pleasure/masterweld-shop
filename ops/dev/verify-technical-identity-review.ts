/** DEV only. Exercise audited product edits and technical recovery on an excluded training card. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";

const actor = 7540652678,
  productId = "65632401-e1f1-4353-8579-29f1a2ff553d";
const sourceRevision = "f9930e91-f3d9-42f7-816b-ff0488674df7";
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
const envPath = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(envPath).mode & 0o077, 0);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1);
}
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["PUBLIC_ORIGIN"], origin);
assert.equal(process.env["TELEGRAM_BOT_ID"], "8996533708");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.deepEqual(await (await fetch(origin + "/api/public/release-health")).json(), {
  ready: true,
  revision: sourceSha,
  environment: "dev",
});
process.env["SUPABASE_URL"] = origin + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
const rpc = db.rpc.bind(db) as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;
async function operation(name: string, args: Record<string, unknown>) {
  const result = await rpc(name, args);
  assert.equal(result.error, null);
  return result.data;
}
assert.deepEqual(await operation("mw_environment_identity", {}), {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const memberResult = await db.from("staff").select("*").eq("telegram_id", actor).single();
assert.equal(memberResult.error, null);
assert.ok(memberResult.data?.active && memberResult.data.role === "admin");
const member = memberResult.data;
function sql(q: string) {
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
    { input: q, encoding: "utf8" },
  ).trim();
}
const product = z
  .object({
    id: z.string(),
    sku: z.string(),
    title: z.string(),
    brand: z.string().nullable(),
    status: z.literal("hidden"),
    assortment_decision: z.literal("excluded"),
  })
  .parse(JSON.parse(sql("SELECT to_jsonb(p) FROM products p WHERE id='" + productId + "'")));
assert.equal(product.sku, "TEST-CHOICE-1794021822914");
assert.equal(product.title, "Учебный выбор модели");
assert.notEqual(product.brand, "Учебная смена модели");
assert.equal(
  sql("SELECT count(*) FROM technical_identity_events WHERE product_id='" + productId + "'"),
  "0",
  "Do not repeat a completed or partial run; inspect its receipt",
);
assert.equal(
  sql(
    "SELECT published_revision IS NULL FROM technical_cards WHERE product_id='" + productId + "'",
  ),
  "t",
);
assert.equal(
  sql("SELECT count(*) FROM document_review_prompts WHERE actor=7540652678 AND expires_at>now()"),
  "0",
);
assert.equal(
  sql(
    "SELECT count(*) FROM bot_editor_states WHERE staff_telegram_id=7540652678 AND consumed_at IS NULL AND expires_at>now()",
  ),
  "0",
);
const oldDoc = z
  .object({ sources: z.array(z.object({ kind: z.literal("synthetic") })) })
  .parse(
    JSON.parse(
      sql(
        "SELECT document FROM technical_revisions WHERE id='" +
          sourceRevision +
          "' AND product_id='" +
          productId +
          "'",
      ),
    ),
  );
assert.ok(oldDoc.sources.length > 0);
const sessionSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int(),
  phase: z.string(),
  change_id: z.string().uuid().nullable(),
  applied_revision: z.string().uuid().nullable(),
});
type Session = z.infer<typeof sessionSchema>;
async function session(op: string, s?: Session, extra: Record<string, unknown> = {}) {
  return z.object({ ok: z.literal(true), session: sessionSchema.nullable() }).parse(
    await operation("bot_technical_editor", {
      p_staff_telegram_id: actor,
      p_op: op,
      ...(s ? { p_session_id: s.id, p_revision: s.revision } : {}),
      ...extra,
    }),
  ).session;
}
async function requiredSession(op: string, s?: Session, extra: Record<string, unknown> = {}) {
  const value = await session(op, s, extra);
  assert.ok(value);
  return value;
}
assert.equal(await session("current"), null);
function protectedData() {
  return sql(`DO $f$ DECLARE t record; h text; q text; result jsonb:='{}'::jsonb; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN
      ('technical_cards','technical_revisions','technical_changes','technical_editor_sessions','technical_identity_events',
       'staff_audit_log','pending_actions','bot_pending_requests') ORDER BY tablename LOOP
      q:=format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM public.%I r',t.tablename);
      IF t.tablename='products' THEN q:=q||' WHERE id<>''${productId}'''; END IF;
      EXECUTE q INTO h; result:=result||jsonb_build_object(t.tablename,h);
    END LOOP;
    PERFORM set_config('mw.qa_fingerprint',result::text,false);
  END $f$; SELECT current_setting('mw.qa_fingerprint');`);
}
function stableProduct() {
  return sql(
    "SELECT to_jsonb(p)-ARRAY['updated_at','assortment_revision'] FROM products p WHERE id='" +
      productId +
      "'",
  );
}
function otherTechnical() {
  return sql(`SELECT jsonb_build_object(
    'cards',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]') FROM technical_cards r WHERE product_id<>'${productId}'),
    'revisions',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM technical_revisions r WHERE product_id<>'${productId}'),
    'changes',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM technical_changes r WHERE product_id<>'${productId}'),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM technical_identity_events r WHERE product_id<>'${productId}')
  )`);
}
const pendingIds: string[] = [];
function existingPending() {
  const excluded =
    pendingIds.map((id) => "'" + z.string().uuid().parse(id) + "'").join(",") || "NULL";
  return sql(`SELECT jsonb_build_object(
    'pending',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM pending_actions r ${pendingIds.length ? "WHERE id NOT IN (" + excluded + ")" : ""}),
    'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY request_id),'[]') FROM bot_pending_requests r ${pendingIds.length ? "WHERE pending_id NOT IN (" + excluded + ")" : ""})
  )`);
}
const before = {
  data: protectedData(),
  product: stableProduct(),
  technical: otherTechnical(),
  pending: existingPending(),
};
const { tg } = await import("../../src/lib/bot/telegram.server");
const me = await (await tg("getMe", {})).json();
assert.equal(me.result.id, 8996533708);
assert.equal(me.result.username, "testmw639bot");
const directory = new URL(
  "../.state/dev/artifacts/technical-identity-review-" + Date.now() + "/",
  import.meta.url,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(
  new URL("started.json", directory),
  JSON.stringify({ sourceSha, productId, sourceRevision, before }, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
const messages: { id: number; text: string; callbacks: string[] }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/")) {
    if (url.endsWith("/answerCallbackQuery")) return Response.json({ ok: true, result: true });
    assert.ok(url.endsWith("/sendMessage"), "No other Telegram effects");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, actor);
    const response = await realFetch(input, init),
      result = await response.clone().json();
    assert.equal(result.ok, true);
    const buttons = z
      .array(z.array(z.object({ callback_data: z.string().optional() })))
      .parse(body.reply_markup?.inline_keyboard ?? [])
      .flat();
    messages.push({
      id: result.result.message_id,
      text: body.text,
      callbacks: buttons.map((b) => b.callback_data ?? ""),
    });
    return response;
  }
  return realFetch(input, init);
}) as typeof fetch;
const { technicalEditor } = await import("../../src/lib/technical/editor.server");
const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const chat = { id: actor, type: "private" },
  from = { id: actor };
let updateId = Date.now();
async function callback(data: string) {
  await handleUpdate({
    update_id: ++updateId,
    callback_query: { id: "simulated", data, from, message: { message_id: 1, chat } },
  });
}
const techClick = (s: Session, action: string) =>
  technicalEditor(member, chat, from, { callback: "te:" + s.id + ":" + s.revision + ":" + action });
await technicalEditor(member, chat, from, { callback: "te:proposal:" + sourceRevision });
let s = await requiredSession("current");
await techClick(s, "verified");
s = await requiredSession("current");
assert.equal(s.phase, "preview");
await techClick(s, "apply");
s = await requiredSession("get", s);
assert.equal(s.phase, "applied");
assert.ok(s.applied_revision);
const publishedRevision = s.applied_revision;
const stale = z.object({ change_id: z.string().uuid() }).parse(
  await operation("bot_technical_catalog", {
    p_staff_telegram_id: actor,
    p_op: "preview",
    p_product_id: productId,
    p_document: JSON.parse(
      sql("SELECT document FROM technical_revisions WHERE id='" + publishedRevision + "'"),
    ),
    p_review_state: "verified",
    p_expected_version: Number(
      sql("SELECT version FROM technical_cards WHERE product_id='" + productId + "'"),
    ),
  }),
);
const previewSchema = z.object({ pending_id: z.string().uuid(), state: z.literal("pending") });
const changed = previewSchema.parse(
  await operation("bot_pending_preview", {
    p_staff_telegram_id: actor,
    p_request_id: randomUUID(),
    p_op: "prepare",
    p_product_id: productId,
    p_action: "brand",
    p_before: { brand: product.brand },
    p_after: { brand: "Учебная смена модели" },
  }),
);
pendingIds.push(changed.pending_id);
await callback("pcr:" + changed.pending_id);
assert.ok(messages.at(-1)?.text.includes("снимает прежние подтверждённые характеристики"));
await callback("pc:" + changed.pending_id);
assert.equal(
  sql(
    "SELECT published_revision IS NULL FROM technical_cards WHERE product_id='" + productId + "'",
  ),
  "t",
);
assert.equal(
  sql("SELECT count(*) FROM technical_identity_events WHERE product_id='" + productId + "'"),
  "1",
);
await callback("pc:" + changed.pending_id);
assert.equal(
  sql("SELECT count(*) FROM technical_identity_events WHERE product_id='" + productId + "'"),
  "1",
);
const refused = await rpc("bot_technical_catalog", {
  p_staff_telegram_id: actor,
  p_op: "apply",
  p_change_id: stale.change_id,
});
assert.equal(refused.error?.message, "TECH_CONFLICT");
await technicalEditor(member, chat, from, { callback: "te:open:" + productId });
assert.ok(messages.at(-1)?.text.includes("характеристики нужно проверить заново"));
assert.ok(messages.at(-1)?.callbacks.includes("te:proposal:" + publishedRevision));
const rollback = previewSchema.parse(
  await operation("bot_pending_preview", {
    p_staff_telegram_id: actor,
    p_request_id: randomUUID(),
    p_op: "rollback",
    p_source_pending_id: changed.pending_id,
  }),
);
pendingIds.push(rollback.pending_id);
await callback("pcr:" + rollback.pending_id);
await callback("pc:" + rollback.pending_id);
assert.equal(
  sql("SELECT count(*) FROM technical_identity_events WHERE product_id='" + productId + "'"),
  "2",
);
assert.equal(
  sql(
    "SELECT published_revision IS NULL FROM technical_cards WHERE product_id='" + productId + "'",
  ),
  "t",
);
await techClick(s, "apply"); // a receipt replay must not republish after product identity changed
assert.ok(messages.at(-1)?.text.includes("Подтверждение сохранено в истории"));
assert.ok(messages.at(-1)?.callbacks.includes("te:open:" + productId));
assert.equal(
  sql(
    "SELECT published_revision IS NULL FROM technical_cards WHERE product_id='" + productId + "'",
  ),
  "t",
);
assert.equal(await session("current"), null);
assert.equal(await operation("public_product_technical", { p_product_id: productId }), null);
assert.equal(protectedData(), before.data);
assert.equal(stableProduct(), before.product);
assert.equal(otherTechnical(), before.technical);
assert.equal(existingPending(), before.pending);
const report = {
  environment: "dev",
  sourceSha,
  productId,
  sourceRevision,
  publishedRevision,
  technicalSession: s.id,
  stalePreview: stale.change_id,
  pendingIds,
  identityEvents: 2,
  separatePreviewAndConfirm: true,
  duplicateEditOneEvent: true,
  stalePreviewBlocked: true,
  productFieldsRestored: true,
  oldTechnicalReceiptCannotRepublish: true,
  excludedNotPublished: true,
  otherPublicDataAndTechnicalUnchanged: true,
  incomingActions: "simulated",
  telegramClientViewed: false,
  ownerMessages: messages.map((m) => m.id),
  remainingTrainingState: "Technical history retained; requires recheck; no active editor",
};
writeFileSync(new URL("result.json", directory), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify(report));
