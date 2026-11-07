import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import {
  parseProductModelCallback,
  renderProductModelLinks,
  type ProductModelLinks,
} from "./model-links-view";
export async function showProductModelLinks(
  m: StaffMember,
  chat: { id: number; type?: string },
  data: string,
) {
  if (
    !isPrivateChat(chat, { id: m.telegram_id }) ||
    !can(m, "import_prices") ||
    !can(m, "view_costs")
  )
    return;
  const action = parseProductModelCallback(data);
  if (!action) return;
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: ProductModelLinks | null; error: unknown }>;
  try {
    const result = await rpc("bot_product_document_models", {
      p_actor: m.telegram_id,
      p_product: action.id,
      p_page: action.page,
    });
    if (result.error || !result.data?.ok) throw new Error("MODEL_LINK_READ");
    const view = renderProductModelLinks(result.data),
      chars = Array.from(view.text);
    for (let i = 0; i < chars.length; i += 3500)
      await tg("sendMessage", {
        chat_id: chat.id,
        text: chars.slice(i, i + 3500).join(""),
        ...(i + 3500 >= chars.length ? { reply_markup: { inline_keyboard: view.rows } } : {}),
      });
  } catch {
    await tg("sendMessage", {
      chat_id: chat.id,
      text: "Не удалось прочитать источники товара. Это не означает, что их нет. Повторите просмотр; сохранённые решения не меняются.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Прочитать источники ещё раз", callback_data: data }],
          [{ text: "↩️ К карточке товара", callback_data: `prd:${action.id}` }],
        ],
      },
    });
  }
}
