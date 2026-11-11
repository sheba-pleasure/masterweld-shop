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

it("opens original and help as a read-only menu with page recovery and staff gating", async () => {
  const wide = { ...review, header: Array.from({ length: 30 }, (_, i) => "Поле " + i) };
  const before = JSON.stringify(wide);
  const main = renderReview(wide, "page", 3);
  const button = main.rows.flat().find((b) => parseReviewCallback(b.callback_data)?.op === "more")!;
  expect(parseReviewCallback(button.callback_data)?.column).toBe(3);
  expect(main.rows.flat().some((b) => b.callback_data.startsWith("dm:"))).toBe(false);
  mocks.rpc.mockResolvedValue({ data: wide, error: null });
  await showDocumentReview(admin, chat, button.callback_data);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get"]);
  const message = mocks.tg.mock.calls[0]![1];
  expect(message.text).toContain("Оригинал и помощь");
  expect(message.reply_markup.force_reply).toBeUndefined();
  const actions = message.reply_markup.inline_keyboard
    .flat()
    .map((b: { callback_data: string }) => parseReviewCallback(b.callback_data))
    .filter(Boolean);
  expect(actions.find((a: { op: string }) => a.op === "page").column).toBe(3);
  expect(
    actions.some((a: { op: string }) => ["approve", "exclude", "handoff", "edit"].includes(a.op)),
  ).toBe(false);
  expect(mocks.catalog).not.toHaveBeenCalled();
  expect(JSON.stringify(wide)).toBe(before);
  mocks.rpc.mockClear();
  mocks.tg.mockClear();
  for (const [member, target] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { id: 102, type: "private" }],
    [admin, { ...chat, type: "group" }],
  ] as const)
    await showDocumentReview(member, target, button.callback_data);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.tg).not.toHaveBeenCalled();
  for (const bad of [`dr:${id}:3:more:0`, `dr:${id}:3:more:0:4`])
    expect(parseReviewCallback(bad)).toBeNull();
  expect(
    renderReview({ ...wide, import_id: id }, "more", 3)
      .rows.flat()
      .some((b) => b.callback_data.startsWith("dm:")),
  ).toBe(false);
});

it("shows a wide row in bounded pages and keeps the decision separate from reading", async () => {
  const wide: DocumentReview = {
    ...review,
    header: Array.from({ length: 30 }, (_, i) => "Поле " + String(i + 1).padStart(2, "0")),
    cells: Array.from({ length: 30 }, (_, i) => "Значение " + i + " " + "Я".repeat(150)),
    original: Array.from({ length: 30 }, () => "Распознано"),
    row: 4999,
    position: 1,
    revision: 9999999,
  };
  const before = JSON.stringify(wide);
  mocks.rpc.mockResolvedValue({ data: wide, error: null });
  for (let page = 0; page < 4; page++) {
    const view = renderReview(wide, page === 0 ? "get" : "page", page);
    expect(view.text).toContain("Страница " + (page + 1) + " из 4");
    expect(Array.from(view.text).length).toBeLessThan(3500);
    wide.header.forEach((header, index) => {
      expect(view.text.includes(header + ":")).toBe(Math.floor(index / 8) === page);
    });
    expect(view.rows.flat().some((b) => b.callback_data.includes(":approve:"))).toBe(page === 3);
    expect(view.rows.flat().some((b) => b.callback_data.includes(":exclude:"))).toBe(page === 3);
    for (const button of view.rows.flat().filter((b) => b.callback_data.startsWith("dr:"))) {
      expect(parseReviewCallback(button.callback_data)).not.toBeNull();
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    }
    mocks.tg.mockClear();
    await showDocumentReview(
      admin,
      chat,
      reviewButton(wide, "", "page", wide.row, page).callback_data,
    );
    expect(mocks.tg).toHaveBeenCalledTimes(1);
    expect(mocks.tg.mock.calls[0]![1].text).toBe(view.text);
    expect(mocks.tg.mock.calls[0]![1].reply_markup.force_reply).toBeUndefined();
  }
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get", "get", "get", "get"]);
  expect(mocks.catalog).not.toHaveBeenCalled();
  expect(JSON.stringify(wide)).toBe(before);
});

