import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { LayoutGrid, List, Search, SlidersHorizontal } from "lucide-react";
import hero from "@/assets/brand/hero-workshop.jpg";
import { ArcTelemetryCanvas } from "@/components/ArcTelemetryCanvas";
import { SpotlightBezel } from "@/components/MagneticWrap";
import { CategoryWeldingIcon, CrosshairIcon } from "@/components/icons/WeldingIcons";
import { categoriesQuery, mainPhoto, productsQuery, rub } from "@/lib/catalog";
import { AddToCartButton } from "@/components/AddToCartButton";
import { validateCatalogSearch, type CatalogSearch } from "@/lib/catalog-search";
import {
  CATALOG_SORTS,
  isDiscounted,
  normalizeText,
  parsePriceInput,
  searchProducts,
  type CatalogSort,
} from "@/lib/search";

const SORT_VALUES: CatalogSort[] = ["name", "price-asc", "price-desc"];

export const Route = createFileRoute("/")({
  validateSearch: validateCatalogSearch,
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
          "Каталог сварочного оборудования «Мастер Сварщик»: инверторы, горелки, электроды, маски, плазменная и газовая резка. Поиск по модели и артикулу.",
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
    text: "Принимаем заявки на FoxWeld, VARTEG, «Сварог» и другие марки.",
  },
];

