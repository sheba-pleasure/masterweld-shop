import { ShoppingBag } from "lucide-react";
import { useSyncExternalStore } from "react";
import { addToCart, openCart, useCart, type CartItem } from "@/lib/cart";
import { CONTACTS } from "@/lib/contacts";
import { inquiryHref } from "@/lib/inquiry";

const subscribeOrigin = () => () => {};
const browserOrigin = () => window.location.origin;
const serverOrigin = () => null;

export function InquiryButton({
  title,
  slug,
  sku,
}: {
  title: string;
  slug: string;
  sku?: string | null | undefined;
}) {
  const origin = useSyncExternalStore(subscribeOrigin, browserOrigin, serverOrigin);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <a
        href={inquiryHref(title, slug, sku, origin)}
        className="inline-flex min-h-11 items-center rounded-full border-2 border-brand-deep bg-brand-yellow px-4 py-2 font-semibold text-brand-deep"
      >
        Запросить цену по почте
      </a>
      <a href={CONTACTS.phoneHref} className="inline-flex min-h-11 items-center underline">
        Позвонить
      </a>
    </div>
  );
}

export function AddToCartButton({
  item,
  className = "",
}: {
  item: Omit<CartItem, "qty" | "price"> & { price: number | null; sku?: string | null };
  className?: string;
}) {
  const { items } = useCart();
  const quantity = items.find((entry) => entry.id === item.id)?.qty ?? 0;
  if (item.price === null)
    return <InquiryButton title={item.title} slug={item.slug} sku={item.sku} />;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => {
          if (item.price !== null)
            addToCart({
              id: item.id,
              slug: item.slug,
              title: item.title,
              photo: item.photo,
              price: item.price,
            });
        }}
        className={
          "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border-2 border-brand-deep bg-brand-yellow px-4 py-2 text-sm font-semibold text-brand-deep transition-colors hover:bg-brand-yellow/90 " +
          className
        }
      >
        <ShoppingBag className="h-4 w-4" />
        {quantity > 0 ? "Добавить ещё" : "В корзину"}
      </button>
      {quantity > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span role="status" className="text-sm">
            В корзине: {quantity} шт.
          </span>
          <button
            type="button"
            onClick={openCart}
            className="min-h-11 text-sm font-semibold underline underline-offset-4"
          >
            Перейти в корзину
          </button>
        </div>
      )}
    </div>
  );
}
