import { modelIdentityText, type DocumentModelLink } from "./model-links-view";

type Identity = NonNullable<DocumentModelLink["identity"]>;
export interface ProductModelChoice {
  ok: true;
  product_id: string;
  title: string;
  sku: string | null;
  current: {
    state: "unselected" | "selected" | "stale" | "excluded" | "withdrawn";
    revision: number;
    usable: boolean;
    choice_id?: string;
    identity?: Identity | null;
  };
  request: {
    id: string;
    kind: "select" | "clear";
    state: "prepared" | "confirmed" | "canceled" | "expired" | "stale";
    identity: Identity | null;
    source: DocumentModelLink | null;
    other_models: number;
    expires_at: string;
  } | null;
}
export interface ModelChoiceAction {
  op: "get" | "prepare" | "prepare_clear" | "read" | "confirm" | "cancel";
  product?: string;
  batch?: string;
  line?: number;
  request?: string;
}
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function parseModelChoiceCallback(value: string): ModelChoiceAction | null {
  let m = value.match(new RegExp(`^pm:(view|clear):(${uuid})$`));
  if (m) return { op: m[1] === "view" ? "get" : "prepare_clear", product: m[2]! };
  m = value.match(new RegExp(`^pm:pick:(${uuid}):([0-9]{1,4})$`));
  if (m) {
    const line = Number(m[2]);
    return line >= 2 && line <= 5001 ? { op: "prepare", batch: m[1]!, line } : null;
  }
  m = value.match(new RegExp(`^pm:(read|confirm|cancel):(${uuid})$`));
  return m ? { op: m[1] as "read" | "confirm" | "cancel", request: m[2]! } : null;
}
function identityText(identity: Identity | null | undefined) {
  return modelIdentityText({ identity: identity ?? null } as DocumentModelLink);
}
export function renderModelChoice(r: ProductModelChoice) {
  const rows: { text: string; callback_data: string }[][] = [];
  const current = r.current,
    request = r.request;
  let text = `🎯 Модель для поиска\n${r.title}\nАртикул: ${r.sku || "Не указан"}\n\n`;
  const labels: Record<ProductModelChoice["current"]["state"], string> = {
    unselected: "❔ Актуальная модель ещё не выбрана.",
    selected: "✅ Эта модель выбрана человеком для будущего поиска.",
    stale:
      "⚠️ После выбора изменились карточка или сведения источников. Прежний выбор требует новой проверки.",
    excluded: "⛔ Товар исключён из ассортимента. Выбор модели не возвращает его на сайт.",
    withdrawn: "❔ Выбор снят человеком. Автоматической замены другой моделью нет.",
  };
  text += labels[current.state] + "\n";
  if (current.identity) text += "\n" + identityText(current.identity) + "\n";
  if (request) {
    text += "\n";
    if (request.state === "prepared") {
      if (request.kind === "select") {
        text +=
          "🔎 Перед подтверждением\nБудет выбрана модель:\n" +
          identityText(request.identity) +
          "\n";
        if (request.source) text += "\nИсточник: " + request.source.file_name + "\n";
        if (request.other_models)
          text +=
            "\n⚠️ В истории есть другие модели: " +
            request.other_models +
            ". Сверьте, что выбранная модель действительно относится к этому товару. История не удалится.\n";
        text +=
          "\n«Подтвердить выбор» сохранит именно эту модель для будущего поиска характеристик и фото. Цена, название и статус товара не изменятся. Прежние характеристики могут быть скрыты до повторной сверки с этой моделью.\n";
        rows.push([
          { text: "✅ Подтвердить выбор модели", callback_data: "pm:confirm:" + request.id },
        ]);
      } else {
        text +=
          "❔ Снять текущий выбор?\nПосле подтверждения модель для поиска станет невыбранной. Товар, его цена и история останутся прежними. Характеристики, связанные с прежним выбором модели, потребуют повторной сверки.\n";
        rows.push([{ text: "✅ Снять выбор модели", callback_data: "pm:confirm:" + request.id }]);
      }
      rows.push([
        { text: "↩️ Отменить — оставить прежний выбор", callback_data: "pm:cancel:" + request.id },
      ]);
    } else {
      const stateText = {
        confirmed:
          "✅ Это решение уже сохранено. Выше показан текущий выбор; повтор не возвращает прежнюю модель.",
        canceled: "↩️ Подготовленный выбор отменён. Действующая модель этим не изменена.",
        expired: "⌛ Время подтверждения истекло. Откройте источники и подготовьте выбор заново.",
        stale:
          "⚠️ Сведения изменились после подготовки. Старое подтверждение недоступно. Откройте источники и проверьте выбор заново.",
      };
      text += stateText[request.state] + "\n";
    }
    if (request.source) {
      rows.push([
        {
          text: "📎 Скачать выбранный источник",
          callback_data: "di:original:" + request.source.document_id,
        },
      ]);
      rows.push([
        {
          text: "🏷 Проверить модель в документе",
          callback_data: `dm:${request.source.review_id}:0:get:${request.source.row}`,
        },
      ]);
    }
  }
  if (!request || request.state !== "prepared") {
    if (!["unselected", "withdrawn"].includes(current.state))
      rows.push([
        {
          text: "❔ Не уверен — подготовить снятие выбора",
          callback_data: "pm:clear:" + r.product_id,
        },
      ]);
  }
  text +=
    "\nПоиск в интернете, описания и генерация фото пока не подключены. Выбор ничего не импортирует и не публикует.";
  rows.push([
    { text: "📎 Выбрать из исходных документов", callback_data: "mp:" + r.product_id + ":0" },
  ]);
  rows.push([{ text: "🔄 Прочитать текущий выбор", callback_data: "pm:view:" + r.product_id }]);
  rows.push([{ text: "⚙️ Проверить характеристики", callback_data: "te:open:" + r.product_id }]);
  rows.push([{ text: "↩️ К карточке товара", callback_data: "prd:" + r.product_id }]);
  return { text, rows };
}
