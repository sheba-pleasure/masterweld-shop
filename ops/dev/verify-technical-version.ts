/** DEV-only rejection checks. Does not apply a technical revision or send messages. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { StaffMember } from "../../src/lib/bot/permissions";
import { technicalDocument } from "../../src/lib/technical/schema";
const envPath = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(envPath).mode & 0o077, 0);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const index = line.indexOf("=");
  if (index > 0) process.env[line.slice(0, index)] = line.slice(index + 1);
}
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
assert.equal(process.env["PUBLIC_ORIGIN"], origin);
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["TELEGRAM_BOT_ID"], "8996533708");
process.env["SUPABASE_URL"] = origin + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
const identity = await db.rpc("mw_environment_identity" as never);
assert.deepEqual(identity.data, {
  environment: "dev",
  instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49",
});
const actor = 7540652678;
const staff = await db.from("staff").select("*").eq("telegram_id", actor).single();
assert.equal(staff.error, null);
const member = staff.data as StaffMember;
assert.equal(member.active, true);
assert.equal(member.role, "admin");
const productId = "20000000-0000-4000-8000-000000000001";
const product = await db.from("products").select("id,sku,title").eq("id", productId).single();
assert.equal(product.data?.sku, "DEV-001");
assert.equal(product.data?.title, "ТЕСТ — сварочный аппарат");
const { technicalOperation } = await import("../../src/lib/technical/staff.server");
const chat = { id: actor, type: "private" };
const from = { id: actor };
type ReadResult = {
  card: {
    version: number;
    published_revision: string;
    published: { id: string; document: unknown };
  };
};
const read = () =>
  technicalOperation(member, chat, from, { op: "read", productId }) as Promise<ReadResult>;
const current = await read();
assert.ok(Number.isSafeInteger(current.card.version) && current.card.version > 0);
assert.equal(current.card.published.id, current.card.published_revision);
const document = technicalDocument.parse(current.card.published.document);
assert.ok(document.sources.every((source) => source.kind === "synthetic"));
function fingerprint() {
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
    {
      input: `SELECT jsonb_build_object(
      'products',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM products r),
      'cards',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY product_id)::text) FROM technical_cards r),
      'revisions',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM technical_revisions r),
      'changes',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM technical_changes r));`,
      encoding: "utf8",
    },
  ).trim();
}
const before = fingerprint();
await assert.rejects(
  technicalOperation(member, chat, from, {
    op: "preview",
    productId,
    document,
    reviewState: "pending_review",
    expectedVersion: current.card.version - 1,
  }),
  { message: "TECH_CONFLICT" },
);
const rpc = db.rpc.bind(db) as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;
const missing = await rpc("bot_technical_catalog", {
  p_staff_telegram_id: actor,
  p_op: "preview",
  p_product_id: productId,
  p_document: document,
  p_review_state: "pending_review",
});
assert.equal(missing.error?.message, "TECH_VERSION_REQUIRED");
assert.equal(fingerprint(), before);
assert.deepEqual((await read()).card, current.card);
const report = {
  environment: "dev",
  productId,
  baseVersion: current.card.version,
  httpsStaffRead: true,
  publishedDocumentAvailable: true,
  stalePreviewRejected: true,
  missingVersionRejected: true,
  productAndTechnicalRowsUnchanged: true,
  messagesSent: 0,
};
const directory = new URL("../.state/dev/artifacts/technical-version-20261106/", import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(new URL("result.json", directory), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(report));
