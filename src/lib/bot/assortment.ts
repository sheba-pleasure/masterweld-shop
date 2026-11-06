import type { BtnRows } from "./catalog";

export const DECISION = {
  review: "На разбор",
  sell: "В ассортименте",
  excluded: "Не продаём",
} as const;
const STATUS = { published: "на сайте", draft: "черновик", hidden: "скрыт" } as const;
export const ACTION = {
  sell: "✅ В ассортимент",
  exclude: "🚫 Не продаём — скрыть",
  review: "📝 На разбор — в черновики",
  hide: "🙈 Скрыть с сайта",
} as const;
export const EFFECT = {
  sell: "Отметить, что будем продавать. Публикация на сайте не меняется. Скрытые товары останутся скрытыми.",
  exclude:
    "Отметить «Не продаём» и скрыть с сайта. Заказы, карточки, цены и фотографии сохранятся.",
  review: "Вернуть на разбор и перевести в черновики. На сайте эти товары показываться не будут.",
  hide: "Скрыть с сайта. Решение об ассортименте сохранить.",
} as const;

type Decision = keyof typeof DECISION;
type Action = keyof typeof ACTION;
export interface AssortmentResult {
  ok: true;
  home?: boolean;
  counts: Record<string, number>;
  recent?: { id: string; state: string; action: Action | null; created_at: string }[];
  id: string;
  state: string;
  action: Action | null;
  query: string;
  filter: Decision | "all";
  revision: number;
  total: number;
  selected: number;
  page: number;
  pages: number;
  items: {
    position: number;
    title: string;
    sku: string | null;
    category: string | null;
    selected: boolean;
    before_decision: Decision;
    before_status: keyof typeof STATUS;
  }[];
}
export interface AssortmentRequest {
  p_op: string;
  p_batch_id?: string;
  p_value?: string;
  p_page?: number;
  p_revision?: number;
  p_query?: string;
}
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function parseAssortmentCallback(data: string): AssortmentRequest | null {
  if (data === "as:home") return { p_op: "home" };
  const start = data.match(/^as:start:(review|sell|excluded|all)$/);
  if (start?.[1]) return { p_op: "start", p_value: start[1] };
  const item = data.match(
    new RegExp(`^as:(select|unselect):(${ID}):([1-9][0-9]{0,3}):([0-9]{1,3})$`),
  );
  if (item?.[1] && item[2] && item[3] && item[4])
    return { p_op: item[1], p_batch_id: item[2], p_value: item[3], p_page: Number(item[4]) };
  const preview = data.match(
    new RegExp(`^as:preview:(${ID}):(sell|exclude|review|hide):([0-9]{1,7})$`),
  );
  if (preview?.[1] && preview[2] && preview[3])
    return {
      p_op: "preview",
      p_batch_id: preview[1],
      p_value: preview[2],
      p_revision: Number(preview[3]),
    };
  const op = data.match(
    new RegExp(`^as:(get|all|none|apply|cancel|undo_preview|undo):(${ID})(?::([0-9]{1,3}))?$`),
  );
  if (op?.[1] && op[2]) return { p_op: op[1], p_batch_id: op[2], p_page: Number(op[3] ?? 0) };
  return null;
}
const compact = (s: string, n: number) => s.replace(/\s+/g, " ").slice(0, n);
const stateLabel: Record<string, string> = {
  selecting: "выбор",
  preview: "подтверждение",
  applied: "применено",
  undo_preview: "отмена изменений",
  undone: "изменения отменены",
  canceled: "отменено",
};
export function assortmentView(r: AssortmentResult): { text: string; rows: BtnRows } {
  if (r.home) {
    return {
      text: [
        "📋 Ассортимент",
        "🧭 Сначала решаем, что продавать.\nПубликация на сайте — отдельное действие.",
        "1️⃣ Выберите группу\n2️⃣ Отметьте товары\n3️⃣ Проверьте и подтвердите действие",
        "🔎 Поиск по названию, артикулу, бренду или разделу:\n/assort маска",
        "Новый список отменяет ваш предыдущий неподтверждённый выбор.",
        "🛡 Заказы сохраняются. Безвозвратного удаления здесь нет.",
      ].join("\n\n"),
      rows: [
        ...Object.entries(DECISION).map(([key, label]) => [
          { text: `${label}: ${r.counts[key] ?? 0}`, callback_data: `as:start:${key}` },
        ]),
        [{ text: "Все товары", callback_data: "as:start:all" }],
        ...(r.recent ?? []).map((b) => [
          {
            text: `${stateLabel[b.state] ?? b.state} · ${b.action ? ACTION[b.action] : "Выбор товаров"} · ${b.id.slice(0, 8)}`,
            callback_data: `as:get:${b.id}`,
          },
        ]),
        [{ text: "Главное меню", callback_data: "menu" }],
      ],
    };
  }
  const selecting = r.state === "selecting";
  const text = [
    `📋 Ассортимент · ${r.id.slice(0, 8)} · ${stateLabel[r.state] ?? r.state}`,
    `Группа: ${r.filter === "all" ? "Все товары" : DECISION[r.filter]}${r.query ? " · Поиск: " + compact(r.query, 120) : ""}`,
    `\n📦 В списке: ${r.total}\n☑️ Выбрано: ${r.selected}\n`,
    selecting
      ? "Нажмите на товары для выбора. «Выбрать все» охватывает весь этот список, включая другие страницы."
      : "Ниже только выбранные товары. Состав зафиксирован; новые совпадения сюда не добавляются.",
    ...(r.action
      ? [
          `${r.state === "undone" ? "Отменённое действие" : r.state === "undo_preview" ? "Отменяемое действие" : "Действие"}: ${ACTION[r.action]}.`,
          ...(["selecting", "preview", "applied"].includes(r.state) ? [EFFECT[r.action]] : []),
        ]
      : []),
    ...(r.selected
      ? [
          `До изменения: на сайте ${r.counts["published"]}, скрыто ${r.counts["hidden"]}, черновиков ${r.counts["draft"]}.`,
        ]
      : []),
    "",
    ...r.items.map(
      (i) =>
        `${i.selected ? "☑" : "☐"} ${compact(i.title, 85)}${i.sku ? " · " + compact(i.sku, 35) : ""}\n${DECISION[i.before_decision]} · ${STATUS[i.before_status]}${i.category ? " · " + compact(i.category, 35) : ""}`,
    ),
    "",
    `Страница ${r.page + 1} из ${r.pages}.`,
    ...(r.state === "preview"
      ? [
          "Подтверждение действует 30 минут. Если карточки изменились, вся операция будет остановлена.",
        ]
      : []),
    ...(r.state === "applied"
      ? ["Изменения сохранены. Отмена доступна 7 дней, если товары после этого не менялись."]
      : []),
    ...(r.state === "undo_preview"
      ? [
          "Отмена вернёт прежние решения и видимость, включая показ на сайте. При изменённых или неготовых карточках отмена остановится целиком. Подтверждение — 30 минут.",
        ]
      : []),
    ...(r.state === "undone" ? ["Прежние решения и видимость восстановлены."] : []),
    ...(r.state === "canceled" ? ["Этот выбор закрыт. Товары этим выбором не изменены."] : []),
  ].join("\n");
  const rows: BtnRows = [];
  if (selecting) {
    rows.push(
      ...r.items.map((i) => [
        {
          text: `${i.selected ? "☑ Убрать" : "☐ Выбрать"}: ${compact(i.title, 45)}`,
          callback_data: `as:${i.selected ? "unselect" : "select"}:${r.id}:${i.position}:${r.page}`,
        },
      ]),
    );
    rows.push([
      { text: `Выбрать все ${r.total}`, callback_data: `as:all:${r.id}:${r.page}` },
      { text: "Снять выбор", callback_data: `as:none:${r.id}:${r.page}` },
    ]);
    if (r.selected)
      rows.push(
        ...Object.entries(ACTION).map(([action, label]) => [
          {
            text: label,
            callback_data: `as:preview:${r.id}:${action}:${r.revision}`,
          },
        ]),
      );
  }
  if (r.pages > 1)
    rows.push([
      ...(r.page > 0 ? [{ text: "←", callback_data: `as:get:${r.id}:${r.page - 1}` }] : []),
      ...(r.page + 1 < r.pages
        ? [{ text: "→", callback_data: `as:get:${r.id}:${r.page + 1}` }]
        : []),
    ]);
  if (r.state === "preview")
    rows.push([
      { text: `✅ Подтвердить для ${r.selected} товаров`, callback_data: `as:apply:${r.id}` },
    ]);
  if (r.state === "applied")
    rows.push([{ text: "↩️ Отменить эти изменения…", callback_data: `as:undo_preview:${r.id}` }]);
  if (r.state === "undo_preview") {
    rows.push([
      { text: `Подтвердить отмену для ${r.selected} товаров`, callback_data: `as:undo:${r.id}` },
    ]);
  }
  if (selecting || r.state === "preview")
    rows.push([{ text: "Отменить выбор", callback_data: `as:cancel:${r.id}` }]);
  rows.push([{ text: "К ассортименту", callback_data: "as:home" }]);
  return { text, rows };
}

