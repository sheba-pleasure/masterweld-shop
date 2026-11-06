import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "./permissions";
import { tg } from "./telegram.server";
import { showOrderMessage } from "./order-message.server";
import { customerMessage, shopUrl } from "./customer";
import { PRO_SHOP_PENDING, staffShopMessage } from "./shop-environments";
import { parseAssortmentCallback } from "./assortment";
import { showAssortment } from "./assortment.server";
import { showCatalogImport, receiveCatalogDocument } from "@/lib/import/catalog.server";
import { parseImportCallback } from "@/lib/import/catalog-view";
import type { ImportDocument } from "@/lib/import/telegram-file.server";
import { deliveryReport, type DeliveryRow } from "./deliveries";
import { navigationCommand, persistentKeyboard } from "./navigation";
import {
  buildOrderCard,
  orderDateMoscow,
  buildOrdersList,
  canViewOrderData,
  checkTransition,
  orderNumber,
  STATUS_LABEL,
  type OrderRow,
  type OrderStatus,
} from "./orders";
import {
  botStatusLabel,
  buildBotList,
  buildCatalogSummary,
  buildMutationChoice,
  buildProductCardBot,
  findCallback,
  isPrivateChat,
  parseBotPrice,
  parseFindCallback,
  parseStockInput,
  priceChoiceCallback,
  pricePreviewText,
  resolveSingleProduct,
  searchBotProducts,
  stockChoiceCallback,
  stockPreviewText,
  type BotProduct,
} from "./catalog";
import {
  describePendingChange,
  isMissingTableError,
  PENDING_PERMISSION,
  PENDING_REASON_MSG,
  PENDING_TTL_MS,
  type PendingActionKind,
} from "./pending";
import {
  CANCEL_HINT,
  canPublish,
  checkEditorState,
  draftPreviewText,
  draftStepPrompt,
  EDITOR_FIELD_LABEL,
  EDITOR_STATE_REASON_MSG,
  EDITOR_STATE_TTL_MS,
  editCategoryPreviewText,
  editFieldPreviewText,
  editMenuRows,
  editStatusPreviewText,
  categoryChoiceCallback,
  parseStatusInput,
  rollbackCallback,
  slugBase,
  statusChoiceCallback,
  STATUS_CHOICE_LABEL,
  validateEditorValue,
  type DraftData,
  type EditorStateRow,
  type EditorTextField,
  type ProductStatus,
} from "./editor";
import {
  galleryText,
  parsePhotoDetailCallback,
  PHOTO_UPLOAD_NOT_CONNECTED_MSG,
  photoDeletePreviewText,
  photoDetailText,
  photoMainPreviewText,
  photoReorderPreviewText,
  photoRows,
  type BotPhoto,
} from "./photos";
import { isDiscounted, normalizeText } from "@/lib/search";
import { parseB2BCommand, parseB2BCallback } from "@/lib/b2b/navigation";
import { technicalEditor } from "@/lib/technical/editor.server";

type Btn = { text: string; callback_data: string };
type Chat = { id: number; type?: string };

export interface TgUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    chat?: Chat;
    text?: string;
    message_id?: number;
    reply_to_message?: { message_id: number };
    photo?: unknown;
    document?: ImportDocument;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { chat?: Chat; message_id?: number };
  };
}

function menuFor(m: StaffMember): { text: string; rows: Btn[][] } {
  const rows: Btn[][] = [];
  rows.push([{ text: "🛍 Открыть сайт · DEV / PRO", callback_data: "shop_versions" }]);
  if (m.role === "director" && !m.elevated) {
    rows.push([
      { text: "📊 Сводка", callback_data: "summary" },
      { text: "🧾 Новые заказы", callback_data: "orders" },
    ]);
    rows.push([
      { text: "📦 Остатки", callback_data: "stock" },
      { text: "💰 Цены", callback_data: "prices" },
    ]);
    rows.push([
      { text: "🗂 Каталог", callback_data: "cat:0" },
      { text: "🔍 Найти товар", callback_data: "fndh" },
    ]);
    rows.push([{ text: "🔓 Включить полный доступ", callback_data: "elevate_on" }]);
    return { text: `👋 Здравствуйте, ${m.name}!\n\n👤 Директор · простой режим`, rows };
  }
  if (can(m, "edit_products") || can(m, "upload_photos"))
    rows.push([
      ...(can(m, "edit_products") ? [{ text: "➕ Товар", callback_data: "product_new" }] : []),
      ...(can(m, "upload_photos") ? [{ text: "🖼 Фото", callback_data: "photos" }] : []),
    ]);
  rows.push([
    { text: "🗂 Каталог", callback_data: "cat:0" },
    { text: "🔍 Найти товар", callback_data: "fndh" },
  ]);
  rows.push([
    { text: "🧾 Заказы", callback_data: "orders" },
    { text: "📦 Наличие", callback_data: "stock" },
  ]);
  if (can(m, "edit_prices"))
    rows.push([
      { text: "💰 Цены", callback_data: "prices" },
      { text: "📊 Сводка", callback_data: "summary" },
    ]);
  if (can(m, "import_prices"))
    rows.push([
      { text: "📥 Импорт товаров и цен", callback_data: "import" },
      { text: "🗂 Разделы", callback_data: "categories" },
    ]);
  if (can(m, "edit_products"))
    rows.push([{ text: "⚙️ Продолжить характеристики", callback_data: "te:resume" }]);
  if (can(m, "manage_assortment"))
    rows.push([{ text: "📋 Ассортимент · массовые действия", callback_data: "as:home" }]);
  if (can(m, "manage_staff"))
    rows.push([
      { text: "👥 Сотрудники", callback_data: "staff" },
      { text: "📜 Журнал", callback_data: "audit" },
    ]);
  if (can(m, "view_audit"))
    rows.push([{ text: "🔔 Доставка уведомлений", callback_data: "deliveries" }]);
  if (m.role === "director" && m.elevated)
    rows.push([{ text: "🔒 Вернуть простой режим", callback_data: "elevate_off" }]);
  const label =
    m.role === "admin"
      ? "администратор"
      : m.role === "director"
        ? "директор (полный доступ)"
        : "продавец";
  return { text: `👋 Здравствуйте, ${m.name}!\n\n👤 Роль: ${label}.`, rows };
}

async function sendMenu(chatId: number, m: StaffMember) {
  const { text, rows } = menuFor(m);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `${text}\n\n👇 Основные разделы — на клавиатуре внизу.\n↩️ «Отмена ввода» завершает текущий диалог.`,
    reply_markup: persistentKeyboard(process.env["APP_ENV"]),
  });
  await tg("sendMessage", {
    chat_id: chatId,
    text: "🧭 Управление магазином\n\nВыберите нужное действие:",
    reply_markup: { inline_keyboard: rows },
  });
}

async function audit(id: number, action: string, details?: unknown) {
  const { error } = await supabaseAdmin
    .from("staff_audit_log")
    .insert({ telegram_id: id, action, details: (details ?? null) as never });
  if (error) throw new Error("BOT_AUDIT_FAILED");
}

// ---------- Каталог: чтение и безопасные изменения ----------

const PRODUCT_COLS =
  "id,slug,title,brand,sku,price,old_price,in_stock,stock_qty,status,assortment_decision,category_id,description,specs";
const PRIVATE_ONLY_MSG = "Служебные данные и изменения доступны только в личном чате с ботом.";
const NOT_ACTIVATED_MSG =
  "⚠️ Функция ещё не активирована: требуется обновление базы. Изменение НЕ выполнено.";

function normalizeProduct(p: Record<string, unknown>): BotProduct {
  return {
    id: String(p["id"]),
    slug: String(p["slug"]),
    title: String(p["title"]),
    brand: (p["brand"] as string | null) ?? null,
    sku: (p["sku"] as string | null) ?? null,
    price: Number(p["price"]),
    old_price: p["old_price"] == null ? null : Number(p["old_price"]),
    in_stock: Boolean(p["in_stock"]),
    stock_qty: p["stock_qty"] == null ? null : Number(p["stock_qty"]),
    status: String(p["status"]),
    assortment_decision: String(p["assortment_decision"] ?? "review"),
    category_id: (p["category_id"] as string | null) ?? null,
    description: (p["description"] as string | null) ?? null,
    specs: (p["specs"] as string | null) ?? null,
  };
}

async function fetchAllProducts(): Promise<BotProduct[]> {
  const res = await loose
    .from("products")
    .select(PRODUCT_COLS)
    .order("title", { ascending: true })
    .limit(2000);
  if (res.error) {
    console.error("[bot] products read failed");
    return [];
  }
  return (res.data ?? []).map((p) => normalizeProduct(p as Record<string, unknown>));
}

async function fetchProductById(id: string): Promise<BotProduct | null> {
  const res = await loose.from("products").select(PRODUCT_COLS).eq("id", id).maybeSingle();
  return res.data ? normalizeProduct(res.data as Record<string, unknown>) : null;
}

async function photoCount(productId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("product_photos")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId);
  return count ?? 0;
}

async function categoryName(categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null;
  const { data } = await supabaseAdmin
    .from("categories")
    .select("name")
    .eq("id", categoryId)
    .maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

type CatalogKind = "all" | "draft" | "backorder" | "sale";

const CATALOG_KIND: Record<CatalogKind, { title: string; prefix: string }> = {
  all: { title: "Каталог", prefix: "cat" },
  draft: { title: "Черновики", prefix: "drf" },
  backorder: { title: "Под заказ", prefix: "bko" },
  sale: { title: "Цена снижена", prefix: "sale" },
};

async function sendCatalogList(chatId: number, kind: CatalogKind, page: number) {
  const products = await fetchAllProducts();
  let list = products;
  if (kind === "draft") list = products.filter((p) => p.status === "draft");
  if (kind === "backorder") list = products.filter((p) => !p.in_stock);
  if (kind === "sale") list = products.filter((p) => isDiscounted(p));
  const { title, prefix } = CATALOG_KIND[kind];
  const { text, rows } = buildBotList(list, page, title, (pg) => `${prefix}:${pg}`);
  await tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } });
}

async function sendFindResults(chatId: number, query: string, page: number) {
  const products = await fetchAllProducts();
  const r = searchBotProducts(products, query, page);
  const { text, rows } = buildBotList(r.all, r.page, `Найдено по «${query}»`, (pg) =>
    findCallback(pg, query),
  );
  await tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } });
}

async function sendProductCard(chatId: number, productId: string, m: StaffMember) {
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  const [photos, cat] = await Promise.all([photoCount(p.id), categoryName(p.category_id)]);
  const { text, rows } = buildProductCardBot(p, {
    categoryName: cat,
    photoCount: photos,
    canEditPrice: can(m, "edit_prices"),
    canEditStock: can(m, "edit_stock"),
    canEditCard:
      can(m, "edit_products") || can(m, "manage_categories") || can(m, "publish_products"),
    canManagePhotos: can(m, "upload_photos"),
  });
  return tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } });
}

// ---------- Фото товара (этап C2B) ----------
// Управление существующими фото: просмотр, основное, порядок, обратимое удаление.
// Требует право upload_photos, только личный чат; все изменения — preview→confirm
// через pending_actions (RPC в миграции 0007, service_role only).
// Загрузка новых фото из Telegram заблокирована (fail closed) до живой проверки,
// что gateway отдаёт бинарные файлы (см. TELEGRAM_PHOTO_UPLOAD_VERIFIED в photos.ts).

