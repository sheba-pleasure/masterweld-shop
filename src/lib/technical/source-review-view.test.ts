import { describe, expect, it } from "vitest";
import { compactId } from "@/lib/import/primary-source-view";
import dictionary from "./dictionary";
import { families } from "./editor";
import { sourceFactInputFields } from "./source-review-input";
import {
  parseSourceFactCallback,
  renderSourceFactFamilies,
  renderSourceFactReview,
  sourceFactButton,
  sourceFactFamilyButton,
  sourceFactMissingInput,
  sourceFactQuote,
  sourceFactReviewResponse,
  type SourceFactReview,
  type SourceFactView,
} from "./source-review-view";

const id = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000002";
const now = Date.parse("2026-11-07T12:00:00Z");
function fixture(): SourceFactReview {
  const line = {
    row_index: 0,
    proposal: {
      attribute_code: "mma_current_max_a",
      label: "Максимальный ток MMA",
      value: 160,
      issues: ["model_scope_review"],
      evidence: {
        kind: "block" as const,
        block: 0,
        locator: "page:1",
        page: 1,
        start: 0,
        end: 25,
        offset_unit: "unicode_codepoints" as const,
        quote: "Максимальный ток MMA: 160 А",
      },
    },
    draft: {
      attribute_code: "mma_current_max_a",
      process: "mma" as const,
      unit_code: "a",
      value: 160,
      context: {},
    },
    decision: "pending" as const,
    locator_override: null,
  };
  const model = {
    state: "selected" as const,
    revision: 1,
    sources_version: 1,
    usable: true,
    choice_id: id,
    identity: {
      manufacturer: "Учебный изготовитель",
      model: "DEV-160",
      variant_mode: "none" as const,
      variant: "",
    },
  };
  return sourceFactReviewResponse.parse({
    ok: true,
    idle: false,
    review: {
      id,
      actor: 101,
      source_id: other,
      product_id: id,
      family_code: "power_mma",
      model_context: model,
      base_version: 0,
      publisher: null,
      revision: 4,
      phase: "reviewing",
      editor_session_id: null,
      prepared_document: null,
      created_at: "2026-11-07T10:00:00+00:00",
      expires_at: "2026-11-08T10:00:00+00:00",
      preview_expires_at: null,
    },
    source_review_id: other,
    document_id: id,
    document_checksum: "a".repeat(64),
    file_name: "[Учебный] Паспорт.pdf",
    source_kind: "manual",
    product_title: "[Учебный] Аппарат",
    usable: true,
    current_model: model,
    counts: { total: 1, pending: 1, accepted: 0, skipped: 0 },
    rows: [line],
    row: line,
    next_pending: 0,
    missing_fields: [
      { code: "mains_nominal_v", label: "Напряжение питания", state: "not_found_in_scanned_text" },
    ],
    warnings: [],
    prompt: null,
  });
}
const actions = (v: SourceFactView) =>
  v.rows
    .flat()
    .map((b) => parseSourceFactCallback(b.callback_data))
    .filter((a) => a?.kind === "review")
    .map((a) => a!.action);
function accepted(v: SourceFactReview) {
  v.row!.decision = "accepted";
  v.rows[0]!.decision = "accepted";
  v.counts.pending = 0;
  v.counts.accepted = 1;
  v.next_pending = null;
}

