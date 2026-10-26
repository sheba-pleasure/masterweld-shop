import { describe, expect, it } from "vitest";
import {
  beforeMatches,
  checkPending,
  describePendingChange,
  describePriceChange,
  describeStockChange,
  isMissingTableError,
  PENDING_PERMISSION,
  PENDING_REASON_MSG,
  PENDING_TTL_MS,
  type PendingActionKind,
  type PendingRow,
} from "./pending";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

const row = (over: Partial<PendingRow> = {}): PendingRow => ({
  id: "33333333-3333-4333-8333-333333333333",
  staff_telegram_id: 42,
  product_id: "11111111-1111-4111-8111-111111111111",
  action: "price",
  before_value: { price: 4500 },
  after_value: { price: 4900 },
  expires_at: new Date(NOW + PENDING_TTL_MS).toISOString(),
  consumed_at: null,
  ...over,
});

describe("TTL и одноразовость pending-действий", () => {
  it("свежее действие владельца — можно подтверждать", () => {
    expect(checkPending(row(), 42, NOW)).toEqual({ ok: true });
  });

  it("истечение TTL: за секунду до истечения можно, в момент истечения — нет", () => {
    const exp = NOW + PENDING_TTL_MS;
    expect(checkPending(row(), 42, exp - 1000)).toEqual({ ok: true });
    expect(checkPending(row(), 42, exp)).toEqual({ ok: false, reason: "expired" });
    expect(checkPending(row(), 42, exp + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("битый expires_at считается истёкшим", () => {
    expect(checkPending(row({ expires_at: "не дата" }), 42, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("anti-replay: применённое/отменённое действие повторно не подтверждается", () => {
    const consumed = row({ consumed_at: new Date(NOW - 1000).toISOString() });
    expect(checkPending(consumed, 42, NOW)).toEqual({ ok: false, reason: "consumed" });
  });

  it("владелец: чужое действие подтвердить нельзя", () => {
    expect(checkPending(row(), 99, NOW)).toEqual({ ok: false, reason: "not_owner" });
  });

  it("отсутствующее действие — not_found", () => {
    expect(checkPending(null, 42, NOW)).toEqual({ ok: false, reason: "not_found" });
  });

  it("на каждый отказ есть понятное сообщение", () => {
    for (const reason of ["not_found", "not_owner", "expired", "consumed"]) {
      expect(PENDING_REASON_MSG[reason]).toBeTruthy();
    }
  });
});

describe("сравнение старого значения (защита от гонок)", () => {
  it("цена совпала — можно применять; расхождение — нет", () => {
    expect(beforeMatches("price", { price: 4500, in_stock: true }, { price: 4500 })).toBe(true);
    expect(beforeMatches("price", { price: 4600, in_stock: true }, { price: 4500 })).toBe(false);
  });

  it("цена сравнивается точно, копейки учитываются", () => {
    expect(beforeMatches("price", { price: 1250.5, in_stock: true }, { price: 1250.5 })).toBe(true);
    expect(beforeMatches("price", { price: 1250.51, in_stock: true }, { price: 1250.5 })).toBe(
      false,
    );
  });

  it("наличие совпало — можно применять; расхождение — нет", () => {
    expect(beforeMatches("stock", { price: 100, in_stock: false }, { in_stock: false })).toBe(true);
    expect(beforeMatches("stock", { price: 100, in_stock: true }, { in_stock: false })).toBe(false);
  });

  it("повреждённый или подменённый before_value отклоняется", () => {
    expect(beforeMatches("price", { price: 4500, in_stock: true }, null)).toBe(false);
    expect(beforeMatches("price", { price: 4500, in_stock: true }, "4500")).toBe(false);
    expect(beforeMatches("price", { price: 4500, in_stock: true }, { price: "4500" })).toBe(false);
    expect(beforeMatches("stock", { price: 1, in_stock: true }, { in_stock: 1 })).toBe(false);
    expect(beforeMatches("stock", { price: 1, in_stock: true }, {})).toBe(false);
  });

  it("текстовые поля: совпадение/null-безопасность", () => {
    expect(beforeMatches("title", { title: "Горелка" }, { title: "Горелка" })).toBe(true);
    expect(beforeMatches("title", { title: "Горелка" }, { title: "Другое" })).toBe(false);
    expect(beforeMatches("brand", { brand: null }, { brand: null })).toBe(true);
    expect(beforeMatches("brand", { brand: null }, { brand: "X" })).toBe(false);
    expect(beforeMatches("sku", { sku: "MW-1" }, {})).toBe(false);
  });

  it("раздел и статус: сравнение по значению", () => {
    expect(beforeMatches("category", { category_id: null }, { category_id: null })).toBe(true);
    expect(beforeMatches("category", { category_id: "a" }, { category_id: "b" })).toBe(false);
    expect(beforeMatches("status", { status: "draft" }, { status: "draft" })).toBe(true);
    expect(beforeMatches("status", { status: "draft" }, { status: "published" })).toBe(false);
  });
});

describe("описания изменений", () => {
  it("цена: было → станет с рублями", () => {
    expect(describePriceChange(4500, 4900)).toBe("4 500 ₽ → 4 900 ₽");
  });
  it("наличие: подписи без обещаний остатка", () => {
    expect(describeStockChange(false, true)).toBe("Под заказ → Отмечено в наличии");
    expect(describeStockChange(true, false)).toBe("Отмечено в наличии → Под заказ");
  });
  it("describePendingChange покрывает все типы действий", () => {
    expect(describePendingChange("price", { price: 4500 }, { price: 4900 })).toContain("4 500 ₽");
    expect(describePendingChange("stock", { in_stock: false }, { in_stock: true })).toContain(
      "Отмечено в наличии",
    );
    expect(describePendingChange("title", { title: "Старое" }, { title: "Новое" })).toBe(
      "название: Старое → Новое",
    );
    expect(describePendingChange("category", {}, {})).toBe("перенесён в другой раздел");
    expect(describePendingChange("status", { status: "draft" }, { status: "published" })).toBe(
      "статус: черновик → на витрине",
    );
  });
});

describe("права по типам действий (RBAC на подтверждении)", () => {
  it("каждое действие C1/C2A сопоставлено с правом", () => {
    const kinds: PendingActionKind[] = [
      "price",
      "stock",
      "title",
      "description",
      "specs",
      "brand",
      "sku",
      "category",
      "status",
    ];
    for (const k of kinds) expect(PENDING_PERMISSION[k]).toBeTruthy();
    expect(PENDING_PERMISSION.price).toBe("edit_prices");
    expect(PENDING_PERMISSION.stock).toBe("edit_stock");
    expect(PENDING_PERMISSION.title).toBe("edit_products");
    expect(PENDING_PERMISSION.category).toBe("manage_categories");
    expect(PENDING_PERMISSION.status).toBe("publish_products");
  });
});

describe("определение отсутствующей таблицы pending_actions", () => {
  it("распознаёт ошибку «таблицы нет» (миграция 0005 не применена)", () => {
    expect(
      isMissingTableError({
        code: "42P01",
        message: 'relation "public.pending_actions" does not exist',
      }),
    ).toBe(true);
    expect(
      isMissingTableError({
        message: "could not find the table 'public.pending_actions' in the schema cache",
      }),
    ).toBe(true);
  });
  it("прочие ошибки и пустые значения — не «таблицы нет»", () => {
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
    expect(isMissingTableError({ code: "23505", message: "duplicate key" })).toBe(false);
  });
});