// Колонка deleted_at появляется в 0007 — до неё выборка работает без неё.
let photoSoftDeleteCol: boolean | null = null;

async function fetchPhotos(productId: string): Promise<BotPhoto[]> {
  if (photoSoftDeleteCol === null) {
    const probe = await supabaseAdmin.from("product_photos").select("deleted_at").limit(1);
    photoSoftDeleteCol = !probe.error;
  }
  const cols = "id,url,sort_order,is_main,created_at" + (photoSoftDeleteCol ? ",deleted_at" : "");
  let q = supabaseAdmin
    .from("product_photos")
    .select(cols)
    .eq("product_id", productId)
    .order("is_main", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (photoSoftDeleteCol) q = q.is("deleted_at", null);
  const { data, error } = await q;
  if (error) {
    console.error("[bot] photos read failed");
    return [];
  }
  return (data ?? []) as unknown as BotPhoto[];
}

async function sendPhotoGallery(m: StaffMember, chatId: number, productId: string) {
  if (!can(m, "upload_photos"))
    return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для управления фото." });
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  const photos = await fetchPhotos(productId);
  const rows = photoRows(productId, photos, true);
  return tg("sendMessage", {
    chat_id: chatId,
    text: galleryText(p, photos),
    reply_markup: { inline_keyboard: rows },
  });
}

async function sendPhotoDetail(m: StaffMember, chatId: number, productId: string, index: number) {
  if (!can(m, "upload_photos"))
    return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для управления фото." });
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  const photos = await fetchPhotos(productId);
  const ph = photos[index];
  if (!ph)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Список фото изменился — откройте галерею заново.",
      reply_markup: {
        inline_keyboard: [[{ text: "🖼 К галерее", callback_data: `ph:${productId}` }]],
      },
    });
  const rows: Btn[][] = [];
  if (!ph.is_main)
    rows.push([{ text: "⭐ Сделать основным", callback_data: `phm:${productId}:${index}` }]);
  const nav: Btn[] = [];
  if (index > 0) nav.push({ text: "⬆️ Выше", callback_data: `phu:${productId}:${index}` });
  if (index < photos.length - 1)
    nav.push({ text: "⬇️ Ниже", callback_data: `phn:${productId}:${index}` });
  if (nav.length > 0) rows.push(nav);
  rows.push([{ text: "🗑 Удалить (обратимо)", callback_data: `phx:${productId}:${index}` }]);
  rows.push([{ text: "⬅️ К галерее", callback_data: `ph:${productId}` }]);
  return tg("sendMessage", {
    chat_id: chatId,
    text: photoDetailText(p, ph, index, photos.length),
    reply_markup: { inline_keyboard: rows },
  });
}

async function photoMainPreview(m: StaffMember, chatId: number, productId: string, index: number) {
  const photos = await fetchPhotos(productId);
  const ph = photos[index];
  const p = await fetchProductById(productId);
  if (!p || !ph)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Список фото изменился — откройте галерею заново.",
    });
  const prevMain = photos.find((x) => x.is_main) ?? null;
  return createPending(
    m,
    chatId,
    productId,
    "photo_main",
    {
      photo_id: ph.id,
      is_main: ph.is_main,
      sort_order: ph.sort_order,
      prev_main_id: prevMain?.id ?? null,
    },
    { photo_id: ph.id, is_main: true, sort_order: 0 },
    photoMainPreviewText(p, ph, index),
  );
}

async function photoReorderPreview(
  m: StaffMember,
  chatId: number,
  productId: string,
  index: number,
  dir: -1 | 1,
) {
  const photos = await fetchPhotos(productId);
  const ph = photos[index];
  const p = await fetchProductById(productId);
  const to = index + dir;
  if (!p || !ph || to < 0 || to >= photos.length || ph.is_main)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Список фото изменился — откройте галерею заново.",
    });
  return createPending(
    m,
    chatId,
    productId,
    "photo_reorder",
    { photo_id: ph.id, sort_order: ph.sort_order, is_main: ph.is_main },
    { photo_id: ph.id, sort_order: to },
    photoReorderPreviewText(p, ph, index, to),
  );
}

async function photoDeletePreview(
  m: StaffMember,
  chatId: number,
  productId: string,
  index: number,
) {
  const photos = await fetchPhotos(productId);
  const ph = photos[index];
  const p = await fetchProductById(productId);
  if (!p || !ph)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Список фото изменился — откройте галерею заново.",
    });
  return createPending(
    m,
    chatId,
    productId,
    "photo_delete",
    { photo_id: ph.id, is_main: ph.is_main, sort_order: ph.sort_order },
    { photo_id: ph.id, deleted: true },
    photoDeletePreviewText(p, ph, index),
  );
}

// Таблица pending_actions (миграция 0005) может отсутствовать — тогда
// изменяющие операции сообщают «функция ещё не активирована» и никогда
// ложно не подтверждают изменение.
let pendingTableState: boolean | null = null;
async function pendingAvailable(): Promise<boolean> {
  if (pendingTableState !== null) return pendingTableState;
  const res = await loose.from("pending_actions").select("id").limit(1);
  pendingTableState = !res.error;
  if (res.error) console.error("[bot] pending actions unavailable");
  return pendingTableState;
}

// ---------- RPC-слой (миграция 0006): атомарные транзакции ----------

const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string; code?: string | null } | null }>;

const RPC_ERR_MSG: Record<string, string> = {
  BOT_PENDING_NOT_FOUND: PENDING_REASON_MSG["not_found"]!,
  BOT_PENDING_NOT_OWNER: PENDING_REASON_MSG["not_owner"]!,
  BOT_PENDING_CONSUMED: PENDING_REASON_MSG["consumed"]!,
  BOT_PENDING_EXPIRED: PENDING_REASON_MSG["expired"]!,
  BOT_PENDING_NOT_APPLIED: "Откатить можно только применённое действие.",
  BOT_NOTHING_TO_ROLLBACK: "Значение уже соответствует исходному — откатывать нечего.",
  BOT_ROLLBACK_CONFLICT:
    "Товар уже изменился после этого действия — откат запрещён. Сделайте новую правку от текущего значения.",
  BOT_PENDING_LEGACY_NO_OUTCOME:
    "Действие создано до обновления базы — доказательств применения нет, откат запрещён.",
  BOT_PHOTO_NOT_FOUND: "Фото не найдено — возможно, список изменился. Обновите галерею.",
  BOT_PHOTO_CONFLICT: "Фото изменилось после предпросмотра — ничего не изменено. Обновите галерею.",
  BOT_PHOTO_LAST_PUBLISHED:
    "Нельзя убрать последнее фото товара на витрине — сначала добавьте другое фото или скройте товар.",
  BOT_PHOTO_MAIN_CANNOT_REORDER:
    "Основное фото всегда первое — порядок можно менять для остальных фото.",
  BOT_PENDING_CONFLICT:
    "Данные изменились с момента предпросмотра — ничего не изменено. Повторите команду.",
  BOT_PRODUCT_NOT_FOUND: "Товар не найден — ничего не изменено.",
  BOT_PENDING_BAD_ACTION: "Повреждённое действие — отменено.",
  BOT_BAD_VALUE: "Недопустимое значение — ничего не изменено.",
  BOT_SKU_DUPLICATE: "Такой артикул уже есть у другого товара — действие отменено.",
  BOT_CATEGORY_NOT_FOUND: "Раздел не найден — ничего не изменено.",
  BOT_PUBLISH_MISSING_FIELDS:
    "Публикация невозможна: нужны название (3+ символа), цена больше нуля и хотя бы одно фото.",
};

function isMissingRpcError(err: { message?: string | null; code?: string | null }): boolean {
  if (err.code === "PGRST202" || err.code === "42883") return true;
  const msg = (err.message ?? "").toLowerCase();
  return msg.includes("could not find the function") || msg.includes("function does not exist");
}

function rpcErrMsg(err: { message: string; code?: string | null } | null): string {
  if (!err || isMissingRpcError(err)) return NOT_ACTIVATED_MSG;
  for (const key of Object.keys(RPC_ERR_MSG))
    if (err.message.includes(key)) return RPC_ERR_MSG[key]!;
  console.error("[bot] RPC failed");
  return "Не удалось выполнить операцию — ничего не изменено. Повторите позже.";
}

const CONFIRM_ROWS = (pendingId: string): Btn[][] => [
  [{ text: "✅ Подтвердить", callback_data: `pc:${pendingId}` }],
  [{ text: "⬅️ Отмена", callback_data: `pcx:${pendingId}` }],
];

/** Создаёт pending-действие и показывает предпросмотр «было → станет» с подтверждением. */
async function createPending(
  m: StaffMember,
  chatId: number,
  productId: string,
  action: PendingActionKind,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  text: string,
): Promise<unknown> {
  if (!(await pendingAvailable()))
    return tg("sendMessage", {
      chat_id: chatId,
      text: `${text}\n\n${NOT_ACTIVATED_MSG}`,
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Отмена", callback_data: "cat:0" }]] },
    });
  const pendingId = crypto.randomUUID();
  const { error } = await loose.from("pending_actions").insert({
    id: pendingId,
    staff_telegram_id: m.telegram_id,
    product_id: productId,
    action,
    before_value: before,
    after_value: after,
    expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  });
  if (error) {
    console.error("[bot] pending action write failed");
    return tg("sendMessage", { chat_id: chatId, text: `${text}\n\n${NOT_ACTIVATED_MSG}` });
  }
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: CONFIRM_ROWS(pendingId) },
  });
}

async function pricePreview(m: StaffMember, chatId: number, productId: string, newPrice: number) {
  if (!can(m, "edit_prices"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: изменение цены недоступно для вашей роли.",
    });
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  if (Math.round(p.price * 100) === Math.round(newPrice * 100))
    return tg("sendMessage", { chat_id: chatId, text: "Цена уже такая — изменять нечего." });
  const text = pricePreviewText(p, newPrice);
  return createPending(m, chatId, p.id, "price", { price: p.price }, { price: newPrice }, text);
}

async function stockPreview(m: StaffMember, chatId: number, productId: string, inStock: boolean) {
  if (!can(m, "edit_stock"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: изменение наличия недоступно для вашей роли.",
    });
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  if (p.in_stock === inStock)
    return tg("sendMessage", { chat_id: chatId, text: "Пометка уже такая — изменять нечего." });
  const text = stockPreviewText(p, inStock);
  return createPending(
    m,
    chatId,
    p.id,
    "stock",
    { in_stock: p.in_stock },
    { in_stock: inStock },
    text,
  );
}

