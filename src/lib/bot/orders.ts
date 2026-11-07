// Чистая (тестируемая) логика работы с заказами в Telegram-боте.
// Никаких обращений к БД/Telegram — только преобразования данных.

export type OrderStatus = "new" | "processing" | "ready" | "completed" | "canceled";

export const ORDER_STATUSES: OrderStatus[] = [
  "new",
  "processing",
  "ready",
  "completed",
  "canceled",
];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: "новый",
  processing: "в обработке",
  ready: "готов",
  completed: "выдан",
  canceled: "отменён",
};

export const STATUS_ACTION: Record<OrderStatus, string> = {
  new: "Новый заказ",
  processing: "Начать обработку",
  ready: "Заказ собран — готов к выдаче",
  completed: "Подтвердить выдачу покупателю",
  canceled: "Отменить заказ",
};

const NEXT_STEP: Record<OrderStatus, string> = {
  new: "«Начать обработку» сразу отметит, что вы занялись заказом. Свяжитесь с покупателем и проверьте наличие.",
  processing:
    "Когда товары собраны, нажмите «Заказ собран — готов к выдаче». Статус сразу станет «готов». Сообщите покупателю о готовности самостоятельно.",
  ready:
    "После передачи товаров покупателю нажмите «Подтвердить выдачу покупателю». Бот попросит подтверждение, затем закроет заказ.",
  completed: "Заказ выдан. Данные сохранены в истории.",
  canceled: "Заказ отменён. Данные сохранены в истории.",
};

export const STATUS_ICON: Record<OrderStatus, string> = {
  new: "🆕",
  processing: "🛠",
  ready: "📦",
  completed: "✅",
  canceled: "🚫",
};

/** Переходы статусов: из текущего — в какие можно. */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ["processing", "canceled"],
  processing: ["ready", "canceled"],
  ready: ["completed", "canceled"],
  completed: [],
  canceled: [],
};

/** Статусы, смена в которые требует дополнительного подтверждения. */
export const CONFIRM_REQUIRED: OrderStatus[] = ["completed", "canceled"];

export interface OrderRow {
  id: string;
  name: string;
  phone: string;
  comment: string | null;
  items: unknown;
  total: number;
  created_at: string;
  status?: OrderStatus | null;
}

export interface OrderItemLite {
  title?: string;
  qty?: number;
  price?: number;
  backorder?: boolean;
}

export function parseOrderItems(items: unknown): OrderItemLite[] {
  if (!Array.isArray(items)) return [];
  return items.filter((i): i is OrderItemLite => typeof i === "object" && i !== null);
}

/** Показывать ли ПДн заказа в этом чате: только личный чат сотрудника с ботом. */
export function canViewOrderData(
  chat: { id: number; type?: string } | null | undefined,
  from: { id: number } | null | undefined,
): boolean {
  if (!chat || !from) return false;
  return chat.type === "private" && chat.id === from.id;
}

export const ORDERS_PAGE_SIZE = 5;

export function ordersPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
}

/** Текст списка заказов (стр. 0-базная) + клавиатура выбора. */
export function buildOrdersList(
  orders: OrderRow[],
  page: number,
): { text: string; rows: { text: string; callback_data: string }[][] } {
  const pages = ordersPageCount(orders.length);
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = orders.slice(p * ORDERS_PAGE_SIZE, (p + 1) * ORDERS_PAGE_SIZE);

  const lines = slice.map((o) => {
    const st = o.status ? STATUS_LABEL[o.status] : "?";
    const sum = Math.round(Number(o.total) || 0);
    return `${o.status ? STATUS_ICON[o.status] : "📋"} #${o.id.slice(0, 8)} · ${st}\n👤 ${o.name} · ${sum.toLocaleString("ru-RU")} ₽`;
  });

  const rows: { text: string; callback_data: string }[][] = slice.map((o) => [
    {
      text: `📄 Заказ #${o.id.slice(0, 8)} (${o.status ? STATUS_LABEL[o.status] : "?"})`,
      callback_data: `order:${o.id}`,
    },
  ]);
  const nav: { text: string; callback_data: string }[] = [];
  if (p > 0) nav.push({ text: "◀️ Назад", callback_data: `orders:${p - 1}` });
  nav.push({ text: `${p + 1}/${pages}`, callback_data: "orders:noop" });
  if (p < pages - 1) nav.push({ text: "Вперёд ▶️", callback_data: `orders:${p + 1}` });
  rows.push(nav);

  const text =
    orders.length === 0
      ? "📭 Заказов пока нет."
      : `📋 Заказы (${orders.length})\n\n${lines.join("\n\n")}\n\n👇 Выберите заказ, чтобы открыть состав и действия.`;
  return { text, rows };
}

