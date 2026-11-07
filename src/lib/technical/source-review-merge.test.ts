import { describe, expect, it } from "vitest";
import {
  sourceFactMergePreview,
  sourceFactMergeSummary,
  sourceFactMergeDetail,
  type SourceFactMergePreview,
} from "./source-review-merge";
import type { TechnicalDocument } from "./schema";

function fixture(): SourceFactMergePreview {
  const source = {
    key: "old",
    kind: "manual" as const,
    publisher: "Учебный изготовитель",
    model: "QA-160",
    title: "Старый паспорт",
    url: "",
    sha256: "a".repeat(64),
    locator: "Страница 2",
    checked_on: "2026-11-07",
  };
  const before: TechnicalDocument = {
    family_code: "power_mma",
    sources: [source],
    values: [
      {
        attribute_code: "mma_current_max_a",
        process: "mma",
        unit_code: "a",
        state: "known",
        value: 160,
        context: {},
        source_key: "old",
      },
      {
        attribute_code: "mma_duty_cycle_pct",
        process: "mma",
        unit_code: "pct",
        state: "known",
        value: 60,
        context: { current_a: 160, temperature_c: 40 },
        source_key: "old",
      },
      {
        attribute_code: "mma_current_min_a",
        process: "mma",
        unit_code: "a",
        state: "unknown",
        value: null,
        context: {},
        source_key: null,
      },
    ],
  };
  return {
    version: "source-fact-merge-v1",
    before_revision: "10000000-0000-4000-8000-000000000001",
    before_document: before,
    after_document: {
      family_code: before.family_code,
      sources: [
        structuredClone(source),
        { ...source, key: "new", title: "Новый паспорт", sha256: "b".repeat(64) },
      ],
      values: [
        { ...structuredClone(before.values[0]!), value: 170, source_key: "new" },
        structuredClone(before.values[1]!),
        structuredClone(before.values[2]!),
        {
          ...structuredClone(before.values[1]!),
          value: 100,
          context: { current_a: 120, temperature_c: 40 },
          source_key: "new",
        },
      ],
    },
    changes: [
      { kind: "replaced", before_index: 0, after_index: 0 },
      { kind: "retained", before_index: 1, after_index: 1 },
      { kind: "retained", before_index: 2, after_index: 2 },
      { kind: "added", before_index: null, after_index: 3 },
    ],
  };
}
describe("Source merge review", () => {
  it("Shows the complete before/after value, source and conditions without changing either document", () => {
    const raw = fixture(),
      saved = structuredClone(raw),
      plan = sourceFactMergePreview.parse(raw);
    expect(sourceFactMergeSummary(plan)).toContain("Заменится: 1");
    expect(sourceFactMergeSummary(plan)).toContain("Останется: 2");
    expect(sourceFactMergeSummary(plan)).toContain("Карточка товара пока не меняется");
    const replacement = sourceFactMergeDetail(plan, 0);
    for (const text of ["160 А", "170 А", "Старый паспорт", "Новый паспорт", "Страница 2"])
      expect(replacement).toContain(text);
    expect(sourceFactMergeDetail(plan, 1)).toContain("Температура: 40 °C");
    expect(sourceFactMergeDetail(plan, 3)).toContain("Ток: 120 А");
    expect(raw).toEqual(saved);
  });
  it("Keeps an unknown value visibly unknown instead of zero or no", () => {
    const detail = sourceFactMergeDetail(sourceFactMergePreview.parse(fixture()), 2);
    expect(detail).toContain("Не указано");
    expect(detail).not.toContain("0 А");
    expect(detail).not.toContain("Нет");
  });
  it("Makes family replacement and every removed value explicit", () => {
    const raw = fixture();
    raw.after_document = { family_code: "power_tig_dc", sources: [], values: [] };
    raw.changes = raw.before_document!.values.map((_, i) => ({
      kind: "removed",
      before_index: i,
      after_index: null,
    }));
    const plan = sourceFactMergePreview.parse(raw);
    expect(sourceFactMergeSummary(plan)).toContain("Меняется вид товара");
    expect(sourceFactMergeSummary(plan)).toContain("Уберётся: 3");
    for (let i = 0; i < 3; i++)
      expect(sourceFactMergeDetail(plan, i)).toContain("сохранится в истории");
  });
  it("Does not conceal a source replacement when the numeric value stays the same", () => {
    const raw = fixture();
    raw.after_document.values[0]!.value = 160;
    const detail = sourceFactMergeDetail(sourceFactMergePreview.parse(raw), 0);
    expect(detail).toContain("Заменится");
    expect(detail).toContain("Новый паспорт");
  });
  it.each([
    ["missing change", (p: SourceFactMergePreview) => p.changes.pop()],
    [
      "duplicate old index",
      (p: SourceFactMergePreview) => {
        p.changes[1]!.before_index = 0;
      },
    ],
    [
      "duplicate new index",
      (p: SourceFactMergePreview) => {
        p.changes[1]!.after_index = 0;
      },
    ],
    [
      "wrong old index",
      (p: SourceFactMergePreview) => {
        p.changes[0]!.before_index = 127;
      },
    ],
    [
      "changed retained value",
      (p: SourceFactMergePreview) => {
        p.after_document.values[1]!.value = 50;
      },
    ],
    [
      "changed retained source",
      (p: SourceFactMergePreview) => {
        p.after_document.sources[0]!.sha256 = "c".repeat(64);
      },
    ],
    [
      "unlabelled same-family removal",
      (p: SourceFactMergePreview) => {
        p.changes[1] = { kind: "removed", before_index: 1, after_index: null };
      },
    ],
    [
      "added replacing an old identity",
      (p: SourceFactMergePreview) => {
        p.changes[0] = { kind: "added", before_index: null, after_index: 0 };
      },
    ],
    [
      "wrong replacement conditions",
      (p: SourceFactMergePreview) => {
        p.after_document.values[0]!.context = { temperature_c: 40 };
      },
    ],
    [
      "source key collision",
      (p: SourceFactMergePreview) => {
        p.after_document.sources[1]!.key = "old";
      },
    ],
    [
      "missing source",
      (p: SourceFactMergePreview) => {
        p.after_document.sources.pop();
      },
    ],
    [
      "missing previous revision",
      (p: SourceFactMergePreview) => {
        p.before_revision = null;
      },
    ],
  ])("Rejects a misleading comparison: %s", (_, mutate) => {
    const raw = fixture();
    mutate(raw);
    expect(sourceFactMergePreview.safeParse(raw).success).toBe(false);
  });
  it("Rejects unknown plan versions and out-of-range navigation", () => {
    const raw = fixture();
    expect(sourceFactMergePreview.safeParse({ ...raw, version: "next" }).success).toBe(false);
    for (const index of [-1, 1.5, 4, 256])
      expect(() => sourceFactMergeDetail(raw, index)).toThrow("SOURCE_FACT_PAGE");
  });
  it("Preserves a full long source locator rather than hiding its important ending", () => {
    const raw = fixture(),
      locator = "Точный раздел ".repeat(50) + "Исключение: только с охлаждением";
    raw.after_document.sources[1]!.locator = locator;
    expect(sourceFactMergeDetail(sourceFactMergePreview.parse(raw), 0)).toContain(locator);
  });
});
