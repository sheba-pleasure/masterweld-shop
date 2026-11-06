import { chromium } from "/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

// Actual DEV reads first; intercepted failure/null responses are marked separately.
// No catalog writes, checkout submissions or Telegram messages.
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
const rpc = origin + "/backend/rest/v1/rpc/public_product_technical";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
const errors = [];
const failed = [];
const report = { actualDev: results, simulatedStates: [], jsErrors: errors, failedRequests: failed, telegramClient: false, ordersCreated: 0, productionTouched: false };
try {
  for (const width of [390, 1440, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => { if (response.status() >= 400) failed.push(response.status() + " " + new URL(response.url()).pathname); });
    page.on("requestfailed", (request) => failed.push(new URL(request.url()).pathname));
    await page.goto(origin + "/product/dev-welder", { waitUntil: "networkidle" });
    await page.getByText("160 А", { exact: true }).waitFor();
    assert.equal(await page.getByText("200 А", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Ток: 200 А", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Температура: 40 °C", { exact: true }).count(), 1);
    assert.equal(await page.getByText("6,5 кВА", { exact: true }).count(), 1);
    assert.equal(await page.getByText("5,2 кВА", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Не указано", { exact: true }).count(), 1);
    assert.equal(await page.getByText(/Учебные данные — не паспорт товара/).isVisible(), true);
    await page.evaluate(() => document.fonts.ready);
    const source = page.getByText("Источники характеристик (1)", { exact: true });
    await source.focus();
    await page.keyboard.press("Enter");
    await page.getByText("Учебный источник. Реального паспорта здесь нет.", { exact: true }).waitFor();
    assert.equal(await source.evaluate((e) => e.parentElement.open), true);
    assert.equal(await page.getByRole("link", { name: /Открыть источник/ }).count(), 0);
    await page.screenshot({ path: `/artifacts/technical-${width}.png`, fullPage: true, animations: "disabled" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
    await page.getByRole("button", { name: "Обновить характеристики", exact: true }).click();
    await page.getByText("160 А", { exact: true }).waitFor();
    await page.getByRole("button", { name: "В корзину", exact: true }).click();
    await page.getByRole("button", { name: /Корзина: 1 шт/ }).click();
    await page.getByLabel("Имя покупателя", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.goto(origin + "/product/dev-mask", { waitUntil: "networkidle" });
    await page.getByText(/Проверенные характеристики пока не добавлены/).waitFor();
    assert.equal(await page.getByText("160 А", { exact: true }).count(), 0);
    if (width === 390) await page.screenshot({ path: "/artifacts/technical-empty.png", fullPage: true });
    results.push({ width, modeValues: true, measurementConditions: true, sourceKeyboard: true, refresh: true, emptyProduct: true, cart: true });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/product/dev-welder", { waitUntil: "networkidle" });
  await page.getByText("160 А", { exact: true }).waitFor();
  await page.route(rpc, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"QA_UNAVAILABLE"}' }));
  await page.getByRole("button", { name: "Обновить характеристики", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Не удалось загрузить характеристики" }).waitFor();
  assert.equal(await page.getByText("160 А", { exact: true }).count(), 0);
  assert.equal(await page.getByText(/QA_UNAVAILABLE/).count(), 0);
  await page.screenshot({ path: "/artifacts/technical-error.png", fullPage: true });
  await page.unroute(rpc);
  await page.getByRole("button", { name: "Обновить характеристики", exact: true }).click();
  await page.getByText("160 А", { exact: true }).waitFor();
  report.simulatedStates.push("503 hides stale values; explicit refresh recovers using actual DEV API");
  await page.route(rpc, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
  await page.getByRole("button", { name: "Обновить характеристики", exact: true }).click();
  await page.getByText(/Проверенные характеристики пока не добавлены/).waitFor();
  assert.equal(await page.getByText("160 А", { exact: true }).count(), 0);
  report.simulatedStates.push("null refresh removes previously verified snapshot");
  await context.close();

  const mini = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await mini.addInitScript(() => {
    window.Telegram = { WebApp: {
      ready() {}, expand() {}, safeAreaInset: { top: 24, bottom: 16 }, contentSafeAreaInset: { top: 20, bottom: 8 },
      onEvent() {}, offEvent() {}, BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
    }};
  });
  const miniPage = await mini.newPage();
  miniPage.on("pageerror", (error) => errors.push(error.message));
  await miniPage.goto(origin + "/product/dev-welder?miniapp=1", { waitUntil: "networkidle" });
  await miniPage.getByText("160 А", { exact: true }).waitFor();
  assert.equal(await miniPage.locator("html").evaluate((e) => e.classList.contains("mw-miniapp")), true);
  assert.equal(await miniPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await miniPage.getByRole("region", { name: "Характеристики", exact: true }).screenshot({ path: "/artifacts/technical-miniapp-emulated.png" });
  report.simulatedStates.push("Telegram SDK/safe areas emulated; same actual DEV characteristics API");
  await mini.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(failed, []);
  writeFileSync("/artifacts/technical-check.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
