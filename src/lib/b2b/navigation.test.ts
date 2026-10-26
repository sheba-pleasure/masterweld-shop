import { describe, it, expect, vi } from "vitest";
import {
  B2B_DENIED,
  B2B_READ_ERROR,
  LEADS_PAGE_SIZE,
  MAX_LEADS_PAGE,
  compareLeads,
  formatLead,
  formatLeads,
  leadsRange,
  parseB2BCallback,
  parseB2BCommand,
  parseLeadsPage,
  validLeadId,
  type SafeLead,
} from "./navigation";
import { readB2B, type B2BReadStore } from "./reader";
import type { StaffMember } from "@/lib/bot/permissions";

const lead = (n = 1): SafeLead => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  stage: "new",
  priority: "high_manual",
  created_at: "2026-10-24T07:00:00Z",
  needs_review: true,
});
const actor = (role: StaffMember["role"] = "admin", active = true): StaffMember => ({
  telegram_id: 1,
  name: "synthetic",
  role,
  active,
  elevated: false,
});
const privateChat = { id: 1, type: "private" };
function mocks() {
  const store: B2BReadStore = {
    list: vi.fn().mockResolvedValue([lead()]),
    lead: vi.fn().mockResolvedValue(lead()),
    counts: vi.fn().mockResolvedValue({ messages: 2, drafts: 1 }),
    audit: vi.fn().mockResolvedValue(undefined),
  };
  return { store, open: vi.fn().mockResolvedValue(store) };
}
describe("bounded B2B navigation", () => {
  it("defaults to page 1 and accepts max with bounded lookahead", () => {
    expect(parseLeadsPage()).toBe(1);
    expect(parseLeadsPage("1000")).toBe(MAX_LEADS_PAGE);
    expect(leadsRange(1)).toEqual({ start: 0, end: 6 });
    expect(leadsRange(1000)).toEqual({ start: 5994, end: 6000 });
  });
  it.each([
    "0",
    "-1",
    "NaN",
    "Infinity",
    "1.5",
    "1001",
    "999999999999999999999",
    "01",
    " 1",
    "1x",
    "",
    NaN,
    -1,
    Infinity,
    null,
    1,
  ])("rejects page %s", (input) => expect(parseLeadsPage(input)).toBeNull());
  it.each([0, -1, NaN, Infinity, 1001, 1.5])("rejects numeric range %s", (page) =>
    expect(leadsRange(page)).toBeNull(),
  );
  it("accepts only exact commands and whitelisted callbacks", () => {
    expect(parseB2BCommand("/leads", [])).toEqual({ kind: "list", page: 1 });
    expect(parseB2BCommand("/leads", ["2"])).toEqual({ kind: "list", page: 2 });
    expect(parseB2BCommand("/lead", [lead().id])).toEqual({ kind: "lead", id: lead().id, page: 1 });
    expect(parseB2BCommand("/leads", ["1", "2"])).toBeNull();
    expect(parseB2BCommand("/lead", [])).toBeNull();
    expect(parseB2BCommand("/lead", [lead().id, "extra"])).toBeNull();
    expect(parseB2BCallback("b2b:p:1000")).toEqual({ kind: "list", page: 1000 });
    expect(parseB2BCallback(`b2b:l:${lead().id}:2`)).toEqual({
      kind: "lead",
      id: lead().id,
      page: 2,
    });
  });
  it.each([
    "b2b:p:0",
    "b2b:p:1001",
    "b2b:p:-1",
    "b2b:p:1\nsend",
    "b2b:send:1",
    "b2b:p:NaN",
    `b2b:l:${"a".repeat(100)}:1`,
    `b2b:l:${"-".repeat(36)}:1`,
    "orders",
    null,
  ])("rejects invalid callback %s", (input) => expect(parseB2BCallback(input)).toBeNull());
  it("rejects invalid/long UUIDs", () => {
    expect(validLeadId(lead().id)).toBe(true);
    expect(validLeadId(lead().id + "x")).toBe(false);
    expect(validLeadId("<script>")).toBe(false);
  });
  it("uses descending created_at and id for ties", () => {
    expect([lead(1), lead(3), lead(2)].sort(compareLeads).map((r) => r.id)).toEqual([
      lead(3).id,
      lead(2).id,
      lead(1).id,
    ]);
    expect(compareLeads({ ...lead(1), created_at: "2026-10-25T00:00:00Z" }, lead(3))).toBeLessThan(
      0,
    );
  });
  it("uses six items plus lookahead and bounded navigation", () => {
    const reply = formatLeads(
      Array.from({ length: 7 }, (_, n) => lead(n + 1)),
      2,
    );
    expect(reply.reply_markup?.inline_keyboard).toHaveLength(7);
    expect(reply.reply_markup?.inline_keyboard.at(-1)).toEqual([
      { text: "Назад", callback_data: "b2b:p:1" },
      { text: "Вперёд", callback_data: "b2b:p:3" },
    ]);
    for (const row of reply.reply_markup?.inline_keyboard ?? [])
      for (const button of row) {
        expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
        expect(parseB2BCallback(button.callback_data)).not.toBeNull();
      }
    expect(formatLeads([lead()], 1).reply_markup?.inline_keyboard).toHaveLength(1);
    expect(formatLeads([], 1).text).toContain("На этой странице заявок нет");
    expect(formatLeads([], 2).reply_markup?.inline_keyboard).toEqual([
      [{ text: "Назад", callback_data: "b2b:p:1" }],
    ]);
    expect(
      formatLeads(
        Array.from({ length: 7 }, (_, n) => lead(n)),
        1000,
      ).reply_markup?.inline_keyboard.at(-1),
    ).toEqual([{ text: "Назад", callback_data: "b2b:p:999" }]);
    expect(() =>
      formatLeads(
        Array.from({ length: 8 }, (_, n) => lead(n)),
        1,
      ),
    ).toThrow();
    expect(LEADS_PAGE_SIZE).toBe(6);
  });
  it("drops PII and untrusted HTML/Markdown using plain-text allowlists, within 4096", () => {
    const unsafe = {
      ...lead(),
      stage: "<b>SECRET</b>",
      priority: "[SECRET](https://bad)",
      original: { from: "synthetic@example.test", text: "ORIGINAL_SECRET" },
      message_id: "MESSAGE_SECRET",
      draft: "DRAFT_SECRET",
      phone: "PHONE_SECRET",
      prices: 999999,
      supplier: "SUPPLIER_SECRET",
    };
    const outputs = [
      formatLead(unsafe, { messages: 2, drafts: 1 }, 1),
      formatLeads(
        Array.from({ length: 7 }, (_, n) => ({ ...unsafe, id: lead(n).id })),
        1,
      ),
    ];
    for (const output of outputs) {
      expect(JSON.stringify(output)).not.toContain("SECRET");
      expect(JSON.stringify(output)).not.toContain("synthetic@example.test");
      expect(JSON.stringify(output)).not.toContain("999999");
      expect(output).not.toHaveProperty("parse_mode");
      expect(output.text.length).toBeLessThanOrEqual(4096);
    }
    expect(() =>
      formatLead({ ...unsafe, created_at: "<b>bad</b>" }, { messages: 0, drafts: 0 }, 1),
    ).toThrow();
    expect(() =>
      formatLead({ ...unsafe, id: "<b>bad</b>" }, { messages: 0, drafts: 0 }, 1),
    ).toThrow();
    expect(() => formatLead(lead(), { messages: NaN, drafts: -1 }, 1)).toThrow();
    expect(formatLead(lead(), { messages: 0, drafts: 0 }, 1).text).not.toContain("ожидает");
  });
});

