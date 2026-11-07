import { useSyncExternalStore } from "react";

export interface CartItem {
  id: string;
  slug: string;
  title: string;
  price: number;
  photo: string | null;
  qty: number;
}

export const OPEN_CART_EVENT = "mw:open-cart";
export function openCart() {
  window.dispatchEvent(new Event(OPEN_CART_EVENT));
}

const KEY = "mw_cart_v1";
const EMPTY: CartItem[] = [];

let items: CartItem[] = EMPTY;
let loaded = false;
let lastPersisted: string | null | undefined;
const listeners = new Set<() => void>();

// Read the current value, not a queued storage event's possibly stale newValue.
// Never write during synchronization: another tab owns this change.
export function refreshCart() {
  const raw = window.localStorage.getItem(KEY);
  if (loaded && raw === lastPersisted) return;
  const parsed: unknown = raw === null ? EMPTY : JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("CART_STORAGE_INVALID");
  const next = parsed.filter(
    (i): i is CartItem => i && typeof i.id === "string" && Number.isFinite(i.price) && i.qty > 0,
  );
  items = next;
  lastPersisted = raw;
  loaded = true;
  listeners.forEach((listener) => listener());
}

function refreshIfAvailable() {
  try {
    refreshCart();
  } catch {
    // Keep the visible in-memory cart when storage is unavailable or damaged.
  }
}

function load() {
  if (loaded || typeof window === "undefined") return;
  refreshIfAvailable();
  loaded = true;
}

function onStorage(event: StorageEvent) {
  try {
    if (event.storageArea === window.localStorage && (event.key === KEY || event.key === null))
      refreshIfAvailable();
  } catch {
    // Access to localStorage itself can be denied by the browser.
  }
}

function persist() {
  try {
    const raw = JSON.stringify(items);
    window.localStorage.setItem(KEY, raw);
    if (window.localStorage.getItem(KEY) === raw) lastPersisted = raw;
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
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refreshIfAvailable);
    refreshIfAvailable();
  }
  listeners.add(listener);
  load();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refreshIfAvailable);
    }
  };
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
  refreshIfAvailable();
  const at = items.findIndex((i) => i.id === item.id);
  if (at === -1) commit([...items, { ...item, qty }]);
  else commit(items.map((i, idx) => (idx === at ? { ...i, qty: i.qty + qty } : i)));
}

export function setQty(id: string, qty: number) {
  load();
  refreshIfAvailable();
  if (qty <= 0) commit(items.filter((i) => i.id !== id));
  else commit(items.map((i) => (i.id === id ? { ...i, qty } : i)));
}

export function adjustQty(id: string, delta: number) {
  load();
  refreshIfAvailable();
  const current = items.find((item) => item.id === id);
  if (!current) return; // A removed item must not reappear from a stale button.
  const qty = current.qty + delta;
  commit(
    qty <= 0
      ? items.filter((item) => item.id !== id)
      : items.map((item) => (item.id === id ? { ...item, qty } : item)),
  );
}

export function removeItem(id: string) {
  load();
  refreshIfAvailable();
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
