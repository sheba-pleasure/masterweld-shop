import { ArrowUpRight, ShoppingBag } from "lucide-react";
import { MagneticWrap } from "@/components/MagneticWrap";
import { addToCart, openCart, useCart, type CartItem } from "@/lib/cart";

export function AddToCartButton({
  item,
  className = "",
}: {
  item: Omit<CartItem, "qty">;
  className?: string;
}) {
  const { items } = useCart();
  const quantity = items.find((entry) => entry.id === item.id)?.qty ?? 0;

  return (
    <div
      className={`flex flex-wrap items-center gap-3 ${className.includes("w-full") ? "w-full" : ""}`}
    >
      <MagneticWrap strength={0.12} className={className.includes("w-full") ? "w-full" : ""}>
        <button
          type="button"
          onClick={() => addToCart(item)}
          className={"btn-pill-cta " + className}
        >
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <ShoppingBag className="h-4 w-4 shrink-0" strokeWidth={2} />
            {quantity > 0 ? "Добавить ещё" : "В корзину"}
          </span>
          <span className="btn-pill-icon" aria-hidden="true">
            <ArrowUpRight className="h-4 w-4" strokeWidth={2.2} />
          </span>
        </button>
      </MagneticWrap>
      {quantity > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span
            role="status"
            className="rounded-full border border-mw-emerald/35 bg-mw-emerald/12 px-2.5 py-0.5 font-mono text-xs font-medium text-mw-emerald tabular-nums"
          >
            В корзине: {quantity} шт.
          </span>
          <button
            type="button"
            onClick={openCart}
            className="min-h-10 text-sm font-medium text-mw-cyan underline underline-offset-4 transition-colors duration-150 hover:text-white"
          >
            Перейти в корзину
          </button>
        </div>
      )}
    </div>
  );
}
