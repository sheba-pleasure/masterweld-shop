import { beforeEach, expect, it, vi } from "vitest";
import { parseIntakeCallback, renderIntake } from "./intake-view";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn(), download: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
vi.mock("./telegram-file.server", () => ({ downloadIntakeDocument: mocks.download }));
import { receiveIntakeDocument, showIntake, enrollSellers } from "./intake.server";
const admin: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({
    data: {
      ok: true,
      id: "11111111-1111-4111-8111-111111111111",
      state: "queued",
      file_name: "a.pdf",
    },
    error: null,
  });
  mocks.download.mockResolvedValue(new TextEncoder().encode("original"));
  mocks.tg.mockResolvedValue({});
});
it("denies documents and enrollment before storage/download for sellers, inactive and forged actors", async () => {
  for (const m of [
    { ...admin, role: "seller" as const },
    { ...admin, active: false },
  ]) {
    await receiveIntakeDocument(m, chat, { file_name: "a.pdf" });
    await showIntake(m, chat);
    await enrollSellers(m, chat, ["201"], "request");
  }
  await receiveIntakeDocument(admin, { id: 102, type: "private" }, { file_name: "a.pdf" });
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});
it("reads table guidance without creating reviews and recovers a failed read without guessing", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  mocks.rpc.mockResolvedValue({
    data: {
      ok: true,
      id,
      state: "review",
      file_name: "Прайс.xlsx",
      extraction: {
        tables: [
          {
            label: "Лист",
            header: ["sku", "price"],
            rows: [["A", "=1+2"]],
            warnings: ["FORMULA_NOT_EVALUATED"],
          },
        ],
        blocks: [],
        warnings: [],
        coverage: { complete: true },
      },
    },
    error: null,
  });
  await showIntake(admin, chat, `di:checks:${id}:0`);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_document_intake", {
    p_actor: 101,
    p_op: "get",
    p_id: id,
    p_payload: { index: 0 },
  });
  expect(mocks.tg.mock.calls[0]![1].text).toContain("не вычислял результат");
  expect(mocks.download).not.toHaveBeenCalled();
  mocks.rpc.mockClear();
  for (const [m, c] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { id: 102, type: "private" }],
    [admin, { ...chat, type: "group" }],
  ] as const)
    await showIntake(m, c, `di:checks:${id}:0`);
  expect(mocks.rpc).not.toHaveBeenCalled();
  mocks.rpc.mockRejectedValue(new Error("private warning details"));
  mocks.tg.mockClear();
  await showIntake(admin, chat, `di:checks:${id}:0`);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg.mock.calls[0]![1].text).toContain("Не удалось прочитать");
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("private warning details");
});

it("uploads original only and does not publish or apply", async () => {
  await receiveIntakeDocument(admin, chat, { file_name: "a.pdf" });
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_document_intake", {
    p_actor: 101,
    p_op: "upload",
    p_payload: { file_name: "a.pdf", base64: "b3JpZ2luYWw=" },
  });
  expect(mocks.tg.mock.calls[0]![1].text).toContain("Оригинал");
});
it("shows recovery after unknown upload without replay", async () => {
  mocks.rpc.mockRejectedValue(new Error("private secret"));
  await receiveIntakeDocument(admin, chat, { file_name: "a.pdf" });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg.mock.calls[0]![1].text).toContain("/documents");
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("private secret");
});
it("requires a read-only confirmation before stopping, including buttons from older messages", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const state of ["queued", "extracting"]) {
    mocks.rpc.mockClear();
    mocks.tg.mockClear();
    mocks.rpc.mockResolvedValue({
      data: { ok: true, id, state, file_name: "Прайс.xlsx" },
      error: null,
    });
    const initial = renderIntake({ ok: true, id, state });
    const open = initial.rows.flat().find((b) => b.callback_data === `di:cancel:${id}`)!;
    await showIntake(admin, chat, open.callback_data);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_document_intake", {
      p_actor: 101,
      p_op: "get",
      p_id: id,
      p_payload: {},
    });
    const body = mocks.tg.mock.calls.at(-1)![1];
    expect(body.text).toContain("Прайс.xlsx");
    expect(body.text).toContain("Обработка пока продолжается");
    expect(body.text).toContain("не запустит его заново");
    const buttons = body.reply_markup.inline_keyboard.flat();
    const back = buttons.find(
      (b: { callback_data: string }) => b.callback_data === `di:get:${id}`,
    )!;
    await showIntake(admin, chat, back.callback_data);
    expect(mocks.rpc.mock.calls.map(([, args]) => args.p_op)).toEqual(["get", "get"]);

    const confirm = buttons.find(
      (b: { callback_data: string }) => b.callback_data === `di:stop:${id}`,
    )!;
    mocks.rpc.mockResolvedValue({ data: { ok: true, id, state: "canceled" }, error: null });
    await showIntake(admin, chat, confirm.callback_data);
    expect(mocks.rpc.mock.calls.map(([, args]) => args.p_op)).toEqual(["get", "get", "cancel"]);
    const stopped = mocks.tg.mock.calls.at(-1)![1];
    expect(stopped.text).toContain("Обработка остановлена");
    expect(stopped.text).toContain("Оригинал сохранён");
    expect(
      stopped.reply_markup.inline_keyboard
        .flat()
        .some((b: { callback_data: string }) => /di:(cancel|stop):/.test(b.callback_data)),
    ).toBe(false);
  }
});

