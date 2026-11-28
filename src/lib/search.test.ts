import { describe, expect, it } from "vitest";

import {
  CATALOG_SORTS,
  isDiscounted,
  normalizeText,
  parsePriceInput,
  searchProducts,
  type SearchableProduct,
} from "@/lib/search";

function p(over: Partial<SearchableProduct> & { id: string }): SearchableProduct {
  return {
    slug: over.id,
    title: "Товар",
    brand: null,
    sku: null,
    price: 1000,
    old_price: null,
    in_stock: true,
    category_id: null,
    ...over,
  };
}

const fox = p({
  id: "1",
  title: "Сварочный инвертор FoxWeld Инвертор 200",
  brand: "FoxWeld",
  sku: "FW-INV-200",
  price: 25000,
});
const tig = p({
  id: "2",
  title: "Горелка TIG-26 с шлангом",
  brand: "Varteg",
  sku: "VG-TIG26",
  price: 8500,
  in_stock: false,
});
const rod = p({
  id: "3",
  title: "Электроды УОНИ 13/55",
  brand: null,
  sku: "UONI-1355",
  price: 340,
  old_price: 420,
});
const mask = p({
  id: "4",
  title: "Маска сварочная ХАМЕЛЕОН ЁЖ",
  brand: "FoxWeld",
  sku: "FW-MASK-1",
  price: 3200,
  old_price: 3200,
});
const all = [fox, tig, rod, mask];

describe("Цена по запросу", () => {
  const inquiry = p({ id: "inquiry", title: "Сварог", sku: "SW-1", price: null, old_price: 1000 });

  it("находится по артикулу и не считается скидкой от нулевой цены", () => {
    expect(searchProducts([inquiry, ...all], { q: "SW-1" })).toEqual([inquiry]);
    expect(isDiscounted(inquiry)).toBe(false);
    expect(searchProducts([inquiry], { onSale: true })).toEqual([]);
  });

  it("не входит в числовой диапазон цены", () => {
    expect(searchProducts([inquiry], { minPrice: 0 })).toEqual([]);
    expect(searchProducts([inquiry], { maxPrice: 1000000 })).toEqual([]);
  });

  it("показывается после известных цен в обоих направлениях сортировки", () => {
    const list = [inquiry, fox, rod];
    expect(searchProducts(list, { sort: "price-asc" }).map((item) => item.id)).toEqual(["3", "1", "inquiry"]);
    expect(searchProducts(list, { sort: "price-desc" }).map((item) => item.id)).toEqual(["1", "3", "inquiry"]);
  });
});

describe("normalizeText", () => {
  it("приводит регистр, ё→е, тире и лишние пробелы к одному виду", () => {
    expect(normalizeText("  Горелка  TIG—26  ")).toBe("горелка tig-26");
    expect(normalizeText("ЁЖ")).toBe("еж");
    expect(normalizeText("a – b")).toBe("a - b");
  });
});

describe("isDiscounted", () => {
  it("истинно только когда old_price реально выше price", () => {
    expect(isDiscounted(rod)).toBe(true);
    expect(isDiscounted(mask)).toBe(false);
    expect(isDiscounted(fox)).toBe(false);
  });
});

describe("searchProducts — поиск", () => {
  it("находит по части названия без учёта регистра", () => {
    expect(searchProducts(all, { q: "инвертор" }).map((x) => x.id)).toEqual(["1"]);
    expect(searchProducts(all, { q: "ИНВЕРТОР" }).map((x) => x.id)).toEqual(["1"]);
  });

  it("находит по артикулу SKU", () => {
    expect(searchProducts(all, { q: "vg-tig26" }).map((x) => x.id)).toEqual(["2"]);
    expect(searchProducts(all, { q: "UONI 1355" }).map((x) => x.id)).toEqual(["3"]);
  });

  it("находит по бренду", () => {
    expect(searchProducts(all, { q: "foxweld" }).map((x) => x.id)).toEqual(["4", "1"]);
  });

  it("находит по модели внутри названия", () => {
    expect(searchProducts(all, { q: "TIG-26" }).map((x) => x.id)).toEqual(["2"]);
    expect(searchProducts(all, { q: "тиг 26" }).map((x) => x.id)).toEqual([]); // без догадок: другой алфавит не совпадает
  });

  it("нормализует ё→е в запросе", () => {
    expect(searchProducts(all, { q: "хамелеон еж" }).map((x) => x.id)).toEqual(["4"]);
  });

  it("требует все слова запроса (AND), порядок не важен", () => {
    expect(searchProducts(all, { q: "200 инвертор" }).map((x) => x.id)).toEqual(["1"]);
    expect(searchProducts(all, { q: "инвертор горелка" }).map((x) => x.id)).toEqual([]);
  });

  it("пустой запрос возвращает всё", () => {
    expect(searchProducts(all, { q: "   " })).toHaveLength(4);
  });

  it("понятное пустое состояние: нет совпадений — пустой список", () => {
    expect(searchProducts(all, { q: "ничего такого" })).toEqual([]);
  });
});

