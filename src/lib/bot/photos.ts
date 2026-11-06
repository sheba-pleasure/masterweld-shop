// Чистая (тестируемая) логика управления фотографиями товара в Telegram-боте
// интернет-магазина «Мастер Сварщик»: валидация изображений (сигнатура/MIME/
// размер), безопасность URL, хэш против дублей, кодирование callback, адаптер
// получения байтов из Telegram. Без обращений к БД, Telegram и Storage.
//
// Загрузка новых фото из Telegram ЗАБЛОКИРОВАНА (fail closed) до живой
// проверки, что gateway отдаёт бинарные файлы (см. TELEGRAM_PHOTO_UPLOAD_VERIFIED).

import { makeCallback, type BotProduct, type BtnRows } from "./catalog";

/** Сколько фото показываем в списке галереи. */
export const PHOTO_LIST_LIMIT = 10;
/** Верхняя граница числа фото у товара. */
export const MAX_GALLERY_PHOTOS = 50;
/** Максимальный размер одного файла фото — 5 МБ. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MIN_PHOTO_DIM = 100;
export const MAX_PHOTO_DIM = 8000;

export const ALLOWED_PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedPhotoMime = (typeof ALLOWED_PHOTO_MIMES)[number];

// ---------- Валидация изображений ----------

/** MIME по сигнатуре файла (magic bytes) — без доверия расширению и заявленному типу. */
export function sniffImageMime(bytes: Uint8Array): AllowedPhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** Нормализация заявленного MIME: image/jpg → image/jpeg. */
export function normalizeMime(m: string | null | undefined): string | null {
  if (!m) return null;
  const s = m.trim().toLowerCase();
  if (s === "image/jpg" || s === "image/pjpeg") return "image/jpeg";
  return s;
}

export interface PhotoBytesCheck {
  ok: boolean;
  mime?: AllowedPhotoMime;
  size: number;
  error?: string;
}

/**
 * Строгая проверка байтов фото: непустой файл, размер ≤ 5 МБ,
 * сигнатура JPEG/PNG/WebP, совпадение заявленного MIME с содержимым.
 */
export function validatePhotoBytes(
  bytes: Uint8Array | null | undefined,
  declaredMime: string | null | undefined,
): PhotoBytesCheck {
  if (!bytes || bytes.length === 0) return { ok: false, size: 0, error: "Пустой файл." };
  if (bytes.length > MAX_PHOTO_BYTES)
    return { ok: false, size: bytes.length, error: "Файл больше 5 МБ." };
  const sniffed = sniffImageMime(bytes);
  if (!sniffed)
    return {
      ok: false,
      size: bytes.length,
      error: "Это не JPEG/PNG/WebP (проверено по сигнатуре файла).",
    };
  const declared = normalizeMime(declaredMime);
  if (declared && declared !== sniffed)
    return {
      ok: false,
      size: bytes.length,
      error: "Заявленный тип файла не совпадает с его содержимым.",
    };
  return { ok: true, mime: sniffed, size: bytes.length };
}

/** SHA-256 (hex) — защита от повторной загрузки того же файла. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Безопасность URL фотографии ----------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateOrLocalIpv4(host: string): boolean {
  const m = host.match(IPV4_RE);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateOrLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.endsWith(".internal") || h === "::1" || h === "[::1]") return true;
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true; // fc00::/7, fe80::/10
  if (IPV4_RE.test(h)) return isPrivateOrLocalIpv4(h);
  return false;
}

/**
 * Допустим ли адрес фотографии: только https, без учётных данных в URL,
 * без внутренних/локальных адресов, без data: и без логин-адресов Telegram.
 */
export function isSafePhotoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (!u.hostname) return false;
  if (isPrivateOrLocalHost(u.hostname)) return false;
  // Логин-адреса и API Telegram — не источник изображений для витрины.
  if (/(^|\.)(telegram\.org|t\.me|telegram\.me)$/.test(u.hostname.toLowerCase())) return false;
  return true;
}

// ---------- Callback (лимит 64 байта проверяется makeCallback) ----------

export function photoMenuCallback(productId: string): string {
  return makeCallback(`ph:${productId}`);
}

export function photoAddCallback(productId: string): string {
  return makeCallback(`pha:${productId}`);
}

const PHOTO_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function photoDetailCallback(photoId: string): string {
  return makeCallback(`pfd:${photoId}`);
}

export function parsePhotoDetailCallback(data: string): { photoId: string } | null {
  const m = data.match(new RegExp(`^pfd:(${PHOTO_ID})$`));
  return m ? { photoId: m[1]! } : null;
}

export type PhotoAction = "m" | "u" | "n" | "x";
export function photoActionCallback(action: PhotoAction, photoId: string): string {
  return makeCallback(`pf${action}:${photoId}`);
}

export function parsePhotoActionCallback(
  data: string,
): { action: PhotoAction; photoId: string } | null {
  const m = data.match(new RegExp(`^pf([munx]):(${PHOTO_ID})$`));
  return m ? { action: m[1] as PhotoAction, photoId: m[2]! } : null;
}

/** Короткий идентификатор фото для показа — полный UUID в сообщениях не нужен. */
export function shortPhotoId(id: string): string {
  return id.slice(0, 8);
}

