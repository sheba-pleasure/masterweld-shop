/** DEV only. Real DB and owner-only Telegram delivery; incoming actions are simulated. */
import assert from "node:assert/strict";
import { z } from "zod";
import { editorData } from "../../src/lib/technical/editor";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const actor = 7540652678;
const productId = "65632401-e1f1-4353-8579-29f1a2ff553d";
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
process.env["SUPABASE_URL"] = origin + "/backend";
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const health = await (await fetch(origin + "/api/public/release-health")).json();
assert.deepEqual(health, { ready: true, revision: sourceSha, environment: "dev" });
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
type Result = { data: unknown; error: unknown };
const sessionSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  revision: z.number().int(),
  phase: z.string(),
  data: editorData,
  prompt_message_id: z.number().nullable(),
  applied_revision: z.string().nullable(),
});
type Session = z.infer<typeof sessionSchema>;
const rpc = db.rpc.bind(db) as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<Result>;
assert.deepEqual((await rpc("mw_environment_identity", {})).data, {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const memberResult = await db.from("staff").select("*").eq("telegram_id", actor).single();
assert.equal(memberResult.error, null);
assert.ok(memberResult.data?.active && memberResult.data.role === "admin");
const member = memberResult.data;
const product = await db
  .from("products")
  .select("id,sku,title,status,assortment_decision")
  .eq("id", productId)
  .single();
assert.equal(product.error, null);
assert.deepEqual(product.data, {
  id: productId,
  sku: "TEST-CHOICE-1794021822914",
  title: "Учебный выбор модели",
  status: "hidden",
  assortment_decision: "excluded",
});
async function nullableEditor(op: string, extra: Record<string, unknown> = {}) {
  const result = await rpc("bot_technical_editor", {
    p_staff_telegram_id: actor,
    p_op: op,
    ...extra,
  });
  assert.equal(result.error, null);
  return z.object({ ok: z.literal(true), session: sessionSchema.nullable() }).parse(result.data)
    .session;
}
async function editor(op: string, extra: Record<string, unknown> = {}) {
  const result = await nullableEditor(op, extra);
  assert.ok(result, "Expected retained editor session");
  return result;
}
function doc(s: Session) {
  assert.ok(s.data.document);
  return s.data.document;
}
assert.equal(await nullableEditor("current"), null, "Existing editor must not be replaced");
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
assert.equal(
  sql("SELECT count(*) FROM document_review_prompts WHERE actor=7540652678 AND expires_at>now()"),
  "0",
);
assert.equal(
  sql("SELECT count(*) FROM technical_cards WHERE product_id='" + productId + "'"),
  "0",
  "Do not repeat this training run; inspect the retained receipt instead",
);
function fingerprint() {
  return sql(`DO $f$ DECLARE t record; h text; result jsonb:='{}'::jsonb; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN
      ('technical_cards','technical_revisions','technical_changes','technical_editor_sessions','staff_audit_log') ORDER BY tablename LOOP
      EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM public.%I r',t.tablename) INTO h;
      result:=result||jsonb_build_object(t.tablename,h);
    END LOOP;
    PERFORM set_config('mw.qa_fingerprint',result::text,false);
  END $f$; SELECT current_setting('mw.qa_fingerprint');`);
}
function otherTechnical() {
  return sql(`SELECT jsonb_build_object(
    'cards',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]') FROM technical_cards r WHERE product_id<>'${productId}'),
    'revisions',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM technical_revisions r WHERE product_id<>'${productId}'),
    'changes',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM technical_changes r WHERE product_id<>'${productId}')
  )`);
}
const before = fingerprint(),
  technicalBefore = otherTechnical();
const { tg } = await import("../../src/lib/bot/telegram.server");
const me = await (await tg("getMe", {})).json();
assert.equal(me.result.id, 8996533708);
assert.equal(me.result.username, "testmw639bot");
const directory = new URL(
  "../.state/dev/artifacts/consumable-characteristics-" + Date.now() + "/",
  import.meta.url,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(
  new URL("started.json", directory),
  JSON.stringify({ sourceSha, actor, productId, before, technicalBefore }, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
const messages: number[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/")) {
    assert.ok(url.endsWith("/sendMessage"), "No other Telegram effects");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, actor, "Owner-only test");
    const response = await realFetch(input, init);
    const result = await response.clone().json();
    assert.equal(result.ok, true);
    messages.push(result.result.message_id);
    return response;
  }
  return realFetch(input, init);
}) as typeof fetch;
const { technicalEditor } = await import("../../src/lib/technical/editor.server");
const { families, fields } = await import("../../src/lib/technical/editor");
const chat = { id: actor, type: "private" },
  from = { id: actor };
const invoke = (input: Parameters<typeof technicalEditor>[3]) =>
  technicalEditor(member, chat, from, input);
const click = (s: Session, action: string, index?: number) =>
  invoke({
    callback:
      "te:" + s.id + ":" + s.revision + ":" + action + (index === undefined ? "" : ":" + index),
  });
await invoke({ callback: "te:start:" + productId });
let s = await editor("current");
assert.equal(s.product_id, productId);
const sessionId = s.id;
await click(s, "families");
s = await editor("current");
const familyIndex = families.findIndex((f) => f.code === "tig_kit_parts");
assert.ok(familyIndex >= 16);
await click(s, "families", Math.floor(familyIndex / 8));
s = await editor("current");
assert.equal(s.data.page, Math.floor(familyIndex / 8));
await click(s, "family", familyIndex);
s = await editor("current");
assert.equal(doc(s).family_code, "tig_kit_parts");
assert.deepEqual(doc(s).values, []);
// Fixture-only source, explicitly synthetic; never impersonate a real manufacturer document.
doc(s).sources = [
  {
    key: "training",
    kind: "synthetic",
    publisher: "Учебный изготовитель",
    model: "[Учебный] Расходник",
    title: "[Учебный] Вымышленные значения, не паспорт",
    url: "https://example.invalid/consumable",
    locator: "Учебная таблица",
    checked_on: new Date().toISOString().slice(0, 10),
    sha256: "",
  },
];
s = await editor("save", { p_session_id: s.id, p_revision: s.revision, p_data: s.data });
await click(s, "fields");
s = await editor("current");
await click(
  s,
  "field",
  fields(s.data).findIndex((f) => f.attribute_code === "tig_cup_size"),
);
s = await editor("current");
await click(s, "process", 0);
s = await editor("current");
await click(s, "new");
s = await editor("current");
assert.ok(s.prompt_message_id > 0);
const beforeInvalid = s.revision;
await invoke({ text: "6,5", replyTo: s.prompt_message_id });
s = await editor("current");
assert.equal(s.revision, beforeInvalid, "Fractional nominal size rejected");
await invoke({ text: "6", replyTo: s.prompt_message_id });
s = await editor("current");
assert.equal(s.data.screen, "sources");
assert.equal(doc(s).values.length, 0, "Value without source not committed");
await click(s, "source", 0);
s = await editor("current");
assert.equal(doc(s).values[0].unit_code, "size_number");
await click(s, "fields");
s = await editor("current");
await click(
  s,
  "field",
  fields(s.data).findIndex((f) => f.attribute_code === "quantity_pack"),
);
s = await editor("current");
await click(s, "process", 0);
s = await editor("current");
await click(s, "new");
s = await editor("current");
await click(s, "unknown");
s = await editor("current");
assert.equal(doc(s).values[1].state, "unknown");
assert.equal(doc(s).values[1].value, null);
await click(s, "verified");
s = await editor("current");
assert.equal(s.phase, "preview");
assert.equal(
  sql("SELECT count(*) FROM technical_revisions WHERE product_id='" + productId + "'"),
  "0",
);
const preview = structuredClone(s);
await click(s, "apply");
s = await editor("get", { p_session_id: sessionId });
assert.equal(s.phase, "applied");
const appliedRevision = s.applied_revision;
await click(preview, "apply");
assert.equal((await editor("get", { p_session_id: sessionId })).applied_revision, appliedRevision);
assert.equal(
  sql("SELECT count(*) FROM technical_revisions WHERE product_id='" + productId + "'"),
  "1",
);
assert.equal(
  (await rpc("public_product_technical", { p_product_id: productId })).data,
  null,
  "Excluded remains hidden",
);
await click(s, "askundo");
await click(s, "undo_yes");
s = await editor("get", { p_session_id: sessionId });
assert.equal(s.phase, "undone");
assert.equal(await nullableEditor("current"), null);
assert.equal(
  sql(
    "SELECT published_revision IS NULL FROM technical_cards WHERE product_id='" + productId + "'",
  ),
  "t",
);
assert.equal(fingerprint(), before);
assert.equal(otherTechnical(), technicalBefore);
const report = {
  environment: "dev",
  sourceSha,
  productId,
  sessionId,
  appliedRevision,
  incomingActions: "simulated",
  realDatabase: true,
  ownerTelegramMessages: messages,
  telegramClientViewed: false,
  pagedFamilyChoice: true,
  fractionalCountRejected: true,
  sourceRequired: true,
  unknownNotZero: true,
  separatePreviewAndApply: true,
  duplicateApplyOneRevision: true,
  excludedNotPublished: true,
  undoRestoresNoPublishedCard: true,
  otherPublicTablesUnchanged: true,
  otherTechnicalCardsUnchanged: true,
};
writeFileSync(new URL("result.json", directory), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify(report));