function HeroSlides() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % SLIDES.length), 5500);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="max-w-xl">
      <div className="grid">
        {SLIDES.map((s, n) => (
          <div
            key={s.title}
            aria-hidden={n !== i}
            className={`col-start-1 row-start-1 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${
              n === i ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
            }`}
          >
            {n === 0 ? (
              <h1 className="font-display text-2xl font-bold leading-[1.08] text-white sm:text-4xl lg:text-[2.75rem]">
                {s.title}
              </h1>
            ) : (
              <p className="font-display text-2xl font-bold leading-[1.08] text-white sm:text-4xl lg:text-[2.75rem]">
                {s.title}
              </p>
            )}
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-secondary-foreground/85 sm:text-base">
              {s.text}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-2">
        {SLIDES.map((s, n) => (
          <button
            key={s.title}
            type="button"
            onClick={() => setI(n)}
            aria-label={`Слайд ${n + 1}`}
            className={`h-2 rounded-full transition-[width,background-color] duration-200 ${
              n === i
                ? "w-9 bg-mw-amber shadow-[0_0_10px_color-mix(in_oklab,var(--mw-amber)_60%,transparent)]"
                : "w-2 bg-white/25 hover:bg-white/50"
            }`}
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
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

  const catFiltered = useMemo(
    () =>
      products.filter((p) => {
        if (!activeCat) return !cat;
        if (activeCat.parent_id) return p.category_id === activeCat.id;
        return p.category_id ? topOf.get(p.category_id) === activeCat.id : false;
      }),
    [products, activeCat, topOf, cat],
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
  const setParam = (key: keyof CatalogSearch, value: string | undefined) =>
    navigate({ search: (s) => ({ ...s, [key]: value }), replace: true });

  const visibleTops = tops.filter((c) => counts.get(c.id));

  const tickerItems = useMemo(() => {
    const brandLabels = brands.slice(0, 10).map(([, name]) => name.toUpperCase());
    const base = [
      ...brandLabels,
      "С 1993 ГОДА",
      "ДОСТАВКА ПО РФ И СНГ",
      `ПОЗИЦИЙ В КАТАЛОГЕ: ${products.length}`,
    ];
    return [...base, ...base];
  }, [brands, products.length]);

  return (
    <main>
      {/* Editorial Split Industrial Hero + Live Oscilloscope Telemetry */}
      <section className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
        <div className="bezel-outer overflow-hidden">
          <div className="bezel-inner relative overflow-hidden p-6 sm:p-10">
            <img
              src={hero}
              alt=""
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 h-full w-full object-cover object-center opacity-22 mix-blend-lighten lg:w-3/5 lg:opacity-35"
            />
            <div className="mw-blueprint-grid pointer-events-none absolute inset-0 opacity-40" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-mw-void via-mw-void/90 via-55% to-mw-void/45" />

            {/* Drafting corner markers */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-4 top-3 font-mono text-[10px] text-white/25"
            >
              +
            </span>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-4 top-3 font-mono text-[10px] text-white/25"
            >
              +
            </span>

            <div className="relative z-10 grid items-center gap-8 lg:grid-cols-12">
              <div className="lg:col-span-7">
                <div className="mb-4 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-mw-amber">
                  <CrosshairIcon size={14} className="text-mw-cyan" />
                  <span>EST. 1993 // МАСТЕР СВАРЩИК</span>
                </div>

                <HeroSlides />

                <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="relative w-full max-w-md">
                    <Search
                      className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-mw-cyan"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      value={q ?? ""}
                      placeholder="Модель, артикул или бренд…"
                      aria-label="Поиск по каталогу: модель, артикул или бренд"
                      onChange={(e) => setParam("q", e.target.value || undefined)}
                      className="search-field search-field--hero"
                    />
                  </div>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    <strong className="text-white">{products.length}</strong> поз.
                    {brands.length > 0 ? (
                      <>
                        {" "}
                        · <strong className="text-mw-cyan">{brands.length}</strong> брендов
                      </>
                    ) : null}
                  </span>
                </div>

                {visibleTops.length > 0 && (
                  <div className="mt-5 flex flex-wrap gap-2">
                    {visibleTops.slice(0, 6).map((c) => (
                      <Link
                        key={c.id}
                        to="/"
                        search={(s) => ({ ...s, cat: c.slug })}
                        hash="catalog"
                        className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors duration-150 ${
                          activeTop === c.id
                            ? "border-mw-amber bg-mw-amber text-white"
                            : "border-white/12 bg-mw-void/80 text-secondary-foreground hover:border-mw-cyan/50 hover:text-white"
                        }`}
                      >
                        <CategoryWeldingIcon
                          slug={c.slug}
                          name={c.name}
                          size={14}
                          className={activeTop === c.id ? "text-white" : "text-mw-cyan"}
                        />
                        <span>{c.name}</span>
                        <span className="font-mono text-[11px] opacity-70 tabular-nums">
                          {counts.get(c.id)}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {/* Right Column: Live Interactive Arc Oscillogram */}
              <div className="lg:col-span-5">
                <ArcTelemetryCanvas />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Kinetic Hardware Marquee */}
      <div
        aria-hidden="true"
        className="mw-marquee mx-auto mt-6 max-w-7xl border-y border-white/8 py-3"
      >
        <div className="mw-marquee-track font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">
          {tickerItems.map((item, idx) => (
            <span key={`${item}-${idx}`} className="inline-flex items-center gap-4">
              <span className={idx % 3 === 0 ? "text-white/90" : "text-muted-foreground"}>
                {item}
              </span>
              <span className="text-mw-amber">//</span>
            </span>
          ))}
        </div>
      </div>

      {/* Catalog Section */}
      <section id="catalog" className="workshop-catalog scroll-mt-24">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 pb-12 pt-8 sm:px-6 md:grid-cols-[248px_1fr]">
          {/* Sticky Category Rail with Custom CAD Icons */}
          <aside className="hidden md:block">
            <div className="glass-panel sticky top-24 rounded-3xl p-3.5">
              <nav aria-label="Категории каталога" className="flex flex-col gap-1">
                <Link
                  to="/"
                  search={(s) => ({ ...s, cat: undefined })}
                  aria-current={!cat ? "page" : undefined}
                  className={`flex items-center justify-between gap-2 rounded-2xl px-3.5 py-2.5 text-sm font-medium transition-colors duration-150 ${
                    !cat
                      ? "bg-mw-amber font-semibold text-white"
                      : "text-secondary-foreground hover:bg-white/6 hover:text-white"
                  }`}
                >
                  <span className="inline-flex min-w-0 items-center gap-2.5">
                    <CrosshairIcon
                      size={15}
                      className={!cat ? "shrink-0 text-white" : "shrink-0 text-mw-cyan"}
                    />
                    <span className="truncate">Все товары</span>
                  </span>
                  <span className="font-mono text-xs opacity-75 tabular-nums">
                    {products.length}
                  </span>
                </Link>
                {visibleTops.map((c) => {
                  const isActive = activeTop === c.id;
                  return (
                    <Link
                      key={c.id}
                      to="/"
                      search={(s) => ({ ...s, cat: c.slug })}
                      aria-current={activeCat?.id === c.id ? "page" : undefined}
                      className={`flex items-center justify-between gap-2 rounded-2xl px-3.5 py-2.5 text-sm font-medium transition-colors duration-150 ${
                        isActive
                          ? "bg-mw-amber font-semibold text-white"
                          : "text-secondary-foreground hover:bg-white/6 hover:text-white"
                      }`}
                    >
                      <span className="inline-flex min-w-0 items-center gap-2.5">
                        <CategoryWeldingIcon
                          slug={c.slug}
                          name={c.name}
                          size={15}
                          className={isActive ? "shrink-0 text-white" : "shrink-0 text-mw-cyan"}
                        />
                        <span className="truncate">{c.name}</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs opacity-75 tabular-nums">
                        {counts.get(c.id)}
                      </span>
                    </Link>
                  );
                })}
              </nav>
            </div>
          </aside>

          {/* Main Catalog Column */}
          <div className="min-w-0">
            <label className="mb-4 flex flex-col gap-1.5 text-xs font-medium text-muted-foreground md:hidden">
              Раздел каталога
              <select
                aria-label="Раздел каталога"
                value={cat ?? ""}
                onChange={(e) => setParam("cat", e.target.value || undefined)}
                className="filter-field w-full min-w-0"
              >
                <option value="">Все товары · {products.length}</option>
                {cat && !activeCat && <option value={cat}>Раздел не найден</option>}
                {tops.map((top) => (
                  <optgroup key={top.id} label={top.name}>
                    <option value={top.slug}>
                      {top.name} · {counts.get(top.id) ?? 0}
                    </option>
                    {cats
                      .filter((c) => c.parent_id === top.id)
                      .map((c) => (
                        <option key={c.id} value={c.slug}>
                          {c.name} · {counts.get(c.id) ?? 0}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>

            {activeCat && (
              <nav
                aria-label="Путь по каталогу"
                className="mb-3 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground"
              >
                <Link
                  to="/"
                  search={(s) => ({ ...s, cat: undefined })}
                  className="transition-colors duration-150 hover:text-white"
                >
                  Все товары
                </Link>
                {activeCat.parent_id && (
                  <>
                    <span aria-hidden>/</span>
                    <Link
                      to="/"
                      search={(s) => ({
                        ...s,
                        cat: cats.find((c) => c.id === activeTop)?.slug,
                      })}
                      className="transition-colors duration-150 hover:text-white"
                    >
                      {cats.find((c) => c.id === activeTop)?.name}
                    </Link>
                  </>
                )}
                <span aria-hidden>/</span>
                <span className="text-mw-cyan">{activeCat.name}</span>
              </nav>
            )}

            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-2xl font-bold text-white sm:text-3xl">
                {activeCat?.name ?? (cat ? "Раздел не найден" : "Каталог товаров")}
              </h2>

              <div className="segmented-track" role="group" aria-label="Вид списка товаров">
                <button
                  type="button"
                  aria-pressed={viewMode === "cards"}
                  onClick={() => setViewMode("cards")}
                  className="segmented-item inline-flex items-center gap-1.5"
                >
                  <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Карточки</span>
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === "table"}
                  onClick={() => setViewMode("table")}
                  className="segmented-item inline-flex items-center gap-1.5"
                >
                  <List className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Таблица</span>
                </button>
              </div>
            </div>

            {subs.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {subs
                  .filter((c) => counts.get(c.id))
                  .map((c) => (
                    <Link
                      key={c.id}
                      to="/"
                      search={(s) => ({ ...s, cat: c.slug })}
                      aria-current={activeCat?.id === c.id ? "page" : undefined}
                      className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors duration-150 ${
                        activeCat?.id === c.id
                          ? "border-mw-cyan bg-mw-cyan/15 text-white"
                          : "border-white/10 bg-mw-surface text-muted-foreground hover:border-white/25 hover:text-white"
                      }`}
                    >
                      {c.name}{" "}
                      <span className="ml-1 font-mono opacity-70 tabular-nums">
                        {counts.get(c.id)}
                      </span>
                    </Link>
                  ))}
              </div>
            )}

            {hasFilters && (
              <div aria-label="Выбранные фильтры" className="mb-4 flex flex-wrap gap-2">
                {(
                  [
                    ["q", q ? `Поиск: ${q}` : undefined],
                    [
                      "brand",
                      brand
                        ? `Бренд: ${brands.find(([key]) => key === brand)?.[1] ?? brand}`
                        : undefined,
                    ],
                    ["min", min ? `Цена от: ${min} ₽` : undefined],
                    ["max", max ? `Цена до: ${max} ₽` : undefined],
                    ["instock", instock ? "В наличии" : undefined],
                    ["sale", sale ? "Цена снижена" : undefined],
                  ] as [keyof CatalogSearch, string | undefined][]
                )
                  .filter(([, label]) => label)
                  .map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-label={`Убрать фильтр «${label}»`}
                      onClick={() => setParam(key, undefined)}
                      className="filter-chip max-w-full break-words border-mw-cyan/45 text-left text-white"
                    >
                      {label}{" "}
                      <span className="text-mw-cyan" aria-hidden>
                        ×
                      </span>
                    </button>
                  ))}
              </div>
            )}

            <div className="glass-panel mb-6 flex flex-col gap-3 rounded-3xl p-4 sm:p-5">
              <div className="md:hidden">
                <button
                  type="button"
                  aria-expanded={filtersOpen}
                  aria-controls="catalog-filters"
                  onClick={() => setFiltersOpen((open) => !open)}
                  className="filter-chip w-full justify-between"
                >
                  <span className="inline-flex items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4 text-mw-cyan" aria-hidden="true" />
                    Фильтры и сортировка
                  </span>
                  <span aria-hidden>{filtersOpen ? "−" : "+"}</span>
                </button>
              </div>
              <div
                id="catalog-filters"
                className={`${filtersOpen ? "flex" : "hidden"} flex-wrap items-end gap-2.5 md:flex`}
              >
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Сортировка
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
                </label>

                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Бренд
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
                </label>

                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Цена от, ₽
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Минимальная цена, рублей"
                    value={min ?? ""}
                    onChange={(e) => setParam("min", e.target.value || undefined)}
                    className="filter-field w-28 font-mono tabular-nums"
                  />
                </label>

                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Цена до, ₽
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Максимальная цена, рублей"
                    value={max ?? ""}
                    onChange={(e) => setParam("max", e.target.value || undefined)}
                    className="filter-field w-28 font-mono tabular-nums"
                  />
                </label>

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

              <p
                aria-live="polite"
                className="border-t border-white/8 pt-3 font-mono text-xs text-muted-foreground tabular-nums"
              >
                Найдено: <strong className="text-white">{list.length}</strong>
              </p>
            </div>

            {cat && !activeCat ? (
              <div className="glass-panel rounded-3xl p-8 text-center">
                <p className="text-secondary-foreground">
                  Ссылка ведёт в раздел, которого сейчас нет в каталоге.
                </p>
                <Link
                  to="/"
                  search={{}}
                  hash="catalog"
                  className="btn-pill-secondary mt-4 inline-flex"
                >
                  Открыть весь каталог
                </Link>
              </div>
            ) : list.length === 0 ? (
              <div className="glass-panel rounded-3xl p-10 text-center">
                <p className="text-secondary-foreground">
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
                      className="text-mw-cyan underline underline-offset-4 hover:text-white"
                    >
                      сбросить фильтры
                    </button>
                    .
                  </p>
                )}
              </div>
            ) : viewMode === "table" ? (
              <div className="glass-panel overflow-x-auto rounded-3xl">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-mw-void font-mono text-xs text-muted-foreground">
                      <th className="p-4 font-medium">Товар</th>
                      <th className="p-4 font-medium">Бренд</th>
                      <th className="p-4 font-medium">Артикул</th>
                      <th className="p-4 font-medium">Наличие</th>
                      <th className="p-4 text-right font-medium">Цена</th>
                      <th className="p-4 text-right font-medium">Заказ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/8">
                    {list.slice(0, limit).map((p) => {
                      const img = mainPhoto(p.product_photos);
                      return (
                        <tr
                          key={p.id}
                          className="transition-colors duration-150 hover:bg-white/[0.03]"
                        >
                          <td className="p-4">
                            <Link
                              to="/product/$slug"
                              params={{ slug: p.slug }}
                              search={{ cat, q, brand, min, max, instock, sale, sort }}
                              className="flex items-center gap-3 font-medium text-white transition-colors duration-150 hover:text-mw-cyan"
                            >
                              <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white p-1">
                                {img ? (
                                  <img
                                    src={img}
                                    alt=""
                                    loading="lazy"
                                    className="max-h-full max-w-full object-contain"
                                  />
                                ) : (
                                  <span className="text-[10px] text-slate-500">Фото</span>
                                )}
                              </span>
                              <span className="line-clamp-2">{p.title}</span>
                            </Link>
                          </td>
                          <td className="p-4 font-mono text-xs text-mw-cyan">{p.brand ?? "—"}</td>
                          <td className="p-4 font-mono text-xs text-muted-foreground">
                            {p.sku ?? "—"}
                          </td>
                          <td className="p-4 font-mono text-xs">
                            <span
                              className={p.in_stock ? "text-mw-emerald" : "text-muted-foreground"}
                            >
                              {p.price === null
                                ? "Наличие уточняется"
                                : p.in_stock
                                  ? "Отмечено в наличии"
                                  : "Под заказ"}
                            </span>
                          </td>
                          <td className="p-4 text-right whitespace-nowrap">
                            <div className="font-display text-base font-semibold text-white tabular-nums">
                              {rub(p.price)}
                            </div>
                            {isDiscounted(p) && (
                              <div className="font-mono text-xs text-muted-foreground line-through tabular-nums">
                                {rub(Number(p.old_price))}
                              </div>
                            )}
                          </td>
                          <td className="p-4 text-right">
                            <div className="inline-flex justify-end">
                              <AddToCartButton
                                item={{
                                  id: p.id,
                                  slug: p.slug,
                                  title: p.title,
                                  sku: p.sku,
                                  price: p.price,
                                  photo: img ?? null,
                                }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {list.slice(0, limit).map((p) => {
                  const img = mainPhoto(p.product_photos);
                  const productCat = cats.find((c) => c.id === p.category_id);
                  return (
                    <li key={p.id} className="h-full">
                      <SpotlightBezel
                        className="flex h-full"
                        innerClassName="flex h-full w-full flex-col overflow-hidden"
                      >
                        <Link
                          to="/product/$slug"
                          params={{ slug: p.slug }}
                          search={{ cat, q, brand, min, max, instock, sale, sort }}
                          className="group flex flex-1 flex-col"
                        >
                          <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-white p-4">
                            {img ? (
                              <img
                                src={img}
                                alt={p.title}
                                loading="lazy"
                                className="max-h-full max-w-full object-contain transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover:scale-[1.04]"
                              />
                            ) : (
                              <span className="font-mono text-xs text-slate-400">Нет фото</span>
                            )}
                            {isDiscounted(p) && <span className="sale-badge">Цена снижена</span>}
                          </div>

                          <div className="flex flex-1 flex-col gap-2 p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                              <span className="inline-flex items-center gap-1.5 text-mw-cyan">
                                <CategoryWeldingIcon
                                  slug={productCat?.slug}
                                  name={productCat?.name}
                                  size={13}
                                />
                                <span>{p.brand ?? productCat?.name ?? "Каталог"}</span>
                              </span>
                              <span
                                className={p.in_stock ? "text-mw-emerald" : "text-muted-foreground"}
                              >
                                {p.price === null
                                  ? "Наличие уточняется"
                                  : p.in_stock
                                    ? "Отмечено в наличии"
                                    : "Под заказ"}
                              </span>
                            </div>

                            <h3 className="line-clamp-3 text-sm font-semibold leading-snug text-white transition-colors duration-150 group-hover:text-mw-cyan">
                              {p.title}
                            </h3>

                            {p.sku && (
                              <span className="truncate font-mono text-xs text-muted-foreground">
                                Артикул: {p.sku}
                              </span>
                            )}

                            <div className="mt-auto flex flex-wrap items-baseline gap-2 border-t border-white/8 pt-3">
                              <span className="font-display text-lg font-bold text-white tabular-nums">
                                {rub(p.price)}
                              </span>
                              {isDiscounted(p) && (
                                <span className="font-mono text-xs text-muted-foreground line-through tabular-nums">
                                  {rub(Number(p.old_price))}
                                </span>
                              )}
                            </div>
                          </div>
                        </Link>
                        <div className="px-4 pb-4">
                          <AddToCartButton
                            className="w-full"
                            item={{
                              id: p.id,
                              slug: p.slug,
                              title: p.title,
                              sku: p.sku,
                              price: p.price,
                              photo: img ?? null,
                            }}
                          />
                        </div>
                      </SpotlightBezel>
                    </li>
                  );
                })}
              </ul>
            )}

            {list.length > limit && (
              <div className="mt-8 text-center">
                <button
                  type="button"
                  onClick={() => setLimit((l) => l + 48)}
                  className="btn-pill-secondary px-8"
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
