// Чистый (тестируемый) diff-движок импорта прайса для интернет-магазина
// «Мастер Сварщик». Сопоставляет разобранный прайс с реальным каталогом и
// формирует предпросмотр изменений. Без обращений к БД, Telegram и сети.
//
// Жёсткие правила:
//   - сопоставление только по SKU; строки без SKU — invalid (в parser),
//     дубли SKU в прайсе ИЛИ в каталоге — manual-review, автоприменение
//     блокируется целиком;
//   - замена цены/наличия/себестоимости только для полей, ЯВНО переданных
//     в opts.fields; qty применяется только при явном подтверждении склада
//     (confirmQty);
//   - old_price, статусы, категория, название, slug, source_url НЕ меняются
//     никогда — таких полей в движке просто нет;
//   - закупочные цены: только при праве view_costs (includeCosts); без него
//     cost-строки не попадают в результат вообще (продавец не видит даже
//     предпросмотр);
//   - ничего не применяется без явного подтверждения: canAutoApply — false
//     всегда, применение только через applyGate(approved=true).

import type { ParseResult, ParsedRow } from "./price-csv";

// ---------- Типы ----------

export type DiffField = "price" | "stock" | "qty" | "cost";

export interface CatalogProduct {
  id: string;
  sku: string | null;
  title: string;
  price: number;
  in_stock: boolean;
  stock_qty: number | null;
  status: string;
}

export interface DiffOptions {
  /** Поля, явно переданные к применению. Ничего вне списка не меняется. */
  fields: Set<DiffField>;
  /** Явное подтверждение склада для применения qty. */
  confirmQty: boolean;
  /** Право view_costs. Без него cost-данные вырезаются из результата. */
  includeCosts: boolean;
  /** Порог предупреждения об изменении цены, %. По умолчанию 20. */
  priceWarnPercent?: number;
  /** Порог критического изменения цены, %. По умолчанию 30. */
  priceCriticalPercent?: number;
}

export interface DiffRow {
  sku: string;
  productId: string;
  title: string;
  field: DiffField;
  oldValue: number | boolean | null;
  newValue: number | boolean;
  /** Процент изменения (только для ценовых полей), null — не применимо. */
  percentChange: number | null;
  warnings: string[];
}

export interface DiffSummary {
  total: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  invalid: number;
  unchanged: number;
  proposed: number;
}

export interface DiffResult {
  summary: DiffSummary;
  /** Предложения по витринным полям (price/stock/qty). */
  rows: DiffRow[];
  /** Предложения по закупочным ценам — ТОЛЬКО при includeCosts. */
  costRows: DiffRow[];
  ambiguousSkus: string[];
  unmatchedSkus: string[];
  invalidLines: number[];
  /** Причины, блокирующие автоматическое применение батча. */
  blockers: string[];
  warnings: string[];
}

export const WARN_PRICE_CHANGE = "PRICE_CHANGE_OVER_WARN";
export const CRITICAL_PRICE_CHANGE = "PRICE_CHANGE_OVER_CRITICAL";
export const WARN_SALE_BELOW_COST = "SALE_BELOW_COST";
export const WARN_QTY_WITHOUT_STOCK_CONFIRM = "QTY_WITHOUT_STOCK_CONFIRM";
export const WARN_COST_SKIPPED_NO_PERMISSION = "COST_SKIPPED_NO_PERMISSION";
export const BLOCK_DUPLICATE_IN_PRICE = "DUPLICATE_SKU_IN_PRICE";
export const BLOCK_AMBIGUOUS_IN_CATALOG = "AMBIGUOUS_SKU_IN_CATALOG";
export const BLOCK_INVALID_ROWS = "INVALID_ROWS_PRESENT";

// ---------- Diff ----------

function percentChange(oldV: number, newV: number): number {
  if (oldV === 0) return newV === 0 ? 0 : 100;
  return Math.round(((newV - oldV) / oldV) * 10000) / 100;
}

/**
 * Сопоставление прайса с каталогом.
 * costs — карта product_id → cost_price (из защищённой таблицы); передаётся
 * только когда у вызывающего есть право view_costs, иначе null.
 */
