import { useSyncExternalStore } from "react";

export interface CartItem {
  id: string;
  slug: string;
  title: string;
  price: number;
  photo: string | null;
  qty: number;
}

const KEY = "mw_cart_v1";
const EMPTY: CartItem[] = [];

let items: CartItem[] = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as CartItem[]) : EMPTY;
    if (Array.isArray(parsed)) {
      items = parsed.filter((i) => i && typeof i.id === "string" && Number.isFinite(i.price) && i.qty > 0);
    }
  } catch {
    items = EMPTY;
  }
}

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable — cart stays in memory for this visit */
  }
}

function commit(next: CartItem[]) {
  items = next;
  persist();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

function snapshot() {
  load();
  return items;
}

export function getCart(): CartItem[] {
  load();
  return items;
}

export function addToCart(item: Omit<CartItem, "qty">, qty = 1) {
  load();
  const at = items.findIndex((i) => i.id === item.id);
  if (at === -1) commit([...items, { ...item, qty }]);
  else commit(items.map((i, idx) => (idx === at ? { ...i, qty: i.qty + qty } : i)));
}

export function setQty(id: string, qty: number) {
  load();
  if (qty <= 0) commit(items.filter((i) => i.id !== id));
  else commit(items.map((i) => (i.id === id ? { ...i, qty } : i)));
}

export function removeItem(id: string) {
  load();
  commit(items.filter((i) => i.id !== id));
}

export function clearCart() {
  commit(EMPTY);
}

export function cartTotal(list: CartItem[]) {
  return list.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function cartCount(list: CartItem[]) {
  return list.reduce((sum, i) => sum + i.qty, 0);
}

export function useCart() {
  const list = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  return { items: list, count: cartCount(list), total: cartTotal(list) };
}
