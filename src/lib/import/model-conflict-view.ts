import { modelIdentityText, type DocumentModelLink } from "./model-links-view";

type Identity = NonNullable<DocumentModelLink["identity"]>;
export interface ModelComparison {
  line: number;
  sku: string;
  incoming: Identity | null;
  previous: Identity[];
  page: number;
  pages: number;
  conflict: boolean;
  accepted: boolean;
  review_id: string;
  row: number;
}
export function renderModelComparison(id: string, revision: number, c: ModelComparison) {
  const rows: { text: string; callback_data: string }[][] = [];
  const identity = (value: Identity | null) =>
    modelIdentityText({ identity: value } as DocumentModelLink);
  const lines = [
    "🔎 Сверка модели перед импортом",
    `Артикул: ${c.sku}\nСтрока импорта: ${c.line}`,
    "📌 Ранее сохранено для этого товара",
    ...c.previous.map((v, n) => `${c.page * 3 + n + 1}.\n${identity(v)}`),
    `📄 В новом документе\n${identity(c.incoming)}`,
    c.accepted
      ? "✅ Вы подтвердили, что это тот же товар. Сам импорт ещё не выполнен."
      : c.conflict
        ? "⚠️ Сведения различаются. Совпадение артикула само по себе не означает, что это тот же товар."
        : "✅ Различий с сохранёнными моделями нет.",
    "Сначала сверьте производителя, модель и модификацию. Если это другой товар — отмените импорт, исправьте артикул в исходном файле и отправьте исправленный файл через «Документы».",
    c.incoming
      ? "Кнопка «Это тот же товар» сохранит ваше решение только для этого предпросмотра. После этого отдельно подтвердите импорт. Прежние сведения останутся в истории; публикация не изменится."
      : "Сначала уточните новую модель по кнопке ниже, затем вернитесь в импорт и обновите предпросмотр. Если не уверены — оставьте импорт на проверке.",
    `Сохранённые модели: страница ${c.page + 1} из ${c.pages}.`,
  ];
  if (c.page > 0)
    rows.push([
      {
        text: "← Предыдущие модели",
        callback_data: `ci:mc:${id}:${revision}:${c.line}:${c.page - 1}`,
      },
    ]);
  if (c.page + 1 < c.pages)
    rows.push([
      {
        text: "Следующие модели →",
        callback_data: `ci:mc:${id}:${revision}:${c.line}:${c.page + 1}`,
      },
    ]);
  if (c.conflict && c.incoming && !c.accepted && c.page + 1 === c.pages)
    rows.push([
      {
        text: "✅ Это тот же товар — подтверждаю",
        callback_data: `ci:ma:${id}:${revision}:${c.line}`,
      },
    ]);
  rows.push(
    [{ text: "🏷 Уточнить новую модель", callback_data: `dm:${c.review_id}:0:get:${c.row}` }],
    [{ text: "↩️ Не уверен — вернуться без решения", callback_data: `ci:get:${id}:0` }],
    [{ text: "⛔ Другой товар — отменить весь импорт", callback_data: `ci:cancel:${id}` }],
  );
  return { text: lines.join("\n\n"), rows };
}
