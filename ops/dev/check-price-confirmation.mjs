import { chromium } from "/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  assert.match(await page.locator("body").innerText(), /Тестовый магазин/);
  await page.getByRole("button", { name: "В корзину", exact: true }).first().click();
  const actual = await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem("mw_cart_v1"));
    const price = rows[0].price;
    rows[0].price = price - 100; // Simulate a stale cart; the catalog is never modified.
    localStorage.setItem("mw_cart_v1", JSON.stringify(rows));
    return price;
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Корзина: 1 шт/ }).click();
  await page.getByLabel("Имя покупателя", { exact: true }).fill("DEV QA E2E-20261106-PRICE-FINAL");
  await page.getByLabel("Телефон покупателя", { exact: true }).fill("+79990000002");
  await page.getByRole("button", { name: "Оформить учебный заказ", exact: true }).click();
  await page.getByText("Цены изменились — заказ пока не оформлен.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("mw.checkout-attempt.v1")), null);
  assert.match(await page.locator(".checkout-details").innerText(), /Итого\s+900/);
  await page.screenshot({
    path: "/artifacts/mw-price-confirmation-mobile.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Согласиться с новой ценой и оформить", exact: true })
    .click();
  await page.getByText(/Спасибо! Заказ .* принят/).waitFor();
  const confirmation = await page.getByText(/Спасибо! Заказ .* принят/).innerText();
  const result = { confirmation, actual, errors };
  writeFileSync("/artifacts/mw-price-confirmed.json", JSON.stringify(result) + "\n", {
    mode: 0o600,
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