describe("Source fact callback boundaries", () => {
  it("Uses the saved review ID, version and row for every action", () => {
    const v = fixture(),
      attr = dictionary.attributes.findIndex((a) => a.code === "mma_current_max_a");
    for (const [action, args] of [
      ["row", []],
      ["accept", []],
      ["skip", []],
      ["prompt", [0]],
      ["fields", [0]],
      ["modes", [attr]],
      ["map", [attr, 1]],
      ["quote", [999999]],
      ["missing", [0]],
      ["stop", []],
      ["resume", []],
      ["issues", []],
      ["changes", [255]],
    ] as const) {
      v.review.revision = 2147483647;
      const data = sourceFactButton(v.review, action, 255, ...args);
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(parseSourceFactCallback(data)).toEqual({
        kind: "review",
        id,
        revision: 2147483647,
        action,
        index: 255,
        args,
      });
    }
  });
  it("Rejects malformed IDs, alias padding, overflows, unknown operations and trailing parameters", () => {
    const base = "sf:r:" + compactId(id) + ":4:";
    for (const data of [
      base + "row:256",
      base + "row:-1",
      base + "row:01",
      base + "row:0:1",
      base + "map:0:1",
      base + "prompt:0:999",
      base + "fields:0",
      base + "publish:0",
      base + "quote:0:1000000",
      base + "changes:0:256",
      base.replace(":4:", ":2147483648:") + "row:0",
      base.replace(":4:", ":04:") + "row:0",
      "sf:r:" + compactId(id) + "=:4:row:0",
      "sf:current:1",
      "ps:current",
    ])
      expect(parseSourceFactCallback(data)).toBeNull();
    const alias = compactId(id).slice(0, -1) + "R"; // Noncanonical padding bits, same decoded bytes.
    expect(parseSourceFactCallback("sf:r:" + alias + ":4:row:0")).toBeNull();
  });
  it("Lets a person select any supported family without guessing from a product title", () => {
    const seen: number[] = [];
    for (let page = 0; page < Math.ceil(families.length / 8); page++) {
      const v = renderSourceFactFamilies(other, 4, page);
      expect(v.text).toContain("Цены, ассортимент и публикация не изменятся");
      for (const b of v.rows.flat()) {
        expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
        const a = parseSourceFactCallback(b.callback_data);
        if (a?.kind === "start") seen.push(a.index);
      }
    }
    expect(seen).toEqual(families.map((_, i) => i));
    expect(parseSourceFactCallback(sourceFactFamilyButton(other, 4, 0))).toMatchObject({
      kind: "families",
      sourceReview: other,
    });
    expect(() => renderSourceFactFamilies(other, 4, 999)).toThrow();
  });
});

