import { z } from "zod";
import { compactId, expandId } from "@/lib/import/primary-source-view";
import dictionary from "./dictionary";
import { families, technicalFieldDefinition } from "./editor";
import { technicalModelContext } from "./model-binding";
import {
  formatTechnicalContext,
  formatTechnicalValue,
  processLabels,
  type TechnicalValue,
} from "./presentation";
import { technicalContext, technicalDocument, technicalProcess } from "./schema";
import { sourceFactInputField, sourceFactInputFields } from "./source-review-input";

const revision = z.number().int().min(0).max(2147483647);
const index = z.number().int().min(0).max(255);
const count = z.number().int().min(0).max(256);
const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const scalar = z
  .union([
    z.number().finite(),
    z.boolean(),
    z.string().max(4000),
    z.array(z.number().finite()).max(32),
    z.array(z.string().max(500)).max(32),
  ])
  .nullable();
const evidence = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("block"),
    block: z.number().int().nonnegative(),
    locator: z.string().max(1000),
    page: z.number().int().positive().nullable(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    offset_unit: z.literal("unicode_codepoints"),
    quote: z.string().max(4000),
  }),
  z.object({
    kind: z.literal("table"),
    table: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    locator: z.string().max(1000).nullable(),
    header: z.array(z.string().max(4000)).max(128),
    cells: z.array(z.string().max(4000)).max(128),
  }),
]);
const row = z.object({
  row_index: index,
  proposal: z.object({
    attribute_code: identifier.optional(),
    label: z.string().max(4000).optional(),
    value: scalar.optional(),
    raw_value: z.string().max(4000).nullable().optional(),
    issues: z.array(z.string().max(100)).max(32).optional(),
    evidence,
  }),
  draft: z
    .object({
      attribute_code: identifier,
      process: technicalProcess.nullable(),
      unit_code: identifier,
      value: scalar,
      context: technicalContext,
    })
    .nullable(),
  decision: z.enum(["pending", "accepted", "skipped"]),
  locator_override: z.string().max(1000).nullable(),
});
export const sourceFactReviewResponse = z
  .object({
    ok: z.literal(true),
    idle: z.literal(false),
    review: z.object({
      id: z.string().uuid(),
      actor: z.number().int().positive().safe(),
      source_id: z.string().uuid(),
      product_id: z.string().uuid(),
      family_code: identifier,
      model_context: technicalModelContext,
      base_version: z.number().int().nonnegative().safe(),
      publisher: z.string().max(1000).nullable(),
      revision,
      phase: z.enum(["reviewing", "preview", "handed", "canceled", "expired"]),
      editor_session_id: z.string().uuid().nullable(),
      prepared_document: technicalDocument.nullable(),
      created_at: timestamp,
      expires_at: timestamp,
      preview_expires_at: timestamp.nullable(),
    }),
    source_review_id: z.string().uuid(),
    document_id: z.string().uuid(),
    document_checksum: z.string().regex(/^[0-9a-f]{64}$/),
    file_name: z.string().max(1000),
    source_kind: z.enum(["manual", "manufacturer", "test_report", "supplier"]),
    product_title: z.string(),
    usable: z.boolean(),
    current_model: technicalModelContext,
    counts: z.object({ total: count, pending: count, accepted: count, skipped: count }),
    rows: z.array(row).max(8),
    row: row.nullable(),
    next_pending: index.nullable(),
    missing_fields: z
      .array(
        z.object({
          code: identifier,
          label: z.string().max(1000),
          state: z.literal("not_found_in_scanned_text"),
        }),
      )
      .max(512),
    warnings: z.array(z.string().max(100)).max(32),
    prompt: z
      .object({
        actor: z.number().int().positive().safe(),
        review_id: z.string().uuid(),
        revision,
        row_index: index,
        field: sourceFactInputField,
        message_id: z.number().int().positive().safe().nullable(),
        expires_at: timestamp,
      })
      .nullable(),
  })
  .superRefine((v, ctx) => {
    const c = v.counts,
      p = v.prompt;
    if (
      c.total !== c.pending + c.accepted + c.skipped ||
      c.total < 1 ||
      new Set(v.rows.map((r) => r.row_index)).size !== v.rows.length ||
      v.rows.some((r) => r.row_index >= c.total) ||
      (v.row && v.row.row_index >= c.total) ||
      (v.next_pending === null) !== (c.pending === 0) ||
      (v.next_pending !== null && v.next_pending >= c.total) ||
      (p &&
        (p.actor !== v.review.actor ||
          p.review_id !== v.review.id ||
          p.revision !== v.review.revision ||
          p.row_index >= c.total))
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SOURCE_FACT_RESULT" });
    }
  });
