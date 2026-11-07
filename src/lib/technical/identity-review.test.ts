import { expect, it } from "vitest";
import { changesTechnicalIdentity, technicalIdentityConsequence } from "./identity-review";

it.each(["title", "brand", "sku", "category_id"])(
  "warns before changing %s, including clearing it",
  (field) => {
    expect(changesTechnicalIdentity({ [field]: "A" }, { [field]: "B" })).toBe(true);
    expect(changesTechnicalIdentity({ [field]: "A" }, { [field]: null })).toBe(true);
    expect(changesTechnicalIdentity({ [field]: null }, { [field]: "A" })).toBe(true);
  },
);
it("does not treat omitted fields, price, stock or unchanged identity as a model change", () => {
  expect(changesTechnicalIdentity({ title: "A", price: 10 }, { title: "A", price: 20 })).toBe(
    false,
  );
  expect(changesTechnicalIdentity({ brand: "A" }, { price: 20 })).toBe(false);
  expect(changesTechnicalIdentity({ stock_qty: 1 }, { stock_qty: 0 })).toBe(false);
  expect(changesTechnicalIdentity(null, {})).toBe(false);
  expect(changesTechnicalIdentity([], [])).toBe(false);
});
it("explains the visible consequence, recovery route and limits of returning old fields", () => {
  expect(technicalIdentityConsequence).toContain("снимает прежние подтверждённые характеристики");
  expect(technicalIdentityConsequence).toContain("«Редактировать» → «Проверенные характеристики»");
  expect(technicalIdentityConsequence).toContain("не подтверждает характеристики автоматически");
});
