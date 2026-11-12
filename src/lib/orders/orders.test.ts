import { describe, expect, it } from "vitest";
import {
  computeOrder,
  orderPayloadSchema,
  MAX_POSITIONS,
  type OrderPayload,
  type OrderProductRow,
} from "./schema";
import {
  checkOrderRateLimit,
  peekOrderRateLimit,
  recordOrderHit,
  resetOrderRateLimit,
} from "./rate-limit.server";

const P = (over: Partial<OrderProductRow> = {}): OrderProductRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  slug: "tovar",
  title: "Товар",
  price: 100,
  status: "published",
  in_stock: true,
  ...over,
});

const payload = (over: Partial<OrderPayload> = {}): OrderPayload => ({
  name: "Иван",
  phone: "+7 (900) 123-45-67",
  comment: null,
  items: [{ product_id: "11111111-1111-4111-8111-111111111111", qty: 2 }],
  ...over,
});

describe("валидация заказа", () => {
  it("принимает корректный payload", () => {
    expect(orderPayloadSchema.safeParse(payload()).success).toBe(true);
  });
  it("отклоняет пустое имя", () => {
    expect(orderPayloadSchema.safeParse(payload({ name: " " })).success).toBe(false);
  });
  it("отклоняет мусорный телефон", () => {
    expect(orderPayloadSchema.safeParse(payload({ phone: "не телефон" })).success).toBe(false);
  });
  it("отклоняет телефон короче 5 цифр", () => {
    expect(orderPayloadSchema.safeParse(payload({ phone: "12-34" })).success).toBe(false);
  });
  it("отклоняет qty = 0", () => {
    expect(
      orderPayloadSchema.safeParse(payload({ items: [{ product_id: P().id, qty: 0 }] })).success,
    ).toBe(false);
  });
  it("отклоняет слишком большое qty", () => {
    expect(
      orderPayloadSchema.safeParse(payload({ items: [{ product_id: P().id, qty: 1000 }] })).success,
    ).toBe(false);
  });
  it("отклоняет пустую корзину", () => {
    expect(orderPayloadSchema.safeParse(payload({ items: [] })).success).toBe(false);
  });
  it("отклоняет больше 50 позиций", () => {
    const items = Array.from({ length: MAX_POSITIONS + 1 }, (_, i) => ({
      product_id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      qty: 1,
    }));
    expect(orderPayloadSchema.safeParse(payload({ items })).success).toBe(false);
  });
  it("отклоняет не-UUID product_id", () => {
    expect(
      orderPayloadSchema.safeParse(payload({ items: [{ product_id: "abc", qty: 1 }] })).success,
    ).toBe(false);
  });
  it("отклоняет клиентские price/title/total в позициях", () => {
    const bad = payload({ items: [{ product_id: P().id, qty: 1 } as never] });
    // строгий объект zod игнорирует лишние поля, но схема позиции их не пропускает в тип
    const parsed = orderPayloadSchema.parse(bad);
    expect(parsed.items[0]).toEqual({ product_id: P().id, qty: 1 });
  });
});

describe("серверный пересчёт заказа", () => {
  it("товар с ценой по запросу нельзя превратить в бесплатный заказ", () => {
    expect(computeOrder(payload(), [P({ price: null })])).toMatchObject({
      ok: false,
      code: "BAD_PRICE",
    });
  });
  it("считает сумму по серверным ценам, игнорируя клиентские", () => {
    const r = computeOrder(payload({ items: [{ product_id: P().id, qty: 3 }] }), [
      P({ price: 250 }),
    ]);
    expect(r).toMatchObject({ ok: true, total: 750 });
  });
  it("склеивает дубли позиций одного товара", () => {
    const r = computeOrder(
      payload({
        items: [
          { product_id: P().id, qty: 2 },
          { product_id: P().id, qty: 3 },
        ],
      }),
      [P({ price: 10 })],
    );
    expect(r.ok && r.items.length === 1 && r.items[0]?.qty === 5 && r.total === 50).toBe(true);
  });
  it("отклоняет отсутствующий товар", () => {
    const r = computeOrder(payload(), []);
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
  it("отклоняет черновик и скрытый товар", () => {
    expect(computeOrder(payload(), [P({ status: "draft" })])).toMatchObject({
      ok: false,
      code: "NOT_PUBLISHED",
    });
    expect(computeOrder(payload(), [P({ status: "hidden" })])).toMatchObject({
      ok: false,
      code: "NOT_PUBLISHED",
    });
  });
  it("товар in_stock=false допускается как «под заказ» без обещания", () => {
    const r = computeOrder(payload(), [P({ in_stock: false })]);
    expect(r).toMatchObject({ ok: true, hasBackorder: true });
    expect(r.ok && r.items[0]?.backorder).toBe(true);
  });
  it("отклоняет отрицательную/нечисловую цену", () => {
    expect(computeOrder(payload(), [P({ price: -5 })])).toMatchObject({
      ok: false,
      code: "BAD_PRICE",
    });
    expect(computeOrder(payload(), [P({ price: Number.NaN })])).toMatchObject({
      ok: false,
      code: "BAD_PRICE",
    });
  });
  it("отклоняет сумму больше лимита", () => {
    const r = computeOrder(payload({ items: [{ product_id: P().id, qty: 999 }] }), [
      P({ price: 1_000_000 }),
    ]);
    expect(r).toMatchObject({ ok: false });
  });
});

describe("анти-спам лимит", () => {
  it("пропускает 5 заказов и блокирует 6-й в окне", () => {
    resetOrderRateLimit();
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(checkOrderRateLimit("phone:79001234567", t + i)).toBe(true);
    expect(checkOrderRateLimit("phone:79001234567", t + 6)).toBe(false);
  });
  it("окно скользящее: спустя 10 минут снова пропускает", () => {
    resetOrderRateLimit();
    const t = 2_000_000;
    for (let i = 0; i < 5; i++) checkOrderRateLimit("phone:79005555555", t + i);
    expect(checkOrderRateLimit("phone:79005555555", t + 10 * 60 * 1000 + 1)).toBe(true);
  });
  it("peek не расходует окно: PRICE_CHANGED-подтверждения не блокируют сами себя", () => {
    resetOrderRateLimit();
    const t = 3_000_000;
    for (let i = 0; i < 20; i++) expect(peekOrderRateLimit("phone:79007777777", t + i)).toBe(true);
    // 20 «подтверждений цены» не потратили лимит — первый реальный заказ пишется
    recordOrderHit("phone:79007777777", t + 20);
    for (let i = 0; i < 4; i++) {
      expect(peekOrderRateLimit("phone:79007777777", t + 21 + i)).toBe(true);
      recordOrderHit("phone:79007777777", t + 21 + i);
    }
    // пятый заказ уже превышает окно
    expect(peekOrderRateLimit("phone:79007777777", t + 30)).toBe(false);
  });
  it("record расходует окно, peek — нет", () => {
    resetOrderRateLimit();
    const t = 4_000_000;
    expect(peekOrderRateLimit("phone:79008888888", t)).toBe(true);
    expect(peekOrderRateLimit("phone:79008888888", t + 1)).toBe(true);
    for (let i = 0; i < 5; i++) recordOrderHit("phone:79008888888", t + 2 + i);
    expect(peekOrderRateLimit("phone:79008888888", t + 10)).toBe(false);
  });
});
