import { expect, it } from "vitest";
import { extractSourceCandidates } from "./source-candidates";
const checksum = "a".repeat(64);
function source(text = "Максимальный ток MMA: 160 А", extra: Record<string, unknown> = {}) {
  return {
    version: "document-v1",
    sha256: checksum,
    blocks: [{ locator: "page:3", page: 3, text }],
    tables: [],
    warnings: [],
    coverage: { complete: true, pages: 3, processed: 3 },
    ...extra,
  };
}
it("keeps exact Unicode/CRLF quote and physical location separately from decimal normalization", () => {
  const text = "🧰 Паспорт\r\n  Минимальный ток MMA:  10,5 А  \r\nМаксимальный ток MMA: 160 А\n";
  const input = source(text),
    before = JSON.stringify(input);
  const result = extractSourceCandidates(input, checksum, "power_mma");
  expect(result.candidates.map((c) => [c.attribute_code, c.value])).toEqual([
    ["mma_current_min_a", 10.5],
    ["mma_current_max_a", 160],
  ]);
  for (const c of result.candidates) {
    expect(c.state).toBe("needs_human_review");
    expect(c.issues).toContain("model_scope_review");
    expect(c.evidence.kind).toBe("block");
    if (c.evidence.kind === "block") {
      expect(Array.from(text).slice(c.evidence.start, c.evidence.end).join("")).toBe(
        c.evidence.quote,
      );
      expect(c.evidence.page).toBe(3);
    }
  }
  expect(result.candidates[0]!.evidence).toMatchObject({
    quote: "  Минимальный ток MMA:  10,5 А  ",
  });
  expect(JSON.stringify(input)).toBe(before);
});
it("preserves contradictory values instead of picking first, last or majority", () => {
  const r = extractSourceCandidates(
    source("Максимальный ток MMA: 160 А\nМаксимальный ток MMA: 200 А\nМаксимальный ток MMA: 160 А"),
    checksum,
    "power_mma",
  );
  expect(r.candidates.map((c) => c.value)).toEqual([160, 200, 160]);
  expect(r.candidates.every((c) => c.issues.includes("conflicting_values"))).toBe(true);
});
it("does not infer welding current from power or a neighboring process", () => {
  const r = extractSourceCandidates(
    source("Потребляемая мощность: 6 кВт\nТок TIG максимум: 200 А\nМаксимальный ток MMA: 6 кВт"),
    checksum,
    "power_mma",
  );
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0]).toMatchObject({ attribute_code: "mma_current_max_a", value: null });
  expect(r.candidates[0]!.issues).toContain("unit_missing_or_mismatch");
});
it.each(["160", "16O А", "160–200 А", "160 А при 60%", "160 ± 5 А", "1 600 А"])(
  "does not silently repair or simplify an ambiguous value %s",
  (text) => {
    const c = extractSourceCandidates(
      source("Максимальный ток MMA: " + text),
      checksum,
      "power_mma",
    ).candidates[0]!;
    expect(c.value).toBeNull();
  },
);
it("accepts an explicit unit column without turning a model column into units", () => {
  const table = {
    label: "Характеристики",
    header: ["Параметр", "Значение", "Ед. изм."],
    rows: [["Максимальный ток MMA", "160", "А"]],
    row_locators: ["page:4/table:1/row:2"],
  };
  const input = source("", { tables: [table] });
  const candidate = extractSourceCandidates(input, checksum, "power_mma").candidates[0]!;
  expect(candidate.value).toBe(160);
  expect(candidate.evidence).toEqual({
    kind: "table",
    table: 0,
    row: 0,
    locator: "page:4/table:1/row:2",
    header: table.header,
    cells: table.rows[0],
  });
});
it("multiple model columns require a decision even if one model is selected elsewhere", () => {
  const table = {
    label: "Модели",
    header: ["Параметр", "Модель 160", "Модель 200"],
    rows: [["Максимальный ток MMA", "160 А", "200 А"]],
    row_locators: ["page:5/table:1/row:2"],
  };
  const c = extractSourceCandidates(source("", { tables: [table] }), checksum, "power_mma")
    .candidates[0]!;
  expect(c.value).toBeNull();
  expect(c.issues).toContain("multiple_value_columns");
  if (c.evidence.kind === "table") expect(c.evidence.cells).toEqual(table.rows[0]);
});
it("preserves an unlocated row rather than inventing a physical page", () => {
  const c = extractSourceCandidates(
    source("", {
      tables: [
        {
          label: "Таблица",
          header: ["Параметр", "Значение"],
          rows: [["Максимальный ток MMA", "160 А"]],
        },
      ],
    }),
    checksum,
    "power_mma",
  ).candidates[0]!;
  expect(c.evidence).toMatchObject({ kind: "table", locator: null });
  expect(c.issues).toContain("locator_review");
});
it("shows page conflicts and OCR limitations without claiming confidence", () => {
  const c = extractSourceCandidates(
    source("", {
      blocks: [
        {
          locator: "page:3",
          page: 4,
          text: "Максимальный ток MMA: 160 А",
          engine: "tesseract-rus-eng",
        },
      ],
      warnings: ["OCR"],
      coverage: { complete: false, pages: 4, processed: 3 },
    }),
    checksum,
    "power_mma",
  ).candidates[0]!;
  expect(c.evidence).toMatchObject({ page: null });
  expect(c.issues).toEqual(
    expect.arrayContaining(["ocr_review", "source_incomplete", "source_warning", "locator_review"]),
  );
  expect(c).not.toHaveProperty("confidence");
});
it("retains missing conditions and ambiguous process for explicit human review", () => {
  const r = extractSourceCandidates(
    source("ПН MMA (при указанном токе): 60 %\nПолная мощность в указанном режиме: 6 кВА"),
    checksum,
    "power_mma",
  );
  const duty = r.candidates.find((c) => c.attribute_code === "mma_duty_cycle_pct")!;
  expect(duty.value).toBe(60);
  expect(duty.conditions_required).toEqual(["current_a", "temperature_c"]);
  expect(duty.issues).toContain("conditions_review");
  const power = extractSourceCandidates(
    source("Полная мощность в указанном режиме: 6 кВА"),
    checksum,
    "power_multiprocess",
  ).candidates.find((c) => c.attribute_code === "power_consumption_kva")!;
  expect(power.process).toBeNull();
  expect(power.issues).toContain("process_review");
});
it("does not turn missing fields or an empty document into absent product capabilities", () => {
  const r = extractSourceCandidates(
    source("Учебный паспорт без характеристик"),
    checksum,
    "power_mma",
  );
  expect(r.candidates).toHaveLength(0);
  expect(r.fields_without_candidates.some((f) => f.code === "hot_start")).toBe(true);
  expect(r.fields_without_candidates.every((f) => f.state === "not_found_in_scanned_text")).toBe(
    true,
  );
  const empty = extractSourceCandidates(source(""), checksum, "power_mma");
  expect(empty.warnings).toContain("no_readable_text");
});
it("keeps explicit no separate from an unrecognized boolean", () => {
  expect(
    extractSourceCandidates(source("Hot Start: Нет"), checksum, "power_mma").candidates[0]!.value,
  ).toBe(false);
  expect(
    extractSourceCandidates(source("Hot Start: Не указано"), checksum, "power_mma").candidates[0]!
      .value,
  ).toBeNull();
});
it("preserves consumable class and compatibility wording and warns about continuation", () => {
  const c = extractSourceCandidates(
    source("Совместимый держатель: Только ABC-7, не ABC-8"),
    checksum,
    "mig_contact_tip",
  ).candidates[0]!;
  expect(c.value).toBe("Только ABC-7, не ABC-8");
  expect(c.issues).toContain("text_continuation_review");
});
it("does not confuse nominal cup number, dimensions, package count and stock", () => {
  const r = extractSourceCandidates(
    source("Размер керамического сопла №: 6\nШтук в упаковке: 10\nОстаток: 120\nДлина, мм: 47"),
    checksum,
    "tig_kit_parts",
  );
  expect(r.candidates.find((c) => c.attribute_code === "tig_cup_size")?.value).toBe(6);
  expect(r.candidates.find((c) => c.attribute_code === "quantity_pack")?.value).toBe(10);
  expect(r.candidates.find((c) => c.attribute_code === "tig_part_length_mm")?.value).toBe(47);
  expect(r.candidates.some((c) => c.value === 120)).toBe(false);
});
it("decimal commas are not list separators; explicit lists preserve each supported value", () => {
  const r = extractSourceCandidates(
    source("Диаметры проволоки, мм: 0,8; 1,0\nДиаметры проволоки: 0,8,1,0 мм"),
    checksum,
    "feed_rollers",
  );
  expect(r.candidates[0]!.value).toEqual([0.8, 1]);
  expect(r.candidates[1]!.value).toBeNull();
});
it("unknown enum vocabulary and incompatible units remain unresolved", () => {
  const r = extractSourceCandidates(
    source("Род тока TIG: Переменный\nТок TIG максимум: 0,2 кА"),
    checksum,
    "power_tig_acdc",
  );
  expect(r.candidates.every((c) => c.value === null)).toBe(true);
  expect(r.candidates).toHaveLength(2);
});
it("rejects negative dimensions and non-integral package counts", () => {
  const r = extractSourceCandidates(
    source("Диаметр: -2 мм\nШтук в упаковке: 2,5"),
    checksum,
    "consumable_tungsten",
  );
  expect(r.candidates.every((c) => c.value === null && c.issues.includes("out_of_range"))).toBe(
    true,
  );
  expect(r.candidates).toHaveLength(2);
});
it("rejects substituted originals and malformed extraction before creating proposals", () => {
  const wrong = extractSourceCandidates(source(), "b".repeat(64), "power_mma");
  expect(wrong.warnings).toEqual(["checksum_mismatch"]);
  expect(wrong.candidates).toHaveLength(0);
  expect(extractSourceCandidates({ blocks: "bad" }, checksum, "power_mma").warnings).toEqual([
    "input_invalid",
  ]);
  expect(() => extractSourceCandidates(source(), checksum, "invented_family")).toThrow(
    "SOURCE_CANDIDATE_FAMILY",
  );
});
it("makes truncation visible and never reports an incomplete scan as complete", () => {
  const r = extractSourceCandidates(
    source("Максимальный ток MMA: 160 А\n".repeat(400)),
    checksum,
    "power_mma",
  );
  expect(r.candidates).toHaveLength(256);
  expect(r.complete).toBe(false);
  expect(r.warnings).toContain("scan_limit");
  const long = extractSourceCandidates(source("X".repeat(4001)), checksum, "power_mma");
  expect(long.complete).toBe(false);
  expect(long.warnings).toContain("scan_limit");
});

