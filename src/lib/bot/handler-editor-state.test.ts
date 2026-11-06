import { beforeEach, expect, it, vi } from "vitest";
import type { EditorStateRow } from "./editor";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  tg: vi.fn(),
  write: vi.fn(),
  pending: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./telegram.server", () => ({ tg: mocks.tg }));
import { handleUpdate } from "./handler.server";
const productId = "10000000-0000-4000-8000-000000000001";
const revision = "20000000-0000-4000-8000-000000000001";
const oldRevision = "20000000-0000-4000-8000-000000000002";
let stored: EditorStateRow | null;
let error: string | null;
let role: string;
let beforeWrite: (() => void) | null;
const stateRow = (state: string, data = {}): EditorStateRow => ({
  staff_telegram_id: 101,
  state,
  data: { _revision: revision, ...data },
  product_id: null,
  expires_at: new Date(Date.now() + 60000).toISOString(),
  consumed_at: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  error = null;
  role = "admin";
  beforeWrite = null;
  mocks.tg.mockResolvedValue(Response.json({ ok: true, result: { message_id: 200 } }));
  mocks.rpc.mockImplementation(async (name, args) => {
    if (name === "bot_finish_draft") {
      if (args.p_revision !== revision)
        return { data: null, error: { message: "DRAFT_STEP_CHANGED" } };
      return {
        data: args.p_accept
          ? { outcome: "created", product_id: productId, slug: "qa", title: "Учебный" }
          : { outcome: "canceled" },
        error: null,
      };
    }
    return { data: { ok: true, session: null }, error: null };
  });
  mocks.from.mockImplementation((table: string) => {
    let operation = "read";
    let patch: Record<string, unknown> = {};
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const result = () => {
      if (table === "bot_editor_states" && operation !== "read") {
        mocks.write(operation, patch);
        if (beforeWrite) {
          const action = beforeWrite;
          beforeWrite = null;
          action();
        }
        if (error) return { data: null, error: { message: error } };
        if (operation === "insert" && stored)
          return { data: null, error: { message: "duplicate" } };
        if (
          operation === "update" &&
          (!stored || !filters.every((f) => f(stored as unknown as Record<string, unknown>)))
        )
          return { data: null, error: null };
        stored = { ...stored, ...patch } as EditorStateRow;
      }
      if (table === "pending_actions" && operation === "insert") mocks.pending(patch);
      return {
        data:
          table === "staff"
            ? { telegram_id: 101, role, name: "QA", active: true, elevated: false }
            : table === "bot_editor_states"
              ? structuredClone(stored)
              : table === "products"
                ? {
                    id: productId,
                    title: "[Учебный] Товар",
                    price: 100,
                    status: "draft",
                    category_id: null,
                  }
                : [{ id: productId, name: "Учебный раздел" }],
        error: null,
      };
    };
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn((key, value) => {
        filters.push((row) =>
          key === "data" ? JSON.stringify(row[key]) === value : row[key] === value,
        );
        return chain;
      }),
      is: vi.fn((key, value) => {
        filters.push((row) => row[key] === value);
        return chain;
      }),
      gt: vi.fn((key, value) => {
        filters.push((row) => String(row[key]) > value);
        return chain;
      }),
      order: vi.fn(() => chain),
      update: vi.fn((value) => {
        operation = "update";
        patch = value;
        return chain;
      }),
      insert: vi.fn((value) => {
        operation = "insert";
        patch = value;
        return chain;
      }),
      maybeSingle: vi.fn(async () => result()),
      limit: vi.fn(async () => ({ data: [], error: null })),
      then: (resolve: (v: unknown) => unknown) => resolve(result()),
    };
    return chain;
  });
});
function text(value: string) {
  return handleUpdate({
    update_id: 1,
    message: { text: value, from: { id: 101 }, chat: { id: 101, type: "private" } },
  });
}
function callback(value: string) {
  return handleUpdate({
    update_id: 2,
    callback_query: {
      id: "cb",
      data: value,
      from: { id: 101 },
      message: { message_id: 150, chat: { id: 101, type: "private" } },
    },
  });
}
const messages = () =>
  mocks.tg.mock.calls.filter(([method]) => method === "sendMessage").map(([, p]) => p.text);
