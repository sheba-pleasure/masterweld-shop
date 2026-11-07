import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
const router = vi.hoisted(() => ({
  location: { pathname: "/product/training", search: {} as Record<string, unknown> },
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => router.location,
  useNavigate: () => router.navigate,
}));
import { TelegramShopBridge } from "./TelegramShopBridge";

let handlers: Set<() => void>;
let sdk: {
  ready: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  BackButton: {
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    onClick: (fn: () => void) => void;
    offClick: (fn: () => void) => void;
  };
};
beforeEach(() => {
  vi.clearAllMocks();
  handlers = new Set();
  sdk = {
    ready: vi.fn(),
    expand: vi.fn(),
    BackButton: {
      show: vi.fn(),
      hide: vi.fn(),
      onClick: (fn) => {
        handlers.add(fn);
      },
      offClick: (fn) => {
        handlers.delete(fn);
      },
    },
  };
  sessionStorage.setItem("mw_miniapp", "1");
  Object.defineProperty(window, "Telegram", { configurable: true, value: { WebApp: sdk } });
  router.location = { pathname: "/product/training", search: {} };
});
afterEach(() => {
  cleanup();
  sessionStorage.removeItem("mw_miniapp");
  Reflect.deleteProperty(window, "Telegram");
});
function pressBack() {
  expect(handlers.size).toBe(1);
  act(() => {
    for (const handler of handlers) handler();
  });
}
it("returns to the same catalog filters and preserves leading-zero product searches", () => {
  router.location.search = {
    cat: "welding",
    q: "0001697",
    brand: "Учебный",
    min: 800,
    max: 3000,
    instock: 1,
    sale: 1,
    sort: "price-desc",
    role: "admin",
    returnTo: "https://example.com",
  };
  render(<TelegramShopBridge />);
  expect(sdk.BackButton.show).toHaveBeenCalled();
  pressBack();
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/",
    search: {
      cat: "welding",
      q: "0001697",
      brand: "Учебный",
      min: "800",
      max: "3000",
      instock: "1",
      sale: "1",
      sort: "price-desc",
    },
  });
});
it("uses the latest product query and removes the previous SDK handler", () => {
  router.location.search = { q: "Первый" };
  const screen = render(<TelegramShopBridge />);
  const oldHandler = [...handlers][0];
  router.location = { pathname: "/product/second", search: { q: "Второй", min: 900 } };
  screen.rerender(<TelegramShopBridge />);
  expect(handlers.has(oldHandler!)).toBe(false);
  pressBack();
  expect(router.navigate).toHaveBeenCalledTimes(1);
  expect(router.navigate.mock.calls[0]![0].search).toMatchObject({ q: "Второй", min: "900" });
  screen.unmount();
  expect(handlers.size).toBe(0);
});
it("falls back to the catalog for a direct product link without an external redirect", () => {
  router.location.search = { min: {}, instock: true, returnTo: "//external.example" };
  render(<TelegramShopBridge />);
  pressBack();
  const target = router.navigate.mock.calls[0]![0];
  expect(target.to).toBe("/");
  expect(Object.values(target.search).every((v) => v === undefined)).toBe(true);
});
it("does not copy unrelated page parameters and hides BackButton in the catalog", () => {
  router.location = { pathname: "/privacy", search: { q: "Не фильтр" } };
  const screen = render(<TelegramShopBridge />);
  pressBack();
  expect(router.navigate).toHaveBeenCalledWith({ to: "/", search: {} });
  sdk.BackButton.show.mockClear();
  router.location = { pathname: "/", search: { q: "Выбранный товар" } };
  screen.rerender(<TelegramShopBridge />);
  expect(sdk.BackButton.hide).toHaveBeenCalled();
  expect(sdk.BackButton.show).not.toHaveBeenCalled();
});
