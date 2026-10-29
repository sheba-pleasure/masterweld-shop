import type { ParseResult, ParsedRow } from "./price-csv";
import type { NormalizedPriceTable } from "./price-table";

/**
 * Передаёт нормализованные данные существующему механизму сравнения.
 * Ошибочные строки остаются блокирующими; здесь ничего не применяется.
 */
export function normalizedTableToParseResult(table: NormalizedPriceTable): ParseResult {
  const rows: ParsedRow[] = table.accepted.map((item) => ({
    line: item.sourceRow,
    sku: item.sku,
    salePrice: item.retailKopecks / 100,
    costPrice: item.purchaseKopecks === null ? null : item.purchaseKopecks / 100,
    stock: null,
    qty: null,
    supplierName: null,
    sourceKey: null,
    errors: [],
  }));
  const invalidRows: ParsedRow[] = table.rejected.map((item) => ({
    line: item.sourceRow,
    sku: null,
    salePrice: null,
    costPrice: null,
    stock: null,
    qty: null,
    supplierName: null,
    sourceKey: null,
    errors: [item.code],
  }));
  return { ok: true, rows, invalidRows, warnings: [], columns: {} };
}