it("rejects invalid page callbacks and offers only recovery when the header no longer has that page", async () => {
  for (const key of [
    `dr:${id}:3:page:0`,
    `dr:${id}:3:page:0:4`,
    `dr:${id}:3:page:0:-1`,
    `dr:${id}:3:page:0:1:0`,
  ])
    expect(parseReviewCallback(key)).toBeNull();
  await showDocumentReview(admin, chat, `dr:${id}:3:page:0:3`);
  const message = mocks.tg.mock.calls[0]![1];
  expect(message.text).toContain("Страница полей больше недоступна".toLowerCase());
  expect(
    message.reply_markup.inline_keyboard
      .flat()
      .map((b: { callback_data: string }) => parseReviewCallback(b.callback_data)?.op)
      .filter(Boolean),
  ).toEqual(["get"]);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get"]);
});

it("keeps page navigation behind staff ownership and does not reopen handed-off rows", async () => {
  const key = reviewButton(review, "", "page", 0, 0).callback_data;
  for (const [member, target] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { id: 102, type: "private" }],
    [admin, { ...chat, type: "group" }],
  ] as const)
    await showDocumentReview(member, target, key);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.tg).not.toHaveBeenCalled();
  mocks.rpc.mockResolvedValue({ data: { ...review, import_id: id }, error: null });
  await showDocumentReview(admin, chat, key);
  const message = mocks.tg.mock.calls[0]![1];
  expect(message.text).toContain("Разбор закрыт для изменений".toLowerCase());
  expect(
    message.reply_markup.inline_keyboard
      .flat()
      .some((b: { callback_data: string }) =>
        /:(approve|exclude|edit|handoff):/.test(b.callback_data),
      ),
  ).toBe(false);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get"]);
});

it("keeps guidance read-only on an approved row and exposes it before handoff", async () => {
  const r = {
    ...review,
    decision: "approved" as const,
    counts: { total: 1, pending: 0, approved: 1, excluded: 0 },
    warnings: ["HIDDEN_ROWS", "FORMULA_NOT_EVALUATED"],
  };
  mocks.rpc.mockResolvedValue({ data: r, error: null });
  const before = JSON.stringify(r);
  const key = reviewButton(r, "", "checks").callback_data;
  expect(parseReviewCallback(key)?.op).toBe("checks");
  expect(parseReviewCallback(key + ":0")).toBeNull();
  await showDocumentReview(admin, chat, key);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get"]);
  const message = mocks.tg.mock.calls[0]![1];
  expect(message.text).toContain("скрытые строки");
  expect(message.text).toContain("не вычислял результат");
  expect(message.reply_markup.force_reply).toBeUndefined();
  expect(
    message.reply_markup.inline_keyboard
      .flat()
      .some((b: { callback_data: string }) => b.callback_data.includes(":approve:")),
  ).toBe(false);
  expect(JSON.stringify(r)).toBe(before);
  expect(mocks.catalog).not.toHaveBeenCalled();
  expect(
    renderReview(r, "summary")
      .rows.flat()
      .some((b) => b.callback_data.endsWith(":checks:0")),
  ).toBe(true);
  expect(
    renderReview({ ...r, import_id: id }, "checks")
      .rows.flat()
      .some((b) => b.callback_data.includes(":edit:")),
  ).toBe(false);
  mocks.rpc.mockClear();
  for (const [m, c] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { id: 102, type: "private" }],
    [admin, { ...chat, type: "group" }],
  ] as const)
    await showDocumentReview(m, c, key);
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("reads full corrected and original values without opening an edit or changing approval", async () => {
  const saved = "Сохранено: " + "Я".repeat(1800) + " — МОДЕЛЬ-220";
  const original = "Распознано: " + "Б".repeat(1800) + " — МОДЕЛЬ-380";
  const r = {
    ...review,
    cells: ["001", saved, "10"],
    original: ["001", original, "10"],
    decision: "approved" as const,
    counts: { total: 1, pending: 0, approved: 1, excluded: 0 },
  };
  const before = JSON.stringify(r);
  mocks.rpc.mockResolvedValue({ data: r, error: null });
  for (const [op, value] of [
    ["full", saved],
    ["orig", original],
  ] as const) {
    mocks.tg.mockClear();
    await showDocumentReview(admin, chat, reviewButton(r, "", op, 0, 1).callback_data);
    const texts = mocks.tg.mock.calls.map((c) => c[1].text as string);
    expect(texts.join("")).toContain(value);
    expect(texts.every((text) => Array.from(text).length <= 3500)).toBe(true);
    expect(mocks.tg.mock.calls.some((c) => c[1].reply_markup?.force_reply)).toBe(false);
    expect(texts.join("")).toContain("Проверена человеком");
  }
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get", "get"]);
  expect(mocks.catalog).not.toHaveBeenCalled();
  expect(JSON.stringify(r)).toBe(before);
  expect(renderReview(r).text).toContain("Длинные значения здесь сокращены");
});

