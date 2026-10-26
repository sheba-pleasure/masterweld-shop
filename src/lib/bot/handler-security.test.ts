import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffMember } from "./permissions";
import type { TgUpdate } from "./handler.server";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./telegram.server", () => ({ tg: mocks.tg }));
import { handleUpdate } from "./handler.server";
const actor: StaffMember = {
  telegram_id: 101,
  name: "PRIVATE_NAME",
  role: "admin",
  elevated: false,
  active: true,
};
const orderId = "11111111-1111-4111-8111-111111111111";
let member: StaffMember | null;
let auditFails: boolean;
let readsFail: boolean;
let events: string[];
function callback(data: string, type: string | undefined = "private", id = 101): TgUpdate {
  return {
    update_id: 1,
    callback_query: { id: "cb", data, from: { id: 101 }, message: { chat: { id, type } } },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  member = { ...actor };
  auditFails = false;
  readsFail = false;
  events = [];
  mocks.tg.mockResolvedValue(undefined);
  mocks.rpc.mockImplementation(async () => {
    events.push("rpc");
    return { data: { ok: true }, error: null };
  });
  mocks.from.mockImplementation((table: string) => {
    events.push(`from:${table}`);
    let insert = false;
    const result = () => ({
      data:
        table === "staff"
          ? member
          : table === "shop_orders"
            ? {
                id: orderId,
                name: "CLIENT",
                phone: "SECRET_PHONE",
                items: [],
                total: 100,
                created_at: "2026-10-25",
                status: "new",
              }
            : [],
      error: insert && auditFails ? { message: "SECRET_PHONE" } : null,
    });
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => result()),
      insert: vi.fn(() => {
        insert = true;
        events.push("audit");
        return Promise.resolve(result());
      }),
      order: vi.fn(() => {
        events.push("disclosure-read");
        return chain;
      }),
      limit: vi.fn(async () => ({
        data: [],
        error: readsFail ? { message: "SECRET_PHONE" } : null,
      })),
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: [], error: readsFail ? { message: "SECRET_PHONE" } : null }),
    };
    return chain;
  });
});
describe("single service gate", () => {
  it.each([
    "staff",
    "audit",
    "elevate_on",
    "elevate_off",
    "orders",
    `st:${orderId}:processing`,
    "cat:0",
    "edit:" + orderId,
    "pc:" + orderId,
    "b2b:leads:1",
    "import",
    "photos",
  ])("group %s never accesses DB", async (data) => {
    await handleUpdate(callback(data, "supergroup", -123));
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.tg).toHaveBeenCalledExactlyOnceWith("answerCallbackQuery", {
      callback_query_id: "cb",
      text: "Нет доступа.",
    });
  });
  it.each(["/start", "/menu", "/catalog", "/lead", "/new", "/cancel", "/unknown", "plain"])(
    "group command %s is blocked",
    async (text) => {
      await handleUpdate({
        update_id: 1,
        message: { text, from: { id: 101 }, chat: { id: -123, type: "group" } },
      });
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.tg).toHaveBeenCalledExactlyOnceWith("sendMessage", {
        chat_id: -123,
        text: "Нет доступа.",
      });
    },
  );
  it("missing type denies even equal IDs", async () => {
    const u = callback("staff");
    if (u.callback_query?.message?.chat) delete u.callback_query.message.chat.type;
    await handleUpdate(u);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("forged private actor denies before lookup", async () => {
    await handleUpdate(callback("staff", "private", 202));
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("absent callback message cannot borrow identity", async () => {
    const u = callback("staff");
    if (u.callback_query) delete u.callback_query.message;
    await handleUpdate(u);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("mixed forged update denies", async () => {
    const u = callback("staff", "group", -123);
    u.message = { from: { id: 101 }, chat: { id: 101, type: "private" } };
    await handleUpdate(u);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it.each([null, { ...actor, active: false }, { ...actor, telegram_id: 202 }])(
    "invalid staff row denies without PII",
    async (row) => {
      member = row;
      await handleUpdate(callback("staff"));
      expect(mocks.from).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("PRIVATE_NAME");
    },
  );
  it("seller cannot disclose staff/audit or elevate", async () => {
    member = { ...actor, role: "seller" };
    for (const data of ["staff", "audit", "elevate_on"]) await handleUpdate(callback(data));
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(events).not.toContain("audit");
  });
  it("authorised private start gets menu", async () => {
    await handleUpdate({
      update_id: 1,
      message: { text: "/start", from: { id: 101 }, chat: { id: 101, type: "private" } },
    });
    expect(mocks.tg.mock.calls[0]?.[1].text).toContain("PRIVATE_NAME");
  });
});
describe("audit-before-disclosure", () => {
  it.each(["staff", "audit"])("%s audits before read", async (data) => {
    await handleUpdate(callback(data));
    expect(events.indexOf("audit")).toBeLessThan(events.indexOf("disclosure-read"));
    expect(events).toContain("disclosure-read");
  });
  it.each(["staff", "audit"])("%s blocks disclosure on failed audit", async (data) => {
    auditFails = true;
    await handleUpdate(callback(data));
    expect(events).not.toContain("disclosure-read");
    expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("PRIVATE_NAME");
    expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("SECRET_PHONE");
  });
  it.each(["staff", "audit"])("%s read error gives no false result", async (data) => {
    readsFail = true;
    await handleUpdate(callback(data));
    expect(mocks.tg.mock.calls.at(-1)?.[1].text).toBe("Не удалось выполнить запрос.");
  });
});
describe("RPC only mutations", () => {
  it("status uses expected value and no separate writes", async () => {
    await handleUpdate(callback(`st:${orderId}:processing`));
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_change_order_status", {
      p_order_id: orderId,
      p_staff_telegram_id: 101,
      p_expected_status: "new",
      p_next_status: "processing",
    });
    expect(events).not.toContain("audit");
    expect(events).not.toContain("from:order_events");
  });
  it.each(["PGRST202", "40001", "XX000"])("status error %s never falls back", async (code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_NAME" } });
    await handleUpdate(callback(`st:${orderId}:processing`));
    expect(mocks.from.mock.calls.map((c) => c[0])).toEqual(["staff", "shop_orders"]);
    expect(mocks.tg.mock.calls.at(-1)?.[1].text).not.toContain("PRIVATE_NAME");
    expect(mocks.tg.mock.calls.at(-1)?.[1].text).not.toContain("→");
  });
  it("empty RPC result never claims success", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await handleUpdate(callback(`st:${orderId}:processing`));
    expect(mocks.tg.mock.calls.at(-1)?.[1].text).toContain("не подтверждена");
  });
  it.each(["elevate_on", "elevate_off"])("director %s uses audited RPC", async (data) => {
    member = { ...actor, role: "director", elevated: data === "elevate_off" };
    await handleUpdate(callback(data));
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_toggle_elevated", {
      p_staff_telegram_id: 101,
      p_expected_elevated: data === "elevate_off",
      p_elevated: data === "elevate_on",
    });
  });
  it("missing elevation RPC fails closed", async () => {
    member = { ...actor, role: "director" };
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    await handleUpdate(callback("elevate_on"));
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.tg.mock.calls.at(-1)?.[1].text).toContain("не активирована");
  });
});
