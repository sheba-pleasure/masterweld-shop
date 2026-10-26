import { describe, expect, it } from "vitest";
import {
  galleryText,
  hashBytes,
  isSafePhotoUrl,
  MAX_PHOTO_BYTES,
  parsePhotoDetailCallback,
  PHOTO_UPLOAD_NOT_CONNECTED_MSG,
  photoAddCallback,
  photoDeletePreviewText,
  photoDetailCallback,
  photoDetailText,
  photoMainPreviewText,
  photoMenuCallback,
  photoReorderPreviewText,
  photoRows,
  sniffImageMime,
  TELEGRAM_PHOTO_UPLOAD_VERIFIED,
  validatePhotoBytes,
  type BotPhoto,
} from "./photos";
import { callbackBytes } from "./catalog";
import { can, PENDING_PERMISSION_PHOTO_KINDS } from "./permissions";
import type { StaffMember } from "./permissions";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);

const UUID_A = "11111111-1111-1111-1111-111111111111";
const PH = (over: Partial<BotPhoto> = {}): BotPhoto => ({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000",
  url: "https://cdn.example.com/photo.jpg",
  sort_order: 0,
  is_main: true,
  ...over,
});

describe("валидация изображений: сигнатура и MIME", () => {
  it("распознаёт JPEG/PNG/WebP по magic bytes", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });
  it("отклоняет текст, пустые и обрезанные данные", () => {
    expect(sniffImageMime(new Uint8Array([]))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("не картинка"))).toBeNull();
    expect(sniffImageMime(JPEG.slice(0, 2))).toBeNull();
    expect(sniffImageMime(PNG.slice(0, 7))).toBeNull();
  });
  it("валидный JPEG проходит; заявленный image/jpg нормализуется", () => {
    expect(validatePhotoBytes(JPEG, "image/jpg")).toEqual({
      ok: true,
      mime: "image/jpeg",
      size: JPEG.length,
    });
  });
  it("несовпадение заявленного MIME с содержимым отклоняется", () => {
    const r = validatePhotoBytes(PNG, "image/jpeg");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("не совпадает");
  });
  it("без заявленного MIME решает только сигнатура", () => {
    expect(validatePhotoBytes(WEBP, null).ok).toBe(true);
  });
  it("пустой файл и файл больше 5 МБ отклоняются", () => {
    expect(validatePhotoBytes(new Uint8Array([]), null).ok).toBe(false);
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set(JPEG);
    const r = validatePhotoBytes(big, "image/jpeg");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("5 МБ");
  });
});