it("lets readers choose any of thirty fields and return to the matching field page", () => {
  const r = {
    ...review,
    header: Array.from({ length: 30 }, (_, i) => "Поле " + i),
    cells: Array.from({ length: 30 }, (_, i) => "Значение " + i),
    row: 4999,
    revision: 9999999,
  };
  const buttons = renderReview(r, "values", 3).rows.flat();
  const fields = buttons.filter((b) => b.callback_data.includes(":full:"));
  expect(fields).toHaveLength(6);
  expect(fields.map((b) => parseReviewCallback(b.callback_data)?.column)).toEqual([
    24, 25, 26, 27, 28, 29,
  ]);
  const value = renderReview(r, "full", 29);
  expect(value.text).toContain("Значение 29");
  expect(value.rows.flat().some((b) => b.callback_data.endsWith(":values:4999:3"))).toBe(true);
  expect(value.rows.flat().some((b) => b.callback_data.endsWith(":page:4999:3"))).toBe(true);
  for (const b of [...buttons, ...value.rows.flat()]) {
    if (b.callback_data.startsWith("dr:"))
      expect(parseReviewCallback(b.callback_data)).not.toBeNull();
    expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  }
  for (const bad of [`dr:${id}:3:full:0`, `dr:${id}:3:orig:0:30`, `dr:${id}:3:values:0:4`])
    expect(parseReviewCallback(bad)).toBeNull();
  const missing = renderReview(review, "full", 29);
  expect(missing.text).toContain("Поле больше недоступно".toLowerCase());
  expect(missing.rows.flat().some((b) => b.callback_data.endsWith(":values:0:0"))).toBe(true);
});

it("distinguishes manual/split provenance and keeps handed-off details read-only", () => {
  expect(
    renderReview({ ...review, source_origin: "manual", original: [] }, "orig", 1).text,
  ).toContain("Исходного распознанного значения нет");
  expect(renderReview({ ...review, source_origin: "split" }, "orig", 1).text).toContain(
    "Общей строки до разделения".toLowerCase(),
  );
  const frozen = renderReview({ ...review, import_id: id }, "full", 1);
  expect(frozen.text).toContain("Аппарат");
  expect(frozen.text).toContain("Исправления закрыты".toLowerCase());
  expect(frozen.rows.flat().some((b) => b.callback_data.includes(":edit:"))).toBe(false);
});

it("keeps full-value browsing behind the existing private staff gate", async () => {
  await showDocumentReview(
    { ...admin, role: "seller" },
    chat,
    reviewButton(review, "", "full", 0, 1).callback_data,
  );
  await showDocumentReview(
    admin,
    { id: 102, type: "private" },
    reviewButton(review, "", "orig", 0, 1).callback_data,
  );
  await showDocumentReview(
    admin,
    { id: 101, type: "group" },
    reviewButton(review, "", "values", 0, 0).callback_data,
  );
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.tg).not.toHaveBeenCalled();
});

