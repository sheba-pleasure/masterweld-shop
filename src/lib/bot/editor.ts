// Чистая (тестируемая) логика редактора карточек товара в Telegram-боте
// интернет-магазина «Мастер Сварщик»: валидация полей, slug, публикация,
// состояния диалогов (TTL/replay), кодирование callback. Без обращений к БД.

import { makeCallback, type BotProduct, type BtnRows } from "./catalog";

/** TTL состояния диалога редактора (как у pending_actions C1). */
export const EDITOR_STATE_TTL_MS = 15 * 60 * 1000;

// ---------- Валидация текстовых полей ----------

// Редактируемые текстовые поля. slug и source_url в белый список не входят
// НИКОГДА: адрес товара и ссылка на старый сайт ботом не меняются.
export type EditorTextField = "title" | "description" | "specs" | "brand" | "sku";

export const EDITOR_FIELD_LABEL: Record<EditorTextField, string> = {
  title: "название",
  description: "описание",
  specs: "характеристики",
  brand: "бренд",
  sku: "артикул",
};

export interface FieldValidation {
  ok: boolean;
  /** Нормализованное значение (null — очистить поле); задано только при ok. */
  value?: string | null;
  error?: string;
}

const SKU_RE = /^[A-Za-zА-Яа-яЁё0-9._/+-]{1,60}$/;

/**
 * Валидация значения текстового поля.
 * title: 3–300 символов, обязательно.
 * description/specs: до 5000, пустая строка очищает поле (null).
 * brand: до 100, пустая строка очищает (null).
 * sku: 1–60 символов, буквы/цифры и . _ / + -; пустая строка очищает (null).
 */
export function validateEditorValue(field: EditorTextField, raw: string): FieldValidation {
  const value = raw.trim().replace(/\s+/g, " ");
  switch (field) {
    case "title":
      if (value.length < 3)
        return { ok: false, error: "Название слишком короткое — минимум 3 символа." };
      if (value.length > 300)
        return { ok: false, error: "Название слишком длинное — максимум 300 символов." };
      return { ok: true, value };
    case "description":
      if (value.length > 5000)
        return { ok: false, error: "Описание слишком длинное — максимум 5000 символов." };
      return { ok: true, value: value.length === 0 ? null : value };
    case "specs":
      if (value.length > 5000)
        return { ok: false, error: "Характеристики слишком длинные — максимум 5000 символов." };
      return { ok: true, value: value.length === 0 ? null : value };
    case "brand":
      if (value.length > 100)
        return { ok: false, error: "Бренд слишком длинный — максимум 100 символов." };
      return { ok: true, value: value.length === 0 ? null : value };
    case "sku":
      if (value.length === 0) return { ok: true, value: null };
      if (!SKU_RE.test(value))
        return {
          ok: false,
          error:
            "Артикул: 1–60 символов, допустимы буквы, цифры и символы . _ / + - (без пробелов).",
        };
      return { ok: true, value };
  }
}

// ---------- Slug для новых черновиков ----------

const TRANSLIT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** Базовый slug из названия (транслитерация, [a-z0-9-]); суффикс уникальности — в БД. */
export function slugBase(title: string): string {
  const lat = title
    .toLowerCase()
    .split("")
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("");
  const slug = lat
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "tovar";
}

// ---------- Публикация ----------

export interface PublishCheck {
  ok: boolean;
  missing: string[];
}

/** Обязательные данные перед публикацией: название, цена > 0, хотя бы одно фото. */
export function canPublish(
  p: Pick<BotProduct, "title" | "price">,
  photoCount: number,
): PublishCheck {
  const missing: string[] = [];
  if (p.title.trim().length < 3) missing.push("название");
  if (!(Number(p.price) > 0)) missing.push("цена больше нуля");
  if (photoCount < 1) missing.push("хотя бы одно фото");
  return { ok: missing.length === 0, missing };
}

export const PUBLISH_MISSING_TEXT = "Публикация невозможна: не заполнено/отсутствует — ";

// ---------- Статусы ----------

export type ProductStatus = "draft" | "published" | "hidden";

