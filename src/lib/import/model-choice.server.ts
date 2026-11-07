import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import {
  parseModelChoiceCallback,
  renderModelChoice,
  type ProductModelChoice,
} from "./model-choice-view";

export async function showModelChoice(
  m: StaffMember,
  chat: { id: number; type?: string },
  data: string,
  requestId = "",
) {
  if (
    !isPrivateChat(chat, { id: m.telegram_id }) ||
    !can(m, "import_prices") ||
    !can(m, "view_costs")
  )
    return;
  const action = parseModelChoiceCallback(data);
  if (!action) return;
  const preparing = action.op === "prepare" || action.op === "prepare_clear";
  const request = preparing ? requestId : action.request;
  if (
    preparing &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)
  ) {
    await tg("sendMessage", {
      chat_id: chat.id,
      text: "Откройте источники товара заново. Не удалось связать выбор с этой кнопкой.",
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "home" }]],
      },
    });
    return;
  }
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: ProductModelChoice | null; error: unknown }>;
  try {
    const result = await rpc("bot_product_model_choice", {
      p_actor: m.telegram_id,
      p_op: action.op,
      p_product: action.product ?? null,
      p_batch: action.batch ?? null,
      p_line: action.line ?? null,
      p_request: request ?? null,
    });
    if (result.error || !result.data?.ok) throw new Error("MODEL_CHOICE_RESULT");
    const view = renderModelChoice(result.data),
      chars = Array.from(view.text);
    for (let i = 0; i < chars.length; i += 3500)
      await tg("sendMessage", {
        chat_id: chat.id,
        text: chars.slice(i, i + 3500).join(""),
        ...(i + 3500 >= chars.length ? { reply_markup: { inline_keyboard: view.rows } } : {}),
      });
  } catch {
    const recovery = request ? "pm:read:" + request : data;
    await tg("sendMessage", {
      chat_id: chat.id,
      text: "Не удалось получить результат выбора. Это не означает, что действие не сохранилось. Нажмите «Прочитать сохранённый результат». Повторное подтверждение автоматически не отправляется.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Прочитать сохранённый результат", callback_data: recovery }],
          ...(action.product
            ? [[{ text: "📎 К источникам товара", callback_data: "mp:" + action.product + ":0" }]]
            : []),
          [{ text: "🏠 Главное меню", callback_data: "home" }],
        ],
      },
    });
  }
}
