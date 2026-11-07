export interface DocumentModelLink {
  review_id: string;
  row: number;
  model_revision: number;
  decision_id: string | null;
  identity: { manufacturer: string; model: string; variant_mode: string; variant: string } | null;
  state: string;
  product_id: string | null;
  document_id: string;
  file_name: string;
  linked_at: string | null;
  import_id?: string;
  line?: number;
}
export interface ProductModelLinks {
  ok: true;
  product_id: string;
  title: string;
  sku: string | null;
  items: DocumentModelLink[];
  page: number;
  pages: number;
  conflicting: boolean;
  excluded: boolean;
}
export const modelLinkState: Record<string, string> = {
  unconfirmed: "❔ Модель не подтверждена. Источник сохранён для ручной проверки.",
  model_changed:
    "⚠️ Решение о модели изменилось. Этот снимок больше не подтверждает актуальную модель.",
  undone: "↩️ Импорт отменён. Связь осталась только в истории.",
  canceled: "↩️ Импорт отменён до применения.",
  preview: "🏷 Модель будет связана с товаром после подтверждения импорта.",
  excluded: "⛔ Товар исключён из ассортимента. Эта связь не разрешает его возвращать.",
  product_changed: "⚠️ Карточка товара изменилась. Прежняя связь с моделью требует новой сверки.",
  linked: "📎 Связь с источником сохранена.",
};
export function modelIdentityText(l: DocumentModelLink) {
  const i = l.identity;
  return i
    ? `Производитель: ${i.manufacturer}\nМодель: ${i.model}\nМодификация: ${i.variant_mode === "none" ? "Отдельной модификации нет" : i.variant}`
    : "Точная модель пока неизвестна.";
}
export function parseProductModelCallback(value: string) {
  const m = value.match(
    /^mp:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{1,4})$/,
  );
  return m && Number(m[2]) <= 1666 ? { id: m[1]!, page: Number(m[2]) } : null;
}
export function renderProductModelLinks(r: ProductModelLinks) {
  const rows: { text: string; callback_data: string }[][] = [];
  let text = `📎 Модель и исходные документы\n${r.title}\nАртикул: ${r.sku || "Не указан"}\n\n`;
  if (r.excluded)
    text += "⛔ Товар исключён из ассортимента. История не возвращает его на сайт.\n\n";
  if (r.conflicting)
    text +=
      "⚠️ Для этого товара подтверждены разные модели. Не выбирайте одну автоматически: сначала сверяйте документы и карточку.\n\n";
  if (!r.items.length)
    text +=
      "Связей с вашими документами пока нет. Они появляются после проверки строк и отдельного подтверждения импорта.";
  rows.push([
    { text: "🎯 Прочитать актуальный выбор модели", callback_data: `pm:view:${r.product_id}` },
  ]);
  for (const [index, l] of r.items.entries()) {
    text += `${index + 1}. ${l.file_name}\n${modelLinkState[l.state] ?? "Требуется проверка"}\n${modelIdentityText(l)}\n\n`;
    rows.push([
      {
        text: `🏷 ${index + 1}. Открыть модель в документе`,
        callback_data: `dm:${l.review_id}:0:get:${l.row}`,
      },
    ]);
    if (!r.excluded && l.state === "linked" && l.import_id && l.line)
      rows.push([
        {
          text: `🎯 ${index + 1}. Выбрать эту модель…`,
          callback_data: `pm:pick:${l.import_id}:${l.line}`,
        },
      ]);
    if (l.import_id)
      rows.push([
        { text: `📥 ${index + 1}. Открыть импорт`, callback_data: `ci:get:${l.import_id}:0` },
      ]);
    rows.push([
      { text: `📎 ${index + 1}. Скачать оригинал`, callback_data: `di:original:${l.document_id}` },
    ]);
  }
  text +=
    "\nЭто история ваших источников. «Выбрать эту модель» сначала покажет отдельное подтверждение. Выбор не меняет карточку и не запускает поиск или публикацию. Изменённые и противоречивые сведения требуют нового решения человека.";
  text += `\nСтраница ${r.page + 1} из ${r.pages}.`;
  if (r.page > 0)
    rows.push([
      { text: "← Предыдущие источники", callback_data: `mp:${r.product_id}:${r.page - 1}` },
    ]);
  if (r.page + 1 < r.pages)
    rows.push([
      { text: "Следующие источники →", callback_data: `mp:${r.product_id}:${r.page + 1}` },
    ]);
  rows.push([{ text: "↩️ К карточке товара", callback_data: `prd:${r.product_id}` }]);
  return { text, rows };
}
