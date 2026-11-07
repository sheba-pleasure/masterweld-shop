import { documentGuidance } from "./document-guidance";

export interface IntakeView {
  ok: true;
  home?: boolean;
  id?: string;
  file_name?: string;
  state?: string;
  error_code?: string;
  checksum?: string;
  original_base64?: string;
  recent?: { id: string; file_name: string; state: string }[];
  extraction?: {
    tables: { label: string; header: string[]; rows: string[][]; warnings?: string[] }[];
    blocks: { locator: string; text: string; page?: number; engine?: string }[];
    warnings: string[];
    coverage: { complete?: boolean; pages?: number; processed?: number };
  };
}
const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function parseIntakeCallback(
  data: string,
): { op: string; id?: string; index?: number; page?: number } | null {
  if (data === "di:home") return { op: "home" };
  const source = data.match(
    new RegExp(`^di:(blocks|read):(${id}):([0-9]{1,6})(?::([0-9]{1,6}))?$`),
  );
  if (source) {
    if (source[1] === "blocks" && source[4] === undefined)
      return { op: "blocks", id: source[2]!, page: Number(source[3]) };
    if (source[1] === "read" && source[4] !== undefined)
      return { op: "read", id: source[2]!, index: Number(source[3]), page: Number(source[4]) };
    return null;
  }
  let match = data.match(new RegExp(`^di:(get|cancel|text|original):(${id})$`));
  if (match) return { op: match[1]!, id: match[2]! };
  match = data.match(new RegExp(`^di:get:(${id}):([0-9]{1,2})$`));
  if (match) return { op: "get", id: match[1]!, page: Number(match[2]) };
  match = data.match(new RegExp(`^di:(table|checks):(${id}):([0-9]{1,2})$`));
  return match ? { op: match[1]!, id: match[2]!, index: Number(match[3]) } : null;
}
const label: Record<string, string> = {
  queued: "⏳ Ожидает обработки",
  extracting: "🔎 Распознаётся",
  review: "👁 Нужна проверка",
  failed: "⚠️ Обработка остановлена",
  canceled: "✖️ Отменено",
};
const short = (v: string | undefined, n = 70) => (v ?? "").replace(/\s+/g, " ").slice(0, n);
export function renderIntake(data: IntakeView, requestedPage = 0) {
  const rows: { text: string; callback_data: string }[][] = [];
  if (data.home)
    return {
      text: "📚 Документы → товары\n\nПришлите файл до 5 МБ. XLS, XLSX, ODS, DOCX, PDF, TXT, TSV и изображения распознаются локально. Сканам доступен русский и английский OCR. Другие форматы сохраняются для ручного разбора. CSV доступен через /import.\n\n1️⃣ Сохраним оригинал.\n2️⃣ Выделим таблицы или строки-кандидаты.\n3️⃣ Вы исправите строки и решите: проверить или пропустить.\n4️⃣ Импорт покажет изменения до подтверждения.\n\nНичего не публикуется автоматически. Поиск источников и генерация изображений/описаний пока не подключены.\n\nПосле загрузки нажмите «Обновить результат»; уведомление об окончании не рассылается.",
      rows: [
        ...(data.recent ?? []).map((d) => [
          {
            text: `${label[d.state] ?? "Проверить"} · ${short(d.file_name, 35)}`,
            callback_data: `di:get:${d.id}`,
          },
        ]),
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ],
    };
  const extraction = data.extraction;
  rows.push([{ text: "📎 Получить оригинал", callback_data: `di:original:${data.id}` }]);
  const lines = [
    `📄 ${short(data.file_name)}\n${label[data.state ?? ""] ?? "Проверить состояние"}`,
    "Оригинал сохранён отдельно от товаров. Повторная отправка того же файла возвращает эту обработку.",
  ];
  if (extraction) {
    lines.push(
      `Таблиц/списков: ${extraction.tables.length}. Текстовых блоков: ${extraction.blocks.length}.`,
    );
    if (extraction.coverage.pages)
      lines.push(
        `Страниц обработано: ${extraction.coverage.processed ?? 0} из ${extraction.coverage.pages}.`,
      );
    if (
      !extraction.coverage.complete ||
      extraction.warnings.length ||
      extraction.tables.some((t) => t.warnings?.length)
    )
      lines.push(
        "⚠️ Нужна сверка с оригиналом: часть содержимого может требовать ручного разбора. Смешанные сканы, объединённые ячейки и формулы не считаются проверенными.",
      );
    if (extraction.tables.length) {
      lines.push(
        "Кнопка «Что проверить» объясняет особенности каждой таблицы. Памятка не меняет данные.",
        "Выберите таблицу. Для каждой строки доступны исходные данные, исправление полей и решение «Строка проверена» или «Пропустить». Затем подтвердите передачу в предпросмотр импорта. Закупочная цена и розничная — разные поля. Строка текста ещё не означает товар.",
      );
    } else {
      const warnings = new Set(extraction.warnings);
      const reason = warnings.has("XLS_PASSWORD_REQUIRED")
        ? "Книга Excel защищена паролем. Откройте её у себя, сохраните отдельную копию без пароля и отправьте копию боту."
        : warnings.has("XLS_VERSION_REVIEW")
          ? "Это слишком старый формат Excel. Откройте файл в Excel или LibreOffice и сохраните копию как XLSX."
          : warnings.has("XLS_DAMAGED")
            ? "Книгу XLS не удалось прочитать. Файл может быть повреждён или иметь другой формат. Откройте его у себя и сохраните новую копию как XLSX."
            : warnings.has("HEADER_REVIEW")
              ? "Не удалось определить пригодные заголовки. В копии таблицы оставьте короткие названия колонок в первой строке, товары — ниже."
              : [...warnings].some((w) =>
                    [
                      "TABLE_LIMIT",
                      "ROW_LIMIT",
                      "COLUMN_LIMIT",
                      "SHEET_LIMIT",
                      "PAGE_LIMIT",
                      "EXTRACTION_LIMIT",
                    ].includes(w),
                  )
                ? "Документ превышает предел обработки. Разделите его на части: до 5000 строк товаров и 30 колонок в таблице, до 30 листов Excel или 40 страниц PDF."
                : warnings.has("FORMAT_REQUIRES_MANUAL_CONVERSION")
                  ? "Этот формат пока не распознаётся. Сохраните таблицу как XLSX/TSV или документ как PDF."
                  : "Не удалось выделить строки товаров. Проверьте, что файл содержит таблицу или читаемый текст. Для скана подготовьте более чёткую копию; таблицу сохраните как XLSX.";
      lines.push(
        "📋 Таблиц для проверки пока нет. Импорт не создан.",
        ...(extraction.blocks.length
          ? [
              "Распознанный текст можно открыть кнопкой «Читать текст документа». Для паспорта без таблицы товаров это нормальный результат; не нужно переделывать его ради импорта.",
            ]
          : []),
        (extraction.blocks.length
          ? "Если здесь должен быть прайс с товарами:\n1. Нажмите «Получить оригинал» и откройте файл.\n2. "
          : "Дальше:\n1. Нажмите «Получить оригинал» и откройте файл.\n2. ") +
          reason +
          "\n3. Пришлите исправленный файл как новый документ.",
        "Прежний оригинал остаётся сохранённым. Повторная отправка тех же байтов вернёт прежний результат и не запустит распознавание заново.",
      );
    }
    const pages = Math.max(1, Math.ceil(extraction.tables.length / 8));
    const page = Math.max(0, Math.min(Math.floor(requestedPage), pages - 1));
    if (pages > 1) lines.push(`Страница таблиц ${page + 1} из ${pages}.`);
    extraction.tables.slice(page * 8, (page + 1) * 8).forEach((t, offset) => {
      const i = page * 8 + offset;
      rows.push([
        {
          text: `${i + 1}. ${short(t.label, 32)} · ${t.rows.length} строк`,
          callback_data: `di:table:${data.id}:${i}`,
        },
      ]);
      rows.push([
        { text: `🔎 Что проверить · Таблица ${i + 1}`, callback_data: `di:checks:${data.id}:${i}` },
      ]);
    });
    if (pages > 1)
      rows.push([
        ...(page > 0
          ? [{ text: "← Таблицы", callback_data: `di:get:${data.id}:${page - 1}` }]
          : []),
        ...(page + 1 < pages
          ? [{ text: "Таблицы →", callback_data: `di:get:${data.id}:${page + 1}` }]
          : []),
      ]);
    rows.push([{ text: "📖 Читать текст документа", callback_data: `di:blocks:${data.id}:0` }]);
    rows.push([
      { text: "🛠 Скачать технический разбор (JSON)", callback_data: `di:text:${data.id}` },
    ]);
  }
  if (data.state === "failed")
    lines.push(
      "Результат не подтверждён. Оригинал сохранён. Требуется разбор администратором; автоматических повторов нет.",
    );
  if (["queued", "extracting"].includes(data.state ?? ""))
    rows.push([{ text: "✖️ Отменить обработку", callback_data: `di:cancel:${data.id}` }]);
  rows.push(
    [{ text: "🔄 Обновить результат", callback_data: `di:get:${data.id}` }],
    [{ text: "📚 Все документы", callback_data: "di:home" }],
  );
  return { text: lines.join("\n\n"), rows };
}

export function renderIntakeChecks(data: IntakeView, index: number) {
  const table = data.extraction?.tables[index];
  const rows = [
    [{ text: "📎 Скачать оригинал", callback_data: `di:original:${data.id}` }],
    [
      {
        text: "📚 К таблицам документа",
        callback_data: `di:get:${data.id}:${Math.floor(index / 8)}`,
      },
    ],
  ];
  if (!table)
    return {
      text: "⚠️ Таблица недоступна. Вернитесь к документу и обновите результат. Проверка и импорт не начаты.",
      rows,
    };
  rows.unshift([
    { text: "🔎 Открыть строки для проверки", callback_data: `di:table:${data.id}:${index}` },
  ]);
  return {
    text: [
      `📄 ${short(data.file_name)}\nТаблица ${index + 1}: ${short(table.label)} · ${table.rows.length} строк`,
      documentGuidance(
        [...(table.warnings ?? []), ...(data.extraction?.warnings ?? [])],
        data.extraction?.coverage,
      ),
    ].join("\n\n"),
    rows,
  };
}
