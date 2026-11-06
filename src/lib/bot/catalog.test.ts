import { describe, expect, it } from "vitest";
import {
  buildBotList,
  buildCatalogSummary,
  buildMutationChoice,
  buildProductCardBot,
  callbackBytes,
  CB_LIMIT_BYTES,
  findCallback,
  isPrivateChat,
  makeCallback,
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
import { can, type StaffMember } from "./permissions";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const p = (over: Partial<BotProduct> = {}): BotProduct => ({
  id: UUID_A,
  slug: "tig-26-gorelka",
  title: "Горелка TIG-26 с кабелем",
  brand: "FoxWeld",
  sku: "MW-123",
  price: 4500,
  old_price: null,
  in_stock: true,
  stock_qty: null,
  status: "published",
  category_id: null,
  ...over,
});

const staff = (role: StaffMember["role"], elevated = false, active = true): StaffMember => ({
  telegram_id: 42,
  name: "Тест",
  role,
  elevated,
  active,
});

describe("поиск в боте", () => {
  it("находит по точному SKU", () => {
    const r = searchBotProducts([p(), p({ id: UUID_B, sku: "MW-999", title: "Другое" })], "mw-123");
    expect(r.total).toBe(1);
    expect(r.items[0]!.id).toBe(UUID_A);
  });

  it("находит по словам названия с нормализацией (регистр, ё/е, тире, пробелы)", () => {
    const items = [p(), p({ id: UUID_B, title: "Маска сварщика ПЁЛ-1", sku: null, brand: null })];
    expect(searchBotProducts(items, "горелка  TIG-26").total).toBe(1);
    expect(searchBotProducts(items, "пел 1").total).toBe(1);
    expect(searchBotProducts(items, "МАСКА").total).toBe(1);
  });

  it("находит по бренду", () => {
    const items = [p(), p({ id: UUID_B, title: "Аппарат", brand: "Ресанта", sku: null })];
    expect(searchBotProducts(items, "ресанта").total).toBe(1);
  });

  it("неоднозначный SKU: два товара с одинаковым SKU дают список, не авто-выбор", () => {
    const items = [p(), p({ id: UUID_B, sku: "MW-123", title: "Горелка TIG-26 (новая)" })];
    const r = searchBotProducts(items, "MW-123");
    expect(r.total).toBe(2);
    expect(r.ambiguousSku).toBe(true);
    const resolved = resolveSingleProduct(items, "MW-123");
    expect(resolved.kind).toBe("ambiguous");
  });

  it("resolveSingleProduct: одно совпадение — товар, ноль — отказ", () => {
    const one = resolveSingleProduct([p(), p({ id: UUID_B, sku: "X" })], "mw-123");
    expect(one).toEqual({ kind: "one", product: p() });
    expect(resolveSingleProduct([p()], "нет-такого").kind).toBe("none");
  });

  it("пагинация: 25 совпадений — 3 страницы по 10", () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      p({
        id: `${UUID_A.slice(0, -2)}${String(i).padStart(2, "0")}`,
        title: `Горелка ${i}`,
        sku: null,
        brand: null,
      }),
    );
    const r0 = searchBotProducts(items, "горелка", 0);
    expect(r0.pages).toBe(3);
    expect(r0.items.length).toBe(10);
    const r2 = searchBotProducts(items, "горелка", 2);
    expect(r2.items.length).toBe(5);
    const r9 = searchBotProducts(items, "горелка", 9);
    expect(r9.page).toBe(2); // страница зажимается в диапазон
  });

  it("все callback_data в списках укладываются в 64 байта", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      p({
        id: `${UUID_A.slice(0, -2)}${String(i).padStart(2, "0")}`,
        title: `Очень длинное название товара номер ${i} для проверки лимита кнопок`,
      }),
    );
    const { rows } = buildBotList(items, 0, "Тест", (pg) => `cat:${pg}`);
    for (const row of rows) {
      for (const btn of row) {
        expect(callbackBytes(btn.callback_data)).toBeLessThanOrEqual(CB_LIMIT_BYTES);
      }
    }
    // Длинный запрос не влезает в callback пагинации — пагинация отключается.
    expect(findCallback(1, "о".repeat(100))).toBeNull();
    const short = findCallback(2, "tig 26");
    expect(short).not.toBeNull();
    expect(parseFindCallback(short!)).toEqual({ page: 2, query: "tig 26" });
    expect(parseFindCallback("cat:0")).toBeNull();
  });

  it("makeCallback отклоняет слишком длинные данные", () => {
    expect(makeCallback("prd:" + UUID_A)).toBe(`prd:${UUID_A}`);
    expect(() => makeCallback("x".repeat(65))).toThrow();
  });
});

describe("карточка товара", () => {
  it("содержит артикул, бренд, статус, наличие, категорию, фото без технического UUID", () => {
    const { text } = buildProductCardBot(p(), { categoryName: "Горелки", photoCount: 3 });
    expect(text).not.toContain(UUID_A);
    expect(text).toContain("Артикул: MW-123");
    expect(text).toContain("Бренд: FoxWeld");
    expect(text).toContain("Статус: на витрине");
    expect(text).toContain("Наличие: Отмечено в наличии");
    expect(text).toContain("Категория: Горелки");
    expect(text).toContain("Фото: 3");
  });

  it("скидка только при old_price > price", () => {
    expect(buildProductCardBot(p({ old_price: 5000 })).text).toContain("снижена с");
    expect(buildProductCardBot(p({ old_price: 4000 })).text).not.toContain("снижена");
    expect(buildProductCardBot(p({ old_price: 4500 })).text).not.toContain("снижена");
  });

  it("кнопки изменения только при правах; закупочные цены нигде не выводятся", () => {
    const withRights = buildProductCardBot(p(), { canEditPrice: true, canEditStock: true });
    const flat = withRights.rows.flat().map((b) => b.callback_data);
    expect(flat).toContain(`pp:${UUID_A}`);
    expect(flat).toContain(`ps:${UUID_A}`);
    const noRights = buildProductCardBot(p(), { canEditPrice: false, canEditStock: false });
    expect(noRights.rows.flat().some((b) => b.callback_data.startsWith("pp:"))).toBe(false);
    expect(withRights.text.toLowerCase()).not.toContain("закуп");
  });

  it("наличие без обещаний остатка: stock_qty не выводится", () => {
    const { text } = buildProductCardBot(p({ stock_qty: 15, in_stock: false }));
    expect(text).toContain("Наличие: Под заказ");
    expect(text).not.toContain("15");
  });
});

