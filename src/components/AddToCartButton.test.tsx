import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AddToCartButton } from "./AddToCartButton";
import { CONTACTS } from "@/lib/contacts";

const cart = vi.hoisted(() => ({
  add: vi.fn(),
  open: vi.fn(),
  items: [] as Array<{ id: string; qty: number }>,
}));
vi.mock("@/lib/cart", () => ({
  addToCart: cart.add,
  openCart: cart.open,
  useCart: () => ({ items: cart.items }),
}));

const item = { id: "product", title: "Сварог REAL MIG 200", slug: "real-mig-200", sku: "N24002N", photo: null };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  cart.items = [];
});

it("отсутствующая цена предлагает запрос точной модели и не добавляет её в корзину", () => {
  cart.items = [{ id: item.id, qty: 2 }];
  render(<AddToCartButton item={{ ...item, price: null }} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  const href = screen.getByRole("link", { name: "Запросить цену по почте" }).getAttribute("href");
  expect(href).toMatch(/^mailto:/);
  const params = new URLSearchParams(href!.split("?")[1]);
  expect(params.get("subject")).toContain(item.title);
  expect(params.get("body")).toContain("Артикул: N24002N");
  expect(params.get("body")).toContain(new URL("/product/real-mig-200", window.location.origin).href);
  expect(screen.getByRole("link", { name: "Позвонить" })).toHaveAttribute("href", CONTACTS.phoneHref);
  expect(cart.add).not.toHaveBeenCalled();
});

it("согласованная числовая цена оставляет обычную покупку", () => {
  render(<AddToCartButton item={{ ...item, price: 1200 }} />);
  fireEvent.click(screen.getByRole("button", { name: "В корзину" }));
  expect(cart.add).toHaveBeenCalledWith({
    id: item.id, title: item.title, slug: item.slug, photo: null, price: 1200,
  });
  expect(screen.queryByRole("link", { name: "Запросить цену по почте" })).not.toBeInTheDocument();
});
