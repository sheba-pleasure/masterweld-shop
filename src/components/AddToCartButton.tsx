import { ShoppingBag } from "lucide-react";
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
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => addToCart(item)}
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