export type SourceFactReview = z.infer<typeof sourceFactReviewResponse>;
export type SourceFactRow = z.infer<typeof row>;
export type SourceFactView = { text: string; rows: { text: string; callback_data: string }[][] };

// All row indices address immutable review rows. Dictionary indices remain append-only.
export const sourceFactActions = [
  "list",
  "row",
  "fix",
  "fields",
  "modes",
  "conditions",
  "quote",
  "missing",
  "issues",
  "askcancel",
  "prompt",
  "map",
  "accept",
  "skip",
  "reset",
  "preview",
  "edit",
  "cancel",
  "stop",
  "resume",
] as const;
export type SourceFactAction = (typeof sourceFactActions)[number];
export type SourceFactCallback =
  | { kind: "current" }
  | { kind: "families"; sourceReview: string; revision: number; index: number }
  | { kind: "start"; sourceReview: string; revision: number; index: number }
  | {
      kind: "review";
      id: string;
      revision: number;
      action: SourceFactAction;
      index: number;
      args: number[];
    };

const integer = (s: string) => /^(0|[1-9][0-9]*)$/.test(s) && Number(s) <= 2147483647;
const processes = technicalProcess.options;
function validArgs(action: SourceFactAction, args: number[]) {
  if (action === "map")
    return args.length === 2 && !!dictionary.attributes[args[0]!] && !!processes[args[1]!];
  if (action === "prompt") return args.length === 1 && !!sourceFactInputFields[args[0]!];
  if (action === "modes") return args.length === 1 && !!dictionary.attributes[args[0]!];
  if (["fields", "quote", "missing"].includes(action))
    return args.length === 1 && args[0]! <= 999999;
  return args.length === 0;
}
export function parseSourceFactCallback(data: string): SourceFactCallback | null {
  if (new TextEncoder().encode(data).length > 64) return null;
  if (data === "sf:current") return { kind: "current" };
  const bits = data.split(":");
  if (bits[0] !== "sf") return null;
  if (bits[1] === "f" || bits[1] === "s") {
    if (bits.length !== 5 || !integer(bits[3]!) || !integer(bits[4]!)) return null;
    const sourceReview = expandId(bits[2]!);
    const n = Number(bits[4]);
    if (
      !sourceReview ||
      (bits[1] === "s" ? !families[n] : n > Math.floor((families.length - 1) / 8))
    )
      return null;
    return {
      kind: bits[1] === "f" ? "families" : "start",
      sourceReview,
      revision: Number(bits[3]),
      index: n,
    };
  }
  if (
    bits[1] !== "r" ||
    bits.length < 6 ||
    !integer(bits[3]!) ||
    !integer(bits[5]!) ||
    Number(bits[5]) > 255 ||
    !sourceFactActions.includes(bits[4] as SourceFactAction)
  )
    return null;
  const id = expandId(bits[2]!),
    action = bits[4] as SourceFactAction;
  if (!id || bits.slice(6).some((v) => !integer(v))) return null;
  const args = bits.slice(6).map(Number);
  if (!validArgs(action, args)) return null;
  return { kind: "review", id, revision: Number(bits[3]), action, index: Number(bits[5]), args };
}
export function sourceFactButton(
  r: Pick<SourceFactReview["review"], "id" | "revision">,
  action: SourceFactAction,
  rowIndex = 0,
  ...args: number[]
) {
  const data = ["sf", "r", compactId(r.id), r.revision, action, rowIndex, ...args].join(":");
  if (!parseSourceFactCallback(data)) throw new Error("SOURCE_FACT_CALLBACK");
  return data;
}
export function sourceFactFamilyButton(id: string, rev: number, n: number, start = false) {
  const data = ["sf", start ? "s" : "f", compactId(id), rev, n].join(":");
  if (!parseSourceFactCallback(data)) throw new Error("SOURCE_FACT_CALLBACK");
  return data;
}
const short = (s: string, n = 80) => {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join("") + "…";
};
const label = (r: SourceFactRow, family: string) =>
  r.draft
    ? technicalFieldDefinition(family, r.draft.attribute_code).label
    : r.proposal.label || "Название параметра не определено";
