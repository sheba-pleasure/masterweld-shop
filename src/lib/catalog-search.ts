/** Public catalog state shared by the listing and the return link on a product. */
export type CatalogSearch = {
  cat?: string | undefined;
  q?: string | undefined;
  brand?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  instock?: "1" | undefined;
  sale?: "1" | undefined;
  sort?: string | undefined;
};

// TanStack parses JSON-compatible query values before validation. Handwritten/shared
// URLs such as ?min=800&instock=1 therefore arrive as numbers, not strings.
function priceSearchValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? String(value)
    : undefined;
}

export function validateCatalogSearch(s: Record<string, unknown>): CatalogSearch {
  return {
    cat: typeof s["cat"] === "string" ? s["cat"] : undefined,
    q:
      typeof s["q"] === "string"
        ? s["q"]
        : typeof s["q"] === "number" && Number.isFinite(s["q"])
          ? String(s["q"])
          : undefined,
    brand: typeof s["brand"] === "string" ? s["brand"] : undefined,
    min: priceSearchValue(s["min"]),
    max: priceSearchValue(s["max"]),
    instock: s["instock"] === "1" || s["instock"] === 1 ? "1" : undefined,
    sale: s["sale"] === "1" || s["sale"] === 1 ? "1" : undefined,
    sort: typeof s["sort"] === "string" ? s["sort"] : undefined,
  };
}
