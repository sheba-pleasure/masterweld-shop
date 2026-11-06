// Чистая (тестируемая) логика панели управления каталогом в Telegram-боте
// интернет-магазина «Мастер Сварщик». Никаких обращений к БД/Telegram —
// только преобразования данных: поиск, карточки, парсеры, кодирование callback.

import { isDiscounted, normalizeText } from "@/lib/search";
import { DECISION } from "./assortment";

export interface BotProduct {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  sku: string | null;
  price: number;
  old_price: number | null;
  in_stock: boolean;
  stock_qty: number | null;
  status: string;
  assortment_decision?: string;
  category_id: string | null;
  description?: string | null;
  specs?: string | null;
}

export type Btn = { text: string; callback_data: string };
export type BtnRows = Btn[][];

/** Лимит Telegram для callback_data — 64 байта (UTF-8). */
export const CB_LIMIT_BYTES = 64;

export function callbackBytes(data: string): number {
  return new TextEncoder().encode(data).length;
}

/** Проверяет длину callback_data и возвращает его; слишком длинный — ошибка. */
export function makeCallback(data: string): string {
  if (callbackBytes(data) > CB_LIMIT_BYTES) {
    throw new Error(`callback_data превышает ${CB_LIMIT_BYTES} байт`);
  }
  return data;
}

/** Служебные данные и операции бота — только в личном чате сотрудника с ботом. */
export function isPrivateChat(
  chat: { id: number; type?: string } | null | undefined,
  from: { id: number } | null | undefined,
): boolean {
  if (!chat || !from) return false;
  return chat.type === "private" && chat.id === from.id;
}

export const PRODUCTS_PAGE_SIZE = 10;

export interface BotSearchResult {
  /** Страница результатов (до PRODUCTS_PAGE_SIZE). */
  items: BotProduct[];
  /** Все совпадения целиком (для пагинации). */
  all: BotProduct[];
  total: number;
  page: number;
  pages: number;
  /** Несколько товаров с одинаковым точным SKU — обязателен выбор UUID. */
  ambiguousSku: boolean;
}

function matchList(
  products: BotProduct[],
  query: string,
): { matches: BotProduct[]; ambiguousSku: boolean } {
  const q = normalizeText(query);
  if (!q) {
    return {
      matches: [...products].sort((a, b) => a.title.localeCompare(b.title, "ru")),
      ambiguousSku: false,
    };
  }
  const exact = products.filter((p) => p.sku !== null && normalizeText(p.sku) === q);
  if (exact.length > 0) {
    return { matches: exact, ambiguousSku: exact.length > 1 };
  }
  const tokens = q.split(" ").filter(Boolean);
  const matches = products.filter((p) =>
    tokens.every((t) => normalizeText([p.title, p.brand ?? "", p.sku ?? ""].join(" ")).includes(t)),
  );
  // Точное начало SKU/названия — выше в списке.
  matches.sort((a, b) => {
    const rank = (p: BotProduct) =>
      p.sku !== null && normalizeText(p.sku).startsWith(q)
        ? 0
        : normalizeText(p.title).startsWith(q)
          ? 1
          : 2;
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.title.localeCompare(b.title, "ru");
  });
  return { matches, ambiguousSku: false };
}

export function paginate<T>(
  items: T[],
  page: number,
  size = PRODUCTS_PAGE_SIZE,
): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { slice: items.slice(p * size, (p + 1) * size), page: p, pages };
}

/** Поиск по названию/SKU/бренду с нормализацией; пагинация по PRODUCTS_PAGE_SIZE. */
export function searchBotProducts(
  products: BotProduct[],
  query: string,
  page = 0,
): BotSearchResult {
  const { matches, ambiguousSku } = matchList(products, query);
  const { slice, page: p, pages } = paginate(matches, page);
  return { items: slice, all: matches, total: matches.length, page: p, pages, ambiguousSku };
}

export type ProductResolve =
  | { kind: "one"; product: BotProduct }
  | { kind: "ambiguous"; products: BotProduct[] }
  | { kind: "none" };

/** Для изменяющих команд: ровно одно совпадение → товар; несколько/дубли → список; ничего → отказ. */
export function resolveSingleProduct(products: BotProduct[], query: string): ProductResolve {
  const r = searchBotProducts(products, query, 0);
  if (r.total === 0) return { kind: "none" };
  if (r.total === 1) return { kind: "one", product: r.items[0]! };
  return { kind: "ambiguous", products: r.items };
}

