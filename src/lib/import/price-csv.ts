// Чистый (тестируемый) парсер CSV-прайсов для импорта в интернет-магазин
// «Мастер Сварщик». Без обращений к БД, Telegram и сети.
//
// Принципы:
//   - только UTF-8 (BOM допускается); cp1251 и прочие кодировки — явный отказ,
//     никакого «угадывания» кодировки;
//   - разделитель определяется строго (comma/semicolon/tab) с безопасной
//     обработкой quoted fields; неоднозначность — отказ;
//   - колонки распознаются только по явному whitelist (русские и английские
//     имена); неизвестные колонки — предупреждение, не угадываем;
//   - строки без SKU НИКОГДА не сопоставляются по названию — это reject;
//   - цены RUB: явный формат десятичного разделителя, до 2 знаков, без
//     умножения на 100 и без неоднозначных разделителей;
//   - лимиты размера/строк/колонок; опасные значения (формулы) — предупреждение,
//     при экспорте CSV — защита от formula injection.

// ---------- Лимиты ----------

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
export const MAX_IMPORT_COLS = 50;
export const MAX_SKU_LEN = 60;
export const MAX_SUPPLIER_NAME_LEN = 200;
export const MAX_SOURCE_KEY_LEN = 200;
export const MAX_PRICE_RUB = 10_000_000;
export const MAX_QTY = 1_000_000;

// ---------- Типы ----------

/** Поля прайса. ВАЖНО: old_price, status, category, title, slug, source_url
 *  в импорт НЕ входят — они ботом через прайс не меняются. */
export type ImportField =
  "sku" | "sale_price" | "cost_price" | "stock" | "qty" | "supplier_name" | "source_key";

export type DecimalFormat = "dot" | "comma";

export type ImportErrorCode =
  | "UNSUPPORTED_ENCODING"
  | "FILE_TOO_LARGE"
  | "EMPTY_FILE"
  | "AMBIGUOUS_DELIMITER"
  | "MALFORMED_QUOTES"
  | "TOO_MANY_ROWS"
  | "TOO_MANY_COLUMNS"
  | "MISSING_SKU_COLUMN"
  | "MISSING_DATA_COLUMNS";

export interface ImportWarning {
  code: string;
  line?: number;
  message: string;
}

export interface ParsedRow {
  line: number;
  sku: string | null;
  salePrice: number | null;
  costPrice: number | null;
  stock: boolean | null;
  qty: number | null;
  supplierName: string | null;
  sourceKey: string | null;
  /** Коды ошибок строки (пусто — строка пригодна к сопоставлению). */
  errors: string[];
}

export interface ParseResult {
  ok: boolean;
  error?: ImportErrorCode;
  rows: ParsedRow[];
  invalidRows: ParsedRow[];
  warnings: ImportWarning[];
  delimiter?: string;
  columns: Partial<Record<ImportField, number>>;
}

// ---------- Кодировка ----------

export function decodeUtf8(
  bytes: Uint8Array,
):
  | { ok: true; text: string }
  | { ok: false; code: "UNSUPPORTED_ENCODING" | "FILE_TOO_LARGE" | "EMPTY_FILE" } {
  if (bytes.length > MAX_IMPORT_FILE_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  if (bytes.length === 0) return { ok: false, code: "EMPTY_FILE" };
  let text: string;
  try {
    // fatal: cp1251-кириллица и любой не-UTF-8 дают исключение — честный отказ.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: "UNSUPPORTED_ENCODING" };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM
  return { ok: true, text };
}

// ---------- Разделитель ----------

const DELIMITERS = [";", ",", "\t"] as const;

/** Подсчёт разделителя вне кавычек в одной строке. */
function countDelim(line: string, delim: string): number {
  let inQuotes = false;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++; // экранированная кавычка
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && ch === delim) {
      n++;
    }
  }
  return n;
}

