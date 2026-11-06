import { useEffect, useRef, useState } from "react";
import { CreditCard, Phone, ShoppingCart, Truck, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CartRows } from "@/components/CartRows";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useServerFn } from "@tanstack/react-start";
import { createOrder } from "@/lib/orders/orders.functions";
import { clearCart, useCart } from "@/lib/cart";
import {
  ATTEMPT_STORAGE_KEY,
  UNKNOWN_ORDER_MESSAGE,
  loadAttempt,
  saveAttempt,
  submissionSchema,
  type Submission,
} from "@/lib/orders/submission";
import { rub } from "@/lib/catalog";

const PHONE = { display: "+7 (495) 639-13-18", href: "tel:+74956391318" };

export function SiteActions() {
  const [open, setOpen] = useState(false);
  const [cabinet, setCabinet] = useState(false);
  const [serviceNotice, setServiceNotice] = useState<string | null>(null);
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

  const change = (next: boolean) => {
    setOpen(next);
    if (next) {
      setDone(false);
      if (storageReady && !attemptRef.current) setError(null);
      setPriceChange(null);
    }
  };

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
    try {
      const res = await placeOrder({ data: current });
      if (!res.ok && res.code !== "PRICE_CHANGED" && res.code !== "REJECTED") {
        setError(res.message ?? UNKNOWN_ORDER_MESSAGE);
        return;
      }
      // Only a durable, definitive server result allows a new attempt.
      if (!res.ok) {
        sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
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
        clearCart();
      }
      sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
      attemptRef.current = null;
      setAttempt(null);
      setDone(true);
    } catch {
      setError(UNKNOWN_ORDER_MESSAGE);
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
          className="checkout-sheet menu-panel inset-y-2 right-2 h-auto w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-brand-yellow/60 bg-brand-deep p-0 text-primary-foreground sm:max-w-3xl"
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
            <div className="px-5 pb-6 text-sm">
              <p className="font-semibold text-brand-yellow">
                {sending ? "Проверяем оформление…" : "Проверим результат оформления"}
              </p>
              <p className="mt-2">
                {attempt.name} · {attempt.phone}
              </p>
              <p className="mt-1">
                Позиций: {attempt.items.length}. Сумма при отправке:{" "}
                {rub(attempt.expected?.total ?? 0)}.
              </p>
              <p role="status" className="mt-3">
                {error ??
                  (sending
                    ? "Проверяем сохранённую попытку. Дождитесь ответа."
                    : "Нажмите кнопку ниже, чтобы получить результат сохранённой попытки.")}
              </p>
              <Button
                onClick={send}
                disabled={sending}
                className="checkout-submit mt-4 h-auto min-h-11 whitespace-normal bg-brand-yellow text-brand-deep"
              >
                {sending ? "Проверяем…" : "Проверить и завершить заказ"}
              </Button>
              <p className="mt-3 text-xs text-primary-foreground/70">
                Не закрывайте эту вкладку и не оформляйте тот же заказ в другой. При повторной
                проверке вернётся результат этой попытки.
              </p>
              <p className="mt-2 break-all text-xs text-primary-foreground/60">
                Код для проверки магазином: {attempt.requestId}
              </p>
              <a href={PHONE.href} className="mt-2 inline-block text-brand-yellow">
                {PHONE.display}
              </a>
            </div>
          ) : items.length === 0 ? (
            <p className="px-5 pb-6 text-sm text-primary-foreground/70">
              Корзина пуста.
              <button type="button" onClick={() => setOpen(false)} className="ml-1 underline">
                Выбрать товары
              </button>
            </p>
          ) : (
            <div className="checkout-layout">
              <div className="checkout-products">
                <CartRows items={items} onNavigate={() => setOpen(false)} />
              </div>
              <div className="checkout-details flex flex-col gap-2">
                <div className="flex items-center justify-between border-b border-brand-yellow/20 pb-2">
                  <span className="text-xs text-primary-foreground/70">Ваши данные</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-brand-yellow"
                    onClick={() => {
                      setOpen(false);
                      setCabinet(true);
                    }}
                  >
                    <User /> Войти
                  </Button>
                </div>

                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-primary-foreground/70">Итого</span>
                  <span className="font-display text-xl font-bold text-brand-yellow">
                    {rub(priceChange?.total ?? total)}
                  </span>
                </div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Имя"
                  aria-label="Имя покупателя"
                  autoComplete="name"
                  className="menu-field checkout-field"
                />
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Телефон"
                  aria-label="Телефон покупателя"
                  autoComplete="tel"
                  type="tel"
                  inputMode="tel"
                  className="menu-field checkout-field"
                />
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Комментарий к заказу (необязательно)"
                  rows={2}
                  aria-label="Комментарий к заказу"
                  className="menu-field checkout-field resize-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="ghost"
                    className="checkout-service"
                    onClick={() =>
                      setServiceNotice(
                        "Онлайн-оплата пока не подключена. Списание денег недоступно.",
                      )
                    }
                  >
                    <CreditCard /> Оплатить онлайн
                  </Button>
                  <Button
                    variant="ghost"
                    className="checkout-service"
                    onClick={() =>
                      setServiceNotice(
                        "Доставка пока не настроена. Службу, стоимость и сроки согласуем отдельно.",
                      )
                    }
                  >
                    <Truck /> Доставка
                  </Button>
                </div>
                {serviceNotice && (
                  <p role="status" className="text-xs text-primary-foreground/70">
                    {serviceNotice}
                  </p>
                )}
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

      <Sheet open={cabinet} onOpenChange={setCabinet}>
        <SheetTrigger asChild>
          <button
            type="button"
            className="head-btn !hidden sm:!inline-flex"
            aria-label="Личный кабинет"
          >
            <User className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </SheetTrigger>
        <SheetContent
          side="right"
          className="menu-panel inset-y-3 right-3 h-auto w-[92vw] max-w-md overflow-y-auto rounded-md border border-brand-yellow/60 bg-brand-deep p-0 text-primary-foreground"
        >
          <SheetHeader className="p-5 pb-2">
            <SheetTitle className="menu-label menu-label--title text-brand-yellow">
              Личный кабинет
            </SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-5 pb-6 text-sm">
            <p className="text-primary-foreground/75">
              Готовим раздел, где будут видны ваши заказы: статус, история и повтор заказа в один
              клик.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="ghost" disabled className="checkout-service">
                Войти
              </Button>
              <Button variant="ghost" disabled className="checkout-service">
                Создать аккаунт
              </Button>
              <Button variant="ghost" disabled className="checkout-service">
                Восстановить пароль
              </Button>
              <Button variant="ghost" disabled className="checkout-service">
                Изменить почту
              </Button>
            </div>
            <p className="text-xs text-primary-foreground/60">
              Вход пока не подключён. Имя, контакты и предпочтения будут сохраняться после
              подключения кабинета.
            </p>
            <p className="text-primary-foreground/75">
              А пока оформите заказ через корзину или позвоните — примем и посчитаем сами.
            </p>
            <button
              type="button"
              onClick={() => {
                setCabinet(false);
                setOpen(true);
              }}
              className="menu-pill menu-pill--accent menu-label flex min-h-12 items-center justify-center"
            >
              Открыть корзину
            </button>
            <p className="text-xs text-primary-foreground/50">
              Телефон отдела сварки:{" "}
              <a href={PHONE.href} className="text-brand-yellow">
                {PHONE.display}
              </a>
            </p>
          </div>
        </SheetContent>
      </Sheet>

      <a href={PHONE.href} className="head-btn head-btn--call" aria-label="Позвонить по телефону">
        <Phone className="h-4 w-4" strokeWidth={2.4} />
        <span className="hidden lg:inline">Позвонить по телефону</span>
      </a>
    </div>
  );
}
