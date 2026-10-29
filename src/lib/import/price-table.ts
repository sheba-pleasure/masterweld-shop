/**
 * Нормализация таблицы прайса после извлечения из файла.
 * Не читает файлы, не выполняет формулы и не изменяет каталог.
 * Сопоставление колонок и тип цены выбирает сотрудник.
 */
export type PriceKind = "retail" | "purchase";
export type PriceCell = string | number | null;

export interface MarkupTier {
  /** Верхняя граница закупочной цены в копейках включительно; null — без верхней границы. */
  upToKopecks: number | null;
  /** 2500 = 25% к закупочной цене. */
  markupBasisPoints: number;
}

export interface TableImportOptions {
  skuColumn: number;
  priceColumn: number;
  priceKind: PriceKind;
  /** Наценка в сотых долях процента: 2500 = 25%. Только для закупочной цены. */
  markupBasisPoints?: number;
  /** Диапазоны по возрастанию цены. Последний диапазон должен иметь границу null. */
  markupTiers?: MarkupTier[];
  decimalSeparator: "." | ",";
  firstDataRow: number;
}

export interface NormalizedPriceRow {
  sourceRow: number;
  sku: string;
  purchaseKopecks: number | null;
  retailKopecks: number;
}

export interface RejectedPriceRow {
  sourceRow: number;
  code: "MISSING_SKU" | "INVALID_SKU" | "MISSING_PRICE" | "INVALID_PRICE" | "FORMULA" | "PRICE_LIMIT";
}

export interface NormalizedPriceTable {
  accepted: NormalizedPriceRow[];
  rejected: RejectedPriceRow[];
}

const MAX_ROWS = 10_000;
const MAX_COLUMNS = 50;
const MAX_KOPECKS = 1_000_000_000;
const SKU = /^[A-Za-zА-Яа-яЁё0-9._/+-]{1,60}$/;

function isFormula(value: PriceCell): boolean {
  return typeof value === "string" && /^[=+@\-]/.test(value.trim());
}

function priceInKopecks(value: PriceCell, separator: "." | ","): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const kopecks = Math.round(value * 100);
    if (Math.abs(value * 100 - kopecks) > 1e-7) return null;
    return Number.isSafeInteger(kopecks) && kopecks > 0 ? kopecks : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/[\s\u00a0\u202f]/g, "");
  const pattern = separator === "." ? /^\d+(?:\.\d{1,2})?$/ : /^\d+(?:,\d{1,2})?$/;
  if (!pattern.test(text)) return null;
  const [whole, fraction = ""] = text.split(separator);
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(amount);
}

export function normalizePriceTable(
  table: PriceCell[][],
  options: TableImportOptions,
): NormalizedPriceTable {
  if (!Array.isArray(table) || table.length > MAX_ROWS + 1) throw new Error("TABLE_TOO_LARGE");
  const { skuColumn, priceColumn, firstDataRow, priceKind, decimalSeparator } = options;
  if (!Number.isInteger(skuColumn) || !Number.isInteger(priceColumn) ||
      skuColumn < 0 || priceColumn < 0 || skuColumn >= MAX_COLUMNS ||
      priceColumn >= MAX_COLUMNS || skuColumn === priceColumn ||
      !Number.isInteger(firstDataRow) || firstDataRow < 0 || firstDataRow >= table.length ||
      (priceKind !== "retail" && priceKind !== "purchase") ||
      (decimalSeparator !== "." && decimalSeparator !== ",")) throw new Error("INVALID_OPTIONS");
  const markup = options.markupBasisPoints;
  const tiers = options.markupTiers;
  if (priceKind === "retail" && (markup !== undefined || tiers !== undefined))
    throw new Error("UNEXPECTED_MARKUP");
  if (priceKind === "purchase") {
    if ((markup === undefined) === (tiers === undefined)) throw new Error("MARKUP_REQUIRED");
    if (markup !== undefined &&
        (!Number.isInteger(markup) || markup < 0 || markup > 100_000))
      throw new Error("INVALID_MARKUP");
    if (tiers !== undefined) {
      if (!Array.isArray(tiers) || tiers.length === 0 || tiers.length > 50)
        throw new Error("INVALID_MARKUP_TIERS");
      let previousLimit = 0;
      let previousMarkup = 100_000;
      tiers.forEach((tier, index) => {
        if (!tier || !Number.isInteger(tier.markupBasisPoints) ||
            tier.markupBasisPoints < 0 || tier.markupBasisPoints > previousMarkup ||
            (index === tiers.length - 1
              ? tier.upToKopecks !== null
              : !Number.isSafeInteger(tier.upToKopecks) ||
                tier.upToKopecks! <= previousLimit || tier.upToKopecks! >= MAX_KOPECKS))
          throw new Error("INVALID_MARKUP_TIERS");
        if (tier.upToKopecks !== null) previousLimit = tier.upToKopecks;
        previousMarkup = tier.markupBasisPoints;
      });
    }
  }

  const accepted: NormalizedPriceRow[] = [];
  const rejected: RejectedPriceRow[] = [];
  for (let index = firstDataRow; index < table.length; index++) {
    const cells = table[index];
    if (!Array.isArray(cells) || cells.length > MAX_COLUMNS) throw new Error("INVALID_TABLE");
    const skuCell = cells[skuColumn] ?? null;
    const priceCell = cells[priceColumn] ?? null;
    if (cells.every((cell) => cell === null || String(cell).trim() === "")) continue;
    const sourceRow = index + 1;
    const reject = (code: RejectedPriceRow["code"]) => rejected.push({ sourceRow, code });
    if (isFormula(skuCell) || isFormula(priceCell)) { reject("FORMULA"); continue; }
    // Числовой артикул мог потерять ведущие нули в Excel: он требует проверки.
    if (skuCell === null || String(skuCell).trim() === "") { reject("MISSING_SKU"); continue; }
    if (typeof skuCell !== "string" || !SKU.test(skuCell.trim())) { reject("INVALID_SKU"); continue; }
    if (priceCell === null || (typeof priceCell === "string" && !priceCell.trim())) {
      reject("MISSING_PRICE"); continue;
    }
    const amount = priceInKopecks(priceCell, decimalSeparator);
    if (amount === null) { reject("INVALID_PRICE"); continue; }
    if (amount > MAX_KOPECKS) { reject("PRICE_LIMIT"); continue; }
    // Один процент применяется ко всей закупочной цене, а не по частям.
    const selectedMarkup = tiers?.find((tier) =>
      tier.upToKopecks === null || amount <= tier.upToKopecks,
    )?.markupBasisPoints ?? markup;
    // Округление до копейки, половина вверх, без арифметики с плавающей точкой.
    const calculated = priceKind === "purchase"
      ? (BigInt(amount) * BigInt(10_000 + selectedMarkup!) + 5_000n) / 10_000n
      : BigInt(amount);
    if (calculated > BigInt(MAX_KOPECKS)) { reject("PRICE_LIMIT"); continue; }
    accepted.push({
      sourceRow, sku: skuCell.trim(),
      purchaseKopecks: priceKind === "purchase" ? amount : null,
      retailKopecks: Number(calculated),
    });
  }
  return { accepted, rejected };
}