it("shows actual completed state when a worker wins the cancellation race", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const state of ["review", "failed", "canceled"]) {
    mocks.rpc.mockResolvedValue({ data: { ok: true, id, state }, error: null });
    mocks.rpc.mockClear();
    mocks.tg.mockClear();
    await showIntake(admin, chat, `di:cancel:${id}`);
    expect(mocks.rpc.mock.calls[0]![1].p_op).toBe("get");
    const question = mocks.tg.mock.calls.at(-1)![1];
    expect(question.text).toContain("Дополнительная отмена не требуется");
    expect(JSON.stringify(question.reply_markup)).not.toContain("di:stop:");
    await showIntake(admin, chat, `di:stop:${id}`);
    const result = mocks.tg.mock.calls.at(-1)![1];
    expect(result.text).toContain(
      state === "review"
        ? "Нужна проверка"
        : state === "failed"
          ? "Обработка остановлена"
          : "Отменено",
    );
    if (state === "review") expect(result.text).not.toContain("Обработка остановлена");
  }
});

it("recovers an uncertain stop by reading saved state without replaying the cancellation", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  mocks.rpc.mockRejectedValueOnce(new Error("private database response"));
  await showIntake(admin, chat, `di:stop:${id}`);
  expect(mocks.rpc.mock.calls.map(([, args]) => args.p_op)).toEqual(["cancel"]);
  const body = mocks.tg.mock.calls.at(-1)![1];
  expect(body.text).toContain("Результат остановки пока неизвестен");
  expect(JSON.stringify(body)).not.toContain("private database response");
  const recovery = body.reply_markup.inline_keyboard.flat();
  expect(recovery.map((b: { callback_data: string }) => b.callback_data)).toEqual([
    `di:get:${id}`,
    "di:home",
  ]);
  mocks.rpc.mockResolvedValue({ data: { ok: true, id, state: "canceled" }, error: null });
  await showIntake(admin, chat, recovery[0].callback_data);
  expect(mocks.rpc.mock.calls.map(([, args]) => args.p_op)).toEqual(["cancel", "get"]);
  expect(mocks.tg.mock.calls.at(-1)![1].text).toContain("Обработка остановлена");
});

it("never offers cancellation based on a response for another document", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  mocks.rpc.mockResolvedValue({
    data: {
      ok: true,
      id: "22222222-2222-4222-8222-222222222222",
      state: "queued",
      file_name: "Чужое имя",
    },
    error: null,
  });
  for (const op of ["cancel", "stop"]) await showIntake(admin, chat, `di:${op}:${id}`);
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("Чужое имя");
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("di:stop:");
});

it("checks permissions and actual private sender before either cancellation step", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const [m, c] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { ...chat, id: 102 }],
    [admin, { ...chat, type: "group" }],
  ] as const) {
    for (const op of ["cancel", "stop"]) await showIntake(m, c, `di:${op}:${id}`);
  }
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});

