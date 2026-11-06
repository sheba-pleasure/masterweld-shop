import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { StaffMember } from "./permissions";
import { photoActionCallback, photoDetailCallback, photoRows, type BotPhoto } from "./photos";
import { describePendingChange } from "./pending";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./telegram.server", () => ({ tg: mocks.tg }));
import { handleUpdate } from "./handler.server";
const product = "10000000-0000-4000-8000-000000000001";
const ids = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
];
const pending = "30000000-0000-4000-8000-000000000001";
let member: StaffMember,
  photos: BotPhoto[],
  lookupError: boolean,
  listError: boolean,
  deleted: Set<string>;
let receipts: Map<string, Record<string, unknown>>, last: Record<string, unknown> | null;
const callback = (data: string, messageId = 100, chatId = 101) =>
  handleUpdate({
    update_id: 1,
    callback_query: {
      id: "cb",
      data,
      from: { id: 101 },
      message: {
        message_id: messageId,
        chat: { id: chatId, type: chatId === 101 ? "private" : "group" },
      },
    },
  });
const sent = () => mocks.tg.mock.calls.filter(([method]) => method === "sendMessage").at(-1)![1];
const prepared = () =>
  mocks.rpc.mock.calls.filter(
    ([fn, args]) => fn === "bot_pending_preview" && args.p_op === "prepare",
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_BOT_ID", "8996533708");
  member = { telegram_id: 101, role: "seller", active: true, elevated: false, name: "QA" };
  photos = ids.map((id, i) => ({
    id,
    url: "https://example.invalid/" + i + ".jpg",
    sort_order: i,
    is_main: i === 0,
  }));
  lookupError = false;
  listError = false;
  deleted = new Set();
  receipts = new Map();
  last = null;
  mocks.tg.mockResolvedValue(undefined);
  mocks.rpc.mockImplementation(async (fn, args) => {
    if (fn === "bot_pending_operation") return { data: last, error: null };
    if (args.p_op === "prepare") {
      last = {
        request_id: args.p_request_id,
        pending_id: pending,
        product_id: args.p_product_id,
        action: args.p_action,
        before: args.p_before,
        after: args.p_after,
        title: "Учебный",
        state: "pending",
      };
      receipts.set(args.p_request_id, last!);
    }
    return {
      data: receipts.get(args.p_request_id) ?? {
        request_id: args.p_request_id,
        state: "not_found",
      },
      error: null,
    };
  });
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => {
        filters[key] = value;
        return chain;
      },
      is: (key: string, value: unknown) => {
        filters[key] = value;
        return chain;
      },
      order: () => chain,
      maybeSingle: async () => {
        if (table === "staff") return { data: member, error: null };
        if (table === "pending_actions") return { data: { action: last?.action }, error: null };
        if (table === "products")
          return {
            data: { id: product, slug: "qa", title: "Учебный", price: 100, status: "draft" },
            error: null,
          };
        expect(filters.deleted_at).toBeNull();
        if (lookupError) return { data: null, error: { message: "SECRET" } };
        const ph = photos.find((p) => p.id === filters.id && !deleted.has(p.id));
        return { data: ph ? { product_id: product } : null, error: null };
      },
      then: (resolve: (r: unknown) => unknown) => {
        expect(table).toBe("product_photos");
        expect(filters.product_id).toBe(product);
        expect(filters.deleted_at).toBeNull();
        return Promise.resolve({
          data: listError ? null : photos.filter((p) => !deleted.has(p.id)),
          error: listError ? { message: "SECRET" } : null,
        }).then(resolve);
      },
    };
    return chain;
  });
});
afterEach(() => vi.unstubAllEnvs());
it("an old gallery position follows the same photo after the list is reordered", async () => {
  const old = photoRows(product, photos, true).flat()[1]!.callback_data;
  photos = [photos[0]!, photos[2]!, photos[1]!];
  await callback(old);
  expect(sent().text).toContain("Фото №3");
  expect(
    sent()
      .reply_markup.inline_keyboard.flat()
      .map((b: { callback_data: string }) => b.callback_data),
  ).toContain(photoActionCallback("x", ids[1]!));
  expect(prepared()).toHaveLength(0);
});
it.each(["m", "x"] as const)(
  "old %s action targets the same ID after another photo takes its position",
  async (action) => {
    const old = photoActionCallback(action, ids[1]!);
    photos = [photos[0]!, { ...photos[2]!, sort_order: 1 }, { ...photos[1]!, sort_order: 2 }];
    await callback(old);
    expect(prepared()).toHaveLength(1);
    expect(prepared()[0]![1].p_before).toMatchObject({ photo_id: ids[1], sort_order: 2 });
    expect(prepared()[0]![1].p_after.photo_id).toBe(ids[1]);
    expect(prepared()[0]![1].p_product_id).toBe(product);
  },
);
it("repeated action reads the first preview without resolving the moved/deleted list again", async () => {
  const old = photoActionCallback("x", ids[1]!);
  await callback(old);
  mocks.from.mockClear();
  deleted.add(ids[1]!);
  await callback(old);
  expect(prepared()).toHaveLength(1);
  expect(mocks.from.mock.calls.some(([table]) => table === "product_photos")).toBe(false);
  expect(sent().reply_markup.inline_keyboard[0][0].callback_data).toBe("pc:" + pending);
});
it.each(["d", "m", "u", "n", "x"])(
  "legacy positional button %s cannot choose a neighbour",
  async (action) => {
    await callback("ph" + action + ":" + product + ":1");
    expect(sent().text).toContain("старый номер фото");
    expect(sent().reply_markup.inline_keyboard[0][0].callback_data).toBe("ph:" + product);
    expect(prepared()).toHaveLength(0);
    expect(mocks.from.mock.calls.some(([table]) => table === "product_photos")).toBe(false);
  },
);
it("an already stored legacy request remains recoverable", async () => {
  const { previewRequestId } = await import("./preview-request.server");
  const update = {
    update_id: 1,
    callback_query: {
      id: "cb",
      data: "phx:" + product + ":1",
      from: { id: 101 },
      message: { message_id: 100, chat: { id: 101, type: "private" } },
    },
  };
  const key = previewRequestId(update, "8996533708")!;
  last = {
    request_id: key,
    pending_id: pending,
    product_id: product,
    action: "photo_delete",
    before: { photo_id: ids[1] },
    after: { photo_id: ids[1], deleted: true },
    state: "pending",
    title: "Учебный",
  };
  receipts.set(key, last);
  await handleUpdate(update);
  expect(sent().text).toContain("ожидает подтверждения");
  expect(prepared()).toHaveLength(0);
});
it.each(["pfd", "pfm", "pfu", "pfn", "pfx"])(
  "deleted photo %s never falls back to its replacement",
  async (prefix) => {
    deleted.add(ids[1]!);
    await callback(prefix + ":" + ids[1]);
    expect(sent().text).toContain("больше недоступно");
    expect(prepared()).toHaveLength(0);
  },
);
it("first non-main photo cannot move above the main photo", async () => {
  await callback(photoDetailCallback(ids[1]!));
  const buttons = sent()
    .reply_markup.inline_keyboard.flat()
    .map((b: { callback_data: string }) => b.callback_data);
  expect(buttons).not.toContain(photoActionCallback("u", ids[1]!));
  expect(buttons).toContain(photoActionCallback("n", ids[1]!));
  await callback(photoActionCallback("u", ids[1]!));
  expect(prepared()).toHaveLength(0);
});
it("last non-main photo moves up by its current non-main rank", async () => {
  await callback(photoActionCallback("u", ids[2]!));
  expect(prepared()[0]![1].p_after).toEqual({ photo_id: ids[2], sort_order: 1 });
  expect(prepared()[0]![1].p_before).toMatchObject({ photo_id: ids[2], sort_order: 2 });
});
it("a gallery without a main still uses SQL non-main ranks 1..n", async () => {
  photos = photos.slice(1).map((p, i) => ({ ...p, sort_order: i + 1 }));
  await callback(photoActionCallback("n", ids[1]!));
  expect(prepared()[0]![1].p_after.sort_order).toBe(2);
});
it.each(["lookup", "list"])("failed %s read is not presented as an empty gallery", async (kind) => {
  lookupError = kind === "lookup";
  listError = kind === "list";
  await callback(photoDetailCallback(ids[1]!));
  expect(sent().text).toContain("Не удалось прочитать");
  expect(sent().text).not.toContain("SECRET");
  expect(prepared()).toHaveLength(0);
});
it("gallery list failure is distinguishable from no photos", async () => {
  listError = true;
  await callback("ph:" + product);
  expect(sent().text).toContain("не означает, что она пуста");
  expect(sent().text).not.toContain("Фотографий пока нет");
});
it("current role is checked before photo access", async () => {
  member.role = "director";
  await callback(photoDetailCallback(ids[1]!));
  await callback(photoActionCallback("x", ids[1]!));
  expect(mocks.from.mock.calls.some(([table]) => table === "product_photos")).toBe(false);
  expect(prepared()).toHaveLength(0);
});
it("group/foreign sender is rejected before storage", async () => {
  await callback(photoActionCallback("x", ids[1]!), 100, -100);
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("photo result text distinguishes hiding, restoration and non-main ordering", () => {
  expect(describePendingChange("photo_delete", {}, { photo_id: ids[1], deleted: true })).toContain(
    "скрыть",
  );
  expect(describePendingChange("photo_delete", {}, { photo_id: ids[1], sort_order: 2 })).toContain(
    "восстановить из карантина",
  );
  expect(
    describePendingChange("photo_reorder", { sort_order: 9 }, { photo_id: ids[1], sort_order: 2 }),
  ).toContain("место среди обычных фото — 2");
});
