import { z } from "zod";

// Ограничения совпадают с RLS-политикой 0002 и жёстче неё (позиций <= 50 против 200).
export const MAX_POSITIONS = 50;
export const MAX_QTY_PER_ITEM = 999;
export const MAX_TOTAL = 100_000_000;

const phoneRe = /^[+()\-\s\d]{5,40}$/;

/**
 * Ожидаемая цена — то, что покупатель ВИДЕЛ в корзине (localStorage и т.п.).
 * Это только «ожидание» для сравнения, НИКОГДА не источник суммы: сервер
 * заново считает цену по published-товарам и сравнивает в копейках.
 */
export const expectedPriceSchema = z.object({
  total: z.number().finite().min(0).max(MAX_TOTAL),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid("Некорректный идентификатор товара"),
        unit_price: z.number().finite().min(0).max(MAX_TOTAL),
      }),
    )
    .max(MAX_POSITIONS, "Слишком много позиций")
    .optional(),
});

export type ExpectedPrice = z.infer<typeof expectedPriceSchema>;

export const orderPayloadSchema = z.object({
  name: z.string().trim().min(2, "Укажите имя").max(200),
  phone: z
    .string()
    .trim()
    .min(5, "Укажите телефон")
    .max(40)
    .regex(phoneRe, "Проверьте формат телефона")
    .refine((p) => (p.match(/\d/g) ?? []).length >= 5, "В телефоне должно быть не меньше 5 цифр"),
  comment: z.string().trim().max(1000).optional().nullable(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid("Некорректный идентификатор товара"),
        qty: z.number().int().min(1).max(MAX_QTY_PER_ITEM),
      }),
    )
    .min(1, "Корзина пуста")
    .max(MAX_POSITIONS, "Слишком много позиций"),
  expected: expectedPriceSchema.optional(),
});

export type OrderPayload = z.infer<typeof orderPayloadSchema>;

export interface OrderProductRow {
  id: string;
  slug: string;
  title: string;
  price: number;
  status: "draft" | "published" | "hidden";
  in_stock: boolean;
}

export interface OrderSnapshotItem {
  product_id: string;
  slug: string;
  title: string;
  price: number;
  qty: number;
  /** true — товар отмечен как отсутствующий: принимаем «под заказ» без обещания срока. */
  backorder: boolean;
}

export type ComputeOrderResult =
  | { ok: true; items: OrderSnapshotItem[]; total: number; hasBackorder: boolean }
  | { ok: false; code: "EMPTY" | "NOT_FOUND" | "NOT_PUBLISHED" | "BAD_PRICE"; message: string };

/**
 * Пересчитывает состав и сумму заказа только по доверенным данным сервера.
 * Клиентские price/title/total не используются вообще.
 */
export function computeOrder(
  payload: OrderPayload,
  products: OrderProductRow[],
): ComputeOrderResult {
  if (payload.items.length === 0) return { ok: false, code: "EMPTY", message: "Корзина пуста" };

  const byId = new Map(products.map((p) => [p.id, p]));

  // Склеиваем дубли позиций одного товара.
  const merged = new Map<string, number>();
  for (const item of payload.items) {
    merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + item.qty);
  }

  const items: OrderSnapshotItem[] = [];
  let total = 0;
  let hasBackorder = false;

  for (const [productId, qty] of merged) {
    const p = byId.get(productId);
    if (!p) return { ok: false, code: "NOT_FOUND", message: "Товар не найден" };
    if (p.status !== "published")
      return { ok: false, code: "NOT_PUBLISHED", message: "Товар недоступен для заказа" };
    const price = Number(p.price);
    if (!Number.isFinite(price) || price < 0)
      return { ok: false, code: "BAD_PRICE", message: "Некорректная цена товара" };
    if (qty > MAX_QTY_PER_ITEM)
      return { ok: false, code: "EMPTY", message: `Слишком большое количество: ${p.title}` };

    const backorder = !p.in_stock;
    if (backorder) hasBackorder = true;
    total += price * qty;
    items.push({ product_id: p.id, slug: p.slug, title: p.title, price, qty, backorder });
  }

  if (total >= MAX_TOTAL)
    return { ok: false, code: "BAD_PRICE", message: "Слишком большая сумма заказа" };
  return { ok: true, items, total: Math.round(total * 100) / 100, hasBackorder };
}

export type ExpectedCheck = { ok: true } | { ok: false; code: "PRICE_CHANGED" };

const toCents = (n: number): number => Math.round(n * 100);

/**
 * Сверка клиентского ожидания с серверным пересчётом. Сравнение — в копейках,
 * чтобы избежать float-артефактов. Отсутствие ожидания — не подтверждение
 * (fail closed): заказ не пишется, пока покупатель не согласится с суммой.
 * Дубли product_id в ожидании допустимы только с одинаковой ценой.
 */
export function checkExpectedPrice(
  computed: { total: number; items: OrderSnapshotItem[] },
  expected: ExpectedPrice | undefined | null,
): ExpectedCheck {
  if (!expected) return { ok: false, code: "PRICE_CHANGED" };
  if (toCents(expected.total) !== toCents(computed.total))
    return { ok: false, code: "PRICE_CHANGED" };
  if (expected.items) {
    const expMap = new Map<string, number>();
    for (const it of expected.items) {
      const prev = expMap.get(it.product_id);
      if (prev !== undefined && toCents(prev) !== toCents(it.unit_price))
        return { ok: false, code: "PRICE_CHANGED" }; // противоречивое ожидание
      expMap.set(it.product_id, it.unit_price);
    }
    for (const it of computed.items) {
      const exp = expMap.get(it.product_id);
      if (exp === undefined || toCents(exp) !== toCents(it.price))
        return { ok: false, code: "PRICE_CHANGED" };
    }
  }
  return { ok: true };
}
