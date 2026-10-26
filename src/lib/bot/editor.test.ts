import { describe, expect, it } from "vitest";
import {
  canPublish,
  categoryChoiceCallback,
  checkEditorState,
  draftPreviewText,
  draftStepPrompt,
  editCategoryCallback,
  editCategoryPreviewText,
  editFieldCallback,
  editFieldPreviewText,
  editMenuCallback,
  editMenuRows,
  editStatusCallback,
  editStatusPreviewText,
  EDITOR_FIELD_LABEL,
  EDITOR_STATE_REASON_MSG,
  parseStatusInput,
  rollbackCallback,
  setChoiceCallback,
  setChoiceParse,
  slugBase,
  statusChoiceCallback,
  validateEditorValue,
  type EditorStateRow,
} from "./editor";
import { callbackBytes, type BotProduct } from "./catalog";

const UUID_A = "11111111-1111-1111-1111-111111111111";

const p = (over: Partial<BotProduct> = {}): BotProduct => ({
  id: UUID_A,
  slug: "gorelka-tig-26",
  title: "Горелка TIG-26",
  brand: "MasterWeld",
  sku: "MW-123",
  price: 4500,
  old_price: null,
  in_stock: true,
  stock_qty: null,
  status: "published",
  category_id: "22222222-2222-2222-2222-222222222222",
  description: "Описание",
  specs: "Характеристики",
  ...over,
});

describe("валидация текстовых полей", () => {
  it("название: границы 3–300", () => {
    expect(validateEditorValue("title", "  ab  ").ok).toBe(false);
    expect(validateEditorValue("title", "abc").ok).toBe(true);
    expect(validateEditorValue("title", "x".repeat(300)).ok).toBe(true);
    expect(validateEditorValue("title", "x".repeat(301)).ok).toBe(false);
  });
  it("название нормализуется: пробелы сжимаются, края обрезаются", () => {
    const v = validateEditorValue("title", "  Новая   горелка  ");
    expect(v.ok && v.value).toBe("Новая горелка");
  });
  it("описание/характеристики: до 5000, пустое очищает поле", () => {
    expect(validateEditorValue("description", "").value).toBe(null);
    expect(validateEditorValue("description", "x".repeat(5000)).ok).toBe(true);
    expect(validateEditorValue("description", "x".repeat(5001)).ok).toBe(false);
    expect(validateEditorValue("specs", "").value).toBe(null);
  });
  it("бренд: до 100, пустое очищает", () => {
    expect(validateEditorValue("brand", "").value).toBe(null);
    expect(validateEditorValue("brand", "x".repeat(100)).ok).toBe(true);
    expect(validateEditorValue("brand", "x".repeat(101)).ok).toBe(false);
  });
  it("артикул: 1–60, без пробелов, допустимые символы; пустое очищает", () => {
    expect(validateEditorValue("sku", "").value).toBe(null);
    expect(validateEditorValue("sku", "MW-123/4+5_6.7").ok).toBe(true);
    expect(validateEditorValue("sku", "MW 123").ok).toBe(false);
    expect(validateEditorValue("sku", "x".repeat(60)).ok).toBe(true);
    expect(validateEditorValue("sku", "x".repeat(61)).ok).toBe(false);
    expect(validateEditorValue("sku", "МВ-№1").ok).toBe(false);
  });
});