it.each(["new", "title", "cat"])(
  "does not open a competing %s prompt when technical editor is active",
  async (mode) => {
    error = "EDITOR_TECHNICAL_ACTIVE";
    if (mode === "new") await text("/new");
    else await callback("et:" + mode + ":" + productId);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(stored).toBeNull();
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("Новый ввод не начат");
    expect(messages()[0]).toContain("/technical");
    expect(messages()[0]).not.toContain("EDITOR_TECHNICAL_ACTIVE");
  },
);
it.each([
  ["new_title", "Новое учебное название"],
  ["new_sku", "-"],
  ["new_price", "14990"],
])("does not ask the next question when persisting %s fails", async (state, answer) => {
  stored = stateRow(state, { title: "Учебный товар", sku: null });
  const before = structuredClone(stored);
  error = "PRIVATE DATABASE DETAILS";
  await text(answer);
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(stored).toEqual(before);
  expect(messages()).toHaveLength(1);
  expect(messages()[0]).toContain("Следующий вопрос не открыт");
  expect(messages()[0]).not.toContain("PRIVATE");
});
it("asks the ordinary first question only after the state was saved", async () => {
  await text("/new");
  expect(stored).toMatchObject({ state: "new_title" });
  expect(messages()).toHaveLength(1);
  expect(messages()[0]).toContain("Отправьте название");
});
it.each(["/new", "et:title:" + productId, "et:cat:" + productId])(
  "preserves the active ordinary input on %s",
  async (action) => {
    stored = stateRow("new_price", { title: "Первый черновик", sku: "QA" });
    const before = structuredClone(stored);
    if (action.startsWith("/")) await text(action);
    else await callback(action);
    expect(stored).toEqual(before);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(messages()[0]).toContain("Текущий ввод сохранён");
  },
);
it("advances a concurrently read draft step only once", async () => {
  stored = stateRow("new_title");
  await Promise.all([text("Первое название"), text("Второе название")]);
  expect(stored?.state).toBe("new_sku");
  expect(messages().filter((m) => m.includes("Этот шаг уже изменился"))).toHaveLength(1);
  expect((stored?.data as Record<string, unknown>)["_revision"]).not.toBe(revision);
});
it("creates one preview from two concurrent text responses", async () => {
  stored = { ...stateRow("edit_title"), product_id: productId };
  await Promise.all([text("Первое название"), text("Второе название")]);
  expect(mocks.pending).toHaveBeenCalledTimes(1);
  expect(stored?.consumed_at).toBeTruthy();
});
it("does not consume a replacement state after a stale read", async () => {
  stored = { ...stateRow("edit_title"), product_id: productId };
  const replacement = stateRow("new_title", { _revision: oldRevision });
  beforeWrite = () => {
    stored = structuredClone(replacement);
  };
  await text("Новое название");
  expect(stored).toEqual(replacement);
  expect(mocks.pending).not.toHaveBeenCalled();
  expect(messages()[0]).toContain("Этот шаг уже изменился");
});
it("does not create a preview when claiming input fails", async () => {
  stored = { ...stateRow("edit_title"), product_id: productId };
  error = "PRIVATE";
  await text("Новое название");
  expect(mocks.pending).not.toHaveBeenCalled();
  expect(stored?.consumed_at).toBeNull();
  expect(messages()[0]).not.toContain("PRIVATE");
  expect(messages()[0]).toContain("Не удалось проверить шаг");
  expect(messages()[0]).not.toContain("уже изменился");
});
it.each(["nd:c", "nd:x", "nd:c:" + oldRevision, "nd:x:" + oldRevision])(
  "rejects old draft button %s",
  async (action) => {
    stored = stateRow("new_confirm", { title: "Второй черновик", sku: null, price: 100 });
    const before = structuredClone(stored);
    await callback(action);
    expect(stored).toEqual(before);
    expect(mocks.rpc.mock.calls.some(([name]) => name === "bot_create_draft")).toBe(false);
    expect(messages()[0]).toContain("Этот шаг уже изменился");
  },
);
it("delegates both confirmations with the same key without consuming input in the handler", async () => {
  stored = stateRow("new_confirm", { title: "Учебный товар", sku: null, price: 100 });
  const before = structuredClone(stored);
  await Promise.all([callback("nd:c:" + revision), callback("nd:c:" + revision)]);
  expect(mocks.rpc.mock.calls.filter(([name]) => name === "bot_finish_draft")).toEqual([
    ["bot_finish_draft", { p_staff_telegram_id: 101, p_revision: revision, p_accept: true }],
    ["bot_finish_draft", { p_staff_telegram_id: 101, p_revision: revision, p_accept: true }],
  ]);
  expect(stored).toEqual(before);
  expect(mocks.write).not.toHaveBeenCalled();
});
it("recovers the saved result without consuming a later dialog", async () => {
  stored = stateRow("new_title", { _revision: oldRevision });
  const before = structuredClone(stored);
  mocks.rpc.mockResolvedValue({
    data: {
      outcome: "created",
      product_id: productId,
      slug: "qa",
      title: "Учебный",
      replayed: true,
    },
    error: null,
  });
  await callback("nd:c:" + revision);
  expect(messages()[0]).toContain("Черновик уже создан");
  expect(stored).toEqual(before);
  expect(mocks.write).not.toHaveBeenCalled();
});
it.each(["c", "x"])(
  "preserves the exact %s attempt after an unknown RPC outcome",
  async (action) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE NETWORK RESPONSE" } });
    await callback("nd:" + action + ":" + revision);
    expect(messages()[0]).toContain("пока не подтверждён");
    expect(messages()[0]).not.toContain("PRIVATE");
    const sent = mocks.tg.mock.calls.find(([method]) => method === "sendMessage")![1];
    expect(sent.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      "nd:" + action + ":" + revision,
    );
    expect(mocks.write).not.toHaveBeenCalled();
  },
);
it("does not retry a known denied creation", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "DRAFT_PERMISSION_DENIED" } });
  await callback("nd:c:" + revision);
  expect(messages()[0]).toContain("Недостаточно прав");
  const sent = mocks.tg.mock.calls.find(([method]) => method === "sendMessage")![1];
  expect(sent.reply_markup).toBeUndefined();
});
it.each(["ec:0", "ec:0:" + oldRevision])("rejects stale category button %s", async (action) => {
  stored = stateRow("pick_cat", {
    product_id: productId,
    cats: [{ id: productId, name: "Раздел" }],
  });
  const before = structuredClone(stored);
  await callback(action);
  expect(stored).toEqual(before);
  expect(mocks.pending).not.toHaveBeenCalled();
});
it("creates one category preview from concurrent choices", async () => {
  stored = stateRow("pick_cat", {
    product_id: productId,
    cats: [{ id: productId, name: "Раздел" }],
  });
  await Promise.all([callback("ec:0:" + revision), callback("ec:0:" + revision)]);
  expect(mocks.pending).toHaveBeenCalledTimes(1);
});
it("does not report successful cancellation when storage fails", async () => {
  stored = stateRow("new_title");
  error = "PRIVATE";
  await text("/cancel");
  expect(stored?.consumed_at).toBeNull();
  expect(messages()[0]).toContain("Не удалось подтвердить отмену");
  expect(messages()[0]).not.toContain("PRIVATE");
});
it("does not advance input after edit permission is revoked", async () => {
  stored = stateRow("new_title");
  role = "viewer";
  const before = structuredClone(stored);
  await text("Новое название");
  expect(stored).toEqual(before);
  expect(mocks.write).not.toHaveBeenCalled();
});