const ERRORS: Record<string, string> = {
  ASSORT_DENIED: "Нет права управлять ассортиментом.",
  ASSORT_NOT_FOUND: "Выбор не найден или принадлежит другому сотруднику.",
  ASSORT_BAD_INPUT: "Не удалось распознать действие. Откройте ассортимент заново.",
  ASSORT_TOO_MANY:
    "Больше 5000 совпадений. Уточните поиск по бренду, разделу или названию: /assort запрос",
  ASSORT_CLOSED: "Этот выбор уже закрыт или подтверждён. Откройте его через «Ассортимент».",
  ASSORT_EXPIRED: "Срок действия истёк. Начните новый выбор.",
  ASSORT_EMPTY: "Сначала выберите хотя бы один товар.",
  ASSORT_STALE: "Выбор изменился. Откройте его заново и проверьте состав перед подтверждением.",
  ASSORT_CONFLICT:
    "Один или несколько товаров уже изменились. Операция остановлена целиком. Начните новый выбор; чужие правки не перезаписываются.",
  ASSORT_NOT_READY:
    "Отмена вернула бы на сайт неготовые карточки. Ничего не изменено. Восстановите фото и данные либо разберите товары отдельно.",
};
export function assortmentError(message?: string): string {
  return (
    ERRORS[message ?? ""] ??
    "Результат операции не подтверждён. Откройте «Ассортимент» и последний выбор, чтобы проверить состояние. Не создавайте повторную операцию вслепую."
  );
}
