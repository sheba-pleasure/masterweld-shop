import type { StructureDraft } from "./structure-view";
import { documentGuidance } from "./document-guidance";
import { catalogColumnLabel } from "./catalog-file";

export const reviewColumnLabel = catalogColumnLabel;

export type ReviewButton = { text: string; callback_data: string };
export interface DocumentReview {
  ok: true;
  id: string;
  document_id: string;
  revision: number;
  file_name: string;
  table_label: string;
  header: string[];
  row: number;
  cells: string[];
  original: string[];
  locator?: string;
  position?: number;
  prev_row?: number | null;
  next_row?: number | null;
  original_header?: string[];
  source_origin?: "ocr" | "manual" | "split";
  source_note?: string;
  structure_draft?: StructureDraft | null;
  last_structure_change?: {
    kind: string;
    target_row: number;
    revision: number;
    can_undo: boolean;
  } | null;
  notice?: string;
  decision: "pending" | "approved" | "excluded";
  counts: { total: number; pending: number; approved: number; excluded: number };
  import_id?: string | null;
  legacy_import_id?: string | null;
  warnings: string[];
  coverage?: { complete?: boolean; pages?: number; processed?: number };
}
export interface ReviewAction {
  id: string;
  revision: number;
  op: string;
  row: number;
  column?: number;
}
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function parseReviewCallback(value: string): ReviewAction | null {
  const m = value.match(
    new RegExp(
      `^dr:(${uuid}):([0-9]{1,7}):(get|next|summary|edit|cancel|approve|exclude|pending|handoff|cols|raw|values|full|orig|checks):([0-9]{1,4})(?::([0-9]{1,2}))?$`,
    ),
  );
  if (!m || Number(m[4]) > 4999 || (m[5] !== undefined && Number(m[5]) > 29)) return null;
  if (["edit", "cols", "values", "full", "orig"].includes(m[3]!) !== (m[5] !== undefined))
    return null;
  if (m[3] === "values" && Number(m[5]) > 3) return null;
  return {
    id: m[1]!,
    revision: Number(m[2]),
    op: m[3]!,
    row: Number(m[4]),
    ...(m[5] === undefined ? {} : { column: Number(m[5]) }),
  };
}
export function reviewButton(
  r: DocumentReview,
  text: string,
  op: string,
  row = r.row,
  column?: number,
): ReviewButton {
  const callback_data = `dr:${r.id}:${r.revision}:${op}:${row}${column === undefined ? "" : ":" + column}`;
  if (Buffer.byteLength(callback_data) > 64) throw new Error("REVIEW_BUTTON");
  return { text, callback_data };
}
const short = (s: string, n = 100) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const status = {
  pending: "⏳ Ещё не проверена",
  approved: "✅ Проверена человеком",
  excluded: "⏭ Пропущена в этом документе",
};
export function renderReview(r: DocumentReview, screen = "get", columnPage = 0) {
  const rows: ReviewButton[][] = [];
  const add = (text: string, op: string, row = r.row, column?: number) =>
    rows.push([reviewButton(r, text, op, row, column)]);
  const c = r.counts;
  let text = `🔎 Проверка документа\n${short(r.file_name)} · ${short(r.table_label)}\n\n✅ Проверено: ${c.approved} · ⏭ Пропущено: ${c.excluded} · ⏳ Осталось: ${c.pending}\n`;
  if (r.notice) text += `\n${r.notice}\n`;
  if (r.import_id && !["values", "full", "orig", "checks"].includes(screen)) {
    text +=
      "\nПроверенные строки уже переданы в предпросмотр импорта. Этот разбор закрыт для изменений. Каталог этим действием не изменён. Откройте импорт, чтобы проверить его текущее состояние.";
    rows.push([
      { text: "📥 Открыть подготовленный импорт", callback_data: `ci:get:${r.import_id}:0` },
    ]);
  } else if (screen === "checks") {
    text += "\n" + documentGuidance(r.warnings, r.coverage);
    add("↩️ К строке", "get");
  } else if (screen === "summary") {
    text += `\nИтог: из ${c.total} строк в импорт попадут ${c.approved}. Пропущенные строки не попадут.\n\nПередача создаст только предпросмотр. Следом нужно выбрать колонки, проверить артикулы, розничные и закупочные цены и отдельно подтвердить импорт. Новые товары автоматически не публикуются. Ранее исключённые из ассортимента товары остаются исключёнными.`;
    if (!r.coverage?.complete || r.warnings.length)
      text +=
        "\n\n⚠️ В распознавании есть предупреждения или неполное покрытие. Сверьте весь документ с оригиналом, включая отсутствующие строки. Передавая строки, вы подтверждаете эту проверку.";
    if (r.legacy_import_id) {
      text +=
        "\n\nРанее для этой таблицы был начат импорт без построчной проверки. Сначала откройте и отмените его. Если он уже применён, нужен отдельный разбор владельцем.";
      rows.push([
        { text: "📥 Проверить прежний импорт", callback_data: `ci:get:${r.legacy_import_id}:0` },
      ]);
    }
    if (c.pending)
      text +=
        "\n\nСначала решите, что делать с каждой оставшейся строкой: проверить или пропустить.";
    else if (c.approved) add("✅ Подтверждаю — передать в предпросмотр", "handoff");
    else text += "\n\nВсе строки пропущены. Импорт не создаётся.";
    add("🔎 Что проверить в таблице", "checks");
    add("🔎 Продолжить проверку", "next");
  } else if (screen === "cols" || screen === "values") {
    const reading = screen === "values";
    text += reading
      ? `\n🔎 Строка ${r.position ?? r.row + 1}. Выберите поле, чтобы прочитать значение целиком и сравнить с оригиналом. Просмотр не меняет данные и решение по строке.\n`
      : `\nСтрока ${r.position ?? r.row + 1}. Выберите поле для исправления. Изменение будет сохранено только в разборе документа. После исправления строку нужно проверить заново.\n`;
    r.header
      .slice(columnPage * 8, columnPage * 8 + 8)
      .forEach((h, i) =>
        add(
          (reading ? "🔎 " : "✏️ ") + short(reviewColumnLabel(h, columnPage * 8 + i), 45),
          reading ? "full" : "edit",
          r.row,
          columnPage * 8 + i,
        ),
      );
    if (columnPage > 0) add("← Предыдущие поля", screen, r.row, columnPage - 1);
    if ((columnPage + 1) * 8 < r.header.length)
      add("Следующие поля →", screen, r.row, columnPage + 1);
    add("↩️ К строке", "get");
  } else if (screen === "full" || screen === "orig") {
    const index = columnPage;
    if (!Number.isInteger(index) || index < 0 || index >= r.header.length) {
      text += "\nЭто поле больше недоступно. Откройте список полей заново.";
    } else {
      const original = screen === "orig";
      text += `\nСтрока ${r.position ?? r.row + 1} · ${status[r.decision]}\nПоле ${index + 1} из ${r.header.length}: ${reviewColumnLabel(r.header[index], index)}\n\n`;
      if (original) {
        text += "📎 Значение в исходном распознавании\n";
        text += `Заголовок в оригинале: ${(r.original_header ?? r.header)[index] || "(Пусто)"}\n\n`;
        text +=
          r.source_origin === "manual"
            ? "Строка добавлена вручную. Исходного распознанного значения нет."
            : r.original[index] || "(Пусто)";
        if (r.source_origin === "split")
          text += "\n\nЭто значение общей строки до разделения на товары.";
        add("↩️ К сохранённому значению", "full", r.row, index);
      } else {
        text += `🔎 Сохранённое значение целиком\n\n${r.cells[index] || "(Пусто)"}`;
        if (r.cells[index] !== r.original[index])
          text += "\n\n✏️ Значение отличается от исходного распознавания.";
        add("📎 Сравнить с исходным значением", "orig", r.row, index);
        if (!r.import_id) add("✏️ Исправить — проверить заново", "edit", r.row, index);
      }
      text += "\n\nПросмотр не меняет данные и решение по строке.";
      if (r.import_id) text += " Разбор уже передан в импорт; исправления закрыты.";
      if (index > 0) add("← Предыдущее поле", screen, r.row, index - 1);
      if (index + 1 < r.header.length) add("Следующее поле →", screen, r.row, index + 1);
    }
    add(
      "📋 Выбрать другое поле",
      "values",
      r.row,
      Number.isInteger(index) && index >= 0 && index < r.header.length ? Math.floor(index / 8) : 0,
    );
    add("↩️ К строке", "get");
  } else if (screen === "raw") {
    text += `\n📎 Исходная строка ${r.position ?? r.row + 1}\nМесто в файле: ${r.locator ?? "точное место не определено; сверьте с оригиналом"}\n\n`;
    if (r.source_origin === "manual")
      text += "Строка добавлена вручную. Распознанной исходной строки нет.\n\n";
    if (r.source_note) text += `Пояснение: ${r.source_note}\n\n`;
    text += r.original
      .map(
        (v, i) =>
          `${i + 1}. ${(r.original_header ?? r.header)[i] || "Дополнительная ячейка"}: ${v || "(пусто)"}`,
      )
      .join("\n\n");
    text += "\n\nЭто неизменённый результат распознавания. Для сверки доступен исходный файл.";
    add("↩️ К исправленной строке", "get");
  } else {
    text += `\nСтрока ${r.position ?? r.row + 1} из ${c.total} · ${status[r.decision]}\n📎 ${short(r.locator ?? "Место в оригинале не определено", 150)}\n\n`;
    text += r.header
      .map(
        (h, i) =>
          `${short(reviewColumnLabel(h, i), 60)}: ${short(r.cells[i] || "(пусто)")}${r.cells[i] !== r.original[i] ? " ✏️" : ""}`,
      )
      .join("\n");
    if (r.cells.length !== r.header.length)
      text +=
        "\n\n⚠️ Число ячеек не совпадает с заголовком. Недостающие поля можно заполнить. Лишние ячейки видны в исходной строке; такую строку пропустите и подготовьте исправленный файл.";
    text +=
      "\n\nСверьте строку с оригиналом. «Строка проверена» означает, что данные верны. «Пропустить» исключает строку только из этого импорта, а не удаляет товар из магазина.";
    if (r.cells.some((value) => value.length > 100))
      text +=
        "\n\n🔎 Длинные значения здесь сокращены. Нажмите «Прочитать значения целиком», чтобы увидеть весь сохранённый текст.";
    if (r.warnings.length || !r.coverage?.complete)
      text +=
        "\n\n🔎 В таблице есть особенности распознавания. Откройте «Что проверить в таблице» перед решением по строке.";
    add("🔎 Что проверить в таблице", "checks");
    add("🔎 Прочитать значения целиком", "values", r.row, 0);
    add("📎 Посмотреть исходную строку", "raw");
    rows.push([
      { text: "🏷 Модель для поиска источников", callback_data: `dm:${r.id}:0:get:${r.row}` },
    ]);
    add("✏️ Исправить поле", "cols", r.row, 0);
    rows.push([
      { text: "🛠 Исправить таблицу", callback_data: `ds:${r.id}:${r.revision}:tools:${r.row}` },
    ]);
    if (r.decision !== "approved") add("✅ Строка проверена → следующая", "approve");
    if (r.decision !== "excluded") add("⏭ Пропустить → следующая", "exclude");
    if (r.decision !== "pending") add("❔ Вернуть на проверку", "pending");
    const nav: ReviewButton[] = [];
    const previous = r.prev_row === undefined ? (r.row > 0 ? r.row - 1 : null) : r.prev_row;
    const next = r.next_row === undefined ? (r.row + 1 < c.total ? r.row + 1 : null) : r.next_row;
    if (previous !== null) nav.push(reviewButton(r, "← Строка", "get", previous));
    if (next !== null) nav.push(reviewButton(r, "Строка →", "get", next));
    if (nav.length) rows.push(nav);
    if (c.pending) add("🔎 Следующая непроверенная", "next");
    add("📋 Итог и передача в импорт", "summary");
  }
  rows.push([{ text: "📎 Скачать оригинал", callback_data: `di:original:${r.document_id}` }]);
  rows.push([{ text: "📚 К документу", callback_data: `di:get:${r.document_id}` }]);
  return { text, rows };
}
