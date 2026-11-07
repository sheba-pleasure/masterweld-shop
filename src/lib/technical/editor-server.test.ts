import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
import { technicalEditor } from "./editor.server";
import { editorAction, families, fields, type EditorData } from "./editor";
import type { StaffMember } from "@/lib/bot/permissions";
const id = "10000000-0000-4000-8000-000000000001";
const owner: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" },
  from = { id: 101 };
const base = (): EditorData => ({
  document: { family_code: "power_mma", values: [], sources: [] },
  screen: "home",
  page: 0,
  field: null,
  fact: null,
  pending: null,
  source: null,
  sourceField: 0,
});
const session = () => ({
  id,
  product_id: id,
  product_title: "[Учебный] изделие",
  revision: 3,
  base_version: 7,
  phase: "editing",
  data: base(),
  base_document: null,
  prompt_message_id: 111,
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  review_state: null,
});
let stored = session();
beforeEach(() => {
  vi.clearAllMocks();
  stored = session();
  mocks.tg.mockImplementation(async () => Response.json({ ok: true, result: { message_id: 222 } }));
  mocks.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    if (args["p_op"] === "save")
      stored = { ...stored, data: args["p_data"] as EditorData, revision: stored.revision + 1 };
    return { data: { ok: true, session: structuredClone(stored) }, error: null };
  });
});
it.each([
  [{ ...owner, active: false }, chat, from],
  [{ ...owner, role: "director" as const }, chat, from],
  [owner, { id: -1, type: "group" }, from],
  [owner, chat, { id: 102 }],
])("does not access storage before private sender and permission checks", async (m, c, f) => {
  await technicalEditor(m, c, f, { command: "/technical" });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("rejects stale callbacks without persisting or confirming", async () => {
  await technicalEditor(owner, chat, from, { callback: "te:" + id + ":2:pending" });
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get"]);
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("устарели");
});
it("seller cannot request verified preview even with a forged button", async () => {
  await technicalEditor({ ...owner, role: "seller" }, chat, from, {
    callback: "te:" + id + ":3:verified",
  });
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get"]);
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("Недостаточно прав");
});
it("preview uses the durable session base; the handler does not read a newer card version", async () => {
  await technicalEditor(owner, chat, from, { callback: "te:" + id + ":3:pending" });
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["get", "preview"]);
  expect(mocks.rpc.mock.calls[1]?.[1]).toMatchObject({
    p_session_id: id,
    p_revision: 3,
    p_review_state: "pending_review",
  });
});
function awaitingValue() {
  let d = editorAction(base(), "fields");
  d = editorAction(
    d,
    "field",
    fields(d).findIndex((f) => f.attribute_code === "mma_current_max_a"),
  );
  stored.data = editorAction(editorAction(d, "process", 0), "new");
}
it.each([undefined, 110, 112])("ignores an unbound or old text reply (%s)", async (replyTo) => {
  awaitingValue();
  await technicalEditor(owner, chat, from, { text: "160", replyTo });
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["current"]);
});
it("accepts only a reply to the stored current prompt and saves using CAS", async () => {
  awaitingValue();
  await technicalEditor(owner, chat, from, { text: "160", replyTo: 111 });
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["current", "save"]);
  expect(stored.data.pending?.value).toBe(160);
  expect(stored.data.screen).toBe("sources");
});
it("resuming a value prompt binds the actual Telegram message ID without applying data", async () => {
  awaitingValue();
  await technicalEditor(owner, chat, from, { command: "/technical" });
  expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
    p_op: "prompt",
    p_prompt_message_id: 222,
    p_revision: 3,
  });
  expect(
    mocks.tg.mock.calls.find((c) => c[1].reply_markup?.force_reply === true)?.[1].reply_markup,
  ).toEqual({ force_reply: true });
});
it("a lost Telegram response leaves the draft recoverable and does not retry the question", async () => {
  awaitingValue();
  mocks.tg
    .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 222 } }))
    .mockRejectedValueOnce(new Error("PRIVATE provider URL token"));
  await technicalEditor(owner, chat, from, { command: "/technical" });
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["current"]);
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("PRIVATE");
  expect(stored.revision).toBe(3);
});
it("unknown database errors and payloads are never echoed", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE SQL details" } });
  await technicalEditor(owner, chat, from, { command: "/technical" });
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("PRIVATE");
});
it("keeps the ordinary dialog and explains how to resolve an editor conflict", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "EDITOR_ORDINARY_ACTIVE" } });
  await technicalEditor(owner, chat, from, { callback: "te:start:" + id });
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["start"]);
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("Текущий ввод сохранён");
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("/cancel");
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("EDITOR_ORDINARY_ACTIVE");
});
it("cancel asks confirmation before mutating a preview", async () => {
  stored.phase = "preview";
  await technicalEditor(owner, chat, from, { command: "/cancel" });
  expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual(["current"]);
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("cancel_now");
});
it("no active draft lets ordinary text reach the legacy editor", async () => {
  mocks.rpc.mockResolvedValue({ data: { ok: true, session: null }, error: null });
  expect(await technicalEditor(owner, chat, from, { text: "title" })).toBe(false);
  expect(mocks.tg).not.toHaveBeenCalled();
});
it("paginates families with stable absolute indices and Telegram-sized callbacks", async () => {
  stored.data = editorAction(base(), "families");
  const indices: number[] = [];
  for (let page = 0; page < Math.ceil(families.length / 8); page++) {
    mocks.tg.mockClear();
    await technicalEditor(owner, chat, from, {
      callback: "te:" + id + ":" + stored.revision + ":families:" + page,
    });
    const message = mocks.tg.mock.calls[0]?.[1];
    const buttons = (message.reply_markup.inline_keyboard as { callback_data: string }[][]).flat();
    const choices = buttons.filter((b) => b.callback_data.includes(":family:"));
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.length).toBeLessThanOrEqual(8);
    expect(message.text).toContain("Страница " + (page + 1));
    expect(buttons.some((b) => b.callback_data.endsWith(":families:" + (page + 1)))).toBe(
      page + 1 < Math.ceil(families.length / 8),
    );
    expect(buttons.some((b) => b.callback_data.endsWith(":families:" + (page - 1)))).toBe(page > 0);
    for (const button of buttons)
      expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
    indices.push(...choices.map((b) => Number(b.callback_data.split(":").at(-1))));
  }
  expect(indices).toEqual(families.map((_, i) => i));
  expect(stored.data.document).toEqual(base().document);
});