export const BOT_STATUS_LABEL: Record<string, string> = {
  published: "на витрине",
  draft: "черновик",
  hidden: "скрыт",
};

export function botStatusLabel(status: string): string {
  return BOT_STATUS_LABEL[status] ?? status;
}

export function formatRub(value: number): string {
  // toLocaleString("ru-RU") может давать неразрывный пробел — приводим к обычному.
  return `${Math.round(Number(value) || 0)
    .toLocaleString("ru-RU")
    .replace(/[\u202f\u00a0]/g, " ")} ₽`;
}

/** Пометка наличия — только логический флаг, без обещаний физического остатка. */
export function stockLabel(p: Pick<BotProduct, "in_stock">): string {
  return p.in_stock ? "Отмечено в наличии" : "Под заказ";
}

export function productLine(p: BotProduct): string {
  const sku = p.sku ? ` · ${p.sku}` : "";
  const sale = isDiscounted(p) ? " · цена снижена" : "";
  return `${p.title}${sku} — ${formatRub(p.price)}${sale}`;
}

/** Список товаров с кнопками выбора (callback prd:<uuid>) и пагинацией. */
export function buildBotList(
  matches: BotProduct[],
  page: number,
  title: string,
  navCb: (page: number) => string | null,
): { text: string; rows: BtnRows } {
  const { slice, page: p, pages } = paginate(matches, page);
  const rows: BtnRows = slice.map((x) => [
    { text: `📄 ${x.title.slice(0, 40)}`, callback_data: makeCallback(`prd:${x.id}`) },
  ]);
  if (pages > 1) {
    const nav: Btn[] = [];
    const prev = p > 0 ? navCb(p - 1) : null;
    const next = p < pages - 1 ? navCb(p + 1) : null;
    const self = navCb(p);
    if (prev) nav.push({ text: "◀️ Назад", callback_data: makeCallback(prev) });
    if (self) nav.push({ text: `${p + 1}/${pages}`, callback_data: makeCallback(self) });
    if (next) nav.push({ text: "Далее ▶️", callback_data: makeCallback(next) });
    if (nav.length > 0) rows.push(nav);
  }
  const text =
    matches.length === 0
      ? "Ничего не найдено. Попробуйте часть названия или артикул.\nНапример: маска или горелка."
      : `${title} (${matches.length}):\n\n${slice.map(productLine).join("\n\n")}\n\n👇 Нажмите название товара ниже — откроется его карточка.`;
  rows.push([{ text: "🔍 Найти другой товар", callback_data: "fndh" }]);
  rows.push([{ text: "🏠 Главное меню", callback_data: "home" }]);
  return { text, rows };
}

/** Список выбора товара для изменяющей команды: у каждой кнопки — свой callback с действием. */
export function buildMutationChoice(
  products: BotProduct[],
  title: string,
  cbFor: (p: BotProduct) => string,
): { text: string; rows: BtnRows } {
  const rows: BtnRows = products.map((x) => [
    { text: `📄 ${x.title.slice(0, 40)}`, callback_data: makeCallback(cbFor(x)) },
  ]);
  const text = `${title}: найдено несколько совпадений — выберите конкретный товар (произвольный товар не изменяем):\n${products
    .map(productLine)
    .join("\n")}`;
  return { text, rows };
}

export interface ProductCardOpts {
  categoryName?: string | null;
  photoCount?: number | null;
  canViewCosts?: boolean;
  canEditPrice?: boolean;
  canEditStock?: boolean;
  canEditCard?: boolean;
  canManagePhotos?: boolean;
  backCallback?: string;
}