describe("Human review screens", () => {
  it("Separates the original quote, corrected value, model and decision", () => {
    const v = fixture();
    v.row!.draft!.value = 175;
    const view = renderSourceFactReview(v, "row", 0, 0, now);
    expect(view.text).toContain("175 А");
    expect(view.text).toContain("Максимальный ток MMA: 160 А");
    expect(view.text).toContain("DEV-160");
    expect(view.text).toContain("исправлено человеком");
    expect(view.text).toContain("не удаляя товар");
    expect(actions(view)).toContain("accept");
    expect(actions(view)).toContain("skip");
    expect(view.rows.flat().some((b) => b.callback_data === "di:original:" + id)).toBe(true);
  });
  it("Shows what to fill before acceptance, including measurement conditions", () => {
    const v = fixture();
    v.row!.draft = {
      attribute_code: "mma_duty_cycle_pct",
      unit_code: "pct",
      process: "mma",
      value: 60,
      context: {},
    };
    const view = renderSourceFactReview(v, "row", 0, 0, now);
    expect(view.text).toContain("Сначала заполните");
    expect(view.text).toContain("Ток, А");
    expect(view.text).toContain("Температура");
    expect(actions(view)).not.toContain("accept");
    expect(sourceFactMissingInput(v.row!, "power_mma")).toContain("Ток, А");
    v.row!.draft.context = { current_a: 160, temperature_c: 40 };
    expect(actions(renderSourceFactReview(v, "row", 0, 0, now))).toContain("accept");
    v.row!.proposal.issues!.push("locator_review");
    expect(actions(renderSourceFactReview(v, "row", 0, 0, now))).not.toContain("accept");
    v.row!.locator_override = "Страница 1, таблица 3";
    expect(actions(renderSourceFactReview(v, "row", 0, 0, now))).toContain("accept");
  });
  it("Keeps an unmatched label available for explicit mapping and preserves its quote", () => {
    const v = fixture();
    v.row!.draft = null;
    const view = renderSourceFactReview(v, "row", 0, 0, now);
    expect(view.text).toContain("Сначала выберите характеристику");
    expect(actions(view)).not.toContain("accept");
    const edit = renderSourceFactReview(v, "fix", 0, 0, now);
    expect(actions(edit)).toContain("fields");
    expect(actions(edit)).not.toContain("conditions");
    const fields = renderSourceFactReview(v, "fields", 0, 0, now);
    expect(fields.text).toContain("ввести заново");
    const callback = fields.rows
      .flat()
      .map((b) => parseSourceFactCallback(b.callback_data))
      .find((a) => a?.kind === "review" && a.action === "modes");
    expect(callback?.kind).toBe("review");
    if (callback?.kind !== "review") throw new Error("No field button");
    const modes = renderSourceFactReview(v, "modes", 0, callback.args[0]!, now);
    expect(modes.text).toContain("очистит прежнее значение и условия");
    expect(actions(modes)).toContain("map");
  });
  it("Offers the next pending row after a decision and the summary only when ready", () => {
    const v = fixture();
    accepted(v);
    v.counts.total = 2;
    v.counts.pending = 1;
    v.next_pending = 1;
    const next = renderSourceFactReview(v, "row", 0, 0, now)
      .rows.flat()
      .find((b) => b.text.includes("Следующая строка"));
    expect(parseSourceFactCallback(next!.callback_data)).toMatchObject({ action: "row", index: 1 });
    v.counts.total = 1;
    v.counts.pending = 0;
    v.next_pending = null;
    expect(actions(renderSourceFactReview(v, "list", 0, 0, now))).not.toContain("preview");
    v.review.publisher = "Учебный издатель";
    expect(actions(renderSourceFactReview(v, "row", 0, 0, now))).toContain("preview");
  });
  it("Keeps missing data distinct from a negative characteristic", () => {
    const view = renderSourceFactReview(fixture(), "missing", 0, 0, now);
    expect(view.text).toContain("Напряжение питания");
    expect(view.text).toContain("Это не означает «Нет» у товара");
    expect(actions(view)).not.toContain("accept");
  });
  it("Shows short warnings on the row and all warnings in a separate view", () => {
    const v = fixture();
    v.row!.proposal.issues = [
      "model_scope_review",
      "ocr_review",
      "conditions_review",
      "conflicting_values",
    ];
    const view = renderSourceFactReview(v, "row", 0, 0, now);
    expect(view.text).toContain("Есть ещё предупреждения: 1");
    expect(actions(view)).toContain("issues");
    const all = renderSourceFactReview(v, "issues", 0, 0, now);
    expect(all.text).toContain("Есть другие значения");
    expect(all.text).toContain("исходному распознаванию");
  });
  it("Preserves an exact long Unicode quote across pages without guessing its physical page", () => {
    const v = fixture(),
      quote = "🧰 Строка\r\n".repeat(250);
    v.row!.proposal.evidence = {
      kind: "block",
      block: 1,
      locator: "block:2",
      page: null,
      start: 0,
      end: Array.from(quote).length,
      offset_unit: "unicode_codepoints",
      quote,
    };
    const parts = [];
    for (let i = 0; i < Math.ceil(Array.from(quote).length / 1700); i++) {
      const view = renderSourceFactReview(v, "quote", 0, i, now);
      expect(view.text).not.toContain("Страница 2");
      parts.push(view.text.split("Место: block:2\n\n")[1]!);
    }
    expect(parts.join("")).toBe(quote);
    expect(() => renderSourceFactReview(v, "quote", 0, 999, now)).toThrow("SOURCE_FACT_PAGE");
    v.row!.proposal.evidence = {
      kind: "table",
      table: 0,
      row: 3,
      locator: null,
      header: ["Модель", "Ток\nА"],
      cells: ["A\tB", "160\r\n200"],
    };
    const table = sourceFactQuote(v.row!);
    expect(table).toContain("Ток\nА");
    expect(table).toContain("160\r\n200");
    expect(table).toContain("A\tB");
  });
  it.each(["stale", "expired", "canceled", "handed"] as const)(
    "Offers only read/recovery actions when %s",
    (state) => {
      const v = fixture();
      if (state === "stale") v.usable = false;
      else if (state === "expired") v.review.expires_at = "2026-11-07T11:00:00Z";
      else v.review.phase = state;
      for (const screen of ["row", "fix", "conditions", "fields", "modes", "list"] as const) {
        const view = renderSourceFactReview(v, screen, 0, 0, now);
        for (const mutation of ["prompt", "map", "accept", "skip", "reset", "preview", "resume"])
          expect(actions(view)).not.toContain(mutation);
      }
      expect(renderSourceFactReview(v, "row", 0, 0, now).text).toContain("160 А");
    },
  );
  it("Treats preview values as read-only and explains an expired preview", () => {
    const v = fixture();
    accepted(v);
    v.review.phase = "preview";
    v.review.publisher = "Учебный издатель";
    v.review.preview_expires_at = "2026-11-07T11:00:00Z";
    const view = renderSourceFactReview(v, "list", 0, 0, now);
    expect(view.text).toContain("Время предпросмотра истекло");
    expect(actions(view)).toContain("edit");
    const detail = renderSourceFactReview(v, "row", 0, 0, now);
    expect(detail.text).toContain("160 А");
    expect(actions(detail)).not.toContain("accept");
    expect(actions(detail)).not.toContain("prompt");
  });
  it("Offers a read-only comparison from preview and keeps it readable after the source becomes stale", () => {
    const v = fixture();
    accepted(v);
    v.review.phase = "preview";
    v.review.merge_preview = {
      version: "source-fact-merge-v1",
      before_revision: null,
      before_document: null,
      after_document: {
        family_code: "power_mma",
        sources: [
          {
            key: "new",
            kind: "manual",
            publisher: "Учебный",
            model: "DEV-160",
            title: "Паспорт",
            url: "",
            sha256: "a".repeat(64),
            locator: "Страница 1",
            checked_on: "2026-11-07",
          },
        ],
        values: [{ ...v.row!.draft!, process: "mma", state: "known", source_key: "new" }],
      },
      changes: [{ kind: "added", before_index: null, after_index: 0 }],
    };
    expect(actions(renderSourceFactReview(v, "list", 0, 0, now))).toContain("changes");
    expect(renderSourceFactReview(v, "list", 0, 0, now).text).toContain("Добавится: 1");
    for (const usable of [true, false]) {
      v.usable = usable;
      const detail = renderSourceFactReview(v, "changes", 0, 0, now);
      expect(detail.text).toContain("160 А");
      expect(actions(detail)).toEqual(["list"]);
      expect(actions(detail)).not.toContain("preview");
    }
    const wrongFamily = structuredClone(v);
    wrongFamily.review.family_code = "power_tig_dc";
    expect(sourceFactReviewResponse.safeParse(wrongFamily).success).toBe(false);
  });
  it("Uses parsed timestamps instead of comparing timezone strings", () => {
    const v = fixture();
    v.review.expires_at = "2026-11-07T11:30:00-02:00"; // 13:30 UTC, still editable.
    expect(actions(renderSourceFactReview(v, "row", 0, 0, now))).toContain("accept");
  });
  it("Keeps recovery buttons bound to the persisted question row", () => {
    const v = fixture();
    v.prompt = {
      actor: 101,
      review_id: id,
      revision: 4,
      row_index: 0,
      field: "value",
      message_id: 50,
      expires_at: "2026-11-08T10:00:00Z",
    };
    const view = renderSourceFactReview(v, "list", 0, 0, now);
    expect(actions(view)).toContain("resume");
    expect(actions(view)).toContain("stop");
    expect(
      sourceFactReviewResponse.safeParse({ ...v, prompt: { ...v.prompt, actor: 102 } }).success,
    ).toBe(false);
    expect(
      sourceFactReviewResponse.safeParse({ ...v, prompt: { ...v.prompt, revision: 5 } }).success,
    ).toBe(false);
    expect(
      sourceFactReviewResponse.safeParse({ ...v, counts: { ...v.counts, pending: 0 } }).success,
    ).toBe(false);
  });
  it("Accepts the full 256-row bound and rejects row/field navigation outside the review", () => {
    const v = fixture();
    v.counts.total = 256;
    v.counts.pending = 256;
    expect(sourceFactReviewResponse.safeParse(v).success).toBe(true);
    expect(() => renderSourceFactReview(v, "row", 1, 0, now)).toThrow("SOURCE_FACT_ROW");
    expect(() => renderSourceFactReview(v, "fields", 0, 999, now)).toThrow("SOURCE_FACT_PAGE");
    const foreign = dictionary.attributes.findIndex(
      (a) =>
        !dictionary.bindings.some(
          (b) => b.family_code === "power_mma" && b.attribute_code === a.code,
        ),
    );
    expect(() => renderSourceFactReview(v, "modes", 0, foreign, now)).toThrow();
  });
  it("Generates bounded buttons for all correction fields", () => {
    const v = fixture();
    const view = renderSourceFactReview(v, "conditions", 0, 0, now);
    const fields = view.rows
      .flat()
      .map((b) => parseSourceFactCallback(b.callback_data))
      .filter((a) => a?.kind === "review" && a.action === "prompt")
      .map((a) => (a?.kind === "review" ? sourceFactInputFields[a.args[0]!] : undefined));
    expect(fields).toContain("temperature_c");
    expect(fields).toContain("cooling");
    for (const b of view.rows.flat())
      expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
  });
});
