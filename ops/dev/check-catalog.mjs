import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

// Read-only navigation/cart inspection; never submits an order or writes catalog data.
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const errors = [];
const results = [];
try {
  for (const width of [390, 1440, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/?cat=dev-consumables&q=ТЕСТ&min=800&max=3000&sort=price-desc", {
      waitUntil: "networkidle",
    });
    await page.getByRole("heading", { name: "Учебные расходники", exact: true }).waitFor();
    assert.equal(await page.locator('#catalog a[href^="/product/"]').count(), 2);
    if (width < 768) {
      assert.equal(await page.getByLabel("Раздел каталога", { exact: true }).isVisible(), true);
      await page.getByLabel("Раздел каталога", { exact: true }).selectOption("dev-equipment");
      await page.getByText("По вашему запросу ничего не нашлось.", { exact: true }).waitFor();
      await page.getByLabel("Раздел каталога", { exact: true }).selectOption("dev-consumables");
    }
    await page.locator('#catalog a[href^="/product/dev-mask"]').click();
    await page.getByRole("heading", { name: "ТЕСТ — сварочная маска", exact: true }).waitFor();
    // Reload verifies that return state survives a direct URL, not just React memory.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("link", { name: "← К выбранным товарам", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/" && url.hash === "#catalog");
    const url = new URL(page.url());
    for (const [key, value] of Object.entries({
      cat: "dev-consumables",
      q: "ТЕСТ",
      min: "800",
      max: "3000",
      sort: "price-desc",
    })) {
      const raw = url.searchParams.get(key);
      assert.equal(raw?.startsWith('"') ? JSON.parse(raw) : raw, value);
    }
    await page.getByRole("heading", { name: "Учебные расходники", exact: true }).waitFor();
    await page.locator('#catalog a[href^="/product/dev-mask"]').waitFor();
    assert.equal(await page.locator('#catalog a[href^="/product/"]').count(), 2);
    if (width < 768) {
      const toggle = page.getByRole("button", { name: "Фильтры и сортировка", exact: true });
      assert.equal(await page.getByLabel("Минимальная цена, рублей").isVisible(), false);
      await toggle.click();
      assert.equal(await page.getByLabel("Минимальная цена, рублей").isVisible(), true);
      assert.equal(await page.getByLabel("Минимальная цена, рублей").inputValue(), "800");
      await toggle.click();
    }
    await page.locator("#catalog").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/artifacts/catalog-${width}.png`, animations: "disabled" });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "no horizontal overflow",
    );
    await page.getByRole("button", { name: "Убрать фильтр «Цена от: 800 ₽»", exact: true }).click();
    await page.waitForURL((url) => !url.searchParams.has("min"));
    assert.equal(await page.getByLabel("Максимальная цена, рублей").inputValue(), "3000");
    await page.getByRole("button", { name: "В корзину", exact: true }).first().click();
    await page.getByRole("button", { name: /Корзина: 1 шт/ }).click();
    await page.getByLabel("Имя покупателя", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.goto(origin + "/?cat=missing-section", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Раздел не найден", exact: true }).waitFor();
    assert.equal(await page.locator('#catalog a[href^="/product/"]').count(), 0);
    await page.getByRole("link", { name: "Открыть весь каталог", exact: true }).click();
    await page.getByRole("heading", { name: "Каталог товаров", exact: true }).waitFor();
    assert.equal(await page.locator('#catalog a[href^="/product/"]').count(), 3);
    results.push({
      width,
      filters: true,
      returnAfterReload: true,
      unknownCategory: true,
      cart: true,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  const result = { results, jsErrors: errors, productionTouched: false, ordersCreated: 0 };
  writeFileSync("/artifacts/catalog-check.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
