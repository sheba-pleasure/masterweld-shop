import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { validateCatalogSearch } from "@/lib/catalog-search";

type Insets = { top?: number; bottom?: number; left?: number; right?: number };
type TelegramWebApp = {
  ready(): void;
  expand(): void;
  safeAreaInset?: Insets;
  contentSafeAreaInset?: Insets;
  onEvent?(event: string, callback: () => void): void;
  offEvent?(event: string, callback: () => void): void;
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(fn: () => void): void;
    offClick(fn: () => void): void;
  };
};
type TelegramWindow = Window & { Telegram?: { WebApp?: TelegramWebApp } };

/** Presentation only. Telegram launch parameters never grant identity or staff rights. */
export function TelegramShopBridge() {
  const [app, setApp] = useState<TelegramWebApp>();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    let remembered = false;
    try {
      remembered = sessionStorage.getItem("mw_miniapp") === "1";
    } catch {
      /* Shop works without SDK. */
    }
    if (
      !remembered &&
      !new URLSearchParams(location.search).has("miniapp") &&
      !location.hash.includes("tgWebAppVersion=")
    )
      return;
    try {
      sessionStorage.setItem("mw_miniapp", "1");
    } catch {
      /* No identity stored. */
    }
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      const api = (window as TelegramWindow).Telegram?.WebApp;
      if (!api) return;
      try {
        api.ready();
        api.expand();
        setApp(api);
      } catch {
        /* Keep ordinary site usable. */
      }
    };
    if ((window as TelegramWindow).Telegram?.WebApp) connect();
    else {
      let script = document.querySelector<HTMLScriptElement>("script[data-mw-telegram]");
      if (!script) {
        script = document.createElement("script");
        script.src = "https://telegram.org/js/telegram-web-app.js";
        script.async = true;
        script.dataset["mwTelegram"] = "1";
        document.head.append(script);
      }
      script.addEventListener("load", connect, { once: true });
    }
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!app) return;
    const root = document.documentElement;
    root.classList.add("mw-miniapp");
    const update = () => {
      for (const edge of ["top", "bottom", "left", "right"] as const) {
        const values = [app.safeAreaInset?.[edge], app.contentSafeAreaInset?.[edge]];
        const inset = values.reduce<number>(
          (sum, value) =>
            sum +
            (typeof value === "number" && Number.isFinite(value)
              ? Math.max(0, Math.min(200, value))
              : 0),
          0,
        );
        root.style.setProperty("--mw-tg-" + edge, inset + "px");
      }
    };
    update();
    app.onEvent?.("safeAreaChanged", update);
    app.onEvent?.("contentSafeAreaChanged", update);
    return () => {
      app.offEvent?.("safeAreaChanged", update);
      app.offEvent?.("contentSafeAreaChanged", update);
      root.classList.remove("mw-miniapp");
      for (const edge of ["top", "bottom", "left", "right"])
        root.style.removeProperty("--mw-tg-" + edge);
    };
  }, [app]);
  useEffect(() => {
    if (!app?.BackButton) return;
    const back = () => {
      void navigate({
        to: "/",
        search: pathname.startsWith("/product/") ? validateCatalogSearch(search) : {},
      });
    };
    if (pathname === "/") app.BackButton.hide();
    else app.BackButton.show();
    app.BackButton.onClick(back);
    return () => {
      app.BackButton?.offClick(back);
      app.BackButton?.hide();
    };
  }, [app, pathname, search, navigate]);
  return null;
}
