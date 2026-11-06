/** Explicit one-time DEV fixture. Never changes product fields or connects to production. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { StaffMember } from "../../src/lib/bot/permissions";
import { publicTechnicalCard, type TechnicalDocument } from "../../src/lib/technical/schema";
const envPath = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(envPath).mode & 0o077, 0);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const origin = process.env["PUBLIC_ORIGIN"]!;
assert.equal(origin, "https://masterweld-dev.138-124-106-211.sslip.io");
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
const memberResult = await db.from("staff").select("*").eq("telegram_id", actor).single();
assert.equal(memberResult.error, null);
const member = memberResult.data as StaffMember;
assert.equal(member.active, true);
assert.equal(member.role, "admin");
const productId = "20000000-0000-4000-8000-000000000001";
const before = await db.from("products").select("*").eq("id", productId).single();
assert.equal(before.error, null);
assert.equal(before.data?.sku, "DEV-001");
assert.equal(before.data?.title, "ТЕСТ — сварочный аппарат");
assert.equal(before.data?.status, "published");
const { technicalOperation } = await import("../../src/lib/technical/staff.server");
const chat = { id: actor, type: "private" };
const from = { id: actor };
const current = (await technicalOperation(member, chat, from, { op: "read", productId })) as {
  card: { version: number; revisions: unknown[] };
};
assert.equal(current.card.version, 0, "Existing technical work must never be replaced by a seed");
assert.equal(current.card.revisions.length, 0);
const fact = (
  attribute_code: string,
  process: "mig" | "mma" | "tig",
  value: number | null,
  unit_code: string,
  context: Record<string, number> = {},
) => ({
  attribute_code,
  process,
  state: value === null ? ("unknown" as const) : ("known" as const),
  value,
  unit_code,
  context,
  source_key: value === null ? null : "training",
});
const document: TechnicalDocument = {
  family_code: "power_multiprocess",
  sources: [
    {
      key: "training",
      kind: "synthetic",
      publisher: "Учебный изготовитель DEV",
      model: "Вымышленный DEV-001",
      title: "[Учебный] Вымышленные характеристики для проверки",
      url: "https://example.invalid/dev-training",
      locator: "Учебный сценарий, не паспорт изделия",
      checked_on: new Date().toISOString().slice(0, 10),
      sha256: "",
    },
  ],
  values: [
    fact("mig_current_max_a", "mig", 200, "a"),
    fact("mma_current_max_a", "mma", 160, "a"),
    fact("mig_duty_cycle_pct", "mig", 60, "pct", { current_a: 200, temperature_c: 40 }),
    fact("tig_current_max_a", "tig", null, "a"),
    fact("power_consumption_kva", "mig", 6.5, "kva"),
    fact("power_consumption_kva", "mma", 5.2, "kva"),
  ],
};
const preview = (await technicalOperation(member, chat, from, {
  op: "preview",
  productId,
  document,
  reviewState: "verified",
})) as { change_id: string };
await technicalOperation(member, chat, from, { op: "apply", changeId: preview.change_id });
const duplicate = (await technicalOperation(member, chat, from, {
  op: "apply",
  changeId: preview.change_id,
})) as { duplicate?: boolean };
assert.equal(duplicate.duplicate, true);
const publicKey = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
assert.ok(publicKey);
const headers = {
  "Content-Type": "application/json",
  apikey: publicKey,
  Authorization: "Bearer " + publicKey,
};
const response = await fetch(origin + "/backend/rest/v1/rpc/public_product_technical", {
  method: "POST",
  headers,
  body: JSON.stringify({ p_product_id: productId }),
});
assert.equal(response.status, 200);
const card = publicTechnicalCard.parse(await response.json());
assert.equal(card.product_id, productId);
assert.equal(card.values.find((v) => v.code === "mig_current_max_a")?.value, 200);
assert.equal(card.values.find((v) => v.code === "mma_current_max_a")?.value, 160);
assert.equal(card.values.find((v) => v.code === "tig_current_max_a")?.state, "unknown");
assert.equal(card.sources[0].kind, "synthetic");
assert.equal(card.values.length, 6);
const denied = await fetch(origin + "/backend/rest/v1/rpc/bot_technical_catalog", {
  method: "POST",
  headers,
  body: JSON.stringify({ p_staff_telegram_id: actor, p_op: "read", p_product_id: productId }),
});
assert.ok([401, 403].includes(denied.status));
const after = await db.from("products").select("*").eq("id", productId).single();
assert.deepEqual(after, before);
const report = {
  environment: "dev",
  productId,
  sku: "DEV-001",
  changeId: preview.change_id,
  revisionId: card.revision_id,
  values: card.values.length,
  synthetic: true,
  publicHttpsRead: true,
  publicWriteDenied: true,
  duplicateSuppressed: true,
  productFieldsUnchanged: true,
  userEditingUi: false,
};
const directory = new URL("../.state/dev/artifacts/technical-pilot-20261106/", import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(new URL("result.json", directory), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(report));
