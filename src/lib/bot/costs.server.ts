import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "./permissions";
import { isPrivateChat } from "./catalog";
import { tg } from "./telegram.server";
import { orderDateMoscow } from "./orders";

const money = (value: number) =>
  value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₽";

/** Separate private response: costs never enter public product objects or the storefront. */
export async function showProductCosts(
  member: StaffMember,
  chat: { id: number; type?: string },
  productId: string,
) {
  if (!isPrivateChat(chat, { id: member.telegram_id }) || !can(member, "view_costs"))
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "Просмотр закупочных цен доступен только действующим сотрудникам в личном чате.",
    });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(productId)) return;
  const reply_markup = {
    inline_keyboard: [
      [{ text: "⬅️ К товару", callback_data: "prd:" + productId }],
      [{ text: "🏠 Главное меню", callback_data: "home" }],
    ],
  };
  let text: string;
  try {
    const product = await supabaseAdmin
      .from("products")
      .select("id,title,sku,price")
      .eq("id", productId)
      .maybeSingle();
    if (product.error) throw new Error("READ_FAILED");
    if (!product.data) {
      return tg("sendMessage", {
        chat_id: chat.id,
        text: "Товар больше не найден. Откройте каталог и выберите другой товар.",
        reply_markup: {
          inline_keyboard: [[{ text: "🗂 Открыть каталог", callback_data: "cat:0" }]],
        },
      });
    }
    const costs = await supabaseAdmin
      .from("product_costs")
      .select("cost_price,updated_at")
      .eq("product_id", productId)
      .maybeSingle();
    if (costs.error) throw new Error("READ_FAILED");
    const cost = costs.data?.cost_price == null ? null : Number(costs.data.cost_price);
    const retail = product.data.price === null ? null : Number(product.data.price);
    if (
      (retail !== null && !Number.isFinite(retail)) ||
      (cost !== null && (!Number.isFinite(cost) || cost < 0))
    )
      throw new Error("INVALID_PRICE");
    // Record the disclosure without copying financial values into audit details.
    const audit = await supabaseAdmin.from("staff_audit_log").insert({
      telegram_id: member.telegram_id,
      action: "product_cost_read",
      details: { product_id: productId },
    });
    if (audit.error) throw new Error("AUDIT_FAILED");
    text = [
      "💰 Цены товара",
      product.data.title + "\nАртикул: " + (product.data.sku ?? "не указан"),
      retail === null
        ? "🛒 Розничная цена: по запросу. Согласованной цены магазина ещё нет."
        : "🛒 Розничная цена: " +
          money(retail) +
          "\nПо этой цене товар предлагается покупателю на сайте.",
      cost === null
        ? "📦 Закупочная цена: пока не указана.\nУточните её у администратора. Это не означает, что товар закуплен за 0 ₽."
        : "📦 Закупочная цена: " +
          money(cost) +
          "\nЭто сохранённая цена закупки для магазина.\nОбновлена: " +
          orderDateMoscow(costs.data!.updated_at),
      "🔎 Только просмотр — цены не изменены.\nПокупатели закупочную цену не видят. Если данные неверны, передайте администратору артикул.",
    ].join("\n\n");
  } catch {
    text =
      "⚠️ Не удалось проверить цены.\nЗакупочная цена не показана: это не означает, что она отсутствует. Откройте товар и попробуйте позже.";
  }
  return tg("sendMessage", { chat_id: chat.id, text, reply_markup });
}