export function diffPriceImport(
  parsed: ParseResult,
  catalog: CatalogProduct[],
  costs: Map<string, number> | null,
  opts: DiffOptions,
): DiffResult {
  const warnPct = opts.priceWarnPercent ?? 20;
  const critPct = opts.priceCriticalPercent ?? 30;

  const bySku = new Map<string, CatalogProduct[]>();
  for (const p of catalog) {
    if (!p.sku) continue;
    const list = bySku.get(p.sku) ?? [];
    list.push(p);
    bySku.set(p.sku, list);
  }

  // Дубли SKU внутри прайса — блокируют автоматическое применение целиком.
  const seen = new Map<string, number>();
  for (const r of parsed.rows) {
    if (r.sku) seen.set(r.sku, (seen.get(r.sku) ?? 0) + 1);
  }
  const dupInPrice = new Set<string>();
  for (const [sku, n] of seen) if (n > 1) dupInPrice.add(sku);

  const result: DiffResult = {
    summary: {
      total: parsed.rows.length + parsed.invalidRows.length,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      invalid: parsed.invalidRows.length,
      unchanged: 0,
      proposed: 0,
    },
    rows: [],
    costRows: [],
    ambiguousSkus: [],
    unmatchedSkus: [],
    invalidLines: parsed.invalidRows.map((r) => r.line),
    blockers: [],
    warnings: [],
  };

  if (dupInPrice.size > 0) {
    result.blockers.push(
      `${BLOCK_DUPLICATE_IN_PRICE}: артикулы ${[...dupInPrice].sort().join(", ")} встречаются в прайсе более одного раза — нужна ручная проверка.`,
    );
  }
  if (parsed.invalidRows.length > 0) {
    result.blockers.push(
      `${BLOCK_INVALID_ROWS}: ${parsed.invalidRows.length} строк с ошибками (строки ${result.invalidLines.join(", ")}) — исправьте прайс.`,
    );
  }

  const ambiguousSet = new Set<string>();
  const unmatchedSet = new Set<string>();

  for (const r of parsed.rows) {
    const sku = r.sku!;
    if (dupInPrice.has(sku)) continue; // blocker уже зафиксирован

    const hits = bySku.get(sku) ?? [];
    if (hits.length > 1) {
      ambiguousSet.add(sku);
      continue;
    }
    if (hits.length === 0) {
      unmatchedSet.add(sku);
      continue;
    }
    const product = hits[0]!;
    result.summary.matched++;

    const pushRow = (
      field: DiffField,
      oldValue: number | boolean | null,
      newValue: number | boolean,
      pct: number | null,
      warnings: string[],
      target: DiffRow[],
    ) => {
      if (oldValue === newValue && pct === null) {
        result.summary.unchanged++;
        return;
      }
      target.push({
        sku,
        productId: product.id,
        title: product.title,
        field,
        oldValue,
        newValue,
        percentChange: pct,
        warnings,
      });
      result.summary.proposed++;
    };

    // ---- Цена продажи (только при явном fields: price) ----
    if (opts.fields.has("price") && r.salePrice !== null) {
      const pct = percentChange(product.price, r.salePrice);
      const warnings: string[] = [];
      if (Math.abs(pct) >= critPct) warnings.push(CRITICAL_PRICE_CHANGE);
      else if (Math.abs(pct) >= warnPct) warnings.push(WARN_PRICE_CHANGE);
      // Сравнение в копейках — без float-артефактов.
      const same = Math.round(product.price * 100) === Math.round(r.salePrice * 100);
      pushRow("price", product.price, r.salePrice, same ? null : pct, warnings, result.rows);
    }

    // ---- Логическое наличие (только при явном fields: stock) ----
    if (opts.fields.has("stock") && r.stock !== null) {
      pushRow("stock", product.in_stock, r.stock, null, [], result.rows);
    }

    // ---- Количество (только при явном подтверждении склада) ----
    if (r.qty !== null) {
      if (!opts.confirmQty) {
        result.warnings.push(
          `${WARN_QTY_WITHOUT_STOCK_CONFIRM}: ${sku} — количество из прайса не применяется без подтверждения синхронизации склада.`,
        );
      } else if (opts.fields.has("qty")) {
        pushRow("qty", product.stock_qty, r.qty, null, [], result.rows);
      }
    }

    // ---- Закупочная цена (только с правом view_costs) ----
    if (r.costPrice !== null) {
      if (!opts.includeCosts) {
        result.warnings.push(
          `${WARN_COST_SKIPPED_NO_PERMISSION}: ${sku} — закупочная цена из прайса пропущена (нет права view_costs).`,
        );
      } else if (opts.fields.has("cost")) {
        const oldCost = costs?.get(product.id) ?? null;
        const pct = oldCost === null ? null : percentChange(oldCost, r.costPrice);
        const same =
          oldCost !== null && Math.round(oldCost * 100) === Math.round(r.costPrice * 100);
        if (same) result.summary.unchanged++;
        else {
          result.costRows.push({
            sku,
            productId: product.id,
            title: product.title,
            field: "cost",
            oldValue: oldCost,
            newValue: r.costPrice,
            percentChange: pct,
            warnings: [],
          });
          result.summary.proposed++;
        }
        // Цена продажи ниже закупки — критическое предупреждение.
        const effectiveCost = r.costPrice;
        if (r.salePrice !== null && r.salePrice < effectiveCost) {
          result.warnings.push(
            `${WARN_SALE_BELOW_COST}: ${sku} — цена продажи ${r.salePrice} ₽ ниже закупки ${effectiveCost} ₽.`,
          );
        }
      }
    }
  }

  result.ambiguousSkus = [...ambiguousSet].sort();
  result.unmatchedSkus = [...unmatchedSet].sort();
  result.summary.ambiguous = ambiguousSet.size;
  result.summary.unmatched = unmatchedSet.size;

  if (result.ambiguousSkus.length > 0) {
    result.blockers.push(
      `${BLOCK_AMBIGUOUS_IN_CATALOG}: артикулы ${result.ambiguousSkus.join(", ")} встречаются в каталоге более одного раза — только ручная проверка.`,
    );
  }

  return result;
}

