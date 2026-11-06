// Standalone Chromium; Telegram SDK/chrome emulated, not a Telegram client test.
import { chromium } from "/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => {
  window.__telegramQA = { ready: false, back: null, backVisible: false };
  window.Telegram = {
    WebApp: {
      ready() {
        window.__telegramQA.ready = true;
      },
      expand() {},
      safeAreaInset: { top: 24, bottom: 16 },
      contentSafeAreaInset: { top: 20, bottom: 8 },
      onEvent() {},
      offEvent() {},
      BackButton: {
        show() {
          window.__telegramQA.backVisible = true;
        },
        hide() {
          window.__telegramQA.backVisible = false;
        },
        onClick(fn) {
          window.__telegramQA.back = fn;
        },
        offClick(fn) {
          if (window.__telegramQA.back === fn) window.__telegramQA.back = null;
        },
      },
    },
  };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => {
  if (r.status() >= 400) errors.push(r.status() + " " + r.url().split("?")[0]);
});
try {
  await page.goto(origin + "/?miniapp=1", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => window.__telegramQA.ready && document.documentElement.classList.contains("mw-miniapp"),
  );
  assert.match(await page.locator("body").innerText(), /Тестовый магазин/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const catalog = async (p) =>
    p
      .locator('a[href^="/product/"]')
      .evaluateAll((links) =>
        [...new Set(links.map((a) => a.getAttribute("href") + ":" + a.innerText))].sort(),
      );
  const miniCatalog = await catalog(page);
  assert.ok(miniCatalog.length > 0);
  await page.screenshot({ path: "/artifacts/telegram-shop-mobile.png", fullPage: true });
  const normalContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const normal = await normalContext.newPage();
  await normal.goto(origin, { waitUntil: "networkidle" });
  assert.deepEqual(await catalog(normal), miniCatalog, "one catalog for both entry points");
  assert.equal(
    await normal.locator("html").evaluate((e) => e.classList.contains("mw-miniapp")),
    false,
  );
  assert.equal(await normal.locator("script[data-mw-telegram]").count(), 0);
  await normal.screenshot({ path: "/artifacts/telegram-shop-desktop.png", fullPage: true });
  await normalContext.close();
  await page.getByPlaceholder("Модель, артикул или бренд…", { exact: true }).fill("DEV");
  await page.waitForTimeout(600);
  assert.ok((await catalog(page)).length > 0);
  await page.locator('a[href^="/product/dev-welder"]').first().click();
  await page.waitForFunction(() => window.__telegramQA.backVisible);
  await page.evaluate(() => window.__telegramQA.back());
  await page.waitForURL(origin + "/");
  await page.getByRole("button", { name: "В корзину", exact: true }).first().click();
  await page.getByRole("button", { name: /Корзина: 1 шт/ }).click();
  await page.getByLabel("Имя покупателя", { exact: true }).fill("DEV QA Telegram Mirror");
  await page.getByLabel("Телефон покупателя", { exact: true }).fill("+79990000009");
  await page
    .getByLabel("Комментарий к заказу", { exact: true })
    .fill("Учебная проверка зеркала Telegram. Не звонить.");
  await page.screenshot({ path: "/artifacts/telegram-shop-cart.png", animations: "disabled" });
  const dialog = await page.getByRole("dialog").boundingBox();
  assert.ok(
    dialog &&
      dialog.x >= 0 &&
      dialog.x + dialog.width <= 390 &&
      dialog.y >= 44 &&
      dialog.y + dialog.height <= 820,
    "Telegram chrome does not cover checkout",
  );
  if (process.env.MW_QA_CHECKOUT !== "false") {
    await page.getByRole("button", { name: /Оформить учебный заказ/, exact: true }).click();
    await page.getByText(/Спасибо! Заказ .* принят/).waitFor({ timeout: 15000 });
    const confirmation = await page.getByText(/Спасибо! Заказ .* принят/).innerText();
    await page.screenshot({ path: "/artifacts/telegram-shop-order.png" });
    assert.deepEqual(errors, []);
    const result = {
      confirmation,
      sameCatalog: true,
      mobileSafeAreas: true,
      backButton: true,
      jsErrors: errors,
      telegramClient: false,
    };
    writeFileSync("/artifacts/telegram-shop-flow.json", JSON.stringify(result));
    console.log(JSON.stringify(result));
  }
  // SDK unavailable: regular storefront and cart must remain usable.
  const fallback = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await fallback.route("https://telegram.org/js/telegram-web-app.js", (r) => r.abort());
  const plain = await fallback.newPage();
  await plain.goto(origin + "/?miniapp=1", { waitUntil: "networkidle" });
  await plain.getByRole("button", { name: "В корзину", exact: true }).first().click();
  await plain.getByRole("button", { name: /Корзина: 1 шт/ }).click();
  assert.equal(await plain.getByLabel("Имя покупателя", { exact: true }).isVisible(), true);
  console.log("SDK failure fallback passed");
  await fallback.close();
} finally {
  await browser.close();
}
