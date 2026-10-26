import { describe, expect, it } from "vitest";
import { parsePriceFile, type ParseResult, type ParsedRow } from "./price-csv";
import {
  applyGate,
  BLOCK_AMBIGUOUS_IN_CATALOG,
  BLOCK_DUPLICATE_IN_PRICE,
  canAutoApply,
  checkApplyConflict,
  checkRollbackConflict,
  CRITICAL_PRICE_CHANGE,
  diffPriceImport,
  renderDiffPreview,
  sanitizeForRole,
  WARN_PRICE_CHANGE,
  WARN_QTY_WITHOUT_STOCK_CONFIRM,
  WARN_SALE_BELOW_COST,
  type CatalogProduct,
  type DiffOptions,
  type DiffRow,
} from "./price-diff";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Искусственный каталог — выдуманные товары, не похожие на реальные.
const CATALOG: CatalogProduct[] = [
  {
    id: "p-1",
    sku: "TEST-SHIM-01",
    title: "Тестовый шлифдиск ЗХ-100",
    price: 1000,
    in_stock: true,
    stock_qty: 5,
    status: "published",
  },
  {
    id: "p-2",
    sku: "TEST-CUT-02",
    title: "Тестовый отрезной круг ТК-200",
    price: 349,
    in_stock: true,
    stock_qty: 40,
    status: "published",
  },
  {
    id: "p-3",
    sku: "TEST-MASK-03",
    title: "Тестовый защитный щиток ТЩ-5",
    price: 2450,
    in_stock: true,
    stock_qty: 0,
    status: "published",
  },
  {
    id: "p-4",
    sku: "TEST-ROD-04",
    title: "Тестовый электрод ТЭ-3",
    price: 120.25,
    in_stock: false,
    stock_qty: null,
    status: "draft",
  },
  // Известный класс проблемы: дубль SKU в каталоге — только ручная проверка.
  {
    id: "p-5",
    sku: "TEST-DUP-02",
    title: "Тестовый дубль А",
    price: 300,
    in_stock: true,
    stock_qty: 1,
    status: "published",
  },
  {
    id: "p-6",
    sku: "TEST-DUP-02",
    title: "Тестовый дубль Б",
    price: 310,
    in_stock: true,
    stock_qty: 2,
    status: "published",
  },
];

const baseOpts = (over: Partial<DiffOptions> = {}): DiffOptions => ({
  fields: new Set(["price"]),
  confirmQty: false,
  includeCosts: false,
  ...over,
});

const parse = (csv: string, format: "dot" | "comma" = "comma"): ParseResult =>
  parsePriceFile(enc(csv), { decimalFormat: format });

