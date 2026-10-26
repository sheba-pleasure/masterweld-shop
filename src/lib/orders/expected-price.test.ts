import { describe, expect, it } from "vitest";
import {
  checkExpectedPrice,
  computeOrder,
  orderPayloadSchema,
  type OrderPayload,
  type OrderProductRow,
  type OrderSnapshotItem,
} from "./schema";

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

const snap = (over: Partial<OrderSnapshotItem> = {}): OrderSnapshotItem => ({
  product_id: "11111111-1111-4111-8111-111111111111",
  slug: "tovar",
  title: "Товар",
  price: 100,
  qty: 2,
  backorder: false,
  ...over,
});

describe("ожидание цены: схема", () => {
  it("принимает корректное expected", () => {
    const r = orderPayloadSchema.safeParse(
      payload({
        expected: {
          total: 200,
          items: [{ product_id: P().id, unit_price: 100 }],
        },
      } as never),
    );
    expect(r.success).toBe(true);
  });
  it("принимает payload без expected (обратная совместимость формы)", () => {
    expect(orderPayloadSchema.safeParse(payload()).success).toBe(true);
  });
  it("отклоняет отрицательный expected.total", () => {
    expect(
      orderPayloadSchema.safeParse(payload({ expected: { total: -1 } } as never)).success,
    ).toBe(false);
  });
  it("отклоняет нечисловой expected.total", () => {
    expect(
      orderPayloadSchema.safeParse(payload({ expected: { total: Number.NaN } } as never)).success,
    ).toBe(false);
  });
  it("отклоняет отрицательный unit_price", () => {
    expect(
      orderPayloadSchema.safeParse(
        payload({
          expected: { total: 0, items: [{ product_id: P().id, unit_price: -5 }] },
        } as never),
      ).success,
    ).toBe(false);
  });
});

