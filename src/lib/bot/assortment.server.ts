import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "./permissions";
import { tg, TelegramDeliveryError } from "./telegram.server";
import {
  assortmentError,
  assortmentView,
  type AssortmentRequest,
  type AssortmentResult,
} from "./assortment";
import { isPrivateChat } from "./catalog";

export async function showAssortment(
  m: StaffMember,
  chat: { id: number; type?: string },
  request: AssortmentRequest | null,
  messageId?: number,
) {
  if (!isPrivateChat(chat, { id: m.telegram_id }) || !can(m, "manage_assortment"))
    return tg("sendMessage", { chat_id: chat.id, text: "Нет права управлять ассортиментом." });
  const recovery = {
    inline_keyboard: [
      ...(request?.p_batch_id
        ? [
            [
              {
                text: "📋 Проверить сохранённый результат",
                callback_data: `as:get:${request.p_batch_id}:${request.p_page ?? 0}`,
              },
            ],
          ]
        : []),
      [{ text: "↩️ К ассортименту", callback_data: "as:home" }],
      [{ text: "Главное меню", callback_data: "home" }],
    ],
  };
  if (!request)
    return tg("sendMessage", {
      chat_id: chat.id,
      text: assortmentError("ASSORT_BAD_INPUT"),
      reply_markup: recovery,
    });
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: AssortmentResult | null; error: { message: string } | null }>;
  let result: Awaited<ReturnType<typeof rpc>>;
  try {
    result = await rpc("bot_assortment", { ...request, p_staff_telegram_id: m.telegram_id });
  } catch {
    return tg("sendMessage", { chat_id: chat.id, text: assortmentError(), reply_markup: recovery });
  }
  const { data, error } = result;
  if (error || !data || data.ok !== true)
    return tg("sendMessage", {
      chat_id: chat.id,
      text: assortmentError(error?.message),
      reply_markup: recovery,
    });
  const view = assortmentView(data);
  const body = { chat_id: chat.id, text: view.text, reply_markup: { inline_keyboard: view.rows } };
  if (Number.isSafeInteger(messageId) && messageId! > 0) {
    try {
      return await tg("editMessageText", { ...body, message_id: messageId });
    } catch (err) {
      // Old/uneditable/unchanged Telegram message: deliver the already computed result.
      // Never repeat the database operation when message delivery fails.
      if (
        !(err instanceof TelegramDeliveryError) ||
        err.temporary ||
        !["api", "http"].includes(err.kind)
      )
        throw err;
    }
  }
  return tg("sendMessage", body);
}