describe("diffPriceImport: сопоставление", () => {
  it("matched/unmatched/unchanged/proposed считаются корректно", () => {
    const parsed = parse(
      "sku;price\nTEST-SHIM-01;1000\nTEST-CUT-02;349\nTEST-MASK-03;2500\nTEST-NO-99;500\n",
    );
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    expect(diff.summary.matched).toBe(3);
    expect(diff.summary.unmatched).toBe(1);
    expect(diff.summary.unchanged).toBe(2);
    expect(diff.summary.proposed).toBe(1);
    expect(diff.unmatchedSkus).toEqual(["TEST-NO-99"]);
    expect(diff.rows[0]!.sku).toBe("TEST-MASK-03");
    expect(diff.rows[0]!.oldValue).toBe(2450);
    expect(diff.rows[0]!.newValue).toBe(2500);
  });

  it("дубль SKU в прайсе блокирует автоматическое применение целиком", () => {
    const parsed = parse("sku;price\nTEST-DUP-01;100\nTEST-DUP-01;200\nTEST-SHIM-01;1100\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    expect(diff.blockers.some((b) => b.startsWith(BLOCK_DUPLICATE_IN_PRICE))).toBe(true);
    expect(applyGate(true, diff).allowed).toBe(false);
    // Строки дубля вообще не сопоставляются — никакого случайного выбора.
    expect(diff.rows.find((r) => r.sku === "TEST-DUP-01")).toBeUndefined();
  });

  it("дубль SKU в каталоге — ambiguous, manual-review, блокирует автоприменение", () => {
    const parsed = parse("sku;price\nTEST-DUP-02;400\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    expect(diff.summary.ambiguous).toBe(1);
    expect(diff.ambiguousSkus).toEqual(["TEST-DUP-02"]);
    expect(diff.blockers.some((b) => b.startsWith(BLOCK_AMBIGUOUS_IN_CATALOG))).toBe(true);
    expect(diff.rows).toHaveLength(0);
  });

  it("invalid-строки парсера блокируют автоприменение и не сопоставляются", () => {
    const parsed = parse("sku;price\n;100\nTEST-SHIM-01;1100\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    expect(diff.summary.invalid).toBe(1);
    expect(diff.blockers.length).toBeGreaterThan(0);
    expect(diff.summary.matched).toBe(1);
  });

  it("стабильность сравнения цен: 120.25 vs 120.25 — unchanged (без float-артефактов)", () => {
    const parsed = parse("sku;price\nTEST-ROD-04;120.25\n", "dot");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    expect(diff.summary.unchanged).toBe(1);
    expect(diff.rows).toHaveLength(0);
  });
});

describe("diffPriceImport: только явно переданные поля", () => {
  it("без fields:stock наличие не меняется, даже если в прайсе есть", () => {
    const parsed = parse("sku;price;stock\nTEST-MASK-03;2450;нет\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts({ fields: new Set(["price"]) }));
    expect(diff.rows).toHaveLength(0);
    expect(diff.summary.unchanged).toBe(1);
  });

  it("с fields:stock наличие меняется", () => {
    const parsed = parse("sku;price;stock\nTEST-MASK-03;2450;нет\n");
    const diff = diffPriceImport(
      parsed,
      CATALOG,
      null,
      baseOpts({ fields: new Set(["price", "stock"]) }),
    );
    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0]!.field).toBe("stock");
    expect(diff.rows[0]!.oldValue).toBe(true);
    expect(diff.rows[0]!.newValue).toBe(false);
  });

  it("qty без confirmQty — предупреждение, значение НЕ применяется", () => {
    const parsed = parse("sku;qty\nTEST-SHIM-01;50\n");
    const diff = diffPriceImport(
      parsed,
      CATALOG,
      null,
      baseOpts({ fields: new Set(["qty"]), confirmQty: false }),
    );
    expect(diff.rows).toHaveLength(0);
    expect(diff.warnings.some((w) => w.startsWith(WARN_QTY_WITHOUT_STOCK_CONFIRM))).toBe(true);
  });

  it("qty с confirmQty — применяется как stock_qty", () => {
    const parsed = parse("sku;qty\nTEST-SHIM-01;50\n");
    const diff = diffPriceImport(
      parsed,
      CATALOG,
      null,
      baseOpts({ fields: new Set(["qty"]), confirmQty: true }),
    );
    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0]!.field).toBe("qty");
    expect(diff.rows[0]!.oldValue).toBe(5);
    expect(diff.rows[0]!.newValue).toBe(50);
  });
});

