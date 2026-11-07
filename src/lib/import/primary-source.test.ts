import { beforeEach, expect, it, vi } from "vitest";
import {
  compactId,
  expandId,
  parseSourceCallback,
  renderSourceReview,
  sourceButton,
  sourceReviewResponse,
  type SourceReviewResponse,
} from "./primary-source-view";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
import { showProductSources } from "./primary-source.server";
const id = "10000000-0000-4000-8000-000000000001";
const product = "20000000-0000-4000-8000-000000000002";
const document = "30000000-0000-4000-8000-000000000003";
const other = "40000000-0000-4000-8000-000000000004";
const checksum = "a".repeat(64);
const member: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" };
function data(): SourceReviewResponse {
  const model = {
    state: "selected" as const,
    revision: 2,
    sources_version: 3,
    usable: true,
    choice_id: other,
    identity: {
      manufacturer: "Учебный изготовитель",
      model: "Учебная-220",
      variant_mode: "none" as const,
      variant: "",
    },
  };
  return {
    ok: true,
    product_id: product,
    title: "Учебный товар",
    current_model: model,
    active_review: id,
    sources: null,
    page: 0,
    pages: 1,
    review: {
      id,
      product_id: product,
      revision: 3,
      phase: "preview",
      model_context: model,
      model_matches: true,
      source_kind: "manual",
      source_id: null,
      usable: false,
      can_confirm: true,
      document: { id: document, file_name: "Паспорт.pdf", checksum },
      documents: null,
      page: 0,
      pages: 1,
    },
  };
}
function file() {
  return {
    ok: true,
    id: document,
    state: "review",
    checksum,
    file_name: "Паспорт.pdf",
    extraction: {
      tables: [],
      blocks: [
        { locator: "page:2", page: 2, text: "Учебная-220 <b>Текст</b> httpds://example.invalid" },
      ],
      warnings: [],
      coverage: { complete: true },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: data(), error: null });
  mocks.tg.mockResolvedValue({});
});
it("roundtrips canonical UUIDs and rejects noncanonical padding aliases", () => {
  for (const uuid of [id, document, "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
    expect(expandId(compactId(uuid))).toBe(uuid);
  }
  expect(expandId(compactId(id).slice(0, -1) + "R")).toBeNull();
  expect(expandId("../../secret")).toBeNull();
  expect(() => compactId("invalid")).toThrow();
});
it("keeps file identity across list changes, with callback payloads within Telegram limits", () => {
  const v = data(),
    r = v.review!;
  r.revision = 2147483647;
  r.phase = "draft";
  r.documents = [
    { id: document, file_name: "Первый.pdf" },
    { id: other, file_name: "Второй.pdf" },
  ];
  const buttons = renderSourceReview(v).rows.flat();
  const choose = buttons.find((b) => b.text.includes("Первый"))!;
  r.documents.reverse();
  expect(parseSourceCallback(choose.callback_data)).toEqual({
    op: "choose",
    id,
    revision: r.revision,
    payload: { document_id: document },
  });
  for (const b of [
    ...buttons,
    { text: "Read", callback_data: sourceButton(r, "read", 999999, 999999) },
  ])
    expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
});
it.each([
  "pds:new:" + product + ":0",
  "pds:r:" + compactId(id) + ":2147483648:confirm",
  "pds:r:" + compactId(id) + ":3:confirm:0",
  "pds:r:" + compactId(id) + ":3:kind:4",
  "pds:r:" + compactId(id) + ":3:read:0",
  "pds:r:" + compactId(id) + ":3:blocks:0:0",
  "pds:d:" + compactId(id) + ":-1:" + compactId(document),
  "pds:home:../../private",
])("rejects malformed or ambiguous action %s", (value) =>
  expect(parseSourceCallback(value)).toBeNull(),
);
it("requires a separate human confirmation and keeps supplier material distinct", () => {
  const v = data();
  v.review!.source_kind = "supplier";
  const view = renderSourceReview(v);
  expect(view.text).toContain("не становится паспортом");
  expect(view.text).toContain("Товары, цены и характеристики не изменятся");
  expect(view.rows.flat().some((b) => parseSourceCallback(b.callback_data)?.op === "confirm")).toBe(
    true,
  );
  v.review!.can_confirm = false;
  expect(
    renderSourceReview(v)
      .rows.flat()
      .some((b) => parseSourceCallback(b.callback_data)?.op === "confirm"),
  ).toBe(false);
  v.review!.phase = "confirmed";
  expect(
    renderSourceReview(v)
      .rows.flat()
      .some((b) => parseSourceCallback(b.callback_data)?.op === "withdraw_prepare"),
  ).toBe(true);
  expect(
    renderSourceReview(v)
      .rows.flat()
      .some((b) => parseSourceCallback(b.callback_data)?.op === "withdraw"),
  ).toBe(false);
});
it("offers extraction only for a current confirmed document and keeps review recovery after withdrawal", () => {
  const v = data();
  const buttons = () =>
    renderSourceReview(v)
      .rows.flat()
      .map((b) => b.callback_data);
  expect(buttons().some((b) => b.startsWith("sf:f:"))).toBe(false);
  v.review!.phase = "confirmed";
  v.review!.usable = true;
  v.review!.source_id = other;
  expect(buttons()).toContain("sf:f:" + compactId(id) + ":" + v.review!.revision + ":0");
  v.review!.usable = false;
  expect(buttons().some((b) => b.startsWith("sf:f:"))).toBe(false);
  v.review!.phase = "withdrawn";
  expect(buttons()).toContain("sf:current");
});
it("does not offer document selection for stale model drafts", () => {
  const v = data();
  v.review!.phase = "draft";
  v.review!.model_matches = false;
  expect(
    renderSourceReview(v)
      .rows.flat()
      .some((b) => parseSourceCallback(b.callback_data)?.op === "documents"),
  ).toBe(false);
});
it("rejects malformed server response", () => {
  const v = data();
  v.current_model.usable = false;
  expect(sourceReviewResponse.safeParse(v).success).toBe(false);
});
it("gates roles, active membership and actual private chat before RPC", async () => {
  for (const [m, c] of [
    [{ ...member, role: "seller" as const }, chat],
    [{ ...member, role: "director" as const }, chat],
    [{ ...member, active: false }, chat],
    [member, { id: 102, type: "private" }],
    [member, { id: 101, type: "group" }],
  ] as const)
    await showProductSources(m, c, "pds:home:" + product);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.tg).not.toHaveBeenCalled();
});
it("starts once with the dispatcher's stable request ID", async () => {
  await showProductSources(member, chat, "pds:new:" + product, id);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_product_sources", {
    p_actor: 101,
    p_op: "start",
    p_product: product,
    p_id: id,
    p_revision: null,
    p_payload: { page: 0 },
  });
});
it("does not create a review without a stable request", async () => {
  await showProductSources(member, chat, "pds:new:" + product);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("Откройте документы модели");
});
it("reads exactly the bound document and rewrites navigation with the review revision", async () => {
  mocks.rpc
    .mockResolvedValueOnce({ data: data(), error: null })
    .mockResolvedValueOnce({ data: file(), error: null });
  await showProductSources(member, chat, sourceButton(data().review!, "read", 0, 0));
  expect(mocks.rpc).toHaveBeenNthCalledWith(2, "bot_document_intake", {
    p_actor: 101,
    p_op: "get",
    p_id: document,
    p_payload: {},
  });
  const body = mocks.tg.mock.calls[0]![1];
  expect(body.text).toContain("Учебная-220 <b>Текст</b>");
  expect(body.parse_mode).toBeUndefined();
  expect(body.link_preview_options).toEqual({ is_disabled: true });
  for (const b of body.reply_markup.inline_keyboard.flat()) {
    if (b.callback_data.startsWith("di:")) expect(b.callback_data).toBe("di:original:" + document);
    else expect(parseSourceCallback(b.callback_data)?.id).toBe(id);
  }
});
it("old read buttons never substitute a newly chosen document", async () => {
  const v = data();
  v.review!.revision++;
  v.review!.document!.id = other;
  mocks.rpc.mockResolvedValue({ data: v, error: null });
  await showProductSources(member, chat, sourceButton(data().review!, "read", 0, 0));
  expect(mocks.rpc).toHaveBeenCalledOnce();
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("прежнему шагу");
});
it.each([
  { ...file(), id: other },
  { ...file(), checksum: "b".repeat(64) },
])("rejects a substituted file or checksum", async (f) => {
  mocks.rpc
    .mockResolvedValueOnce({ data: data(), error: null })
    .mockResolvedValueOnce({ data: f, error: null });
  await showProductSources(member, chat, sourceButton(data().review!, "read", 0, 0));
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("<b>Текст</b>");
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("документ недоступен");
});
it("unknown persistence result offers only read recovery and does not leak internal error", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE ORIGINAL DETAILS" } });
  await showProductSources(member, chat, sourceButton(data().review!, "confirm"));
  expect(mocks.rpc).toHaveBeenCalledOnce();
  const sent = JSON.stringify(mocks.tg.mock.calls);
  expect(sent).not.toContain("PRIVATE");
  expect(sent).toContain("не означает");
  const body = mocks.tg.mock.calls[0]![1];
  expect(parseSourceCallback(body.reply_markup.inline_keyboard[0][0].callback_data)?.op).toBe(
    "get",
  );
});
it("does not substitute another review result", async () => {
  const v = data();
  v.review!.id = other;
  mocks.rpc.mockResolvedValue({ data: v, error: null });
  await showProductSources(member, chat, "pds:g:" + compactId(id));
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("Учебная-220");
});
it("never retries an uncertain Telegram send or replays the mutation", async () => {
  mocks.tg.mockRejectedValue(new Error("timeout"));
  await expect(
    showProductSources(member, chat, sourceButton(data().review!, "confirm")),
  ).rejects.toThrow("timeout");
  expect(mocks.rpc).toHaveBeenCalledOnce();
  expect(mocks.tg).toHaveBeenCalledOnce();
});
