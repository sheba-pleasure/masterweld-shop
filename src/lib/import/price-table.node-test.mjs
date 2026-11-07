import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePriceTable } from "./price-table.ts";
import { normalizedTableToParseResult } from "./price-table-adapter.ts";
import { diffPriceImport, applyGate } from "./price-diff.ts";

const options = { skuColumn: 0, priceColumn: 1, firstDataRow: 1,
  priceKind: "purchase", markupBasisPoints: 2500, decimalSeparator: "," };

test("explicit purchase prices and markup are calculated in kopecks", () => {
  const result = normalizePriceTable([["Артикул", "Цена"], ["ABC-1", "1 234,56"], ["B", "0,01"]], options);
  assert.deepEqual(result.accepted, [
    { sourceRow: 2, sku: "ABC-1", purchaseKopecks: 123456, retailKopecks: 154320 },
    { sourceRow: 3, sku: "B", purchaseKopecks: 1, retailKopecks: 1 },
  ]);
});

test("retail prices never become purchase costs", () => {
  const { accepted } = normalizePriceTable([["sku", "price"], ["X", 12.34]],
    { ...options, priceKind: "retail", markupBasisPoints: undefined });
  assert.equal(accepted[0].purchaseKopecks, null);
  assert.equal(accepted[0].retailKopecks, 1234);
});

test("reject formulas, numeric SKU, missing and ambiguous prices", () => {
  const { rejected } = normalizePriceTable([["sku", "price"], ["X", "=2+2"], [123, "20"],
    ["Y", "1,200"], ["Z", ""], ["=A1", "5"], ["Q", "10000001"]], options);
  assert.deepEqual(rejected.map((r) => r.code),
    ["FORMULA", "INVALID_SKU", "INVALID_PRICE", "MISSING_PRICE", "FORMULA", "PRICE_LIMIT"]);
});

test("requires explicit markup and rejects reused column", () => {
  assert.throws(() => normalizePriceTable([["x"], ["y"]], { ...options, markupBasisPoints: undefined }), /MARKUP_REQUIRED/);
  assert.throws(() => normalizePriceTable([["x"], ["y"]], { ...options, priceColumn: 0 }), /INVALID_OPTIONS/);
});

test("existing diff blocks application for rejected and duplicate rows", () => {
  const table = normalizePriceTable([["sku", "price"], ["A", "10"], ["A", "20"], ["B", "=1"]], options);
  const parsed = normalizedTableToParseResult(table);
  const diff = diffPriceImport(parsed,
    [{ id: "1", sku: "A", title: "A", price: 1, in_stock: true, stock_qty: null, status: "published" }],
    null, { fields: new Set(["price"]), confirmQty: false, includeCosts: false });
  assert.equal(diff.summary.invalid, 1);
  assert.ok(diff.blockers.some((blocker) => blocker.startsWith("DUPLICATE_SKU_IN_PRICE")));
  assert.equal(applyGate(true, diff).allowed, false);
});

test("tier markup uses purchase price and inclusive thresholds", () => {
  const tiers = [
    { upToKopecks: 100000, markupBasisPoints: 5000 },
    { upToKopecks: 1000000, markupBasisPoints: 3000 },
    { upToKopecks: null, markupBasisPoints: 1500 },
  ];
  const result = normalizePriceTable([["sku", "price"], ["A", "1000"], ["B", "1000,01"],
    ["C", "10000"], ["D", "10000,01"]], { ...options, markupBasisPoints: undefined, markupTiers: tiers });
  assert.deepEqual(result.accepted.map((row) => row.retailKopecks), [150000, 130001, 1300000, 1150001]);
});

test("invalid or conflicting tiers fail closed", () => {
  const table = [["sku", "price"], ["A", "10"]];
  for (const tiers of [
    [],
    [{ upToKopecks: 100, markupBasisPoints: 5000 }],
    [{ upToKopecks: 100, markupBasisPoints: 1000 }, { upToKopecks: null, markupBasisPoints: 2000 }],
    [{ upToKopecks: null, markupBasisPoints: 1000 }, { upToKopecks: null, markupBasisPoints: 500 }],
  ]) {
    assert.throws(() => normalizePriceTable(table, { ...options, markupBasisPoints: undefined, markupTiers: tiers }), /INVALID_MARKUP_TIERS/);
  }
  assert.throws(() => normalizePriceTable(table, { ...options, markupTiers: [{ upToKopecks: null, markupBasisPoints: 1000 }] }), /MARKUP_REQUIRED/);
  assert.throws(() => normalizePriceTable(table, { ...options, priceKind: "retail", markupBasisPoints: undefined, markupTiers: [] }), /UNEXPECTED_MARKUP/);
});

test("rounds half kopeck up and rejects markup over price limit", () => {
  const { accepted, rejected } = normalizePriceTable([["sku", "price"], ["A", "0,02"], ["B", "10000000"]],
    { ...options, markupBasisPoints: 2500 });
  assert.equal(accepted[0].retailKopecks, 3);
  assert.equal(rejected[0].code, "PRICE_LIMIT");
});
