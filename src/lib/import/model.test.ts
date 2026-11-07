import { beforeEach, expect, it, vi } from "vitest";
import { modelButton, parseModelCallback, renderModel, type ModelView } from "./model-view";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
import { showDocumentModel, handleDocumentModelText } from "./model.server";
import { documentReviewControl, handleDocumentReviewText } from "./review.server";
const id = "11111111-1111-4111-8111-111111111111";
const admin: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" };
const prompt = {
  kind: "model" as const,
  review_id: id,
  revision: 3,
  row_index: 0,
  column_index: 0,
  message_id: 500,
};
const model: ModelView = {
  ok: true,
  id,
  row: 0,
  revision: 3,
  row_revision: 4,
  file_name: "Прайс.xlsx",
  table_label: "Лист 1",
  document_id: id,
  header: ["Артикул", "Название"],
  cells: ["aB-001", "Образец 220"],
  eligible: true,
  stale: false,
  usable: false,
  state: "draft",
  manufacturer: "Производитель",
  model: "Модель-220",
  variant_mode: "unknown",
  variant: "",
  focus: -1,
  prompt: null,
  history: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: model, error: null });
  mocks.tg.mockResolvedValue({ json: async () => ({ ok: true, result: { message_id: 501 } }) });
});
it("denies every model path before database or Telegram access for wrong actor and rights", async () => {
  for (const [m, c] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { id: 102, type: "private" }],
    [admin, { id: 101, type: "group" }],
  ] as const) {
    await showDocumentModel(m, c, modelButton(model, "", "get").callback_data);
    expect(await handleDocumentModelText(m, c, prompt, "Text", 500)).toBe(false);
  }
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.tg).not.toHaveBeenCalled();
});
it("reads current model and history without questions, writes, import or publication", async () => {
  for (const op of ["get", "history"])
    await showDocumentModel(admin, chat, modelButton(model, "", op).callback_data);
  expect(mocks.rpc.mock.calls.map((c) => [c[0], c[1].p_op])).toEqual([
    ["bot_document_model", "get"],
    ["bot_document_model", "get"],
  ]);
  expect(mocks.tg.mock.calls.some((c) => c[1].reply_markup?.force_reply)).toBe(false);
  const v = renderModel(model);
  expect(v.text).toContain("Автоматический поиск, описания и фотографии ещё не подключены");
  expect(v.text).toContain("aB-001");
  expect(v.rows.flat().some((b) => b.callback_data.includes(":confirm:"))).toBe(false);
  expect(v.rows.flat().some((b) => b.callback_data.startsWith("ci:"))).toBe(false);
});
it("never describes an obsolete confirmation as currently usable", () => {
  for (const m of [
    { ...model, state: "confirmed" as const, stale: true },
    { ...model, state: "confirmed" as const, eligible: false },
  ]) {
    const v = renderModel(m);
    expect(v.text).not.toContain("✅ Модель подтверждена");
    expect(v.rows.flat().some((b) => b.callback_data.includes(":confirm:"))).toBe(false);
  }
  const confirmed = {
    ...model,
    state: "confirmed" as const,
    usable: true,
    variant_mode: "none" as const,
  };
  expect(renderModel(confirmed).text).toContain("✅ Модель подтверждена");
  expect(
    renderModel(confirmed)
      .rows.flat()
      .some((b) => b.callback_data.includes(":confirm:")),
  ).toBe(false);
});
it("binds a new question only to its actual Telegram message and returned revision", async () => {
  mocks.rpc.mockResolvedValue({
    data: { ...model, revision: 4, focus: 0, prompt: { ...prompt, revision: 4, message_id: null } },
    error: null,
  });
  await showDocumentModel(admin, chat, modelButton(model, "", "start").callback_data);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["start", "bind"]);
  expect(mocks.rpc.mock.calls[1]![1]).toMatchObject({
    p_actor: 101,
    p_id: id,
    p_row: 0,
    p_revision: 4,
    p_payload: { message_id: 501 },
  });
  expect(mocks.tg.mock.calls[1]![1].reply_markup.force_reply).toBe(true);
});
it("routes /input and /cancel to the model instead of the cell editor", async () => {
  for (const command of ["resume", "cancel"] as const) {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
    expect(await documentReviewControl(admin, chat, command)).toBe(true);
  }
  expect(mocks.rpc.mock.calls.map((c) => [c[0], c[1].p_op])).toEqual([
    ["bot_document_review", "input"],
    ["bot_document_model", "resume"],
    ["bot_document_review", "input"],
    ["bot_document_model", "cancel"],
  ]);
});
it("accepts only the current replied-to model question; ordinary text cannot become a cell edit", async () => {
  mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
  expect(await handleDocumentReviewText(admin, chat, "Other", 499)).toBe(false);
  mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
  expect(await handleDocumentReviewText(admin, chat, "Plain")).toBe(true);
  expect(mocks.rpc.mock.calls).toHaveLength(2);
  mocks.rpc.mockResolvedValueOnce({ data: { ok: true, prompt }, error: null });
  expect(await handleDocumentReviewText(admin, chat, "aB-220", 500)).toBe(true);
  expect(mocks.rpc.mock.calls.at(-1)).toEqual([
    "bot_document_model",
    {
      p_actor: 101,
      p_op: "reply",
      p_id: id,
      p_row: 0,
      p_revision: 3,
      p_payload: { value: "aB-220", reply_to: 500 },
    },
  ]);
  expect(mocks.rpc.mock.calls.some((c) => c[1].p_op === "save")).toBe(false);
});
it("does not replay a mutation or bind an uncertain Telegram question", async () => {
  mocks.rpc.mockResolvedValue({
    data: { ...model, focus: 0, prompt: { ...prompt, message_id: null } },
    error: null,
  });
  mocks.tg.mockResolvedValueOnce({ json: async () => ({ ok: true }) });
  mocks.tg.mockRejectedValueOnce(new Error("Private transport detail"));
  await showDocumentModel(admin, chat, modelButton(model, "", "start").callback_data);
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["start"]);
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("Private transport detail");
  expect(mocks.tg.mock.calls.at(-1)![1].reply_markup.inline_keyboard[0][0].callback_data).toBe(
    `dm:${id}:0:get:0`,
  );
});
it("renders a bounded history as history and splits all messages without losing identities", async () => {
  const history = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    decision: "confirmed",
    identity: {
      manufacturer: "Я".repeat(100),
      model: "М".repeat(150),
      variant_mode: "specified",
      variant: "В".repeat(150),
    },
    created_at: "2026-11-07T00:00:00Z",
  }));
  mocks.rpc.mockResolvedValue({ data: { ...model, history }, error: null });
  await showDocumentModel(admin, chat, modelButton(model, "", "history").callback_data);
  const messages = mocks.tg.mock.calls.map((c) => c[1].text as string);
  expect(messages.length).toBeGreaterThan(1);
  expect(messages.every((t) => Array.from(t).length <= 3500)).toBe(true);
  expect(messages.join("")).toContain("История не заменяет текущее состояние");
  expect(messages.join("")).toContain("В".repeat(150));
});
it("keeps callback limits and rejects injected or out-of-range actions", () => {
  for (const op of [
    "get",
    "history",
    "start",
    "askbrand",
    "askmodel",
    "askvar",
    "resume",
    "novar",
    "uncertain",
    "confirm",
    "cancel",
  ]) {
    const key = modelButton({ ...model, revision: 9999999, row: 4999 }, "", op).callback_data;
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(64);
    expect(parseModelCallback(key)?.op).toBe(op);
  }
  for (const key of [
    `dm:${id}:3:get:5000`,
    `dm:${id}:3:get:0:1`,
    `dm:${id}:3:apply:0`,
    "dm:../../x:0:get:0",
  ])
    expect(parseModelCallback(key)).toBeNull();
});
