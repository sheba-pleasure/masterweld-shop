import { beforeEach, expect, it, vi } from "vitest";
import { can, type StaffMember } from "./permissions";
import { PENDING_PERMISSION, type PendingActionKind } from "./pending";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./telegram.server", () => ({ tg: mocks.tg }));
import { handleUpdate } from "./handler.server";
const id = "10000000-0000-4000-8000-000000000001";
const product = "10000000-0000-4000-8000-000000000002";
let member: StaffMember;
let action: PendingActionKind = "title";
let readError: boolean;
const result = (state: string) => ({
  state,
  pending_id: id,
  product_id: product,
  action,
  title: "Учебный товар",
  before: { title: "До", price: 100 },
  after: { title: "После", price: 120 },
  replayed: true,
});
beforeEach(() => {
  vi.clearAllMocks();
  member = { telegram_id: 101, role: "admin", active: true, elevated: false, name: "QA" };
  action = "title";
  readError = false;
  mocks.tg.mockResolvedValue(undefined);
  mocks.rpc.mockImplementation(async () => ({ data: result("applied"), error: null }));
  mocks.from.mockImplementation((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data: table === "staff" ? member : { action },
        error: table !== "staff" && readError ? { message: "PRIVATE DATABASE" } : null,
      }),
    };
    return chain;
  });
});
function callback(prefix = "pc") {
  return handleUpdate({
    update_id: 1,
    callback_query: {
      id: "cb",
      data: prefix + ":" + id,
      from: { id: 101 },
      message: { message_id: 1, chat: { id: 101, type: "private" } },
    },
  });
}
const sent = () => mocks.tg.mock.calls.filter(([method]) => method === "sendMessage").at(-1)![1];

it.each([
  ["pc", "apply"],
  ["pcx", "cancel"],
  ["pcr", "read"],
])("uses the same key for %s and reports the durable outcome", async (prefix, op) => {
  await callback(prefix);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_pending_operation", {
    p_pending_id: id,
    p_staff_telegram_id: 101,
    p_op: op,
  });
  expect(sent().text).toContain("Изменение уже сохранено");
  expect(sent().text).not.toContain("Отменено");
});
it.each(["pc", "pcx", "pcr"])("offers only a read after unknown response to %s", async (prefix) => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE DATABASE" } });
  await callback(prefix);
  expect(sent().text).toContain("Изменение могло сохраниться");
  expect(sent().text).not.toContain("ничего не изменено");
  expect(sent().text).not.toContain("PRIVATE");
  expect(sent().reply_markup.inline_keyboard).toEqual([
    [{ text: "🔎 Проверить результат", callback_data: "pcr:" + id }],
  ]);
});
it("does not call a mutation after the initial lookup fails", async () => {
  readError = true;
  await callback();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(sent().text).toContain("Результат пока не подтверждён");
});
it("reads a pending result without automatically applying it", async () => {
  mocks.rpc.mockResolvedValue({ data: result("pending"), error: null });
  await callback("pcr");
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(sent().text).toContain("Пока ничего не сохранено");
  expect(sent().reply_markup.inline_keyboard[0][0].callback_data).toBe("pc:" + id);
});
it.each(["canceled", "expired", "uncertain"])(
  "does not offer apply/rollback for %s",
  async (state) => {
    mocks.rpc.mockResolvedValue({ data: result(state), error: null });
    await callback();
    const buttons = JSON.stringify(sent().reply_markup ?? {});
    expect(buttons).not.toContain("pc:");
    expect(buttons).not.toContain("rb:");
    expect(sent().text).not.toContain("Изменение сохранено");
  },
);
it.each([
  null,
  { state: "applied" },
  { ...result("applied"), pending_id: product },
  { ...result("applied"), action: "price" },
  { ...result("applied"), after: null },
])("does not invent success from an incomplete result", async (data) => {
  mocks.rpc.mockResolvedValue({ data, error: null });
  await callback();
  expect(sent().text).toContain("Результат пока не подтверждён");
});
it.each(["BOT_PENDING_PERMISSION_DENIED", "BOT_PENDING_NOT_OWNER"])(
  "fails closed on %s",
  async (message) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message } });
    await callback();
    expect(sent().reply_markup).toBeUndefined();
    expect(sent().text).not.toContain("Изменение сохранено");
  },
);
it("reports a proven transaction conflict without provider details", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "BOT_PENDING_CONFLICT PRIVATE" } });
  await callback();
  expect(sent().text).toContain("Данные изменились");
  expect(sent().text).not.toContain("PRIVATE");
});
it.each(Object.keys(PENDING_PERMISSION) as PendingActionKind[])(
  "keeps seller permission %s for confirmation, cancellation and reading",
  async (kind) => {
    member.role = "seller";
    action = kind;
    for (const prefix of ["pc", "pcx", "pcr"]) {
      mocks.rpc.mockClear();
      await callback(prefix);
      expect(mocks.rpc).toHaveBeenCalledTimes(can(member, PENDING_PERMISSION[kind]) ? 1 : 0);
    }
  },
);
