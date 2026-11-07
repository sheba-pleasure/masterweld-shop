import { beforeEach, expect, it, vi } from "vitest";
import {
  renderSourceBlocks,
  renderSourceText,
  sourceLocation,
  SOURCE_PART_SIZE,
} from "./source-reader";
import { parseIntakeCallback, renderIntake, type IntakeView } from "./intake-view";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
import { showIntake } from "./intake.server";
const id = "10000000-0000-4000-8000-000000000001";
const member: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" };
function file(
  text = "MODEL-aB\nТок: 160 A\n https://example.invalid/manual <b>Источник</b>",
): IntakeView {
  return {
    ok: true,
    id,
    state: "review",
    file_name: "Паспорт.pdf",
    extraction: {
      tables: [],
      blocks: [{ locator: "page:3", page: 3, text, engine: "tesseract-rus-eng" }],
      warnings: [],
      coverage: { complete: false, pages: 5, processed: 3 },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: file(), error: null });
  mocks.tg.mockResolvedValue({});
});
it("preserves physical locators instead of using a list position as page number", () => {
  expect(sourceLocation(file().extraction!.blocks[0], 0)).toBe("Страница файла 3");
  expect(sourceLocation({ locator: "page:3", page: 4, text: "A" }, 0)).toContain("требует сверки");
  expect(sourceLocation({ locator: "unrecognized", text: "A" }, 4)).toContain(
    "Место в оригинале нужно уточнить",
  );
  expect(sourceLocation({ locator: "paragraph:7", text: "A" }, 0)).toBe("Абзац 7");
});
it("keeps every character and surrogate pair while paging a long source", () => {
  const raw = "  aB-007\r\n🧰\t".repeat(600) + "\nПоследняя строка\n ";
  const f = file(raw),
    before = JSON.stringify(f);
  const count = Math.ceil(Array.from(raw).length / SOURCE_PART_SIZE),
    pieces: string[] = [];
  for (let part = 0; part < count; part++) {
    const view = renderSourceText(f, 0, part);
    pieces.push(view.text.split("—— Текст источника ——\n")[1]!);
    expect(view.text.length).toBeLessThan(3500);
    expect(view.text).not.toMatch(/[\ud800-\udbff]$/);
    for (const b of view.rows.flat()) {
      expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
      expect(parseIntakeCallback(b.callback_data)).not.toBeNull();
    }
  }
  expect(pieces.join("")).toBe(raw);
  expect(JSON.stringify(f)).toBe(before);
});
it("paginates source blocks without losing empty or unknown-locator positions", () => {
  const f = file();
  f.extraction!.blocks = Array.from({ length: 19 }, (_, n) => ({
    locator: "page:" + (n + 1),
    text: n % 2 ? "" : "A",
  }));
  const view = renderSourceBlocks(f, 2);
  expect(view.text).toContain("3 из 3");
  expect(view.rows.flat().some((b) => b.callback_data === "di:read:" + id + ":18:0")).toBe(true);
  expect(view.rows.flat().filter((b) => b.callback_data.startsWith("di:read:"))).toHaveLength(3);
  expect(renderSourceText(f, 1).text).toContain("Текст этого фрагмента пуст");
});
it.each([-1, 999999, NaN, Infinity, 1.5])(
  "does not substitute a different block or part for %s",
  (value) => {
    expect(renderSourceText(file(), value).text).toContain("недоступен");
    expect(renderSourceText(file(), 0, value).text).toContain("недоступна");
    expect(renderSourceBlocks(file(), value).text).toContain("недоступна");
  },
);
it("shows OCR limitations and original access without approving or importing", () => {
  const view = renderSourceText(file(), 0);
  expect(view.text).toContain("3 из 5");
  expect(view.text).toContain("возможны ошибки");
  expect(view.text).toContain("ещё не подтверждённые характеристики");
  expect(view.rows.flat().some((b) => b.callback_data === "di:original:" + id)).toBe(true);
  expect(JSON.stringify(view.rows)).not.toMatch(/approve|ci:|apply|confirm/);
  const home = renderIntake(file());
  expect(home.text).toContain("Для паспорта без таблицы товаров это нормальный результат");
  expect(home.rows.flat().some((b) => b.callback_data === "di:blocks:" + id + ":0")).toBe(true);
});
it("empty/missing blocks explain how to open original or available tables", () => {
  const f = file();
  f.extraction!.blocks = [];
  expect(renderSourceBlocks(f).text).toContain("Отдельного распознанного текста нет");
  expect(renderSourceBlocks({ ok: true, id }).text).toContain(
    "Отдельного распознанного текста нет",
  );
});
it.each([
  "di:read:" + id + ":0",
  "di:read:" + id + ":-1:0",
  "di:read:" + id + ":1000000:0",
  "di:read:" + id + ":0:NaN",
  "di:blocks:" + id + ":0:0",
  "di:blocks:../../secret:0",
])("rejects malformed navigation: %s", (callback) => {
  expect(parseIntakeCallback(callback)).toBeNull();
});
it("reads the owned document once and sends plain text with preview links disabled", async () => {
  await showIntake(member, chat, "di:read:" + id + ":0:0");
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_document_intake", {
    p_actor: 101,
    p_op: "get",
    p_id: id,
    p_payload: { index: 0 },
  });
  expect(mocks.tg).toHaveBeenCalledOnce();
  const body = mocks.tg.mock.calls[0]![1];
  expect(body.text).toContain("MODEL-aB");
  expect(body.parse_mode).toBeUndefined();
  expect(body.link_preview_options).toEqual({ is_disabled: true });
});
it("rejects sellers, disabled accounts and another or group chat before storage", async () => {
  for (const [m, c] of [
    [{ ...member, role: "seller" as const }, chat],
    [{ ...member, active: false }, chat],
    [member, { id: 102, type: "private" }],
    [member, { id: 101, type: "group" }],
  ] as const)
    await showIntake(m, c, "di:blocks:" + id + ":0");
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it.each([
  { data: { ...file(), id: "20000000-0000-4000-8000-000000000002" }, error: null },
  { data: null, error: { message: "PRIVATE DOCUMENT DETAILS" } },
])("never substitutes another document or exposes failed read details", async (response) => {
  mocks.rpc.mockResolvedValue(response);
  await showIntake(member, chat, "di:read:" + id + ":0:0");
  expect(mocks.rpc).toHaveBeenCalledOnce();
  const sent = JSON.stringify(mocks.tg.mock.calls);
  expect(sent).toContain("Не удалось прочитать результат");
  expect(sent).not.toContain("MODEL-aB");
  expect(sent).not.toContain("PRIVATE DOCUMENT");
});
