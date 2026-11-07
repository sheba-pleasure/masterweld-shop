import { beforeEach, expect, it, vi } from "vitest";
import type { StaffMember } from "@/lib/bot/permissions";
import {
  parseModelChoiceCallback,
  renderModelChoice,
  type ProductModelChoice,
} from "./model-choice-view";
import { renderProductModelLinks, type DocumentModelLink } from "./model-links-view";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
import { showModelChoice } from "./model-choice.server";
const id = "11111111-1111-4111-8111-111111111111",
  request = "22222222-2222-4222-8222-222222222222";
const admin: StaffMember = {
  telegram_id: 101,
  name: "QA",
  active: true,
  role: "admin",
  elevated: false,
};
const chat = { id: 101, type: "private" };
const identity = { manufacturer: "Завод", model: "aB-220", variant_mode: "none", variant: "" };
const source: DocumentModelLink = {
  review_id: id,
  row: 4999,
  model_revision: 2,
  decision_id: id,
  identity,
  state: "linked",
  product_id: id,
  document_id: id,
  file_name: "Прайс.xls",
  linked_at: null,
  import_id: id,
  line: 5001,
};
const base: ProductModelChoice = {
  ok: true,
  product_id: id,
  title: "Аппарат",
  sku: "aB-001",
  current: { state: "unselected", revision: 0, usable: false },
  request: null,
};
const prepared: ProductModelChoice = {
  ...base,
  request: {
    id: request,
    kind: "select",
    state: "prepared",
    identity,
    source,
    other_models: 1,
    expires_at: "2026-11-07T05:00:00Z",
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: prepared, error: null });
  mocks.tg.mockResolvedValue({});
});
it("binds source and receipt callbacks to exact IDs within Telegram limits", () => {
  for (const [data, expected] of [
    [`pm:view:${id}`, { op: "get", product: id }],
    [`pm:clear:${id}`, { op: "prepare_clear", product: id }],
    [`pm:pick:${id}:5001`, { op: "prepare", batch: id, line: 5001 }],
    [`pm:read:${request}`, { op: "read", request }],
    [`pm:confirm:${request}`, { op: "confirm", request }],
    [`pm:cancel:${request}`, { op: "cancel", request }],
  ] as const) {
    expect(parseModelChoiceCallback(data)).toEqual(expected);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  }
  for (const bad of [
    `pm:pick:${id}:0`,
    `pm:pick:${id}:1`,
    `pm:pick:${id}:5002`,
    `pm:pick:${id}:2:3`,
    `pm:apply:${id}`,
    `pm:view:${id}x`,
    "pm:pick:x:2",
  ])
    expect(parseModelChoiceCallback(bad)).toBeNull();
});
it("requires private actual actor and current import and cost permissions", async () => {
  for (const [m, c] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, role: "director" as const, elevated: false }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { id: 202, type: "private" }],
    [admin, { id: 101, type: "group" }],
  ] as const)
    await showModelChoice(m, c, `pm:pick:${id}:2`, request);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.tg).not.toHaveBeenCalled();
  await showModelChoice(
    { ...admin, role: "director", elevated: true },
    chat,
    `pm:pick:${id}:2`,
    request,
  );
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_product_model_choice", {
    p_actor: 101,
    p_op: "prepare",
    p_product: null,
    p_batch: id,
    p_line: 2,
    p_request: request,
  });
});
it("does not prepare without a durable source request ID", async () => {
  await showModelChoice(admin, chat, `pm:pick:${id}:2`);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.tg.mock.calls[0]![1].reply_markup.inline_keyboard[0][0].callback_data).toBe("home");
});
it("shows a separate confirmation and keeps the old choice when canceling", () => {
  const view = renderModelChoice(prepared);
  expect(view.text).toContain("aB-220");
  expect(view.text).toContain("другие модели: 1");
  expect(view.text).toContain("Цена, название и статус товара не изменятся");
  expect(view.text).toContain("Прежние характеристики могут быть скрыты");
  expect(view.text).toContain("пока не подключены");
  const buttons = view.rows.flat();
  expect(buttons).toContainEqual({
    text: "✅ Подтвердить выбор модели",
    callback_data: `pm:confirm:${request}`,
  });
  expect(buttons.some((b) => b.callback_data === `pm:cancel:${request}`)).toBe(true);
  expect(buttons.some((b) => b.callback_data === `di:original:${id}`)).toBe(true);
  expect(buttons.some((b) => b.callback_data === `dm:${id}:0:get:4999`)).toBe(true);
  expect(
    renderModelChoice(base)
      .rows.flat()
      .some((b) => b.callback_data.startsWith("pm:confirm:")),
  ).toBe(false);
});
it("expired, stale, canceled and old confirmed previews cannot offer another confirmation", () => {
  for (const state of ["expired", "stale", "canceled", "confirmed"] as const) {
    const view = renderModelChoice({
      ...prepared,
      current: {
        state: "selected",
        revision: 3,
        usable: true,
        choice_id: id,
        identity: { ...identity, model: "NEW-380" },
      },
      request: { ...prepared.request!, state },
    });
    expect(view.rows.flat().some((b) => b.callback_data.startsWith("pm:confirm:"))).toBe(false);
    expect(view.text).toContain("NEW-380");
    if (state === "confirmed") expect(view.text).toContain("повтор не возвращает прежнюю модель");
  }
});
it("withdrawal needs separate confirmation and does not choose another source", () => {
  const view = renderModelChoice({
    ...base,
    current: { state: "selected", revision: 1, usable: true, identity },
    request: { ...prepared.request!, kind: "clear", identity: null, source: null },
  });
  expect(view.text).toContain("Снять текущий выбор?");
  expect(view.rows.flat()).toContainEqual({
    text: "✅ Снять выбор модели",
    callback_data: `pm:confirm:${request}`,
  });
  expect(
    renderModelChoice({ ...base, current: { state: "withdrawn", revision: 2, usable: false } })
      .text,
  ).toContain("Автоматической замены другой моделью нет");
});
it("stale and excluded choices are visibly unusable without hiding prior identity", () => {
  for (const state of ["stale", "excluded"] as const) {
    const view = renderModelChoice({
      ...base,
      current: { state, revision: 2, usable: false, identity },
    });
    expect(view.text).toContain("aB-220");
    expect(view.text).not.toContain("✅ Эта модель выбрана");
    expect(view.rows.flat().some((b) => b.callback_data === `pm:clear:${id}`)).toBe(true);
  }
});
it("links selection only to eligible exact source IDs, never a page index", () => {
  const render = (state: string, excluded = false) =>
    renderProductModelLinks({
      ok: true,
      product_id: id,
      title: "Аппарат",
      sku: "A",
      items: [{ ...source, state }],
      page: 0,
      pages: 1,
      conflicting: true,
      excluded,
    });
  const view = render("linked");
  expect(view.rows.flat().some((b) => b.callback_data === `pm:pick:${id}:5001`)).toBe(true);
  expect(view.rows.flat().some((b) => b.callback_data === `pm:view:${id}`)).toBe(true);
  for (const state of [
    "unconfirmed",
    "model_changed",
    "undone",
    "canceled",
    "preview",
    "excluded",
    "product_changed",
  ])
    expect(
      render(state)
        .rows.flat()
        .some((b) => b.callback_data.startsWith("pm:pick:")),
    ).toBe(false);
  expect(
    render("linked", true)
      .rows.flat()
      .some((b) => b.callback_data.startsWith("pm:pick:")),
  ).toBe(false);
});
it("recovers unknown preparation or confirmation by reading the same receipt, without retrying writes", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE_DETAILS" } });
  for (const data of [`pm:pick:${id}:2`, `pm:confirm:${request}`]) {
    mocks.rpc.mockClear();
    mocks.tg.mockClear();
    await showModelChoice(admin, chat, data, request);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const body = mocks.tg.mock.calls[0]![1];
    expect(body.text).toContain("Это не означает, что действие не сохранилось");
    expect(body.text).not.toContain("PRIVATE_DETAILS");
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe(`pm:read:${request}`);
  }
});
it("reads recovery without turning it into a new preparation", async () => {
  await showModelChoice(admin, chat, `pm:read:${request}`, id);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_product_model_choice", {
    p_actor: 101,
    p_op: "read",
    p_product: null,
    p_batch: null,
    p_line: null,
    p_request: request,
  });
});
