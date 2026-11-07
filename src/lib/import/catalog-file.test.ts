import { describe, expect, it } from "vitest";
import { parseCatalogFile, normalizeCatalogFile, FIELDS, CATALOG_FILE_BYTES } from "./catalog-file";
import { parseImportCallback, renderImport, importError, type ImportView } from "./catalog-view";
const bytes = (text: string) => new TextEncoder().encode(text);
describe("catalog CSV preparation", () => {
  it("maps explicit Russian headers, retains SKU zeroes, parses rubles and derives stock", () => {
    const file = parseCatalogFile(
      bytes("Артикул;Название;Цена;Количество;Статус\n001-A;Учебный товар;1250,50;3;published"),
    );
    const rows = normalizeCatalogFile(file, "comma");
    expect(rows).toEqual([
      {
        line: 2,
        sku: "001-A",
        values: { title: "Учебный товар", price: 1250.5, stock_qty: 3, in_stock: true },
        errors: [],
      },
    ]);
    expect(rows[0]?.values).not.toHaveProperty("status");
  });
  it("blank fields never erase existing values", () => {
    const file = parseCatalogFile(bytes("sku;title;price;brand\nA;;;"));
    expect(normalizeCatalogFile(file, "dot")[0]?.values).toEqual({});
  });
  it("ambiguous headers require manual selection; a column cannot serve two fields", () => {
    const file = parseCatalogFile(bytes("sku;цена;цена\nA;10;20"));
    expect(file.mapping.price).toBe(-1);
    file.mapping.price = 0;
    expect(() => normalizeCatalogFile(file, "comma")).toThrow("BAD_MAPPING");
  });
  it.each([
    ["sku;price\nA;1.23", "comma", "BAD_PRICE"],
    ["sku;price\nA;=1+2", "dot", "FORMULA"],
    ["sku;price\nA;=Формула XLS: введите проверенное значение", "dot", "FORMULA"],
    ["sku;price\n;10", "dot", "BAD_SKU"],
    ["sku;price\nA;0", "dot", "BAD_PRICE"],
    ["sku;price\nA;1.001", "dot", "BAD_PRICE"],
    ["sku;price;stock;qty\nA;10;нет;2", "dot", "STOCK_CONFLICT"],
    ["sku;price;title\nA;10", "dot", "ROW_WIDTH"],
  ] as const)("invalid row %s", (input, format, code) => {
    expect(normalizeCatalogFile(parseCatalogFile(bytes(input)), format)[0]?.errors).toContain(code);
  });
  it("preserves quoted delimiters, multiline text and record positions", () => {
    const file = parseCatalogFile(
      bytes('sku;title;price\nA;"Маска; учебная\nновая";10\n;;\nB;Вторая;20'),
    );
    const rows = normalizeCatalogFile(file, "dot");
    expect(rows.map((r) => r.line)).toEqual([2, 4]);
    expect(rows[0]?.values.title).toContain("Маска; учебная");
  });
  it("fails size, encoding and row bounds rather than truncating", () => {
    expect(() => parseCatalogFile(new Uint8Array(CATALOG_FILE_BYTES + 1))).toThrow(
      "FILE_TOO_LARGE",
    );
    expect(() => parseCatalogFile(new Uint8Array([0xff, 0xff]))).toThrow("UNSUPPORTED_ENCODING");
    expect(() =>
      parseCatalogFile(
        bytes("sku;price\n" + Array.from({ length: 5001 }, (_, i) => `A${i};10`).join("\n")),
      ),
    ).toThrow("TOO_MANY_ROWS");
  });
});
const id = "11111111-1111-4111-8111-111111111111";
const view: ImportView = {
  ok: true,
  id,
  file: "учебный.csv",
  state: "preview",
  revision: 9999999,
  header: Array.from({ length: 30 }, () => "Колонка"),
  sample: Array.from({ length: 30 }, () => "Пример"),
  mapping: Object.fromEntries(FIELDS.map((f, i) => [f, i])) as ImportView["mapping"],
  decimal: "comma",
  fileRows: 5000,
  counts: { new: 1, update: 2, unchanged: 0, error: 0, excluded: 1 },
  page: 1666,
  pages: 1667,
  items: Array.from({ length: 3 }, (_, i) => ({
    line: i + 2,
    sku: "SKU-" + i,
    kind: "update",
    errors: [],
    patch: {
      title: "Т".repeat(200),
      brand: "Б".repeat(100),
      price: 10000000,
      cost_price: 9999999,
      stock_qty: 1000000,
      in_stock: true,
      category_slug: "a".repeat(120),
    },
    before_product: { title: "Старое", price: 20, brand: "Бренд" },
    after_product: { title: "Т".repeat(200) },
    before_cost: { cost_price: 10 },
    after_cost: { cost_price: 9999999 },
  })),
};
describe("import confirmation screens", () => {
  it.each(["preview", "undo_preview"])(
    "explains identity consequences before %s confirmation",
    (state) => {
      const result = renderImport({ ...view, state, items: [] });
      expect(result.text).toContain("снимает прежние подтверждённые характеристики");
      expect(result.text).toContain("не подтверждает характеристики автоматически");
    },
  );
  it.each(["config", "preview", "applied", "undo_preview", "undone", "canceled"])(
    "%s fits Telegram",
    (state) => {
      const result = renderImport({ ...view, state });
      expect(result.text.length).toBeLessThan(4000);
      for (const b of result.rows.flat()) {
        expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
        expect(parseImportCallback(b.callback_data)).not.toBeNull();
      }
    },
  );
  it("column choice callbacks carry expected configuration revision", () => {
    const result = renderImport(view, 4);
    for (const b of result.rows.flat()) {
      expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
      expect(parseImportCallback(b.callback_data)).not.toBeNull();
    }
  });
  it("errors block apply and undo always has separate confirmation", () => {
    expect(
      renderImport({ ...view, counts: { ...view.counts, error: 1 } })
        .rows.flat()
        .some((b) => b.callback_data.startsWith("ci:apply:")),
    ).toBe(false);
    const applied = renderImport({ ...view, state: "applied" });
    expect(applied.rows.flat().some((b) => b.callback_data.startsWith("ci:undo_preview:"))).toBe(
      true,
    );
    expect(applied.rows.flat().some((b) => b.callback_data.startsWith("ci:undo:"))).toBe(false);
  });
  it.each(["ci:map:bad:1:2:3", `ci:field:${id}:9`, `ci:apply:${id}`, `ci:get:${id}:99999`])(
    "malformed callback %s",
    (s) => expect(parseImportCallback(s)).toBeNull(),
  );
  it("never leaks unclassified database error details or claims a failed write", () => {
    expect(importError("SECRET")).not.toContain("SECRET");
    expect(importError("SECRET")).toContain("Результат не подтверждён");
  });
});
