import type { TgUpdate } from "./handler.server";
import { customerMessage } from "./customer";
import { tg } from "./telegram.server";

/** Public shop only. Never dispatch customer messages to the staff handler. */
export async function handleCustomerUpdate(update: TgUpdate) {
  if (update.callback_query) {
    return tg(
      "answerCallbackQuery",
      {
        callback_query_id: update.callback_query.id,
        text: "Откройте магазин кнопкой внизу чата.",
      },
      "customer",
    );
  }
  const message = update.message;
  const actor = message?.from;
  const chat = message?.chat;
  if (
    !actor ||
    !chat ||
    chat.type !== "private" ||
    actor.id !== chat.id ||
    !Number.isSafeInteger(actor.id) ||
    actor.id <= 0
  )
    return;
  return tg(
    "sendMessage",
    {
      chat_id: chat.id,
      ...customerMessage(message.text ?? "", process.env["PUBLIC_ORIGIN"]),
    },
    "customer",
  );
}
