import { describe, expect, it } from "vitest";
import { persistentKeyboard } from "./navigation";
import { DEV_SHOP_ORIGIN, PRO_SHOP_ORIGIN, staffShopMessage } from "./shop-environments";

describe("staff Mini App entry points", () => {
  it("production has two direct web_app buttons with distinct HTTPS origins in both menus", () => {
    const keyboard = persistentKeyboard("production");
    expect(keyboard.is_persistent).toBe(true);
    const inline = staffShopMessage("production").reply_markup.inline_keyboard.flat();
    for (const buttons of [keyboard.keyboard.flat(), inline]) {
      const urls = buttons.flatMap((button) => {
        if (!("web_app" in button)) return [];
        const app = button.web_app;
        expect(app).toEqual({ url: expect.any(String) });
        if (typeof app !== "object" || app === null || !("url" in app))
          throw new Error("Invalid web_app button");
        return [app.url];
      });
      expect(urls).toEqual([DEV_SHOP_ORIGIN + "/?miniapp=1", PRO_SHOP_ORIGIN + "/?miniapp=1"]);
    }
  });
  it.each(["dev", undefined, "preview"])(
    "unreleased environment %s never offers a dead PRO URL",
    (env) => {
      for (const markup of [persistentKeyboard(env), staffShopMessage(env)])
        expect(JSON.stringify(markup)).not.toContain(PRO_SHOP_ORIGIN);
      expect(staffShopMessage(env).text).toContain("Рабочий магазин пока не открывается");
    },
  );
});
