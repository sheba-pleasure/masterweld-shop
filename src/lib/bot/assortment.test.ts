import { describe, expect, it } from "vitest";
import {
  assortmentError,
  assortmentView,
  parseAssortmentCallback,
  type AssortmentResult,
} from "./assortment";
import { can, type StaffMember } from "./permissions";
const id = "11111111-1111-4111-8111-111111111111";
const sample: AssortmentResult = {
  ok: true,
  id,
  state: "selecting",
  action: null,
  query: "маска",
  filter: "all",
  revision: 9999999,
  total: 5000,
  selected: 5000,
  page: 624,
  pages: 625,
  counts: { published: 4000, draft: 500, hidden: 500 },
  items: Array.from({ length: 8 }, (_, i) => ({
    position: 4993 + i,
    title: "М".repeat(250),
    sku: "A".repeat(150),
    category: "Р".repeat(100),
    selected: true,
    before_decision: "review",
    before_status: "published",
  })),
};
describe("assortment interface", () => {
  it.each(["selecting", "preview", "applied", "undo_preview", "undone", "canceled"])(
    "%s buttons fit Telegram limits and parse without losing identity",
    (state) => {
      const view = assortmentView({ ...sample, state, action: "exclude" });
      expect(view.text.length).toBeLessThan(4000);
      for (const b of view.rows.flat()) {
        expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
        expect(parseAssortmentCallback(b.callback_data)).not.toBeNull();
      }
    },
  );
  it("freezes explicit desired selection and preview revision", () => {
    expect(parseAssortmentCallback(`as:unselect:${id}:5000:624`)).toEqual({
      p_op: "unselect",
      p_batch_id: id,
      p_value: "5000",
      p_page: 624,
    });
    expect(parseAssortmentCallback(`as:preview:${id}:exclude:7`)).toEqual({
      p_op: "preview",
      p_batch_id: id,
      p_value: "exclude",
      p_revision: 7,
    });
  });
  it.each([
    "as:apply:bad",
    `as:preview:${id}:delete:7`,
    `as:select:${id}:-1:0`,
    "as:start:unknown",
    `as:get:${id}:9999`,
  ])("rejects malformed %s", (value) => expect(parseAssortmentCallback(value)).toBeNull());
  it("does not offer confirmation before selection or label archival as permanent deletion", () => {
    const view = assortmentView({ ...sample, selected: 0 });
    expect(view.rows.flat().some((b) => b.callback_data.startsWith("as:preview"))).toBe(false);
    const preview = assortmentView({ ...sample, state: "preview", action: "exclude" });
    expect(preview.text).toContain("сохранятся");
    expect(
      preview.rows
        .flat()
        .some(
          (b) =>
            b.text.includes("Подтвердить для 5000 товаров") && b.callback_data === `as:apply:${id}`,
        ),
    ).toBe(true);
  });
  it("requires a separate undo preview, and distinguishes assortment from publication", () => {
    const view = assortmentView({ ...sample, state: "applied", action: "sell" });
    expect(view.text).toContain("Скрытые товары останутся скрытыми");
    expect(view.rows.flat().some((b) => b.callback_data === `as:undo_preview:${id}`)).toBe(true);
    expect(view.rows.flat().some((b) => b.callback_data === `as:undo:${id}`)).toBe(false);
  });
  it("unknown outcome does not claim nothing changed or expose errors", () => {
    const text = assortmentError("password=SECRET");
    expect(text).not.toContain("SECRET");
    expect(text).toContain("не подтверждён");
  });
});
describe("assortment permission", () => {
  it.each([
    ["admin", false, true, true],
    ["director", true, true, true],
    ["director", false, true, false],
    ["seller", false, true, false],
    ["admin", false, false, false],
  ] as const)("%s elevated=%s active=%s", (role, elevated, active, allowed) => {
    expect(
      can(
        { role, elevated, active, telegram_id: 1, name: "QA" } as StaffMember,
        "manage_assortment",
      ),
    ).toBe(allowed);
  });
});