describe("checkExpectedPrice: сверка в копейках", () => {
  it("совпадающая цена принимается", () => {
    const r = checkExpectedPrice(
      { total: 200, items: [snap()] },
      { total: 200, items: [{ product_id: snap().product_id, unit_price: 100 }] },
    );
    expect(r).toEqual({ ok: true });
  });

  it("цена выросла → PRICE_CHANGED", () => {
    const r = checkExpectedPrice(
      { total: 250, items: [snap({ price: 125 })] },
      { total: 200, items: [{ product_id: snap().product_id, unit_price: 100 }] },
    );
    expect(r).toEqual({ ok: false, code: "PRICE_CHANGED" });
  });

  it("цена снизилась → PRICE_CHANGED (тоже требует подтверждения)", () => {
    const r = checkExpectedPrice(
      { total: 160, items: [snap({ price: 80 })] },
      { total: 200, items: [{ product_id: snap().product_id, unit_price: 100 }] },
    );
    expect(r).toEqual({ ok: false, code: "PRICE_CHANGED" });
  });

  it("устаревшая корзина не проходит, пока не подтверждена заново", () => {
    const computed = { total: 250, items: [snap({ price: 125 })] };
    // первая попытка со старым ожиданием — отказ
    expect(checkExpectedPrice(computed, { total: 200 })).toEqual({
      ok: false,
      code: "PRICE_CHANGED",
    });
    // повторная попытка с обновлённым ожиданием — принимается
    expect(checkExpectedPrice(computed, { total: 250 })).toEqual({ ok: true });
  });

  it("вторая смена цены снова требует подтверждения", () => {
    const stale = { total: 250 };
    // подтвердили 250, но цена снова изменилась на 300
    expect(checkExpectedPrice({ total: 300, items: [snap({ price: 150 })] }, stale)).toEqual({
      ok: false,
      code: "PRICE_CHANGED",
    });
  });

  it("отсутствие expected — fail closed (нужно подтверждение)", () => {
    expect(checkExpectedPrice({ total: 200, items: [snap()] }, undefined)).toEqual({
      ok: false,
      code: "PRICE_CHANGED",
    });
    expect(checkExpectedPrice({ total: 200, items: [snap()] }, null)).toEqual({
      ok: false,
      code: "PRICE_CHANGED",
    });
  });

  it("expected только по total без строк принимается при совпадении суммы", () => {
    expect(checkExpectedPrice({ total: 200, items: [snap()] }, { total: 200 })).toEqual({
      ok: true,
    });
  });

  it("расхождение unit_price при совпавшем total отклоняется", () => {
    const items = [
      snap({ price: 60 }),
      snap({ product_id: "22222222-2222-4222-8222-222222222222", price: 140 }),
    ];
    const r = checkExpectedPrice(
      { total: 200, items },
      {
        total: 200,
        items: [
          { product_id: snap().product_id, unit_price: 50 }, // корзина «врала» по строке
          { product_id: "22222222-2222-4222-8222-222222222222", unit_price: 150 },
        ],
      },
    );
    expect(r).toEqual({ ok: false, code: "PRICE_CHANGED" });
  });

  it("дубли product_id в expected с одинаковой ценой допустимы", () => {
    const r = checkExpectedPrice(
      { total: 200, items: [snap()] },
      {
        total: 200,
        items: [
          { product_id: snap().product_id, unit_price: 100 },
          { product_id: snap().product_id, unit_price: 100 },
        ],
      },
    );
    expect(r).toEqual({ ok: true });
  });

  it("дубли product_id в expected с разными ценами — противоречивое ожидание, отказ", () => {
    const r = checkExpectedPrice(
      { total: 200, items: [snap()] },
      {
        total: 200,
        items: [
          { product_id: snap().product_id, unit_price: 100 },
          { product_id: snap().product_id, unit_price: 90 },
        ],
      },
    );
    expect(r).toEqual({ ok: false, code: "PRICE_CHANGED" });
  });

  it("float-артефакты: 100.005 vs 100.01 в копейках совпадают", () => {
    const r = checkExpectedPrice(
      { total: 100.01, items: [snap({ price: 100.01 })] },
      { total: 100.005, items: [{ product_id: snap().product_id, unit_price: 100.005 }] },
    );
    expect(r).toEqual({ ok: true });
  });

  it("разница в одну копейку отклоняется", () => {
    const r = checkExpectedPrice({ total: 200.01, items: [snap({ price: 100 })] }, { total: 200 });
    expect(r).toEqual({ ok: false, code: "PRICE_CHANGED" });
  });

  it("скрытая/черновая позиция отсекается ДО сверки цены (fail closed)", () => {
    // computeOrder отклоняет draft/hidden раньше, чем checkExpectedPrice
    const r = computeOrder(payload(), [P({ status: "draft" })]);
    expect(r).toMatchObject({ ok: false, code: "NOT_PUBLISHED" });
    const r2 = computeOrder(payload(), [P({ status: "hidden" })]);
    expect(r2).toMatchObject({ ok: false, code: "NOT_PUBLISHED" });
  });

  it("нельзя доверять произвольной клиентской сумме: сервер считает сам", () => {
    // клиент «ожидает» 1 ₽ при реальной цене 100 ₽ × 2 — отказ
    const computed = computeOrder(payload(), [P({ price: 100 })]);
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    const r = checkExpectedPrice(computed, { total: 1 });
    expect(r).toEqual({ ok: false, code: "PRICE_CHANGED" });
    // даже «правдоподобная» попытка unit_price=1 при qty=2 не проходит
    const r2 = checkExpectedPrice(computed, {
      total: 2,
      items: [{ product_id: P().id, unit_price: 1 }],
    });
    expect(r2).toEqual({ ok: false, code: "PRICE_CHANGED" });
  });

  it("дубли позиций корзины склеиваются сервером до сверки", () => {
    const computed = computeOrder(
      payload({
        items: [
          { product_id: P().id, qty: 2 },
          { product_id: P().id, qty: 3 },
        ],
      }),
      [P({ price: 10 })],
    );
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    expect(computed.total).toBe(50);
    // ожидание с корректным объединённым итогом проходит
    expect(checkExpectedPrice(computed, { total: 50 })).toEqual({ ok: true });
    // ожидание «как из двух строк корзины» тоже проходит, если цены совпадают
    expect(
      checkExpectedPrice(computed, {
        total: 50,
        items: [
          { product_id: P().id, unit_price: 10 },
          { product_id: P().id, unit_price: 10 },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("in_stock=false — это «под заказ», а не обещание срока", () => {
    const computed = computeOrder(payload(), [P({ in_stock: false })]);
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    expect(computed.hasBackorder).toBe(true);
    expect(computed.items[0]?.backorder).toBe(true);
    // и такая позиция спокойно проходит сверку цены
    expect(checkExpectedPrice(computed, { total: 200 })).toEqual({ ok: true });
  });
});
