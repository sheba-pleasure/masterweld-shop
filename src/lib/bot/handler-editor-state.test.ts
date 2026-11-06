import { beforeEach, expect, it, vi } from "vitest";
import type { EditorStateRow } from "./editor";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), tg: vi.fn(), upsert: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./telegram.server", () => ({ tg: mocks.tg }));
import { handleUpdate } from "./handler.server";
const productId = "10000000-0000-4000-8000-000000000001";
let stored: EditorStateRow | null;
let error: string | null;
beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  error = "EDITOR_TECHNICAL_ACTIVE";
  mocks.tg.mockResolvedValue(Response.json({ ok: true, result: { message_id: 200 } }));
  mocks.rpc.mockResolvedValue({ data: { ok: true, session: null }, error: null });
  mocks.from.mockImplementation((table: string) => {
    const result = () => ({
      data:
        table === "staff"
          ? { telegram_id: 101, role: "admin", name: "QA", active: true, elevated: false }
          : table === "bot_editor_states"
            ? stored
            : table === "products"
              ? { id: productId, title: "[Учебный] Товар", price: 100, status: "draft" }
              : [{ id: productId, name: "Учебный раздел" }],
      error: null,
    });
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      order: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => result()),
      limit: vi.fn(async () => ({ data: [], error: null })),
      upsert: mocks.upsert.mockImplementation(async (next) => {
        if (!error) stored = next;
        return { data: null, error: error ? { message: error } : null };
      }),
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
    if (mode === "new") await text("/new");
    else await callback("et:" + mode + ":" + productId);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
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
  stored = {
    staff_telegram_id: 101,
    state,
    data: { title: "Учебный товар", sku: null },
    product_id: null,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    consumed_at: null,
  };
  const before = structuredClone(stored);
  error = "PRIVATE DATABASE DETAILS";
  await text(answer);
  expect(mocks.upsert).toHaveBeenCalledTimes(1);
  expect(stored).toEqual(before);
  expect(messages()).toHaveLength(1);
  expect(messages()[0]).toContain("Следующий вопрос не открыт");
  expect(messages()[0]).not.toContain("PRIVATE");
});
it("asks the ordinary first question only after the state was saved", async () => {
  error = null;
  await text("/new");
  expect(stored).toMatchObject({ state: "new_title" });
  expect(messages()).toHaveLength(1);
  expect(messages()[0]).toContain("Отправьте название");
});
