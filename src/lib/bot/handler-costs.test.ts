import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffMember } from "./permissions";
import type { TgUpdate } from "./handler.server";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./telegram.server", () => ({ tg: mocks.tg }));
import { handleUpdate } from "./handler.server";
const id = "10000000-0000-4000-8000-000000000002";
let member: StaffMember | null;
let cost: number | null;
let failure: string | null;
let events: string[];
const callback = (data = "cost:" + id, chatId = 101, type = "private"): TgUpdate => ({
  update_id: 811,
  callback_query: {
    id: "cb",
    data,
    from: { id: 101 },
    message: { message_id: 200, chat: { id: chatId, type } },
  },
});
const sent = () => mocks.tg.mock.calls.filter(([method]) => method === "sendMessage").at(-1)?.[1];
beforeEach(() => {
  vi.clearAllMocks();
  member = { telegram_id: 101, name: "Продавец", role: "seller", active: true, elevated: false };
  cost = 1234.56;
  failure = null;
  events = [];
  mocks.tg.mockResolvedValue(undefined);
  mocks.from.mockImplementation((table: string) => {
    events.push(table);
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data:
          table === "staff"
            ? member
            : table === "product_costs"
              ? { cost_price: cost, updated_at: "2026-11-06T12:00:00Z" }
              : { id, title: "Учебный товар", sku: "QA-COST", price: 2500.75, in_stock: true },
        error: failure === table ? { message: "PRIVATE_DATABASE_ERROR" } : null,
      }),
      insert: async () => ({
        error: failure === table ? { message: "PRIVATE_AUDIT_ERROR" } : null,
      }),
    };
    return chain;
  });
});
describe("private seller purchase cost flow", () => {
  it("seller reads cost with kopecks, retail separately, audited before delivery", async () => {
    mocks.tg.mockImplementation(async (method) => {
      if (method === "sendMessage") events.push("send");
    });
    await handleUpdate(callback());
    expect(sent().text).toContain("1 234,56 ₽");
    expect(sent().text).toContain("2 500,75 ₽");
    expect(sent().text).toContain("15:00 МСК");
    expect(events).toEqual(["staff", "products", "product_costs", "staff_audit_log", "send"]);
    expect(sent().reply_markup.inline_keyboard.flat()).toContainEqual({
      text: "⬅️ К товару",
      callback_data: "prd:" + id,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("unknown and disabled users cannot read costs", async () => {
    for (const value of [null, { ...member!, active: false }]) {
      mocks.from.mockClear();
      member = value;
      await handleUpdate(callback());
      expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["staff"]);
      expect(sent()).toBeUndefined();
    }
  });
  it("group and foreign chat cannot reach the database", async () => {
    await handleUpdate(callback("cost:" + id, 101, "group"));
    await handleUpdate(callback("cost:" + id, 202));
    expect(mocks.from).not.toHaveBeenCalled();
    expect(sent()).toBeUndefined();
  });
  it("malformed ID cannot read costs", async () => {
    await handleUpdate(callback("cost:" + "a".repeat(36)));
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["staff"]);
  });
  it("read or audit failure discloses neither amount nor database error", async () => {
    for (const table of ["products", "product_costs", "staff_audit_log"]) {
      failure = table;
      await handleUpdate(callback());
      expect(sent().text).toContain("Не удалось проверить цены");
      expect(sent().text).not.toMatch(/1234|1.234|PRIVATE_/);
    }
  });
  it("missing cost differs from a genuine zero", async () => {
    cost = null;
    await handleUpdate(callback());
    expect(sent().text).toContain("пока не указана");
    cost = 0;
    await handleUpdate(callback());
    expect(sent().text).toContain("Закупочная цена: 0,00 ₽");
    expect(sent().text).not.toContain("пока не указана");
  });
  it("stock picker only offers previews; opening it never mutates", async () => {
    await handleUpdate(callback("ps:" + id));
    expect(
      sent()
        .reply_markup.inline_keyboard.flat()
        .map((b: { callback_data: string }) => b.callback_data),
    ).toEqual(["pxs:" + id + ":s1", "pxs:" + id + ":s0", "prd:" + id]);
    expect(sent().text).toContain("для подтверждения");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("seller help and menu link to actions, without import or staff controls", async () => {
    await handleUpdate(callback("home"));
    const rows = sent().reply_markup.inline_keyboard.flat();
    expect(rows).toHaveLength(6);
    expect(
      rows.some((b: { callback_data: string }) => /staff|import|elevate/.test(b.callback_data)),
    ).toBe(false);
    await handleUpdate(callback("guide:home"));
    expect(sent().text).toContain("Закупочная и розничная цена");
    expect(
      sent()
        .reply_markup.inline_keyboard.flat()
        .some((b: { callback_data: string }) => b.callback_data === "guide:input"),
    ).toBe(true);
  });
});
