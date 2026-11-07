import { catalogColumnLabel } from "./catalog-file";
import { orderDateMoscow } from "@/lib/bot/orders";

export interface ModelPrompt {
  kind?: "cell" | "structure" | "model";
  review_id: string;
  revision: number;
  row_index: number;
  column_index: number;
  message_id: number | null;
}
export interface ModelView {
  ok: true;
  id: string;
  row: number;
  revision: number;
  row_revision: number;
  file_name: string;
  table_label: string;
  document_id: string;
  header: string[];
  cells: string[];
  eligible: boolean;
  stale: boolean;
  usable: boolean;
  state: "draft" | "confirmed" | "needs_review";
  manufacturer: string;
  model: string;
  variant_mode: "unknown" | "none" | "specified";
  variant: string;
  focus: number;
  prompt: ModelPrompt | null;
  notice?: string | null;
  history: {
    id: string;
    decision: string;
    identity: {
      manufacturer: string;
      model: string;
      variant_mode: string;
      variant: string;
    };
    created_at: string;
  }[];
}
const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function parseModelCallback(value: string) {
  const m = value.match(
    new RegExp(
      `^dm:(${id}):([0-9]{1,7}):(get|history|start|askbrand|askmodel|askvar|resume|novar|uncertain|confirm|cancel):([0-9]{1,4})$`,
    ),
  );
  return m && Number(m[4]) <= 4999
    ? { id: m[1]!, revision: Number(m[2]), op: m[3]!, row: Number(m[4]) }
    : null;
}
export const modelQuestions = [
  "Кто изготовил товар? Укажите точное название производителя по исходному документу. Если не знаете, выберите «Не уверен» в карточке модели.",
  "Какая точная модель товара? Сохраните все буквы, цифры и обозначения из источника. Не заменяйте её похожей моделью.",
  "Какая модификация или исполнение? Например, обозначение варианта из документа. Не дописывайте характеристики, которых нет в источнике.",
];
const short = (value: string, n = 90) => (value.length > n ? value.slice(0, n - 1) + "…" : value);
export function modelButton(r: ModelView, text: string, op: string) {
  const callback_data = `dm:${r.id}:${r.revision}:${op}:${r.row}`;
  if (Buffer.byteLength(callback_data) > 64) throw new Error("MODEL_CALLBACK");
  return { text, callback_data };
}
export function renderModel(r: ModelView, history = false) {
  const rows: { text: string; callback_data: string }[][] = [];
  const add = (text: string, op: string) => rows.push([modelButton(r, text, op)]);
  let text = `🏷 Модель для поиска источников\n${short(r.file_name)} · ${short(r.table_label)}\n\n`;
  if (r.notice) text += r.notice + "\n\n";
  if (history) {
    text +=
      "📋 Последние решения по этой строке\nИстория не заменяет текущее состояние модели. Изменение исходной строки может сделать старое подтверждение непригодным.\n\n";
    text += r.history.length
      ? r.history
          .map((h) =>
            [
              orderDateMoscow(h.created_at) +
                " · " +
                (h.decision === "confirmed" ? "Модель была подтверждена" : "Оставлена на проверке"),
              "Производитель: " + (h.identity.manufacturer || "Не указан"),
              "Модель: " + (h.identity.model || "Не указана"),
              "Модификация: " +
                (h.identity.variant_mode === "none"
                  ? "Отдельной модификации нет"
                  : h.identity.variant_mode === "unknown"
                    ? "Неизвестна"
                    : h.identity.variant),
            ].join("\n"),
          )
          .join("\n\n")
      : "Решений пока нет.";
    add("↩️ К текущей модели", "get");
  } else {
    text += !r.eligible
      ? "⏳ Сначала проверьте исходную строку. Модель нельзя подтвердить для пропущенной, заменённой или ещё не проверенной строки, а также при незавершённом исправлении таблицы.\n\n"
      : r.stale
        ? "⚠️ Исходная строка изменилась. Прежнее подтверждение модели больше не подходит. Заполните сведения заново по текущему источнику. История сохранена.\n\n"
        : r.usable
          ? "✅ Модель подтверждена человеком для следующего этапа поиска.\n\n"
          : r.state === "needs_review"
            ? "❔ Модель оставлена на проверке. Поиск по догадке не запускается.\n\n"
            : "✏️ Уточните товар по исходному документу. Название магазина или артикул поставщика не заменяют производителя и точную модель.\n\n";
    text += `Производитель: ${r.manufacturer || "Не указан"}\nМодель: ${r.model || "Не указана"}\nМодификация: ${r.variant_mode === "none" ? "Отдельной модификации нет" : r.variant_mode === "unknown" ? "Пока неизвестна" : r.variant}\n\n`;
    text +=
      "Строка документа для сверки:\n" +
      r.header
        .slice(0, 6)
        .map((h, i) => `${catalogColumnLabel(h, i)}: ${short(r.cells[i] || "(Пусто)")}`)
        .join("\n");
    text +=
      "\n\nЭто отдельное решение о модели. Оно не исправляет строку, не создаёт товар и не запускает импорт. Автоматический поиск, описания и фотографии ещё не подключены.";
    if (r.prompt) {
      text +=
        "\n\nЕсть вопрос по модели. Ответьте именно на сообщение-вопрос. Просмотр карточки не повторяет вопрос.";
      if (r.eligible && !r.stale) add("✏️ Получить новый вопрос", "resume");
      add("↩️ Закрыть ввод модели", "cancel");
    } else if (r.eligible && !r.stale) {
      add(r.usable ? "✏️ Исправить — проверить заново" : "✏️ Заполнить по шагам", "start");
      if (r.manufacturer || r.model) {
        add("🏭 Исправить производителя", "askbrand");
        add("🏷 Исправить модель", "askmodel");
        add("🔎 Указать модификацию", "askvar");
        if (r.variant_mode !== "none") add("Отдельной модификации нет", "novar");
      }
      if (!r.usable && r.manufacturer && r.model && r.variant_mode !== "unknown" && r.focus < 0)
        add("✅ Подтвердить модель для поиска", "confirm");
      text +=
        "\n\nНачало исправления снимает подтверждение модели. «Отдельной модификации нет» выбирайте только после сверки; незнание варианта оставляйте на проверке.";
    }
    if (r.eligible && r.stale) add("✏️ Заполнить по новой строке", "start");
    if (r.eligible && !r.stale) add("❔ Не уверен — оставить на проверке", "uncertain");
    if (r.history.length) add("📋 История решений", "history");
  }
  rows.push([
    {
      text: "🔎 Сверить поля целиком",
      callback_data: `dr:${r.id}:${r.row_revision}:values:${r.row}:0`,
    },
  ]);
  rows.push([
    { text: "↩️ К проверке строки", callback_data: `dr:${r.id}:${r.row_revision}:get:${r.row}` },
  ]);
  rows.push([{ text: "📎 Скачать оригинал", callback_data: `di:original:${r.document_id}` }]);
  return { text, rows };
}