// ---------- Отображение галереи (без URL и токенов) ----------

export interface BotPhoto {
  id: string;
  url: string;
  sort_order: number;
  is_main: boolean;
  created_at?: string;
}

/** Текст галереи: до 10 записей, только короткие id и отметки — без URL и любых токенов. */
export function galleryText(p: Pick<BotProduct, "title" | "sku">, photos: BotPhoto[]): string {
  const lines = [`Фото товара: ${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`, ""];
  if (photos.length === 0) {
    lines.push("Фотографий пока нет.");
  } else {
    photos.slice(0, PHOTO_LIST_LIMIT).forEach((ph, i) => {
      lines.push(`${i + 1}. ${ph.is_main ? "⭐ основное" : "🖼"} · #${shortPhotoId(ph.id)}`);
    });
    lines.push("");
    lines.push(
      `Всего: ${photos.length}.` +
        (photos.length > PHOTO_LIST_LIMIT
          ? ` Показаны первые ${PHOTO_LIST_LIMIT} — управлять можно ими.`
          : ""),
    );
  }
  lines.push("");
  lines.push("Нажмите номер фото для действий: основное, порядок, обратимое удаление.");
  return lines.join("\n");
}

export function photoDetailText(
  p: Pick<BotProduct, "title" | "sku">,
  ph: BotPhoto,
  index: number,
  total: number,
): string {
  return [
    `Фото №${index + 1} из ${total}`,
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Идентификатор: #${shortPhotoId(ph.id)}`,
    ph.is_main ? "⭐ Это основное фото (показывается в витрине первым)." : "Обычное фото галереи.",
    "",
    "Выберите действие:",
  ].join("\n");
}

/** Кнопки галереи: до 10 фото, «добавить» (заблокировано), назад к карточке. */
export function photoRows(productId: string, photos: BotPhoto[], canManage: boolean): BtnRows {
  const rows: BtnRows = [];
  const listed = photos.slice(0, PHOTO_LIST_LIMIT);
  for (let i = 0; i < listed.length; i += 4) {
    rows.push(
      listed.slice(i, i + 4).map((ph, j) => ({
        text: `${i + j + 1}${ph.is_main ? "⭐" : "🖼"}`,
        callback_data: photoDetailCallback(ph.id),
      })),
    );
  }
  if (canManage)
    rows.push([{ text: "➕ Добавить фото", callback_data: photoAddCallback(productId) }]);
  rows.push([{ text: "⬅️ К карточке", callback_data: makeCallback(`prd:${productId}`) }]);
  return rows;
}

// ---------- Предпросмотры действий ----------

export function photoMainPreviewText(
  p: Pick<BotProduct, "title" | "sku">,
  ph: BotPhoto,
  index: number,
): string {
  return [
    "Сделать это фото основным?",
    "",
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Фото №${index + 1} · #${shortPhotoId(ph.id)}`,
    "Основное фото показывается в витрине первым; прежнее основное останется в галерее.",
    "",
    "Подтвердите действие:",
  ].join("\n");
}

export function photoReorderPreviewText(
  p: Pick<BotProduct, "title" | "sku">,
  ph: BotPhoto,
  fromIndex: number,
  toIndex: number,
): string {
  return [
    "Изменить порядок фото?",
    "",
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Фото #${shortPhotoId(ph.id)}: №${fromIndex + 1} → №${toIndex + 1}`,
    "",
    "Подтвердите действие:",
  ].join("\n");
}

export function photoDeletePreviewText(
  p: Pick<BotProduct, "title" | "sku">,
  ph: BotPhoto,
  index: number,
): string {
  return [
    "Удалить фото из галереи?",
    "",
    `${p.title}${p.sku ? ` (SKU ${p.sku})` : ""}`,
    `Фото №${index + 1} · #${shortPhotoId(ph.id)}`,
    "Удаление обратимое: фото исчезнет из витрины, файл сохраняется в карантине.",
    "Основное фото при необходимости будет переназначено.",
    "",
    "Подтвердите действие:",
  ].join("\n");
}

// ---------- Адаптер получения байтов из Telegram (для будущей загрузки) ----------

export interface FetchedTelegramPhoto {
  bytes: Uint8Array;
  declaredMime: string | null;
  fileName: string | null;
}

/**
 * Интерфейс получения файла из Telegram по file_id.
 * Реальная реализация возможна только если gateway отдаёт бинарные файлы
 * (getFile → /file/<path>); это НЕ проверено вживую в этом проекте.
 */
export interface TelegramPhotoFetcher {
  fetchPhotoBytes(fileId: string): Promise<FetchedTelegramPhoto | null>;
}

/**
 * Флаг живой проверки: подтверждено ли, что Lovable Telegram gateway
 * возвращает бинарное содержимое файлов. До включения (false) все попытки
 * добавления фото отвечают честным отказом — fail closed.
 * Включение: только после ручной проверки getFile + /file/<path> на живом боте,
 * с проверкой HTTP-статуса и содержимого ответа.
 */
export const TELEGRAM_PHOTO_UPLOAD_VERIFIED = false;

export const PHOTO_UPLOAD_NOT_CONNECTED_MSG =
  "Загрузка из Telegram пока не подключена. Галерею можно просмотреть и управлять существующими фото: карточка товара → «🖼 Фото».";
