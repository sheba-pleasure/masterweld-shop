import navigation from "./navigation.json";
import { DEV_SHOP_LABEL, PRO_SHOP_LABEL, staffShopButtons } from "./shop-environments";

export function navigationCommand(text: string): string | undefined {
  if ([DEV_SHOP_LABEL, PRO_SHOP_LABEL].includes(text.trim())) return "/shops";
  const item = navigation.find((item) => item.button === text.trim());
  return item ? "/" + item.command : undefined;
}

export function persistentKeyboard(env?: string) {
  const { dev, pro } = staffShopButtons(env);
  const buttons = navigation.map(({ button }) => ({ text: button }));
  return {
    keyboard: [
      [dev],
      ["web_app" in pro ? pro : { text: pro.text }],
      buttons.slice(0, 2),
      buttons.slice(2, 4),
      buttons.slice(4),
    ],
    is_persistent: true,
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: "Выберите раздел или введите сообщение",
  };
}
