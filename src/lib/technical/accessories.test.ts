import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import extension from "./accessory-dictionary.json";
import dictionary, { attributeGuidance, familyGuidance } from "./dictionary";
import {
  editorAction as act,
  editorReply as reply,
  editorQuestion,
  families,
  fields,
  type EditorData,
} from "./editor";
import { parseSourceFactAnswer, sourceFactQuestion } from "./source-review-input";
import { formatTechnicalContext, formatTechnicalValue } from "./presentation";
import { publicTechnicalCard } from "./schema";

const familyCodes = [
  "tig_torch",
  "cut_torch",
  "mma_holder",
  "ground_clamp",
  "welding_cable",
  "water_cooler",
];
const empty = (): EditorData => ({
  document: null,
  screen: "home",
  page: 0,
  field: null,
  fact: null,
  pending: null,
  source: null,
  sourceField: 0,
});
function family(code: string) {
  return act(
    act(empty(), "families"),
    "family",
    families.findIndex((f) => f.code === code),
  );
}
function field(code: string, attribute: string) {
  let s = act(family(code), "fields");
  s = act(
    s,
    "field",
    fields(s).findIndex((f) => f.attribute_code === attribute),
  );
  return act(act(s, "process"), "new");
}

it("appends all six accessory families and represents all 41 research fields explicitly", () => {
  expect(families).toHaveLength(33);
  expect(families.slice(27).map((f) => f.code)).toEqual(familyCodes);
  expect(extension.attributes).toHaveLength(44);
  expect(extension.bindings).toHaveLength(44);
  expect(dictionary.attributes).toHaveLength(131);
  expect(dictionary.bindings).toHaveLength(166);
  const research = JSON.parse(
    readFileSync(
      "research/welding-catalog-2026-11-06/MasterWeld_Attribute_Dictionary_v1.json",
      "utf8",
    ),
  );
  let mapped = 0;
  for (const code of familyCodes) {
    const source = research.families.find((f: { code: string }) => f.code === code);
    for (const expected of source.attributes) {
      const binding = extension.bindings.find(
        (b) => b.family_code === code && b.attribute_code === expected.key,
      );
      expect(binding).toBeDefined();
      const attr = extension.attributes.find((a) => a.code === expected.key)!;
      const documentary = extension.research_text_fields.find(
        (r) => r.family === code && r.attribute === expected.key,
      );
      if (documentary) {
        expect(documentary.research_kind).toBe(expected.type);
        expect(["enum", "enum_list"]).toContain(expected.type);
        expect(attr.kind).toBe("text");
        expect(attr.options).toEqual([]);
      } else expect(attr.kind).toBe(expected.type);
      mapped++;
    }
    expect(family(code).document?.values).toEqual([]);
    expect(familyGuidance(code)).toContain("не доказывают совместимость");
  }
  expect(mapped).toBe(41);
  expect(extension.research_text_fields).toHaveLength(18);
  const sql = readFileSync("docs/proposals/0043_accessory_characteristics.sql", "utf8");
  expect(JSON.parse(sql.split("$accessory_seed$")[1]!)).toEqual(extension);
});

it.each(extension.bindings)(
  "keeps $attribute_code in the human input and source-review paths",
  (binding) => {
    const attr = extension.attributes.find((a) => a.code === binding.attribute_code)!;
    const input =
      attr.kind === "number_list"
        ? "1,6; 2,4"
        : attr.kind === "number"
          ? "12,5"
          : "Обозначение изготовителя / Исполнение Z\nТолько по документу";
    const expected =
      attr.kind === "number_list" ? [1.6, 2.4] : attr.kind === "number" ? 12.5 : input;
    const result = reply(field(binding.family_code, attr.code), input);
    expect(result.pending?.value).toEqual(expected);
    expect(result.document?.values).toEqual([]);
    expect(result.pending?.source_key).toBeNull();
    expect(parseSourceFactAnswer(binding.family_code, attr.code, "value", input)).toEqual(expected);
    expect(sourceFactQuestion(binding.family_code, attr.code, "value")).toContain(
      "строку затем нужно проверить",
    );
    expect(sourceFactQuestion(binding.family_code, attr.code, "value")).toContain(
      "Публикация не начнётся",
    );
    expect(result.screen).toBe(attr.required_context.length ? "context" : "sources");
    if (attr.kind === "number")
      expect(() => reply(field(binding.family_code, attr.code), "-1")).toThrow();
  },
);