it("enrolls only requested sellers with stable request key", async () => {
  await enrollSellers(admin, chat, ["201", "202"], "stable-request");
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_enroll_sellers", {
    p_actor: 101,
    p_request_key: "stable-request",
    p_ids: [201, 202],
  });
});
it("rejects malformed IDs and callback injection", async () => {
  await enrollSellers(admin, chat, ["-1", "1.5"], "request");
  expect(mocks.rpc).not.toHaveBeenCalled();
  for (const value of [
    "di:get:../../secret",
    "di:table:11111111-1111-4111-8111-111111111111:-1",
    "di:approve:all",
  ])
    expect(parseIntakeCallback(value)).toBeNull();
});
it("paginates large extracted documents without losing table identities", () => {
  const view = renderIntake(
    {
      ok: true,
      id: "11111111-1111-4111-8111-111111111111",
      state: "review",
      extraction: {
        tables: Array.from({ length: 100 }, (_, i) => ({
          label: String(i),
          header: ["sku", "price"],
          rows: [["A", "10"]],
        })),
        blocks: [],
        warnings: [],
        coverage: { complete: true },
      },
    },
    12,
  );
  const buttons = view.rows.flat();
  expect(buttons.length).toBeLessThan(20);
  expect(buttons.some((b) => b.callback_data.endsWith(":99"))).toBe(true);
  expect(view.text).toContain("13 из 13");
  expect(parseIntakeCallback("di:get:11111111-1111-4111-8111-111111111111:12")?.page).toBe(12);
});
it("review UI exposes missing coverage and no automatic publication", () => {
  const view = renderIntake({
    ok: true,
    id: "11111111-1111-4111-8111-111111111111",
    state: "review",
    extraction: {
      tables: [{ label: "Страница 1", header: ["sku", "price"], rows: [["", ""]] }],
      blocks: [],
      warnings: ["OCR_REVIEW"],
      coverage: { complete: false, pages: 2, processed: 1 },
    },
  });
  expect(view.text).toContain("1 из 2");
  expect(view.text).toContain("сверка с оригиналом");
  expect(view.rows.flat().some((b) => b.callback_data.startsWith("di:table:"))).toBe(true);
  expect(JSON.stringify(view)).not.toContain("ci:apply");
});

it("gives an actionable empty-result path without offering nonexistent tables", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const [warning, explanation] of [
    ["XLS_PASSWORD_REQUIRED", "защищена паролем"],
    ["XLS_DAMAGED", "Книгу XLS не удалось прочитать"],
    ["XLS_VERSION_REVIEW", "слишком старый формат"],
    ["HEADER_REVIEW", "названия колонок"],
    ["TABLE_LIMIT", "Разделите его на части"],
    ["FORMAT_REQUIRES_MANUAL_CONVERSION", "Этот формат пока не распознаётся"],
    ["UNKNOWN_INTERNAL_DETAIL", "Не удалось выделить строки товаров"],
  ]) {
    const view = renderIntake({
      ok: true,
      id,
      state: "review",
      file_name: "Прайс.xls",
      extraction: { tables: [], blocks: [], warnings: [warning!], coverage: { complete: false } },
    });
    expect(view.text).toContain(explanation);
    expect(view.text).toContain("Таблиц для проверки пока нет");
    expect(view.text).toContain("тех же байтов вернёт прежний результат");
    expect(view.text).not.toContain("Выберите таблицу");
    expect(view.text).not.toContain("UNKNOWN_INTERNAL_DETAIL");
    expect(view.rows.flat().some((b) => b.callback_data === `di:original:${id}`)).toBe(true);
    expect(view.rows.flat().some((b) => b.callback_data.startsWith("di:table:"))).toBe(false);
  }
});

it("delivers complete XLS guidance within the Telegram message limit", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const warnings = [
    "HIDDEN_SHEET",
    "HIDDEN_ROWS",
    "HIDDEN_COLUMNS",
    "MERGED_CELLS",
    "MERGED_CELLS_REVIEW",
    "FORMULA_NOT_EVALUATED",
    "XLS_FORMULA_VALUE_REQUIRED",
    "XLS_DATE_REVIEW",
    "XLS_CELL_ERROR_REVIEW",
    "XLS_NONCELL_CONTENT_REVIEW",
    "FORMATTED_CELL_REVIEW",
    "MIXED_PDF_IMAGES_REQUIRE_VISUAL_REVIEW",
    "TEXT_LAYOUT_REVIEW",
    "UNSTRUCTURED_TEXT",
    "COLUMN_MAPPING_REVIEW",
    "FORMAT_REQUIRES_MANUAL_CONVERSION",
    "PRIVATE_UNRECOGNIZED_FLAG",
  ];
  const data = {
    ok: true as const,
    id,
    state: "review",
    file_name: "Я".repeat(200),
    extraction: {
      tables: [{ label: "Я".repeat(200), header: ["sku", "price"], rows: [["A", "10"]], warnings }],
      blocks: [],
      warnings: [],
      coverage: { complete: false },
    },
  };
  mocks.rpc.mockResolvedValue({ data, error: null });
  await showIntake(admin, chat, `di:checks:${id}:0`);
  const { renderIntakeChecks } = await import("./intake-view");
  const expected = renderIntakeChecks(data, 0);
  const bodies = mocks.tg.mock.calls.map(([, body]) => body);
  expect(bodies).toHaveLength(1);
  expect(bodies.map((b) => b.text).join("")).toBe(expected.text);
  expect(bodies.every((b) => Array.from(b.text).length <= 3500)).toBe(true);
  expect(bodies.slice(0, -1).every((b) => b.reply_markup === undefined)).toBe(true);
  expect(bodies.at(-1).reply_markup.inline_keyboard).toEqual(expected.rows);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