/** Карточка товара: UUID, SKU, цена, скидка (только old_price > price), бренд, статус, наличие, категория, фото. */
export function buildProductCardBot(
  p: BotProduct,
  opts: ProductCardOpts = {},
): { text: string; rows: BtnRows } {
  const price = isDiscounted(p)
    ? `Цена: ${formatRub(p.price)} (снижена с ${formatRub(p.old_price ?? 0)})`
    : `Цена: ${formatRub(p.price)}`;
  const text = [
    `📦 ${p.title}`,
    "",
    `🏷 Артикул: ${p.sku ?? "не указан"} · Бренд: ${p.brand ?? "не указан"}`,
    `💰 ${price}`,
    `📊 Наличие: ${stockLabel(p)}`,
    "",
    `🌐 Статус: ${botStatusLabel(p.status)}`,
    `📋 Ассортимент: ${DECISION[p.assortment_decision as keyof typeof DECISION] ?? "На разбор"}`,
    `🗂 Категория: ${opts.categoryName ?? "—"}`,
    `🖼 Фото: ${opts.photoCount ?? 0}`,
    "",
    "👇 Нажмите нужную кнопку. Просмотр карточки ничего не меняет.",
  ].join("\n");
  const rows: BtnRows = [];
  if (opts.canViewCosts)
    rows.push([
      { text: "💰 Закупочная и розничная цена", callback_data: makeCallback(`cost:${p.id}`) },
    ]);
  if (opts.canEditPrice)
    rows.push([{ text: "💰 Изменить цену", callback_data: makeCallback(`pp:${p.id}`) }]);
  if (opts.canEditStock)
    rows.push([{ text: "📦 Изменить наличие", callback_data: makeCallback(`ps:${p.id}`) }]);
  if (opts.canEditCard)
    rows.push([{ text: "✏️ Изменить карточку", callback_data: makeCallback(`edit:${p.id}`) }]);
  if (opts.canManagePhotos)
    rows.push([{ text: "🖼 Посмотреть фотографии", callback_data: makeCallback(`ph:${p.id}`) }]);
  rows.push([{ text: "⬅️ К каталогу", callback_data: makeCallback(opts.backCallback ?? "cat:0") }]);
  return { text, rows };
}

/** Фактическая сводка: без обещаний остатков (stock_qty не отслеживается). */
export function buildCatalogSummary(products: BotProduct[]): string {
  const count = (fn: (p: BotProduct) => boolean) => products.filter(fn).length;
  return [
    "📊 Каталог интернет-магазина «Мастер Сварщик»:\n",
    `• на витрине: ${count((p) => p.status === "published")}`,
    `• черновики: ${count((p) => p.status === "draft")}`,
    `• скрытые: ${count((p) => p.status === "hidden")}`,
    `• отмечены в наличии: ${count((p) => p.in_stock)}`,
    `• под заказ: ${count((p) => !p.in_stock)}`,
    "",
    "Точные остатки склада не отслеживаются — это только пометки.",
  ].join("\n");
}

export function pricePreviewText(p: BotProduct, newPrice: number): string {
  return [
    "💰 Изменить цену товара?",
    "",
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Было: ${formatRub(p.price)}`,
    `Станет: ${formatRub(newPrice)}`,
    "",
    "Подтвердите действие:",
  ].join("\n");
}

export function stockPreviewText(p: BotProduct, inStock: boolean): string {
  return [
    "📦 Изменить пометку наличия?",
    "",
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Было: ${stockLabel(p)}`,
    `Станет: ${inStock ? "Отмечено в наличии" : "Под заказ"}`,
    "",
    "Подтвердите действие:",
  ].join("\n");
}

export function priceChoiceCallback(p: BotProduct, newPrice: number): string {
  return makeCallback(`pxp:${p.id}:p${Math.round(newPrice * 100)}`);
}

export function stockChoiceCallback(p: BotProduct, inStock: boolean): string {
  return makeCallback(`pxs:${p.id}:s${inStock ? 1 : 0}`);
}

/** Callback пагинации поиска: запрос зашит в callback; слишком длинный — null (без пагинации). */
export function findCallback(page: number, query: string): string | null {
  const cb = `fnd:${page}:${query}`;
  return callbackBytes(cb) <= CB_LIMIT_BYTES ? cb : null;
}

export function parseFindCallback(data: string): { page: number; query: string } | null {
  const m = data.match(/^fnd:(\d+):(.*)$/s);
  if (!m) return null;
  return { page: Number(m[1]), query: m[2] ?? "" };
}

export const MAX_BOT_PRICE = 10_000_000;

/** Цена из текста: «1250», «1 250,50», «1250.5» — до 2 знаков; 0, отрицательные и мусор отклоняются. */
export function parseBotPrice(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const s = text.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_BOT_PRICE) return undefined;
  return Math.round(n * 100) / 100;
}

/** Пометка наличия из текста: «есть»/«в наличии» → true; «под_заказ»/«под заказ» → false. */
export function parseStockInput(text: string | undefined): boolean | undefined {
  const s = normalizeText(text ?? "");
  if (s === "есть" || s === "в наличии") return true;
  if (s === "под_заказ" || s === "под заказ") return false;
  return undefined;
}