describe("хэш против дублей", () => {
  it("одинаковые байты — одинаковый SHA-256, разные — разный", async () => {
    const h1 = await hashBytes(JPEG);
    const h2 = await hashBytes(JPEG);
    const h3 = await hashBytes(PNG);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("безопасность URL фотографии", () => {
  it("нормальные https-адреса допустимы", () => {
    expect(isSafePhotoUrl("https://cdn.example.com/a.jpg")).toBe(true);
    expect(isSafePhotoUrl("https://shop.masterweld.ru/storage/v1/object/public/x.png")).toBe(true);
  });
  it("http, data: и мусор отклоняются", () => {
    expect(isSafePhotoUrl("http://cdn.example.com/a.jpg")).toBe(false);
    expect(isSafePhotoUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafePhotoUrl("ftp://x/a.jpg")).toBe(false);
    expect(isSafePhotoUrl("")).toBe(false);
    expect(isSafePhotoUrl(null)).toBe(false);
    expect(isSafePhotoUrl("не url")).toBe(false);
  });
  it("внутренние и локальные адреса отклоняются", () => {
    for (const u of [
      "https://localhost/a.jpg",
      "https://127.0.0.1/a.jpg",
      "https://10.0.0.5/a.jpg",
      "https://192.168.1.5/a.jpg",
      "https://172.16.0.1/a.jpg",
      "https://172.31.255.1/a.jpg",
      "https://169.254.1.1/a.jpg",
      "https://100.64.0.1/a.jpg",
      "https://host.internal/a.jpg",
      "https://x.local/a.jpg",
      "https://[::1]/a.jpg",
    ])
      expect(isSafePhotoUrl(u)).toBe(false);
    expect(isSafePhotoUrl("https://172.32.0.1/a.jpg")).toBe(true); // вне 172.16/12
  });
  it("учётные данные в URL и логин-адреса Telegram отклоняются", () => {
    expect(isSafePhotoUrl("https://user:pass@cdn.example.com/a.jpg")).toBe(false);
    expect(isSafePhotoUrl("https://api.telegram.org/file/botTOKEN/a.jpg")).toBe(false);
    expect(isSafePhotoUrl("https://t.me/a.jpg")).toBe(false);
  });
});

describe("callback фото: лимит 64 байта и парсинг", () => {
  it("все callback фото укладываются в 64 байта", () => {
    for (const cb of [
      photoMenuCallback(UUID_A),
      photoAddCallback(UUID_A),
      photoDetailCallback(UUID_A, 0),
      photoDetailCallback(UUID_A, 99),
    ])
      expect(callbackBytes(cb)).toBeLessThanOrEqual(64);
  });
  it("parsePhotoDetailCallback: валидный и битый ввод", () => {
    expect(parsePhotoDetailCallback(photoDetailCallback(UUID_A, 7))).toEqual({
      productId: UUID_A,
      index: 7,
    });
    expect(parsePhotoDetailCallback("phd:not-a-uuid:1")).toBeNull();
    expect(parsePhotoDetailCallback("phd:11111111-1111-1111-1111-111111111111:1000")).toBeNull();
    expect(parsePhotoDetailCallback("phd:11111111-1111-1111-1111-111111111111")).toBeNull();
  });
});

describe("отображение галереи: без URL и токенов", () => {
  const p = { title: "Горелка TIG-26", sku: "MW-123" };
  it("список до 10, основное отмечено, полные id и URL не показываются", () => {
    const photos = Array.from({ length: 14 }, (_, i) =>
      PH({ id: `aaaaaaaa-bbbb-cccc-dddd-eeeeffff000${i}`, sort_order: i, is_main: i === 0 }),
    );
    const text = galleryText(p, photos);
    expect(text).not.toContain("http");
    expect(text).not.toContain("cdn.example.com");
    expect(text).not.toContain("aaaaaaaa-bbbb");
    expect(text).toContain("⭐ основное");
    expect(text).toContain("Всего: 14");
    expect(text).toContain("Показаны первые 10");
    expect(text.split("\n").filter((l) => /^\d+\. /.test(l)).length).toBe(10);
  });
  it("пустая галерея — понятный текст", () => {
    expect(galleryText(p, [])).toContain("Фотографий пока нет");
  });
  it("кнопки: по 4 в ряд, «добавить» только при праве, назад к карточке", () => {
    const photos = Array.from({ length: 6 }, (_, i) =>
      PH({ id: `${i}`.repeat(8), is_main: i === 0 }),
    );
    const withRights = photoRows(UUID_A, photos, true);
    const flat = withRights.flat();
    expect(flat.some((b) => b.text.includes("Добавить"))).toBe(true);
    expect(flat[flat.length - 1]!.callback_data).toBe(`prd:${UUID_A}`);
    const noRights = photoRows(UUID_A, photos, false);
    expect(noRights.flat().some((b) => b.text.includes("Добавить"))).toBe(false);
  });
});

describe("предпросмотры действий с фото", () => {
  const p = { title: "Горелка TIG-26", sku: "MW-123" };
  it("основное: понятный предпросмотр с подтверждением", () => {
    const t = photoMainPreviewText(p, PH(), 2);
    expect(t).toContain("Сделать это фото основным");
    expect(t).toContain("Фото №3");
    expect(t).toContain("Подтвердите действие");
  });
  it("порядок: было → станет", () => {
    const t = photoReorderPreviewText(p, PH({ is_main: false }), 2, 1);
    expect(t).toContain("№3 → №2");
  });
  it("удаление: обратимое, файл в карантине, без «полного удаления»", () => {
    const t = photoDeletePreviewText(p, PH({ is_main: false }), 0);
    expect(t).toContain("обратимое");
    expect(t).toContain("карантин");
    expect(t).not.toContain("навсегда");
  });
  it("детали фото: без URL и полного id", () => {
    const t = photoDetailText(p, PH(), 0, 3);
    expect(t).not.toContain("http");
    expect(t).not.toContain("aaaaaaaa-bbbb");
    expect(t).toContain("основное");
  });
});

describe("RBAC фото-действий: upload_photos", () => {
  const m = (role: StaffMember["role"], elevated = false): StaffMember => ({
    telegram_id: 1,
    name: "X",
    role,
    elevated,
    active: true,
  });
  it("photo-действия требуют upload_photos", () => {
    for (const k of ["photo_main", "photo_reorder", "photo_delete"] as const)
      expect(PENDING_PERMISSION_PHOTO_KINDS[k]).toBe("upload_photos");
  });
  it("продавец может управлять фото; директор в простом режиме — нет; админ — да", () => {
    expect(can(m("seller"), "upload_photos")).toBe(true);
    expect(can(m("director"), "upload_photos")).toBe(false);
    expect(can(m("director", true), "upload_photos")).toBe(true);
    expect(can(m("admin"), "upload_photos")).toBe(true);
  });
});

describe("загрузка из Telegram: fail closed", () => {
  it("живая проверка gateway не подтверждена — флаг false", () => {
    expect(TELEGRAM_PHOTO_UPLOAD_VERIFIED).toBe(false);
  });
  it("честное сообщение вместо ложного успеха", () => {
    expect(PHOTO_UPLOAD_NOT_CONNECTED_MSG).toContain("не подключена");
  });
});
