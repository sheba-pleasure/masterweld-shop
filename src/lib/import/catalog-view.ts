import { FIELDS, FIELD_LABEL, catalogColumnLabel, type Field, type Mapping } from "./catalog-file";

import { modelIdentityText, modelLinkState, type DocumentModelLink } from "./model-links-view";

type Button = { text: string; callback_data: string };
type Product = Partial<Record<Field | "category_id", string | number | boolean | null>>;
export interface ImportView {
  ok: true;
  home?: boolean;
  id: string;
  file: string;
  state: string;
  revision: number;
  header: string[];
  sample: string[];
  mapping: Mapping;
  decimal: "comma" | "dot";
  fileRows: number;
  counts: { new: number; update: number; unchanged: number; error: number; excluded: number };
  page: number;
  pages: number;
  recent?: { id: string; file_name: string; state: string }[];
  document_review_id?: string;
  model_count?: number;
  model_capture_ready?: boolean;
  items: {
    line: number;
    sku: string;
    kind: string;
    errors: string[];
    patch: Product;
    before_product: Product | null;
    after_product: Product | null;
    before_cost: { cost_price: number } | null;
    after_cost: { cost_price: number } | null;
    document_model?: DocumentModelLink | null;
  }[];
}
export interface ImportRequest {
  op: string;
  id?: string;
  page?: number;
  revision?: number;
  field?: number;
  column?: number;
  decimal?: string;
}
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function parseImportCallback(data: string): ImportRequest | null {
  if (data === "ci:home" || data === "ci:template") return { op: data.slice(3) };
  let m = data.match(
    new RegExp(`^ci:(get|config|cancel|undo_preview|undo):(${ID})(?::([0-9]{1,4}))?$`),
  );
  if (m) return { op: m[1]!, id: m[2]!, page: Number(m[3] ?? 0) };
  m = data.match(new RegExp(`^ci:(preview|apply):(${ID}):([0-9]{1,7})$`));
  if (m) return { op: m[1]!, id: m[2]!, revision: Number(m[3]) };
  m = data.match(new RegExp(`^ci:field:(${ID}):([0-7])$`));
  if (m) return { op: "field", id: m[1]!, field: Number(m[2]) };
  m = data.match(new RegExp(`^ci:map:(${ID}):([0-7]):(-1|[0-9]{1,2}):([0-9]{1,7})$`));
  if (m)
    return {
      op: "map",
      id: m[1]!,
      field: Number(m[2]),
      column: Number(m[3]),
      revision: Number(m[4]),
    };
  m = data.match(new RegExp(`^ci:decimal:(${ID}):(comma|dot):([0-9]{1,7})$`));
  if (m) return { op: "decimal", id: m[1]!, decimal: m[2]!, revision: Number(m[3]) };
  return null;
}
const short = (value: unknown, n = 70) =>
  String(value ?? "—")
    .replace(/\s+/g, " ")
    .slice(0, n);
