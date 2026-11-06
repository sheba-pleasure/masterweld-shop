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
    command === "/contacts" || text === "Контакты"
      ? `Магазин «Мастер Сварщик»\nТелефон: ${CONTACTS.phoneDisplay}\nПочта: ${CONTACTS.email}`
      : command === "/help" || text === "Помощь"
        ? "Нажмите «Открыть магазин». Выберите товары, добавьте в корзину и оформите заказ. Цену и наличие проверим перед подтверждением. Если отправка прервалась, откройте корзину и проверьте результат прежней попытки."
        : "Магазин «Мастер Сварщик»\nКаталог, поиск, корзина и оформление заказа — внутри Telegram. Товары, цены и наличие общие с сайтом.";
  return {
    text: body,
    reply_markup: {
      keyboard: [
        [{ text: "Открыть магазин", web_app: { url } }],
        [{ text: "Контакты" }, { text: "Помощь" }],
      ],
      is_persistent: true,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: "Откройте магазин или выберите раздел",
    },
  };
}
