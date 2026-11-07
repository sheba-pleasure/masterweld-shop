import { z } from "zod";
import { technicalModelContext, type TechnicalModelContext } from "@/lib/technical/model-binding";

function modelContextText(context: TechnicalModelContext) {
  let text = context.usable
    ? "🎯 Выбранная модель:"
    : "⚠️ Сначала проверьте и выберите модель товара.";
  if (context.identity) {
    const i = context.identity;
    text +=
      "\nПроизводитель: " +
      i.manufacturer +
      "\nМодель: " +
      i.model +
      "\nМодификация: " +
      (i.variant_mode === "none" ? "Отдельной модификации нет" : i.variant);
  }
  return text;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function compactId(id: string) {
  if (!uuid.test(id)) throw new Error("SOURCE_ID");
  const bytes = id
    .replaceAll("-", "")
    .match(/../g)!
    .map((v) => Number.parseInt(v, 16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function expandId(id: string) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
  try {
    const hex = Array.from(atob(id.replaceAll("-", "+").replaceAll("_", "/") + "=="))
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
    const full =
      hex.slice(0, 8) +
      "-" +
      hex.slice(8, 12) +
      "-" +
      hex.slice(12, 16) +
      "-" +
      hex.slice(16, 20) +
      "-" +
      hex.slice(20);
    return compactId(full) === id ? full : null;
  } catch {
    return null;
  }
}
export const sourceKinds = ["manual", "manufacturer", "test_report", "supplier"] as const;
const kind = z.enum(sourceKinds);
export const sourceReviewResponse = z.object({
  ok: z.literal(true),
  product_id: z.string().uuid(),
  title: z.string(),
  current_model: technicalModelContext,
  active_review: z.string().uuid().nullable(),
  page: z.number().int().nonnegative(),
  pages: z.number().int().positive(),
  sources: z
    .array(
      z.object({
        review_id: z.string().uuid(),
        source_kind: kind,
        file_name: z.string(),
        withdrawn_at: z.string().nullable(),
        usable: z.boolean(),
      }),
    )
    .nullable(),
  review: z
    .object({
      id: z.string().uuid(),
      product_id: z.string().uuid(),
      revision: z.number().int().nonnegative(),
      phase: z.enum([
        "draft",
        "preview",
        "confirmed",
        "canceled",
        "expired",
        "withdraw_preview",
        "withdrawn",
      ]),
      model_context: technicalModelContext,
      model_matches: z.boolean(),
      source_kind: kind.nullable(),
      source_id: z.string().uuid().nullable(),
      usable: z.boolean(),
      can_confirm: z.boolean(),
      document: z
        .object({
          id: z.string().uuid(),
          file_name: z.string(),
          checksum: z.string().regex(/^[0-9a-f]{64}$/),
          coverage: z.unknown().optional(),
          warnings: z.unknown().optional(),
        })
        .nullable(),
      documents: z.array(z.object({ id: z.string().uuid(), file_name: z.string() })).nullable(),
      page: z.number().int().nonnegative(),
      pages: z.number().int().positive(),
    })
    .nullable(),
});
export type SourceReviewResponse = z.infer<typeof sourceReviewResponse>;
type Review = NonNullable<SourceReviewResponse["review"]>;
type Button = { text: string; callback_data: string };
export const kindLabels: Record<(typeof sourceKinds)[number], string> = {
  manual: "Паспорт или руководство",
  manufacturer: "Документ изготовителя",
  test_report: "Протокол испытаний",
  supplier: "Материал поставщика",
};
export function sourceButton(r: Review, action: string, ...params: (string | number)[]) {
  const data = ["pds", "r", compactId(r.id), r.revision, action, ...params].join(":");
  if (new TextEncoder().encode(data).length > 64) throw new Error("SOURCE_CALLBACK_LENGTH");
  return data;
}
export interface SourceAction {
  op: string;
  product?: string;
  id?: string;
  revision?: number;
  payload?: Record<string, unknown>;
  view?: "blocks" | "read";
  index?: number;
  part?: number;
}
export function parseSourceCallback(value: string): SourceAction | null {
  let m = value.match(/^pds:(home|new):([0-9a-f-]{36})(?::([0-9]{1,6}))?$/);
  if (m && uuid.test(m[2]!)) {
    if (m[1] === "new" && m[3] !== undefined) return null;
    return {
      op: m[1] === "new" ? "start" : "home",
      product: m[2]!,
      payload: { page: Number(m[3] ?? 0) },
    };
  }
  m = value.match(/^pds:g:([A-Za-z0-9_-]{22})$/);
  if (m) {
    const id = expandId(m[1]!);
    return id ? { op: "get", id } : null;
  }
  m = value.match(/^pds:d:([A-Za-z0-9_-]{22}):([0-9]{1,10}):([A-Za-z0-9_-]{22})$/);
  if (m) {
    const id = expandId(m[1]!),
      document = expandId(m[3]!),
      revision = Number(m[2]);
    return id && document && revision <= 2147483647
      ? { op: "choose", id, revision, payload: { document_id: document } }
      : null;
  }
  m = value.match(
    /^pds:r:([A-Za-z0-9_-]{22}):([0-9]{1,10}):([a-z]+)(?::([0-9]{1,6}))?(?::([0-9]{1,6}))?$/,
  );
  if (!m) return null;
  const id = expandId(m[1]!),
    revision = Number(m[2]),
    action = m[3]!,
    index = Number(m[4] ?? 0),
    part = Number(m[5] ?? 0);
  if (!id || revision > 2147483647) return null;
  if (action === "read")
    return m[4] !== undefined && m[5] !== undefined
      ? { op: "get", id, revision, view: "read", index, part }
      : null;
  if (action === "blocks")
    return m[4] !== undefined && m[5] === undefined
      ? { op: "get", id, revision, view: "blocks", index }
      : null;
  if (m[5] !== undefined) return null;
  if (action === "docs")
    return m[4] !== undefined ? { op: "documents", id, revision, payload: { page: index } } : null;
  if (action === "kind")
    return m[4] !== undefined && sourceKinds[index]
      ? { op: "kind", id, revision, payload: { kind: sourceKinds[index] } }
      : null;
  if (m[4] !== undefined) return null;
  const operations: Record<string, string> = {
    get: "get",
    preview: "preview",
    edit: "edit",
    confirm: "confirm",
    cancel: "cancel",
    askoff: "withdraw_prepare",
    off: "withdraw",
    keep: "withdraw_cancel",
  };
  return operations[action] ? { op: operations[action], id, revision } : null;
}
const short = (text: string, n = 70) => Array.from(text).slice(0, n).join("").replace(/\s+/g, " ");
export function renderSourceReview(v: SourceReviewResponse) {
  const rows: Button[][] = [],
    r = v.review;
  let text = "📘 Документы для модели\n" + short(v.title, 180) + "\n\n";
  const back = () =>
    rows.push(
      [{ text: "🎯 К выбору модели", callback_data: "pm:view:" + v.product_id }],
      [{ text: "📦 К товару", callback_data: "prd:" + v.product_id }],
    );
  if (!r) {
    text += modelContextText(v.current_model) + "\n\n";
    text +=
      "Здесь вы подтверждаете, что файл относится к выбранной модели. Это не подтверждение отдельных характеристик и не публикация товара.\n\n";
    if (v.current_model.usable)
      rows.push([
        { text: "➕ Проверить новый документ", callback_data: "pds:new:" + v.product_id },
      ]);
    if (v.active_review)
      rows.push([
        {
          text: "✏️ Продолжить начатую проверку",
          callback_data: "pds:g:" + compactId(v.active_review),
        },
      ]);
    for (const s of v.sources ?? [])
      rows.push([
        {
          text: (s.withdrawn_at ? "↩️ " : s.usable ? "✅ " : "⚠️ ") + short(s.file_name, 48),
          callback_data: "pds:g:" + compactId(s.review_id),
        },
      ]);
    if (!(v.sources ?? []).length)
      text += "Подтверждённых вами документов для этой модели пока нет.\n";
    text +=
      "Если файла ещё нет в боте, откройте «Загрузить документ» и пришлите его. Затем вернитесь к товару.";
    rows.push([{ text: "📤 Загрузить документ", callback_data: "di:home" }]);
    if (v.page > 0)
      rows.push([
        {
          text: "⬅️ Предыдущие документы",
          callback_data: "pds:home:" + v.product_id + ":" + (v.page - 1),
        },
      ]);
    if (v.page + 1 < v.pages)
      rows.push([
        {
          text: "Следующие документы ➡️",
          callback_data: "pds:home:" + v.product_id + ":" + (v.page + 1),
        },
      ]);
    back();
    return { text, rows };
  }
  text += modelContextText(r.model_context) + "\n\n";
  if (!r.model_matches)
    text +=
      "⚠️ Выбор модели изменился. Эта проверка не подтверждает текущую модель. Вернитесь к выбору модели. Незавершённый черновик нужно отменить перед новой проверкой.\n\n";
  if (r.document)
    text +=
      "📎 Файл: " +
      r.document.file_name +
      "\nТип: " +
      (r.source_kind ? kindLabels[r.source_kind] : "Ещё не выбран") +
      "\n\n";
  const add = (label: string, action: string, ...params: (string | number)[]) =>
    rows.push([{ text: label, callback_data: sourceButton(r, action, ...params) }]);
  if (r.documents) {
    text +=
      "Выберите свой загруженный файл. Старая кнопка всегда относится к тому же файлу, даже если список пополнился.\nСтраница " +
      (r.page + 1) +
      " из " +
      r.pages +
      ".\n\n";
    for (const d of r.documents)
      rows.push([
        {
          text: "📄 " + short(d.file_name, 55),
          callback_data: "pds:d:" + compactId(r.id) + ":" + r.revision + ":" + compactId(d.id),
        },
      ]);
    if (!r.documents.length)
      text +=
        "Обработанных файлов на этой странице нет. Вернитесь к списку документов и проверьте загрузку.\n";
    if (r.page > 0) add("⬅️ Предыдущие файлы", "docs", r.page - 1);
    if (r.page + 1 < r.pages) add("Следующие файлы ➡️", "docs", r.page + 1);
    rows.push([{ text: "📤 Загрузить документ", callback_data: "di:home" }]);
    add("↩️ К проверке", "get");
  } else if (r.phase === "draft") {
    text +=
      "1. Выберите файл и его тип.\n2. Откройте оригинал и сверьте изготовителя, точную модель и модификацию.\n3. Перейдите к предпросмотру.\n\nЕсли не уверены, не подтверждайте привязку.";
    if (r.model_matches) {
      add(r.document ? "📂 Выбрать другой файл" : "📂 Выбрать загруженный файл", "docs", 0);
      if (r.document) {
        sourceKinds.forEach((k, i) => add(kindLabels[k], "kind", i));
        if (r.source_kind) add("👁 Предпросмотр привязки", "preview");
      }
    }
    add("↩️ Отменить — ничего не привязывать", "cancel");
  } else if (r.phase === "preview") {
    text +=
      "👁 Перед подтверждением\nЯ сверил оригинал: изготовитель, точная модель и модификация относятся к указанному товару. Тип документа выбран верно.\n\nБудет сохранена связь файла с этой моделью. Товары, цены и характеристики не изменятся.";
    if (r.source_kind === "supplier")
      text +=
        "\n\n⚠️ Материал поставщика не становится паспортом изготовителя или проверенным техническим фактом.";
    if (r.can_confirm) add("✅ Да, файл относится к этой модели", "confirm");
    else text += "\n\nПредпросмотр устарел или сведения изменились. Вернитесь к проверке.";
    add("✏️ Вернуться к проверке", "edit");
    add("↩️ Отменить — ничего не привязывать", "cancel");
  } else if (r.phase === "confirmed") {
    text += r.usable
      ? "✅ Соответствие файла этой модели подтверждено вами. Содержимое отдельных характеристик ещё нужно проверить."
      : "⚠️ Решение сохранено в истории, но сейчас использовать эту связь нельзя. Проверьте актуальную модель и источник.";
    add("❔ Снять подтверждение этого файла…", "askoff");
  } else if (r.phase === "withdraw_preview") {
    text +=
      "Снять подтверждение соответствия этого файла модели? После подтверждения связь останется в истории как снятая. Файл и товар не удалятся; другие источники не изменятся.";
    if (r.can_confirm) add("✅ Снять подтверждение", "off");
    else text += "\n\nПредпросмотр истёк. Вернитесь и подготовьте снятие заново.";
    add("↩️ Оставить подтверждение", "keep");
  } else
    text +=
      r.phase === "withdrawn"
        ? "↩️ Подтверждение снято. Старое нажатие не восстановит связь."
        : r.phase === "canceled"
          ? "↩️ Проверка отменена. Новая связь не создана."
          : "⌛ Черновик истёк. Начните новую проверку из списка документов модели.";
  if (r.document) {
    add("📖 Читать текст и страницы", "blocks", 0);
    rows.push([
      { text: "📎 Скачать оригинал для сверки", callback_data: "di:original:" + r.document.id },
    ]);
  }
  rows.push(
    [{ text: "🔄 Прочитать сохранённый результат", callback_data: "pds:g:" + compactId(r.id) }],
    [{ text: "📘 Все документы этой модели", callback_data: "pds:home:" + v.product_id }],
  );
  back();
  return { text, rows };
}
