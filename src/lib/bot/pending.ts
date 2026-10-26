// Чистая (тестируемая) логика двухшаговых операций бота (preview → confirm):
// TTL, anti-replay, сравнение старого значения перед изменением. Без обращений к БД.

import { formatRub, type BotProduct } from "./catalog";
import { EDITOR_FIELD_LABEL } from "./editor";
import type { Permission } from "./permissions";

export const PENDING_TTL_MS = 15 * 60 * 1000;

export type PendingActionKind =
  | "price"
  | "stock"
  | "title"
  | "description"
  | "specs"
  | "brand"
  | "sku"
  | "category"
  | "status"
  | "photo_main"
  | "photo_reorder"
  | "photo_delete";

const TEXT_FIELDS: PendingActionKind[] = ["title", "description", "specs", "brand", "sku"];

export interface PendingRow {
  id: string;
  staff_telegram_id: number;
  product_id: string;
  action: PendingActionKind;
  before_value: unknown;
  after_value: unknown;
  expires_at: string;
  consumed_at: string | null;
}

export type PendingCheck =
  { ok: true } | { ok: false; reason: "not_found" | "not_owner" | "expired" | "consumed" };

export const PENDING_REASON_MSG: Record<string, string> = {
  not_found: "Запрос не найден — возможно, он устарел. Повторите команду.",
  not_owner: "Это действие создал другой сотрудник — подтверждать его запрещено.",
  expired: "Срок подтверждения истёк — повторите команду.",
  consumed: "Действие уже выполнено или отменено — повторное применение запрещено.",
};

/** Проверка pending-действия перед подтверждением: владелец, TTL, одноразовость. */
export function checkPending(
  row: PendingRow | null,
  staffTelegramId: number,
  nowMs: number,
): PendingCheck {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.staff_telegram_id !== staffTelegramId) return { ok: false, reason: "not_owner" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  const exp = Date.parse(row.expires_at);
  if (!Number.isFinite(exp) || nowMs >= exp) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** Совпадает ли сохранённое «было» с текущим значением товара (защита от гонок). */
export function beforeMatches(
  action: PendingActionKind,
  current: Partial<Pick<BotProduct, "price" | "in_stock" | "title" | "brand" | "sku">> & {
    description?: string | null;
    specs?: string | null;
    category_id?: string | null;
    status?: string;
    photos?: { id: string; sort_order: number; is_main: boolean }[];
  },
  before: unknown,
): boolean {
  if (typeof before !== "object" || before === null) return false;
  const b = before as Record<string, unknown>;
  if (action === "price") {
    return (
      typeof b["price"] === "number" &&
      typeof current.price === "number" &&
      Math.round(current.price * 100) === Math.round(b["price"] * 100)
    );
  }
  if (action === "stock") {
    return typeof b["in_stock"] === "boolean" && current.in_stock === b["in_stock"];
  }
  if (TEXT_FIELDS.includes(action)) {
    if (!(action in b)) return false;
    const cur = (current as Record<string, unknown>)[action] ?? null;
    const prev = b[action] ?? null;
    return cur === prev;
  }
  if (action === "category") {
    return "category_id" in b && (current.category_id ?? null) === (b["category_id"] ?? null);
  }
  if (action === "status") {
    return typeof b["status"] === "string" && current.status === b["status"];
  }
  if (action === "photo_main" || action === "photo_reorder" || action === "photo_delete") {
    const photos = current.photos ?? [];
    const ph = photos.find((x) => x.id === b["photo_id"]);
    if (!ph) return false;
    if (action === "photo_main") return ph.is_main === b["is_main"];
    return ph.sort_order === b["sort_order"];
  }
  return false;
}

/** Какое право требуется для подтверждения/отката каждого типа действия. */
export const PENDING_PERMISSION: Record<PendingActionKind, Permission> = {
  price: "edit_prices",
  stock: "edit_stock",
  title: "edit_products",
  description: "edit_products",
  specs: "edit_products",
  brand: "edit_products",
  sku: "edit_products",
  category: "manage_categories",
  status: "publish_products",
  // Фото-действия: все требуют upload_photos; права продавца не расширяются.
  photo_main: "upload_photos",
  photo_reorder: "upload_photos",
  photo_delete: "upload_photos",
};

/** Человекочитаемое описание изменения по типу действия (для сообщения после применения). */
export function describePendingChange(
  action: PendingActionKind,
  before: unknown,
  after: unknown,
): string {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  if (action === "price") return describePriceChange(Number(b["price"]), Number(a["price"]));
  if (action === "stock")
    return describeStockChange(Boolean(b["in_stock"]), Boolean(a["in_stock"]));
  if (action === "status") {
    const label: Record<string, string> = {
      published: "на витрине",
      draft: "черновик",
      hidden: "скрыт",
    };
    return `статус: ${label[String(b["status"])] ?? b["status"]} → ${label[String(a["status"])] ?? a["status"]}`;
  }
  if (action === "category") return "перенесён в другой раздел";
  const short = (v: unknown) => (typeof v === "string" ? v.slice(0, 8) : "—");
  const pos = (v: unknown) => (typeof v === "number" ? `#${v + 1}` : "—");
  if (action === "photo_main")
    return `основное фото: #${short(b["prev_main_id"])} → #${short(a["photo_id"])}`;
  if (action === "photo_reorder")
    return `порядок фото: ${pos(b["sort_order"])} → ${pos(a["sort_order"])}`;
  if (action === "photo_delete") return `фото #${short(a["photo_id"])} скрыто (обратимо)`;
  return `${EDITOR_FIELD_LABEL[action]}: ${describeTextChange(b[action], a[action])}`;
}

/** Описание текстового изменения «было → станет» (для сообщения после применения). */
export function describeTextChange(before: unknown, after: unknown, maxLen = 60): string {
  const clip = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    const t = String(v).replace(/\s+/g, " ").trim();
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
  };
  return `${clip(before)} → ${clip(after)}`;
}

export function describePriceChange(before: number, after: number): string {
  return `${formatRub(before)} → ${formatRub(after)}`;
}

export function describeStockChange(before: boolean, after: boolean): string {
  const label = (v: boolean) => (v ? "Отмечено в наличии" : "Под заказ");
  return `${label(before)} → ${label(after)}`;
}

/** Таблица pending_actions ещё не создана (миграция 0005 не применена). */
export function isMissingTableError(
  err: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "PGRST205") return true;
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("не существует") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}
