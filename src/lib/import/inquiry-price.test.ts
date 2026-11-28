import { describe, expect, it } from "vitest";
import { parseImportCallback, renderImport, type ImportView } from "./catalog-view";

const id = "11111111-1111-4111-8111-111111111111";
const config: ImportView = {
  ok: true,
  id,
  file: "catalog.csv",
  state: "config",
  revision: 7,
  header: ["Артикул", "Название"],
  sample: ["001", "Аппарат"],
  mapping: {
    sku: 0,
    title: 1,
    brand: -1,
    price: -1,
    cost_price: -1,
    in_stock: -1,
    stock_qty: -1,
    category_slug: -1,
  },
  decimal: "comma",
  fileRows: 1,
  counts: { new: 1, update: 0, unchanged: 0, error: 0, excluded: 0 },
  page: 0,
  pages: 1,
  items: [],
};
describe("explicit inquiry pricing", () => {
  it("binds the chosen setting to the exact import and revision within Telegram size limits", () => {
    const view = renderImport({ ...config, inquiry_price: false });
    const button = view.rows.flat().find((b) => b.callback_data.startsWith("ci:ip:"));
    expect(button).toBeDefined();
    expect(new TextEncoder().encode(button!.callback_data).length).toBeLessThanOrEqual(64);
    expect(parseImportCallback(button!.callback_data)).toEqual({
      op: "inquiry_price",
      id,
      enabled: true,
      revision: 7,
    });
    const enabled = renderImport({ ...config, inquiry_price: true });
    expect(
      parseImportCallback(
        enabled.rows.flat().find((b) => b.callback_data.startsWith("ci:ip:"))!.callback_data,
      )?.enabled,
    ).toBe(false);
    expect(enabled.text).toContain("Цены существующих товаров при пустой ячейке сохранятся");
  });
  it("rejects malformed and unbound price settings", () => {
    for (const input of [
      `ci:ip:${id}:1`,
      `ci:ip:${id}:true:7`,
      `ci:ip:${id}:2:7`,
      `ci:ip:${id}:1:-1`,
      `ci:ip:${id}:1:7:extra`,
    ])
      expect(parseImportCallback(input)).toBeNull();
  });
  it("does not offer an unsupported setting on an older database", () => {
    expect(
      renderImport(config)
        .rows.flat()
        .some((b) => b.callback_data.startsWith("ci:ip:")),
    ).toBe(false);
  });
  it("makes a new unpriced draft explicit before confirmation", () => {
    const view = renderImport({
      ...config,
      state: "preview",
      inquiry_price: true,
      items: [
        {
          line: 2,
          sku: "001",
          kind: "new",
          errors: [],
          patch: { title: "Аппарат" },
          before_product: null,
          after_product: { title: "Аппарат", price: null },
          before_cost: null,
          after_cost: null,
        },
      ],
    });
    expect(view.text).toContain("Цена продажи: по запросу. Новая карточка останется черновиком.");
    expect(view.rows.flat().find((b) => b.callback_data.startsWith("ci:apply:"))).toBeDefined();
    const blocked = renderImport({
      ...config,
      state: "preview",
      inquiry_price: true,
      counts: { ...config.counts, error: 1 },
    });
    expect(blocked.rows.flat().some((b) => b.callback_data.startsWith("ci:apply:"))).toBe(false);
  });
});