/**
 * Строгое определение разделителя по первым 10 непустым строкам:
 * кандидат побеждает, если на первой строке его больше нуля, первая строка —
 * максимум, и как минимум половина строк содержит столько же разделителей
 * (одиночные битые строки не мешают определению — они будут отклонены как
 * ROW_COLUMN_MISMATCH). Неоднозначность (>1 кандидата) или отсутствие — null.
 */
export function detectDelimiter(text: string): string | null {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 10);
  if (lines.length === 0) return null;
  const minConsistent = Math.ceil(lines.length / 2);
  const fits: string[] = [];
  for (const delim of DELIMITERS) {
    const counts = lines.map((l) => countDelim(l, delim));
    const first = counts[0]!;
    if (first === 0) continue;
    if (first !== Math.max(...counts)) continue;
    const consistent = counts.filter((c) => c === first).length;
    if (consistent >= minConsistent) fits.push(delim);
  }
  if (fits.length !== 1) return null; // 0 — ничего не подошло; >1 — неоднозначно
  return fits[0]!;
}

// ---------- Разбор строк (RFC 4180) ----------

/**
 * Разбор CSV в поля с поддержкой quoted fields ("" внутри кавычек).
 * Возвращает строки полей или ошибку MALFORMED_QUOTES при повреждённых
 * кавычках (кавычка не в начале поля, текст после закрывающей кавычки).
 */
export function parseCsvFields(
  text: string,
  delim: string,
): { ok: true; rows: string[][] } | { ok: false; code: "MALFORMED_QUOTES" } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteOpened = false; // текущее поле началось с кавычки
  let quoteClosed = false; // текущее поле закрыло кавычку
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
    quoteOpened = false;
    quoteClosed = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        quoteClosed = true;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (field.length === 0 && !quoteOpened && !quoteClosed) {
        quoteOpened = true;
        inQuotes = true;
        i++;
        continue;
      }
      return { ok: false, code: "MALFORMED_QUOTES" };
    }
    if (quoteClosed && ch !== delim && ch !== "\r" && ch !== "\n") {
      return { ok: false, code: "MALFORMED_QUOTES" };
    }
    if (ch === delim) {
      endField();
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) return { ok: false, code: "MALFORMED_QUOTES" };
  if (field.length > 0 || row.length > 0) endRow();
  return { ok: true, rows };
}

// ---------- Колонки (явный whitelist) ----------

export const COLUMN_ALIASES: Record<ImportField, string[]> = {
  sku: ["sku", "supplier_sku", "артикул", "арт"],
  sale_price: ["sale_price", "price", "цена", "цена продажи", "розничная цена"],
  cost_price: ["cost_price", "cost", "закупка", "закупочная цена", "себестоимость"],
  stock: ["stock", "наличие", "в наличии"],
  qty: ["qty", "quantity", "кол-во", "количество"],
  supplier_name: ["supplier_name", "поставщик"],
  source_key: ["source_key", "источник"],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

/** Распознавание колонок по заголовку; неизвестные — в warnings, не угадываем. */
export function mapColumns(header: string[]): {
  columns: Partial<Record<ImportField, number>>;
  unknown: string[];
} {
  const columns: Partial<Record<ImportField, number>> = {};
  const unknown: string[] = [];
  header.forEach((h, idx) => {
    const norm = normalizeHeader(h);
    if (!norm) return;
    let hit: ImportField | null = null;
    for (const field of Object.keys(COLUMN_ALIASES) as ImportField[]) {
      if (COLUMN_ALIASES[field].includes(norm)) {
        hit = field;
        break;
      }
    }
    if (hit === null) unknown.push(h.trim());
    else if (columns[hit] === undefined) columns[hit] = idx; // первый выигрывает
  });
  return { columns, unknown };
}

// ---------- Значения ----------

// SKU: буквы/цифры и . _ / + - (как в редакторе бота).
const SKU_RE = /^[A-Za-zА-Яа-яЁё0-9._/+-]{1,60}$/;

/**
 * Цена RUB: строго по объявленному формату десятичного разделителя.
 * Пробелы (включая NBSP) — разделители тысяч и удаляются.
 * «1,200» при формате dot — невалидно (запятая не допускается);
 * при формате comma — невалидно (3 знака после запятой).
 * Никакого ×100: значение собирается как строка и преобразуется один раз.
 */
export function parseRubPrice(
  raw: string,
  format: DecimalFormat,
): { ok: true; value: number } | { ok: false } {
  const t = raw.trim().replace(/[\s\u00a0\u202f]/g, "");
  if (t.length === 0) return { ok: false };
  const re = format === "dot" ? /^\d+(?:\.\d{1,2})?$/ : /^\d+(?:,\d{1,2})?$/;
  if (!re.test(t)) return { ok: false };
  const normalized = t.replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PRICE_RUB) return { ok: false };
  return { ok: true, value };
}

