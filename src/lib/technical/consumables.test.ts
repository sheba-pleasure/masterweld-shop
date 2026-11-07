import { expect, it } from "vitest";
import pilot from "./pilot-dictionary.json";
import extension from "./consumable-dictionary.json";
import dictionary, { attributeGuidance, consumableGuidance } from "./dictionary";
import {
  editorAction as act,
  editorReply as reply,
  editorData,
  families,
  fields,
  editorQuestion,
  type EditorData,
} from "./editor";
import { formatTechnicalValue } from "./presentation";
import { publicTechnicalCard } from "./schema";
import { readFileSync } from "node:fs";

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
it("keeps all persisted pilot family and field indices stable while appending consumables", () => {
  const originalFamilies = pilot.families.filter((f) =>
    pilot.bindings.some((b) => b.family_code === f.code),
  );
  expect(families.slice(0, originalFamilies.length)).toEqual(originalFamilies);
  expect(families).toHaveLength(27);
  for (const f of originalFamilies) {
    const before = pilot.bindings.filter((b) => b.family_code === f.code);
    expect(fields(family(f.code)).slice(0, before.length)).toEqual(before);
  }
  expect(dictionary.attributes.slice(0, pilot.attributes.length)).toEqual(pilot.attributes);
  expect(new Set(dictionary.attributes.map((a) => a.code)).size).toBe(dictionary.attributes.length);
  expect(new Set(dictionary.bindings.map((a) => a.family_code + ":" + a.attribute_code)).size).toBe(
    dictionary.bindings.length,
  );
});
it("requires an explicit family choice and bounds navigation without clearing a draft", () => {
  let s = act(empty(), "families");
  s = act(s, "families", 3);
  expect(editorData.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  expect(s.document).toBeNull();
  expect(() => act(s, "families", 4)).toThrow("Страница");
  const selected = act(s, "family", 26);
  expect(selected.document?.family_code).toBe(families[26]?.code);
  expect(selected.document?.values).toEqual([]);
});
it("keeps documentary text exact and requires a source before adding a known value", () => {
  const sourceText = "AWS A5.18: ER70S-6 / Условия из паспорта";
  const s = reply(field("consumable_tig_rod", "filler_rod_class"), sourceText);
  expect(s.screen).toBe("sources");
  expect(s.pending?.value).toBe(sourceText);
  expect(s.document?.values).toEqual([]);
  expect(editorQuestion(field("consumable_tig_rod", "filler_rod_class"))).toContain("дословно");
});
it("validates decimal comma, lists, pack counts and unknown separately", () => {
  expect(reply(field("consumable_tig_rod", "filler_rod_diameter_mm"), "1,6").pending?.value).toBe(
    1.6,
  );
  expect(
    reply(field("feed_rollers", "roller_wire_diameters_mm"), "0,8; 1,0").pending?.value,
  ).toEqual([0.8, 1]);
  expect(() => reply(field("feed_rollers", "roller_wire_diameters_mm"), "0,8; 0.8")).toThrow(
    "повторяющиеся",
  );
  expect(() => reply(field("consumable_tungsten", "tungsten_qty_pack"), "1,5")).toThrow();
  expect(() => reply(field("consumable_tungsten", "tungsten_qty_pack"), "0")).toThrow();
  expect(() => reply(field("mig_liner", "mig_liner_length_m"), "-1")).toThrow();
  const s = act(field("consumable_tungsten", "tungsten_qty_pack"), "unknown");
  expect(s.document?.values[0]).toMatchObject({ value: null, state: "unknown", source_key: null });
  expect(reply(field("tig_kit_parts", "tig_gas_lens"), "нет").pending?.value).toBe(false);
});
it("does not turn research priority or undefined enums into required or inferred product facts", () => {
  expect(extension.attributes.every((a) => !["enum", "enum_list"].includes(a.kind))).toBe(true);
  expect(dictionary.attributes.find((a) => a.code === "flux_wire_gas_mode")?.options).toEqual([
    "self_shielded",
    "gas_shielded",
  ]);
  expect(
    fields(family("consumable_tig_rod")).some((f) => f.attribute_code === "filler_rod_alloy"),
  ).toBe(false);
  expect(family("consumable_tig_rod").document?.values).toEqual([]);
  expect(consumableGuidance("mig_contact_tip")).toContain("не подтверждает совместимость");
  expect(attributeGuidance("quantity_pack")).toContain("не остаток");
  expect(attributeGuidance("tig_cup_size")).toContain("не диаметр");
});
it("preserves the research origin and exactly matches the forward-only SQL seed", () => {
  const sql = readFileSync("docs/migrations/0034_consumable_characteristics.sql", "utf8");
  expect(JSON.parse(sql.split("$consumable_seed$")[1]!)).toEqual(extension);
  const research = JSON.parse(
    readFileSync(
      "research/welding-catalog-2026-11-06/MasterWeld_Attribute_Dictionary_v1.json",
      "utf8",
    ),
  );
  for (const binding of extension.bindings) {
    const source = research.families
      .find((f: { code: string }) => f.code === binding.family_code)
      ?.attributes.find((a: { key: string }) => a.key === binding.attribute_code);
    expect(source).toBeDefined();
    const attr = dictionary.attributes.find((a) => a.code === binding.attribute_code)!;
    expect(attr.kind).toBe(source.type);
  }
});
it("renders the nominal cup size without misrepresenting it as a diameter", () => {
  const fact = {
    code: "tig_cup_size",
    label: "Размер сопла",
    kind: "integer" as const,
    process: "general" as const,
    state: "known" as const,
    value: 6,
    unit: { code: "size_number", label: "№" },
    context: {},
    source_key: "manual",
  };
  expect(formatTechnicalValue(fact)).toBe("№ 6");
  const source = {
    key: "manual",
    kind: "manual",
    publisher: "Учебный",
    model: "Учебный",
    title: "Учебный",
    url: "https://example.invalid/manual",
    locator: "Страница 1",
    checked_on: "2026-11-06",
    sha256: "",
  };
  const card = publicTechnicalCard.parse({
    product_id: "10000000-0000-4000-8000-000000000001",
    revision_id: "10000000-0000-4000-8000-000000000002",
    family: { code: "tig_kit_parts", label: "Расходники TIG" },
    verified_on: "2026-11-06",
    values: [fact],
    sources: [source],
  });
  expect(card.values[0]?.unit.code).toBe("size_number");
});
