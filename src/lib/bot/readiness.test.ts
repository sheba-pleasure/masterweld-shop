import { describe, expect, it } from "vitest";
import { can, type StaffMember, type Permission } from "./permissions";
import { orderDateMoscow } from "./orders";
import { deliveryReport } from "./deliveries";
describe("small shop staff contract", () => {
  for (const name of ["Валентина (учебная роль)", "Светлана (учебная роль)"]) {
    const staff: StaffMember = {
      name,
      telegram_id: 42,
      role: "seller",
      active: true,
      elevated: false,
    };
    it(name + ": orders/catalog/stock allowed; money and staff administration denied", () => {
      for (const p of [
        "manage_orders",
        "edit_products",
        "upload_photos",
        "edit_stock",
      ] as Permission[])
        expect(can(staff, p)).toBe(true);
      for (const p of [
        "view_costs",
        "edit_prices",
        "manage_staff",
        "view_audit",
        "import_prices",
        "publish_products",
        "toggle_full_access",
      ] as Permission[])
        expect(can(staff, p)).toBe(false);
      expect(can({ ...staff, elevated: true }, "view_costs")).toBe(false);
      expect(can({ ...staff, active: false }, "manage_orders")).toBe(false);
    });
  }
  it("Moscow date handles midnight and explicit offsets", () => {
    expect(orderDateMoscow("2026-11-06T22:15:00Z")).toBe("07.11.2026, 01:15 МСК");
    expect(orderDateMoscow("2026-11-07T01:15:00+03:00")).toBe("07.11.2026, 01:15 МСК");
    expect(orderDateMoscow("broken")).toBe("дата недоступна");
  });
  it("uncertain delivery gives a safe next step, no resend control", () => {
    const r = deliveryReport([
      {
        order_id: "11111111-1111-4111-8111-111111111111",
        staff_telegram_id: 42,
        state: "uncertain",
        updated_at: "2026-11-06",
      },
    ]);
    expect(r.text).toContain("сначала проверьте чат");
    expect(r.rows.flat().map((b) => b.callback_data)).toEqual([
      "order:11111111-1111-4111-8111-111111111111",
    ]);
  });
});