it("does not save a TIG current without its duty and documentary conditions", () => {
  let s = reply(field("tig_torch", "tig_torch_max_ac_a"), "195");
  expect(s.screen).toBe("context");
  expect(editorQuestion(s)).toContain("Продолжительность нагрузки");
  expect(() => act(s, "source")).toThrow();
  s = reply(s, "60");
  expect(editorQuestion(s)).toContain("Условия из документа");
  expect(() => act(s, "source")).toThrow();
  s = reply(s, "Учебная строка: AC, цикл из паспорта, рукав указанного исполнения.");
  expect(s.screen).toBe("sources");
  expect(s.pending?.context).toEqual({
    duty_pct: 60,
    test_conditions: "Учебная строка: AC, цикл из паспорта, рукав указанного исполнения.",
  });
  expect(s.document?.values).toEqual([]);
  expect(() => reply(reply(field("tig_torch", "tig_torch_max_dc_a"), "160"), "101")).toThrow();
});

it("preserves ranges and multi-voltage supply without inventing a numeric list", () => {
  expect(() => reply(field("tig_torch", "tig_torch_tungsten_diameters_mm"), "1,0–2,4")).toThrow();
  const range = "Учебный диапазон: 1,0–2,4 мм";
  expect(reply(field("tig_torch", "tig_torch_tungsten_range"), range).pending?.value).toBe(range);
  const supply = "Учебное питание: 200–230 / 400–480 В AC; 50/60 Гц";
  expect(reply(field("water_cooler", "cooler_power_supply_text"), supply).pending?.value).toBe(
    supply,
  );
  expect(() => reply(field("water_cooler", "cooler_power_v"), supply)).toThrow();
  expect(attributeGuidance("tig_torch_tungsten_diameters_mm")).toContain("Диапазон диаметров");
  expect(attributeGuidance("cooler_power_v")).toContain("Питание по документу");
});

it("keeps source units and full cooling conditions instead of calculating a rating", () => {
  let s = reply(field("water_cooler", "cooler_capacity_w"), "800");
  expect(s.pending?.unit_code).toBe("w");
  expect(s.screen).toBe("context");
  s = reply(s, "Учебные условия: расход 1 л/мин; окружающий воздух +40 °C.");
  expect(s.pending?.value).toBe(800);
  expect(s.pending?.context.test_conditions).toContain("1 л/мин");
  const fact = {
    ...s.pending!,
    code: "cooler_capacity_w",
    label: "Мощность охлаждения",
    kind: "number" as const,
    unit: { code: "w", label: "Вт" },
    source_key: "manual",
  };
  expect(formatTechnicalValue(fact)).toBe("800 Вт");
  expect(formatTechnicalContext(fact.context).join(" ")).toContain("окружающий воздух +40 °C");
  expect(attributeGuidance("cooler_capacity_kw")).toContain("Мощность охлаждения, Вт");
  const source = {
    key: "manual",
    kind: "synthetic",
    publisher: "Учебный",
    model: "Учебная модель",
    title: "Учебные условия",
    url: "https://example.invalid/manual",
    locator: "Учебная таблица",
    checked_on: "2026-11-06",
    sha256: "",
  };
  const card = publicTechnicalCard.parse({
    product_id: "10000000-0000-4000-8000-000000000001",
    revision_id: "10000000-0000-4000-8000-000000000002",
    family: { code: "water_cooler", label: "Блок охлаждения" },
    verified_on: "2026-11-06",
    values: [
      {
        code: fact.code,
        label: fact.label,
        kind: fact.kind,
        process: fact.process,
        state: fact.state,
        value: fact.value,
        unit: fact.unit,
        context: fact.context,
        source_key: fact.source_key,
      },
    ],
    sources: [source],
  });
  expect(card.values[0]?.value).toBe(800);
});

it("keeps unknown explicit and never turns a connector name into compatibility", () => {
  const text = "Разъём Z / 3 контакта; только исполнение Q";
  const s = reply(field("tig_torch", "tig_torch_control_connector"), text);
  expect(s.pending?.value).toBe(text);
  expect(s.document?.values).toEqual([]);
  expect(attributeGuidance("tig_torch_control_connector")).toContain(
    "не подтверждают совместимость",
  );
  const unknown = act(field("welding_cable", "cable_current_limit_a"), "unknown");
  expect(unknown.document?.values[0]).toMatchObject({
    state: "unknown",
    value: null,
    context: {},
    source_key: null,
  });
});
