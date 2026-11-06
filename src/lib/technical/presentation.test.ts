import { expect, it } from "vitest";
import {
  formatTechnicalContext,
  formatTechnicalValue,
  groupTechnicalValues,
  type TechnicalValue,
} from "./presentation";
import { publicTechnicalCard } from "./schema";
import dictionary from "./pilot-dictionary.json";
const fact: TechnicalValue = {
  code: "tig_pulse",
  label: "Импульс",
  kind: "boolean",
  process: "tig",
  state: "known",
  value: false,
  unit: { code: "none", label: "—" },
  context: {},
  source_key: "manual",
};
it("distinguishes false, zero, unknown and not applicable", () => {
  expect(formatTechnicalValue(fact)).toBe("Нет");
  expect(
    formatTechnicalValue({ ...fact, value: 0, kind: "number", unit: { code: "a", label: "А" } }),
  ).toBe("0 А");
  expect(formatTechnicalValue({ ...fact, state: "unknown", value: null })).toBe("Не указано");
  expect(formatTechnicalValue({ ...fact, state: "not_applicable", value: null })).toBe(
    "Не применяется",
  );
});
it("keeps fractional lists unambiguous and never converts kVA to kW", () => {
  expect(
    formatTechnicalValue({
      ...fact,
      value: [0.8, 1, 1.2],
      kind: "number_list",
      unit: { code: "mm", label: "мм" },
    }),
  ).toBe("0,8; 1; 1,2 мм");
  expect(
    formatTechnicalValue({
      ...fact,
      value: 6.5,
      kind: "number",
      unit: { code: "kva", label: "кВА" },
    }),
  ).toBe("6,5 кВА");
  expect(
    formatTechnicalValue({
      ...fact,
      value: 0.00004,
      kind: "number",
      unit: { code: "ms", label: "мс" },
    }),
  ).toBe("0,00004 мс");
});
it("names every pilot enum option without inventing compatibility", () => {
  for (const attr of dictionary.attributes.filter((attr) => attr.kind.startsWith("enum"))) {
    for (const option of attr.options) {
      expect(
        formatTechnicalValue({ ...fact, code: attr.code, kind: "enum", value: option }),
      ).not.toBe(option);
    }
  }
  expect(
    formatTechnicalValue({
      ...fact,
      code: "tig_start_modes",
      kind: "enum_list",
      value: ["hf", "lift"],
    }),
  ).toBe("HF — бесконтактный поджиг; Lift — поджиг касанием с отрывом");
  expect(
    formatTechnicalValue({ ...fact, code: "mask_optical_class", kind: "text", value: "1/1/1/2" }),
  ).toBe("1/1/1/2");
});
it("keeps all measurement conditions, including zero current and temperature", () => {
  expect(
    formatTechnicalContext({
      current_a: 0,
      temperature_c: 0,
      pressure_bar: 5.5,
      gas: "M21",
      cooling: "liquid",
      duty_pct: 60,
      material: "Сталь",
      diameter_mm: 3.2,
    }),
  ).toEqual([
    "Ток: 0 А",
    "Температура: 0 °C",
    "Давление: 5,5 бар",
    "Газ: M21",
    "Охлаждение: жидкостное",
    "Продолжительность нагрузки: 60 %",
    "Материал: Сталь",
    "Диаметр: 3,2 мм",
  ]);
});
it("groups processes without borrowing another mode's maximum", () => {
  const groups = groupTechnicalValues([
    { ...fact, process: "mig", value: 200 },
    { ...fact, process: "mma", value: 160 },
    { ...fact, process: "tig", state: "unknown", value: null },
  ]);
  expect(groups.map((g) => [g.process, g.values[0]?.value])).toEqual([
    ["mma", 160],
    ["mig", 200],
    ["tig", null],
  ]);
});
const source = {
  key: "manual",
  kind: "manual",
  publisher: "Изготовитель",
  model: "Учебная модель",
  title: "Учебный документ",
  url: "https://example.invalid/manual",
  locator: "Страница 2",
  checked_on: "2026-11-06",
  sha256: "",
};
const card = {
  product_id: "10000000-0000-4000-8000-000000000001",
  revision_id: "10000000-0000-4000-8000-000000000002",
  family: { code: "power_tig_dc", label: "TIG" },
  verified_on: "2026-11-06",
  values: [fact],
  sources: [source],
};
it.each([
  { ...fact, value: "false" },
  { ...fact, source_key: "missing" },
  { ...fact, state: "unknown", value: false },
  { ...fact, state: "unknown", value: null, source_key: null, context: { current_a: 200 } },
  { ...fact, kind: "integer", value: 1.2 },
  { ...fact, kind: "number_list", value: ["200"] },
])("rejects a malformed public value rather than displaying a misleading fact", (value) => {
  expect(publicTechnicalCard.safeParse({ ...card, values: [value] }).success).toBe(false);
});
it("rejects ambiguous source references", () => {
  expect(publicTechnicalCard.safeParse(card).success).toBe(true);
  expect(publicTechnicalCard.safeParse({ ...card, sources: [source, source] }).success).toBe(false);
});