export const STATUS_CHOICE_LABEL: Record<ProductStatus, string> = {
  published: "📤 На витрину",
  draft: "📝 В черновик",
  hidden: "🚫 Скрыть",
};

/** Статус из текста: «витрина»/«опубликовать» → published; «черновик» → draft; «скрыть»/«скрыт» → hidden. */
export function parseStatusInput(text: string | undefined): ProductStatus | undefined {
  const s = (text ?? "").trim().toLowerCase().replace(/ё/g, "е");
  if (s === "витрина" || s === "опубликовать" || s === "published") return "published";
  if (s === "черновик" || s === "draft") return "draft";
  if (s === "скрыть" || s === "скрыт" || s === "скрытый" || s === "hidden") return "hidden";
  return undefined;
}

// ---------- Callback редактора (лимит 64 байта проверяется makeCallback) ----------

export function editMenuCallback(productId: string): string {
  return makeCallback(`edit:${productId}`);
}

export function editFieldCallback(field: EditorTextField, productId: string): string {
  return makeCallback(`et:${field}:${productId}`);
}

export function editCategoryCallback(productId: string): string {
  return makeCallback(`et:cat:${productId}`);
}

export function editStatusCallback(productId: string): string {
  return makeCallback(`et:st:${productId}`);
}

export function statusChoiceCallback(productId: string, status: ProductStatus): string {
  return makeCallback(`stp:${productId}:${status}`);
}

/** Выбор товара для /set при неоднозначном SKU. */
export function setChoiceCallback(field: EditorTextField, productId: string): string {
  return makeCallback(`esp:${field}:${productId}`);
}

export function setChoiceParse(data: string): { field: EditorTextField; productId: string } | null {
  const m = data.match(/^esp:(title|description|specs|brand|sku):([0-9a-f-]{36})$/);
  if (!m) return null;
  return { field: m[1] as EditorTextField, productId: m[2]! };
}

/** Выбор категории из списка (индекс в состоянии диалога pick_cat). */
export function categoryChoiceCallback(index: number): string {
  return makeCallback(`ec:${index}`);
}

export function rollbackCallback(pendingId: string): string {
  return makeCallback(`rb:${pendingId}`);
}

// ---------- Меню редактора ----------

export interface EditMenuOpts {
  canEditText: boolean;
  canManageCategories: boolean;
  canPublish: boolean;
}

/** Меню «Редактировать» на карточке: только доступные роли кнопки. */
export function editMenuRows(p: BotProduct, opts: EditMenuOpts): BtnRows {
  const rows: BtnRows = [];
  if (opts.canEditText) {
    rows.push([
      { text: "🏷 Название", callback_data: editFieldCallback("title", p.id) },
      { text: "📄 Описание", callback_data: editFieldCallback("description", p.id) },
    ]);
    rows.push([
      {
        text: "📄 Прежнее описание характеристик",
        callback_data: editFieldCallback("specs", p.id),
      },
      { text: "🏭 Бренд", callback_data: editFieldCallback("brand", p.id) },
    ]);
    rows.push([{ text: "⚙️ Проверенные характеристики", callback_data: `te:open:${p.id}` }]);
    rows.push([{ text: "🔢 Артикул", callback_data: editFieldCallback("sku", p.id) }]);
  }
  if (opts.canManageCategories)
    rows.push([{ text: "🗂 Перенести в раздел", callback_data: editCategoryCallback(p.id) }]);
  if (opts.canPublish)
    rows.push([
      { text: "📌 Статус (витрина/черновик/скрыть)", callback_data: editStatusCallback(p.id) },
    ]);
  rows.push([{ text: "⬅️ Назад к карточке", callback_data: makeCallback(`prd:${p.id}`) }]);
  return rows;
}

// ---------- Тексты предпросмотров ----------

