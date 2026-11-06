export interface DeliveryRow {
  order_id: string;
  staff_telegram_id: number;
  state: string;
  updated_at: string;
}
export function deliveryReport(rows: DeliveryRow[]) {
  const labels: Record<string, string> = {
    pending: "ожидает отправки",
    sending: "отправляется",
    sent: "доставлено",
    skipped: "пропущено: проверьте права или статус заказа",
    failed: "не доставлено: проверьте запуск бота сотрудником",
    uncertain: "результат неизвестен: сначала проверьте чат сотрудника",
  };
  return {
    text: rows.length
      ? "Уведомления — последние 10 записей:\n" +
        rows
          .map(
            (r) =>
              "#" +
              r.order_id.slice(0, 8) +
              " · сотрудник " +
              r.staff_telegram_id +
              " · " +
              (labels[r.state] ?? "нужна проверка"),
          )
          .join("\n") +
        "\n\nЗаказы доступны через «Заказы». При неизвестном результате проверьте чат вручную. Повторная отправка здесь не выполняется."
      : "Очередь уведомлений пуста. Заказы проверяйте через «Заказы».",
    rows: [...new Set(rows.map((r) => r.order_id))].map((id) => [
      { text: "📄 Заказ #" + id.slice(0, 8), callback_data: "order:" + id },
    ]),
  };
}
