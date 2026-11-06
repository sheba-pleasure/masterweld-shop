/** DEV only: actual storage and Telegram sendMessage; incoming commands are simulated. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { StaffMember } from "../../src/lib/bot/permissions";
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
const memberResult = await db.from("staff").select("*").eq("telegram_id", actor).single();
assert.equal(memberResult.error, null);
const member = memberResult.data as StaffMember;
assert.equal(member.active, true);
assert.equal(member.role, "admin");
const productId = "20000000-0000-4000-8000-000000000001";
const product = await db.from("products").select("sku,title").eq("id", productId).single();
assert.equal(product.data?.sku, "DEV-001");
assert.equal(product.data?.title, "ТЕСТ — сварочный аппарат");
const { tg } = await import("../../src/lib/bot/telegram.server");
const me = await (await tg("getMe", {})).json();
assert.equal(me.result.id, 8996533708);
assert.equal(me.result.username, "testmw639bot");
const rpc = db.rpc.bind(db) as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: { session: unknown } | null; error: unknown }>;
async function editor(op: string) {
  const r = await rpc("bot_technical_editor", { p_staff_telegram_id: actor, p_op: op });
  assert.equal(r.error, null);
  assert.ok(r.data);
  return r.data.session;
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
function ordinary() {
  return JSON.parse(
    sql(
      "SELECT coalesce((SELECT to_jsonb(s) FROM bot_editor_states s WHERE staff_telegram_id=7540652678),'null'::jsonb);",
    ),
  );
}
function unchanged() {
  return sql(`SELECT jsonb_build_object(
    'products',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM products r),
    'orders',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM shop_orders r),
    'notifications',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id)::text) FROM order_notifications r),
    'technical',(SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]'::jsonb)::text) FROM technical_cards r));`);
}
const previous = ordinary();
assert.ok(
  !previous || previous.consumed_at || Date.parse(previous.expires_at) <= Date.now(),
  "Do not replace the owner's unfinished ordinary input",
);
assert.equal(await editor("current"), null, "Do not replace the owner's technical draft");
const before = unchanged();

const messages: { messageId: number; text: string; buttons: string[] }[] = [];
let loseNextResult = false;
let committed: { pending_id: string; request_id: string } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/answerCallbackQuery"))
    return Response.json({ ok: true, result: true });
  if (
    url.includes("/rpc/bot_pending_preview") &&
    loseNextResult &&
    JSON.parse(String(init?.body)).p_op !== "read"
  ) {
    loseNextResult = false;
    const response = await realFetch(input, init);
    assert.ok(response.ok);
    committed = await response.json();
    return Response.json({ message: "SIMULATED_RESPONSE_LOSS" }, { status: 503 });
  }
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/sendMessage")) {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, actor);
    const response = await realFetch(input, init),
      result = await response.clone().json();
    assert.equal(result.ok, true);
    messages.push({
      messageId: result.result.message_id,
      text: body.text,
      buttons: (body.reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((b: { callback_data: string }) => b.callback_data),
    });
    return response;
  }
  return realFetch(input, init);
}) as typeof fetch;

const { handleUpdate } = await import("../../src/lib/bot/handler.server");
const chat = { id: actor, type: "private" },
  from = { id: actor };
let sequence = Date.now();
const makeCommand = (text: string) => ({
  update_id: ++sequence,
  message: { message_id: sequence, text, from, chat },
});
const callback = (data: string) =>
  handleUpdate({
    update_id: ++sequence,
    callback_query: { id: "dev-simulated", data, from, message: { chat, message_id: sequence } },
  });
const command = makeCommand("/set title DEV-001 ТЕСТ — восстановление прямой команды");
loseNextResult = true;
await handleUpdate(command);
assert.ok(committed);
const direct = committed as { pending_id: string; request_id: string };
assert.equal(messages.at(-1)?.buttons[0], "prr:" + direct.request_id);
assert.ok(messages.at(-1)?.text.includes("мог сохраниться"));
assert.equal(unchanged(), before);
assert.deepEqual(ordinary(), previous);
execFileSync("docker", ["restart", "mw-dev-app"], { stdio: "pipe" });
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(origin + "/api/public/release-health");
    if (r.ok && (await r.json()).revision === sha) {
      ready = true;
      break;
    }
  } catch {
    /* bounded readiness */
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.ok(ready);
await callback("prr:" + direct.request_id);
assert.ok(messages.at(-1)?.buttons.includes("pc:" + direct.pending_id));
await handleUpdate(command);
assert.ok(messages.at(-1)?.buttons.includes("pc:" + direct.pending_id));
await handleUpdate(makeCommand("/actions"));
assert.ok(messages.at(-1)?.buttons.includes("pcr:" + direct.pending_id));
await callback("pcx:" + direct.pending_id);
await handleUpdate(command);
assert.ok(messages.at(-1)?.text.includes("Отменено"));
assert.equal(
  Number(
    sql("SELECT count(*) FROM bot_pending_requests WHERE request_id='" + direct.request_id + "';"),
  ),
  1,
);