describe("B2B read gate and audit-before-disclosure", () => {
  it.each([actor("seller"), actor("admin", false), null])(
    "denies unauthorized actor before opening DB",
    async (member) => {
      const { open } = mocks();
      expect(
        await readB2B(member, privateChat, { id: 1 }, { kind: "list", page: 1 }, open),
      ).toEqual({ text: B2B_DENIED });
      expect(open).not.toHaveBeenCalled();
    },
  );
  it.each([
    { id: -1, type: "supergroup" },
    { id: 1, type: "group" },
    { id: 2, type: "private" },
  ])("denies non-private/mismatched chat", async (chat) => {
    const { open } = mocks();
    expect((await readB2B(actor(), chat, { id: 1 }, { kind: "list", page: 1 }, open)).text).toBe(
      B2B_DENIED,
    );
    expect(open).not.toHaveBeenCalled();
  });
  it("actual sender must match staff and chat", async () => {
    const { open } = mocks();
    expect(
      (await readB2B(actor(), privateChat, { id: 2 }, { kind: "list", page: 1 }, open)).text,
    ).toBe(B2B_DENIED);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["admin", "director"] as const)(
    "allows %s, range read then audit then reply",
    async (role) => {
      const { open, store } = mocks();
      const reply = await readB2B(
        actor(role),
        privateChat,
        { id: 1 },
        { kind: "list", page: 2 },
        open,
      );
      expect(store.list).toHaveBeenCalledWith(6, 12);
      expect(store.audit).toHaveBeenCalledWith(1, { kind: "list", page: 2 });
      expect(vi.mocked(store.list).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(store.audit).mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(reply.text).toContain("00000000");
    },
  );
  it("card reads metadata and confirmed counts before audit", async () => {
    const { open, store } = mocks();
    const reply = await readB2B(
      actor(),
      privateChat,
      { id: 1 },
      { kind: "lead", id: lead().id, page: 2 },
      open,
    );
    expect(store.lead).toHaveBeenCalledWith(lead().id);
    expect(store.counts).toHaveBeenCalledWith(lead().id);
    expect(vi.mocked(store.counts).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.audit).mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(reply.text).toContain("Сообщений в БД: 2");
    expect(reply.text).toContain("Черновиков DRAFT в БД: 1");
  });
  it.each(["list", "lead", "counts", "audit"] as const)(
    "fails closed on %s error including missing tables",
    async (operation) => {
      const { open, store } = mocks();
      vi.mocked(store[operation]).mockRejectedValue(new Error("missing table / ORIGINAL_SECRET"));
      const request =
        operation === "list"
          ? { kind: "list" as const, page: 1 }
          : { kind: "lead" as const, id: lead().id, page: 1 };
      expect(await readB2B(actor(), privateChat, { id: 1 }, request, open)).toEqual({
        text: B2B_READ_ERROR,
      });
      if (operation !== "audit") expect(store.audit).not.toHaveBeenCalled();
    },
  );
  it("invalid request opens no store", async () => {
    const { open } = mocks();
    for (const request of [
      null,
      { kind: "list" as const, page: 0 },
      { kind: "lead" as const, id: "bad", page: 1 },
    ])
      await readB2B(actor(), privateChat, { id: 1 }, request, open);
    expect(open).not.toHaveBeenCalled();
  });
  it("empty/missing records are audited, never pretend mail was received", async () => {
    const { open, store } = mocks();
    vi.mocked(store.lead).mockResolvedValue(null);
    expect(
      (
        await readB2B(
          actor(),
          privateChat,
          { id: 1 },
          { kind: "lead", id: lead().id, page: 1 },
          open,
        )
      ).text,
    ).toBe("Заявка не найдена.");
    expect(store.counts).not.toHaveBeenCalled();
    expect(store.audit).toHaveBeenCalledOnce();
  });
});