it("uses Russian field labels without rewriting original headers", () => {
  const r = {
    ...review,
    header: ["sku", "title", "price", "cost_price"],
    cells: ["001", "Аппарат", "100", "80"],
  };
  const view = renderReview(r);
  expect(view.text).toContain("Артикул: 001");
  expect(view.text).toContain("Розничная цена: 100");
  expect(view.text).toContain("Закупочная цена: 80");
  expect(r.header).toEqual(["sku", "title", "price", "cost_price"]);
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
  for (const op of ["get", "approve", "exclude", "handoff", "summary", "cancel", "resume"]) {
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
it("renews a rejected cell question only on request and rejects its old reply", async () => {
  let active = { ...prompt };
  let rejected = true;
  mocks.rpc.mockImplementation(async (_fn, args) => {
    if (args.p_op === "input") return { data: { ok: true, prompt: active }, error: null };
    if (args.p_op === "save" && rejected)
      return { data: null, error: { message: "DOCUMENT_VALUE" } };
    if (args.p_op === "edit") active = { ...active, revision: 4, message_id: 0 };
    if (args.p_op === "bind") active.message_id = args.p_payload.message_id;
    return { data: { ...review, revision: active.revision }, error: null };
  });
  await handleDocumentReviewText(admin, chat, "Я".repeat(2001), 500);
  const message = mocks.tg.mock.calls.at(-1)![1];
  expect(message.text).toContain("Этот ответ не сохранён");
  const retry = message.reply_markup.inline_keyboard
    .flat()
    .find((b: { text: string }) => b.text === "✏️ Повторить ввод").callback_data;
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["input", "save"]);
  expect(mocks.tg.mock.calls.some((c) => c[1].reply_markup?.force_reply)).toBe(false);
  await showDocumentReview(admin, chat, retry);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual([
    "input",
    "save",
    "input",
    "edit",
    "bind",
  ]);
  expect(active.message_id).toBe(501);
  rejected = false;
  mocks.rpc.mockClear();
  expect(await handleDocumentReviewText(admin, chat, "15", 500)).toBe(false);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["input"]);
  await handleDocumentReviewText(admin, chat, "15", 501);
  expect(mocks.rpc.mock.calls.at(-1)![1]).toMatchObject({
    p_op: "save",
    p_revision: 4,
    p_column: 2,
    p_payload: { value: "15", reply_to: 501 },
  });
  mocks.rpc.mockClear();
  await showDocumentReview(admin, chat, retry);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["input"]);
  expect(mocks.tg.mock.calls.at(-1)![1].text).toContain("устарели");
});

it("does not reopen another document, row, model question or closed input from an old retry", async () => {
  const retry = reviewButton(review, "", "resume").callback_data;
  for (const active of [
    undefined,
    { ...prompt, review_id: "22222222-2222-4222-8222-222222222222" },
    { ...prompt, row_index: 1 },
    { ...prompt, revision: 4 },
    { ...prompt, kind: "model" },
  ]) {
    mocks.rpc.mockClear();
    mocks.tg.mockClear();
    mocks.rpc.mockResolvedValue({ data: { ok: true, prompt: active }, error: null });
    await showDocumentReview(admin, chat, retry);
    expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["input"]);
    expect(mocks.tg.mock.calls.some((c) => c[1].reply_markup?.force_reply)).toBe(false);
  }
  mocks.rpc.mockClear();
  for (const [member, destination] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { id: 102, type: "private" }],
    [admin, { id: 101, type: "group" }],
  ] as const)
    await showDocumentReview(member, destination, retry);
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("never offers rejected-answer retry for an uncertain save or later Telegram failure", async () => {
  for (const failedBoundary of ["save", "delivery"]) {
    mocks.rpc.mockReset();
    mocks.tg.mockReset();
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
    mocks.tg.mockResolvedValue({ json: async () => ({ ok: true, result: { message_id: 501 } }) });
    if (failedBoundary === "save") mocks.rpc.mockRejectedValueOnce(new Error("connection lost"));
    else {
      mocks.rpc.mockResolvedValue({ data: review, error: null });
      mocks.tg.mockRejectedValueOnce(new Error("delivery lost"));
    }
    await handleDocumentReviewText(admin, chat, "15", 500);
    const recovery = mocks.tg.mock.calls.at(-1)![1];
    expect(recovery.text).toContain("неизвестен");
    expect(recovery.text).not.toContain("Этот ответ не сохранён");
    expect(
      recovery.reply_markup.inline_keyboard
        .flat()
        .some((b: { callback_data: string }) => b.callback_data.includes(":resume:")),
    ).toBe(false);
    expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["input", "save"]);
  }
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
