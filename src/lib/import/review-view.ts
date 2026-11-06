import { FIELD_LABEL, type Field } from "./catalog-file";

export function reviewColumnLabel(header: string | undefined, index: number) {
  const name = header?.trim() ?? "";
  return Object.hasOwn(FIELD_LABEL, name.toLowerCase())
    ? FIELD_LABEL[name.toLowerCase() as Field]
    : name || `Колонка ${index + 1}`;
}

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
      `^dr:(${uuid}):([0-9]{1,7}):(get|next|summary|edit|cancel|approve|exclude|pending|handoff|cols|raw):([0-9]{1,4})(?::([0-9]{1,2}))?$`,
    ),
  );
  if (!m || Number(m[4]) > 4999 || (m[5] !== undefined && Number(m[5]) > 29)) return null;
  if (["edit", "cols"].includes(m[3]!) !== (m[5] !== undefined)) return null;
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
  if (r.import_id) {
    text +=
      "\nПроверенные строки уже переданы в предпросмотр импорта. Этот разбор закрыт для изменений. Каталог этим действием не изменён. Откройте импорт, чтобы проверить его текущее состояние.";
    rows.push([
      { text: "📥 Открыть подготовленный импорт", callback_data: `ci:get:${r.import_id}:0` },
    ]);
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
    add("🔎 Продолжить проверку", "next");
  } else if (screen === "cols") {
    text += `\nСтрока ${r.row + 1}. Выберите поле для исправления. Изменение будет сохранено только в разборе документа. После исправления строку нужно проверить заново.\n`;
    r.header
      .slice(columnPage * 8, columnPage * 8 + 8)
      .forEach((h, i) =>
        add(
          "✏️ " + short(reviewColumnLabel(h, columnPage * 8 + i), 45),
          "edit",
          r.row,
          columnPage * 8 + i,
        ),
      );
    if (columnPage > 0) add("← Предыдущие поля", "cols", r.row, columnPage - 1);
    if ((columnPage + 1) * 8 < r.header.length)
      add("Следующие поля →", "cols", r.row, columnPage + 1);
    add("↩️ К строке", "get");
  } else if (screen === "raw") {
    text += `\n📎 Исходная строка ${r.row + 1}\nМесто в файле: ${r.locator ?? "точное место не определено; сверьте с оригиналом"}\n\n`;
    text += r.original
      .map((v, i) => `${i + 1}. ${r.header[i] || "Дополнительная ячейка"}: ${v || "(пусто)"}`)
      .join("\n\n");
    text += "\n\nЭто неизменённый результат распознавания. Для сверки доступен исходный файл.";
    add("↩️ К исправленной строке", "get");
  } else {
    text += `\nСтрока ${r.row + 1} из ${c.total} · ${status[r.decision]}\n📎 ${short(r.locator ?? "Место в оригинале не определено", 150)}\n\n`;
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
    add("📎 Посмотреть исходную строку", "raw");
    add("✏️ Исправить поле", "cols", r.row, 0);
    if (r.decision !== "approved") add("✅ Строка проверена → следующая", "approve");
    if (r.decision !== "excluded") add("⏭ Пропустить → следующая", "exclude");
    if (r.decision !== "pending") add("❔ Вернуть на проверку", "pending");
    const nav: ReviewButton[] = [];
    if (r.row > 0) nav.push(reviewButton(r, "← Строка", "get", r.row - 1));
    if (r.row + 1 < c.total) nav.push(reviewButton(r, "Строка →", "get", r.row + 1));
    if (nav.length) rows.push(nav);
    if (c.pending) add("🔎 Следующая непроверенная", "next");
    add("📋 Итог и передача в импорт", "summary");
  }
  rows.push([{ text: "📎 Скачать оригинал", callback_data: `di:original:${r.document_id}` }]);
  rows.push([{ text: "📚 К документу", callback_data: `di:get:${r.document_id}` }]);
  return { text, rows };
}
