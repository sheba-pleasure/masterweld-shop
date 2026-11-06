import { shopUrl } from "./customer";

export const DEV_SHOP_ORIGIN = "https://masterweld-dev.138-124-106-211.sslip.io";
export const PRO_SHOP_ORIGIN = "https://shop.masterweld.ru";
export const DEV_SHOP_LABEL = "🧪 DEV · учебный магазин";
export const PRO_SHOP_LABEL = "🏪 PRO · рабочий магазин";

type ShopButton = { text: string; web_app: { url: string } };

/**
 * Links open public storefronts; they never change the bot's database or staff identity.
 * PRO is offered only by a verified production runtime. DEV must not imply it is live.
 */
export function staffShopButtons(env: string | undefined): {
  dev: ShopButton;
  pro: ShopButton | { text: string; callback_data: string };
} {
  return {
    dev: { text: DEV_SHOP_LABEL, web_app: { url: shopUrl(DEV_SHOP_ORIGIN) } },
    pro:
      env === "production"
        ? { text: PRO_SHOP_LABEL, web_app: { url: shopUrl(PRO_SHOP_ORIGIN) } }
        : { text: PRO_SHOP_LABEL, callback_data: "shop_pro_pending" },
  };
}

export function staffShopMessage(env: string | undefined) {
  const { dev, pro } = staffShopButtons(env);
  return {
    text: [
      "🛍 Магазин внутри Telegram",
      "",
      "🧪 DEV — учебные товары и заказы. Здесь можно пробовать.",
      env === "production"
        ? "🏪 PRO — рабочие товары и настоящие заказы."
        : "🏪 PRO — готовится к запуску. Рабочий магазин пока не открывается.",
      "",
      "Корзины и заказы этих магазинов раздельные.",
      env === "production"
        ? "Команды этого бота управляют только PRO. Открытие DEV этого не меняет."
        : "Команды этого бота управляют только DEV.",
      "Кнопки открывают витрину покупателя. Права управления сайтом они не выдают.",
      "",
      "👇 Выберите магазин:",
    ].join("\n"),
    reply_markup: { inline_keyboard: [[dev], [pro]] },
  };
}

export const PRO_SHOP_PENDING =
  "🏪 PRO · рабочий магазин\n\nРабочая версия ещё не запущена.\n🧪 Для проверки откройте DEV — все заказы там учебные.";