// Existing applied DEV test reversal is still current. Prepare/cancel its undo
// without applying any product mutation; preserve the original applied action.
const source = sql(
  "SELECT a.id FROM pending_actions a JOIN products p ON p.id=a.product_id " +
    "WHERE a.staff_telegram_id=7540652678 AND a.product_id='" +
    productId +
    "' AND a.action='title' " +
    "AND a.outcome='applied' AND a.after_value=jsonb_build_object('title',p.title) " +
    "AND a.before_value IS DISTINCT FROM a.after_value ORDER BY a.created_at DESC LIMIT 1;",
);
assert.match(source, /^[0-9a-f-]{36}$/);
const sourceBefore = sql("SELECT to_jsonb(a) FROM pending_actions a WHERE id='" + source + "';");
const auditCount = () =>
  Number(
    sql(
      "SELECT count(*) FROM staff_audit_log WHERE action='catalog_rollback_prepared' AND details->>'source_pending_id'='" +
        source +
        "';",
    ),
  );
const auditBefore = auditCount();
loseNextResult = true;
await callback("rb:" + source);
const reverse = committed as { pending_id: string; request_id: string };
assert.notEqual(reverse.pending_id, direct.pending_id);
assert.equal(messages.at(-1)?.buttons[0], "prr:" + reverse.request_id);
await callback("prr:" + reverse.request_id);
assert.ok(messages.at(-1)?.buttons.includes("pc:" + reverse.pending_id));
await callback("rb:" + source);
assert.ok(messages.at(-1)?.buttons.includes("pc:" + reverse.pending_id));
assert.equal(auditCount(), auditBefore + 1);
await callback("pcx:" + reverse.pending_id);
await callback("rb:" + source);
assert.ok(messages.at(-1)?.text.includes("Отменено"));
assert.equal(auditCount(), auditBefore + 1);
assert.equal(
  sql("SELECT to_jsonb(a) FROM pending_actions a WHERE id='" + source + "';"),
  sourceBefore,
);
for (const item of [direct, reverse]) {
  assert.equal(
    sql("SELECT outcome FROM pending_actions WHERE id='" + item.pending_id + "';"),
    "canceled",
  );
  assert.equal(
    Number(
      sql("SELECT count(*) FROM bot_pending_requests WHERE request_id='" + item.request_id + "';"),
    ),
    1,
  );
  assert.equal(
    Number(
      sql(
        "SELECT count(*) FROM staff_audit_log WHERE action='catalog_cancel' AND details->>'pending_id'='" +
          item.pending_id +
          "';",
      ),
    ),
    1,
  );
}
await handleUpdate(makeCommand("/menu"));
assert.equal(unchanged(), before);
assert.deepEqual(ordinary(), previous);
assert.equal(await editor("current"), null);
const report = {
  environment: "dev",
  sourceSha: sha,
  incomingCommands: "simulated",
  realHttpsDatabase: true,
  realTelegram: true,
  responseLostAfterActualCommit: true,
  devAppRestarted: true,
  directPreviewRecovered: true,
  reversePreviewRecovered: true,
  onePreviewPerRequest: true,
  oneReversePreparationAudit: true,
  canceledPreviewsNotRecreated: true,
  historyDiscovery: true,
  productsOrdersNotificationsTechnicalUnchanged: true,
  ordinaryInputUnchanged: true,
  direct,
  reverse,
  sourcePendingId: source,
  sourceUnchanged: true,
  messages,
};
const directory = new URL(
  "../.state/dev/artifacts/preview-requests-" + Date.now() + "/",
  import.meta.url,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(new URL("result.json", directory), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    verified: true,
    report: directory.pathname + "result.json",
    sourceSha: sha,
    pendingIds: [direct.pending_id, reverse.pending_id],
    messages: messages.map((m) => m.messageId),
  }),
);
