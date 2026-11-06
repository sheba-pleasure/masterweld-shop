import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { productQuery, rub, type Photo } from "@/lib/catalog";
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

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <Link
        to="/"
        search={catalogSearch}
        hash="catalog"
        className="mb-4 inline-block text-sm underline"
      >
        ← К выбранным товарам
      </Link>
      <nav aria-label="Категория товара" className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Каталог
        </Link>
        {cat && (
          <>
            {" "}
            /{" "}
            <Link to="/" search={{ cat: cat.slug }} className="hover:text-foreground">
              {cat.name}
            </Link>
          </>
        )}
      </nav>
      <div className="grid gap-10 md:grid-cols-2">
        <div className="min-w-0">
          <div className="flex aspect-square items-center justify-center rounded-lg border border-border bg-background p-6">
            {photos[active] ? (
              <img
                src={photos[active].url}
                alt={p.title}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-muted-foreground">Нет фото</span>
            )}
          </div>
          {photos.length > 1 && (
            <div className="mt-3 flex max-w-full snap-x gap-2 overflow-x-auto pb-2 md:flex-wrap">
              {photos.map((ph, i) => (
                <button
                  key={ph.url}
                  type="button"
                  aria-label={`Фото ${i + 1} товара ${p.title}`}
                  aria-pressed={i === active}
                  onClick={() => setActive(i)}
                  className={`h-16 w-16 shrink-0 snap-start rounded border-2 p-1 ${i === active ? "border-primary" : "border-border"}`}
                >
                  <img src={ph.url} alt="" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          {p.brand && (
            <p className="text-xs uppercase tracking-widest text-muted-foreground">{p.brand}</p>
          )}
          <h1 className="mt-2 font-display text-2xl font-bold text-foreground md:text-3xl">
            {p.title}
          </h1>
          {p.sku && <p className="mt-2 text-sm text-muted-foreground">Артикул: {p.sku}</p>}
          <div className="mt-6 flex items-baseline gap-3">
            <span className="font-display text-3xl font-bold text-foreground">
              {rub(Number(p.price))}
            </span>
            {p.old_price && Number(p.old_price) > Number(p.price) && (
              <span className="text-muted-foreground line-through">{rub(Number(p.old_price))}</span>
            )}
          </div>
          <p className={`mt-2 text-sm ${p.in_stock ? "text-primary" : "text-muted-foreground"}`}>
            {p.in_stock ? "Отмечено в наличии" : "Под заказ"}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {p.in_stock
              ? "Наличие подтвердим при обработке заказа."
              : "Срок поставки уточнит сотрудник магазина после заказа."}
          </p>
          <div className="mt-6">
            <AddToCartButton
              className="px-6 py-3"
              item={{
                id: p.id,
                slug: p.slug,
                title: p.title,
                price: Number(p.price),
                photo: photos[active]?.url ?? photos[0]?.url ?? null,
              }}
            />
          </div>
          <ProductTechnical key={p.id} productId={p.id} legacySpecs={p.specs} />
        </div>
      </div>
      {p.description && (
        <section className="mt-12 max-w-3xl">
          <h2 className="font-display text-lg font-semibold text-foreground">Описание</h2>
          <div className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {p.description}
          </div>
        </section>
      )}
    </main>
  );
}
