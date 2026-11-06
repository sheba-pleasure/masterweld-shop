import {
  decodeUtf8,
  detectDelimiter,
  parseCsvFields,
  parseRubPrice,
  parseStockValue,
  parseQtyValue,
} from "./price-csv";

export const CATALOG_FILE_BYTES = 2 * 1024 * 1024;
export const CATALOG_ROWS = 5000;
export const FIELDS = [
  "sku",
  "title",
  "brand",
  "price",
  "cost_price",
  "in_stock",
  "stock_qty",
  "category_slug",
] as const;
export type Field = (typeof FIELDS)[number];
export const FIELD_LABEL: Record<Field, string> = {
  sku: "Артикул",
  title: "Название",
  brand: "Бренд",
  price: "Розничная цена",
  cost_price: "Закупочная цена",
  in_stock: "Наличие",
  stock_qty: "Количество",
  category_slug: "Код раздела",
};
export type Mapping = Record<Field, number>;
const ALIASES: Record<Field, string[]> = {
  sku: ["sku", "артикул", "арт"],
  title: ["title", "название", "наименование", "товар"],
  brand: ["brand", "бренд", "производитель"],
  price: ["price", "sale_price", "цена", "розничная цена", "цена продажи"],
  cost_price: ["cost_price", "закупочная цена", "закупка", "себестоимость"],
  in_stock: ["in_stock", "stock", "наличие", "в наличии"],
  stock_qty: ["stock_qty", "qty", "количество", "остаток"],
  category_slug: ["category_slug", "код раздела"],
};
export interface CatalogFile {
  header: string[];
  rows: string[][];
  mapping: Mapping;
}
export interface CatalogInputRow {
  line: number;
  sku: string;
  values: Partial<Record<Exclude<Field, "sku">, string | number | boolean>>;
  errors: string[];
}
export function parseCatalogFile(bytes: Uint8Array): CatalogFile {
  if (bytes.byteLength > CATALOG_FILE_BYTES) throw new Error("FILE_TOO_LARGE");
  const decoded = decodeUtf8(bytes);
  if (!decoded.ok) throw new Error(decoded.code);
  const delimiter = detectDelimiter(decoded.text);
  if (!delimiter) throw new Error("AMBIGUOUS_DELIMITER");
  const parsed = parseCsvFields(decoded.text, delimiter);
  if (!parsed.ok) throw new Error(parsed.code);
  // Preserve row numbers, including blank records.
  const header = parsed.rows[0]?.map((h) => h.trim()) ?? [];
  const rows = parsed.rows.slice(1);
  if (
    header.length < 2 ||
    header.length > 30 ||
    header.some((h) => h.length > 100 || h.includes("\u0000"))
  )
    throw new Error("BAD_HEADER");
  if (!rows.length || rows.every((r) => r.every((c) => !c.trim()))) throw new Error("EMPTY_FILE");
  if (rows.length > CATALOG_ROWS) throw new Error("TOO_MANY_ROWS");
  if (rows.some((r) => r.length > 30 || r.some((c) => c.length > 2000 || c.includes("\u0000"))))
    throw new Error("CELL_TOO_LARGE");
  const normalized = header.map((h) => h.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " "));
  const mapping = Object.fromEntries(
    FIELDS.map((f) => {
      const indices = normalized.flatMap((h, i) => (ALIASES[f].includes(h) ? [i] : []));
      return [f, indices.length === 1 ? indices[0] : -1];
    }),
  ) as Mapping;
  return { header, rows, mapping };
}
export function normalizeCatalogFile(
  file: CatalogFile,
  decimal: "comma" | "dot",
): CatalogInputRow[] {
  const mapped = FIELDS.map((f) => file.mapping[f]).filter((i) => i !== -1);
  if (
    !["comma", "dot"].includes(decimal) ||
    file.mapping.sku < 0 ||
    FIELDS.some(
      (f) =>
        !Number.isInteger(file.mapping[f]) ||
        file.mapping[f] < -1 ||
        file.mapping[f] >= file.header.length,
    ) ||
    new Set(mapped).size !== mapped.length
  )
    throw new Error("BAD_MAPPING");
  if (mapped.length < 2) throw new Error("NO_FIELDS");
  return file.rows.flatMap((cells, i) => {
    if (cells.every((c) => !c.trim())) return [];
    const row: CatalogInputRow = { line: i + 2, sku: "", values: {}, errors: [] };
    if (cells.length !== file.header.length) row.errors.push("ROW_WIDTH");
    for (const field of FIELDS) {
      const col = file.mapping[field];
      if (col < 0) continue;
      const value = (cells[col] ?? "").trim();
      if (field === "sku") {
        row.sku = value;
        if (!/^[A-Za-zА-Яа-яЁё0-9._/+-]{1,60}$/.test(value)) row.errors.push("BAD_SKU");
        continue;
      }
      // Empty input never clears an existing field; this rule is shown before preview.
      if (!value) continue;
      if (/^[=+@]/.test(value)) {
        row.errors.push("FORMULA");
        continue;
      }
      if (field === "price" || field === "cost_price") {
        const result = parseRubPrice(value, decimal);
        if (!result.ok) row.errors.push("BAD_PRICE");
        else row.values[field] = result.value;
      } else if (field === "in_stock") {
        const stock = parseStockValue(value);
        if (stock === null) row.errors.push("BAD_STOCK");
        else row.values[field] = stock;
      } else if (field === "stock_qty") {
        const qty = parseQtyValue(value);
        if (qty === null) row.errors.push("BAD_QTY");
        else row.values[field] = qty;
      } else if (
        (field === "title" && (value.length < 3 || value.length > 200)) ||
        (field === "brand" && value.length > 100) ||
        (field === "category_slug" && !/^[a-z0-9][a-z0-9-]{0,119}$/.test(value))
      )
        row.errors.push("BAD_TEXT");
      else row.values[field] = value;
    }
    if ("stock_qty" in row.values) {
      const available = Number(row.values.stock_qty) > 0;
      if ("in_stock" in row.values && row.values.in_stock !== available)
        row.errors.push("STOCK_CONFLICT");
      row.values.in_stock = available;
    }
    return [row];
  });
}
