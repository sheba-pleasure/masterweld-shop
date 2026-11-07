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
              className="line-clamp-2 text-sm font-semibold leading-tight text-primary-foreground"
            >
              {item.title}
            </Link>
            <p className="mt-1 text-xs text-primary-foreground/60">{rub(item.price)} / шт.</p>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Убрать одну: ${item.title}`}
                title="Убрать одну"
                className="checkout-icon"
                onClick={() => adjustQty(item.id, -1)}
              >
                <Minus />
              </Button>
              <span className="w-8 text-center text-sm font-semibold">{item.qty}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Добавить одну: ${item.title}`}
                title="Добавить одну"
                className="checkout-icon"
                onClick={() => adjustQty(item.id, 1)}
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Удалить из корзины: ${item.title}`}
                title="Удалить из корзины"
                className="checkout-icon ml-2"
                onClick={() => removeItem(item.id)}
              >
                <Trash2 />
              </Button>
              <span className="ml-auto whitespace-nowrap text-sm font-bold text-brand-yellow">
                {rub(item.price * item.qty)}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
