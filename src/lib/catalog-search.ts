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

export function validateCatalogSearch(s: Record<string, unknown>): CatalogSearch {
  return {
    cat: typeof s["cat"] === "string" ? s["cat"] : undefined,
    q: typeof s["q"] === "string" ? s["q"] : undefined,
    brand: typeof s["brand"] === "string" ? s["brand"] : undefined,
    min: typeof s["min"] === "string" ? s["min"] : undefined,
    max: typeof s["max"] === "string" ? s["max"] : undefined,
    instock: s["instock"] === "1" ? "1" : undefined,
    sale: s["sale"] === "1" ? "1" : undefined,
    sort: typeof s["sort"] === "string" ? s["sort"] : undefined,
  };
}
