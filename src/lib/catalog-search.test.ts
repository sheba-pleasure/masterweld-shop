import { describe, expect, it } from "vitest";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { validateCatalogSearch } from "./catalog-search";

describe("shared catalog links", () => {
  it("preserves prices and switches from a direct URL after router parsing", () => {
    expect(
      validateCatalogSearch(defaultParseSearch("?min=800&max=3000&instock=1&sale=1&q=1697")),
    ).toMatchObject({
      min: "800",
      max: "3000",
      instock: "1",
      sale: "1",
      q: "1697",
    });
  });
  it("round-trips a product return link without losing a leading-zero SKU", () => {
    const state = {
      cat: "welding",
      q: "0001697",
      brand: "foxweld",
      min: "800",
      max: "3000",
      sort: "price-desc",
      instock: "1",
      sale: "1",
    };
    expect(validateCatalogSearch(defaultParseSearch(defaultStringifySearch(state)))).toEqual(state);
  });
  it("does not accept arrays, objects, boolean switches, unsafe numbers or auth parameters", () => {
    const actual = validateCatalogSearch({
      cat: [],
      q: {},
      min: -1,
      max: Infinity,
      instock: true,
      sale: "true",
      role: "admin",
      returnTo: "https://example.com",
    });
    expect(Object.values(actual).every((v) => v === undefined)).toBe(true);
    expect(actual).not.toHaveProperty("role");
    expect(actual).not.toHaveProperty("returnTo");
  });
});
