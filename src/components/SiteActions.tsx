import { useEffect, useRef, useState } from "react";
import { Phone, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CartRows } from "@/components/CartRows";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { createOrder } from "@/lib/orders/orders.functions";
import { refreshCart, useCart, OPEN_CART_EVENT } from "@/lib/cart";
import {
  ATTEMPT_STORAGE_KEY,
  UNKNOWN_ORDER_MESSAGE,
  loadAttempt,
  saveAttempt,
  submissionSchema,
  type Submission,
  type CreateOrderResult,
} from "@/lib/orders/submission";
import { rub } from "@/lib/catalog";

import { CONTACTS } from "@/lib/contacts";

const PHONE = { display: CONTACTS.phoneDisplay, href: CONTACTS.phoneHref };

export function SiteActions() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [attempt, setAttempt] = useState<Submission | null>(null);
  const attemptRef = useRef<Submission | null>(null);
  const sendingRef = useRef(false);
  const [storageReady, setStorageReady] = useState(false);
  useEffect(() => {
    try {
      const saved = loadAttempt(sessionStorage);
      attemptRef.current = saved;
      setAttempt(saved);
      if (saved) {
        setName(saved.name);
        setPhone(saved.phone);
        setComment(saved.comment ?? "");
      }
      setStorageReady(true);
    } catch {
      setError(
        "Не удалось прочитать сохранённую попытку заказа. Не оформляйте заново: свяжитесь с магазином для проверки.",
      );
    }
  }, []);
  const [done, setDone] = useState(false);
  const [resolvedAttempt, setResolvedAttempt] = useState<{
    requestId: string;
    result: CreateOrderResult;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneInfo, setDoneInfo] = useState<{
    number?: string | undefined;
    total?: number | undefined;
    backorder?: boolean | undefined;
  }>({});
  // PRICE_CHANGED: сервер вернул актуальную сумму и строки — ждём явного
  // подтверждения покупателя, автоматической повторной отправки нет.
  const [priceChange, setPriceChange] = useState<{
    total: number;
    items: { product_id: string; title: string; price: number }[];
  } | null>(null);
  const { items, count, total } = useCart();
  const placeOrder = useServerFn(createOrder);
  const resolution =
    attempt && resolvedAttempt?.requestId === attempt.requestId ? resolvedAttempt.result : null;

  const change = (next: boolean) => {
    setOpen(next);
    if (next) {
      setDone(false);
      if (storageReady && !attemptRef.current) setError(null);
      setPriceChange(null);
    }
  };

  useEffect(() => {
    const showCart = () => {
      setOpen(true);
      setDone(false);
      setPriceChange(null);
      if (storageReady && !attemptRef.current) setError(null);
    };
    window.addEventListener(OPEN_CART_EVENT, showCart);
    return () => window.removeEventListener(OPEN_CART_EVENT, showCart);
  }, [storageReady]);

  // Любое изменение корзины аннулирует предыдущее сравнение цен.
  useEffect(() => {
    setPriceChange(null);
  }, [items]);

  const send = async () => {
    if (sendingRef.current || !storageReady) return;
    let current = attemptRef.current;
    if (!current) {
      const parsed = submissionSchema.safeParse({
        requestId: crypto.randomUUID(),
        name: name.trim(),
        phone: phone.trim(),
        comment: comment.trim() || null,
        items: items.map((i) => ({ product_id: i.id, qty: i.qty })),
        expected: priceChange
          ? {
              total: priceChange.total,
              items: priceChange.items.map((i) => ({
                product_id: i.product_id,
                unit_price: i.price,
              })),
            }
          : {
              total: Math.round(total * 100) / 100,
              items: items.map((i) => ({ product_id: i.id, unit_price: i.price })),
            },
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "Проверьте данные заказа.");
        return;
      }
      current = parsed.data;
      try {
        saveAttempt(sessionStorage, current);
      } catch {
        setError(
          "Браузер не сохранил попытку. Заказ не отправлялся. Разрешите хранение данных сайта и повторите.",
        );
        return;
      }
      attemptRef.current = current;
      setAttempt(current);
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    // A definitive response stays attached to its attempt even if browser cleanup fails.
    // Retry only the unfinished local work; do not submit or re-read this known result.
    let confirmedResult =
      resolvedAttempt?.requestId === current.requestId ? resolvedAttempt.result : null;
    try {
      const res = confirmedResult ?? (await placeOrder({ data: current }));
      if (!res.ok && res.code !== "PRICE_CHANGED" && res.code !== "REJECTED") {
        setError(res.message ?? UNKNOWN_ORDER_MESSAGE);
        return;
      }
      confirmedResult = res;
      setResolvedAttempt({ requestId: current.requestId, result: res });
      // Only a durable, definitive server result allows a new attempt.
      if (!res.ok) {
        sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
        if (sessionStorage.getItem(ATTEMPT_STORAGE_KEY) !== null)
          throw new Error("ATTEMPT_CLEANUP_FAILED");
        attemptRef.current = null;
        setAttempt(null);
        if (res.code === "PRICE_CHANGED" && typeof res.total === "number") {
          setPriceChange({
            total: res.total,
            items: (res.items ?? []).map((i) => ({
              product_id: i.product_id,
              title: i.title,
              price: i.price,
            })),
          });
        } else setError(res.message ?? "Проверьте данные заказа.");
        return;
      }
      setDoneInfo({ number: res.number, total: res.total, backorder: res.hasBackorder });
      // Clear the submitted cart BEFORE dropping the recovery token. A reload
      // between these steps can still recover the receipt instead of reordering.
      const persisted: unknown = JSON.parse(localStorage.getItem("mw_cart_v1") ?? "[]");
      if (
        Array.isArray(persisted) &&
        persisted.length === current.items.length &&
        persisted.every((i) =>
          current.items.some((p) => p.product_id === i?.id && p.qty === i?.qty),
        )
      ) {
        localStorage.setItem("mw_cart_v1", "[]");
        if (localStorage.getItem("mw_cart_v1") !== "[]") throw new Error("CART_STORAGE_FAILED");
      }
      // Another tab may have changed or cleared the cart while the order was in flight.
      // Show its current contents without writing our old in-memory snapshot back.
      refreshCart();
      sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
      if (sessionStorage.getItem(ATTEMPT_STORAGE_KEY) !== null)
        throw new Error("ATTEMPT_CLEANUP_FAILED");
      attemptRef.current = null;
      setAttempt(null);
      setDone(true);
    } catch {
      setError(
        confirmedResult
          ? "Результат уже получен, но браузер не завершил оформление. Нажмите «Завершить в браузере». Повторного заказа не будет."
          : UNKNOWN_ORDER_MESSAGE,
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // Строки, где цена в корзине покупателя отличается от серверной.
  const changedLines = priceChange
    ? priceChange.items
        .map((s) => {
          const cart = items.find((i) => i.id === s.product_id);
          if (!cart) return null;
          if (Math.round(cart.price * 100) === Math.round(s.price * 100)) return null;
          return { title: s.title, was: cart.price, now: s.price };
        })
        .filter((l): l is { title: string; was: number; now: number } => l !== null)
    : [];

  return (
    <div className="flex items-center gap-2">
      <Sheet open={open} onOpenChange={change}>
        <SheetTrigger asChild>
          <button type="button" className="head-btn" aria-label={`Корзина: ${count} шт.`}>
            <span className="relative">
              <ShoppingCart className="h-4 w-4" strokeWidth={2.4} />
              {count > 0 && <span className="cart-badge">{count > 99 ? "99+" : count}</span>}
            </span>
            <span className="hidden 2xl:inline">Корзина</span>
            {total > 0 && <span className="hidden 2xl:inline opacity-70">{rub(total)}</span>}
          </button>
        </SheetTrigger>
        <SheetContent
          side="right"
          className="checkout-sheet menu-panel inset-y-2 right-2 h-auto w-[calc(100%-16px)] overflow-y-auto rounded-md border border-brand-yellow/60 bg-brand-deep p-0 text-primary-foreground sm:max-w-3xl"
        >
          <SheetHeader className="border-b border-brand-yellow/20 px-4 py-3 text-left">
            <SheetTitle className="menu-label menu-label--title text-brand-yellow">
              Корзина{" "}
              <span className="ml-2 text-xs font-normal text-primary-foreground/60">
                {attempt?.items.length ?? items.length} поз. ·{" "}
                {attempt ? attempt.items.reduce((n, i) => n + i.qty, 0) : count} шт.
              </span>
            </SheetTitle>
          </SheetHeader>

          {done ? (
            <div className="px-5 pb-6 text-sm">
              <p className="font-semibold text-brand-yellow">
                Спасибо! Заказ {doneInfo.number ?? ""} принят.
              </p>
              <p className="mt-2 text-primary-foreground/70">
                {import.meta.env["VITE_APP_ENV"] === "dev"
                  ? "Учебный заказ сохранён. Звонка, оплаты и доставки не будет."
                  : `Позвоним на ${phone.trim()} и уточним доставку.`}
              </p>
              {doneInfo.total !== undefined && (
                <p className="mt-1 text-primary-foreground/70">
                  Итог по нашим ценам:{" "}
                  <span className="font-semibold text-brand-yellow">{rub(doneInfo.total)}</span>
                </p>
              )}
              {doneInfo.backorder && import.meta.env["VITE_APP_ENV"] !== "dev" && (
                <p className="mt-2 text-xs text-primary-foreground/60">
                  Часть позиций отмечена как отсутствующая на складе — это заказ «под заказ», срок
                  поставки подтвердит менеджер по телефону.
                </p>
              )}
            </div>
          ) : attempt ? (
            <div className="px-5 pb-6 pt-4 text-sm">
              <p className="font-semibold text-brand-yellow">
                {resolution?.ok
                  ? `Заказ ${resolution.number ?? ""} сохранён.`
                  : resolution?.code === "PRICE_CHANGED"
                    ? "Цены изменились — заказ не оформлен."
                    : resolution
                      ? "Заказ не оформлен."
                      : sending
                        ? "Проверяем оформление…"
                        : "Проверим результат оформления"}
              </p>
              <p className="mt-2 break-words">
                {attempt.name} · {attempt.phone}
              </p>
              {import.meta.env["VITE_APP_ENV"] === "dev" && (
                <p className="mt-2 text-primary-foreground/70">
                  Учебный магазин · DEV. Звонка, оплаты и доставки не будет.
                </p>
              )}
              <p className="mt-1">
                Позиций: {attempt.items.length}.{" "}
                {resolution?.ok && resolution.total !== undefined
                  ? "Сумма заказа: "
                  : "Сумма при отправке: "}
                <span className="whitespace-nowrap">
                  {rub(
                    resolution?.ok && resolution.total !== undefined
                      ? resolution.total
                      : (attempt.expected?.total ?? 0),
                  )}
                </span>
                .
              </p>
              <p role="status" className="mt-3">
                {error ??
                  (resolution
                    ? "Завершаем оформление в браузере. Новый заказ не отправляется."
                    : sending
                      ? "Проверяем сохранённую попытку. Дождитесь ответа."
                      : "Нажмите кнопку ниже, чтобы получить результат сохранённой попытки.")}
              </p>
              <Button
                onClick={send}
                disabled={sending}
                className="checkout-submit mt-4 h-auto min-h-11 whitespace-normal bg-brand-yellow text-brand-deep hover:bg-brand-yellow/90"
              >
                {resolution
                  ? sending
                    ? "Завершаем…"
                    : "Завершить в браузере"
                  : sending
                    ? "Проверяем…"
                    : "Проверить и завершить заказ"}
              </Button>
              <p className="mt-3 text-xs text-primary-foreground/70">
                {resolution?.ok
                  ? "Заказ уже сохранён. Не оформляйте его заново. Кнопка выше завершит работу с этой корзиной."
                  : resolution?.code === "PRICE_CHANGED"
                    ? "После завершения проверьте новую сумму. Заказ появится только после вашего согласия."
                    : resolution
                      ? "После завершения исправьте данные заказа. Затем его можно отправить заново."
                      : "Не закрывайте эту вкладку и не оформляйте тот же заказ в другой. При повторной проверке вернётся результат этой попытки."}
              </p>
              <p className="mt-2 break-all text-xs text-primary-foreground/60">
                Код для проверки магазином: {attempt.requestId}
              </p>
              <a href={PHONE.href} className="mt-2 inline-block text-brand-yellow">
                {PHONE.display}
              </a>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col gap-3 px-5 pb-6">
              <p className="text-primary-foreground">В корзине пока ничего нет</p>
              <Link
                to="/"
                onClick={() => setOpen(false)}
                className="menu-pill menu-pill--accent flex min-h-11 items-center justify-center"
              >
                Открыть каталог
              </Link>
              <a href={PHONE.href} className="text-sm text-brand-yellow">
                Помочь с подбором? {PHONE.display}
              </a>
            </div>
          ) : (
            <div className="checkout-layout">
              <div className="checkout-products">
                <CartRows items={items} onNavigate={() => setOpen(false)} />
              </div>
              <div className="checkout-details flex flex-col gap-2">
                <p className="border-b border-brand-yellow/20 pb-2 text-sm text-primary-foreground/75">
                  Для заказа регистрация не нужна.
                </p>

                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-primary-foreground/70">Итого</span>
                  <span className="font-display text-xl font-bold text-brand-yellow">
                    {rub(priceChange?.total ?? total)}
                  </span>
                </div>
                <label htmlFor="checkout-name" className="text-sm text-primary-foreground">
                  Имя
                </label>
                <input
                  id="checkout-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Имя"
                  aria-label="Имя покупателя"
                  autoComplete="name"
                  className="menu-field checkout-field"
                />
                <label htmlFor="checkout-phone" className="text-sm text-primary-foreground">
                  Телефон
                </label>
                <input
                  id="checkout-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Телефон"
                  aria-label="Телефон покупателя"
                  autoComplete="tel"
                  type="tel"
                  inputMode="tel"
                  className="menu-field checkout-field"
                />
                <label htmlFor="checkout-comment" className="text-sm text-primary-foreground">
                  Комментарий (необязательно)
                </label>
                <textarea
                  id="checkout-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Комментарий к заказу (необязательно)"
                  rows={2}
                  aria-label="Комментарий к заказу"
                  className="menu-field checkout-field resize-none"
                />
                <p className="text-xs leading-relaxed text-primary-foreground/75">
                  Онлайн-оплата пока недоступна. Условия оплаты и получения уточните у сотрудника
                  магазина.
                </p>
                <Button
                  onClick={send}
                  disabled={sending || !storageReady || !name.trim() || !phone.trim()}
                  className="checkout-submit h-auto min-h-11 whitespace-normal bg-brand-yellow px-3 py-2 text-brand-deep hover:bg-brand-yellow/90"
                >
                  {sending
                    ? "Отправляем…"
                    : priceChange
                      ? "Согласиться с новой ценой и оформить"
                      : import.meta.env["VITE_APP_ENV"] === "dev"
                        ? "Оформить учебный заказ"
                        : "Оформить заказ"}
                </Button>
                {(!name.trim() || !phone.trim()) && (
                  <p className="text-xs text-primary-foreground/75">
                    Укажите имя и телефон, чтобы оформить заказ.
                  </p>
                )}
                {priceChange && (
                  <div className="rounded-md border border-brand-yellow/50 p-3 text-xs">
                    <p className="font-semibold text-brand-yellow">
                      Цены изменились — заказ пока не оформлен.
                    </p>
                    <ul className="mt-2 flex flex-col gap-1 text-primary-foreground/80">
                      {changedLines.map((l) => (
                        <li key={l.title} className="line-clamp-2">
                          {l.title}: <span className="line-through opacity-70">{rub(l.was)}</span> →{" "}
                          <span className="font-semibold text-brand-yellow">{rub(l.now)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-primary-foreground/80">
                      Итог: <span className="line-through opacity-70">{rub(total)}</span> →{" "}
                      <span className="font-semibold text-brand-yellow">
                        {rub(priceChange.total)}
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setPriceChange(null)}
                      className="mt-2 underline opacity-80"
                    >
                      Отмена — вернуться к корзине
                    </button>
                  </div>
                )}
                {error && (
                  <p role="alert" className="text-xs text-brand-yellow">
                    {error}
                  </p>
                )}
                <p className="text-xs text-primary-foreground/50">
                  Или просто позвоните:{" "}
                  <a href={PHONE.href} className="text-brand-yellow">
                    {PHONE.display}
                  </a>
                </p>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <a href={PHONE.href} className="head-btn head-btn--call" aria-label="Позвонить по телефону">
        <Phone className="h-4 w-4" strokeWidth={2.4} />
        <span className="hidden lg:inline">Позвонить по телефону</span>
      </a>
    </div>
  );
}
