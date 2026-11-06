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
    'products',(SELECT md5(jsonb_agg(CASE WHEN id='20000000-0000-4000-8000-000000000001' THEN to_jsonb(r)-'updated_at' ELSE to_jsonb(r) END ORDER BY id)::text) FROM products r),
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
let committed: { pending_id: string; state: string } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/answerCallbackQuery"))
    return Response.json({ ok: true, result: true });
  if (url.includes("/rpc/bot_pending_operation") && loseNextResult) {
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
const command = (text: string) => {
  const prompt = text.startsWith("/") ? null : ordinary()?.data?._prompt_message_id;
  return handleUpdate({
    update_id: 1,
    message: { text, from, chat, ...(prompt ? { reply_to_message: { message_id: prompt } } : {}) },
  });
};
const callback = (data: string) =>
  handleUpdate({
    update_id: 2,
    callback_query: { id: "dev-simulated", data, from, message: { chat, message_id: 1 } },
  });

await callback("et:title:" + productId);
await command("ТЕСТ — проверка подтверждения после обрыва");
const pendingButton = messages.at(-1)!.buttons.find((b) => b.startsWith("pc:"))!;
assert.ok(pendingButton);
const pendingId = pendingButton.slice(3);
assert.match(pendingId, /^[0-9a-f-]{36}$/);
loseNextResult = true;
await callback(pendingButton);
assert.ok(committed);
const saved = committed as { pending_id: string; state: string };
assert.equal(saved.pending_id, pendingId);
assert.equal(saved.state, "applied");
assert.ok(messages.at(-1)?.text.includes("Изменение могло сохраниться"));
assert.equal(messages.at(-1)?.buttons[0], "pcr:" + pendingId);
assert.equal(
  sql("SELECT title FROM products WHERE id='" + productId + "';"),
  "ТЕСТ — проверка подтверждения после обрыва",
);
await command("/new");
const later = ordinary();
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
    /* bounded readiness polling */
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.ok(ready);
for (const button of ["pcr:", "pc:", "pcx:"]) {
  await callback(button + pendingId);
  assert.ok(messages.at(-1)?.text.includes("Изменение уже сохранено"));
  assert.deepEqual(ordinary(), later);
}
assert.equal(
  Number(
    sql("SELECT count(*) FROM staff_audit_log WHERE details->>'pending_id'='" + pendingId + "';"),
  ),
  1,
);
await callback("rb:" + pendingId);
const undoButton = messages.at(-1)!.buttons.find((b) => b.startsWith("pc:"))!;
assert.ok(undoButton);
const undoId = undoButton.slice(3);
await callback(undoButton);
assert.ok(messages.at(-1)?.text.includes("Изменение сохранено"));
await callback(undoButton);
assert.ok(messages.at(-1)?.text.includes("Изменение уже сохранено"));
assert.equal(
  Number(
    sql(
      "SELECT count(*) FROM staff_audit_log WHERE action='catalog_title' AND details->>'pending_id'='" +
        undoId +
        "';",
    ),
  ),
  1,
);
assert.deepEqual(ordinary(), later);
await command("/cancel");
assert.ok(ordinary().consumed_at);
assert.equal(unchanged(), before);
assert.equal(
  sql("SELECT title FROM products WHERE id='" + productId + "';"),
  "ТЕСТ — сварочный аппарат",
);
const report = {
  environment: "dev",
  sourceSha: sha,
  incomingCommands: "simulated",
  realHttpsDatabase: true,
  realTelegram: true,
  responseLostAfterActualCommit: true,
  devAppRestarted: true,
  readApplyCancelRecoveredSameOutcome: true,
  oneApplyAudit: true,
  laterInputPreserved: true,
  productsRestoredExceptTestProductUpdatedAt: true,
  ordersNotificationsTechnicalUnchanged: true,
  noActiveInputRemains: true,
  pendingId,
  rollbackPendingId: undoId,
  rollbackAppliedOnce: true,
  messages,
};
const directory = new URL(
  "../.state/dev/artifacts/pending-recovery-" + Date.now() + "/",
  import.meta.url,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(new URL("result.json", directory), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    verified: true,
    report: directory.pathname + "result.json",
    sourceSha: sha,
    pendingId,
    rollbackPendingId: undoId,
    messages: messages.map((m) => m.messageId),
  }),
);