describe("searchProducts — фильтры", () => {
  it("фильтрует по бренду точно", () => {
    expect(searchProducts(all, { brand: "foxweld" }).map((x) => x.id)).toEqual(["4", "1"]);
  });

  it("фильтрует по диапазону цены", () => {
    expect(searchProducts(all, { minPrice: 5000, maxPrice: 20000 }).map((x) => x.id)).toEqual([
      "2",
    ]);
  });

  it("фильтрует по отметке наличия", () => {
    expect(searchProducts(all, { inStock: true }).map((x) => x.id)).toEqual(["4", "1", "3"]);
  });

  it("фильтрует «Цена снижена» только по факту old_price > price", () => {
    expect(searchProducts(all, { onSale: true }).map((x) => x.id)).toEqual(["3"]);
  });

  it("комбинирует поиск и фильтры", () => {
    expect(searchProducts(all, { q: "маска", onSale: true })).toEqual([]);
    expect(searchProducts(all, { q: "foxweld", inStock: true }).map((x) => x.id)).toEqual([
      "4",
      "1",
    ]);
  });
});

describe("searchProducts — сортировка", () => {
  it("по названию (А–Я, русская локаль)", () => {
    expect(searchProducts(all, { sort: "name" }).map((x) => x.id)).toEqual(["2", "4", "1", "3"]);
  });

  it("цена по возрастанию и убыванию", () => {
    expect(searchProducts(all, { sort: "price-asc" }).map((x) => x.id)).toEqual([
      "3",
      "4",
      "2",
      "1",
    ]);
    expect(searchProducts(all, { sort: "price-desc" }).map((x) => x.id)).toEqual([
      "1",
      "2",
      "4",
      "3",
    ]);
  });

  it("варианты сортировки в интерфейсе — только реальные, без «по популярности»", () => {
    expect(CATALOG_SORTS.map((s) => s.value)).toEqual(["name", "price-asc", "price-desc"]);
  });
});

describe("parsePriceInput", () => {
  it("принимает пробелы и запятую, отвергает мусор", () => {
    expect(parsePriceInput("12 500")).toBe(12500);
    expect(parsePriceInput("12500,5")).toBe(12500.5);
    expect(parsePriceInput("abc")).toBeUndefined();
    expect(parsePriceInput("-5")).toBeUndefined();
    expect(parsePriceInput(undefined)).toBeUndefined();
  });
});

describe("скорость на реальном объёме каталога", () => {
  it("поиск и сортировка по 1029 товарам укладываются в 150 мс", () => {
    const brands = ["FoxWeld", "Varteg", "ESAB", null];
    const big: SearchableProduct[] = Array.from({ length: 1029 }, (_, i) =>
      p({
        id: `p${i}`,
        title: `Сварочный инвертор модель ${i % 137} FOX-${i}`,
        brand: brands[i % brands.length] ?? null,
        sku: `SKU-${i}`,
        price: 1000 + (i % 500) * 100,
        in_stock: i % 20 !== 0,
        old_price: i % 7 === 0 ? 1000 + (i % 500) * 100 + 500 : null,
      }),
    );
    const start = performance.now();
    const found = searchProducts(big, { q: "инвертор fox", sort: "price-asc" });
    const withFilters = searchProducts(big, {
      onSale: true,
      inStock: true,
      minPrice: 5000,
      sort: "price-desc",
    });
    const elapsed = performance.now() - start;
    expect(found.length).toBeGreaterThan(0);
    expect(withFilters.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(150);
  });
});
