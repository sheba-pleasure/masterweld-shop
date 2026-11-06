import { beforeEach, expect, it, vi } from "vitest";
import {
  parseReviewCallback,
  renderReview,
  reviewButton,
  type DocumentReview,
} from "./review-view";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn(), catalog: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
vi.mock("./catalog.server", () => ({ showCatalogImport: mocks.catalog }));
import {
  openDocumentReview,
  showDocumentReview,
  handleDocumentReviewText,
  documentReviewControl,
} from "./review.server";
const id = "11111111-1111-4111-8111-111111111111";
const admin: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" };
const review: DocumentReview = {
  ok: true,
  id,
  document_id: id,
  revision: 3,
  file_name: "Прайс.xlsx",
  table_label: "Лист 1",
  header: ["Артикул", "Название", "Закупка"],
  row: 0,
  cells: ["001", "Аппарат", "10"],
  original: ["00I", "Аппарат", "10"],
  locator: "sheet:1/row:2",
  decision: "pending",
  counts: { pending: 1, approved: 0, excluded: 0, total: 1 },
  warnings: [],
  coverage: { complete: true },
};
const prompt = { review_id: id, revision: 3, row_index: 0, column_index: 2, message_id: 500 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: review, error: null });
  mocks.tg.mockResolvedValue({ json: async () => ({ ok: true, result: { message_id: 501 } }) });
});
it("guards owner identity, private chat and import rights before access", async () => {
  for (const m of [
    { ...admin, role: "seller" as const },
    { ...admin, active: false },
  ]) {
    await openDocumentReview(m, chat, id, 0);
    await showDocumentReview(m, chat, reviewButton(review, "", "approve").callback_data);
    expect(await handleDocumentReviewText(m, chat, "15", 500)).toBe(false);
  }
  await openDocumentReview(admin, { id: 102, type: "private" }, id, 0);
  await openDocumentReview(admin, { id: 101, type: "group" }, id, 0);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("keeps initial table selection in review, never in import or publication", async () => {
  await openDocumentReview(admin, chat, id, 0);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_document_review", {
    p_actor: 101,
    p_op: "open",
    p_id: id,
    p_row: 0,
  });
  expect(mocks.catalog).not.toHaveBeenCalled();
  expect(mocks.tg.mock.calls[0]![1].text).toContain("Ещё не проверена");
});
it("rejects injected callbacks and keeps bounded Telegram callback sizes", () => {
  for (const op of ["get", "approve", "exclude", "handoff", "summary", "cancel"]) {
    const value = reviewButton({ ...review, revision: 9999999, row: 4999 }, "", op).callback_data;
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(parseReviewCallback(value)?.op).toBe(op);
  }
  for (const value of [
    `dr:${id}:3:edit:0`,
    `dr:${id}:3:approve:0:1`,
    `dr:${id}:3:get:5000`,
    `dr:${id}:3:edit:0:30`,
    "dr:../../secret:1:get:0",
  ])
    expect(parseReviewCallback(value)).toBeNull();
});
it("shows no transfer button while any row is unresolved or all rows were skipped", () => {
  for (const counts of [review.counts, { pending: 0, approved: 0, excluded: 1, total: 1 }]) {
    const v = renderReview({ ...review, counts }, "summary");
    expect(v.rows.flat().some((b) => b.callback_data.includes(":handoff:"))).toBe(false);
  }
  const v = renderReview(
    {
      ...review,
      counts: { pending: 0, approved: 1, excluded: 0, total: 1 },
      warnings: ["OCR"],
      coverage: { complete: false },
    },
    "summary",
  );
  expect(v.text).toContain("Сверьте весь документ");
  expect(v.rows.flat().some((b) => b.callback_data.includes(":handoff:"))).toBe(true);
});
it("binds edits to the returned Telegram question and exact review revision", async () => {
  await showDocumentReview(admin, chat, reviewButton(review, "", "edit", 0, 2).callback_data);
  expect(mocks.rpc.mock.calls[1]).toEqual([
    "bot_document_review",
    {
      p_actor: 101,
      p_op: "bind",
      p_id: id,
      p_revision: 3,
      p_row: 0,
      p_column: 2,
      p_payload: { message_id: 501 },
    },
  ]);
  expect(mocks.tg.mock.calls.some((c) => c[1].reply_markup?.force_reply)).toBe(true);
});
it("saves only a bound reply; ordinary text and other questions cannot change a cell", async () => {
  mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
  expect(await handleDocumentReviewText(admin, chat, "15", 499)).toBe(false);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
  expect(await handleDocumentReviewText(admin, chat, "15")).toBe(true);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
  await handleDocumentReviewText(admin, chat, "15", 500);
  expect(mocks.rpc.mock.calls.at(-1)).toEqual([
    "bot_document_review",
    {
      p_actor: 101,
      p_op: "save",
      p_id: id,
      p_revision: 3,
      p_row: 0,
      p_column: 2,
      p_payload: { value: "15", reply_to: 500 },
    },
  ]);
});
it("recovers unknown delivery/read/save without automatic mutation replay or secret leakage", async () => {
  mocks.rpc.mockRejectedValue(new Error("private database details"));
  expect(await handleDocumentReviewText(admin, chat, "15", 500)).toBe(true);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("private database details");
  expect(mocks.tg.mock.calls[0]![1].text).toContain("неизвестен");
  mocks.rpc.mockResolvedValue({ data: review, error: null });
  mocks.tg.mockRejectedValueOnce(new Error("lost Telegram answer"));
  await showDocumentReview(admin, chat, reviewButton(review, "", "edit", 0, 2).callback_data);
  expect(mocks.rpc.mock.calls.filter((c) => c[1].p_op === "bind")).toHaveLength(0);
});
it("opens the one linked import only after an explicit transfer action", async () => {
  mocks.rpc.mockResolvedValue({ data: { ok: true, import_id: id }, error: null });
  await showDocumentReview(admin, chat, reviewButton(review, "", "handoff").callback_data);
  expect(mocks.catalog).toHaveBeenCalledExactlyOnceWith(admin, chat, { op: "get", id });
  expect(mocks.rpc.mock.calls.some((c) => c[1].p_op === "apply")).toBe(false);
});
it("global cancellation closes only the active document prompt, preserving prior decisions", async () => {
  mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
  expect(await documentReviewControl(admin, chat, "cancel")).toBe(true);
  expect(mocks.rpc.mock.calls[1]![1]).toEqual({
    p_actor: 101,
    p_op: "cancel",
    p_id: id,
    p_revision: 3,
    p_row: 0,
  });
});
it("splits long originals without losing text and paginates all thirty editable columns", async () => {
  const r = { ...review, original: ["X".repeat(2000), "Y".repeat(2000), "Z".repeat(2000)] };
  mocks.rpc.mockResolvedValue({ data: r, error: null });
  await showDocumentReview(admin, chat, reviewButton(r, "", "raw").callback_data);
  const texts = mocks.tg.mock.calls.map((c) => c[1].text as string);
  expect(texts.every((t) => Array.from(t).length <= 3500)).toBe(true);
  expect(texts.join("")).toContain(r.original.join("\n").split("\n")[0]);
  const wide = { ...review, header: Array.from({ length: 30 }, (_, i) => "Поле " + i) };
  expect(
    renderReview(wide, "cols", 3)
      .rows.flat()
      .filter((b) => b.callback_data.includes(":edit:")),
  ).toHaveLength(6);
});
