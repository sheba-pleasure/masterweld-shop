import { z } from "zod";
import dictionary from "./dictionary";

export const SOURCE_CANDIDATE_VERSION = "source-candidates-v1";
const MAX_UNITS = 5000;
const MAX_CANDIDATES = 256;
const MAX_CHARS = 2_000_000;
const MAX_LINE = 4000;
const schema = z.object({
  version: z.literal("document-v1"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  blocks: z
    .array(
      z.object({
        locator: z.string().max(1000),
        text: z.string().max(MAX_CHARS),
        page: z.number().int().positive().optional(),
        engine: z.string().max(100).optional(),
      }),
    )
    .max(MAX_UNITS),
  tables: z
    .array(
      z.object({
        label: z.string().max(1000),
        header: z.array(z.string().max(MAX_LINE)).max(128),
        rows: z.array(z.array(z.string().max(MAX_LINE)).max(128)).max(MAX_UNITS),
        row_locators: z.array(z.string().max(1000)).max(MAX_UNITS).optional(),
        warnings: z.array(z.string().max(1000)).max(1000).optional(),
      }),
    )
    .max(128),
  warnings: z.array(z.string().max(1000)).max(1000),
  coverage: z.object({
    complete: z.boolean().optional(),
    pages: z.number().int().nonnegative().optional(),
    processed: z.number().int().nonnegative().optional(),
  }),
});
export type SourceEvidence =
  | {
      kind: "block";
      block: number;
      locator: string;
      page: number | null;
      start: number;
      end: number;
      offset_unit: "unicode_codepoints";
      quote: string;
    }
  | {
      kind: "table";
      table: number;
      row: number;
      locator: string | null;
      header: string[];
      cells: string[];
    };
export type CandidateIssue =
  | "model_scope_review"
  | "ocr_review"
  | "source_incomplete"
  | "source_warning"
  | "locator_review"
  | "multiple_value_columns"
  | "unit_missing_or_mismatch"
  | "value_format_review"
  | "out_of_range"
  | "process_review"
  | "conditions_review"
  | "text_continuation_review"
  | "conflicting_values";
export interface SourceCandidate {
  attribute_code: string;
  label: string;
  kind: string;
  unit_code: string;
  process: string | null;
  value: number | boolean | string | number[] | string[] | null;
  conditions_required: string[];
  issues: CandidateIssue[];
  evidence: SourceEvidence;
  // No confirmed/known state. Extraction never creates a technicalFact.
  state: "needs_human_review";
}
export interface CandidateResult {
  version: typeof SOURCE_CANDIDATE_VERSION;
  checksum: string;
  family_code: string;
  candidates: SourceCandidate[];
  unmatched_entries: {
    label: string;
    raw_value: string | null;
    evidence: SourceEvidence;
    state: "needs_field_selection";
  }[];
  fields_without_candidates: { code: string; label: string; state: "not_found_in_scanned_text" }[];
  warnings: (
    | "input_invalid"
    | "checksum_mismatch"
    | "scan_limit"
    | "source_incomplete"
    | "source_warning"
    | "no_readable_text"
  )[];
  scanned_units: number;
  complete: boolean;
}
const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const unitAliases: Record<string, string[]> = {
  a: ["а", "a"],
  v: ["в", "v"],
  pct: ["%"],
  mm: ["мм", "mm"],
  m: ["м", "m"],
  kg: ["кг", "kg"],
  c: ["°c", "°с"],
  din: ["din"],
  ms: ["мс", "ms"],
  l_min: ["л/мин", "l/min"],
  kva: ["ква", "kva", "кв·а", "kv·a"],
  count: ["шт", "шт.", "штук"],
  size_number: ["№"],
  none: [""],
};
// Exact synonyms only. Missing process/range/compatibility must never be guessed.
const labelAliases: Record<string, string[]> = {
  mains_nominal_v: ["Номинальное напряжение питания", "Напряжение питания", "Напряжение сети"],
  mma_current_min_a: ["Минимальный сварочный ток MMA", "Мин. ток MMA"],
  mma_current_max_a: ["Максимальный сварочный ток MMA", "Макс. ток MMA"],
  mig_current_min_a: ["Минимальный сварочный ток MIG/MAG"],
  mig_current_max_a: ["Максимальный сварочный ток MIG/MAG"],
  tig_current_min_a: ["Минимальный сварочный ток TIG"],
  tig_current_max_a: ["Максимальный сварочный ток TIG"],
  cut_current_min_a: ["Минимальный ток резки CUT"],
  cut_current_max_a: ["Максимальный ток резки CUT"],
  mma_duty_cycle_pct: ["ПН MMA", "ПВ MMA", "Продолжительность нагрузки MMA"],
  mig_duty_cycle_pct: ["ПН MIG/MAG", "ПВ MIG/MAG", "Продолжительность нагрузки MIG/MAG"],
  tig_duty_cycle_pct: ["ПВ TIG", "Продолжительность нагрузки TIG"],
  cut_duty_cycle_pct: ["ПВ CUT", "Продолжительность нагрузки CUT"],
};
type Field = Omit<(typeof dictionary.attributes)[number], "options"> & {
  options: string[];
  display_label: string;
  labels: string[];
};
function familyFields(family: string): Field[] {
  const bindings = dictionary.bindings.filter((b) => b.family_code === family);
  if (!bindings.length) throw new Error("SOURCE_CANDIDATE_FAMILY");
  return bindings.map((b) => {
    const a = dictionary.attributes.find((v) => v.code === b.attribute_code)!;
    return {
      ...a,
      options: b.options_override ?? a.options,
      display_label: b.label ?? a.label,
      labels: [
        ...new Set([a.label, b.label ?? a.label, ...(labelAliases[a.code] ?? [])].map(normalize)),
      ],
    };
  });
}
function units(field: Field) {
  return [
    ...new Set(
      [
        ...(unitAliases[field.unit_code] ?? []),
        dictionary.units.find((u) => u.code === field.unit_code)?.label ?? "",
      ].map(normalize),
    ),
  ];
}
function matchLabel(raw: string, field: Field): { unitInLabel: boolean } | null {
  const key = normalize(raw),
    aliases = units(field).filter(Boolean);
  for (const label of field.labels) {
    if (key === label)
      return { unitInLabel: ["none", "count", "size_number"].includes(field.unit_code) };
    for (const unit of aliases)
      if ([label + ", " + unit, label + " (" + unit + ")", label + " [" + unit + "]"].includes(key))
        return { unitInLabel: true };
  }
  return null;
}
function parseValue(
  raw: string,
  field: Field,
  unitInLabel: boolean,
): Pick<SourceCandidate, "value" | "issues"> {
  const value = raw.trim(),
    issues: CandidateIssue[] = [];
  if (field.kind === "text")
    return {
      value: value.length > 0 && value.length <= 500 ? value : null,
      issues:
        value.length > 0 && value.length <= 500
          ? ["text_continuation_review"]
          : ["value_format_review"],
    };
  if (field.kind === "boolean")
    return /^(да|true|нет|false)$/i.test(value)
      ? { value: /^(да|true)$/i.test(value), issues }
      : { value: null, issues: ["value_format_review"] };
  if (field.kind === "enum" || field.kind === "enum_list") {
    const list = field.kind === "enum_list" ? value.split(";").map((v) => v.trim()) : [value];
    return list.length <= 32 &&
      list.every((v) => field.options.includes(v)) &&
      new Set(list).size === list.length
      ? { value: field.kind === "enum" ? list[0]! : list, issues }
      : { value: null, issues: ["value_format_review"] };
  }
  const parse = (text: string): number | null => {
    const m = text.trim().match(/^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))\s*([^0-9]*)$/u);
    if (!m) {
      issues.push("value_format_review");
      return null;
    }
    const tail = normalize(m[2]!),
      n = Number(m[1]!.replace(",", "."));
    if (tail ? !units(field).includes(tail) : !unitInLabel) {
      issues.push("unit_missing_or_mismatch");
      return null;
    }
    if (
      !Number.isFinite(n) ||
      Math.abs(n) > 1e9 ||
      (field.kind === "integer" && !Number.isInteger(n)) ||
      (field.minimum !== null && n < field.minimum) ||
      (field.maximum !== null && n > field.maximum)
    ) {
      issues.push("out_of_range");
      return null;
    }
    return n;
  };
  // A comma is a decimal separator, never an inferred list separator. No silent unit conversion.
  if (field.kind === "number_list") {
    const parts = value.split(";");
    if (!parts.length || parts.length > 32) return { value: null, issues: ["value_format_review"] };
    const list = parts.map(parse);
    if (list.includes(null) || new Set(list).size !== list.length)
      return { value: null, issues: [...new Set([...issues, "value_format_review" as const])] };
    return { value: list as number[], issues };
  }
  return { value: parse(value), issues: [...new Set(issues)] };
}

