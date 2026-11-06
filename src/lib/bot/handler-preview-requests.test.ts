import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { previewRequestId, isDirectPreview } from "./preview-request.server";
import type { TgUpdate } from "./handler.server";
import type { StaffMember } from "./permissions";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./telegram.server", () => ({ tg: mocks.tg }));
import { handleUpdate } from "./handler.server";
const product = "10000000-0000-4000-8000-000000000002";
const pending = "10000000-0000-4000-8000-000000000003";
const source = "10000000-0000-4000-8000-000000000004";
let member: StaffMember;
let state: string;
let action: string;
let failRead: boolean;
let loseCommitResponse: boolean;
let receipt: Record<string, unknown> | null;
const command = (text = "/set title DEMO Новый товар", messageId = 100): TgUpdate => ({
  update_id: messageId,
  message: { message_id: messageId, text, from: { id: 101 }, chat: { id: 101, type: "private" } },
});
const button = (data: string, messageId = 200): TgUpdate => ({
  update_id: 777,
  callback_query: {
    id: "cb",
    data,
    from: { id: 101 },
    message: { message_id: messageId, chat: { id: 101, type: "private" } },
  },
});
const result = () => ({
  pending_id: pending,
  product_id: product,
  action,
  state,
  title: "Учебный товар",
  before: { title: "До", price: 100 },
  after: { title: "После", price: 120 },
  replayed: true,
});
const sent = () => mocks.tg.mock.calls.filter(([method]) => method === "sendMessage").at(-1)![1];
const mutations = () =>
  mocks.rpc.mock.calls.filter(([fn, args]) => fn === "bot_pending_preview" && args.p_op !== "read");
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_BOT_ID", "8996533708");
  member = { telegram_id: 101, role: "admin", active: true, elevated: false, name: "QA" };
  state = "pending";
  action = "title";
  failRead = false;
  loseCommitResponse = false;
  receipt = null;
  mocks.tg.mockResolvedValue(undefined);
  mocks.rpc.mockImplementation(async (fn, args) => {
    if (fn === "bot_pending_operation") return { data: result(), error: null };
    if (fn === "bot_pending_history")
      return {
        data: receipt
          ? [
              {
                id: pending,
                action,
                state,
                title: "Учебный товар",
                created_at: "2026-11-06T10:00:00Z",
              },
            ]
          : [],
        error: null,
      };
    if (args.p_op === "read" && failRead)
      return { data: null, error: { message: "SECRET transport failure" } };
    if (!receipt && args.p_op !== "read") receipt = { ...result(), request_id: args.p_request_id };
    if (args.p_op !== "read" && loseCommitResponse) {
      loseCommitResponse = false;
      return { data: null, error: { message: "SECRET lost response" } };
    }
    return {
      data: receipt ? { ...receipt, state } : { state: "not_found", request_id: args.p_request_id },
      error: null,
    };
  });
  mocks.from.mockImplementation((table: string) => {
    const p = {
      id: product,
      title: "До",
      slug: "qa",
      sku: "DEMO",
      price: 100,
      in_stock: true,
      status: "draft",
    };
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: [p], error: null }),
      maybeSingle: async () => ({
        data: table === "staff" ? member : table === "pending_actions" ? { action } : p,
        error: null,
      }),
    };
    return chain;
  });
});
afterEach(() => vi.unstubAllEnvs());