describe("diffPriceImport: закупочные цены защищены", () => {
  const costs = new Map([["p-1", 800]]);

  it("без includeCosts cost-строки не попадают в результат вообще", () => {
    const parsed = parse("sku;price;cost\nTEST-SHIM-01;1100;900\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    expect(diff.costRows).toHaveLength(0);
    expect(JSON.stringify(diff)).not.toContain("900");
  });

  it("с includeCosts cost-изменение в costRows отдельно от витринных строк", () => {
    const parsed = parse("sku;price;cost\nTEST-SHIM-01;1100;900\n");
    const diff = diffPriceImport(
      parsed,
      CATALOG,
      costs,
      baseOpts({ fields: new Set(["price", "cost"]), includeCosts: true }),
    );
    expect(diff.rows.some((r) => r.field === "price")).toBe(true);
    expect(diff.costRows).toHaveLength(1);
    expect(diff.costRows[0]!.oldValue).toBe(800);
    expect(diff.costRows[0]!.newValue).toBe(900);
  });

  it("цена продажи ниже закупки — предупреждение SALE_BELOW_COST", () => {
    const parsed = parse("sku;price;cost\nTEST-SHIM-01;500;800\n");
    const diff = diffPriceImport(
      parsed,
      CATALOG,
      costs,
      baseOpts({ fields: new Set(["price", "cost"]), includeCosts: true }),
    );
    expect(diff.warnings.some((w) => w.startsWith(WARN_SALE_BELOW_COST))).toBe(true);
  });

  it("sanitizeForRole вырезает cost-строки и cost-предупреждения для продавца", () => {
    const parsed = parse("sku;price;cost\nTEST-SHIM-01;500;800\n");
    const diff = diffPriceImport(
      parsed,
      CATALOG,
      costs,
      baseOpts({ fields: new Set(["price", "cost"]), includeCosts: true }),
    );
    const safe = sanitizeForRole(diff, false);
    expect(safe.costRows).toHaveLength(0);
    expect(safe.warnings.some((w) => w.includes("800"))).toBe(false);
    const text = renderDiffPreview(diff, { canViewCosts: false });
    expect(text).not.toContain("закупка");
    expect(text).not.toContain("800");
  });
});

describe("diffPriceImport: предупреждения об изменении цены", () => {
  it("рост >20% — WARN_PRICE_CHANGE, >30% — CRITICAL", () => {
    const parsed = parse("sku;price\nTEST-SHIM-01;1250\nTEST-CUT-02;500\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    const shim = diff.rows.find((r) => r.sku === "TEST-SHIM-01")!;
    const cut = diff.rows.find((r) => r.sku === "TEST-CUT-02")!;
    expect(shim.percentChange).toBe(25);
    expect(shim.warnings).toContain(WARN_PRICE_CHANGE);
    expect(cut.percentChange).toBe(43.27);
    expect(cut.warnings).toContain(CRITICAL_PRICE_CHANGE);
  });

  it("снижение >30% — тоже критично", () => {
    const parsed = parse("sku;price\nTEST-SHIM-01;600\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    expect(diff.rows[0]!.warnings).toContain(CRITICAL_PRICE_CHANGE);
    expect(diff.rows[0]!.percentChange).toBe(-40);
  });
});

describe("гейты применения и отката", () => {
  const parsed = parse("sku;price\nTEST-SHIM-01;1100\n");
  const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());

  it("автоприменение запрещено всегда; без подтверждения — отказ", () => {
    expect(canAutoApply()).toBe(false);
    expect(applyGate(false, diff)).toEqual({ allowed: false, reason: "NO_CONFIRMATION" });
  });

  it("с подтверждением и без блокеров — разрешено", () => {
    expect(applyGate(true, diff)).toEqual({ allowed: true });
  });

  it("нечего применять — отказ", () => {
    const noop = diffPriceImport(
      parse("sku;price\nTEST-SHIM-01;1000\n"),
      CATALOG,
      null,
      baseOpts(),
    );
    expect(applyGate(true, noop)).toEqual({ allowed: false, reason: "NOTHING_TO_APPLY" });
  });

  const row: DiffRow = {
    sku: "TEST-SHIM-01",
    productId: "p-1",
    title: "Тестовый шлифдиск ЗХ-100",
    field: "price",
    oldValue: 1000,
    newValue: 1100,
    percentChange: 10,
    warnings: [],
  };

  it("optimistic concurrency: текущее значение изменилось — конфликт применения", () => {
    expect(checkApplyConflict(row, 1000)).toBe(false);
    expect(checkApplyConflict(row, 1050)).toBe(true);
  });

  it("откат конфликтует, если текущее значение не равно «стало» (1000→1100→1200)", () => {
    expect(checkRollbackConflict(row, 1100)).toBe(false);
    expect(checkRollbackConflict(row, 1200)).toBe(true);
  });

  it("сравнение цен в копейках: 1100.001 не считается конфликтом", () => {
    expect(checkApplyConflict(row, 1000.0001)).toBe(false);
  });
});

describe("renderDiffPreview", () => {
  it("честная сводка: ничего не изменено, счётчики и первые строки", () => {
    const parsed = parse("sku;price\nTEST-SHIM-01;1100\nTEST-NO-99;100\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    const text = renderDiffPreview(diff, { canViewCosts: true });
    expect(text).toContain("ничего не изменено");
    expect(text).toContain("TEST-SHIM-01");
    expect(text).toContain("1000 ₽ → 1100 ₽ (+10%)");
    expect(text).toContain("не найдено: 1");
  });

  it("блокеры показываются явно", () => {
    const parsed = parse("sku;price\nTEST-DUP-01;1\nTEST-DUP-01;2\n");
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    const text = renderDiffPreview(diff, { canViewCosts: true });
    expect(text).toContain("заблокировано");
  });
});

describe("ParsedRow без SKU в diff не попадает", () => {
  it("защита от сопоставления по названию: diff работает только по sku", () => {
    const rogue: ParsedRow = {
      line: 2,
      sku: null,
      salePrice: 999,
      costPrice: null,
      stock: null,
      qty: null,
      supplierName: null,
      sourceKey: null,
      errors: ["SKU_REQUIRED"],
    };
    const parsed: ParseResult = {
      ok: true,
      rows: [],
      invalidRows: [rogue],
      warnings: [],
      columns: { sku: 0, sale_price: 1 },
    };
    const diff = diffPriceImport(parsed, CATALOG, null, baseOpts());
    expect(diff.rows).toHaveLength(0);
    expect(diff.summary.invalid).toBe(1);
  });
});
