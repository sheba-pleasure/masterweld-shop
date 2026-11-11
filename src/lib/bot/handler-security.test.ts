import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffMember } from "./permissions";
import type { TgUpdate } from "./handler.server";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./telegram.server", async (original) => ({
  ...(await original<typeof import("./telegram.server")>()),
  tg: mocks.tg,
}));
import { handleUpdate } from "./handler.server";
import { assortmentView, type AssortmentResult } from "./assortment";
import { TelegramDeliveryError } from "./telegram.server";
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
let orderStatus: "new" | "processing" | "canceled";
function callback(data: string, type: string | undefined = "private", id = 101): TgUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: "cb",
      data,
      from: { id: 101 },
      message: { message_id: 41, chat: { id, type } },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  member = { ...actor };
  auditFails = false;
  readsFail = false;
  events = [];
  orderStatus = "new";
  mocks.tg.mockReset().mockResolvedValue(undefined);
  mocks.rpc.mockImplementation(async (name, args) => {
    if (name === "bot_change_order_status") orderStatus = args.p_next_status;
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
                status: orderStatus,
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
  it("opens the real main menu from new and previously delivered assortment buttons", async () => {
    const view = assortmentView({
      home: true,
      counts: {},
      recent: [],
    } as unknown as AssortmentResult);
    const button = view.rows.flat().find((b) => b.text === "Главное меню")!;
    for (const data of [button.callback_data, "menu"]) {
      mocks.tg.mockClear();
      await handleUpdate(callback(data));
      expect(
        mocks.tg.mock.calls.filter(([method]) => method === "sendMessage").length,
      ).toBeGreaterThan(0);
      const messages = mocks.tg.mock.calls
        .filter(([method]) => method === "sendMessage")
        .map(([, body]) => body);
      expect(
        messages.some((body) =>
          body.reply_markup?.inline_keyboard
            ?.flat()
            .some((b: { callback_data?: string }) => b.callback_data === "as:home"),
        ),
      ).toBe(true);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(events.every((e) => e === "from:staff")).toBe(true);
  });
  it("dev onboarding returns only the verified sender ID without granting permissions", async () => {
    member = null;
    vi.stubEnv("APP_ENV", "dev");
    try {
      await handleUpdate({
        update_id: 1,
        message: { text: "/start", from: { id: 101 }, chat: { id: 101, type: "private" } },
      });
      expect(mocks.tg).toHaveBeenCalledWith(
        "sendMessage",
        expect.objectContaining({
          chat_id: 101,
          text: expect.stringContaining("Telegram ID: 101"),
        }),
      );
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(events).toEqual(["from:staff"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    "home",
    "menu",
    "shop_versions",
    "shop_preview",
    "shop_pro_pending",
    "staff",
    "audit",
    "elevate_on",
    "elevate_off",
    "deliveries",
    "ci:home",
    `ci:apply:${orderId}:1`,
    "as:home",
    `as:apply:${orderId}`,
    "orders",
    `st:${orderId}:processing`,
    "cat:0",
    "edit:" + orderId,
    "pc:" + orderId,
    "pcx:" + orderId,
    "pcr:" + orderId,
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
  it.each([
    "/start",
    "/menu",
    "/shops",
    "/shop",
    "/catalog",
    "/lead",
    "/new",
    "/cancel",
    "/unknown",
    "plain",
  ])("group command %s is blocked", async (text) => {
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
  });
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
    for (const data of [
      "staff",
      "audit",
      "elevate_on",
      "deliveries",
      "ci:home",
      `ci:apply:${orderId}:1`,
      "as:home",
      `as:apply:${orderId}`,
    ])
      await handleUpdate(callback(data));
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(events).not.toContain("audit");
  });
  it("administrator delivery read is audited; failure does not disclose details", async () => {
    await handleUpdate(callback("deliveries"));
    expect(events.indexOf("audit")).toBeLessThan(events.indexOf("from:order_notifications"));
    expect(mocks.tg).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({ text: expect.stringContaining("Очередь уведомлений пуста") }),
    );
    events = [];
    auditFails = true;
    await handleUpdate(callback("deliveries"));
    expect(events).not.toContain("from:order_notifications");
    expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("SECRET_PHONE");
  });
  it("authorised private start gets menu", async () => {
    await handleUpdate({
      update_id: 1,
      message: { text: "/start", from: { id: 101 }, chat: { id: 101, type: "private" } },
    });
    expect(mocks.tg.mock.calls[0]?.[1].text).toContain("PRIVATE_NAME");
  });
});
describe("persistent navigation", () => {
  function message(text: string, type = "private", chatId = 101): TgUpdate {
    return { update_id: 2, message: { text, from: { id: 101 }, chat: { id: chatId, type } } };
  }
  it("start attaches a persistent keyboard and retains role actions", async () => {
    await handleUpdate(message("/start"));
    expect(mocks.tg.mock.calls[0]?.[1].reply_markup).toMatchObject({
      is_persistent: true,
      one_time_keyboard: false,
      resize_keyboard: true,
    });
    expect(mocks.tg.mock.calls[1]?.[1].reply_markup.inline_keyboard).toBeDefined();
  });
  it.each(["🧾 Заказы", "/orders"])(
    "orders entry %s opens orders before any editor input",
    async (text) => {
      await handleUpdate(message(text));
      expect(events).toContain("from:shop_orders");
      expect(events).not.toContain("from:bot_editor_states");
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it.each(["🏠 Меню", "❓ Помощь"])("navigation %s never becomes editor text", async (text) => {
    await handleUpdate(message(text));
    expect(events).toEqual(["from:staff"]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["🧾 Заказы", "/orders", "🏠 Меню"])(
    "group navigation %s cannot reach data",
    async (text) => {
      await handleUpdate(message(text, "group", -101));
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("revoked staff cannot use a previously installed keyboard", async () => {
    member = { ...actor, active: false };
    await handleUpdate(message("🧾 Заказы"));
    expect(events).toEqual(["from:staff"]);
    expect(mocks.tg.mock.calls[0]?.[1].text).toBe("Нет доступа.");
  });
});
describe("staff storefront environments", () => {
  it.each(["dev", "production"])(
    "authorised seller opens %s links without data or role mutations",
    async (env) => {
      vi.stubEnv("APP_ENV", env);
      try {
        member = { ...actor, role: "seller" };
        await handleUpdate(callback("shop_versions"));
        const payload = mocks.tg.mock.calls.find(([method]) => method === "sendMessage")?.[1];
        expect(payload.text).toContain("Корзины и заказы этих магазинов раздельные");
        expect(payload.reply_markup.inline_keyboard[0][0].web_app.url).toBe(
          "https://masterweld-dev.138-124-106-211.sslip.io/?miniapp=1",
        );
        const pro = payload.reply_markup.inline_keyboard[1][0];
        if (env === "production")
          expect(pro.web_app.url).toBe("https://shop.masterweld.ru/?miniapp=1");
        else {
          expect(pro.web_app).toBeUndefined();
          expect(pro.callback_data).toBe("shop_pro_pending");
        }
        expect(events).toEqual(["from:staff"]);
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(process.env["APP_ENV"]).toBe(env);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it.each(["shop_versions", "shop_preview", "shop_pro_pending"])(
    "revoked staff cannot access %s through an old message",
    async (action) => {
      member = { ...actor, active: false };
      await handleUpdate(callback(action));
      expect(mocks.tg).toHaveBeenCalledExactlyOnceWith("answerCallbackQuery", {
        callback_query_id: "cb",
        text: "Нет доступа.",
      });
      expect(events).toEqual(["from:staff"]);
    },
  );
  it.each(["🧪 DEV · учебный магазин", "🏪 PRO · рабочий магазин", "/shops"])(
    "shop entry %s cannot become pending product editor input",
    async (text) => {
      vi.stubEnv("APP_ENV", "dev");
      try {
        await handleUpdate({
          update_id: 3,
          message: { text, from: { id: 101 }, chat: { id: 101, type: "private" } },
        });
        expect(events).toEqual(["from:staff"]);
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.tg.mock.calls[0]?.[1].text).toContain("PRO — готовится к запуску");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
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
  it("updates the clicked order card and removes its obsolete action", async () => {
    await handleUpdate(callback(`st:${orderId}:processing`));
    expect(mocks.tg.mock.calls.map((c) => c[0])).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    const card = mocks.tg.mock.calls.at(-1)![1];
    expect(card.message_id).toBe(41);
    expect(card.text).toContain("Статус: в обработке");
    expect(JSON.stringify(card.reply_markup)).not.toContain(`st:${orderId}:processing`);
    expect(JSON.stringify(card.reply_markup)).toContain(`st:${orderId}:ready`);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("refreshes an already processed stale card without another mutation", async () => {
    orderStatus = "processing";
    await handleUpdate(callback(`st:${orderId}:processing`));
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.tg.mock.calls.at(-1)).toEqual([
      "editMessageText",
      expect.objectContaining({
        message_id: 41,
        text: expect.stringContaining("Заказ уже «в обработке»."),
      }),
    ]);
  });
  it("replaces confirmation and cancel views in the same message without writes", async () => {
    await handleUpdate(callback(`stc:${orderId}:canceled`));
    expect(mocks.tg.mock.calls.at(-1)).toEqual([
      "editMessageText",
      expect.objectContaining({
        message_id: 41,
        text: expect.stringContaining("Подтвердите"),
      }),
    ]);
    await handleUpdate(callback(`order:${orderId}`));
    expect(mocks.tg.mock.calls.at(-1)).toEqual([
      "editMessageText",
      expect.objectContaining({
        message_id: 41,
        text: expect.stringContaining("Статус: новый"),
      }),
    ]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("a Telegram timeout after commit never repeats the status write or sends another card", async () => {
    mocks.tg.mockImplementation(async (method) => {
      if (method === "editMessageText") throw new TelegramDeliveryError("network", true);
    });
    await expect(handleUpdate(callback(`st:${orderId}:processing`))).rejects.toThrow(
      "TELEGRAM_DELIVERY_FAILED",
    );
    expect(orderStatus).toBe("processing");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.tg.mock.calls.map((c) => c[0])).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
  });
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