describe("сводка каталога", () => {
  it("считает фактические published/draft/hidden и пометки наличия", () => {
    const items = [
      p({ status: "published", in_stock: true }),
      p({ id: UUID_B, status: "published", in_stock: false }),
      p({ status: "draft" }),
      p({ status: "hidden" }),
    ];
    const text = buildCatalogSummary(items);
    expect(text).toContain("на витрине: 2");
    expect(text).toContain("черновики: 1");
    expect(text).toContain("скрытые: 1");
    expect(text).toContain("отмечены в наличии: 3");
    expect(text).toContain("под заказ: 1");
    expect(text).toContain("Точные остатки склада не отслеживаются");
  });
});

describe("парсеры", () => {
  it("цена: разумные значения до 2 знаков", () => {
    expect(parseBotPrice("1250")).toBe(1250);
    expect(parseBotPrice("1 250,50")).toBe(1250.5);
    expect(parseBotPrice("1250.5")).toBe(1250.5);
    expect(parseBotPrice("9999999.99")).toBe(9999999.99);
  });

  it("цена: 0, отрицательные, 3 знака и мусор отклоняются", () => {
    expect(parseBotPrice("0")).toBeUndefined();
    expect(parseBotPrice("-5")).toBeUndefined();
    expect(parseBotPrice("1.234")).toBeUndefined();
    expect(parseBotPrice("10 000 001")).toBeUndefined();
    expect(parseBotPrice("abc")).toBeUndefined();
    expect(parseBotPrice("12a")).toBeUndefined();
    expect(parseBotPrice(undefined)).toBeUndefined();
    expect(parseBotPrice("")).toBeUndefined();
  });

  it("пометка наличия: есть / под_заказ и варианты", () => {
    expect(parseStockInput("есть")).toBe(true);
    expect(parseStockInput("В наличии")).toBe(true);
    expect(parseStockInput("под_заказ")).toBe(false);
    expect(parseStockInput("под заказ")).toBe(false);
    expect(parseStockInput("может быть")).toBeUndefined();
    expect(parseStockInput(undefined)).toBeUndefined();
  });
});

describe("приватность и RBAC", () => {
  it("служебные данные только в личном чате сотрудника", () => {
    expect(isPrivateChat({ id: 42, type: "private" }, { id: 42 })).toBe(true);
    expect(isPrivateChat({ id: -1002632977406, type: "group" }, { id: 42 })).toBe(false);
    expect(isPrivateChat({ id: 99, type: "private" }, { id: 42 })).toBe(false);
    expect(isPrivateChat(null, { id: 42 })).toBe(false);
  });

  it("цена: продавец не может, директор и админ могут", () => {
    expect(can(staff("seller"), "edit_prices")).toBe(false);
    expect(can(staff("director"), "edit_prices")).toBe(true);
    expect(can(staff("admin"), "edit_prices")).toBe(true);
  });

  it("наличие: все активные роли могут, неактивный — нет", () => {
    expect(can(staff("seller"), "edit_stock")).toBe(true);
    expect(can(staff("director"), "edit_stock")).toBe(true);
    expect(can(staff("admin"), "edit_stock")).toBe(true);
    expect(can(staff("seller", false, false), "edit_stock")).toBe(false);
  });
});

describe("предпросмотр и выбор товара", () => {
  it("предпросмотр цены: было → станет", () => {
    const text = pricePreviewText(p({ price: 4500 }), 4900);
    expect(text).toContain("Было: 4 500 ₽");
    expect(text).toContain("Станет: 4 900 ₽");
  });

  it("предпросмотр наличия: было → станет", () => {
    const text = stockPreviewText(p({ in_stock: false }), true);
    expect(text).toContain("Было: Под заказ");
    expect(text).toContain("Станет: Отмечено в наличии");
  });

  it("список выбора при дублях SKU: у каждой кнопки свой товар и значение", () => {
    const items = [p(), p({ id: UUID_B, sku: "MW-123" })];
    const { rows } = buildMutationChoice(items, "Изменение цены", (x) =>
      priceChoiceCallback(x, 4900),
    );
    expect(rows.length).toBe(2);
    expect(rows[0]![0]!.callback_data).toBe(`pxp:${UUID_A}:p490000`);
    expect(rows[1]![0]!.callback_data).toBe(`pxp:${UUID_B}:p490000`);
    expect(callbackBytes(rows[1]![0]!.callback_data)).toBeLessThanOrEqual(CB_LIMIT_BYTES);
    const stock = buildMutationChoice(items, "Изменение наличия", (x) =>
      stockChoiceCallback(x, true),
    );
    expect(stock.rows[0]![0]!.callback_data).toBe(`pxs:${UUID_A}:s1`);
  });
});
