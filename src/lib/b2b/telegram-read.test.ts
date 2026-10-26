import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  from: vi.fn(),
  tg: vi.fn(),
  calls: [] as { table: string; method: string; args: unknown[] }[],
  results: [] as unknown[],
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mock.from, rpc: vi.fn() },
}));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mock.tg }));
import { showB2B } from "./telegram.server";
import { handleUpdate } from "@/lib/bot/handler.server";
import { B2B_READ_ERROR, LEAD_COLUMNS } from "./navigation";

const member = {
  telegram_id: 1,
  name: "synthetic",
  role: "admin" as const,
  active: true,
  elevated: false,
};
const chat = { id: 1, type: "private" };
const lead = {
  id: "00000000-0000-4000-8000-000000000001",
  stage: "new",
  priority: "manual",
  needs_review: true,
  created_at: "2026-10-24T07:00:00Z",
};
const ok = (data: unknown = null, count: number | null = null) => ({ data, count, error: null });
beforeEach(() => {
  vi.clearAllMocks();
  mock.calls.length = 0;
  mock.results.length = 0;
  mock.tg.mockResolvedValue(new Response("{}"));
  mock.from.mockImplementation((table: string) => {
    const result = mock.results.shift();
    const query: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    for (const method of ["select", "eq", "order", "range", "maybeSingle", "insert", "limit"])
      query[method] = (...args: unknown[]) => {
        mock.calls.push({ table, method, args });
        return query;
      };
    return query;
  });
});
describe("mocked B2B server adapter and existing handler", () => {
  it("bounded range, two stable sort keys and audit before send", async () => {
    mock.results.push(ok([lead]), ok());
    await showB2B(member, chat, { id: 1 }, { kind: "list", page: 1000 });
    expect(mock.calls).toEqual([
      { table: "b2b_leads", method: "select", args: [LEAD_COLUMNS] },
      { table: "b2b_leads", method: "order", args: ["created_at", { ascending: false }] },
      { table: "b2b_leads", method: "order", args: ["id", { ascending: false }] },
      { table: "b2b_leads", method: "range", args: [5994, 6000] },
      {
        table: "staff_audit_log",
        method: "insert",
        args: [{ telegram_id: 1, action: "b2b_leads_read", details: { page: 1000 } }],
      },
    ]);
    expect(mock.from.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mock.tg.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mock.tg).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({ chat_id: 1, text: expect.stringContaining("страница 1000") }),
    );
  });
  it("card counts use HEAD only with lead join; never select originals", async () => {
    mock.results.push(ok(lead), ok(null, 2), ok(null, 1), ok());
    await showB2B(member, chat, { id: 1 }, { kind: "lead", id: lead.id, page: 1 });
    expect(mock.calls).toContainEqual({
      table: "b2b_messages",
      method: "select",
      args: ["id", { count: "exact", head: true }],
    });
    expect(mock.calls).toContainEqual({
      table: "b2b_drafts",
      method: "select",
      args: ["id,b2b_messages!inner(lead_id)", { count: "exact", head: true }],
    });
    expect(mock.calls).toContainEqual({
      table: "b2b_drafts",
      method: "eq",
      args: ["b2b_messages.lead_id", lead.id],
    });
    expect(mock.calls).toContainEqual({
      table: "b2b_drafts",
      method: "eq",
      args: ["status", "DRAFT"],
    });
    expect(mock.tg).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({ text: expect.stringContaining("Сообщений в БД: 2") }),
    );
  });
  it("unknown count discloses nothing and never invents zero", async () => {
    mock.results.push(ok(lead), ok(null, null), ok(null, 1));
    await showB2B(member, chat, { id: 1 }, { kind: "lead", id: lead.id, page: 1 });
    expect(mock.tg).toHaveBeenCalledWith("sendMessage", { chat_id: 1, text: B2B_READ_ERROR });
    expect(mock.from).not.toHaveBeenCalledWith("staff_audit_log");
  });
  it("audit error sends only generic response", async () => {
    mock.results.push(ok([lead]), { error: { message: "SECRET" } });
    await showB2B(member, chat, { id: 1 }, { kind: "list", page: 1 });
    expect(mock.tg).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: 1,
      text: B2B_READ_ERROR,
    });
  });
  it("missing tables send generic response without audit", async () => {
    mock.results.push({ error: { code: "42P01", message: "missing table" } });
    await showB2B(member, chat, { id: 1 }, { kind: "list", page: 1 });
    expect(mock.tg).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: 1,
      text: B2B_READ_ERROR,
    });
    expect(mock.from).not.toHaveBeenCalledWith("staff_audit_log");
  });
  it.each(["/leads 2", "/leads@syntheticbot 2"])(
    "existing command dispatcher routes %s",
    async (text) => {
      mock.results.push(ok(member), ok([lead]), ok());
      await handleUpdate({ update_id: 1, message: { from: { id: 1 }, chat, text } });
      expect(mock.calls).toContainEqual({ table: "b2b_leads", method: "range", args: [6, 12] });
    },
  );
  it("existing callback dispatcher opens lead and acknowledges", async () => {
    mock.results.push(ok(member), ok(lead), ok(null, 2), ok(null, 1), ok());
    await handleUpdate({
      update_id: 1,
      callback_query: {
        id: "synthetic",
        data: `b2b:l:${lead.id}:2`,
        from: { id: 1 },
        message: { chat },
      },
    });
    expect(mock.tg).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({
        reply_markup: { inline_keyboard: [[{ text: "К списку", callback_data: "b2b:p:2" }]] },
      }),
    );
    expect(mock.tg).toHaveBeenLastCalledWith("answerCallbackQuery", {
      callback_query_id: "synthetic",
    });
  });
  it("pagination callback routes bounded range", async () => {
    mock.results.push(ok(member), ok([]), ok());
    await handleUpdate({
      update_id: 1,
      callback_query: { id: "synthetic", data: "b2b:p:3", from: { id: 1 }, message: { chat } },
    });
    expect(mock.calls).toContainEqual({ table: "b2b_leads", method: "range", args: [12, 18] });
  });
  it.each(["b2b:p:-1", "b2b:p:1001", "b2b:send:1"])(
    "invalid callback %s never reads CRM",
    async (data) => {
      mock.results.push(ok(member));
      await handleUpdate({
        update_id: 1,
        callback_query: { id: "synthetic", data, from: { id: 1 }, message: { chat } },
      });
      expect(mock.from).toHaveBeenCalledExactlyOnceWith("staff");
    },
  );
  it.each([null, { ...member, active: false }, { ...member, role: "seller" }])(
    "handler denies unauthorized user",
    async (staff) => {
      mock.results.push(ok(staff));
      await handleUpdate({ update_id: 1, message: { from: { id: 1 }, chat, text: "/leads" } });
      expect(mock.from).toHaveBeenCalledExactlyOnceWith("staff");
    },
  );
  it("group commands and callbacks reject before staff or CRM read", async () => {
    const group = { id: -10, type: "supergroup" };
    await handleUpdate({ update_id: 1, message: { from: { id: 1 }, chat: group, text: "/leads" } });
    await handleUpdate({
      update_id: 2,
      callback_query: {
        id: "synthetic",
        data: "b2b:p:1",
        from: { id: 1 },
        message: { chat: group },
      },
    });
    expect(mock.from).not.toHaveBeenCalled();
  });
});