// Применение идёт через транзакционную RPC bot_apply_pending (миграция 0006):
// блокировка строки действия и товара, сверка «было», UPDATE, consumed_at и
// аудит — одной транзакцией. Пока RPC нет — изменения безопасно заблокированы.
async function confirmPending(m: StaffMember, chatId: number, pendingId: string) {
  if (!(await pendingAvailable()))
    return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  // RBAC по типу действия — до вызова RPC (и повторно внутри RPC через владельца/TTL).
  const rowRes = await loose
    .from("pending_actions")
    .select("action")
    .eq("id", pendingId)
    .maybeSingle();
  if (rowRes.error) return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  const act = (rowRes.data as { action?: PendingActionKind } | null)?.action;
  if (!act || !(act in PENDING_PERMISSION))
    return tg("sendMessage", { chat_id: chatId, text: PENDING_REASON_MSG["not_found"]! });
  if (!can(m, PENDING_PERMISSION[act]))
    return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для этого действия." });

  // Фото-действия (C2B) идут в свои RPC миграции 0007; остальные — в bot_apply_pending.
  const PHOTO_RPC: Record<string, string> = {
    photo_main: "bot_set_photo_main",
    photo_reorder: "bot_reorder_photo",
    photo_delete: "bot_delete_photo_meta",
  };
  const fn = PHOTO_RPC[act] ?? "bot_apply_pending";
  const { data, error } = await rpc(fn, {
    p_pending_id: pendingId,
    p_staff_telegram_id: m.telegram_id,
  });
  if (error) return tg("sendMessage", { chat_id: chatId, text: rpcErrMsg(error) });
  const r = data as {
    action: PendingActionKind;
    product_id: string;
    title: string;
    before: unknown;
    after: unknown;
  } | null;
  if (!r) return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });

  const change = describePendingChange(r.action, r.before, r.after);
  return tg("sendMessage", {
    chat_id: chatId,
    text: `✅ «${r.title}»: ${change}.`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "↩️ Откатить", callback_data: rollbackCallback(pendingId) },
          { text: "📄 Карточка", callback_data: `prd:${r.product_id}` },
        ],
      ],
    },
  });
}

// Отмена идёт через транзакционную RPC bot_cancel_pending (миграция 0006).
async function cancelPending(m: StaffMember, chatId: number, pendingId: string) {
  if (!(await pendingAvailable()))
    return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  const { error } = await rpc("bot_cancel_pending", {
    p_pending_id: pendingId,
    p_staff_telegram_id: m.telegram_id,
  });
  if (error) return tg("sendMessage", { chat_id: chatId, text: rpcErrMsg(error) });
  return tg("sendMessage", { chat_id: chatId, text: "Отменено: действие не выполнено." });
}

// ---------- Редактор карточек (этап C2A) ----------
// Текстовые/разделовые/статусные правки: pending preview→confirm через RPC 0006.
// Права: текст — edit_products, раздел — manage_categories, статус — publish_products.
// Цена/наличие — отдельные права C1 (edit_prices/edit_stock). Закупочные цены
// (product_costs, право view_costs) в редактировании не участвуют и не читаются.

let editorTableState: boolean | null = null;
async function editorAvailable(): Promise<boolean> {
  if (editorTableState !== null) return editorTableState;
  const res = await loose.from("bot_editor_states").select("staff_telegram_id").limit(1);
  editorTableState = !res.error;
  if (res.error) console.error("[bot] editor unavailable");
  return editorTableState;
}

const EDITOR_CHANGED =
  "⚠️ Этот шаг уже изменился или завершён. Используйте последнее сообщение бота; /cancel — отменить текущий ввод.";

function editorRevision(st: EditorStateRow): string | null {
  const revision = (st.data as Record<string, unknown> | null)?.["_revision"];
  return typeof revision === "string" && /^[0-9a-f-]{36}$/.test(revision) ? revision : null;
}

// Match the entire observed state. Every new step has a fresh revision in its private data.
// PostgreSQL rechecks these filters after a concurrent UPDATE obtains the row lock.
function matchEditorState(query: ReturnType<typeof loose.from>, st: EditorStateRow) {
  let q = query
    .eq("staff_telegram_id", st.staff_telegram_id)
    .eq("state", st.state)
    .eq("data", JSON.stringify(st.data))
    .eq("expires_at", st.expires_at);
  q = st.product_id === null ? q.is("product_id", null) : q.eq("product_id", st.product_id);
  return st.consumed_at === null ? q.is("consumed_at", null) : q.eq("consumed_at", st.consumed_at);
}

async function setEditorState(
  staffTelegramId: number,
  state: string,
  data: Record<string, unknown>,
  productId?: string | null,
  previous?: EditorStateRow,
): Promise<EditorStateRow | null> {
  const observed =
    previous ??
    ((
      await loose
        .from("bot_editor_states")
        .select("*")
        .eq("staff_telegram_id", staffTelegramId)
        .maybeSingle()
    ).data as EditorStateRow | null);
  if (!previous && observed && checkEditorState(observed, staffTelegramId, Date.now()).ok) {
    await tg("sendMessage", {
      chat_id: staffTelegramId,
      text: "✏️ У вас уже есть незавершённый ввод. /input — продолжить, /cancel — отменить. Текущий ввод сохранён.",
    });
    return null;
  }
  const next: EditorStateRow = {
    staff_telegram_id: staffTelegramId,
    state,
    data: { ...data, _revision: crypto.randomUUID(), _prompt_message_id: null },
    product_id: productId ?? null,
    expires_at: new Date(Date.now() + EDITOR_STATE_TTL_MS).toISOString(),
    consumed_at: null,
  };
  let query = observed
    ? matchEditorState(loose.from("bot_editor_states").update({ ...next }), observed)
    : loose.from("bot_editor_states").insert({ ...next });
  if (previous) query = query.gt("expires_at", new Date().toISOString()).is("consumed_at", null);
  const { data: saved, error } = await query.select("*").maybeSingle();
  if (error) {
    console.error("[bot] editor state write failed");
    await tg("sendMessage", {
      chat_id: staffTelegramId,
      text:
        error.message === "EDITOR_TECHNICAL_ACTIVE"
          ? "⚙️ Сначала завершите черновик характеристик: /technical — продолжить, /cancel — отменить с подтверждением. Новый ввод не начат; сохранённый черновик не изменён."
          : "⚠️ Не удалось сохранить шаг. Следующий вопрос не открыт. Повторите действие или отмените ввод командой /cancel.",
    });
  }
  if (error) return null;
  if (!saved) await tg("sendMessage", { chat_id: staffTelegramId, text: EDITOR_CHANGED });
  return saved as EditorStateRow | null;
}

/** Забирает только прочитанный шаг — конкурент или новый диалог не потребляются. */
async function consumeEditorState(st: EditorStateRow): Promise<"claimed" | "changed" | "failed"> {
  const { data, error } = await matchEditorState(
    loose.from("bot_editor_states").update({ consumed_at: new Date().toISOString() }),
    st,
  )
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("staff_telegram_id")
    .maybeSingle();
  return error ? "failed" : data ? "claimed" : "changed";
}

const EDITOR_CLAIM_FAILED =
  "⚠️ Не удалось проверить шаг из-за сбоя связи с базой. Эта попытка не отправляла правку товара. Откройте карточку и проверьте результат; /cancel — сбросить оставшийся ввод.";

async function claimEditorStep(st: EditorStateRow, chatId: number): Promise<boolean> {
  const outcome = await consumeEditorState(st);
  if (outcome === "claimed") return true;
  await tg("sendMessage", {
    chat_id: chatId,
    text: outcome === "failed" ? EDITOR_CLAIM_FAILED : EDITOR_CHANGED,
  });
  return false;
}

async function getEditorState(m: StaffMember): Promise<EditorStateRow | null> {
  const res = await loose
    .from("bot_editor_states")
    .select("*")
    .eq("staff_telegram_id", m.telegram_id)
    .maybeSingle();
  return (res.data as EditorStateRow | null) ?? null;
}