describe("slug для новых черновиков", () => {
  it("транслитерация и нормализация", () => {
    expect(slugBase("Горелка TIG-26 с кабелем")).toBe("gorelka-tig-26-s-kabelem");
    expect(slugBase("Щётка «Мастер»")).toBe("schetka-master");
    expect(slugBase("Ёж-2026")).toBe("ezh-2026");
  });
  it("пустое/служебное название даёт запасной slug", () => {
    expect(slugBase("!!!")).toBe("tovar");
    expect(slugBase("")).toBe("tovar");
  });
  it("не заканчивается дефисом и не длиннее 80", () => {
    const s = slugBase("a".repeat(200));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("обязательные данные перед публикацией", () => {
  it("название, цена > 0 и фото обязательны", () => {
    expect(canPublish(p(), 1).ok).toBe(true);
    expect(canPublish(p({ title: "ab" }), 1).missing).toContain("название");
    expect(canPublish(p({ price: 0 }), 1).missing).toContain("цена больше нуля");
    expect(canPublish(p(), 0).missing).toContain("хотя бы одно фото");
  });
  it("предпросмотр публикации без обязательных данных — отказ, а не подтверждение", () => {
    const text = editStatusPreviewText(p({ price: 0 }), "черновик", "published", [
      "цена больше нуля",
    ]);
    expect(text).toContain("Публикация невозможна");
    expect(text).not.toContain("Подтвердите действие");
  });
});

describe("статусы", () => {
  it("распознаёт русские варианты", () => {
    expect(parseStatusInput("витрина")).toBe("published");
    expect(parseStatusInput("Опубликовать")).toBe("published");
    expect(parseStatusInput("черновик")).toBe("draft");
    expect(parseStatusInput("скрыть")).toBe("hidden");
    expect(parseStatusInput("скрытый")).toBe("hidden");
    expect(parseStatusInput("мусор")).toBe(undefined);
  });
});

describe("callback редактора: лимит 64 байта", () => {
  it("все callback укладываются в лимит", () => {
    const cbs = [
      editMenuCallback(UUID_A),
      editFieldCallback("title", UUID_A),
      editFieldCallback("description", UUID_A),
      editCategoryCallback(UUID_A),
      editStatusCallback(UUID_A),
      statusChoiceCallback(UUID_A, "published"),
      setChoiceCallback("description", UUID_A),
      categoryChoiceCallback(39),
      rollbackCallback(UUID_A),
    ];
    for (const cb of cbs) expect(callbackBytes(cb)).toBeLessThanOrEqual(64);
  });
  it("esp-выбор товара разбирается обратно", () => {
    const cb = setChoiceCallback("brand", UUID_A);
    expect(setChoiceParse(cb)).toEqual({ field: "brand", productId: UUID_A });
    expect(setChoiceParse("esp:unknown:" + UUID_A)).toBe(null);
  });
});

describe("меню редактора: кнопки по правам", () => {
  it("без прав — только возврат к карточке", () => {
    const rows = editMenuRows(p(), {
      canEditText: false,
      canManageCategories: false,
      canPublish: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]!.callback_data).toBe(`prd:${UUID_A}`);
  });
  it("продавец с edit_products — текстовые кнопки, без раздела и статуса", () => {
    const rows = editMenuRows(p(), {
      canEditText: true,
      canManageCategories: false,
      canPublish: false,
    });
    const all = rows.flat().map((b) => b.callback_data);
    expect(all).toContain(editFieldCallback("title", UUID_A));
    expect(all).toContain(editFieldCallback("sku", UUID_A));
    expect(all.some((c) => c.startsWith("et:cat:"))).toBe(false);
    expect(all.some((c) => c.startsWith("et:st:"))).toBe(false);
  });
  it("админ видит все действия", () => {
    const rows = editMenuRows(p(), {
      canEditText: true,
      canManageCategories: true,
      canPublish: true,
    });
    const all = rows.flat().map((b) => b.callback_data);
    expect(all).toContain(editCategoryCallback(UUID_A));
    expect(all).toContain(editStatusCallback(UUID_A));
  });
});

describe("предпросмотры текстовых правок", () => {
  it("название: было → станет", () => {
    const text = editFieldPreviewText("title", p(), "Новая горелка");
    expect(text).toContain("Изменить название");
    expect(text).toContain("Было: Горелка TIG-26");
    expect(text).toContain("Станет: Новая горелка");
    expect(text).toContain("Подтвердите действие");
  });
  it("очистка поля показывается как «—»", () => {
    const text = editFieldPreviewText("brand", p(), null);
    expect(text).toContain("Станет: —");
  });
  it("перенос в раздел: было → станет", () => {
    const text = editCategoryPreviewText(p(), "Горелки", "Расходники");
    expect(text).toContain("Было: Горелки");
    expect(text).toContain("Станет: Расходники");
  });
});

describe("состояния диалога: TTL и одноразовость", () => {
  const now = 1_000_000_000_000;
  const st = (over: Partial<EditorStateRow> = {}): EditorStateRow => ({
    staff_telegram_id: 42,
    state: "new_title",
    data: {},
    product_id: null,
    expires_at: new Date(now + 60_000).toISOString(),
    consumed_at: null,
    ...over,
  });
  it("свежее состояние владельца — можно", () => {
    expect(checkEditorState(st(), 42, now)).toEqual({ ok: true });
  });
  it("чужое состояние — отказ", () => {
    expect(checkEditorState(st(), 43, now)).toEqual({ ok: false, reason: "not_owner" });
  });
  it("истечение TTL — отказ, на каждый отказ есть сообщение", () => {
    expect(checkEditorState(st(), 42, now + 60_000)).toEqual({ ok: false, reason: "expired" });
    for (const r of ["not_found", "not_owner", "expired", "consumed"])
      expect(EDITOR_STATE_REASON_MSG[r]).toBeTruthy();
  });
  it("использованное состояние повторно не принимается", () => {
    expect(checkEditorState(st({ consumed_at: new Date(now).toISOString() }), 42, now)).toEqual({
      ok: false,
      reason: "consumed",
    });
  });
  it("битый expires_at считается истёкшим", () => {
    expect(checkEditorState(st({ expires_at: "не-дата" }), 42, now)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("диалог нового черновика", () => {
  it("подсказки шагов понятны и с отменой", () => {
    for (const s of ["new_title", "new_sku", "new_price"] as const) {
      const text = draftStepPrompt(s);
      expect(text.length).toBeGreaterThan(20);
      expect(text).toContain("/cancel");
    }
  });
  it("предпросмотр: только черновик, slug и предупреждение о source_url", () => {
    const text = draftPreviewText(
      { title: "Новая горелка", sku: "MW-999", price: 14990 },
      "novaya-gorelka",
    );
    expect(text).toContain("черновик");
    expect(text).toContain("novaya-gorelka");
    expect(text).toContain("source_url");
    expect(text).toContain("Подтвердите создание");
  });
});

describe("неприкосновенные поля", () => {
  it("slug и source_url никогда не входят в редактируемые поля", () => {
    const fields = Object.keys(EDITOR_FIELD_LABEL);
    expect(fields).toEqual(["title", "description", "specs", "brand", "sku"]);
    expect(fields).not.toContain("slug");
    expect(fields).not.toContain("source_url");
    expect(fields).not.toContain("id");
  });
});
