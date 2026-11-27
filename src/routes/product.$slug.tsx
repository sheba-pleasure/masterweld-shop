import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArcTelemetryCanvas } from "@/components/ArcTelemetryCanvas";
import { SpotlightBezel } from "@/components/MagneticWrap";
import { CategoryWeldingIcon } from "@/components/icons/WeldingIcons";
import { productQuery, rub, type Photo } from "@/lib/catalog";
import { CONTACTS } from "@/lib/contacts";
import { AddToCartButton } from "@/components/AddToCartButton";
import { ProductTechnical } from "@/components/ProductTechnical";
import { validateCatalogSearch } from "@/lib/catalog-search";

export const Route = createFileRoute("/product/$slug")({
  validateSearch: validateCatalogSearch,
  loader: async ({ context, params }) => {
    const p = await context.queryClient.ensureQueryData(productQuery(params.slug));
    if (!p) throw notFound();
    return { title: p.title, price: p.price };
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.title} — купить | Мастер Сварщик` },
          {
            name: "description",
            content: `${loaderData.title} по цене ${rub(Number(loaderData.price))}. Условия получения уточните в магазине.`,
          },
          { property: "og:title", content: loaderData.title },
          { property: "og:description", content: `Цена ${rub(Number(loaderData.price))}` },
          { property: "og:type", content: "product" },
          { name: "twitter:card", content: "summary_large_image" },
        ]
      : [{ title: "Товар недоступен | Мастер Сварщик" }],
  }),
  component: ProductPage,
});

function ProductPage() {
  const { slug } = Route.useParams();
  const catalogSearch = Route.useSearch();
  const { data: p } = useSuspenseQuery(productQuery(slug));
  const photos: Photo[] = [...((p?.product_photos as Photo[]) ?? [])].sort(
    (a, b) => Number(b.is_main) - Number(a.is_main) || a.sort_order - b.sort_order,
  );
  const [active, setActive] = useState(0);
  if (!p) return null;
  const cat = p.categories as { name: string; slug: string } | null;
  const activePhoto = photos[active] ?? photos[0];
  const discounted = Boolean(p.old_price && Number(p.old_price) > Number(p.price));

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Link
          to="/"
          search={catalogSearch}
          hash="catalog"
          className="btn-pill-secondary min-h-10 px-4 py-1.5 text-xs"
        >
          ← К выбранным товарам
        </Link>

        <nav aria-label="Категория товара" className="font-mono text-xs text-muted-foreground">
          <Link to="/" className="transition-colors duration-150 hover:text-white">
            Каталог
          </Link>
          {cat && (
            <>
              {" "}
              /{" "}
              <Link
                to="/"
                search={{ cat: cat.slug }}
                hash="catalog"
                className="text-mw-cyan transition-colors duration-150 hover:text-white"
              >
                {cat.name}
              </Link>
            </>
          )}
        </nav>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-12">
        {/* Left: Double-Bezel Gallery + Interactive Arc Mode Preview */}
        <div className="min-w-0 space-y-5 lg:col-span-6">
          <SpotlightBezel innerClassName="p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
              <div className="flex flex-wrap items-center gap-2">
                {p.brand && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-mw-cyan/30 bg-mw-cyan/12 px-3 py-1 font-semibold text-mw-cyan">
                    <CategoryWeldingIcon slug={cat?.slug} name={cat?.name} size={13} />
                    <span>{p.brand}</span>
                  </span>
                )}
                {discounted && (
                  <span className="rounded-full bg-mw-amber px-3 py-1 font-semibold text-white">
                    Цена снижена
                  </span>
                )}
              </div>
              <span className={p.in_stock ? "text-mw-emerald" : "text-muted-foreground"}>
                {p.in_stock ? "Отмечено в наличии" : "Под заказ"}
              </span>
            </div>

            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-2xl bg-white p-6">
              {activePhoto ? (
                <img
                  src={activePhoto.url}
                  alt={p.title}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="font-mono text-sm text-slate-400">Нет фото</span>
              )}
            </div>

            {photos.length > 1 && (
              <div className="mt-4 flex max-w-full snap-x gap-2.5 overflow-x-auto pb-1 md:flex-wrap">
                {photos.map((ph, i) => (
                  <button
                    key={ph.url}
                    type="button"
                    aria-label={`Фото ${i + 1} товара ${p.title}`}
                    aria-pressed={i === active}
                    onClick={() => setActive(i)}
                    className={`h-16 w-16 shrink-0 snap-start overflow-hidden rounded-xl border-2 bg-white p-1.5 transition-[border-color,opacity] duration-150 ${
                      i === active
                        ? "border-mw-amber opacity-100"
                        : "border-white/15 opacity-70 hover:opacity-100"
                    }`}
                  >
                    <img src={ph.url} alt="" className="h-full w-full object-contain" />
                  </button>
                ))}
              </div>
            )}
          </SpotlightBezel>

          <ArcTelemetryCanvas compact />

          <div className="glass-panel grid gap-4 rounded-2xl p-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-white">Более 30 лет на рынке</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Работаем с 1993 года, доставка по РФ и СНГ.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-white">Консультация по товару</p>
              <a
                href={CONTACTS.phoneHref}
                className="mt-1 inline-block font-mono text-xs text-mw-cyan transition-colors duration-150 hover:text-white"
              >
                {CONTACTS.phoneDisplay}
              </a>
            </div>
          </div>
        </div>

        {/* Right: Double-Bezel Purchase & Verified Technical Specs */}
        <div className="min-w-0 lg:col-span-6">
          <SpotlightBezel innerClassName="p-6 sm:p-8">
            {p.sku && (
              <p className="font-mono text-xs text-muted-foreground">
                Артикул: <span className="text-mw-cyan">{p.sku}</span>
              </p>
            )}

            <h1 className="mt-2 font-display text-2xl font-bold leading-tight text-white sm:text-3xl">
              {p.title}
            </h1>

            <div className="mt-6 rounded-2xl border border-white/10 bg-mw-void/85 p-5">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="font-display text-3xl font-bold text-white tabular-nums sm:text-4xl">
                  {rub(Number(p.price))}
                </span>
                {discounted && (
                  <span className="font-mono text-base text-muted-foreground line-through tabular-nums">
                    {rub(Number(p.old_price))}
                  </span>
                )}
              </div>

              <p className="mt-2 text-sm text-muted-foreground">
                {p.in_stock
                  ? "Наличие подтвердим при обработке заказа."
                  : "Срок поставки уточнит сотрудник магазина после заказа."}
              </p>

              <div className="mt-5">
                <AddToCartButton
                  item={{
                    id: p.id,
                    slug: p.slug,
                    title: p.title,
                    price: Number(p.price),
                    photo: activePhoto?.url ?? null,
                  }}
                />
              </div>
            </div>

            <ProductTechnical key={p.id} productId={p.id} legacySpecs={p.specs} />
          </SpotlightBezel>
        </div>
      </div>

      {p.description && (
        <section className="bezel-outer mt-8">
          <div className="bezel-inner p-6 sm:p-8">
            <h2 className="font-display text-lg font-semibold text-white">Описание</h2>
            <div className="mt-3 max-w-4xl whitespace-pre-line text-sm leading-relaxed text-secondary-foreground">
              {p.description}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