async function sendEditMenu(m: StaffMember, chatId: number, productId: string) {
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  const rows = editMenuRows(p, {
    canEditText: can(m, "edit_products"),
    canManageCategories: can(m, "manage_categories"),
    canPublish: can(m, "publish_products"),
  });
  return tg("sendMessage", {
    chat_id: chatId,
    text: `Редактирование: ${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    reply_markup: { inline_keyboard: rows },
  });
}

const FIELD_PROMPT: Record<EditorTextField, string> = {
  title: "название (3–300 символов)",
  description: "описание (до 5000 символов; «-» очистит поле)",
  specs: "характеристики (до 5000 символов; «-» очистит поле)",
  brand: "бренд (до 100 символов; «-» очистит поле)",
  sku: "артикул (1–60 символов без пробелов; «-» очистит поле)",
};

function editorNeedsText(st: EditorStateRow): boolean {
  return st.state.startsWith("edit_") || ["new_title", "new_sku", "new_price"].includes(st.state);
}

const QUESTION_RECOVERY =
  "⚠️ Не удалось подтвердить текущий вопрос. /input — получить его заново; /cancel — отменить ввод.";

async function showEditorQuestion(
  m: StaffMember,
  chatId: number,
  st: EditorStateRow,
  warning = "",
) {
  let prompt: string;
  if (st.state.startsWith("edit_")) {
    const field = st.state.slice(5) as EditorTextField;
    if (!(field in FIELD_PROMPT)) return;
    const p = await fetchProductById(st.product_id ?? "");
    if (!p)
      return tg("sendMessage", {
        chat_id: chatId,
        text: "Товар не найден. /cancel — отменить ввод.",
      });
    prompt = `✏️ «${p.title}»\nОтправьте новое значение — ${FIELD_PROMPT[field]}.${CANCEL_HINT}`;
  } else {
    const d = st.data as DraftData;
    prompt =
      (d.title ? `📝 Новый товар: «${d.title}»\n` : "") +
      draftStepPrompt(st.state as "new_title" | "new_sku" | "new_price");
  }
  let messageId: number;
  try {
    const sent = await (
      await tg("sendMessage", {
        chat_id: chatId,
        text:
          (warning ? warning + "\n\n" : "") +
          prompt +
          "\n\n↩️ Ответьте на это сообщение. /input — показать вопрос заново.",
        reply_markup: { force_reply: true, input_field_placeholder: "Ваш ответ на вопрос" },
      })
    ).json();
    messageId = sent.result?.message_id;
    if (!sent.ok || !Number.isSafeInteger(messageId) || messageId <= 0)
      throw new Error("QUESTION_UNCONFIRMED");
  } catch {
    return tg("sendMessage", { chat_id: chatId, text: QUESTION_RECOVERY });
  }
  const { data, error } = await matchEditorState(
    loose.from("bot_editor_states").update({
      data: { ...(st.data as Record<string, unknown>), _prompt_message_id: messageId },
    }),
    st,
  )
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("staff_telegram_id")
    .maybeSingle();
  if (error || !data)
    return tg("sendMessage", { chat_id: chatId, text: error ? QUESTION_RECOVERY : EDITOR_CHANGED });
  return;
}

async function refreshEditorQuestion(
  m: StaffMember,
  chatId: number,
  st: EditorStateRow,
  warning = "",
) {
  const saved = await setEditorState(
    m.telegram_id,
    st.state,
    st.data as Record<string, unknown>,
    st.product_id,
    st,
  );
  if (saved) return showEditorQuestion(m, chatId, saved, warning);
  return;
}

async function showDraftConfirmation(chatId: number, st: EditorStateRow) {
  const revision = editorRevision(st);
  if (!revision) return tg("sendMessage", { chat_id: chatId, text: EDITOR_CHANGED });
  const d = st.data as Required<DraftData>;
  return tg("sendMessage", {
    chat_id: chatId,
    text: draftPreviewText(d, slugBase(d.title)),
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Создать черновик", callback_data: `nd:c:${revision}` }],
        [{ text: "⬅️ Отмена", callback_data: `nd:x:${revision}` }],
      ],
    },
  });
}

async function showCategoryChoices(chatId: number, st: EditorStateRow) {
  const revision = editorRevision(st);
  if (!revision) return tg("sendMessage", { chat_id: chatId, text: EDITOR_CHANGED });
  const d = st.data as { cats: { id: string; name: string }[] };
  const p = await fetchProductById(st.product_id ?? "");
  if (!p)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Товар не найден. /cancel — отменить ввод.",
    });
  const rows: Btn[][] = d.cats.map((c, i) => [
    { text: c.name.slice(0, 40), callback_data: categoryChoiceCallback(i, revision) },
  ]);
  rows.push([{ text: "⬅️ К карточке", callback_data: `prd:${p.id}` }]);
  return tg("sendMessage", {
    chat_id: chatId,
    text: `Перенос «${p.title}» — выберите раздел.\n\n/cancel — отменить выбор. Переход к карточке сохраняет ввод.`,
    reply_markup: { inline_keyboard: rows },
  });
}

/** Prepare and recover through one durable revision; never consume input in the handler. */
async function editorPreview(
  m: StaffMember,
  chatId: number,
  revision: string,
  mode: "prepare" | "read",
  value: string | number | null = null,
) {
  if (!can(m, "edit_products"))
    return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для ввода товара." });
  const { data, error } = await rpc("bot_editor_preview", {
    p_staff_telegram_id: m.telegram_id,
    p_revision: revision,
    p_mode: mode,
    p_value: value,
  });
  const r = data as {
    id: string;
    action: EditorTextField | "category";
    title: string;
    sku: string | null;
    before: Record<string, string | null>;
    after: Record<string, string | null>;
    old_category: string | null;
    new_category: string;
    outcome: string | null;
    consumed_at: string | null;
    expired: boolean;
  } | null;
  if (error || !r?.id) {
    const known = error?.message ?? "";
    const msg =
      known.includes("PREVIEW_PERMISSION_DENIED") || known.includes("PREVIEW_NOT_OWNER")
        ? "Недостаточно прав для этого предпросмотра."
        : known.includes("PREVIEW_STEP_CHANGED")
          ? EDITOR_CHANGED
          : known.includes("PREVIEW_STEP_EXPIRED")
            ? "Срок ввода истёк. Откройте карточку и начните правку заново."
            : known.includes("PREVIEW_NOT_FOUND")
              ? "Сохранённого предпросмотра нет. /input — вернуться к вводу; если срок истёк, начните правку из карточки."
              : Object.keys(RPC_ERR_MSG).find((key) => known.includes(key));
    const knownText = msg && (RPC_ERR_MSG[msg] ?? msg);
    return tg("sendMessage", {
      chat_id: chatId,
      text:
        knownText ??
        "⚠️ Не удалось проверить сохранение предпросмотра. Товар не менялся на этом шаге. /input — продолжить или восстановить предпросмотр.",
      ...(knownText
        ? {}
        : {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔎 Проверить предпросмотр", callback_data: `ep:${revision}` }],
              ],
            },
          }),
    });
  }
  if (r.action === "category" && !can(m, "manage_categories"))
    return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для выбора раздела." });
  if (r.outcome || r.consumed_at || r.expired) {
    const status =
      r.outcome === "applied"
        ? "✅ Это изменение уже применено."
        : r.outcome === "canceled"
          ? "Изменение отменено."
          : r.consumed_at
            ? "Действие завершено, результат требует проверки в карточке."
            : "Срок предпросмотра истёк. Начните новую правку из карточки.";
    return tg("sendMessage", { chat_id: chatId, text: status });
  }
  const product = { title: r.title, sku: r.sku, ...r.before } as BotProduct;
  const text =
    r.action === "category"
      ? editCategoryPreviewText(product, r.old_category, r.new_category)
      : editFieldPreviewText(r.action, product, r.after[r.action] ?? null);
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: CONFIRM_ROWS(r.id) },
  });
}

async function resumeEditorInput(m: StaffMember, chatId: number) {
  if (!can(m, "edit_products"))
    return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для ввода товара." });
  if (!(await editorAvailable()))
    return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  const st = await getEditorState(m);
  const revision = st && editorRevision(st);
  if (st?.consumed_at && revision && (st.state.startsWith("edit_") || st.state === "pick_cat"))
    return editorPreview(m, chatId, revision, "read");
  if (!st || !checkEditorState(st, m.telegram_id, Date.now()).ok)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Активного ввода товара нет или срок истёк. /new — новый товар; /technical — черновик характеристик.",
    });
  if (editorNeedsText(st)) return refreshEditorQuestion(m, chatId, st);
  if (st.state === "new_confirm") return showDraftConfirmation(chatId, st);
  if (st.state === "pick_cat") {
    if (!can(m, "manage_categories"))
      return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для выбора раздела." });
    return showCategoryChoices(chatId, st);
  }
  return tg("sendMessage", { chat_id: chatId, text: EDITOR_CHANGED });
}

async function startEditorField(
  m: StaffMember,
  chatId: number,
  field: EditorTextField,
  productId: string,
) {
  if (!can(m, "edit_products"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: редактирование карточек недоступно для вашей роли.",
    });
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  if (!(await editorAvailable()))
    return tg("sendMessage", {
      chat_id: chatId,
      text: `⚠️ ${NOT_ACTIVATED_MSG}\n\nКогда база обновится, диалог заработает. Пока доступна команда: /set ${field === "description" ? "desc" : field} ${p.sku ?? p.title} <значение>`,
    });
  const saved = await setEditorState(m.telegram_id, `edit_${field}`, { product_id: p.id }, p.id);
  if (saved) return showEditorQuestion(m, chatId, saved);
  return;
}

/** Текст от сотрудника в личном чате: продолжение диалога редактора, если он активен. */
async function handleEditorText(
  m: StaffMember,
  chatId: number,
  text: string,
  replyTo?: number,
): Promise<boolean> {
  if (!(await editorAvailable())) return false;
  const st = await getEditorState(m);
  const chk = checkEditorState(st, m.telegram_id, Date.now());
  if (!chk.ok || !st) return false;
  if (!can(m, "edit_products")) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: редактирование карточек недоступно для вашей роли.",
    });
    return true;
  }
  if (editorNeedsText(st)) {
    const promptId = (st.data as Record<string, unknown> | null)?.["_prompt_message_id"];
    if (!Number.isSafeInteger(promptId) || Number(promptId) <= 0 || replyTo !== promptId) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "↩️ Ответьте на текущий вопрос через «Ответить» в Telegram. /input — показать вопрос заново. Это сообщение не изменило товар или шаг.",
      });
      return true;
    }
  }
  if (st.state.startsWith("edit_")) {
    const field = st.state.slice(5) as EditorTextField;
    if (!(field in EDITOR_FIELD_LABEL)) return false;
    const p = await fetchProductById(st.product_id ?? "");
    if (!p) {
      if (!(await claimEditorStep(st, chatId))) return true;
      await tg("sendMessage", { chat_id: chatId, text: "Товар не найден — диалог сброшен." });
      return true;
    }
    const v = validateEditorValue(field, text.trim() === "-" ? "" : text);
    if (!v.ok) {
      await refreshEditorQuestion(m, chatId, st, v.error);
      return true; // состояние сохраняем — ждём исправленный ввод
    }
    const revision = editorRevision(st);
    if (!revision) {
      await tg("sendMessage", { chat_id: chatId, text: EDITOR_CHANGED });
      return true;
    }
    await editorPreview(m, chatId, revision, "prepare", v.value ?? null);
    return true;
  }
  if (st.state === "new_title" || st.state === "new_sku" || st.state === "new_price")
    return handleDraftStep(m, chatId, st, text);
  return false;
}

async function handleDraftStep(
  m: StaffMember,
  chatId: number,
  st: EditorStateRow,
  text: string,
): Promise<boolean> {
  const data = (st.data ?? {}) as DraftData;
  if (st.state === "new_title") {
    const v = validateEditorValue("title", text);
    if (!v.ok) {
      await refreshEditorQuestion(m, chatId, st, v.error);
      return true;
    }
    const saved = await setEditorState(m.telegram_id, "new_sku", { title: v.value }, null, st);
    if (saved) await showEditorQuestion(m, chatId, saved);
    return true;
  }
  if (st.state === "new_sku") {
    let sku: string | null = null;
    if (text.trim() !== "-") {
      const v = validateEditorValue("sku", text);
      if (!v.ok) {
        await refreshEditorQuestion(m, chatId, st, v.error);
        return true;
      }
      sku = v.value ?? null;
    }
    if (sku) {
      const products = await fetchAllProducts();
      const dup = products.filter(
        (p) => p.sku !== null && normalizeText(p.sku) === normalizeText(sku!),
      );
      if (dup.length > 0) {
        await refreshEditorQuestion(
          m,
          chatId,
          st,
          `⚠️ Такой артикул уже есть: «${dup[0]!.title}». Укажите другой артикул или «-».`,
        );
        return true;
      }
    }
    const saved = await setEditorState(
      m.telegram_id,
      "new_price",
      { ...data, title: data.title, sku },
      null,
      st,
    );
    if (saved) await showEditorQuestion(m, chatId, saved);
    return true;
  }
  if (st.state === "new_price") {
    const price = parseBotPrice(text);
    if (!price) {
      await refreshEditorQuestion(
        m,
        chatId,
        st,
        "Не похоже на цену. Пример: 14990 или 14 990,50 (до 2 знаков).",
      );
      return true;
    }
    const d: Required<DraftData> = { title: data.title ?? "", sku: data.sku ?? null, price };
    const saved = await setEditorState(m.telegram_id, "new_confirm", d, null, st);
    if (!saved) return true;
    await showDraftConfirmation(chatId, saved);
    return true;
  }
  return false;
}

async function startNewDraft(m: StaffMember, chatId: number) {
  if (!can(m, "edit_products"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: создание товара недоступно для вашей роли.",
    });
  if (!(await editorAvailable()))
    return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  const saved = await setEditorState(m.telegram_id, "new_title", {});
  if (saved) return showEditorQuestion(m, chatId, saved);
  return;
}

// Создание черновика: stateful-диалог + дополнительное подтверждение (nd:c).
// RPC bot_finish_draft (0022): создание/отмена и сохранённый результат атомарны;
// source_url не приписывается, ID — UUID.
async function confirmNewDraft(m: StaffMember, chatId: number, accept: boolean, revision?: string) {
  if (!can(m, "edit_products"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: создание товара недоступно для вашей роли.",
    });
  if (!(await editorAvailable()))
    return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  if (!revision) return tg("sendMessage", { chat_id: chatId, text: EDITOR_CHANGED });
  // The database owns consumption + product + audit + receipt in one transaction.
  // Read the receipt before looking at current input: a later dialog must survive recovery.
  const { data, error } = await rpc("bot_finish_draft", {
    p_staff_telegram_id: m.telegram_id,
    p_revision: revision,
    p_accept: accept,
  });
  const r = data as {
    outcome?: string;
    product_id?: string;
    slug?: string;
    title?: string;
    replayed?: boolean;
  } | null;
  if (
    error ||
    !r ||
    !["created", "canceled"].includes(r.outcome ?? "") ||
    (r.outcome === "created" && (!r.product_id || !r.slug || !r.title))
  ) {
    const known: Record<string, string> = {
      DRAFT_PERMISSION_DENIED:
        "Недостаточно прав для создания товара. Обратитесь к администратору.",
      DRAFT_NOT_OWNER: "Это подтверждение другого сотрудника.",
      DRAFT_STEP_CHANGED: EDITOR_CHANGED,
      DRAFT_STEP_CONSUMED:
        "Этот ввод завершён прежней версией бота. Проверьте каталог перед новым созданием товара.",
      DRAFT_STEP_EXPIRED:
        "Время подтверждения истекло. Черновик этой попыткой не создан; начните заново: /cancel, затем /new.",
      BOT_SKU_DUPLICATE:
        "⚠️ Такой артикул уже есть в каталоге. Проверьте товар; для исправления ввода: /cancel, затем /new.",
      BOT_BAD_VALUE: "⚠️ Данные черновика не прошли проверку. Исправьте ввод: /cancel, затем /new.",
    };
    const explanation = error && known[error.message];
    return tg("sendMessage", {
      chat_id: chatId,
      text:
        explanation ||
        "⚠️ Итог создания или отмены пока не подтверждён. Нажмите «Проверить и завершить» ниже. Повтор использует эту же попытку и не создаст второй товар.",
      ...(explanation
        ? {}
        : {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🔄 Проверить и завершить",
                    callback_data: `nd:${accept ? "c" : "x"}:${revision}`,
                  },
                ],
              ],
            },
          }),
    });
  }
  if (r.outcome === "canceled")
    return tg("sendMessage", { chat_id: chatId, text: "Отменено: черновик не создан." });
  await tg("sendMessage", {
    chat_id: chatId,
    text: `✅ ${r.replayed ? "Черновик уже создан" : "Черновик создан"}: «${r.title}» (адрес: ${r.slug}). Статус — черновик; публикация — отдельным шагом после проверки полей и фото.`,
  });
  return sendProductCard(chatId, r.product_id!, m);
}

async function startCategoryPicker(m: StaffMember, chatId: number, productId: string) {
  if (!can(m, "manage_categories"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: перенос в другой раздел недоступен для вашей роли.",
    });
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  const { data } = await supabaseAdmin.from("categories").select("id,name").order("name");
  const cats = (data ?? []) as { id: string; name: string }[];
  if (cats.length === 0) return tg("sendMessage", { chat_id: chatId, text: "Разделы не найдены." });
  if (!(await editorAvailable()))
    return tg("sendMessage", {
      chat_id: chatId,
      text: `⚠️ ${NOT_ACTIVATED_MSG}\n\nПока доступна команда: /set cat ${p.sku ?? p.title} <название раздела>`,
    });
  const saved = await setEditorState(m.telegram_id, "pick_cat", { product_id: p.id, cats }, p.id);
  if (!saved) return;
  return showCategoryChoices(chatId, saved);
}

async function pickCategory(m: StaffMember, chatId: number, index: number, revision?: string) {
  if (!can(m, "manage_categories"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: перенос в другой раздел недоступен для вашей роли.",
    });
  const st = await getEditorState(m);
  const chk = checkEditorState(st, m.telegram_id, Date.now());
  if (!chk.ok || !st || st.state !== "pick_cat")
    return tg("sendMessage", {
      chat_id: chatId,
      text: EDITOR_STATE_REASON_MSG[chk.ok ? "not_found" : chk.reason]!,
    });
  if (!revision || editorRevision(st) !== revision)
    return tg("sendMessage", { chat_id: chatId, text: EDITOR_CHANGED });
  const data = (st.data ?? {}) as { product_id?: string; cats?: { id: string; name: string }[] };
  const cat = data.cats?.[index];
  if (!cat)
    return tg("sendMessage", { chat_id: chatId, text: "Некорректный выбор — начните заново." });
  const p = await fetchProductById(data.product_id ?? "");
  if (!p) {
    if (!(await claimEditorStep(st, chatId))) return;
    return tg("sendMessage", { chat_id: chatId, text: "Товар не найден — диалог сброшен." });
  }
  if (p.category_id === cat.id)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Товар уже в этом разделе — изменять нечего. Выберите другой раздел или /cancel.",
    });
  return editorPreview(m, chatId, revision, "prepare", index);
}

async function startStatusMenu(m: StaffMember, chatId: number, productId: string) {
  if (!can(m, "publish_products"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: смена статуса и публикация недоступны для вашей роли.",
    });
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  const rows: Btn[][] = (["published", "draft", "hidden"] as ProductStatus[]).map((s) => [
    { text: STATUS_CHOICE_LABEL[s], callback_data: statusChoiceCallback(p.id, s) },
  ]);
  rows.push([{ text: "⬅️ Назад", callback_data: `prd:${p.id}` }]);
  return tg("sendMessage", {
    chat_id: chatId,
    text: `Статус «${p.title}»: сейчас — ${botStatusLabel(p.status)}. Выберите новый:`,
    reply_markup: { inline_keyboard: rows },
  });
}

async function statusPreview(
  m: StaffMember,
  chatId: number,
  productId: string,
  status: ProductStatus,
) {
  if (!can(m, "publish_products"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: смена статуса и публикация недоступны для вашей роли.",
    });
  const p = await fetchProductById(productId);
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Товар не найден." });
  if (p.assortment_decision === "excluded" && status !== "hidden")
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Товар отмечен «Не продаём». Сначала верните его в ассортимент через /assort. Затем проверьте карточку и публикацию.",
    });
  if (p.status === status)
    return tg("sendMessage", { chat_id: chatId, text: "Статус уже такой — изменять нечего." });
  const photos = await photoCount(p.id);
  const check = canPublish(p, photos);
  if (status === "published" && !check.ok)
    return tg("sendMessage", {
      chat_id: chatId,
      text: editStatusPreviewText(p, botStatusLabel(p.status), status, check.missing),
    });
  return createPending(
    m,
    chatId,
    p.id,
    "status",
    { status: p.status },
    { status },
    editStatusPreviewText(p, botStatusLabel(p.status), status, []),
  );
}

// ---------- /set: текстовые правки, раздел и статус командой ----------

const SET_FIELDS: Record<string, EditorTextField> = {
  title: "title",
  desc: "description",
  description: "description",
  specs: "specs",
  brand: "brand",
  sku: "sku",
};

const SET_HELP =
  "Формат:\n/set <title|desc|specs|brand|sku> <SKU> <значение>\n/set cat <SKU> <название раздела>\n/set status <SKU> <витрина|черновик|скрыть>";

async function startSetCommand(m: StaffMember, chatId: number, args: string[]) {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "cat") return setCategoryCommand(m, chatId, args);
  if (sub === "status") return setStatusCommand(m, chatId, args);
  const field = SET_FIELDS[sub];
  if (!field) return tg("sendMessage", { chat_id: chatId, text: SET_HELP });
  if (!can(m, "edit_products"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: редактирование карточек недоступно для вашей роли.",
    });
  const skuQuery = args[1] ?? "";
  const rawValue = args.slice(2).join(" ");
  if (!skuQuery || rawValue.trim() === "")
    return tg("sendMessage", {
      chat_id: chatId,
      text: `Укажите SKU и новое значение.\n${SET_HELP}`,
    });
  const v = validateEditorValue(field, rawValue);
  if (!v.ok) return tg("sendMessage", { chat_id: chatId, text: v.error });
  const products = await fetchAllProducts();
  const r = resolveSingleProduct(products, skuQuery);
  if (r.kind === "none")
    return tg("sendMessage", { chat_id: chatId, text: `Товар «${skuQuery}» не найден.` });
  if (r.kind === "ambiguous")
    return tg("sendMessage", {
      chat_id: chatId,
      text: `Найдено несколько совпадений — уточните точный артикул (SKU):\n${r.products
        .map((x) => `• ${x.title}${x.sku ? ` — SKU ${x.sku}` : ""}`)
        .join("\n")}`,
    });
  const p = r.product;
  return createPending(
    m,
    chatId,
    p.id,
    field,
    { [field]: (p as unknown as Record<string, unknown>)[field] ?? null },
    { [field]: v.value ?? null },
    editFieldPreviewText(field, p, v.value ?? null),
  );
}

async function setCategoryCommand(m: StaffMember, chatId: number, args: string[]) {
  if (!can(m, "manage_categories"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: перенос в другой раздел недоступен для вашей роли.",
    });
  const skuQuery = args[1] ?? "";
  const catQuery = args.slice(2).join(" ").trim();
  if (!skuQuery || !catQuery)
    return tg("sendMessage", {
      chat_id: chatId,
      text: `Укажите SKU и название раздела.\n${SET_HELP}`,
    });
  const products = await fetchAllProducts();
  const r = resolveSingleProduct(products, skuQuery);
  if (r.kind === "none")
    return tg("sendMessage", { chat_id: chatId, text: `Товар «${skuQuery}» не найден.` });
  if (r.kind === "ambiguous")
    return tg("sendMessage", {
      chat_id: chatId,
      text: `Найдено несколько товаров — уточните точный артикул (SKU).`,
    });
  const { data } = await supabaseAdmin.from("categories").select("id,name").order("name");
  const cats = (data ?? []) as { id: string; name: string }[];
  const q = normalizeText(catQuery);
  let matches = cats.filter((c) => normalizeText(c.name) === q);
  if (matches.length === 0) matches = cats.filter((c) => normalizeText(c.name).includes(q));
  if (matches.length === 0)
    return tg("sendMessage", { chat_id: chatId, text: `Раздел «${catQuery}» не найден.` });
  if (matches.length > 1)
    return tg("sendMessage", {
      chat_id: chatId,
      text: `Несколько разделов похожи — уточните название:\n${matches
        .map((c) => `• ${c.name}`)
        .join("\n")}`,
    });
  const cat = matches[0]!;
  const p = r.product;
  if (p.category_id === cat.id)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Товар уже в этом разделе — изменять нечего.",
    });
  const oldName = await categoryName(p.category_id);
  return createPending(
    m,
    chatId,
    p.id,
    "category",
    { category_id: p.category_id },
    { category_id: cat.id },
    editCategoryPreviewText(p, oldName, cat.name),
  );
}

async function setStatusCommand(m: StaffMember, chatId: number, args: string[]) {
  const skuQuery = args[1] ?? "";
  const status = parseStatusInput(args.slice(2).join(" "));
  if (!skuQuery || !status)
    return tg("sendMessage", { chat_id: chatId, text: `Укажите SKU и статус.\n${SET_HELP}` });
  const products = await fetchAllProducts();
  const r = resolveSingleProduct(products, skuQuery);
  if (r.kind === "none")
    return tg("sendMessage", { chat_id: chatId, text: `Товар «${skuQuery}» не найден.` });
  if (r.kind === "ambiguous")
    return tg("sendMessage", {
      chat_id: chatId,
      text: `Найдено несколько товаров — уточните точный артикул (SKU).`,
    });
  return statusPreview(m, chatId, r.product.id, status);
}

// ---------- Откат применённого действия (preview → confirm) ----------

async function prepareRollback(m: StaffMember, chatId: number, pendingId: string) {
  if (!(await pendingAvailable()))
    return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  // RBAC по типу действия — ДО вызова RPC: без права откат не готовится вовсе
  // (RPC дополнительно проверяет владельца и outcome='applied').
  const rowRes = await loose
    .from("pending_actions")
    .select("action")
    .eq("id", pendingId)
    .maybeSingle();
  if (rowRes.error) return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  const act = (rowRes.data as { action?: PendingActionKind } | null)?.action;
  if (!act || !(act in PENDING_PERMISSION))
    return tg("sendMessage", { chat_id: chatId, text: PENDING_REASON_MSG["not_found"]! });
  if (!can(m, PENDING_PERMISSION[act]))
    return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для этого действия." });
  const { data, error } = await rpc("bot_prepare_rollback", {
    p_pending_id: pendingId,
    p_staff_telegram_id: m.telegram_id,
  });
  if (error) return tg("sendMessage", { chat_id: chatId, text: rpcErrMsg(error) });
  const r = data as {
    pending_id: string;
    action: PendingActionKind;
    title: string;
    before: unknown;
    after: unknown;
  } | null;
  if (!r) return tg("sendMessage", { chat_id: chatId, text: NOT_ACTIVATED_MSG });
  if (!(r.action in PENDING_PERMISSION) || !can(m, PENDING_PERMISSION[r.action]))
    return tg("sendMessage", { chat_id: chatId, text: "Недостаточно прав для этого действия." });
  return tg("sendMessage", {
    chat_id: chatId,
    text: `Откатить изменение?\n\n${r.title}\n${describePendingChange(r.action, r.before, r.after)}\n\nПодтвердите действие:`,
    reply_markup: { inline_keyboard: CONFIRM_ROWS(r.pending_id) },
  });
}

async function sendCategories(chatId: number) {
  const { data } = await supabaseAdmin.from("categories").select("id,name,parent_id").order("name");
  const cats = (data ?? []) as { id: string; name: string; parent_id: string | null }[];
  if (cats.length === 0) return tg("sendMessage", { chat_id: chatId, text: "Разделы не найдены." });
  const byId = new Map(cats.map((c) => [c.id, c]));
  const roots = cats.filter((c) => !c.parent_id || !byId.has(c.parent_id));
  const lines: string[] = [];
  for (const root of roots) {
    lines.push(`• ${root.name}`);
    for (const child of cats.filter((c) => c.parent_id === root.id))
      lines.push(`   ◦ ${child.name}`);
  }
  return tg("sendMessage", {
    chat_id: chatId,
    text: `Разделы (${cats.length}):\n${lines.join("\n").slice(0, 3500)}`,
  });
}

async function startPriceCommand(m: StaffMember, chatId: number, args: string[]) {
  const price = parseBotPrice(args[args.length - 1]);
  const skuQuery = args.slice(0, -1).join(" ").trim();
  if (!price || !skuQuery)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Формат: /price <SKU или модель> <цена>, например: /price MW-123 14990",
    });
  if (!can(m, "edit_prices"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: изменение цены недоступно для вашей роли.",
    });
  const products = await fetchAllProducts();
  const r = resolveSingleProduct(products, skuQuery);
  if (r.kind === "none")
    return tg("sendMessage", { chat_id: chatId, text: `Товар «${skuQuery}» не найден.` });
  if (r.kind === "ambiguous") {
    const { text, rows } = buildMutationChoice(r.products, "Изменение цены", (x) =>
      priceChoiceCallback(x, price),
    );
    return tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } });
  }
  return pricePreview(m, chatId, r.product.id, price);
}

async function startStockCommand(m: StaffMember, chatId: number, args: string[]) {
  const state = parseStockInput(args[args.length - 1]);
  const skuQuery = args.slice(0, -1).join(" ").trim();
  if (state === undefined || !skuQuery)
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Формат: /stock <SKU или модель> <есть|под_заказ>, например: /stock MW-123 под_заказ",
    });
  if (!can(m, "edit_stock"))
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Недостаточно прав: изменение наличия недоступно для вашей роли.",
    });
  const products = await fetchAllProducts();
  const r = resolveSingleProduct(products, skuQuery);
  if (r.kind === "none")
    return tg("sendMessage", { chat_id: chatId, text: `Товар «${skuQuery}» не найден.` });
  if (r.kind === "ambiguous") {
    const { text, rows } = buildMutationChoice(r.products, "Изменение наличия", (x) =>
      stockChoiceCallback(x, state),
    );
    return tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } });
  }
  return stockPreview(m, chatId, r.product.id, state);
}

async function handleCommand(m: StaffMember, chat: Chat, text: string, from: { id: number }) {
  const priv = isPrivateChat(chat, { id: m.telegram_id });
  const [raw, ...args] = text.trim().split(/\s+/);
  const cmd = (raw ?? "").toLowerCase().replace(/@[a-z0-9_]+$/, "");
  if (cmd === "/leads" || cmd === "/lead") {
    const { showB2B } = await import("@/lib/b2b/telegram.server");
    return showB2B(m, chat, from, parseB2BCommand(cmd, args));
  }
  if (cmd === "/start" || cmd === "/menu") return sendMenu(chat.id, m);
  if (cmd === "/shops" || cmd === "/shop")
    return tg("sendMessage", { chat_id: chat.id, ...staffShopMessage(process.env["APP_ENV"]) });
  if (
    !priv &&
    [
      "/catalog",
      "/find",
      "/product",
      "/summary",
      "/price",
      "/stock",
      "/set",
      "/new",
      "/cancel",
      "/categories",
      "/help",
    ].includes(cmd)
  )
    return tg("sendMessage", { chat_id: chat.id, text: PRIVATE_ONLY_MSG });
  switch (cmd) {
    case "/orders":
      if (!priv || !can(m, "manage_orders"))
        return tg("sendMessage", { chat_id: chat.id, text: "Нет доступа к заказам." });
      return sendOrdersList(chat.id, 0);
    case "/import":
      return showCatalogImport(m, chat, { op: "home" });
    case "/assort":
      return showAssortment(
        m,
        chat,
        args.length ? { p_op: "start", p_value: "all", p_query: args.join(" ") } : { p_op: "home" },
      );
    case "/catalog":
      return sendCatalogList(chat.id, "all", 0);
    case "/find": {
      const q = args.join(" ").trim();
      if (!q)
        return tg("sendMessage", {
          chat_id: chat.id,
          text: "Укажите запрос: /find <артикул или модель>",
        });
      return sendFindResults(chat.id, q, 0);
    }
    case "/product": {
      const q = args.join(" ").trim();
      if (!q)
        return tg("sendMessage", {
          chat_id: chat.id,
          text: "Укажите запрос: /product <артикул или модель>",
        });
      const products = await fetchAllProducts();
      const r = resolveSingleProduct(products, q);
      if (r.kind === "none")
        return tg("sendMessage", { chat_id: chat.id, text: `Товар «${q}» не найден.` });
      if (r.kind === "ambiguous") {
        const { text: t, rows } = buildBotList(
          r.products,
          0,
          `По запросу «${q}» несколько товаров`,
          (pg) => findCallback(pg, q),
        );
        return tg("sendMessage", {
          chat_id: chat.id,
          text: t,
          reply_markup: { inline_keyboard: rows },
        });
      }
      return sendProductCard(chat.id, r.product.id, m);
    }
    case "/summary": {
      const products = await fetchAllProducts();
      return tg("sendMessage", { chat_id: chat.id, text: buildCatalogSummary(products) });
    }
    case "/price":
      return startPriceCommand(m, chat.id, args);
    case "/stock":
      return startStockCommand(m, chat.id, args);
    case "/set":
      return startSetCommand(m, chat.id, args);
    case "/new":
      return startNewDraft(m, chat.id);
    case "/input":
      return resumeEditorInput(m, chat.id);
    case "/technical":
      return technicalEditor(m, chat, from, { command: "/technical" });
    case "/cancel": {
      if (can(m, "edit_products") && (await technicalEditor(m, chat, from, { command: "/cancel" })))
        return;
      const st = await getEditorState(m);
      if (st?.consumed_at && (st.state.startsWith("edit_") || st.state === "pick_cat"))
        return tg("sendMessage", {
          chat_id: chat.id,
          text: "Ввод уже завершён. /input — открыть результат или предпросмотр и отменить его кнопкой «Отмена».",
        });
      const outcome = st && (await consumeEditorState(st));
      return tg("sendMessage", {
        chat_id: chat.id,
        text:
          outcome === "claimed"
            ? "Диалог отменён."
            : outcome === "failed"
              ? "⚠️ Не удалось подтвердить отмену из-за сбоя связи с базой. Проверьте текущий ввод и повторите /cancel."
              : outcome === "changed"
                ? EDITOR_CHANGED
                : "Активного диалога нет.",
      });
    }
    case "/categories":
      return sendCategories(chat.id);
    case "/help":
      return tg("sendMessage", {
        chat_id: chat.id,
        text: [
          "Постоянные кнопки внизу: Меню, Заказы, Каталог, Помощь, Продолжить ввод, Отмена ввода.",
          "/input — текущий вопрос или подтверждение товара. На вопрос отвечайте через «Ответить» в Telegram.",
          "/menu — главное меню, /orders — заказы",
          "/shops — открыть сайт DEV или PRO внутри Telegram",
          "Заказы → карточка → В обработке. Для выдачи и отмены нужно подтверждение.",
          "Переход в раздел сохраняет незавершённый ввод; /cancel его отменяет.",
          "",
          "Команды панели каталога:",
          "/catalog — каталог, /find <SKU или модель> — поиск",
          "/product <SKU или модель> — карточка товара",
          "/summary — сводка по статусам и пометкам наличия",
          "/assort — ассортимент и массовые действия (администратор)",
          "/import — CSV-импорт товаров и цен с предпросмотром и откатом (администратор)",
          "/assort <запрос> — выбрать товары по названию, артикулу, бренду или разделу",
          "/price <SKU> <цена> — изменить цену",
          "/stock <SKU> <есть|под_заказ> — изменить пометку наличия",
          SET_HELP,
          "/new — создать черновик товара",
          "/categories — список разделов",
          "/cancel — отменить текущий диалог",
          "",
          "Все операции — только в личном чате; каждое изменение — с подтверждением.",
        ].join("\n"),
      });
    default:
      return tg("sendMessage", {
        chat_id: chat.id,
        text: "Неизвестная команда. /menu — список возможностей.",
      });
  }
}

// ---------- Заказы ----------

const ORDERS_FALLBACK_MSG = "Обработка заказов доступна только в личном чате с ботом.";

// Колонка shop_orders.status и таблица order_events появятся в сгенерированных
// типах только после применения миграции 0003, поэтому обращения к ним идут
// через структурный «свободный» тип. После применения миграции и перегенерации
// типов этот слой можно убрать.
interface LooseChain extends PromiseLike<{ data: unknown; error: { message: string } | null }> {
  select(cols: string): LooseChain;
  order(col: string, opts: { ascending: boolean }): LooseChain;
  limit(
    n: number,
  ): Promise<{ data: unknown[] | null; error: { message: string; code?: string | null } | null }>;
  eq(col: string, v: unknown): LooseChain;
  is(col: string, v: unknown): LooseChain;
  gt(col: string, v: unknown): LooseChain;
  update(patch: Record<string, unknown>): LooseChain;
  insert(row: Record<string, unknown>): LooseChain;
  upsert(
    row: Record<string, unknown>,
    opts: { onConflict: string },
  ): Promise<{ error: { message: string } | null }>;
  maybeSingle(): Promise<{
    data: unknown | null;
    error: { message: string; code?: string | null } | null;
  }>;
}
const loose = supabaseAdmin as unknown as { from(table: string): LooseChain };

/**
 * Читает заказы. Если колонка status ещё не добавлена (миграция 0003 не применена),
 * возвращает заказы без статуса — graceful fallback «только просмотр».
 */
async function fetchOrders(limit = 100): Promise<{ orders: OrderRow[]; hasStatusColumn: boolean }> {
  const res = await loose
    .from("shop_orders")
    .select("id, name, phone, comment, items, total, created_at, status")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (res.error) {
    const fb = await loose
      .from("shop_orders")
      .select("id, name, phone, comment, items, total, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    return { orders: (fb.data ?? []) as OrderRow[], hasStatusColumn: false };
  }
  return { orders: (res.data ?? []) as OrderRow[], hasStatusColumn: true };
}

async function fetchOrder(
  id: string,
): Promise<{ order: OrderRow | null; hasStatusColumn: boolean }> {
  const res = await loose
    .from("shop_orders")
    .select("id, name, phone, comment, items, total, created_at, status")
    .eq("id", id)
    .maybeSingle();
  if (res.error) {
    const fb = await loose
      .from("shop_orders")
      .select("id, name, phone, comment, items, total, created_at")
      .eq("id", id)
      .maybeSingle();
    return { order: (fb.data as OrderRow) ?? null, hasStatusColumn: false };
  }
  return { order: (res.data as OrderRow) ?? null, hasStatusColumn: true };
}

async function sendOrdersList(chatId: number, page: number) {
  const { orders } = await fetchOrders();
  const { text, rows } = buildOrdersList(orders, page);
  await tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: rows } });
}

async function sendOrderCard(chatId: number, orderId: string, messageId?: number, notice?: string) {
  const { order } = await fetchOrder(orderId);
  if (!order) {
    await showOrderMessage(
      chatId,
      {
        text: "Заказ не найден.",
        rows: [[{ text: "⬅️ К списку", callback_data: "orders:0" }]],
      },
      messageId,
    );
    return;
  }
  const { text, rows } = buildOrderCard(order, "");
  await showOrderMessage(chatId, { text: notice ? notice + "\n\n" + text : text, rows }, messageId);
}

async function applyStatus(
  m: StaffMember,
  chatId: number,
  orderId: string,
  next: OrderStatus,
  messageId?: number,
) {
  const { order, hasStatusColumn } = await fetchOrder(orderId);
  if (!order) {
    await tg("sendMessage", { chat_id: chatId, text: "Заказ не найден." });
    return;
  }
  const check = checkTransition(order, next, hasStatusColumn);
  if (!check.ok) {
    await sendOrderCard(chatId, orderId, messageId, check.message);
    return;
  }
  // Review-only 0010: locked status + both audit records in one transaction.
  // No separate UPDATE fallback: absence of RPC must block the mutation.
  const { data: updated, error } = await rpc("bot_change_order_status", {
    p_order_id: orderId,
    p_staff_telegram_id: m.telegram_id,
    p_expected_status: check.from,
    p_next_status: next,
  });
  if (
    error ||
    !updated ||
    typeof updated !== "object" ||
    !("ok" in updated) ||
    updated.ok !== true
  ) {
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        error && isMissingRpcError(error)
          ? NOT_ACTIVATED_MSG
          : "Смена статуса не подтверждена. Откройте заказ заново; при ошибке связи нужна проверка журнала.",
    });
    return;
  }
  await sendOrderCard(chatId, orderId, messageId);
}

// ---------- Обработка обновлений ----------

export async function handleUpdate(update: TgUpdate) {
  const cb = update.callback_query;
  // Use the actual callback actor/chat together. Never borrow message identity.
  const from = cb ? cb.from : update.message?.from;
  const chat = cb ? cb.message?.chat : update.message?.chat;
  const deny = () =>
    cb
      ? tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Нет доступа." })
      : chat
        ? tg("sendMessage", { chat_id: chat.id, text: "Нет доступа." })
        : undefined;
  if (cb && update.message) return deny();
  if (
    !from ||
    !chat ||
    !Number.isSafeInteger(from.id) ||
    from.id <= 0 ||
    !isPrivateChat(chat, from)
  )
    return deny();

  // DEV preview uses the existing test bot; production staff access stays separate.
  if (!cb && process.env["APP_ENV"] === "dev" && update.message?.text === "/shop")
    return tg("sendMessage", {
      chat_id: chat.id,
      text: customerMessage("/shop", process.env["PUBLIC_ORIGIN"]).text,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Открыть учебный магазин",
              web_app: { url: shopUrl(process.env["PUBLIC_ORIGIN"]) },
            },
          ],
        ],
      },
    });

  const { data, error: staffError } = await supabaseAdmin
    .from("staff")
    .select("*")
    .eq("telegram_id", from.id)
    .maybeSingle();
  const m = data as StaffMember | null;
  if (!staffError && !m && !cb && update.message?.text === "/start") {
    return tg("sendMessage", {
      chat_id: chat.id,
      text: `Доступ ещё не выдан. Ваш Telegram ID: ${from.id}. Передайте его владельцу магазина для доступа к ${process.env["APP_ENV"] === "dev" ? "тестовому" : "рабочему"} магазину. Затем снова отправьте /start.`,
    });
  }
  if (
    staffError ||
    !m ||
    !m.active ||
    m.telegram_id !== from.id ||
    m.telegram_id !== chat.id ||
    !["admin", "director", "seller"].includes(m.role)
  )
    return deny();

  if (!cb) {
    const text = update.message?.text ?? "";
    // Navigation buttons are reserved controls, never product editor input.
    const command = navigationCommand(text);
    if (command) return handleCommand(m, chat, command, from);
    if (text.startsWith("/")) return handleCommand(m, chat, text, from);
    // CSV documents are handled only after the private-actor and staff gates.
    if (update.message?.document && can(m, "import_prices"))
      return receiveCatalogDocument(m, chat, update.message.document, update.update_id);
    if (
      isPrivateChat(chat, from) &&
      (update.message?.photo || update.message?.document) &&
      can(m, "upload_photos")
    )
      return tg("sendMessage", { chat_id: chat.id, text: PHOTO_UPLOAD_NOT_CONNECTED_MSG });
    if (
      can(m, "edit_products") &&
      (await technicalEditor(m, chat, from, {
        text,
        replyTo: update.message?.reply_to_message?.message_id,
      }))
    )
      return;
    // Текст в личном чате может продолжать активный диалог редактора (C2A).
    if (
      isPrivateChat(chat, from) &&
      (await handleEditorText(
        m,
        chat.id,
        text.trim(),
        update.message?.reply_to_message?.message_id,
      ))
    )
      return;
    return sendMenu(chat.id, m);
  }
  if (cb.data?.startsWith("b2b:")) {
    const { showB2B } = await import("@/lib/b2b/telegram.server");
    const result = await showB2B(m, chat, from, parseB2BCallback(cb.data));
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    return result;
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  if (cb.data === "shop_versions" || cb.data === "shop_preview")
    return tg("sendMessage", {
      chat_id: chat.id,
      ...staffShopMessage(process.env["APP_ENV"]),
    });
  if (cb.data === "shop_pro_pending")
    return tg("sendMessage", { chat_id: chat.id, text: PRO_SHOP_PENDING });

  if (cb.data === "elevate_on" || cb.data === "elevate_off") {
    if (!can(m, "toggle_full_access")) return;
    const elevated = cb.data === "elevate_on";
    const { data: result, error } = await rpc("bot_toggle_elevated", {
      p_staff_telegram_id: m.telegram_id,
      p_expected_elevated: m.elevated,
      p_elevated: elevated,
    });
    if (error || !result || typeof result !== "object" || !("ok" in result) || result.ok !== true)
      return tg("sendMessage", { chat_id: chat.id, text: NOT_ACTIVATED_MSG });
    return sendMenu(chat.id, { ...m, elevated });
  }
  if (cb.data === "staff" && can(m, "manage_staff")) {
    try {
      await audit(m.telegram_id, "staff_read");
    } catch {
      return tg("sendMessage", { chat_id: chat.id, text: "Не удалось выполнить запрос." });
    }
    const { data: list, error } = await supabaseAdmin
      .from("staff")
      .select("name,telegram_id,role,elevated,active")
      .order("role");
    if (error) return tg("sendMessage", { chat_id: chat.id, text: "Не удалось выполнить запрос." });
    const text = (list ?? [])
      .map(
        (s) =>
          `${s.active ? "✅" : "⛔"} ${s.name} — ${{ admin: "администратор", director: "директор", seller: "продавец-консультант" }[s.role]}${s.elevated ? " (полный)" : ""} · ${s.telegram_id}`,
      )
      .join("\n");
    return tg("sendMessage", { chat_id: chat.id, text: `Сотрудники:\n${text}` });
  }
  if (cb.data === "deliveries") {
    if (!can(m, "view_audit"))
      return tg("sendMessage", {
        chat_id: chat.id,
        text: "Недостаточно прав для просмотра доставки.",
      });
    try {
      await audit(m.telegram_id, "order_deliveries_read");
      const { data: deliveries, error } = await supabaseAdmin
        .from("order_notifications" as never)
        .select("order_id,staff_telegram_id,state,updated_at")
        .order("updated_at", { ascending: false })
        .limit(10);
      if (error) throw new Error("DELIVERIES_UNAVAILABLE");
      const report = deliveryReport((deliveries ?? []) as unknown as DeliveryRow[]);
      return tg("sendMessage", {
        chat_id: chat.id,
        text: report.text,
        reply_markup: { inline_keyboard: report.rows },
      });
    } catch {
      return tg("sendMessage", {
        chat_id: chat.id,
        text: "Не удалось проверить доставку. Откройте «Заказы» и сообщите администратору время ошибки.",
      });
    }
  }
  if (cb.data === "audit" && can(m, "view_audit")) {
    try {
      await audit(m.telegram_id, "audit_read");
    } catch {
      return tg("sendMessage", { chat_id: chat.id, text: "Не удалось выполнить запрос." });
    }
    const { data: rows, error } = await supabaseAdmin
      .from("staff_audit_log")
      .select("telegram_id,action,created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return tg("sendMessage", { chat_id: chat.id, text: "Не удалось выполнить запрос." });
    const text =
      (rows ?? [])
        .map((r) => `${orderDateMoscow(r.created_at)} · ${r.telegram_id} · ${r.action}`)
        .join("\n") || "Пусто";
    return tg("sendMessage", { chat_id: chat.id, text: `Журнал:\n${text}` });
  }

  const data_str = typeof cb.data === "string" ? cb.data : "";
  if (data_str.startsWith("te:")) return technicalEditor(m, chat, from, { callback: data_str });
  if (data_str.startsWith("ci:"))
    return showCatalogImport(m, chat, parseImportCallback(data_str), cb.message?.message_id);
  if (data_str.startsWith("as:"))
    return showAssortment(m, chat, parseAssortmentCallback(data_str), cb.message?.message_id);

  // Каталог: служебные данные и операции — только в личном чате сотрудника.
  const priv = isPrivateChat(chat, from);
  const catalogGuard = () => tg("sendMessage", { chat_id: chat.id, text: PRIVATE_ONLY_MSG });

  if (data_str === "fndh") {
    if (!priv) return catalogGuard();
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "Отправьте команду: /find <артикул или модель>",
    });
  }
  if (data_str === "summary") {
    if (!priv) return catalogGuard();
    const products = await fetchAllProducts();
    return tg("sendMessage", { chat_id: chat.id, text: buildCatalogSummary(products) });
  }
  const kindM = data_str.match(/^(cat|drf|bko|sale):(\d+|noop)$/);
  if (kindM) {
    if (!priv) return catalogGuard();
    if (kindM[2] === "noop") return;
    const kind: CatalogKind =
      kindM[1] === "cat"
        ? "all"
        : kindM[1] === "drf"
          ? "draft"
          : kindM[1] === "bko"
            ? "backorder"
            : "sale";
    return sendCatalogList(chat.id, kind, Number(kindM[2]));
  }
  const findM = parseFindCallback(data_str);
  if (findM) {
    if (!priv) return catalogGuard();
    return sendFindResults(chat.id, findM.query, findM.page);
  }
  const prdM = data_str.match(/^prd:([0-9a-f-]{36})$/);
  if (prdM) {
    if (!priv) return catalogGuard();
    return sendProductCard(chat.id, prdM[1]!, m);
  }
  const ppM = data_str.match(/^pp:([0-9a-f-]{36})$/);
  if (ppM) {
    if (!priv) return catalogGuard();
    const p = await fetchProductById(ppM[1]!);
    return tg("sendMessage", {
      chat_id: chat.id,
      text: p ? `Введите: /price ${p.sku ?? p.title} <новая цена>` : "Товар не найден.",
    });
  }
  const psM = data_str.match(/^ps:([0-9a-f-]{36})$/);
  if (psM) {
    if (!priv) return catalogGuard();
    const p = await fetchProductById(psM[1]!);
    return tg("sendMessage", {
      chat_id: chat.id,
      text: p ? `Введите: /stock ${p.sku ?? p.title} <есть|под_заказ>` : "Товар не найден.",
    });
  }
  const pxpM = data_str.match(/^pxp:([0-9a-f-]{36}):p(\d+)$/);
  if (pxpM) {
    if (!priv) return catalogGuard();
    return pricePreview(m, chat.id, pxpM[1]!, Number(pxpM[2]) / 100);
  }
  const pxsM = data_str.match(/^pxs:([0-9a-f-]{36}):s([01])$/);
  if (pxsM) {
    if (!priv) return catalogGuard();
    return stockPreview(m, chat.id, pxsM[1]!, pxsM[2] === "1");
  }
  const pcM = data_str.match(/^pc:([0-9a-f-]{36})$/);
  if (pcM) {
    if (!priv) return catalogGuard();
    return confirmPending(m, chat.id, pcM[1]!);
  }
  const pcxM = data_str.match(/^pcx:([0-9a-f-]{36})$/);
  if (pcxM) {
    if (!priv) return catalogGuard();
    return cancelPending(m, chat.id, pcxM[1]!);
  }

  // Фото товара (C2B): только личный чат + RBAC внутри обработчиков.
  const phM = data_str.match(/^ph:([0-9a-f-]{36})$/);
  if (phM) {
    if (!priv) return catalogGuard();
    return sendPhotoGallery(m, chat.id, phM[1]!);
  }
  const phaM = data_str.match(/^pha:([0-9a-f-]{36})$/);
  if (phaM) {
    if (!priv) return catalogGuard();
    if (!can(m, "upload_photos")) return;
    return tg("sendMessage", { chat_id: chat.id, text: PHOTO_UPLOAD_NOT_CONNECTED_MSG });
  }
  const phd = parsePhotoDetailCallback(data_str);
  if (phd) {
    if (!priv) return catalogGuard();
    return sendPhotoDetail(m, chat.id, phd.productId, phd.index);
  }
  const phmM = data_str.match(/^phm:([0-9a-f-]{36}):(\d{1,2})$/);
  if (phmM) {
    if (!priv) return catalogGuard();
    return photoMainPreview(m, chat.id, phmM[1]!, Number(phmM[2]));
  }
  const phrM = data_str.match(/^ph([un]):([0-9a-f-]{36}):(\d{1,2})$/);
  if (phrM) {
    if (!priv) return catalogGuard();
    return photoReorderPreview(m, chat.id, phrM[2]!, Number(phrM[3]), phrM[1] === "u" ? -1 : 1);
  }
  const phxM = data_str.match(/^phx:([0-9a-f-]{36}):(\d{1,2})$/);
  if (phxM) {
    if (!priv) return catalogGuard();
    return photoDeletePreview(m, chat.id, phxM[1]!, Number(phxM[2]));
  }

  // Редактор карточек (C2A): все пути — только личный чат + RBAC внутри обработчиков.
  const editM = data_str.match(/^edit:([0-9a-f-]{36})$/);
  if (editM) {
    if (!priv) return catalogGuard();
    return sendEditMenu(m, chat.id, editM[1]!);
  }
  const etM = data_str.match(/^et:(title|description|specs|brand|sku|cat|st):([0-9a-f-]{36})$/);
  if (etM) {
    if (!priv) return catalogGuard();
    const f = etM[1]!;
    if (f === "cat") return startCategoryPicker(m, chat.id, etM[2]!);
    if (f === "st") return startStatusMenu(m, chat.id, etM[2]!);
    return startEditorField(m, chat.id, f as EditorTextField, etM[2]!);
  }
  const epM = data_str.match(/^ep:([0-9a-f-]{36})$/);
  if (epM) {
    if (!priv) return catalogGuard();
    return editorPreview(m, chat.id, epM[1]!, "read");
  }
  const ecM = data_str.match(/^ec:(\d{1,3})(?::([0-9a-f-]{36}))?$/);
  if (ecM) {
    if (!priv) return catalogGuard();
    return pickCategory(m, chat.id, Number(ecM[1]), ecM[2]);
  }
  const stpM = data_str.match(/^stp:([0-9a-f-]{36}):(published|draft|hidden)$/);
  if (stpM) {
    if (!priv) return catalogGuard();
    return statusPreview(m, chat.id, stpM[1]!, stpM[2] as ProductStatus);
  }
  const rbM = data_str.match(/^rb:([0-9a-f-]{36})$/);
  if (rbM) {
    if (!priv) return catalogGuard();
    return prepareRollback(m, chat.id, rbM[1]!);
  }
  const ndM = data_str.match(/^nd:([cx])(?::([0-9a-f-]{36}))?$/);
  if (ndM) {
    if (!priv) return catalogGuard();
    return confirmNewDraft(m, chat.id, ndM[1] === "c", ndM[2]);
  }

  // Заказы: только сотрудники с manage_orders и только в личном чате (ПДн).
  if (
    data_str === "orders" ||
    data_str.startsWith("orders:") ||
    data_str.startsWith("order:") ||
    data_str.startsWith("st:") ||
    data_str.startsWith("stc:")
  ) {
    if (!can(m, "manage_orders")) return;
    if (!canViewOrderData(chat, from)) {
      return tg("sendMessage", { chat_id: chat.id, text: ORDERS_FALLBACK_MSG });
    }

    if (data_str === "orders" || data_str === "orders:0") return sendOrdersList(chat.id, 0);
    const pageMatch = data_str.match(/^orders:(\d+)$/);
    if (pageMatch) return sendOrdersList(chat.id, Number(pageMatch[1] ?? 0));
    if (data_str === "orders:noop") return;

    const orderMatch = data_str.match(/^order:([0-9a-f-]{36})$/);
    if (orderMatch) return sendOrderCard(chat.id, orderMatch[1]!, cb.message?.message_id);

    const stcMatch = data_str.match(/^stc:([0-9a-f-]{36}):(\w+)$/);
    if (stcMatch) {
      const orderId = stcMatch[1]!;
      const next = stcMatch[2]!;
      if (!(next in STATUS_LABEL)) return;
      return showOrderMessage(
        chat.id,
        {
          text: `Подтвердите: перевести заказ ${orderNumber(orderId)} в статус «${STATUS_LABEL[next as OrderStatus]}»?`,
          rows: [
            [
              { text: "✅ Подтвердить", callback_data: `st:${orderId}:${next}` },
              { text: "⬅️ Отмена", callback_data: `order:${orderId}` },
            ],
          ],
        },
        cb.message?.message_id,
      );
    }
    const stMatch = data_str.match(/^st:([0-9a-f-]{36}):(\w+)$/);
    if (stMatch) {
      const orderId = stMatch[1]!;
      const next = stMatch[2]!;
      if (!(next in STATUS_LABEL)) return;
      return applyStatus(m, chat.id, orderId, next as OrderStatus, cb.message?.message_id);
    }
    return;
  }

  if (cb.data === "stock") {
    if (!priv) return catalogGuard();
    const [{ count: pub }, { count: draft }, { count: out }] = await Promise.all([
      supabaseAdmin
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("status", "published"),
      supabaseAdmin
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("status", "draft"),
      supabaseAdmin
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("in_stock", false),
    ]);
    return tg("sendMessage", {
      chat_id: chat.id,
      text: `Каталог:\n• на витрине: ${pub ?? 0}\n• черновики: ${draft ?? 0}\n• под заказ: ${out ?? 0}\n\nИзменить пометку: /stock <SKU> <есть|под_заказ>`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📝 Черновики", callback_data: "drf:0" },
            { text: "🚚 Под заказ", callback_data: "bko:0" },
          ],
        ],
      },
    });
  }
  if (cb.data === "prices") {
    if (!priv) return catalogGuard();
    const products = await fetchAllProducts();
    const sale = products.filter((p) => isDiscounted(p));
    const { text, rows } = buildBotList(sale, 0, "Цена снижена", (pg) => `sale:${pg}`);
    return tg("sendMessage", {
      chat_id: chat.id,
      text: `${text}\n\nИзменить цену: /price <SKU> <цена>`,
      reply_markup: { inline_keyboard: rows },
    });
  }
  if (cb.data === "product_new") {
    if (!priv) return catalogGuard();
    return startNewDraft(m, chat.id);
  }
  if (cb.data === "categories") {
    if (!priv) return catalogGuard();
    if (!can(m, "manage_categories")) return;
    return sendCategories(chat.id);
  }
  if (cb.data === "photos") {
    if (!priv) return catalogGuard();
    if (!can(m, "upload_photos")) return;
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "Откройте карточку товара (/product <SKU> или через каталог) и нажмите «🖼 Фото» — там просмотр и управление галереей.",
    });
  }
  if (cb.data === "import") {
    if (!priv) return catalogGuard();
    if (!can(m, "import_prices")) return;
    return showCatalogImport(m, chat, { op: "home" });
  }
  return tg("sendMessage", { chat_id: chat.id, text: "Этот раздел скоро появится." });
}