function clip(s: string | null | undefined, n = 80): string {
  if (s === null || s === undefined || s === "") return "—";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function editFieldPreviewText(
  field: EditorTextField,
  p: Pick<BotProduct, "title" | "sku" | EditorTextField>,
  newValue: string | null,
): string {
  const old = clip((p as Record<string, unknown>)[field] as string | null);
  const next = clip(newValue);
  return [
    `Изменить ${EDITOR_FIELD_LABEL[field]} товара?`,
    "",
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Было: ${old}`,
    `Станет: ${next}`,
    "",
    "Подтвердите действие:",
  ].join("\n");
}

export function editCategoryPreviewText(
  p: Pick<BotProduct, "title" | "sku">,
  oldCatName: string | null,
  newCatName: string,
): string {
  return [
    "Перенести товар в другой раздел?",
    "",
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Было: ${oldCatName ?? "—"}`,
    `Станет: ${newCatName}`,
    "",
    "Подтвердите действие:",
  ].join("\n");
}

export function editStatusPreviewText(
  p: Pick<BotProduct, "title" | "sku">,
  oldStatus: string,
  newStatus: ProductStatus,
  missing: string[],
): string {
  if (newStatus === "published" && missing.length > 0) {
    return `${PUBLISH_MISSING_TEXT}${missing.join(", ")}.`;
  }
  const label: Record<ProductStatus, string> = {
    published: "на витрине",
    draft: "черновик",
    hidden: "скрыт",
  };
  return [
    "Изменить статус товара?",
    "",
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Было: ${oldStatus}`,
    `Станет: ${label[newStatus]}`,
    "",
    "Подтвердите действие:",
  ].join("\n");
}

// ---------- Состояния диалогов (stateful) ----------

export type EditorStateName =
  | "edit_title"
  | "edit_description"
  | "edit_specs"
  | "edit_brand"
  | "edit_sku"
  | "pick_cat"
  | "new_title"
  | "new_sku"
  | "new_price"
  | "new_confirm";

export interface EditorStateRow {
  staff_telegram_id: number;
  state: string;
  data: unknown;
  product_id: string | null;
  expires_at: string;
  consumed_at: string | null;
}

export type EditorStateCheck =
  { ok: true } | { ok: false; reason: "not_found" | "not_owner" | "expired" | "consumed" };

/** Проверка состояния диалога: владелец, TTL, одноразовость. */
export function checkEditorState(
  row: EditorStateRow | null,
  staffTelegramId: number,
  nowMs: number,
): EditorStateCheck {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.staff_telegram_id !== staffTelegramId) return { ok: false, reason: "not_owner" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  const exp = Date.parse(row.expires_at);
  if (!Number.isFinite(exp) || nowMs >= exp) return { ok: false, reason: "expired" };
  return { ok: true };
}

export const EDITOR_STATE_REASON_MSG: Record<string, string> = {
  not_found: "Нет активного диалога — начните заново: /new или ✏️ Редактировать на карточке.",
  not_owner: "Это диалог другого сотрудника.",
  expired: "Диалог устарел — начните заново.",
  consumed: "Диалог уже завершён — начните заново.",
};

export const CANCEL_HINT = "\n\nОтмена — /cancel";

// ---------- Диалог нового черновика ----------

export interface DraftData {
  title?: string;
  sku?: string | null;
  price?: number;
}

export function draftStepPrompt(step: EditorStateName): string {
  switch (step) {
    case "new_title":
      return `Создание черновика. Отправьте название товара (3–300 символов).${CANCEL_HINT}`;
    case "new_sku":
      return `Отправьте артикул (SKU) — 1–60 символов без пробелов, или «-», если артикула нет.${CANCEL_HINT}`;
    case "new_price":
      return `Отправьте цену в рублях, например 14990 или 14 990,50.${CANCEL_HINT}`;
    default:
      return CANCEL_HINT;
  }
}

/** Предпросмотр нового черновика: создаётся только черновик, публикация — отдельным шагом. */
export function draftPreviewText(d: Required<DraftData>, baseSlug: string): string {
  return [
    "Создать новый товар-черновик?",
    "",
    `Название: ${d.title}`,
    `Артикул: ${d.sku ?? "—"}`,
    `Цена: ${d.price} ₽`,
    `Статус: черновик (на витрине не появится)`,
    `Адрес (slug): ${baseSlug} — при совпадении добавится суффикс`,
    "",
    "Ссылка на старый сайт (source_url) не приписывается автоматически.",
    "Фото можно будет добавить отдельным этапом. Публикация — только после проверки обязательных полей.",
    "",
    "Подтвердите создание:",
  ].join("\n");
}