const contextLabels: Record<string, string> = {
  current_a: "Ток, А",
  temperature_c: "Температура, °C",
  pressure_bar: "Давление, бар",
  gas: "Защитный газ",
  cooling: "Охлаждение",
  duty_pct: "Продолжительность нагрузки, %",
  material: "Материал",
  diameter_mm: "Диаметр, мм",
};
const issueLabels: Record<string, string> = {
  model_scope_review: "Сверьте, что значение относится именно к выбранной модели и модификации.",
  ocr_review: "Текст распознан с изображения. Проверьте цифры и обозначения по оригиналу.",
  source_incomplete:
    "Документ обработан не полностью. Нужные сведения могут быть на другой странице.",
  source_warning: "При обработке документа есть предупреждения. Сверьтесь с оригиналом.",
  locator_review: "Точное место в оригинале требует уточнения.",
  multiple_value_columns: "В таблице несколько колонок значений. Выберите значение своей модели.",
  unit_missing_or_mismatch: "Единица отсутствует или отличается. Нельзя просто перенести число.",
  value_format_review:
    "Значение требует исправления формата. Диапазон нельзя сокращать до одного числа.",
  out_of_range: "Значение вне допустимого диапазона. Проверьте цифры и единицу.",
  process_review: "Не определён режим сварки. Выберите его по документу.",
  conditions_review: "Проверьте условия измерения: например, ток и температуру.",
  text_continuation_review: "Проверьте продолжение фразы и ограничения в оригинале.",
  conflicting_values:
    "Есть другие значения той же характеристики. Сверьте модель и условия измерения.",
};
const decision = {
  pending: "Нужно проверить",
  accepted: "Проверено человеком",
  skipped: "Пропущено",
};
const icon = { pending: "🔎", accepted: "✅", skipped: "⏭" };
function formatValue(r: SourceFactRow, family: string) {
  if (!r.draft) return "Сначала выберите характеристику.";
  if (r.draft.value === null) return "Значение ещё не выбрано.";
  const a = technicalFieldDefinition(family, r.draft.attribute_code);
  const unit = dictionary.units.find((u) => u.code === r.draft!.unit_code);
  if (!unit || a.unit_code !== r.draft.unit_code) throw new Error("SOURCE_FACT_RESULT");
  return formatTechnicalValue({
    code: a.code,
    label: a.label,
    kind: a.kind as TechnicalValue["kind"],
    process: r.draft.process ?? "general",
    state: "known",
    value: r.draft.value,
    unit,
    context: r.draft.context,
    source_key: null,
  });
}
export function sourceFactMissingInput(r: SourceFactRow, family: string): string[] {
  const missing: string[] = [];
  if (!r.draft) return ["Назначение поля и режим", "Значение"];
  const a = technicalFieldDefinition(family, r.draft.attribute_code);
  if (!r.draft.process) missing.push("Режим");
  if (r.draft.value === null) missing.push("Значение");
  for (const key of a.required_context)
    if (!(key in r.draft.context)) missing.push(contextLabels[key] ?? key);
  for (const [key, expected] of Object.entries(a.fixed_context))
    if (
      !(key in r.draft.context) ||
      r.draft.context[key as keyof typeof r.draft.context] !== expected
    )
      missing.push(
        "Условие «" +
          (contextLabels[key] ?? key) +
          "» = " +
          String(expected) +
          " согласно определению характеристики",
      );
  if (
    !(r.locator_override || r.proposal.evidence.locator) ||
    (r.proposal.issues?.includes("locator_review") && !r.locator_override)
  )
    missing.push("Место в оригинале");
  return missing;
}
export function sourceFactQuote(r: SourceFactRow) {
  const e = r.proposal.evidence;
  if (e.kind === "block") return e.quote;
  return (
    "Заголовки исходной таблицы:\n" +
    e.header.map((s, i) => i + 1 + ". " + s).join("\n") +
    "\n\nЯчейки исходной строки:\n" +
    e.cells.map((s, i) => i + 1 + ". " + s).join("\n")
  );
}
function location(r: SourceFactRow) {
  const e = r.proposal.evidence;
  if (r.locator_override) return "Уточнено человеком: " + r.locator_override;
  if (e.kind === "block" && e.page !== null) return "Страница " + e.page;
  return e.locator || "Точное место ещё не указано";
}
export function renderSourceFactFamilies(
  sourceReview: string,
  rev: number,
  page = 0,
): SourceFactView {
  if (!Number.isInteger(page) || page < 0 || page > Math.floor((families.length - 1) / 8))
    throw new Error("SOURCE_FACT_PAGE");
  const rows: SourceFactView["rows"] = families.slice(page * 8, page * 8 + 8).map((f, i) => [
    {
      text: short(f.label, 54),
      callback_data: sourceFactFamilyButton(sourceReview, rev, page * 8 + i, true),
    },
  ]);
  if (page)
    rows.push([
      {
        text: "⬅️ Назад по списку",
        callback_data: sourceFactFamilyButton(sourceReview, rev, page - 1),
      },
    ]);
  if ((page + 1) * 8 < families.length)
    rows.push([
      {
        text: "➡️ Другие виды товаров",
        callback_data: sourceFactFamilyButton(sourceReview, rev, page + 1),
      },
    ]);
  rows.push([{ text: "↩️ К документу", callback_data: "pds:g:" + compactId(sourceReview) }]);
  return {
    text: "📦 Какой это вид товара?\n\nВыберите по документу и модели. После выбора появится разбор для проверки. Цены, ассортимент и публикация не изменятся.",
    rows,
  };
}
export function renderSourceFactReview(
  v: SourceFactReview,
  screen: SourceFactAction = "list",
  rowIndex = 0,
  arg = 0,
  now = Date.now(),
): SourceFactView {
  const r = v.review,
    item = v.row,
    rows: SourceFactView["rows"] = [];
  const add = (text: string, action: SourceFactAction, i = rowIndex, ...params: number[]) =>
    rows.push([{ text, callback_data: sourceFactButton(r, action, i, ...params) }]);
  const back = () => add("↩️ К списку характеристик", "list", Math.floor(rowIndex / 8) * 8);
  const original = () =>
    rows.push(
      [{ text: "📎 Скачать оригинал документа", callback_data: "di:original:" + v.document_id }],
      [
        {
          text: "📘 Проверка документа и модели",
          callback_data: "pds:g:" + compactId(v.source_review_id),
        },
      ],
    );
  const model = r.model_context.identity;
  let text =
    "🧾 Проверка характеристик\n" +
    short(v.product_title, 140) +
    (model
      ? "\nМодель: " +
        short(
          model.manufacturer +
            " · " +
            model.model +
            (model.variant_mode === "specified" ? " · " + model.variant : ""),
          200,
        )
      : "") +
    "\nДокумент: " +
    short(v.file_name, 120) +
    "\n\n";
  const alive = Date.parse(r.expires_at) > now;
  const editable = v.usable && alive && r.phase === "reviewing";
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= v.counts.total)
    throw new Error("SOURCE_FACT_ROW");
  const terminal = ["canceled", "expired", "handed"].includes(r.phase);
  // Viewing old evidence is always read-only. Never render a mutation button for stale source/model.
  if (!v.usable || !alive || terminal) {
    text +=
      r.phase === "canceled"
        ? "Разбор закрыт. Исправления и решения сохранены в истории."
        : r.phase === "handed"
          ? "Результат передан в редактор характеристик. Это не публикация товара."
          : !alive
            ? "Срок разбора истёк. Изменения сохранены; для нового решения нужна новая проверка."
            : "Документ, модель или карточка изменились. Сохранённые решения нельзя применить к текущему товару.";
    if (r.phase === "reviewing" || r.phase === "preview")
      add("Закрыть устаревший разбор", "askcancel");
    if (r.editor_session_id)
      rows.push([
        {
          text: "⚙️ Открыть редактор характеристик",
          callback_data: "te:" + r.editor_session_id + ":0:resume",
        },
      ]);
    text += "\n\n";
    if (!["row", "quote", "missing", "issues", "askcancel"].includes(screen)) {
      for (const line of v.rows)
        add(
          icon[line.decision] +
            " " +
            (line.row_index + 1) +
            ". " +
            short(label(line, r.family_code), 48),
          "row",
          line.row_index,
        );
      const offset = Math.floor(rowIndex / 8) * 8;
      if (offset) add("⬅️ Предыдущие строки", "list", offset - 8);
      if (offset + 8 < v.counts.total) add("➡️ Следующие строки", "list", offset + 8);
      original();
      return { text, rows };
    }
    rows.length = 0;
  }
  if (screen === "askcancel") {
    text +=
      "Закрыть весь разбор?\n\nСохранённые исправления останутся в истории. Ничего не импортируется и не публикуется.";
    if (!terminal) add("Да, закрыть этот разбор", "cancel");
    back();
    return { text, rows };
  }
  if (screen === "quote") {
    if (!item || item.row_index !== rowIndex) throw new Error("SOURCE_FACT_ROW");
    const chars = Array.from(sourceFactQuote(item));
    const parts = Math.max(1, Math.ceil(chars.length / 1700));
    if (!Number.isInteger(arg) || arg < 0 || arg >= parts) throw new Error("SOURCE_FACT_PAGE");
    text +=
      "📄 Точный фрагмент · " +
      (arg + 1) +
      "/" +
      parts +
      "\nМесто: " +
      short(location(item), 300) +
      "\n\n" +
      chars.slice(arg * 1700, (arg + 1) * 1700).join("");
    if (arg) add("⬅️ Предыдущая часть", "quote", rowIndex, arg - 1);
    if (arg + 1 < parts) add("➡️ Следующая часть", "quote", rowIndex, arg + 1);
    add("↩️ К характеристике", "row");
    original();
    return { text, rows };
  }
  if (r.phase === "preview" && !["row", "missing", "issues"].includes(screen)) {
    text +=
      "📋 Предпросмотр\nПроверено: " +
      v.counts.accepted +
      ". Пропущено: " +
      v.counts.skipped +
      ".\nИздатель: " +
      short(r.publisher ?? "Не указан", 200) +
      "\n\nЭто выбранные предложения, ещё не характеристики на сайте.";
    if (!r.preview_expires_at || Date.parse(r.preview_expires_at) <= now)
      text += "\nВремя предпросмотра истекло. Вернитесь к строкам и проверьте итог заново.";
    // Handoff is intentionally absent until source dependency guards and the atomic transfer are ready.
    text += "\nПередача в редактор пока недоступна в этой разрабатываемой версии.";
    for (const line of v.rows)
      add(
        icon[line.decision] +
          " " +
          (line.row_index + 1) +
          ". " +
          short(label(line, r.family_code), 48),
        "row",
        line.row_index,
      );
    const offset = Math.floor(rowIndex / 8) * 8;
    if (offset) add("⬅️ Предыдущие строки", "list", offset - 8);
    if (offset + 8 < v.counts.total) add("➡️ Следующие строки", "list", offset + 8);
    add("✏️ Вернуться к проверке строк", "edit");
    original();
    return { text, rows };
  }
  if (screen === "missing") {
    const page = v.missing_fields.slice(arg * 8, arg * 8 + 8);
    if (!Number.isInteger(arg) || arg < 0 || (arg > 0 && !page.length))
      throw new Error("SOURCE_FACT_PAGE");
    text +=
      "🔍 Не найдено в просмотренном тексте\n\n" +
      (page.length ? page.map((f) => "• " + f.label).join("\n") : "Таких полей нет.") +
      "\n\nЭто не означает «Нет» у товара. Список полей пока неполный; проверьте другие страницы и документы.";
    if (arg) add("⬅️ Предыдущие поля", "missing", rowIndex, arg - 1);
    if ((arg + 1) * 8 < v.missing_fields.length)
      add("➡️ Следующие поля", "missing", rowIndex, arg + 1);
    back();
    original();
    return { text, rows };
  }
  if (screen === "list") {
    text +=
      "Осталось проверить: " +
      v.counts.pending +
      "\nПроверено: " +
      v.counts.accepted +
      " · Пропущено: " +
      v.counts.skipped +
      "\n\nОткройте строку, сверьтесь с документом и выберите решение.";
    if (v.warnings.length)
      text +=
        "\n⚠️ Распознавание имеет ограничения. Сверяйте оригинал, в том числе непрочитанные страницы.";
    if (v.prompt) {
      text += "\n\n✏️ Открыт вопрос к строке " + (v.prompt.row_index + 1) + ".";
      add("✏️ Продолжить ответ на вопрос", "resume", v.prompt.row_index);
      add("Отменить только вопрос", "stop", v.prompt.row_index);
    }
    for (const line of v.rows)
      add(
        icon[line.decision] +
          " " +
          (line.row_index + 1) +
          ". " +
          short(label(line, r.family_code), 48),
        "row",
        line.row_index,
      );
    const offset = Math.floor(rowIndex / 8) * 8;
    if (offset) add("⬅️ Предыдущие строки", "list", offset - 8);
    if (offset + 8 < v.counts.total) add("➡️ Следующие строки", "list", offset + 8);
    add(
      r.publisher ? "📎 Изменить издателя документа" : "📎 Указать издателя документа",
      "prompt",
      0,
      sourceFactInputFields.indexOf("publisher"),
    );
    add("🔍 Какие сведения не найдены", "missing", rowIndex, 0);
    if (!v.counts.pending && v.counts.accepted && r.publisher && !v.prompt)
      add("📋 Проверить итог", "preview");
    else
      text +=
        "\n\nДля итога нужно решить по каждой строке, выбрать хотя бы одну характеристику и указать издателя.";
    add("Закрыть весь разбор", "askcancel");
    original();
    return { text, rows };
  }
  if (!item || item.row_index !== rowIndex) throw new Error("SOURCE_FACT_ROW");
  text +=
    "Строка " +
    (rowIndex + 1) +
    " из " +
    v.counts.total +
    "\n" +
    short(label(item, r.family_code), 160) +
    "\n" +
    icon[item.decision] +
    " " +
    decision[item.decision] +
    "\n\n";
  if (screen === "issues") {
    text +=
      "⚠️ Что нужно сверить по оригиналу\n\n" +
      (item.proposal.issues ?? [])
        .map(
          (issue) =>
            "• " +
            (issueLabels[issue] ?? "Есть дополнительное предупреждение. Сверьтесь с оригиналом."),
        )
        .join("\n\n") +
      "\n\nПредупреждения относятся к исходному распознаванию. Ваши исправления сохраняются отдельно.";
    add("📄 Прочитать точную цитату", "quote", rowIndex, 0);
  } else if (screen === "fields") {
    const fields = dictionary.bindings.filter((b) => b.family_code === r.family_code);
    if (!Number.isInteger(arg) || arg < 0 || (arg > 0 && arg * 8 >= fields.length))
      throw new Error("SOURCE_FACT_PAGE");
    text +=
      "Какую характеристику означает строка?\nВыберите по смыслу исходной подписи. Значение и условия потребуется ввести заново.";
    fields.slice(arg * 8, arg * 8 + 8).forEach((f) => {
      const n = dictionary.attributes.findIndex((a) => a.code === f.attribute_code);
      add(
        short(technicalFieldDefinition(r.family_code, f.attribute_code).label, 54),
        "modes",
        rowIndex,
        n,
      );
    });
    if (arg) add("⬅️ Предыдущие поля", "fields", rowIndex, arg - 1);
    if ((arg + 1) * 8 < fields.length) add("➡️ Другие поля", "fields", rowIndex, arg + 1);
  } else if (screen === "modes") {
    const attr = dictionary.attributes[arg];
    if (!attr) throw new Error("SOURCE_FACT_ATTRIBUTE");
    const a = technicalFieldDefinition(r.family_code, attr.code);
    text +=
      "Для какого режима указано значение?\n" +
      a.label +
      "\nВыбор заменит назначение строки и очистит прежнее значение и условия. Затем сверьте и заполните их заново.";
    for (const p of processes.filter((p) => a.processes.includes(p)))
      add(processLabels[p], "map", rowIndex, arg, processes.indexOf(p));
  } else if (screen === "conditions") {
    if (!item.draft) throw new Error("SOURCE_FACT_ATTRIBUTE");
    const a = technicalFieldDefinition(r.family_code, item.draft.attribute_code);
    text +=
      "🔎 Условия измерения\n" +
      (formatTechnicalContext(item.draft.context).join("\n") || "Пока не указаны.") +
      "\n\nОбязательно: " +
      (a.required_context.map((k) => contextLabels[k] ?? k).join(", ") ||
        "Для этого поля нет обязательных условий.") +
      "\nВыберите условие, которое указано в документе. Не подставляйте пример.";
    for (const [field, title] of Object.entries(contextLabels)) {
      const n = sourceFactInputFields.indexOf(field as (typeof sourceFactInputFields)[number]);
      add(title, "prompt", rowIndex, n);
    }
  } else if (screen === "fix") {
    text +=
      "Что исправить?\nНачало ввода снимет отметку «Проверено». Изменения сохранятся в разборе; затем строку нужно проверить снова.";
    if (item.draft) {
      add("✏️ Значение", "prompt", rowIndex, 0);
      add("🔎 Условия измерения", "conditions");
    }
    add("📌 Назначение поля и режим", "fields", rowIndex, 0);
    add("📍 Место в оригинале", "prompt", rowIndex, sourceFactInputFields.indexOf("locator"));
  } else {
    text +=
      "Предлагаемое значение: " +
      short(formatValue(item, r.family_code), 500) +
      "\nРежим: " +
      (item.draft?.process ? processLabels[item.draft.process] : "Нужно выбрать по документу") +
      "\nУсловия: " +
      (item.draft
        ? formatTechnicalContext(item.draft.context).join("; ") || "Не указаны"
        : "Не указаны") +
      "\n\n📄 Исходный фрагмент\n" +
      short(sourceFactQuote(item), 350) +
      "\nМесто: " +
      short(location(item), 220);
    const issues = item.proposal.issues ?? [];
    if (issues.length)
      text +=
        "\n\n⚠️ Что проверить\n" +
        issues
          .slice(0, 3)
          .map(
            (issue) =>
              "• " +
              (issueLabels[issue] ?? "Есть дополнительное предупреждение. Сверьтесь с оригиналом."),
          )
          .join("\n");
    if (issues.length > 3) {
      text += "\nЕсть ещё предупреждения: " + (issues.length - 3) + ".";
      add("⚠️ Все предупреждения по строке", "issues");
    }
    if (
      item.proposal.value !== undefined &&
      JSON.stringify(item.proposal.value) !== JSON.stringify(item.draft?.value)
    )
      text += "\n\n✏️ Значение исправлено человеком; исходный фрагмент сохранён.";
    add("📄 Прочитать точную цитату", "quote", rowIndex, 0);
    if (editable) {
      const missing = sourceFactMissingInput(item, r.family_code);
      if (missing.length) text += "\n\nСначала заполните: " + missing.join("; ") + ".";
      if (item.decision !== "accepted" && !missing.length)
        add("✅ Проверено — использовать", "accept");
      add("✏️ Исправить строку", "fix");
      if (item.decision !== "skipped") add("⏭ Пропустить эту строку", "skip");
      if (item.decision !== "pending") {
        add("🔄 Проверить заново", "reset");
        if (v.next_pending !== null) add("➡️ Следующая строка для проверки", "row", v.next_pending);
        else if (v.counts.accepted && r.publisher && !v.prompt) add("📋 Проверить итог", "preview");
        else if (!r.publisher)
          add(
            "📎 Указать издателя документа",
            "prompt",
            rowIndex,
            sourceFactInputFields.indexOf("publisher"),
          );
      }
      text +=
        "\n\n«Проверено» включает строку в итог. «Пропустить» исключает её из этого разбора, не удаляя товар.";
    }
  }
  if (screen !== "row") add("↩️ К строке", "row");
  back();
  original();
  return { text, rows };
}