/** Логическое наличие: да/нет. «Под заказ» = нет на складе. */
export function parseStockValue(raw: string): boolean | null {
  const t = raw.trim().toLowerCase().replace(/ё/g, "е");
  if (["1", "да", "yes", "y", "true", "в наличии", "есть"].includes(t)) return true;
  if (["0", "нет", "no", "n", "false", "под заказ", "нет в наличии"].includes(t)) return false;
  return null;
}

/** Количество: целое 0..MAX_QTY. */
export function parseQtyValue(raw: string): number | null {
  const t = raw.trim().replace(/[\s\u00a0\u202f]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isSafeInteger(v) || v > MAX_QTY) return null;
  return v;
}

/** Подозрительное «формульное» значение — предупреждение (мы его не исполняем). */
export function isFormulaLike(raw: string): boolean {
  return /^[=+\-@\t\r]/.test(raw.trim());
}

// ---------- Главный конвейер ----------

export interface ParseOptions {
  /** Формат десятичного разделителя цен — объявляется явно, не угадывается. */
  decimalFormat: DecimalFormat;
}

export function parsePriceFile(bytes: Uint8Array, opts: ParseOptions): ParseResult {
  const empty: ParseResult = { ok: false, rows: [], invalidRows: [], warnings: [], columns: {} };

  const dec = decodeUtf8(bytes);
  if (!dec.ok) return { ...empty, error: dec.code };

  const delim = detectDelimiter(dec.text);
  if (delim === null) return { ...empty, error: "AMBIGUOUS_DELIMITER" };

  const fields = parseCsvFields(dec.text, delim);
  if (!fields.ok) return { ...empty, error: "MALFORMED_QUOTES" };

  const allRows = fields.rows.filter((r) => r.some((c) => c.trim().length > 0));
  if (allRows.length === 0) return { ...empty, error: "EMPTY_FILE", delimiter: delim };
  if (allRows.length - 1 > MAX_IMPORT_ROWS)
    return { ...empty, error: "TOO_MANY_ROWS", delimiter: delim };
  const maxCols = Math.max(...allRows.map((r) => r.length));
  if (maxCols > MAX_IMPORT_COLS) return { ...empty, error: "TOO_MANY_COLUMNS", delimiter: delim };

  const header = allRows[0]!;
  const { columns, unknown } = mapColumns(header);
  const warnings: ImportWarning[] = unknown.map((h) => ({
    code: "UNKNOWN_COLUMN",
    message: `Колонка «${h}» не распознана и будет проигнорирована.`,
  }));

  if (columns.sku === undefined)
    return { ...empty, error: "MISSING_SKU_COLUMN", delimiter: delim, columns, warnings };
  if (
    columns.sale_price === undefined &&
    columns.cost_price === undefined &&
    columns.stock === undefined &&
    columns.qty === undefined
  )
    return { ...empty, error: "MISSING_DATA_COLUMNS", delimiter: delim, columns, warnings };

  const rows: ParsedRow[] = [];
  const invalidRows: ParsedRow[] = [];
  const headerLen = header.length;

  for (let r = 1; r < allRows.length; r++) {
    const cells = allRows[r]!;
    const line = r + 1;
    const cell = (field: ImportField): string | null => {
      const idx = columns[field];
      if (idx === undefined || idx >= cells.length) return null;
      return cells[idx]!;
    };

    const errors: string[] = [];
    if (cells.length !== headerLen)
      warnings.push({
        code: "ROW_COLUMN_MISMATCH",
        line,
        message: `Строка ${line}: ${cells.length} полей вместо ${headerLen} — строка отклонена.`,
      });

    // Подозрительные «формульные» значения — предупреждение на любом
    // текстовом поле (мы их не исполняем; при экспорте CSV экранируем).
    const warnFormula = (raw: string | null): void => {
      if (raw !== null && isFormulaLike(raw)) {
        warnings.push({
          code: "FORMULA_LIKE_VALUE",
          line,
          message: `Строка ${line}: значение похоже на формулу — принято как текст, не исполняется.`,
        });
      }
    };

    const rawSku = cell("sku") ?? "";
    const sku = rawSku.trim();
    if (sku.length === 0) errors.push("SKU_REQUIRED");
    else if (sku.length > MAX_SKU_LEN || !SKU_RE.test(sku)) errors.push("SKU_INVALID");
    warnFormula(rawSku);

    const parsePriceCell = (field: ImportField): number | null => {
      const raw = cell(field);
      if (raw === null || raw.trim().length === 0) return null;
      const p = parseRubPrice(raw, opts.decimalFormat);
      if (!p.ok) {
        errors.push(field === "sale_price" ? "INVALID_SALE_PRICE" : "INVALID_COST_PRICE");
        return null;
      }
      return p.value;
    };
    const salePrice = parsePriceCell("sale_price");
    const costPrice = parsePriceCell("cost_price");

    let stock: boolean | null = null;
    const rawStock = cell("stock");
    if (rawStock !== null && rawStock.trim().length > 0) {
      stock = parseStockValue(rawStock);
      if (stock === null) errors.push("INVALID_STOCK");
    }

    let qty: number | null = null;
    const rawQty = cell("qty");
    if (rawQty !== null && rawQty.trim().length > 0) {
      qty = parseQtyValue(rawQty);
      if (qty === null) errors.push("INVALID_QTY");
    }

    const supplierName = (() => {
      const raw = cell("supplier_name");
      if (raw === null) return null;
      warnFormula(raw);
      const v = raw.trim();
      if (v.length === 0) return null;
      if (v.length > MAX_SUPPLIER_NAME_LEN) {
        errors.push("SUPPLIER_NAME_TOO_LONG");
        return null;
      }
      return v;
    })();
    const sourceKey = (() => {
      const raw = cell("source_key");
      if (raw === null) return null;
      warnFormula(raw);
      const v = raw.trim();
      if (v.length === 0) return null;
      if (v.length > MAX_SOURCE_KEY_LEN) {
        errors.push("SOURCE_KEY_TOO_LONG");
        return null;
      }
      return v;
    })();

    if (cells.length !== headerLen) errors.push("ROW_COLUMN_MISMATCH");

    const row: ParsedRow = {
      line,
      sku: sku.length > 0 ? sku : null,
      salePrice,
      costPrice,
      stock,
      qty,
      supplierName,
      sourceKey,
      errors,
    };
    (errors.length === 0 ? rows : invalidRows).push(row);
  }

  return { ok: true, rows, invalidRows, warnings, delimiter: delim, columns };
}

// ---------- Экспорт CSV с защитой от formula injection ----------

/** Значение для CSV: экранирование кавычек/переносов + префикс `'` против формул. */
export function csvEscape(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\r\n;]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function rowsToCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

// ---------- Хэш (идемпотентность батча) ----------

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
