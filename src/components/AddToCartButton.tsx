import { useState } from "react";
import { Check, ShoppingBag } from "lucide-react";
import { addToCart, type CartItem } from "@/lib/cart";

export function AddToCartButton({
  item,
  className = "",
}: {
  item: Omit<CartItem, "qty">;
  className?: string;
}) {
  const [added, setAdded] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        addToCart(item);
        setAdded(true);
        window.setTimeout(() => setAdded(false), 1200);
      }}
      className={
        "inline-flex items-center justify-center gap-2 rounded-full border-2 border-brand-deep bg-brand-yellow px-4 py-2 text-sm font-semibold text-brand-deep shadow-[inset_0_1px_0_oklch(1_0_0/0.6),0_4px_10px_-4px_oklch(0_0_0/0.8)] transition-transform hover:-translate-y-0.5 active:translate-y-0 " +
        className
      }
    >
      {added ? <Check className="h-4 w-4" strokeWidth={2.6} /> : <ShoppingBag className="h-4 w-4" />}
      {added ? "Добавлено" : "В корзину"}
    </button>
  );
}
