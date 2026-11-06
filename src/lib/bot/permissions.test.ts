import { describe, expect, it } from "vitest";
import { can, type StaffMember } from "./permissions";

const m = (role: StaffMember["role"], elevated = false): StaffMember => ({
  telegram_id: 1,
  name: "x",
  role,
  elevated,
  active: true,
});

describe("bot permissions", () => {
  it("unknown runtime role fails closed", () =>
    expect(can(m("viewer" as StaffMember["role"]), "manage_orders")).toBe(false));
  it("seller cannot see costs", () => expect(can(m("seller"), "view_costs")).toBe(false));
  it("seller cannot edit sale prices", () => expect(can(m("seller"), "edit_prices")).toBe(false));
  it("seller cannot delete items", () => expect(can(m("seller"), "delete_items")).toBe(false));
  it("seller can edit products", () => expect(can(m("seller"), "edit_products")).toBe(true));
  it("seller cannot publish, move categories or edit prices (права не расширяются молча)", () => {
    expect(can(m("seller"), "publish_products")).toBe(false);
    expect(can(m("seller"), "manage_categories")).toBe(false);
    expect(can(m("seller"), "edit_prices")).toBe(false);
  });
  it("director in simple mode cannot publish or move categories", () => {
    expect(can(m("director"), "publish_products")).toBe(false);
    expect(can(m("director"), "manage_categories")).toBe(false);
  });
  it("director with full access can publish and move categories", () => {
    expect(can(m("director", true), "publish_products")).toBe(true);
    expect(can(m("director", true), "manage_categories")).toBe(true);
  });
  it("admin can publish and move categories", () => {
    expect(can(m("admin"), "publish_products")).toBe(true);
    expect(can(m("admin"), "manage_categories")).toBe(true);
  });
  it("director sees costs and edits prices", () => {
    expect(can(m("director"), "view_costs")).toBe(true);
    expect(can(m("director"), "edit_prices")).toBe(true);
  });
  it("director in simple mode cannot manage staff", () =>
    expect(can(m("director"), "manage_staff")).toBe(false));
  it("director with full access can manage staff", () =>
    expect(can(m("director", true), "manage_staff")).toBe(true));
  it("admin manages staff", () => expect(can(m("admin"), "manage_staff")).toBe(true));
  it("unknown user has no access", () => expect(can(null, "edit_products")).toBe(false));
  it("inactive staff has no access", () =>
    expect(can({ ...m("admin"), active: false }, "edit_products")).toBe(false));
});
