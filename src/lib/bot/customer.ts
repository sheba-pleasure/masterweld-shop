import { CONTACTS } from "@/lib/contacts";

export function shopUrl(origin: string | undefined) {
  if (!origin || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(origin))
    throw new Error("SHOP_ORIGIN_INVALID");
  return origin + "/?miniapp=1";
}

export function customerMessage(text: string, origin: string | undefined) {
  const url = shopUrl(origin);
  const command = text.trim().split(/\s/)[0]?.split("@")[0];
  const body =
    command === "/contacts" || ["Контакты", "📍 Контакты"].includes(text)
      ? `📍 Мастер Сварщик · Контакты\n\n📞 ${CONTACTS.phoneDisplay}\n✉️ ${CONTACTS.email}\n\n🛍 Каталог и заказ — по кнопке «Открыть магазин» внизу.`
      : command === "/help" || ["Помощь", "💬 Помощь"].includes(text)
        ? "💬 Как сделать заказ\n\n🔎 Откройте магазин и выберите товары.\n🛒 Добавьте их в корзину.\n📋 Укажите имя и телефон, проверьте сумму.\n\n💰 Цену и наличие проверим перед подтверждением.\n\n⚠️ Если отправка прервалась, откройте корзину и проверьте результат прежней попытки."
        : "🛍 Мастер Сварщик\nМагазин внутри Telegram\n\n🔎 Найдите нужный товар\n🛒 Соберите корзину\n📋 Оформите заказ\n\n🔄 Товары, цены и наличие общие с сайтом.\n\n👇 Нажмите «Открыть магазин».";
  return {
    text: body,
    reply_markup: {
      keyboard: [
        [{ text: "🛍 Открыть магазин", web_app: { url } }],
        [{ text: "📍 Контакты" }, { text: "💬 Помощь" }],
      ],
      is_persistent: true,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: "Откройте магазин или выберите раздел",
    },
  };
}
