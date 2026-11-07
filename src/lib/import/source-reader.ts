import type { IntakeView } from "./intake-view";

type Button = { text: string; callback_data: string };
type SourceBlock = { locator: string; text: string; page?: number; engine?: string };
const PAGE_SIZE = 8;
// Bound both code points and UTF-16 length, while never splitting a surrogate pair.
export const SOURCE_PART_SIZE = 1200;
const short = (value: string | undefined, length = 80) =>
  Array.from(value ?? "")
    .slice(0, length)
    .join("")
    .replace(/\s+/g, " ");
function blocks(data: IntakeView): unknown[] {
  return Array.isArray(data.extraction?.blocks) ? data.extraction.blocks : [];
}
function sourceBlock(value: unknown): SourceBlock | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  return typeof b["locator"] === "string" && typeof b["text"] === "string"
    ? (b as unknown as SourceBlock)
    : null;
}
export function sourceLocation(value: unknown, index: number) {
  const block = sourceBlock(value);
  const location = block?.locator.match(
    /^(page|sheet|paragraph|image|document):([1-9][0-9]{0,5})$/,
  );
  if (!location) return "Фрагмент " + (index + 1) + " · Место в оригинале нужно уточнить";
  const number = Number(location[2]);
  if (location[1] === "page") {
    if (block?.page !== undefined && block.page !== number)
      return "Фрагмент " + (index + 1) + " · Номер страницы требует сверки";
    return "Страница файла " + number;
  }
  if (location[1] === "sheet") return "Лист " + number;
  if (location[1] === "paragraph") return "Абзац " + number;
  if (location[1] === "image") return "Текст изображения";
  return "Текст документа";
}
function back(data: IntakeView): Button[][] {
  return [
    [{ text: "📎 Скачать оригинал для сверки", callback_data: "di:original:" + data.id }],
    [{ text: "↩️ К документу и таблицам", callback_data: "di:get:" + data.id }],
  ];
}
function coverage(data: IntakeView) {
  const c = data.extraction?.coverage;
  let text = c?.complete ? "" : "⚠️ Документ прочитан частично или полнота неизвестна. ";
  if (Number.isInteger(c?.pages) && Number.isInteger(c?.processed))
    text += "Обработано страниц: " + c!.processed + " из " + c!.pages + ". ";
  return text;
}
export function renderSourceBlocks(data: IntakeView, page = 0) {
  const all = blocks(data),
    pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const rows = back(data);
  let text = "📖 Текст исходного документа\n" + short(data.file_name) + "\n\n";
  if (!Number.isInteger(page) || page < 0 || page >= pages) {
    rows.unshift([{ text: "📖 К началу списка", callback_data: "di:blocks:" + data.id + ":0" }]);
    return {
      text: text + "Эта страница списка недоступна. Откройте начало списка или оригинал.",
      rows,
    };
  }
  text += coverage(data) + "Просмотр ничего не подтверждает, не исправляет и не импортирует.\n\n";
  if (!all.length)
    return {
      text:
        text +
        "Отдельного распознанного текста нет. Таблицы доступны в карточке документа, если они найдены. Оригинал можно скачать ниже.",
      rows,
    };
  text +=
    "Выберите страницу или фрагмент. Номер страницы файла может отличаться от номера, напечатанного на листе.\n\nСтраница списка " +
    (page + 1) +
    " из " +
    pages +
    ".";
  const choices: Button[][] = all
    .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    .map((block, offset) => {
      const index = page * PAGE_SIZE + offset;
      return [
        {
          text: "📄 " + short(sourceLocation(block, index), 55),
          callback_data: "di:read:" + data.id + ":" + index + ":0",
        },
      ];
    });
  if (page > 0 || page + 1 < pages)
    choices.push([
      ...(page > 0
        ? [
            {
              text: "⬅️ Предыдущие страницы",
              callback_data: "di:blocks:" + data.id + ":" + (page - 1),
            },
          ]
        : []),
      ...(page + 1 < pages
        ? [
            {
              text: "Следующие страницы ➡️",
              callback_data: "di:blocks:" + data.id + ":" + (page + 1),
            },
          ]
        : []),
    ]);
  return { text, rows: [...choices, ...rows] };
}
export function renderSourceText(data: IntakeView, index: number, part = 0) {
  const all = blocks(data);
  const block = Number.isInteger(index) && index >= 0 ? sourceBlock(all[index]) : null;
  const rows: Button[][] = [
    [
      {
        text: "📖 Выбрать страницу или фрагмент",
        callback_data:
          "di:blocks:" +
          data.id +
          ":" +
          (index >= 0 && index < all.length && Number.isInteger(index)
            ? Math.floor(index / PAGE_SIZE)
            : 0),
      },
    ],
    ...back(data),
  ];
  const title = "📖 " + short(data.file_name) + "\n";
  if (!block)
    return {
      text: title + "\nЭтот фрагмент недоступен. Выберите страницу заново или скачайте оригинал.",
      rows,
    };
  const chars = Array.from(block.text),
    parts = Math.max(1, Math.ceil(chars.length / SOURCE_PART_SIZE));
  if (!Number.isInteger(part) || part < 0 || part >= parts) {
    rows.unshift([
      { text: "📄 К началу фрагмента", callback_data: "di:read:" + data.id + ":" + index + ":0" },
    ]);
    return { text: title + "\nЭта часть текста недоступна. Откройте начало фрагмента.", rows };
  }
  const nav: Button[] = [
    ...(part > 0
      ? [
          {
            text: "⬅️ Предыдущая часть",
            callback_data: "di:read:" + data.id + ":" + index + ":" + (part - 1),
          },
        ]
      : []),
    ...(part + 1 < parts
      ? [
          {
            text: "Продолжение текста ➡️",
            callback_data: "di:read:" + data.id + ":" + index + ":" + (part + 1),
          },
        ]
      : []),
  ];
  if (nav.length) rows.unshift(nav);
  const neighbors: Button[] = [
    ...(index > 0
      ? [
          {
            text: "⬅️ Предыдущий фрагмент",
            callback_data: "di:read:" + data.id + ":" + (index - 1) + ":0",
          },
        ]
      : []),
    ...(index + 1 < all.length
      ? [
          {
            text: "Следующий фрагмент ➡️",
            callback_data: "di:read:" + data.id + ":" + (index + 1) + ":0",
          },
        ]
      : []),
  ];
  if (neighbors.length) rows.splice(nav.length ? 1 : 0, 0, neighbors);
  const method =
    block.engine === "tesseract-rus-eng"
      ? "Текст распознан со скана: возможны ошибки в буквах и цифрах. "
      : block.engine === "pdftotext"
        ? "Прочитан текстовый слой PDF; рисунки могут содержать другие сведения. "
        : "";
  const raw = chars.slice(part * SOURCE_PART_SIZE, (part + 1) * SOURCE_PART_SIZE).join("");
  const text =
    title +
    "📍 " +
    sourceLocation(block, index) +
    " · Часть " +
    (part + 1) +
    " из " +
    parts +
    "\n\n" +
    coverage(data) +
    method +
    "Сверьте точную модель, единицы и значения с оригиналом. Это ещё не подтверждённые характеристики.\n\n—— Текст источника ——\n" +
    (raw || "Текст этого фрагмента пуст. Посмотрите оригинал.");
  return { text, rows };
}
