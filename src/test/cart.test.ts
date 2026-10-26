import { beforeEach, describe, expect, it } from "vitest";

import { addToCart, cartCount, cartTotal, clearCart, getCart, removeItem, setQty, type CartItem } from "@/lib/cart";

const app1 = { id: "a1", slug: "app-1", title: "Аппарат", price: 12500, photo: null };
const rod3 = { id: "r3", slug: "rod-3", title: "Электроды", price: 340, photo: null };

describe("Cart", () => {
  beforeEach(() => {
    clearCart();
    localStorage.clear();
  });

  it("keeps one line per product and adds quantities instead of duplicating", () => {
    addToCart(app1);
    addToCart(app1, 2);
    addToCart(rod3);

    expect(getCart()).toHaveLength(2);
    expect(getCart().find((i) => i.id === "a1")?.qty).toBe(3);
    expect(cartCount(getCart())).toBe(4);
  });

  it("totals every line as price times quantity", () => {
    addToCart(app1, 2);
    addToCart(rod3, 5);

    // 2 x 12500 + 5 x 340 = 26700
    expect(cartTotal(getCart())).toBe(26700);
  });

  it("drops a line when quantity goes to zero and when removed", () => {
    addToCart(app1, 3);
    addToCart(rod3, 1);

    setQty("a1", 0);
    expect(getCart().map((i) => i.id)).toEqual(["r3"]);

    removeItem("r3");
    expect(getCart()).toEqual([]);
    expect(cartTotal(getCart())).toBe(0);
  });

  it("survives a reload through browser storage", () => {
    addToCart(app1, 2);

    const stored = JSON.parse(localStorage.getItem("mw_cart_v1") ?? "[]") as CartItem[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "a1", qty: 2, price: 12500 });
  });
});
