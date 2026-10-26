import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  buildOrderCard,
  buildOrdersList,
  canViewOrderData,
  checkTransition,
  ORDER_STATUSES,
  type OrderRow,
} from "./orders";
import { can, type StaffMember } from "./permissions";

const order = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  name: "Иван",
  phone: "+7 900 123-45-67",
  comment: "Позвонить после 18:00",
  items: [{ title: "Аппарат", qty: 2, price: 1000, backorder: false }],
  total: 2000,
  created_at: "2026-10-24T00:00:00.000Z",
  status: "new",
  ...over,
});

const staff = (role: StaffMember["role"], elevated = false): StaffMember => ({
  telegram_id: 42,
  name: "Тест",
  role,
  elevated,
  active: true,
});

describe("приватность заказов", () => {
  it("ПДн показываются только в личном чате сотрудника", () => {
    expect(canViewOrderData({ id: 42, type: "private" }, { id: 42 })).toBe(true);
  });
  it("в группе данные скрыты", () => {
    expect(canViewOrderData({ id: -100, type: "group" }, { id: 42 })).toBe(false);
  });
  it("чужой приватный чат (chat.id !== from.id) — скрыто", () => {
    expect(canViewOrderData({ id: 99, type: "private" }, { id: 42 })).toBe(false);
  });
  it("без чата или отправителя — скрыто", () => {
    expect(canViewOrderData(null, { id: 42 })).toBe(false);
    expect(canViewOrderData({ id: 42, type: "private" }, null)).toBe(false);
  });
});

describe("RBAC заказов", () => {
  it("продавец, директор и админ управляют заказами", () => {
    expect(can(staff("seller"), "manage_orders")).toBe(true);
    expect(can(staff("director"), "manage_orders")).toBe(true);
    expect(can(staff("admin"), "manage_orders")).toBe(true);
  });
  it("посторонний и неактивный сотрудник — нет", () => {
    expect(can(null, "manage_orders")).toBe(false);
    expect(can({ ...staff("admin"), active: false }, "manage_orders")).toBe(false);
  });
});

describe("список заказов", () => {
  it("постраничный: 5 на страницу, навигация", () => {
    const orders = Array.from({ length: 7 }, (_, i) =>
      order({ id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, "0")}` }),
    );
    const p0 = buildOrdersList(orders, 0);
    expect(p0.text).toContain("Заказы (7)");
    // 5 кнопок заказов + навигация
    expect(p0.rows.length).toBe(6);
    const p1 = buildOrdersList(orders, 1);
    expect(p1.rows.length).toBe(3); // 2 заказа + навигация
  });
  it("пустой список", () => {
    expect(buildOrdersList([], 0).text).toContain("Заказов пока нет");
  });
  it("страница вне диапазона зажимается", () => {
    const p = buildOrdersList([order()], 99);
    expect(p.rows.length).toBe(2); // 1 заказ + навигация
  });
  it("callback_data заказа — безопасный короткий id в списке, полный uuid в кнопке", () => {
    const rows = buildOrdersList([order()], 0).rows;
    expect(rows[0]?.[0]?.callback_data).toBe("order:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(rows[0]?.[0]?.text).toContain("#aaaaaaaa");
  });
});

describe("карточка заказа", () => {
  it("содержит имя, телефон, состав и сумму", () => {
    const { text } = buildOrderCard(order(), "Никита");
    expect(text).toContain("Иван");
    expect(text).toContain("+7 900 123-45-67");
    expect(text).toContain("Аппарат");
    expect(text).toContain("2\u00A0000 ₽"); // ru-RU: неразрывный пробел
  });
  it("помечает позиции «под заказ»", () => {
    const o = order({ items: [{ title: "Аппарат", qty: 1, price: 10, backorder: true }] });
    expect(buildOrderCard(o, "x").text).toContain("под заказ");
  });
  it("для completed/canceled нужна отдельная кнопка подтверждения", () => {
    const { rows } = buildOrderCard(order({ status: "ready" }), "x");
    const flat = rows.flat();
    expect(
      flat.some(
        (b) => b.callback_data.startsWith("stc:") && b.callback_data.endsWith(":completed"),
      ),
    ).toBe(true);
    expect(
      flat.some((b) => b.callback_data.startsWith("stc:") && b.callback_data.endsWith(":canceled")),
    ).toBe(true);
  });
  it("без колонки статуса кнопки смены не показываются", () => {
    const { rows, text } = buildOrderCard(order({ status: null }), "x");
    expect(rows.flat().some((b) => b.callback_data.startsWith("st:"))).toBe(false);
    expect(text).toContain("статус не подключён");
  });
});

describe("переходы статусов", () => {
  it("допустимые переходы new→processing→ready→completed", () => {
    expect(checkTransition(order({ status: "new" }), "processing", true)).toMatchObject({
      ok: true,
    });
    expect(checkTransition(order({ status: "processing" }), "ready", true)).toMatchObject({
      ok: true,
    });
    expect(checkTransition(order({ status: "ready" }), "completed", true)).toMatchObject({
      ok: true,
    });
  });
  it("запрещённые переходы отклоняются", () => {
    expect(checkTransition(order({ status: "new" }), "completed", true).ok).toBe(false);
    expect(checkTransition(order({ status: "completed" }), "processing", true).ok).toBe(false);
    expect(checkTransition(order({ status: "canceled" }), "new", true).ok).toBe(false);
  });
  it("без колонки статуса — graceful отказ, не падение", () => {
    const r = checkTransition(order({ status: "new" }), "processing", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("после обновления базы");
  });
  it("все статусы покрыты картой переходов", () => {
    for (const s of ORDER_STATUSES) expect(Array.isArray(ALLOWED_TRANSITIONS[s])).toBe(true);
  });
});
