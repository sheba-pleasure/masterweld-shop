// Чистые функции поиска, фильтрации и сортировки каталога.
// Ничего не знают о React — покрыты юнит-тестами и переиспользуются витриной.

export interface SearchableProduct {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  sku?: string | null;
  price: number | null;
  old_price: number | null;
  in_stock: boolean;
  category_id: string | null;
}

/** Нормализация текста для поиска: регистр, ё→е, тире, лишние пробелы. */
export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();
}

/** Скидка показывается только когда старое цена реально выше текущей. */
export function isDiscounted(p: Pick<SearchableProduct, "price" | "old_price">): boolean {
  return (
    p.price !== null &&
    p.old_price !== null &&
    p.old_price !== undefined &&
    Number(p.old_price) > Number(p.price)
  );
}

export type CatalogSort = "name" | "price-asc" | "price-desc";

export const CATALOG_SORTS: { value: CatalogSort; label: string }[] = [
  { value: "name", label: "Название (А–Я)" },
  { value: "price-asc", label: "Цена: сначала дешёвые" },
  { value: "price-desc", label: "Цена: сначала дорогие" },
];

export interface CatalogQuery {
  /** Поиск по названию, артикулу (SKU) и бренду. Несколько слов — все должны найтись. */
  q?: string | undefined;
  brand?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  inStock?: boolean | undefined;
  onSale?: boolean | undefined;
  sort?: CatalogSort | undefined;
}

/**
 * Поиск + фильтры + сортировка за один проход.
 * Текстовые совпадения в названии — это поиск, а не доказательство совместимости:
 * никакие технические параметры здесь не выводятся.
 */
export function searchProducts<T extends SearchableProduct>(
  products: T[],
  query: CatalogQuery = {},
): T[] {
  const tokens = normalizeText(query.q ?? "")
    .split(" ")
    .filter(Boolean);
  const brand = query.brand ? normalizeText(query.brand) : undefined;
  const minPrice = query.minPrice;
  const maxPrice = query.maxPrice;

  const result = products.filter((p) => {
    if (brand && normalizeText(p.brand ?? "") !== brand) return false;
    if (p.price === null && (minPrice !== undefined || maxPrice !== undefined)) return false;
    if (minPrice !== undefined && Number(p.price) < minPrice) return false;
    if (maxPrice !== undefined && Number(p.price) > maxPrice) return false;
    if (query.inStock && !p.in_stock) return false;
    if (query.onSale && !isDiscounted(p)) return false;
    if (tokens.length > 0) {
      const haystack = normalizeText([p.title, p.brand ?? "", p.sku ?? ""].join(" "));
      for (const token of tokens) {
        if (!haystack.includes(token)) return false;
      }
    }
    return true;
  });

  const sort = query.sort ?? "name";
  const sorted = [...result];
  if (sort === "price-asc") sorted.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  else if (sort === "price-desc")
    sorted.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
  else sorted.sort((a, b) => a.title.localeCompare(b.title, "ru"));
  return sorted;
}

/** Парсит цену из поля фильтра: «12 500», «12500», «12 500,5» → число или undefined. */
export function parsePriceInput(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
