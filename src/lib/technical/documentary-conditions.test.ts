import { describe, expect, it } from "vitest";
import { parseTechnicalContextValue } from "./editor";
import { formatTechnicalContext } from "./presentation";
import { technicalContext, technicalFact } from "./schema";
import {
  parseSourceFactAnswer,
  sourceFactInputFields,
  sourceFactQuestion,
} from "./source-review-input";

describe("Literal documentary measurement conditions", () => {
  it("Preserves source wording, line breaks and units in both human input paths", () => {
    const note = "Кабель 8 м; ПН 60 %.\nТолько для модификации A; без пересчёта единиц.";
    expect(parseTechnicalContextValue("test_conditions", note)).toBe(note);
    expect(parseSourceFactAnswer("power_mma", "mma_current_max_a", "test_conditions", note)).toBe(
      note,
    );
    expect(formatTechnicalContext({ duty_pct: 60, test_conditions: note })).toEqual([
      "Продолжительность нагрузки: 60 %",
      "Условия из документа: " + note,
    ]);
    expect(() => parseSourceFactAnswer("power_mma", null, "test_conditions", note)).toThrow();
    expect(() =>
      parseSourceFactAnswer("power_cut", "mma_current_max_a", "test_conditions", note),
    ).toThrow();
  });

  it("Counts Unicode characters and refuses empty, overlong and non-text conditions", () => {
    const note = "🧰".repeat(500);
    expect(technicalContext.parse({ test_conditions: note }).test_conditions).toBe(note);
    expect(parseTechnicalContextValue("test_conditions", note)).toBe(note);
    for (const bad of [
      "",
      " \t\r\n",
      "\u00a0\u2003\ufeff",
      "🧰".repeat(501),
      " ".repeat(500) + "A",
      0,
      true,
      [],
      {},
      null,
    ]) {
      expect(technicalContext.safeParse({ test_conditions: bad }).success).toBe(false);
    }
    expect(() => parseTechnicalContextValue("test_conditions", "🧰".repeat(501))).toThrow();
    // Existing numeric/context restrictions are not relaxed by the text field.
    expect(
      technicalContext.safeParse({ test_conditions: "Документ", pressure_bar: 0 }).success,
    ).toBe(false);
    expect(
      technicalContext.safeParse({ test_conditions: "Документ", arbitrary: "value" }).success,
    ).toBe(false);
  });

  it("Keeps persisted question indexes and explains how to handle incomplete conditions", () => {
    expect(sourceFactInputFields.slice(0, 11)).toEqual([
      "value",
      "publisher",
      "locator",
      "current_a",
      "temperature_c",
      "pressure_bar",
      "gas",
      "cooling",
      "duty_pct",
      "material",
      "diameter_mm",
    ]);
    expect(sourceFactInputFields[11]).toBe("test_conditions");
    const question = sourceFactQuestion("power_mma", "mma_current_max_a", "test_conditions");
    expect(question).toContain("до 500 знаков");
    expect(question).toContain("отмените ввод и пропустите строку");
    expect(question).toContain("Публикация не начнётся");
  });

  it("Does not let an unknown value acquire documentary conditions", () => {
    const fact = {
      attribute_code: "mma_current_max_a",
      process: "mma",
      state: "unknown",
      value: null,
      unit_code: "a",
      source_key: null,
      context: { test_conditions: "Из документа" },
    };
    expect(technicalFact.safeParse(fact).success).toBe(false);
    expect(technicalFact.safeParse({ ...fact, context: {} }).success).toBe(true);
  });
});
