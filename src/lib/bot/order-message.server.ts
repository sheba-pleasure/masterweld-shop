import { tg, TelegramDeliveryError } from "./telegram.server";

type OrderView = {
  text: string;
  rows: { text: string; callback_data: string }[][];
};

/** Presentation only. A failed edit must never repeat a database operation. */
export async function showOrderMessage(chatId: number, view: OrderView, messageId?: number) {
  const body = {
    chat_id: chatId,
    text: view.text,
    reply_markup: { inline_keyboard: view.rows },
  };
  if (Number.isSafeInteger(messageId) && messageId! > 0) {
    try {
      await tg("editMessageText", { ...body, message_id: messageId });
      return;
    } catch (error) {
      if (error instanceof TelegramDeliveryError && error.messageUnchanged) return;
      // Only a definite rejection permits sending a replacement. A timeout/5xx
      // may already have edited the card, so do not produce an uncertain duplicate.
      if (
        !(error instanceof TelegramDeliveryError) ||
        error.temporary ||
        !["api", "http"].includes(error.kind) ||
        error.status !== 400
      )
        throw error;
    }
    body.text = "ℹ️ Предыдущую карточку обновить не удалось. Используйте эту.\n\n" + body.text;
  }
  await tg("sendMessage", body);
}
