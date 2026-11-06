import { FIELD_LABEL, type Field } from "./catalog-file";
import {
  reviewButton,
  reviewColumnLabel,
  type DocumentReview,
  type ReviewButton,
} from "./review-view";

export interface StructureDraft {
  kind: "header" | "add" | "split";
  target: number;
  stage: "editing" | "preview";
  focus: number;
  guided: boolean;
  column?: number;
  value?: string;
  rows?: string[][];
  note?: string;
}
export interface StructureAction {
  id: string;
  revision: number;
  op: string;
  row: number;
  arg?: number;
}
const withArg = new Set([
  "heads",
  "head",
  "split",
  "edit",
  "walk",
  "std",
  "skip",
  "copy",
  "fields",
]);
export function parseStructureCallback(value: string): StructureAction | null {
  const match = value.match(
    /^ds:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{1,7}):(tools|heads|head|add|parts|split|edit|walk|std|skip|copy|src|where|preview|apply|back|cancel|undo|askundo|fields):([0-9]{1,4})(?::([0-9]{1,3}))?$/,
  );
  if (
    !match ||
    Buffer.byteLength(value) > 64 ||
    Number(match[4]) > 4999 ||
    withArg.has(match[3]!) !== (match[5] !== undefined) ||
    Number(match[5] ?? 0) > 119
  )
    return null;
  const arg = match[5] === undefined ? undefined : Number(match[5]);
  if (
    (match[3] === "head" && arg! > 29) ||
    (match[3] === "std" && arg! > 7) ||
    (match[3] === "split" && (arg! < 2 || arg! > 4)) ||
    (match[3] === "heads" && arg! > 3)
  )
    return null;
  return {
    id: match[1]!,
    revision: Number(match[2]),
    op: match[3]!,
    row: Number(match[4]),
    ...(arg === undefined ? {} : { arg }),
  };
}
export function structureButton(
  r: DocumentReview,
  text: string,
  op: string,
  arg?: number,
): ReviewButton {
  const callback_data = `ds:${r.id}:${r.revision}:${op}:${r.structure_draft?.target ?? r.row}${arg === undefined ? "" : ":" + arg}`;
  if (Buffer.byteLength(callback_data) > 64) throw new Error("STRUCTURE_BUTTON");
  return { text, callback_data };
}
const short = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const STANDARD_HEADERS: Field[] = [
  "sku",
  "title",
  "brand",
  "price",
  "cost_price",
  "in_stock",
  "stock_qty",
  "category_slug",
];
export function structureQuestion(r: DocumentReview) {
  const d = r.structure_draft!;
  if (d.focus === -1)
    return "Где в исходном документе находится этот товар? Укажите лист, страницу или соседний товар. Например: «Лист 1, между электродами А и Б».";
  if (d.kind === "header")
    return "Введите правильное название колонки. Для стандартного поля магазина удобнее выбрать кнопку под предыдущим сообщением.";
  const part = Math.floor(d.focus / 30),
    col = d.focus % 30;
  return `Товар ${part + 1} из ${d.rows!.length}. Введите поле «${reviewColumnLabel(r.header[col], col)}».\nСейчас: ${short(d.rows![part]![col] || "(пусто)", 500)}\n\nОтветьте именно на это сообщение. «—» оставит поле пустым. Значение сохраняется только в черновике.`;
}
export function renderStructure(r: DocumentReview, screen = "tools", arg = 0) {
  const rows: ReviewButton[][] = [];
  const add = (text: string, op: string, value?: number) =>
    rows.push([structureButton(r, text, op, value)]);
  const d = r.structure_draft;
  let text = `🛠 Исправление таблицы\n${short(r.file_name, 100)}\n\n`;
  if (r.notice) text += r.notice + "\n\n";
  if (r.import_id)
    return {
      text: text + "Разбор уже передан в импорт и закрыт для изменений.",
      rows: [[reviewButton(r, "📋 К результату", "get")]],
    };
  if (d) {
    text +=
      d.kind === "header"
        ? "Заголовок колонки"
        : d.kind === "add"
          ? "Добавление пропущенного товара"
          : "Разделение одной строки на несколько товаров";
    text += "\n";
    if (d.stage === "preview") {
      text += "\n👀 Было → станет\n";
      if (d.kind === "header") {
        text += `Было: ${r.header[d.column!]}.\nСтанет: ${reviewColumnLabel(d.value, d.column!)}.\n\nВсе ранее проверенные строки снова потребуют проверки. Пропущенные строки останутся пропущенными.`;
      } else {
        if (d.kind === "split")
          text +=
            "Было: одна строка\n" +
            r.header
              .map((h, i) => `${reviewColumnLabel(h, i)}: ${short(r.cells[i] || "(пусто)")}`)
              .join("\n") +
            "\n\n";
        else
          text += `Было: товара нет в разборе.\nСтанет: новый товар после строки ${r.position ?? r.row + 1}.\n\n`;
        text += d
          .rows!.map(
            (cells, i) =>
              `📦 Товар ${i + 1}\n` +
              r.header
                .map((h, j) => `${reviewColumnLabel(h, j)}: ${cells[j] || "(пусто)"}`)
                .join("\n"),
          )
          .join("\n\n");
        text += "\n\n📎 " + (d.note || r.locator || "Точное место в оригинале не определено.");
        text +=
          "\n\nКаждую новую строку нужно будет отдельно проверить. Исходная строка сохранится для сверки.";
      }
      text +=
        "\n\nПодтверждение изменит только разбор документа. Импорт и публикация не запускаются.";
      add("✅ Подтвердить исправление таблицы", "apply");
      add("✏️ Вернуться к исправлению", "back");
    } else if (d.focus >= -1) {
      text += "\n" + structureQuestion(r);
      if (d.kind === "header") {
        STANDARD_HEADERS.forEach((field, i) => add(FIELD_LABEL[field], "std", i));
      } else if (d.focus === -1) add("❔ Точное место пока неизвестно", "where");
      else {
        add("Оставить это поле пустым", "skip", d.focus);
        if (d.kind === "split") add("📋 Взять это поле из исходной строки", "copy", d.focus);
      }
      if (d.focus === -1) add("🔄 Получить новый вопрос", "src");
      else add("🔄 Получить новый вопрос", d.guided ? "walk" : "edit", d.focus);
      add("↩️ К полям черновика", "back");
    } else if (d.kind === "header") {
      text += `\nБыло: ${r.header[d.column!]}.\nВыбрано: ${reviewColumnLabel(d.value, d.column!)}.\n\nВыберите, что означает эта колонка, или введите своё название. Данные в ячейках не перемещаются.`;
      STANDARD_HEADERS.forEach((field, i) => add(FIELD_LABEL[field], "std", i));
      add("✏️ Ввести своё название", "edit", d.column);
      add("👀 Проверить перед сохранением", "preview");
    } else {
      const part = Math.min(Math.floor(arg / 30), d.rows!.length - 1),
        page = Math.floor((arg % 30) / 8);
      text += `\n📦 Товар ${part + 1} из ${d.rows!.length}\n`;
      text += r.header
        .map((h, i) => `${reviewColumnLabel(h, i)}: ${short(d.rows![part]![i] || "(пусто)")}`)
        .join("\n");
      text +=
        "\n\n«Заполнить по шагам» задаст по одному вопросу. Можно также выбрать отдельное поле. Общие значения из склеенной строки автоматически не копируются.";
      add("▶️ Заполнить по шагам", "walk", part * 30);
      r.header
        .slice(page * 8, page * 8 + 8)
        .forEach((h, i) =>
          add(
            "✏️ " + short(reviewColumnLabel(h, page * 8 + i), 40),
            "edit",
            part * 30 + page * 8 + i,
          ),
        );
      if (page > 0) add("← Предыдущие поля", "fields", part * 30 + (page - 1) * 8);
      if ((page + 1) * 8 < r.header.length)
        add("Следующие поля →", "fields", part * 30 + (page + 1) * 8);
      if (d.rows!.length > 1)
        rows.push(d.rows!.map((_, i) => structureButton(r, `Товар ${i + 1}`, "fields", i * 30)));
      add("📎 Указать место в исходном файле", "src");
      add("👀 Проверить перед сохранением", "preview");
    }
    add("❌ Отменить черновик — сохранить прежнюю таблицу", "cancel");
  } else if (screen === "heads") {
    text += "Выберите неверный заголовок. Название колонки определяет смысл всех значений под ним.";
    r.header
      .slice(arg * 8, arg * 8 + 8)
      .forEach((h, i) =>
        add(
          `${arg * 8 + i + 1}. ${short(reviewColumnLabel(h, arg * 8 + i), 40)}`,
          "head",
          arg * 8 + i,
        ),
      );
    if (arg > 0) add("← Предыдущие колонки", "heads", arg - 1);
    if ((arg + 1) * 8 < r.header.length) add("Следующие колонки →", "heads", arg + 1);
    add("↩️ Назад", "tools");
  } else if (screen === "parts") {
    text +=
      "Сколько товаров ошибочно попало в эту строку?\n\nКаждый товар получит отдельную строку. Проверьте его артикул, название и цены. Если товаров больше четырёх, разделите строку в несколько приёмов.";
    [2, 3, 4].forEach((n) => add(`${n} товара`, "split", n));
    add("↩️ Назад", "tools");
  } else if (screen === "askundo") {
    text +=
      "Отменить последнее исправление структуры? Будут восстановлены прежние строки или заголовок и прежние решения по ним. Это возможно только пока после исправления ничего больше не изменено.";
    if (r.last_structure_change?.can_undo) add("↩️ Да, отменить последнее исправление", "undo");
    else
      text += "\n\nПосле исправления уже были другие изменения. Автоматическая отмена недоступна.";
    add("Оставить как есть", "tools");
  } else {
    text +=
      "Выберите проблему. Бот поможет исправить её по шагам, затем покажет результат перед сохранением.\n\n🏷 Заголовок — неверное название колонки.\n➕ Пропущенный товар — есть в файле, но отсутствует в разборе.\n✂️ Несколько товаров — распознавание склеило их в одну строку.";
    add("🏷 Исправить заголовок", "heads", 0);
    add("➕ Добавить товар после этой строки", "add");
    add("✂️ В этой строке несколько товаров", "parts");
    if (r.last_structure_change?.can_undo) add("↩️ Отменить последнее исправление", "askundo");
  }
  if (!d) rows.push([reviewButton(r, "🔎 К проверке строки", "get")]);
  rows.push([{ text: "📎 Скачать оригинал", callback_data: `di:original:${r.document_id}` }]);
  return { text, rows };
}