/** Deterministic local proposals. Caller must verify actor, current source approval and model.
 * Original evidence remains untouched. Persist the complete result before creating review buttons.
 * This output must never be submitted directly as a verified technical document.
 */
export function extractSourceCandidates(
  raw: unknown,
  checksum: string,
  family: string,
): CandidateResult {
  const fields = familyFields(family);
  const result: CandidateResult = {
    version: SOURCE_CANDIDATE_VERSION,
    checksum,
    family_code: family,
    candidates: [],
    unmatched_entries: [],
    fields_without_candidates: [],
    warnings: [],
    scanned_units: 0,
    complete: false,
  };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    result.warnings.push("input_invalid");
    return result;
  }
  const source = parsed.data;
  if (source.sha256 !== checksum) {
    result.warnings.push("checksum_mismatch");
    return result;
  }
  if (!source.coverage.complete) result.warnings.push("source_incomplete");
  if (source.warnings.length) result.warnings.push("source_warning");
  let chars = 0,
    stopped = false,
    readable = false;
  const count = () => result.candidates.length + result.unmatched_entries.length;
  const consume = (size: number) => {
    if (stopped) return false;
    if (
      result.scanned_units >= MAX_UNITS ||
      chars + size > MAX_CHARS ||
      count() >= MAX_CANDIDATES
    ) {
      stopped = true;
      result.warnings.push("scan_limit");
      return false;
    }
    chars += size;
    result.scanned_units++;
    return true;
  };
  const add = (
    key: string,
    rawValue: string | null,
    evidence: SourceEvidence,
    flags: CandidateIssue[],
  ) => {
    let matched = false;
    for (const field of fields) {
      const match = matchLabel(key, field);
      if (!match) continue;
      matched = true;
      if (count() >= MAX_CANDIDATES) {
        stopped = true;
        result.warnings.push("scan_limit");
        return;
      }
      const candidate =
        rawValue === null
          ? { value: null, issues: [] }
          : parseValue(rawValue, field, match.unitInLabel);
      result.candidates.push({
        attribute_code: field.code,
        label: field.display_label,
        kind: field.kind,
        unit_code: field.unit_code,
        process: field.processes.length === 1 ? field.processes[0]! : null,
        value: candidate.value,
        conditions_required: [...field.required_context],
        issues: [
          ...new Set<CandidateIssue>([
            "model_scope_review",
            ...flags,
            ...candidate.issues,
            ...(!source.coverage.complete ? ["source_incomplete" as const] : []),
            ...(source.warnings.length ? ["source_warning" as const] : []),
            ...(field.required_context.length ? ["conditions_review" as const] : []),
            ...(field.processes.length !== 1 ? ["process_review" as const] : []),
          ]),
        ],
        evidence,
        state: "needs_human_review",
      });
    }
    if (!matched && key.trim())
      result.unmatched_entries.push({
        label: key,
        raw_value: rawValue,
        evidence,
        state: "needs_field_selection",
      });
  };
  for (const [index, block] of source.blocks.entries()) {
    if (stopped) break;
    let offset = 0,
      codepointOffset = 0;
    for (const line of block.text.split(/\r\n|\r|\n/)) {
      if (!consume(line.length)) break;
      if (line.trim()) readable = true;
      if (line.length <= MAX_LINE) {
        const contentStart = line.search(/\S/u);
        const relativeSeparator =
          contentStart < 0 ? -1 : line.slice(contentStart).search(/[:=\t]/u);
        const separator = relativeSeparator < 0 ? -1 : contentStart + relativeSeparator;
        if (separator > contentStart && contentStart >= 0) {
          const location = block.locator.match(/^page:([1-9][0-9]{0,5})$/);
          const physicalPage = location ? Number(location[1]) : null;
          const conflicts =
            physicalPage !== null && block.page !== undefined && physicalPage !== block.page;
          const locatorKnown = /^(?:page|sheet|paragraph|image|document):[1-9][0-9]{0,5}$/.test(
            block.locator,
          );
          add(
            line.slice(0, separator),
            line.slice(separator + 1),
            {
              kind: "block",
              block: index,
              locator: block.locator,
              page: conflicts ? null : physicalPage,
              start: codepointOffset,
              end: codepointOffset + Array.from(line).length,
              offset_unit: "unicode_codepoints",
              quote: line,
            },
            [
              ...(block.engine === "tesseract-rus-eng" ? ["ocr_review" as const] : []),
              ...(!locatorKnown || conflicts ? ["locator_review" as const] : []),
            ],
          );
        }
      } else {
        if (!result.warnings.includes("scan_limit")) result.warnings.push("scan_limit");
      }
      const newlineLength =
        block.text.slice(offset + line.length, offset + line.length + 2) === "\r\n" ? 2 : 1;
      offset += line.length + newlineLength;
      codepointOffset += Array.from(line).length + newlineLength;
    }
  }
  for (const [index, table] of source.tables.entries()) {
    if (stopped) break;
    for (const [row, cells] of table.rows.entries()) {
      if (!consume(cells.reduce((n, c) => n + c.length, 0))) break;
      if (cells.some((c) => c.trim())) readable = true;
      if (!cells[0]) continue;
      const unitColumn =
        table.header.length === 3 &&
        /^(ед\.?\s*изм\.?|единица(?: измерения)?|unit)$/i.test(table.header[2]!.trim());
      const oneValue =
        (cells.length === 2 && table.header.length <= 2) || (cells.length === 3 && unitColumn);
      const locator = table.row_locators?.[row] ?? null;
      const value = oneValue ? cells[1]! + (unitColumn && cells[2] ? " " + cells[2] : "") : null;
      add(
        cells[0],
        value,
        { kind: "table", table: index, row, locator, header: [...table.header], cells: [...cells] },
        [
          ...(!oneValue ? ["multiple_value_columns" as const] : []),
          ...(!locator ? ["locator_review" as const] : []),
          ...(table.warnings?.length ? ["source_warning" as const] : []),
        ],
      );
    }
  }
  // Conflicting proposals remain side by side, regardless of source order or repetition.
  for (const candidate of result.candidates) {
    const peers = result.candidates.filter(
      (c) =>
        c.attribute_code === candidate.attribute_code &&
        c.process === candidate.process &&
        c.value !== null,
    );
    if (new Set(peers.map((c) => JSON.stringify(c.value))).size > 1)
      candidate.issues.push("conflicting_values");
  }
  result.fields_without_candidates = fields
    .filter((f) => !result.candidates.some((c) => c.attribute_code === f.code))
    .map((f) => ({
      code: f.code,
      label: f.display_label,
      state: "not_found_in_scanned_text" as const,
    }));
  if (!readable) result.warnings.push("no_readable_text");
  result.warnings = [...new Set(result.warnings)];
  result.complete =
    !stopped && !result.warnings.includes("scan_limit") && source.coverage.complete === true;
  return result;
}
