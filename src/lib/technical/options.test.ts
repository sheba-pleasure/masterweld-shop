import { expect, it } from "vitest";
import dictionary from "./dictionary";
import {
  parseTechnicalContextValue,
  parseTechnicalFieldValue,
  technicalFieldDefinition,
  editorAction,
  editorReply,
  editorQuestion,
  families,
  fields,
  type EditorData,
} from "./editor";
import { parseSourceFactAnswer, sourceFactQuestion } from "./source-review-input";
import { parseTechnicalOption, technicalOptionLabel } from "./options";

it("accepts every displayed dictionary choice while preserving its canonical code and family limits", () => {
  for (const binding of dictionary.bindings) {
    const a = technicalFieldDefinition(binding.family_code, binding.attribute_code);
    if (!["enum", "enum_list"].includes(a.kind)) continue;
    for (const option of a.options) {
      const expected = a.kind === "enum_list" ? [option] : option;
      for (const input of [option, option.toUpperCase(), technicalOptionLabel(a.code, option)]) {
        expect(parseTechnicalFieldValue(binding.family_code, a.code, input)).toEqual(expected);
        expect(parseSourceFactAnswer(binding.family_code, a.code, "value", input)).toEqual(
          expected,
        );
      }
    }
  }
  expect(() =>
    parseTechnicalFieldValue("power_tig_dc", "tig_polarity_modes", "Переменный ток"),
  ).toThrow();
  expect(() =>
    parseTechnicalFieldValue("power_mma", "tig_polarity_modes", "Постоянный ток"),
  ).toThrow();
});

it("normalizes explicit human choices before detecting duplicates", () => {
  expect(
    parseTechnicalFieldValue(
      "power_tig_acdc",
      "tig_polarity_modes",
      "Постоянный ток; ПЕРЕМЕННЫЙ ТОК",
    ),
  ).toEqual(["dc", "ac"]);
  for (const input of ["dc; Постоянный ток", "AC; ac", "Постоянный ток;; Переменный ток"]) {
    expect(() => parseTechnicalFieldValue("power_tig_acdc", "tig_polarity_modes", input)).toThrow();
  }
});

it("does not guess unknown, negative, ambiguous or approximate answers", () => {
  for (const input of [
    "Нет",
    "Неизвестно",
    "0",
    "1",
    "Постоянный",
    "Наверное DC",
    "AC/DC",
    "Постоянный ток, переменный ток",
  ]) {
    expect(() => parseTechnicalFieldValue("power_tig_acdc", "tig_polarity_modes", input)).toThrow();
  }
  expect(parseTechnicalOption("unmapped", "CODE", ["code", "Code"])).toBeUndefined();
  expect(parseTechnicalOption("unmapped", "Произвольное", ["code"])).toBeUndefined();
  expect(() => parseTechnicalFieldValue("power_tig_acdc", "tig_start_modes", "Касанием")).toThrow();
});

it("accepts Russian cooling in both editors while keeping other documentary text exact", () => {
  for (const [input, expected] of [
    ["Воздушное", "air"],
    ["ЖИДКОСТНОЕ", "liquid"],
    ["air", "air"],
    ["LIQUID", "liquid"],
  ]) {
    expect(parseTechnicalContextValue("cooling", input!)).toBe(expected);
    expect(parseSourceFactAnswer("power_mma", "mma_duty_cycle_pct", "cooling", input!)).toBe(
      expected,
    );
  }
  for (const input of ["Нет", "Водяное?", "Вроде воздушное", "air/liquid", ""]) {
    expect(() => parseTechnicalContextValue("cooling", input)).toThrow();
  }
  expect(parseTechnicalContextValue("gas", "Ar + 18 % CO2")).toBe("Ar + 18 % CO2");
  expect(parseTechnicalContextValue("material", "DC — постоянный ток")).toBe("DC — постоянный ток");
  expect(() => parseTechnicalContextValue("temperature_c", "20 °C")).toThrow();
});

it("explains source-review choices without exposing internal underscored codes", () => {
  const binding = dictionary.bindings.find((b) => b.attribute_code === "flux_wire_gas_mode")!;
  const question = sourceFactQuestion(binding.family_code, binding.attribute_code, "value");
  expect(question).toContain("Самозащитная");
  expect(question).toContain("С защитным газом");
  expect(question).not.toContain("self_shielded");
  expect(question).not.toContain("gas_shielded");
  expect(
    parseSourceFactAnswer(binding.family_code, binding.attribute_code, "value", "Самозащитная"),
  ).toBe("self_shielded");
  expect(
    parseSourceFactAnswer(binding.family_code, binding.attribute_code, "value", "С защитным газом"),
  ).toBe("gas_shielded");
});

it("a Russian answer updates only the pending editor value and still requires a source", () => {
  const empty: EditorData = {
    document: null,
    screen: "home",
    page: 0,
    field: null,
    fact: null,
    pending: null,
    source: null,
    sourceField: 0,
  };
  let state = editorAction(
    editorAction(empty, "families"),
    "family",
    families.findIndex((f) => f.code === "power_tig_acdc"),
  );
  state = editorAction(state, "fields");
  state = editorAction(
    state,
    "field",
    fields(state).findIndex((f) => f.attribute_code === "tig_polarity_modes"),
  );
  state = editorAction(editorAction(state, "process"), "new");
  const before = structuredClone(state);
  expect(editorQuestion(state)).toContain("DC — постоянный ток");
  expect(editorQuestion(state)).toContain("AC — переменный ток");
  const after = editorReply(state, "Постоянный ток; Переменный ток");
  expect(after.pending?.value).toEqual(["dc", "ac"]);
  expect(after.document?.values).toEqual([]);
  expect(after.screen).toBe("sources");
  expect(state).toEqual(before);
});
