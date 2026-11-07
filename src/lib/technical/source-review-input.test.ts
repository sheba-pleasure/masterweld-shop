import { describe, expect, it } from "vitest";
import dictionary from "./dictionary";
import {
  parseSourceFactAnswer as answer,
  sourceFactInputFields,
  sourceFactQuestion,
} from "./source-review-input";

const family = "power_mma";
const current = "mma_current_max_a";
const duty = "mma_duty_cycle_pct";

describe("Questions for human review of source facts", () => {
  it("Reads decimal commas without unit conversion or OCR repair", () => {
    expect(answer(family, current, "value", " 160,5 ")).toBe(160.5);
    for (const value of ["160 А", "0.16 кА", "1 600", "16О", "160–200", "", "Нет данных"]) {
      expect(() => answer(family, current, "value", value)).toThrow();
    }
  });
  it("Keeps technical bounds and rejects wrong family mappings", () => {
    expect(() => answer(family, duty, "value", "101")).toThrow();
    expect(() => answer(family, duty, "value", "-1")).toThrow();
    expect(() => answer("does_not_exist", current, "value", "160")).toThrow();
    expect(() => answer(family, null, "value", "160")).toThrow("Сначала выберите");
    expect(() => answer(family, null, "current_a", "160")).toThrow("Сначала выберите");
  });
  it("Never treats missing or ambiguous data as false", () => {
    const attr = dictionary.attributes.find((item) => item.kind === "boolean")!;
    const binding = dictionary.bindings.find((item) => item.attribute_code === attr.code)!;
    expect(answer(binding.family_code, attr.code, "value", "Да")).toBe(true);
    expect(answer(binding.family_code, attr.code, "value", "Нет")).toBe(false);
    for (const value of ["0", "—", "Неизвестно", "?"]) {
      expect(() => answer(binding.family_code, attr.code, "value", value)).toThrow();
    }
  });
  it("Distinguishes decimal commas and list separators", () => {
    const attr = dictionary.attributes.find((item) => item.kind === "number_list")!;
    const binding = dictionary.bindings.find((item) => item.attribute_code === attr.code)!;
    expect(answer(binding.family_code, attr.code, "value", "0,8; 1,0")).toEqual([0.8, 1]);
    expect(() => answer(binding.family_code, attr.code, "value", "0,8, 1,0")).toThrow();
    expect(() => answer(binding.family_code, attr.code, "value", "1; 1,0")).toThrow();
  });
  it("Preserves a literal designation and constraints", () => {
    const attr = dictionary.attributes.find((item) => item.kind === "text")!;
    const binding = dictionary.bindings.find((item) => item.attribute_code === attr.code)!;
    const text = "ISO 2560-A: E 42 4 B 42 H5; Только DC+";
    expect(answer(binding.family_code, attr.code, "value", text)).toBe(text);
  });
  it("Accepts conditions separately without inventing defaults", () => {
    expect(answer(family, duty, "current_a", "160")).toBe(160);
    expect(answer(family, duty, "temperature_c", "-20,5")).toBe(-20.5);
    expect(answer(family, duty, "gas", "Ar + 18 % CO2")).toBe("Ar + 18 % CO2");
    expect(answer(family, duty, "cooling", " Воздушное ")).toBe("air");
    expect(answer(family, duty, "cooling", "ЖИДКОСТНОЕ")).toBe("liquid");
    for (const [field, value] of [
      ["current_a", "-1"],
      ["current_a", "1000001"],
      ["temperature_c", "-101"],
      ["pressure_bar", "0"],
      ["diameter_mm", "0"],
      ["duty_pct", "101"],
      ["gas", ""],
      ["cooling", "Вроде воздушное"],
    ] as const) {
      expect(() => answer(family, duty, field, value)).toThrow();
    }
  });
  it("Does not infer the publisher or source location from the product", () => {
    expect(answer(family, null, "publisher", " Учебная организация ")).toBe("Учебная организация");
    expect(answer(family, null, "locator", "Стр. 7, таблица 2")).toBe("Стр. 7, таблица 2");
    for (const field of ["publisher", "locator"] as const) {
      expect(() => answer(family, null, field, " ")).toThrow();
      expect(() => answer(family, null, field, "Я".repeat(1001))).toThrow();
    }
  });
  it("Explains the effect of an answer and recovery for every supported question", () => {
    for (const field of sourceFactInputFields) {
      const text = sourceFactQuestion(family, duty, field);
      expect(text).toContain("Ответьте на это сообщение");
      expect(text).toContain(
        field === "publisher" ? "Это не подтверждает характеристики" : "Сохранится только это поле",
      );
      expect(text).toContain("/input");
      expect(text).toContain("/cancel");
      expect(text).toContain("Публикация не начнётся");
      expect(text).not.toContain("undefined");
    }
    expect(sourceFactQuestion(family, duty, "current_a")).toContain(
      "не подставляйте пример или ноль",
    );
    expect(sourceFactQuestion(family, null, "locator")).toContain("пропустите строку");
    expect(sourceFactQuestion(family, null, "publisher")).toContain("Не подставляйте изготовителя");
  });
  it("Fits a Telegram question for every dictionary field without cutting instructions", () => {
    for (const binding of dictionary.bindings) {
      const text = sourceFactQuestion(binding.family_code, binding.attribute_code, "value");
      expect(text).not.toContain("undefined");
      expect(Array.from(text).length).toBeLessThan(3000);
    }
  });
});
