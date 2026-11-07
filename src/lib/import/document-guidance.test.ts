import { expect, it } from "vitest";
import { documentGuidance } from "./document-guidance";
import {
  parseIntakeCallback,
  renderIntake,
  renderIntakeChecks,
  type IntakeView,
} from "./intake-view";

const id = "11111111-1111-4111-8111-111111111111";
const flags = [
  "HIDDEN_SHEET",
  "HIDDEN_ROWS",
  "MERGED_CELLS",
  "MERGED_CELLS_REVIEW",
  "FORMULA_NOT_EVALUATED",
  "FORMATTED_CELL_REVIEW",
  "MIXED_PDF_IMAGES_REQUIRE_VISUAL_REVIEW",
  "TEXT_LAYOUT_REVIEW",
  "UNSTRUCTURED_TEXT",
  "SKU_AND_PRICE_REQUIRE_REVIEW",
  "LINES_MAY_NOT_BE_PRODUCTS",
  "COLUMN_MAPPING_REVIEW",
  "FORMAT_REQUIRES_MANUAL_CONVERSION",
];
const doc: IntakeView = {
  ok: true,
  id,
  file_name: "Прайс.xlsx",
  state: "review",
  extraction: {
    tables: [
      { label: "Обычный", header: ["sku", "price"], rows: [["001", "10"]], warnings: [] },
      {
        label: "Скрытый",
        header: ["sku", "price"],
        rows: [["002", "=1+2"]],
        warnings: ["HIDDEN_SHEET", "FORMULA_NOT_EVALUATED", "FORMATTED_CELL_REVIEW"],
      },
    ],
    blocks: [],
    warnings: [],
    coverage: { complete: true },
  },
};

it("shows actionable table-only flags instead of losing them behind document coverage", () => {
  const home = renderIntake(doc);
  expect(home.text).toContain("сверка с оригиналом");
  const view = renderIntakeChecks(doc, 1);
  expect(view.text).toContain("Скрытый");
  expect(view.text).toContain("скрытый лист");
  expect(view.text).toContain("не вычислял результат");
  expect(view.text).toContain("ведущие нули");
  expect(view.text).toContain("Исправить поле");
  expect(renderIntakeChecks(doc, 0).text).not.toContain("Есть формулы");
  expect(view.rows.flat().map((b) => b.callback_data)).toContain(`di:table:${id}:1`);
  expect(view.rows.flat().map((b) => b.callback_data)).toContain(`di:original:${id}`);
  expect(view.text).not.toContain("FORMATTED_CELL_REVIEW");
});

it("keeps uncertainty and all explanations bounded without leaking unknown warning content", () => {
  const text = documentGuidance([...flags, ...flags, "PRIVATE_UNRECOGNIZED_FLAG"], {
    complete: false,
  });
  expect(text).toContain("не полностью");
  expect(text).toContain("дополнительные ограничения");
  expect(text).not.toContain("PRIVATE_UNRECOGNIZED_FLAG");
  expect(text.match(/Есть формулы/g)).toHaveLength(1);
  expect(Array.from(text).length).toBeLessThan(3200);
  const all = renderIntakeChecks(
    {
      ...doc,
      file_name: "Я".repeat(200),
      extraction: {
        ...doc.extraction!,
        warnings: flags,
        coverage: { complete: false },
        tables: [{ ...doc.extraction!.tables[1]!, label: "Я".repeat(200) }],
      },
    },
    0,
  );
  expect(Array.from(all.text).length).toBeLessThan(3500);
  expect(documentGuidance([], { complete: true, pages: 3, processed: 2 })).toContain(
    "не полностью",
  );
  expect(documentGuidance([])).toContain("полнота неизвестна");
  expect(documentGuidance(["MERGED_CELLS_REVIEW"], { complete: true })).not.toContain(
    "В таблице есть объединённые",
  );
});

it("preserves table identity, read-only buttons, missing-result recovery and page return", () => {
  const many = {
    ...doc,
    extraction: {
      ...doc.extraction!,
      tables: Array.from({ length: 100 }, (_, i) => ({
        ...doc.extraction!.tables[0]!,
        label: "Таблица " + i,
      })),
    },
  };
  const view = renderIntakeChecks(many, 99);
  expect(view.text).toContain("Таблица 100");
  expect(view.rows.flat().map((b) => b.callback_data)).toContain(`di:get:${id}:12`);
  for (const button of [...renderIntake(many, 12).rows.flat(), ...view.rows.flat()]) {
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    expect(parseIntakeCallback(button.callback_data)).not.toBeNull();
  }
  for (const cb of [`di:checks:${id}:-1`, `di:checks:${id}:100`, `di:checks:${id}:0:1`])
    expect(parseIntakeCallback(cb)).toBeNull();
  const missing = renderIntakeChecks(doc, 99);
  expect(missing.text).toContain("Таблица недоступна");
  expect(missing.rows.flat().some((b) => b.callback_data.startsWith("di:table:"))).toBe(false);
});

it("distinguishes XLS formula markers from preserved formula text and never trusts the cache", () => {
  const text = documentGuidance(
    [
      "XLS_FORMULA_VALUE_REQUIRED",
      "HIDDEN_COLUMNS",
      "XLS_NONCELL_CONTENT_REVIEW",
      "XLS_DATE_REVIEW",
    ],
    { complete: true },
  );
  expect(text).toContain("Вместо формул XLS");
  expect(text).toContain("Сохранённое число не используется");
  expect(text).not.toContain("сохранил их текст");
  expect(text).toContain("Макросы не запускались");
  expect(text).toContain("скрытые колонки");
  expect(text).toContain("Это не цена и не артикул");
  expect(text).not.toContain("дополнительные ограничения");
});