/** Карточка заказа: состав, сумма, статус, кнопки смены статуса. */
export function orderDateMoscow(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "дата недоступна";
  return (
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date) + " МСК"
  );
}

export function buildOrderCard(
  order: OrderRow,
  staffName: string,
): { text: string; rows: { text: string; callback_data: string }[][] } {
  const items = parseOrderItems(order.items);
  const lines = items.map((i) => {
    const qty = Number(i.qty) || 0;
    const price = Number(i.price) || 0;
    const back = i.backorder ? " (под заказ)" : "";
    return `• ${i.title ?? "товар"} — ${qty} × ${price.toLocaleString("ru-RU")} ₽${back}`;
  });
  const status = order.status ?? null;
  const st = status ? STATUS_LABEL[status] : "статус не подключён";
  const text = [
    `📋 Заказ #${order.id.slice(0, 8)}\n${status ? STATUS_ICON[status] : "ℹ️"} Статус: ${st}\n🕒 ${orderDateMoscow(order.created_at)}`,
    `👤 Покупатель: ${order.name}\n📞 Телефон: ${order.phone}`,
    order.comment ? `💬 Комментарий: ${order.comment}` : null,
    `🛒 Состав:\n${lines.join("\n") || "—"}`,
    `💰 Итого: ${Math.round(Number(order.total) || 0).toLocaleString("ru-RU")} ₽`,
    status
      ? ALLOWED_TRANSITIONS[status].length
        ? "👇 " +
          NEXT_STEP[status] +
          "\n\n«Отменить заказ» попросит подтверждение. Отмена заказа не выполняет возврат денег."
        : "🏁 Заказ закрыт. Данные сохранены в истории."
      : "ℹ️ Статус пока не подключён. Доступен только просмотр.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const rows: { text: string; callback_data: string }[][] = [];
  if (status) {
    for (const next of ALLOWED_TRANSITIONS[status]) {
      const confirm = CONFIRM_REQUIRED.includes(next);
      rows.push([
        {
          text: `${STATUS_ICON[next]} ${STATUS_ACTION[next]}`,
          callback_data: confirm ? `stc:${order.id}:${next}` : `st:${order.id}:${next}`,
        },
      ]);
    }
  }
  rows.push([{ text: "⬅️ К списку заказов", callback_data: "orders:0" }]);
  rows.push([{ text: "🏠 Главное меню", callback_data: "home" }]);
  return { text, rows };
}

export type TransitionCheck =
  { ok: true; from: OrderStatus | null; to: OrderStatus } | { ok: false; message: string };

/**
 * Проверка допустимости смены статуса. Если статуса в схеме ещё нет (колонка
 * не применена), смена запрещена — graceful fallback на «только просмотр».
 */
export function checkTransition(
  order: OrderRow,
  next: OrderStatus,
  hasStatusColumn: boolean,
): TransitionCheck {
  if (!hasStatusColumn) {
    return { ok: false, message: "Смена статусов станет доступна после обновления базы." };
  }
  const from = order.status ?? null;
  if (!from) return { ok: false, message: "У заказа нет статуса." };
  if (from === next) return { ok: false, message: `Заказ уже «${STATUS_LABEL[next]}».` };
  if (!ALLOWED_TRANSITIONS[from].includes(next)) {
    return {
      ok: false,
      message: `Из «${STATUS_LABEL[from]}» нельзя перевести в «${STATUS_LABEL[next]}».`,
    };
  }
  return { ok: true, from, to: next };
}

/** Короткий человекочитаемый номер заказа. */
export function orderNumber(id: string): string {
  return `#${id.slice(0, 8)}`;
}
