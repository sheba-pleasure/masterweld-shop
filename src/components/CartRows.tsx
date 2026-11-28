import { Link } from "@tanstack/react-router";
import { Minus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { removeItem, adjustQty, type CartItem } from "@/lib/cart";
import { rub } from "@/lib/catalog";

export function CartRows({ items, onNavigate }: { items: CartItem[]; onNavigate: () => void }) {
  return (
    <ul className="checkout-items">
      {items.map((item) => (
        <li key={item.id} className="checkout-item">
          <div className="checkout-photo">
            {item.photo ? <img src={item.photo} alt="" /> : <span>Нет фото</span>}
          </div>
          <div className="min-w-0">
            <Link
              to="/product/$slug"
              params={{ slug: item.slug }}
              onClick={onNavigate}
              className="line-clamp-2 text-sm font-semibold leading-tight text-white transition-colors duration-150 hover:text-mw-cyan"
            >
              {item.title}
            </Link>
            <p className="mt-1 font-mono text-xs text-muted-foreground tabular-nums">
              {rub(item.price)} / шт.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Убрать одну: ${item.title}`}
                title="Убрать одну"
                className="checkout-icon"
                onClick={() => adjustQty(item.id, -1)}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-8 text-center font-mono text-sm font-semibold text-white tabular-nums">
                {item.qty}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Добавить одну: ${item.title}`}
                title="Добавить одну"
                className="checkout-icon"
                onClick={() => adjustQty(item.id, 1)}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Удалить из корзины: ${item.title}`}
                title="Удалить из корзины"
                className="checkout-icon ml-1"
                onClick={() => removeItem(item.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <span className="ml-auto whitespace-nowrap font-display text-sm font-semibold text-mw-amber tabular-nums">
                {rub(item.price * item.qty)}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