it("keeps one key for message delivery and repeated clicks; isolates actors, bots and new messages", () => {
  const a = command();
  expect(previewRequestId(a, "1")).toBe(previewRequestId({ ...a, update_id: 888 }, "1"));
  expect(previewRequestId(a, "1")).not.toBe(previewRequestId(command(undefined, 101), "1"));
  expect(previewRequestId(a, "1")).not.toBe(previewRequestId(a, "2"));
  const cb = button("stp:" + product + ":hidden");
  expect(previewRequestId(cb, "1")).toBe(
    previewRequestId(
      { ...cb, update_id: 9, callback_query: { ...cb.callback_query!, id: "another" } },
      "1",
    ),
  );
  expect(previewRequestId(cb, "1")).not.toBe(
    previewRequestId(button("stp:" + product + ":hidden", 201), "1"),
  );
  expect(previewRequestId(cb, "1")).not.toBe(
    previewRequestId({ ...cb, callback_query: { ...cb.callback_query!, from: { id: 102 } } }, "1"),
  );
});
it("uses the original applied operation as the rollback key across result messages", () => {
  expect(previewRequestId(button("rb:" + source, 1), "1")).toBe(
    previewRequestId(button("rb:" + source, 2), "1"),
  );
  expect(previewRequestId(button("rb:" + source), "1")).not.toBe(
    previewRequestId(button("rb:" + pending), "1"),
  );
});
it("refuses missing identity and recognises only preparation routes", () => {
  expect(previewRequestId(command(), undefined)).toBeNull();
  expect(previewRequestId(button("pxs:" + product + ":s0", 0), "1")).toBeNull();
  expect(isDirectPreview(command("/set@mybot title DEMO Новый"))).toBe(true);
  expect(isDirectPreview(command("/settings"))).toBe(false);
  expect(isDirectPreview(button("pc:" + pending))).toBe(false);
  expect(isDirectPreview(button("phx:" + product + ":1"))).toBe(true);
});
it("recovers a direct command without a new pending after simulated module restart", async () => {
  const update = command();
  await handleUpdate(update);
  expect(mutations()).toHaveLength(1);
  expect(mutations()[0]![1]).toMatchObject({
    p_op: "prepare",
    p_product_id: product,
    p_action: "title",
    p_after: { title: "Новый товар" },
  });
  mocks.from.mockClear();
  vi.resetModules();
  const restarted = await import("./handler.server");
  await restarted.handleUpdate(update);
  expect(mutations()).toHaveLength(1);
  expect(mocks.from.mock.calls.some(([table]) => table === "products")).toBe(false);
  expect(sent().reply_markup.inline_keyboard[0][0].callback_data).toBe("pc:" + pending);
});
it("lost commit response offers a read key and does not repeat preparation", async () => {
  loseCommitResponse = true;
  await handleUpdate(command());
  const callback = sent().reply_markup.inline_keyboard[0][0].callback_data;
  expect(callback).toBe("prr:" + previewRequestId(command(), "8996533708"));
  expect(sent().text).toContain("мог сохраниться");
  expect(sent().text).not.toContain("SECRET");
  await handleUpdate(button(callback));
  expect(mutations()).toHaveLength(1);
  expect(sent().text).toContain("Пока ничего не сохранено");
});
it("a failed initial read stops the write", async () => {
  failRead = true;
  await handleUpdate(command());
  expect(mutations()).toHaveLength(0);
  expect(sent().text).toContain("ответ не подтверждён");
});
it("unknown request reading never creates a pending", async () => {
  await handleUpdate(button("prr:" + pending));
  expect(mutations()).toHaveLength(0);
  expect(sent().text).toContain("пока не найден");
});
it.each(["canceled", "expired", "applied", "uncertain"])(
  "returns %s without a new preview or write",
  async (outcome) => {
    await handleUpdate(command());
    state = outcome;
    await handleUpdate(command());
    expect(mutations()).toHaveLength(1);
    expect(JSON.stringify(sent().reply_markup ?? {})).not.toContain('"callback_data":"pc:');
    expect(
      mocks.rpc.mock.calls
        .filter(([fn, args]) => fn === "bot_pending_operation")
        .every(([, args]) => args.p_op === "read"),
    ).toBe(true);
  },
);
it("rollback preparation uses the same key on a second click, never the old RPC", async () => {
  await handleUpdate(button("rb:" + source, 1));
  await handleUpdate(button("rb:" + source, 2));
  expect(mutations()).toHaveLength(1);
  expect(mocks.tg.mock.calls.filter(([method]) => method === "answerCallbackQuery")).toHaveLength(
    2,
  );
  expect(mutations()[0]![1]).toMatchObject({ p_op: "rollback", p_source_pending_id: source });
  expect(mocks.rpc.mock.calls.some(([fn]) => fn === "bot_prepare_rollback")).toBe(false);
});
it("history finds the saved preview when Telegram delivery failed", async () => {
  mocks.tg.mockRejectedValueOnce(new Error("unknown delivery"));
  await expect(handleUpdate(command())).rejects.toThrow("unknown delivery");
  expect(receipt).not.toBeNull();
  mocks.tg.mockResolvedValue(undefined);
  await handleUpdate(command("/actions", 101));
  expect(sent().text).toContain("Мои правки");
  expect(sent().text).toContain("13:00");
  expect(sent().reply_markup.inline_keyboard[0][0].callback_data).toBe("pcr:" + pending);
  expect(mutations()).toHaveLength(1);
});
it("history is bounded and uses server pagination", async () => {
  await handleUpdate(button("acts:10"));
  expect(mocks.rpc).toHaveBeenLastCalledWith("bot_pending_history", {
    p_staff_telegram_id: 101,
    p_offset: 10,
  });
  mocks.rpc.mockClear();
  await handleUpdate(button("acts:10001"));
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("history read failure never appears as an empty history", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "SECRET" } });
  await handleUpdate(command("/actions"));
  expect(sent().text).toContain("Не удалось прочитать");
  expect(sent().text).not.toContain("SECRET");
});
it("current seller rights prevent price result disclosure", async () => {
  action = "price";
  receipt = { ...result(), request_id: pending };
  member.role = "seller";
  await handleUpdate(button("prr:" + pending));
  expect(sent().text).toContain("Недостаточно прав");
  expect(mocks.rpc.mock.calls.some(([fn]) => fn === "bot_pending_operation")).toBe(false);
});
it.each(["acts:0", "prr:" + pending, "rb:" + source])(
  "private actor gate precedes %s",
  async (data) => {
    const update = button(data);
    update.callback_query!.message!.chat = { id: -100, type: "group" };
    await handleUpdate(update);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
