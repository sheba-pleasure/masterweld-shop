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
    blocks: { locator: string; text: string }[];
    warnings: string[];
    coverage: { complete?: boolean; pages?: number; processed?: number };
  };
}
const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function parseIntakeCallback(
  data: string,
): { op: string; id?: string; index?: number; page?: number } | null {
  if (data === "di:home") return { op: "home" };
  let match = data.match(new RegExp(`^di:(get|cancel|text|original):(${id})$`));
  if (match) return { op: match[1]!, id: match[2]! };
  match = data.match(new RegExp(`^di:get:(${id}):([0-9]{1,2})$`));
  if (match) return { op: "get", id: match[1]!, page: Number(match[2]) };
  match = data.match(new RegExp(`^di:table:(${id}):([0-9]{1,2})$`));
  return match ? { op: "table", id: match[1]!, index: Number(match[2]) } : null;
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
      text: "📚 Документы → товары\n\nПришлите файл до 5 МБ. XLSX, ODS, DOCX, PDF, TXT, TSV и изображения распознаются локально. Сканам доступен русский и английский OCR. Другие форматы сохраняются для ручного разбора. CSV доступен через /import.\n\n1️⃣ Сохраним оригинал.\n2️⃣ Выделим таблицы или строки-кандидаты.\n3️⃣ Вы исправите строки и решите: проверить или пропустить.\n4️⃣ Импорт покажет изменения до подтверждения.\n\nНичего не публикуется автоматически. Поиск источников и генерация изображений/описаний пока не подключены.\n\nПосле загрузки нажмите «Обновить результат»; уведомление об окончании не рассылается.",
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
    if (!extraction.coverage.complete || extraction.warnings.length)
      lines.push(
        "⚠️ Нужна сверка с оригиналом: часть содержимого может требовать ручного разбора. Смешанные сканы, объединённые ячейки и формулы не считаются проверенными.",
      );
    lines.push(
      "Выберите таблицу. Для каждой строки доступны исходные данные, исправление полей и решение «Строка проверена» или «Пропустить». Затем подтвердите передачу в предпросмотр импорта. Закупочная цена и розничная — разные поля. Строка текста ещё не означает товар.",
    );
    if (extraction.warnings.includes("FORMAT_REQUIRES_MANUAL_CONVERSION"))
      lines.push(
        "Этот формат пока не распознаётся. Скачайте оригинал, сохраните таблицу как XLSX/CSV или документ как PDF и отправьте новый файл.",
      );
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
    rows.push([
      { text: "📋 Получить извлечение и источники", callback_data: `di:text:${data.id}` },
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
