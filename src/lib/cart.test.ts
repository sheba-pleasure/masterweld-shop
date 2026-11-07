import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addToCart, adjustQty, clearCart, getCart, refreshCart, setQty, useCart } from "./cart";

const KEY = "mw_cart_v1";
const first = { id: "first", slug: "first", title: "Аппарат", price: 900, photo: null };
const second = { id: "second", slug: "second", title: "Маска", price: 200, photo: null };
function storageEvent(
  newValue: string | null,
  key: string | null = KEY,
  storageArea = localStorage,
) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea }));
}
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  clearCart();
  addToCart(first);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("updates visible quantities from another tab without writing them back", () => {
  const { result } = renderHook(() => useCart());
  const raw = JSON.stringify([{ ...first, qty: 4 }]);
  localStorage.setItem(KEY, raw);
  const write = vi.spyOn(Storage.prototype, "setItem");
  act(() => storageEvent(raw));
  expect(result.current.count).toBe(4);
  expect(result.current.total).toBe(3600);
  expect(write).not.toHaveBeenCalled();
});

it("reads the latest storage value instead of replaying an older queued event", () => {
  const { result } = renderHook(() => useCart());
  localStorage.setItem(KEY, JSON.stringify([{ ...second, qty: 2 }]));
  act(() => storageEvent(JSON.stringify([{ ...first, qty: 5 }])));
  expect(result.current.items).toEqual([{ ...second, qty: 2 }]);
  localStorage.clear();
  act(() => storageEvent(null, null));
  expect(result.current.count).toBe(0);
});

it("ignores unrelated keys and session storage", () => {
  const { result } = renderHook(() => useCart());
  localStorage.setItem(KEY, "[]");
  act(() => {
    storageEvent("[]", "other");
    storageEvent("[]", KEY, sessionStorage);
  });
  expect(result.current.count).toBe(1);
  act(() => storageEvent("[]"));
  expect(result.current.count).toBe(0);
});

it("catches up on focus and when mounting again without a storage event", () => {
  const view = renderHook(() => useCart());
  localStorage.setItem(KEY, JSON.stringify([{ ...second, qty: 2 }]));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(view.result.current.items).toEqual([{ ...second, qty: 2 }]);
  const stable = view.result.current.items;
  act(() => window.dispatchEvent(new Event("focus")));
  expect(view.result.current.items).toBe(stable);
  view.unmount();
  localStorage.setItem(KEY, "[]");
  const next = renderHook(() => useCart());
  expect(next.result.current.count).toBe(0);
});

it("preserves unseen items from another tab before a local mutation", () => {
  localStorage.setItem(KEY, JSON.stringify([{ ...second, qty: 3 }]));
  addToCart(first);
  expect(getCart()).toEqual([
    { ...second, qty: 3 },
    { ...first, qty: 1 },
  ]);
  localStorage.setItem(
    KEY,
    JSON.stringify([
      { ...second, qty: 4 },
      { ...first, qty: 1 },
    ]),
  );
  setQty(first.id, 2);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([
    { ...second, qty: 4 },
    { ...first, qty: 2 },
  ]);
});

it("applies plus/minus to the latest quantity and never revives a removed row", () => {
  localStorage.setItem(KEY, JSON.stringify([{ ...first, qty: 4 }]));
  adjustQty(first.id, 1);
  expect(getCart()[0]?.qty).toBe(5);
  localStorage.setItem(KEY, JSON.stringify([{ ...first, qty: 2 }]));
  adjustQty(first.id, -1);
  expect(getCart()[0]?.qty).toBe(1);
  localStorage.setItem(KEY, "[]");
  adjustQty(first.id, 1);
  expect(getCart()).toEqual([]);
  expect(localStorage.getItem(KEY)).toBe("[]");
});

it("keeps unsaved in-memory edits when storage writes are unavailable", () => {
  const { result } = renderHook(() => useCart());
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  act(() => addToCart(second));
  expect(result.current.count).toBe(2);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(result.current.count).toBe(2);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([{ ...first, qty: 1 }]);
});

it("does not erase the visible cart or overwrite malformed external data", () => {
  const { result } = renderHook(() => useCart());
  localStorage.setItem(KEY, "{broken");
  const write = vi.spyOn(Storage.prototype, "setItem");
  act(() => storageEvent("{broken"));
  expect(result.current.count).toBe(1);
  expect(() => refreshCart()).toThrow();
  expect(write).not.toHaveBeenCalled();
  expect(localStorage.getItem(KEY)).toBe("{broken");
});
