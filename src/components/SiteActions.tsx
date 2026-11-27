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
  canonicalPayload,
} from "@/lib/orders/submission";
import { reserveAttempt, forgetRejectedAttempt } from "@/lib/orders/browser-attempt";
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
  const [reusedRequestId, setReusedRequestId] = useState<string | null>(null);
  const [lastAccepted, setLastAccepted] = useState<Submission | null>(null);
  const [repeatConfirmed, setRepeatConfirmed] = useState(false);
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
    setRepeatConfirmed(false);
    if (next) {
      setDone(false);
      if (storageReady && !attemptRef.current) setError(null);
      setPriceChange(null);
    }
  };

  useEffect(() => {
    const showCart = () => {
      setOpen(true);
      setRepeatConfirmed(false);
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
    sendingRef.current = true;
    setSending(true);
    setError(null);
    let current = attemptRef.current;
    let confirmedResult =
      current && resolvedAttempt?.requestId === current.requestId ? resolvedAttempt.result : null;
    let requestStarted = false;
    let reused = current?.requestId === reusedRequestId;
    try {
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
        const repeatOf =
          repeatConfirmed &&
          lastAccepted &&
          canonicalPayload(parsed.data) === canonicalPayload(lastAccepted)
            ? lastAccepted.requestId
            : undefined;
        const reservation = await reserveAttempt(parsed.data, repeatOf ? { repeatOf } : {});
        current = reservation.attempt;
        reused = reservation.reused;
        setReusedRequestId(reused ? current.requestId : null);
        saveAttempt(sessionStorage, current);
        attemptRef.current = current;
        setAttempt(current);
        setRepeatConfirmed(false);
      } else if (!confirmedResult) {
        const reservation = await reserveAttempt(current, { resume: true });
        reused = reservation.reused;
        setReusedRequestId(reused ? current.requestId : null);
      }
      // A definitive response stays attached to its attempt even if browser cleanup fails.
      // Retry only unfinished local work; never rotate an ID to escape an unknown outcome.
      requestStarted = true;
      const res = confirmedResult ?? (await placeOrder({ data: current }));
      if (!res.ok && res.code !== "PRICE_CHANGED" && res.code !== "REJECTED") {
        setError(res.message ?? UNKNOWN_ORDER_MESSAGE);
        return;
      }
      confirmedResult = res;
      setResolvedAttempt({ requestId: current.requestId, result: res });
      if (!res.ok) {
        await forgetRejectedAttempt(current);
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
      setLastAccepted(current);
      // A reused receipt must not clear items added again after the original order.
      // The initiating attempt clears its unchanged cart before dropping recovery.
      if (!reused) {
        const submittedItems = current.items;
        const persisted: unknown = JSON.parse(localStorage.getItem("mw_cart_v1") ?? "[]");
        if (
          Array.isArray(persisted) &&
          persisted.length === submittedItems.length &&
          persisted.every((i) =>
            submittedItems.some((p) => p.product_id === i?.id && p.qty === i?.qty),
          )
        ) {
          localStorage.setItem("mw_cart_v1", "[]");
          if (localStorage.getItem("mw_cart_v1") !== "[]") throw new Error("CART_STORAGE_FAILED");
        }
      }
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
          : requestStarted
            ? UNKNOWN_ORDER_MESSAGE
            : "Не удалось безопасно проверить сохранённую попытку. Разрешите хранение данных сайта и повторите проверку здесь. Если ошибка остаётся, позвоните в магазин; не оформляйте тот же заказ в другом браузере.",
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // Show the offered prices consistently without accepting or persisting them.
  // Cancellation or any cart edit returns to the saved cart and requires a fresh check.
  const displayedItems = priceChange
    ? items.map((item) => {
        const offered = priceChange.items.find((line) => line.product_id === item.id);
        return offered ? { ...item, price: offered.price } : item;
      })
    : items;

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
              <ShoppingCart className="h-4 w-4 text-mw-cyan" strokeWidth={2.2} />
              {count > 0 && <span className="cart-badge">{count > 99 ? "99+" : count}</span>}
            </span>
            <span className="hidden 2xl:inline">Корзина</span>
            {total > 0 && (
              <span className="hidden font-mono text-xs text-muted-foreground tabular-nums 2xl:inline">
                {rub(total)}
              </span>
            )}
          </button>
        </SheetTrigger>
        <SheetContent
          side="right"
          className="checkout-sheet menu-panel inset-y-2 right-2 h-auto w-[calc(100%-16px)] overflow-y-auto rounded-2xl border border-white/12 p-0 text-foreground sm:max-w-3xl"
        >
          <SheetHeader className="border-b border-white/10 px-4 py-4 text-left">
            <SheetTitle className="menu-label menu-label--title flex items-center text-white">
              <span>Корзина</span>
              <span className="ml-3 font-mono text-xs font-medium text-muted-foreground tabular-nums">
                {attempt?.items.length ?? items.length} поз. ·{" "}
                {attempt ? attempt.items.reduce((n, i) => n + i.qty, 0) : count} шт.
              </span>
            </SheetTitle>
          </SheetHeader>

          {done ? (
            <div className="px-5 py-6 text-sm">
              <p className="font-display text-base font-bold text-mw-emerald">
                Спасибо! Заказ {doneInfo.number ?? ""} принят.
              </p>
              <p className="mt-2 text-muted-foreground">
                {import.meta.env["VITE_APP_ENV"] === "dev"
                  ? "Учебный заказ сохранён. Звонка, оплаты и доставки не будет."
                  : `Позвоним на ${phone.trim()} и уточним доставку.`}
              </p>
              {doneInfo.total !== undefined && (
                <p className="mt-2 text-muted-foreground">
                  Итог по нашим ценам:{" "}
                  <span className="font-display font-bold text-white tabular-nums">
                    {rub(doneInfo.total)}
                  </span>
                </p>
              )}
              {lastAccepted?.requestId === reusedRequestId && (
                <div className="mt-4 space-y-3 rounded-2xl border border-white/10 bg-mw-void/70 p-4">
                  <p role="status" className="text-secondary-foreground">
                    Найден результат ранее начатого оформления. Второй заказ не создан.
                    {items.length > 0 &&
                      " Товары оставлены в корзине. Если нужен ещё один заказ, подтвердите это отдельно."}
                  </p>
                  {items.length > 0 && (
                    <Button
                      className="h-auto min-h-11 rounded-full whitespace-normal bg-mw-amber px-5 text-white hover:bg-mw-amber/90"
                      onClick={() => {
                        setRepeatConfirmed(true);
                        setDone(false);
                        setError(null);
                      }}
                    >
                      Нужен ещё один заказ — проверить корзину
                    </Button>
                  )}
                </div>
              )}
              {doneInfo.backorder && import.meta.env["VITE_APP_ENV"] !== "dev" && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Часть позиций отмечена как отсутствующая на складе — это заказ «под заказ», срок
                  поставки подтвердит менеджер по телефону.
                </p>
              )}
            </div>
          ) : attempt ? (
            <div className="px-5 py-6 text-sm">
              <p className="font-display text-base font-bold text-mw-amber">
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
              <p className="mt-2 break-words text-white">
                {attempt.name} · {attempt.phone}
              </p>
              {import.meta.env["VITE_APP_ENV"] === "dev" && (
                <p className="mt-2 text-muted-foreground">
                  Учебный магазин · DEV. Звонка, оплаты и доставки не будет.
                </p>
              )}
              <p className="mt-2 text-secondary-foreground">
                Позиций: {attempt.items.length}.{" "}
                {resolution?.ok && resolution.total !== undefined
                  ? "Сумма заказа: "
                  : "Сумма при отправке: "}
                <span className="whitespace-nowrap font-mono font-bold text-white tabular-nums">
                  {rub(
                    resolution?.ok && resolution.total !== undefined
                      ? resolution.total
                      : (attempt.expected?.total ?? 0),
                  )}
                </span>
                .
              </p>
              <p role="status" className="mt-3 rounded-xl border border-white/10 bg-mw-void/70 p-3">
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
                className="checkout-submit mt-4 h-auto min-h-11 rounded-full whitespace-normal bg-mw-amber px-6 font-bold text-white hover:bg-mw-amber/90"
              >
                {resolution
                  ? sending
                    ? "Завершаем…"
                    : "Завершить в браузере"
                  : sending
                    ? "Проверяем…"
                    : "Проверить и завершить заказ"}
              </Button>
              <p className="mt-3 text-xs text-muted-foreground">
                {resolution?.ok
                  ? "Заказ уже сохранён. Не оформляйте его заново. Кнопка выше завершит работу с этой корзиной."
                  : resolution?.code === "PRICE_CHANGED"
                    ? "После завершения проверьте новую сумму. Заказ появится только после вашего согласия."
                    : resolution
                      ? "После завершения исправьте данные заказа. Затем его можно отправить заново."
                      : "Не закрывайте эту вкладку и не оформляйте тот же заказ в другой. При повторной проверке вернётся результат этой попытки."}
              </p>
              <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
                Код для проверки магазином: {attempt.requestId}
              </p>
              <a
                href={PHONE.href}
                className="mt-2 inline-block font-mono text-sm font-semibold text-mw-cyan hover:text-white"
              >
                {PHONE.display}
              </a>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col gap-4 px-5 py-8">
              <p className="text-secondary-foreground">В корзине пока ничего нет</p>
              <Link
                to="/"
                onClick={() => setOpen(false)}
                className="menu-pill menu-pill--accent flex min-h-11 items-center justify-center font-semibold"
              >
                Открыть каталог
              </Link>
              <a href={PHONE.href} className="font-mono text-sm text-mw-cyan hover:text-white">
                Помочь с подбором? {PHONE.display}
              </a>
            </div>
          ) : (
            <div className="checkout-layout">
              <div className="checkout-products">
                <CartRows items={displayedItems} onNavigate={() => setOpen(false)} />
              </div>
              <div className="checkout-details flex flex-col gap-2.5">
                <p className="border-b border-white/10 pb-2.5 text-sm text-muted-foreground">
                  {repeatConfirmed
                    ? "Вы создаёте ещё один заказ. Проверьте товары, сумму и контакты, затем подтвердите оформление."
                    : "Для заказа регистрация не нужна."}
                </p>

                <div className="flex items-baseline justify-between py-1">
                  <span className="text-sm text-muted-foreground">Итого</span>
                  <span className="font-display text-2xl font-semibold text-white tabular-nums">
                    {rub(priceChange?.total ?? total)}
                  </span>
                </div>
                <label
                  htmlFor="checkout-name"
                  className="text-xs font-medium text-secondary-foreground"
                >
                  Имя
                </label>
                <input
                  id="checkout-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Имя покупателя"
                  autoComplete="name"
                  className="menu-field checkout-field"
                />
                <label
                  htmlFor="checkout-phone"
                  className="text-xs font-medium text-secondary-foreground"
                >
                  Телефон
                </label>
                <input
                  id="checkout-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+7 (999) 000-00-00"
                  aria-label="Телефон покупателя"
                  autoComplete="tel"
                  type="tel"
                  inputMode="tel"
                  className="menu-field checkout-field"
                />
                <label
                  htmlFor="checkout-comment"
                  className="text-xs font-medium text-secondary-foreground"
                >
                  Комментарий (необязательно)
                </label>
                <textarea
                  id="checkout-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  aria-label="Комментарий к заказу"
                  className="menu-field checkout-field resize-none"
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Онлайн-оплата пока недоступна. Условия оплаты и получения уточните у сотрудника
                  магазина.
                </p>
                <Button
                  onClick={send}
                  disabled={sending || !storageReady || !name.trim() || !phone.trim()}
                  className="checkout-submit h-auto min-h-11 rounded-xl whitespace-normal bg-mw-amber px-4 py-2.5 font-semibold text-white hover:bg-mw-amber/90"
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
                  <p className="text-xs text-muted-foreground">
                    Укажите имя и телефон, чтобы оформить заказ.
                  </p>
                )}
                {priceChange && (
                  <div className="rounded-2xl border border-mw-amber/45 bg-mw-amber/10 p-3.5 text-xs">
                    <p className="font-semibold text-mw-amber">
                      Цены изменились — заказ пока не оформлен.
                    </p>
                    <ul className="mt-2 flex flex-col gap-1 text-secondary-foreground">
                      {changedLines.map((l) => (
                        <li key={l.title} className="line-clamp-2">
                          {l.title}:{" "}
                          <span className="font-mono line-through opacity-70">{rub(l.was)}</span> →{" "}
                          <span className="font-mono font-semibold text-white">{rub(l.now)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-secondary-foreground">
                      Итог: <span className="font-mono line-through opacity-70">{rub(total)}</span>{" "}
                      →{" "}
                      <span className="font-mono font-semibold text-mw-amber">
                        {rub(priceChange.total)}
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setPriceChange(null)}
                      className="mt-2 text-mw-cyan underline underline-offset-4 hover:text-white"
                    >
                      Отмена — вернуться к корзине
                    </button>
                  </div>
                )}
                {error && (
                  <p
                    role="alert"
                    className="rounded-xl border border-mw-amber/40 bg-mw-amber/10 px-3 py-2 text-xs text-mw-amber"
                  >
                    {error}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Или просто позвоните:{" "}
                  <a href={PHONE.href} className="font-mono text-mw-cyan hover:text-white">
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