it("recognizes explicit process-specific labels without guessing a generic current's process", () => {
  const r = extractSourceCandidates(
    source("\tМаксимальный сварочный ток MMA, А: 160\nСварочный ток: 200 А"),
    checksum,
    "power_mma",
  );
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0]).toMatchObject({
    attribute_code: "mma_current_max_a",
    process: "mma",
    value: 160,
  });
  if (r.candidates[0]!.evidence.kind === "block")
    expect(r.candidates[0]!.evidence.quote).toContain("\tМаксимальный");
});
it("does not invent measurement conditions for abbreviated duty-cycle labels", () => {
  const c = extractSourceCandidates(source("ПВ MMA: 60 %"), checksum, "power_mma").candidates[0]!;
  expect(c.attribute_code).toBe("mma_duty_cycle_pct");
  expect(c.conditions_required).toEqual(["current_a", "temperature_c"]);
  expect(c.issues).toContain("conditions_review");
});

it("keeps unfamiliar labels for manual field selection instead of dropping their evidence", () => {
  const r = extractSourceCandidates(
    source("Сварочный ток: 20–160 А\nМощность двигателя: 5 кВт"),
    checksum,
    "power_mma",
  );
  expect(r.candidates).toHaveLength(0);
  expect(r.unmatched_entries.map((e) => [e.label, e.raw_value, e.state])).toEqual([
    ["Сварочный ток", " 20–160 А", "needs_field_selection"],
    ["Мощность двигателя", " 5 кВт", "needs_field_selection"],
  ]);
  expect(r.unmatched_entries[0]!.evidence).toMatchObject({ quote: "Сварочный ток: 20–160 А" });
});
it("bounds unmatched entries and rejects future extraction versions until reviewed", () => {
  const r = extractSourceCandidates(
    source("Неизвестная подпись: Значение\n".repeat(400)),
    checksum,
    "power_mma",
  );
  expect(r.unmatched_entries).toHaveLength(256);
  expect(r.warnings).toContain("scan_limit");
  expect(
    extractSourceCandidates(source("", { version: "document-v2" }), checksum, "power_mma").warnings,
  ).toContain("input_invalid");
});