// ---------- Гейты применения ----------

export interface ApplyGate {
  allowed: boolean;
  reason?: string;
}

/**
 * Автоприменение запрещено ВСЕГДА: подтверждение владельца/сотрудника с
 * правом обязательно. Функция существует, чтобы это нельзя было случайно
 * обойти: единственный путь — applyGate(true).
 */
export function canAutoApply(): false {
  return false;
}

export function applyGate(approved: boolean, result: DiffResult): ApplyGate {
  if (!approved) return { allowed: false, reason: "NO_CONFIRMATION" };
  if (result.blockers.length > 0)
    return { allowed: false, reason: result.blockers[0]!.split(":")[0]! };
  if (result.summary.proposed === 0) return { allowed: false, reason: "NOTHING_TO_APPLY" };
  return { allowed: true };
}

/** Оптимистичная блокировка: текущее значение должно совпасть с «было». */
export function checkApplyConflict(row: DiffRow, currentValue: number | boolean | null): boolean {
  if (row.field === "price" || row.field === "cost") {
    if (typeof currentValue !== "number" || typeof row.oldValue !== "number")
      return currentValue !== row.oldValue;
    return Math.round(currentValue * 100) !== Math.round(row.oldValue * 100);
  }
  return currentValue !== row.oldValue;
}

/** Откат разрешён, только если текущее значение ТОЧНО равно «стало». */
export function checkRollbackConflict(
  row: DiffRow,
  currentValue: number | boolean | null,
): boolean {
  if (row.field === "price" || row.field === "cost") {
    if (typeof currentValue !== "number" || typeof row.newValue !== "number")
      return currentValue !== row.newValue;
    return Math.round(currentValue * 100) !== Math.round(row.newValue * 100);
  }
  return currentValue !== row.newValue;
}

// ---------- Redaction и тексты для роли ----------

/**
 * Вырезает закупочные данные для роли без view_costs: cost-строки и
 * cost-warnings. Вызывать перед формированием ЛЮБОГО текста для Telegram.
 */
export function sanitizeForRole(result: DiffResult, canViewCosts: boolean): DiffResult {
  if (canViewCosts) return result;
  return {
    ...result,
    costRows: [],
    warnings: result.warnings.filter(
      (w) => !w.startsWith(WARN_COST_SKIPPED_NO_PERMISSION) && !w.startsWith(WARN_SALE_BELOW_COST),
    ),
  };
}

const FIELD_LABEL: Record<DiffField, string> = {
  price: "цена",
  stock: "наличие",
  qty: "количество",
  cost: "закупка",
};

function fmtValue(field: DiffField, v: number | boolean | null): string {
  if (v === null) return "—";
  if (field === "stock") return v ? "да" : "нет";
  return `${v}${field === "price" || field === "cost" ? " ₽" : ""}`;
}

/** Текст предпросмотра: сводка + первые строки изменений (не более limit). */
export function renderDiffPreview(
  result: DiffResult,
  opts: { canViewCosts: boolean; limit?: number },
): string {
  const r = sanitizeForRole(result, opts.canViewCosts);
  const limit = opts.limit ?? 20;
  const s = r.summary;
  const lines: string[] = [
    "Предпросмотр импорта прайса (ничего не изменено):",
    "",
    `Сопоставлено: ${s.matched} · не найдено: ${s.unmatched} · неоднозначных: ${s.ambiguous}`,
    `С ошибками: ${s.invalid} · без изменений: ${s.unchanged} · предложено изменений: ${s.proposed}`,
  ];
  if (r.blockers.length > 0) {
    lines.push("", "⛔ Автоприменение заблокировано:", ...r.blockers.map((b) => `• ${b}`));
  }
  const all = [...r.rows, ...r.costRows];
  const shown = all.slice(0, limit);
  if (shown.length > 0) {
    lines.push("", "Изменения:");
    for (const row of shown) {
      const pct =
        row.percentChange !== null
          ? ` (${row.percentChange > 0 ? "+" : ""}${row.percentChange}%)`
          : "";
      const warn = row.warnings.includes(CRITICAL_PRICE_CHANGE)
        ? " ⚠️ сильное изменение"
        : row.warnings.includes(WARN_PRICE_CHANGE)
          ? " ⚠️"
          : "";
      lines.push(
        `• ${row.sku} — ${FIELD_LABEL[row.field]}: ${fmtValue(row.field, row.oldValue)} → ${fmtValue(row.field, row.newValue)}${pct}${warn}`,
      );
    }
    if (all.length > limit) lines.push(`…и ещё ${all.length - limit} — уточните выборку.`);
  }
  if (r.warnings.length > 0) {
    lines.push("", "Предупреждения:", ...r.warnings.slice(0, 10).map((w) => `• ${w}`));
  }
  return lines.join("\n");
}
