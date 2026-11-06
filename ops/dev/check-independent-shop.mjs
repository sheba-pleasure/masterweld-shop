// Separate Chromium against DEV only. No Browser Skill or customer sessions.
import { chromium } from "/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const hosts = new Set();
    const errors = [];
    page.on("request", (request) => hosts.add(new URL(request.url()).hostname));
    page.on("pageerror", (error) => errors.push(error.message));
    // Exercise a long gallery without mutating any database.
    await page.route("**/backend/rest/v1/products?**", async (route) => {
      if (!new URL(route.request().url()).searchParams.has("slug")) return route.continue();
      const response = await route.fetch();
      const product = await response.json();
      const record = Array.isArray(product) ? product[0] : product;
      assert.ok(record?.id);
      const original = record.product_photos?.[0] ?? { url: origin + "/favicon-32x32.png" };
      record.product_photos = Array.from({ length: 12 }, (_, i) => ({
        ...original,
        url: original.url + "?qa=" + i,
        sort_order: i,
        is_main: i === 0,
      }));
      await route.fulfill({ response, json: product });
    });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('a[href^="/product/"]').first().click();
    await page.locator("main > nav").waitFor();
    assert.equal(await page.getByRole("button", { name: /^Фото [0-9]+ товара/ }).count(), 12);
    await page.getByRole("button", { name: "В корзину", exact: true }).click();
    await page.getByRole("button", { name: "Перейти в корзину", exact: true }).waitFor();
    await page.screenshot({
      path: `/artifacts/mw-independent-product-${width}.png`,
      animations: "disabled",
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.getByRole("button", { name: "Перейти в корзину", exact: true }).click();
    await page.getByLabel("Имя покупателя", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Оформить учебный заказ", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "Оплатить онлайн", exact: true }).count(),
      0,
    );
    assert.equal(await page.getByRole("button", { name: "Войти", exact: true }).count(), 0);
    await page.getByLabel("Имя покупателя", { exact: true }).fill("Учебная проверка");
    await page.getByLabel("Телефон покупателя", { exact: true }).fill("+79990000001");
    const submit = page.getByRole("button", { name: "Оформить учебный заказ", exact: true });
    assert.equal(await submit.isEnabled(), true);
    await submit.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/artifacts/mw-independent-cart-${width}.png`,
      animations: "disabled",
    });
    const box = await submit.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width);
    await page.getByRole("button", { name: /Удалить из корзины:/ }).click();
    await page.getByRole("link", { name: "Открыть каталог", exact: true }).waitFor();
    await page.screenshot({
      path: `/artifacts/mw-independent-empty-${width}.png`,
      animations: "disabled",
    });
    await page.getByRole("link", { name: "Открыть каталог", exact: true }).click();
    await page.goto(origin + "/qa-page-does-not-exist", { waitUntil: "networkidle" });
    assert.ok((await page.locator("body").innerText()).includes("Страница не найдена"));
    await page.screenshot({
      path: `/artifacts/mw-independent-404-${width}.png`,
      animations: "disabled",
    });
    assert.deepEqual(errors, []);
    assert.deepEqual([...hosts], [new URL(origin).hostname]);
    console.log(JSON.stringify({ width, errors, hosts: [...hosts], result: "passed" }));
    await context.close();
  }
} finally {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) await page.unrouteAll({ behavior: "ignoreErrors" });
  }
  await browser.close();
}
