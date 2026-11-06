import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), adminRpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.adminRpc },
}));
import { readProductTechnical } from "./catalog";
import { technicalDocument } from "./schema";
import { technicalOperation } from "./staff.server";
import type { StaffMember } from "@/lib/bot/permissions";
const id = "10000000-0000-4000-8000-000000000001";
const member: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" };
const source = {
  key: "manual",
  kind: "synthetic" as const,
  publisher: "Учебный",
  model: "QA",
  title: "[Учебный] Не паспорт",
  url: "https://example.invalid/manual",
  locator: "Раздел 1",
  checked_on: "2026-11-06",
  sha256: "",
};
const doc = {
  family_code: "power_tig_dc",
  sources: [source],
  values: [
    {
      attribute_code: "tig_pulse",
      process: "tig" as const,
      state: "known" as const,
      value: false,
      unit_code: "none",
      context: {},
      source_key: "manual",
    },
  ],
};
const card = {
  product_id: id,
  revision_id: id,
  family: { code: "power_tig_dc", label: "TIG DC" },
  verified_on: "2026-11-06",
  sources: [source],
  values: [
    {
      code: "tig_pulse",
      label: "Импульс",
      kind: "boolean",
      process: "tig",
      state: "known",
      value: false,
      unit: { code: "none", label: "—" },
      context: {},
      source_key: "manual",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: card, error: null });
  mocks.adminRpc.mockResolvedValue({ data: { ok: true }, error: null });
});
it("retains false, zero and unknown without coercion", () => {
  expect(technicalDocument.parse(doc).values[0]?.value).toBe(false);
  expect(
    technicalDocument.parse({ ...doc, values: [{ ...doc.values[0], value: 0 }] }).values[0]?.value,
  ).toBe(0);
  expect(
    technicalDocument.parse({
      ...doc,
      values: [{ ...doc.values[0], state: "unknown", value: null, source_key: null }],
    }).values[0]?.value,
  ).toBeNull();
  expect(
    technicalDocument.safeParse({ ...doc, values: [{ ...doc.values[0], state: "unknown" }] })
      .success,
  ).toBe(false);
});
it("rejects unexpected fields and credential-bearing source URLs before staff RPC", () => {
  expect(technicalDocument.safeParse({ ...doc, price: 1 }).success).toBe(false);
  expect(
    technicalDocument.safeParse({
      ...doc,
      sources: [{ ...source, url: "https://example.invalid/doc?token=private" }],
    }).success,
  ).toBe(false);
});
it("public read uses only the public RPC and preserves the verified false value", async () => {
  expect((await readProductTechnical(id))?.values[0]?.value).toBe(false);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("public_product_technical", {
    p_product_id: id,
  });
  expect(mocks.adminRpc).not.toHaveBeenCalled();
});
it("missing/unpublished technical card is an explicit null", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  expect(await readProductTechnical(id)).toBeNull();
});
it("invalid product ID never calls the backend", async () => {
  await expect(readProductTechnical("sku-or-sql")).rejects.toThrow("TECH_INVALID_PRODUCT");
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it.each([
  { ...card, staff_telegram_id: 101 },
  { ...card, product_id: "20000000-0000-4000-8000-000000000002" },
  { ...card, sources: [{ ...source, internal_note: "PRIVATE" }] },
])("rejects private/unexpected response fields or wrong product", async (data) => {
  mocks.rpc.mockResolvedValue({ data, error: null });
  await expect(readProductTechnical(id)).rejects.toThrow("TECH_INVALID_RESPONSE");
});
it("read failure never becomes a false empty card or exposes provider diagnostics", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE" } });
  await expect(readProductTechnical(id)).rejects.toThrow("TECH_READ_UNAVAILABLE");
});
it.each([
  [member, { id: -1, type: "group" }, { id: 101 }],
  [member, chat, { id: 102 }],
  [{ ...member, active: false }, chat, { id: 101 }],
  [{ ...member, role: "director" as const }, chat, { id: 101 }],
])("staff guard precedes service access", async (actor, room, from) => {
  await expect(
    technicalOperation(actor, room, from, { op: "read", productId: id }),
  ).rejects.toThrow("TECH_DENIED");
  expect(mocks.adminRpc).not.toHaveBeenCalled();
});
it("seller can submit a pending proposal but cannot verify it", async () => {
  const seller: StaffMember = { ...member, role: "seller" };
  await technicalOperation(
    seller,
    chat,
    { id: 101 },
    { op: "preview", productId: id, document: doc, reviewState: "pending_review" },
  );
  expect(mocks.adminRpc).toHaveBeenCalledTimes(1);
  await expect(
    technicalOperation(
      seller,
      chat,
      { id: 101 },
      { op: "preview", productId: id, document: doc, reviewState: "verified" },
    ),
  ).rejects.toThrow("TECH_REVIEW_DENIED");
  expect(mocks.adminRpc).toHaveBeenCalledTimes(1);
});
it("RPC error is not retried and its private text is not disclosed", async () => {
  mocks.adminRpc.mockResolvedValue({ data: null, error: { message: "PRIVATE SQL" } });
  await expect(
    technicalOperation(member, chat, { id: 101 }, { op: "apply", changeId: id }),
  ).rejects.toThrow("TECH_OPERATION_UNCONFIRMED");
  expect(mocks.adminRpc).toHaveBeenCalledTimes(1);
});
