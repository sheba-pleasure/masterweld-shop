import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import hero from "@/assets/brand/hero-workshop.jpg";
import { categoriesQuery, mainPhoto, productsQuery, rub } from "@/lib/catalog";
import { AddToCartButton } from "@/components/AddToCartButton";
import {
  CATALOG_SORTS,
  isDiscounted,
  normalizeText,
  parsePriceInput,
  searchProducts,
  type CatalogSort,
} from "@/lib/search";

type Search = {
  cat?: string | undefined;
  q?: string | undefined;
  brand?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  instock?: "1" | undefined;
  sale?: "1" | undefined;
  sort?: string | undefined;
};

const SORT_VALUES: CatalogSort[] = ["name", "price-asc", "price-desc"];

export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    cat: typeof s["cat"] === "string" ? s["cat"] : undefined,
    q: typeof s["q"] === "string" ? s["q"] : undefined,
    brand: typeof s["brand"] === "string" ? s["brand"] : undefined,
    min: typeof s["min"] === "string" ? s["min"] : undefined,
    max: typeof s["max"] === "string" ? s["max"] : undefined,
    instock: s["instock"] === "1" ? "1" : undefined,
    sale: s["sale"] === "1" ? "1" : undefined,
    sort: typeof s["sort"] === "string" ? s["sort"] : undefined,
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(categoriesQuery),
      context.queryClient.ensureQueryData(productsQuery),
    ]),
  head: () => ({
    meta: [
      { title: "«Мастер Сварщик» — сварочное оборудование и расходники" },
      {
        name: "description",
        content:
          "Каталог сварочного оборудования «Мастер Сварщик»: инверторы, горелки, электроды, маски, плазменная и газовая резка. Поиск по модели и артикулу, более 1000 товаров.",
      },
      { property: "og:title", content: "«Мастер Сварщик» — каталог сварочного оборудования" },
      {
        property: "og:description",
        content:
          "Сварочные аппараты, расходники, СИЗ и газовое оборудование. Поиск по модели и артикулу.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Catalog,
});

const SLIDES = [
  {
    title: "Всё для сварки — высшей марки",
    text: "Сварочные аппараты, горелки, расходники, маски и газовое оборудование.",
  },
  {
    title: "Работаем более 30 лет",
    text: "Товарный знак зарегистрирован в 2002 г. Доставка по всей России и СНГ.",
  },
  {
    title: "Всё для сварки и резки металла",
    text: "Более 1000 товаров в каталоге. Принимаем заявки на FoxWeld, VARTEG, «Сварог» и другие марки.",
  },
];

function HeroSlides() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % SLIDES.length), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mt-40 max-w-3xl md:mt-5">
      <div className="grid">
        {SLIDES.map((s, n) => (
          <div
            key={s.title}
            aria-hidden={n !== i}
            className={`col-start-1 row-start-1 transition-all ${n === i ? "duration-700 translate-x-0 opacity-100" : "duration-200 pointer-events-none translate-x-6 opacity-0"}`}
          >
            {n === 0 ? (
              <h1 className="font-display text-xl font-bold uppercase leading-tight text-primary-foreground md:text-4xl">
                {s.title}
              </h1>
            ) : (
              <p className="font-display text-xl font-bold uppercase leading-tight text-primary-foreground md:text-4xl">
                {s.title}
              </p>
            )}
            <p className="mt-2 max-w-xl text-sm text-primary-foreground/80 md:mt-3 md:text-base">
              {s.text}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        {SLIDES.map((s, n) => (
          <button
            key={s.title}
            onClick={() => setI(n)}
            aria-label={`Слайд ${n + 1}`}
            className={`h-2.5 rounded-full transition-all ${n === i ? "w-8 bg-brand-yellow" : "w-2.5 bg-primary-foreground/40"}`}
          />
        ))}
      </div>
    </div>
  );
}

function Catalog() {
  const { cat, q, brand, min, max, instock, sale, sort } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const { data: cats } = useSuspenseQuery(categoriesQuery);
  const { data: products } = useSuspenseQuery(productsQuery);
  const activeCat = cats.find((c) => c.slug === cat);
  const [limit, setLimit] = useState(48);
  const tops = cats.filter((c) => !c.parent_id);
  const topOf = useMemo(() => {
    const m = new Map<string, string>();
    cats.forEach((c) => m.set(c.id, c.parent_id ?? c.id));
    return m;
  }, [cats]);
  const activeTop = activeCat ? (activeCat.parent_id ?? activeCat.id) : undefined;
  const subs = activeTop ? cats.filter((c) => c.parent_id === activeTop) : [];

  const activeSort: CatalogSort = SORT_VALUES.includes(sort as CatalogSort)
    ? (sort as CatalogSort)
    : "name";

  // Сначала категория (та же логика, что и раньше), затем поиск/фильтры/сортировка.
  const catFiltered = useMemo(
    () =>
      products.filter((p) => {
        if (!activeCat) return true;
        if (activeCat.parent_id) return p.category_id === activeCat.id;
        return p.category_id ? topOf.get(p.category_id) === activeCat.id : false;
      }),
    [products, activeCat, topOf],
  );

  const brands = useMemo(() => {
    const byKey = new Map<string, string>();
    products.forEach((p) => {
      if (p.brand) byKey.set(normalizeText(p.brand), p.brand);
    });
    return [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  }, [products]);

  const list = useMemo(
    () =>
      searchProducts(catFiltered, {
        q,
        brand,
        minPrice: parsePriceInput(min),
        maxPrice: parsePriceInput(max),
        inStock: instock === "1",
        onSale: sale === "1",
        sort: activeSort,
      }),
    [catFiltered, q, brand, min, max, instock, sale, activeSort],
  );

  // При смене запроса/фильтров показываем первую страницу выдачи.
  useEffect(() => {
    setLimit(48);
  }, [q, brand, min, max, instock, sale, sort, cat]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    products.forEach((p) => {
      if (!p.category_id) return;
      m.set(p.category_id, (m.get(p.category_id) ?? 0) + 1);
      const t = topOf.get(p.category_id);
      if (t && t !== p.category_id) m.set(t, (m.get(t) ?? 0) + 1);
    });
    return m;
  }, [products, topOf]);

  const hasFilters = Boolean(q || brand || min || max || instock || sale);
  const setParam = (key: keyof Search, value: string | undefined) =>
    navigate({ search: (s) => ({ ...s, [key]: value }), replace: true });

  return (
    <main>
      {/* Компактный hero: поиск виден сразу, слайды — ниже и скромнее */}
      <section className="relative overflow-hidden border-b-2 border-brand-yellow bg-brand-deep">
        <img
          src={hero}
          alt=""
          aria-hidden
          className="absolute right-0 top-12 h-[280px] w-full object-cover object-[center_45%] opacity-95 md:inset-y-0 md:h-full md:w-2/3 md:opacity-100"
        />
        {/* Осветлённое затемнение: знак читается целиком; плотный чёрный — только у самого левого края под текст */}
        <div className="absolute inset-0 bg-gradient-to-r from-brand-deep/95 from-5% via-brand-deep/40 via-55% to-transparent" />
        {/* Короткий переход в тёмную шапку: сверху сплошной цвет, ниже — быстрый прозрачный сход */}
        <div className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-brand-deep via-brand-deep/55 to-transparent" />
        <div className="relative mx-auto max-w-7xl px-4 pb-6 pt-4 md:py-10">
          <p className="font-display text-xs font-bold uppercase tracking-normal text-brand-yellow">
            Интернет-магазин «Мастер Сварщик»
          </p>
          <div className="relative mt-2 w-full max-w-80 md:mt-3 md:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={q ?? ""}
              placeholder="Модель, артикул или бренд…"
              aria-label="Поиск по каталогу: модель, артикул или бренд"
              onChange={(e) => setParam("q", e.target.value || undefined)}
              className="search-field search-field--hero"
            />
          </div>
          <HeroSlides />
        </div>
      </section>

      <section className="workshop-catalog">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 pb-10 pt-24 md:grid-cols-[220px_1fr] md:pt-32">
          <nav
            aria-label="Категории каталога"
            className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible"
          >
            <Link
              to="/"
              search={(s) => ({ ...s, cat: undefined })}
              className={`whitespace-nowrap rounded-md px-3 py-2 text-sm md:whitespace-normal ${!activeCat ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted"}`}
            >
              Все товары <span className="opacity-60">{products.length}</span>
            </Link>
            {tops
              .filter((c) => counts.get(c.id))
              .map((c) => (
                <Link
                  key={c.id}
                  to="/"
                  search={(s) => ({ ...s, cat: c.slug })}
                  className={`whitespace-nowrap rounded-md px-3 py-2 text-sm md:whitespace-normal ${activeTop === c.id ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted"}`}
                >
                  {c.name} <span className="opacity-60">{counts.get(c.id)}</span>
                </Link>
              ))}
          </nav>

          <div>
            {subs.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {subs
                  .filter((c) => counts.get(c.id))
                  .map((c) => (
                    <Link
                      key={c.id}
                      to="/"
                      search={(s) => ({ ...s, cat: c.slug })}
                      className={`rounded-full border px-3 py-1 text-xs ${activeCat?.id === c.id ? "border-primary bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
                    >
                      {c.name} · {counts.get(c.id)}
                    </Link>
                  ))}
              </div>
            )}

            {/* Фильтры и сортировка: только по реальным полям базы */}
            <div className="workshop-filters mb-6 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Сортировка"
                  value={activeSort}
                  onChange={(e) =>
                    setParam("sort", e.target.value === "name" ? undefined : e.target.value)
                  }
                  className="filter-field"
                >
                  {CATALOG_SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Бренд"
                  value={brand ?? ""}
                  onChange={(e) => setParam("brand", e.target.value || undefined)}
                  className="filter-field"
                >
                  <option value="">Все бренды</option>
                  {brands.map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Цена от, ₽"
                  aria-label="Минимальная цена, рублей"
                  value={min ?? ""}
                  onChange={(e) => setParam("min", e.target.value || undefined)}
                  className="filter-field w-28"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="до, ₽"
                  aria-label="Максимальная цена, рублей"
                  value={max ?? ""}
                  onChange={(e) => setParam("max", e.target.value || undefined)}
                  className="filter-field w-24"
                />
                <button
                  type="button"
                  aria-pressed={instock === "1"}
                  onClick={() => setParam("instock", instock === "1" ? undefined : "1")}
                  className="filter-chip"
                >
                  Отмечено в наличии
                </button>
                <button
                  type="button"
                  aria-pressed={sale === "1"}
                  onClick={() => setParam("sale", sale === "1" ? undefined : "1")}
                  className="filter-chip"
                >
                  Цена снижена
                </button>
                {hasFilters && (
                  <button
                    type="button"
                    onClick={() => navigate({ search: (s) => ({ cat: s.cat }) })}
                    className="filter-chip filter-chip--reset"
                  >
                    Сбросить
                  </button>
                )}
              </div>
              <p aria-live="polite" className="text-sm text-muted-foreground">
                Найдено: {list.length}
              </p>
            </div>

            {list.length === 0 ? (
              <div className="py-16 text-center">
                <p className="text-muted-foreground">
                  {hasFilters
                    ? "По вашему запросу ничего не нашлось."
                    : "В этом разделе пока нет товаров."}
                </p>
                {hasFilters && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Попробуйте изменить запрос или{" "}
                    <button
                      type="button"
                      onClick={() => navigate({ search: (s) => ({ cat: s.cat }) })}
                      className="underline hover:text-foreground"
                    >
                      сбросить фильтры
                    </button>
                    .
                  </p>
                )}
              </div>
            ) : (
              <ul className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
                {list.slice(0, limit).map((p) => {
                  const img = mainPhoto(p.product_photos);
                  return (
                    <li
                      key={p.id}
                      className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-shadow hover:shadow-lg"
                    >
                      <Link
                        to="/product/$slug"
                        params={{ slug: p.slug }}
                        className="flex h-full flex-col"
                      >
                        <div className="relative flex aspect-square items-center justify-center bg-background p-4">
                          {img ? (
                            <img
                              src={img}
                              alt={p.title}
                              loading="lazy"
                              className="max-h-full max-w-full object-contain transition-transform group-hover:scale-105"
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">Нет фото</span>
                          )}
                          {isDiscounted(p) && <span className="sale-badge">Цена снижена</span>}
                        </div>
                        <div className="flex flex-1 flex-col gap-1.5 border-t border-border p-3">
                          {p.brand && (
                            <span className="truncate text-xs uppercase tracking-wide text-muted-foreground">
                              {p.brand}
                            </span>
                          )}
                          <h2 className="line-clamp-3 text-sm font-medium text-card-foreground">
                            {p.title}
                          </h2>
                          {p.sku && (
                            <span className="truncate text-xs text-muted-foreground">
                              Артикул: {p.sku}
                            </span>
                          )}
                          <div className="mt-auto flex items-baseline gap-2">
                            <span className="font-display text-lg font-bold text-foreground">
                              {rub(p.price)}
                            </span>
                            {isDiscounted(p) && (
                              <span className="text-xs text-muted-foreground line-through">
                                {rub(Number(p.old_price))}
                              </span>
                            )}
                          </div>
                          <span
                            className={`text-xs ${p.in_stock ? "text-primary" : "text-muted-foreground"}`}
                          >
                            {p.in_stock ? "Отмечено в наличии" : "Под заказ"}
                          </span>
                        </div>
                      </Link>
                      <div className="px-3 pb-3">
                        <AddToCartButton
                          className="w-full"
                          item={{
                            id: p.id,
                            slug: p.slug,
                            title: p.title,
                            price: p.price,
                            photo: img ?? null,
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {list.length > limit && (
              <div className="mt-8 text-center">
                <button
                  onClick={() => setLimit((l) => l + 48)}
                  className="rounded-md border border-border px-6 py-3 text-sm font-medium text-foreground hover:bg-muted"
                >
                  Показать ещё ({list.length - limit})
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
