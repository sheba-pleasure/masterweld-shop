import { beforeEach, expect, it, vi } from "vitest";
import { parseStructureCallback, renderStructure, structureButton } from "./structure-view";
import { renderReview, type DocumentReview } from "./review-view";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
vi.mock("./catalog.server", () => ({ showCatalogImport: vi.fn() }));
import {
  showDocumentStructure,
  handleDocumentReviewText,
  documentReviewControl,
} from "./review.server";
const id = "11111111-1111-4111-8111-111111111111";
const m: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" };
const r: DocumentReview = {
  ok: true,
  id,
  document_id: id,
  revision: 3,
  file_name: "Прайс.xlsx",
  table_label: "Лист 1",
  header: ["sku", "title", "price"],
  row: 6,
  position: 1,
  prev_row: null,
  next_row: 7,
  cells: ["A", "Аппарат", "10"],
  original: ["A\nB", "Аппарат\nМаска", "10"],
  decision: "pending",
  counts: { total: 3, pending: 3, approved: 0, excluded: 0 },
  warnings: [],
};
const draft: DocumentReview = {
  ...r,
  structure_draft: {
    kind: "split",
    target: 6,
    stage: "editing",
    focus: 0,
    guided: true,
    rows: [
      ["A", "Аппарат", ""],
      ["B", "Маска", ""],
    ],
  },
};
const prompt = {
  kind: "structure",
  review_id: id,
  revision: 3,
  row_index: 6,
  column_index: 0,
  message_id: 501,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: r, error: null });
  mocks.tg.mockResolvedValue({ json: async () => ({ ok: true, result: { message_id: 502 } }) });
});
it("bounds callback bytes and rejects missing/extra or invalid parameters", () => {
  for (const [op, arg] of [
    ["tools", undefined],
    ["heads", 3],
    ["head", 29],
    ["split", 4],
    ["fields", 119],
    ["walk", 119],
    ["askundo", undefined],
    ["preview", undefined],
  ] as const) {
    const value = structureButton(
      { ...r, revision: 9999999, row: 4999 },
      "",
      op,
      arg,
    ).callback_data;
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(parseStructureCallback(value)?.op).toBe(op);
  }
  for (const value of [
    `ds:${id}:3:add:0:1`,
    `ds:${id}:3:split:0:1`,
    `ds:${id}:3:head:0:30`,
    `ds:${id}:3:edit:0`,
    `ds:${id}:3:tools:5000`,
  ])
    expect(parseStructureCallback(value)).toBeNull();
});
it("navigates by stable row IDs and labels the original with original headings", () => {
  const view = renderReview(
    { ...r, original_header: ["Source SKU", "Original name", "Price"] },
    "raw",
  );
  expect(view.text).toContain("Original name");
  const nav = renderReview(r)
    .rows.flat()
    .map((b) => b.callback_data);
  expect(nav).toContain(`dr:${id}:3:get:7`);
  expect(nav).not.toContain(`dr:${id}:3:get:5`);
  expect(renderReview(r).text).toContain("Строка 1 из 3");
});
it("shows source, exact draft values and explicit confirmation; never approve or import buttons", () => {
  const view = renderStructure({
    ...draft,
    structure_draft: {
      ...draft.structure_draft!,
      stage: "preview",
      focus: -2,
      rows: [
        ["A", "Аппарат", "10"],
        ["B", "Маска", "20"],
      ],
    },
  });
  expect(view.text).toContain("Было → станет");
  expect(view.text).toContain("Розничная цена: 20");
  expect(view.text).toContain("Импорт и публикация не запускаются");
  expect(view.rows.flat().map((b) => b.callback_data)).toContain(`ds:${id}:3:apply:6`);
  expect(view.rows.flat().some((b) => /handoff|approve/.test(b.callback_data))).toBe(false);
});
it("provides one-field questions, explicit skip/copy and recovery after a lost question", () => {
  const view = renderStructure(draft);
  expect(view.text).toContain("Товар 1 из 2");
  expect(view.text).toContain("Артикул");
  expect(view.rows.flat().map((b) => b.callback_data)).toEqual(
    expect.arrayContaining([`ds:${id}:3:skip:6:0`, `ds:${id}:3:copy:6:0`, `ds:${id}:3:walk:6:0`]),
  );
});
it("gates structure before service access using sender and current role", async () => {
  await showDocumentStructure(
    { ...m, role: "seller" },
    chat,
    structureButton(r, "", "add").callback_data,
  );
  await showDocumentStructure(
    m,
    { id: 102, type: "private" },
    structureButton(r, "", "add").callback_data,
  );
  await showDocumentStructure(
    m,
    { id: 101, type: "group" },
    structureButton(r, "", "add").callback_data,
  );
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("opening a stored draft is read-only and does not send or bind a new question", async () => {
  mocks.rpc.mockResolvedValue({ data: draft, error: null });
  await showDocumentStructure(m, chat, structureButton(r, "", "tools").callback_data);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.rpc.mock.calls[0]![1].p_op).toBe("get");
  expect(mocks.tg.mock.calls.every((c) => !c[1].reply_markup?.force_reply)).toBe(true);
});
it("starts guided input and binds only a successfully returned message ID", async () => {
  mocks.rpc.mockResolvedValue({ data: draft, error: null });
  await showDocumentStructure(m, chat, structureButton(r, "", "walk", 0).callback_data);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["st_focus", "st_bind"]);
  expect(mocks.rpc.mock.calls[0]![1].p_payload).toEqual({ guided: true });
  expect(mocks.rpc.mock.calls[1]![1].p_payload).toEqual({ message_id: 502 });
});
it("does not bind an uncertain question delivery", async () => {
  mocks.rpc.mockResolvedValue({ data: draft, error: null });
  mocks.tg.mockResolvedValue({ json: async () => ({ ok: false }) });
  await showDocumentStructure(m, chat, structureButton(r, "", "walk", 0).callback_data);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["st_focus"]);
  expect(mocks.tg.mock.calls.at(-1)![1].text).toContain("Ответ не привязан");
});
it("only exact reply saves structure and advances to the next field", async () => {
  mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null }).mockResolvedValue({
    data: { ...draft, structure_draft: { ...draft.structure_draft!, focus: 1 } },
    error: null,
  });
  await handleDocumentReviewText(m, chat, "A", 501);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["input", "st_save", "st_bind"]);
  expect(mocks.rpc.mock.calls[1]![1].p_payload).toEqual({ value: "A", reply_to: 501 });
  expect(mocks.rpc.mock.calls[2]![1].p_column).toBe(1);
});
it("ignores ordinary text and unrelated replies without saving", async () => {
  mocks.rpc.mockResolvedValue({ data: { ok: true, prompt }, error: null });
  expect(await handleDocumentReviewText(m, chat, "wrong", 500)).toBe(false);
  await handleDocumentReviewText(m, chat, "wrong");
  expect(mocks.rpc.mock.calls.every((c) => c[1].p_op === "input")).toBe(true);
});
it("cancel uses the structure operation, resume renews the persisted question", async () => {
  mocks.rpc
    .mockResolvedValueOnce({ data: { ok: true, prompt }, error: null })
    .mockResolvedValue({ data: r, error: null });
  await documentReviewControl(m, chat, "cancel");
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["input", "st_cancel"]);
  mocks.rpc.mockClear();
  mocks.rpc
    .mockResolvedValueOnce({ data: { ok: true, prompt }, error: null })
    .mockResolvedValue({ data: draft, error: null });
  await documentReviewControl(m, chat, "resume");
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual([
    "input",
    "get",
    "st_focus",
    "st_bind",
  ]);
});