const state: Record<string, string> = {
  config: "Настройка",
  preview: "Предпросмотр",
  applied: "Применён",
  undo_preview: "Подтверждение отката",
  undone: "Откат выполнен",
  canceled: "Отменён",
};
const reason: Record<string, string> = {
  ROW_WIDTH: "Число ячеек не совпадает с заголовком",
  BAD_SKU: "Нет корректного артикула",
  FORMULA: "Формула вместо значения",
  BAD_PRICE: "Некорректная цена или десятичный разделитель",
  BAD_STOCK: "Наличие: да/нет",
  BAD_QTY: "Количество: целое от 0 до 1000000",
  BAD_TEXT: "Некорректное название, бренд или код раздела",
  STOCK_CONFLICT: "Количество противоречит наличию",
  DUPLICATE_SKU: "Артикул повторяется в файле",
  AMBIGUOUS_SKU: "Несколько товаров с таким артикулом",
  CATEGORY_NOT_FOUND: "Код раздела не найден",
  NEW_REQUIRED: "Для нового товара нужны название и розничная цена",
};
function value(v: unknown): string {
  if (typeof v === "boolean") return v ? "да" : "нет";
  return short(v, 60);
}
export function renderImport(
  r: ImportView,
  screen?: "config" | number,
): { text: string; rows: Button[][] } {
  const rows: Button[][] = [];
  if (r.home)
    return {
      text: "📥 Импорт товаров и цен\n\n1️⃣ Файл\nПришлите CSV UTF-8: до 2 МБ и 5000 строк. Первая строка — заголовки. Из Excel сохраните как CSV UTF-8. XLSX/PDF и сканы отправьте через «Документы»: там можно проверить и исправить распознанные строки.\n\n2️⃣ Колонки\nУкажите артикул, название и нужные поля. Цена продажи и закупка выбираются отдельно; суммы — в рублях.\n\n3️⃣ Предпросмотр\nПроверьте изменения и только затем подтвердите импорт.\n\n🛡 Новые товары — черновики «На разбор». Публикация и отметка «Не продаём» сохраняются. Товары вне файла не меняются.\n\n👇 Начните с учебного CSV.",
      rows: [
        [{ text: "📄 Получить учебный CSV", callback_data: "ci:template" }],
        ...(r.recent ?? []).map((b) => [
          {
            text: `${state[b.state]} · ${short(b.file_name, 35)} · ${b.id.slice(0, 8)}`,
            callback_data: `ci:get:${b.id}`,
          },
        ]),
        [{ text: "📚 Документы и распознавание", callback_data: "di:home" }],
        [{ text: "Главное меню", callback_data: "home" }],
      ],
    };
  if (typeof screen === "number" && ["config", "preview"].includes(r.state)) {
    const field = FIELDS[screen]!;
    return {
      text: `🗂 Выберите колонку: ${FIELD_LABEL[field]}\nФайл: ${short(r.file)}\nПример — первая строка данных. «Не импортировать» оставляет прежнее поле без изменения.`,
      rows: [
        ...r.header.map((h, index) => [
          {
            text: `${index + 1}. ${short(catalogColumnLabel(h, index), 25)} · ${short(r.sample?.[index], 30)}`,
            callback_data: `ci:map:${r.id}:${screen}:${index}:${r.revision}`,
          },
        ]),
        [
          {
            text: "Не импортировать это поле",
            callback_data: `ci:map:${r.id}:${screen}:-1:${r.revision}`,
          },
        ],
        [{ text: "К настройке", callback_data: `ci:config:${r.id}` }],
      ],
    };
  }
  if (r.state === "config" || (screen === "config" && r.state === "preview")) {
    return {
      text: [
        `⚙️ Настройка импорта · ${r.id.slice(0, 8)}\nФайл: ${short(r.file)}\nСтрок в файле: ${r.fileRows}.`,
        "Проверьте каждую колонку. Сопоставление товаров — только по уникальному артикулу.",
        ...FIELDS.map(
          (f) =>
            `${FIELD_LABEL[f]}: ${r.mapping[f] >= 0 ? short(catalogColumnLabel(r.header[r.mapping[f]], r.mapping[f]), 45) : "не импортировать"}`,
        ),
        `Десятичный разделитель: ${r.decimal === "comma" ? "запятая (123,45)" : "точка (123.45)"}.`,
        `Неиспользуемые колонки: ${
          r.header
            .filter((_, index) => !Object.values(r.mapping).includes(index))
            .map((h) => short(h, 25))
            .join(", ") || "нет"
        }.`,
        "Пустые ячейки сохраняют прежние значения. Количество автоматически задаёт наличие: 0 — нет, больше 0 — есть. Закупка не заменяет розничную цену; наценка автоматически не рассчитывается.",
        "Для новых товаров обязательны артикул, название и розничная цена. Код раздела — существующий slug; разделы не создаются автоматически. Фото и публикация этим файлом не меняются.",
      ].join("\n\n"),
      rows: [
        ...FIELDS.map((f, index) => [
          { text: `Колонка: ${FIELD_LABEL[f]}`, callback_data: `ci:field:${r.id}:${index}` },
        ]),
        [
          { text: "Цены: 123,45", callback_data: `ci:decimal:${r.id}:comma:${r.revision}` },
          { text: "Цены: 123.45", callback_data: `ci:decimal:${r.id}:dot:${r.revision}` },
        ],
        [{ text: "👁 Построить предпросмотр", callback_data: `ci:preview:${r.id}:${r.revision}` }],
        [{ text: "Отменить импорт", callback_data: `ci:cancel:${r.id}` }],
        [{ text: "К импортам", callback_data: "ci:home" }],
      ],
    };
  }
  const lines = [
    `📥 Импорт · ${r.id.slice(0, 8)} · ${state[r.state]}\nФайл: ${short(r.file)}`,
    `\n➕ Новых: ${r.counts.new}\n✏️ Изменятся: ${r.counts.update}\n➖ Без изменений: ${r.counts.unchanged}\n⚠️ Ошибок: ${r.counts.error}\n`,
    `🛡 Исключённых товаров в файле: ${r.counts.excluded}. Они останутся скрытыми. Новые товары не появятся на сайте.`,
  ];
  if (r.state === "undo_preview")
    lines.push(
      "Откат вернёт прежние импортированные поля существующих товаров. Новые карточки будут скрыты и отмечены «Не продаём», с сохранением заказов и фото. Если после импорта были правки, откат остановится целиком. Подтверждение — 30 минут.",
    );
  else if (r.state === "undone")
    lines.push(
      "Прежние импортированные значения восстановлены. Созданные этим импортом карточки оставлены в «Не продаём».",
    );
  else if (r.state === "applied")
    lines.push("✅ Импорт сохранён.\n↩️ Откат доступен 7 дней с проверкой последующих изменений.");
  else if (r.state === "canceled") lines.push("Импорт отменён, товары не изменены.");
  else
    lines.push(
      r.counts.error
        ? "Исправьте ошибки в файле или сопоставление колонок. Ни одна строка не будет применена при наличии ошибок."
        : "Проверьте все страницы. Подтверждение действует 30 минут. Товары вне файла не меняются.",
    );
  if (r.document_review_id && r.model_capture_ready === false)
    lines.push(
      r.state === "preview"
        ? "В этом прежнем предпросмотре сведения о моделях ещё не сохранены. Обновите предпросмотр перед подтверждением."
        : "Для этого прежнего импорта снимки моделей не создавались. История не дополняется задним числом.",
    );
  else if (r.document_review_id)
    lines.push(
      `🏷 Подтверждённых моделей в этом предпросмотре: ${r.model_count ?? 0}. Связь с исходными строками сохраняется при подтверждении. Автопоиск и публикация не запускаются. Если исправили модель, обновите предпросмотр.`,
    );
  lines.push("Ниже — снимок предложений исходного импорта:");
  for (const i of r.items) {
    lines.push(
      `\nСтрока ${i.line} · ${short(i.sku, 60)} · ${{ new: "новый", update: "изменение", unchanged: "без изменений", error: "ошибка" }[i.kind]}\n${short(i.after_product?.title, 90)}`,
    );
    if (i.document_model) {
      const l = i.document_model;
      lines.push(modelLinkState[l.state] ?? "Модель требует проверки", modelIdentityText(l));
      rows.push([
        {
          text: `🏷 Строка ${i.line}: проверить модель`,
          callback_data: `dm:${l.review_id}:0:get:${l.row}`,
        },
      ]);
      if (l.product_id)
        rows.push([
          { text: `📎 Строка ${i.line}: источники товара`, callback_data: `mp:${l.product_id}:0` },
        ]);
    }
    const oldPrice = Number(i.before_product?.price ?? 0),
      newPrice = Number(i.after_product?.price ?? 0);
    if (oldPrice > 0 && Math.abs(newPrice - oldPrice) / oldPrice >= 0.3)
      lines.push(
        `⚠️ Внимание: цена меняется на ${Math.round(((newPrice - oldPrice) / oldPrice) * 100)}%. Проверьте сумму.`,
      );
    if (i.after_cost && newPrice < Number(i.after_cost.cost_price))
      lines.push("⚠️ Внимание: розничная цена ниже закупочной.");
    if (i.errors.length)
      lines.push([...new Set(i.errors)].map((e) => reason[e] ?? "Ошибка строки").join("; "));
    else
      for (const f of FIELDS.filter((f) => f !== "sku" && f in i.patch)) {
        const before =
          f === "cost_price"
            ? i.before_cost?.cost_price
            : f === "category_slug"
              ? i.before_product?.category_id
              : i.before_product?.[f];
        const after = f === "cost_price" ? i.after_cost?.cost_price : i.patch[f];
        // Category IDs are internal: show requested code without exposing UUIDs as instructions.
        const description =
          f === "category_slug" ? value(after) : `${value(before)} → ${value(after)}`;
        lines.push(`${FIELD_LABEL[f]}: ${description}`);
      }
  }
  lines.push(`\nСтраница ${r.page + 1} из ${r.pages}.`);
  if (r.pages > 1)
    rows.push([
      ...(r.page > 0 ? [{ text: "←", callback_data: `ci:get:${r.id}:${r.page - 1}` }] : []),
      ...(r.page + 1 < r.pages
        ? [{ text: "→", callback_data: `ci:get:${r.id}:${r.page + 1}` }]
        : []),
    ]);
  if (r.state === "preview") {
    if (
      !r.counts.error &&
      r.model_capture_ready !== false &&
      (r.counts.new + r.counts.update > 0 || (r.model_count ?? 0) > 0)
    )
      rows.push([
        {
          text:
            r.counts.new + r.counts.update > 0
              ? `✅ Подтвердить: ${r.counts.new + r.counts.update} товаров`
              : "✅ Сохранить связи с моделями",
          callback_data: `ci:apply:${r.id}:${r.revision}`,
        },
      ]);
    if (r.document_review_id)
      rows.push([
        { text: "🔄 Обновить предпросмотр", callback_data: `ci:preview:${r.id}:${r.revision}` },
      ]);
    rows.push(
      [{ text: "Изменить колонки", callback_data: `ci:config:${r.id}` }],
      [{ text: "Отменить импорт", callback_data: `ci:cancel:${r.id}` }],
    );
  }
  if (r.state === "applied")
    rows.push([{ text: "Откатить этот импорт…", callback_data: `ci:undo_preview:${r.id}` }]);
  if (r.state === "undo_preview")
    rows.push([{ text: "Подтвердить откат", callback_data: `ci:undo:${r.id}` }]);
  rows.push([{ text: "К импортам", callback_data: "ci:home" }]);
  return { text: lines.join("\n"), rows };
}
const ERRORS: Record<string, string> = {
  IMPORT_MODEL_CHANGED:
    "Решение о модели изменилось после предпросмотра. Откройте импорт и обновите предпросмотр, затем проверьте сведения заново.",
  IMPORT_MODEL_PREVIEW_REQUIRED:
    "Этот предпросмотр ещё не сохраняет сведения о модели. Обновите его и проверьте строки перед подтверждением.",
  IMPORT_MODEL_SOURCE:
    "Не удалось точно связать строку с исходным документом. Импорт остановлен. Нужна проверка владельцем.",
  DOCUMENT_REVIEW_REQUIRED:
    "Сначала проверьте строки через «Документы». Этот старый импорт создан до обязательной проверки. Отмените его и продолжите разбор документа.",
  IMPORT_DENIED: "Нет права импортировать товары и просматривать закупочные данные.",
  IMPORT_NOT_FOUND: "Импорт не найден или принадлежит другому сотруднику.",
  IMPORT_BAD_INPUT: "Некорректные параметры импорта. Откройте раздел заново.",
  IMPORT_CLOSED: "Этот импорт уже закрыт. Откройте его состояние через /import.",
  IMPORT_EXPIRED: "Срок подтверждения истёк. Для нового разбора отправьте файл заново.",
  IMPORT_STALE: "Настройки изменились. Откройте импорт заново и постройте свежий предпросмотр.",
  IMPORT_CONFLICT:
    "Товары или закупочные цены изменились после предпросмотра. Операция остановлена целиком; последующие правки сохраняются.",
  IMPORT_BLOCKED: "Применение заблокировано: есть ошибки либо нечего изменять.",
  BAD_MAPPING: "Укажите колонку артикула. Одну колонку нельзя использовать для разных полей.",
  NO_FIELDS: "Выберите хотя бы одно поле для импорта помимо артикула.",
  FILE_TOO_LARGE: "Файл больше 2 МБ. Разделите его на несколько файлов.",
  TOO_MANY_ROWS: "Больше 5000 строк. Разделите файл; строки не будут обрезаны автоматически.",
  UNSUPPORTED_ENCODING: "Нужен CSV в UTF-8. В Excel выберите «CSV UTF-8».",
  AMBIGUOUS_DELIMITER:
    "Не удалось однозначно определить разделитель CSV. Используйте ;, запятую или табуляцию.",
  MALFORMED_QUOTES: "В CSV повреждены кавычки. Пересохраните файл как CSV UTF-8.",
  EMPTY_FILE: "Файл пуст или не содержит данных.",
  BAD_HEADER: "Нужен заголовок из 2–30 колонок, до 100 символов каждый.",
  CELL_TOO_LARGE: "Слишком длинная ячейка, больше 30 колонок или недопустимый символ.",
  FILE_FORMAT: "Сейчас принимается только CSV UTF-8. XLSX/PDF сохраните как CSV UTF-8.",
  FILE_DOWNLOAD:
    "Файл не удалось получить из Telegram. Каталог на этапе загрузки не меняется. Отправьте файл ещё раз.",
};
export function importError(message?: string) {
  return (
    ERRORS[message ?? ""] ??
    "Результат не подтверждён. Откройте /import и последний импорт, чтобы проверить сохранённое состояние. Не запускайте повторный импорт вслепую."
  );
}
