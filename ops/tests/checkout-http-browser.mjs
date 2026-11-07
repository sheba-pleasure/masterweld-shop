// Run only inside the disposable checkout-http.py stack. No Browser Skill or real accounts.
const { chromium } = await import(
  process.env.MW_PLAYWRIGHT_MODULE ?? "/node_modules/playwright/index.mjs"
);
import fs from "node:fs";
import assert from "node:assert/strict";

const origin = "http://127.0.0.1:8080";
const directory = "/artifacts";
const key = "mw.checkout-attempt.v1";
const phase = process.env.MW_QA_PHASE;
assert.ok(["loss", "recovery"].includes(phase));
const errors = [],
  outside = [],
  screenshots = [];
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const file = directory + "/" + name + ".png";
  await page.screenshot({ path: file, animations: "disabled" });
  screenshots.push(file);
}
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    ...(phase === "recovery" ? { storageState: directory + "/browser-state.json" } : {}),
  });
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      outside.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const watch = (page) => page.on("pageerror", (error) => errors.push(error.message));
  if (phase === "loss") {
    const a = await context.newPage(),
      b = await context.newPage();
    watch(a);
    watch(b);
    await a.goto(origin, { waitUntil: "networkidle" });
    assert.match(await a.locator("body").innerText(), /Тестовый магазин/);
    await a.getByRole("button", { name: "В корзину", exact: true }).first().click();
    await b.goto(origin, { waitUntil: "networkidle" });
    for (const page of [a, b]) {
      await page.getByLabel("Корзина: 1 шт.", { exact: true }).click();
      await page.getByLabel("Имя покупателя", { exact: true }).fill("Учебный HTTP покупатель");
      await page.getByLabel("Телефон покупателя", { exact: true }).fill("+79990000001");
      await page
        .getByLabel("Комментарий к заказу", { exact: true })
        .fill("Учебная сквозная проверка. Не звонить.");
    }
    let arriving = 0,
      release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    for (const [page, lose] of [
      [a, true],
      [b, false],
    ]) {
      await page.route(origin + "/**", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        arriving++;
        if (arriving === 2) release();
        await barrier;
        const headers = await route.request().allHeaders();
        assert.equal(headers.origin, origin);
        const response = await route.fetch({
          headers: { ...headers, "sec-fetch-site": "same-origin" },
        });
        assert.equal(response.ok(), true, "Actual server accepted the HTTP request");
        if (lose) return route.abort("connectionfailed");
        return route.fulfill({ response });
      });
    }
    await Promise.all(
      [a, b].map((page) =>
        page.getByRole("button", { name: "Оформить учебный заказ", exact: true }).click(),
      ),
    );
    await a.getByText(/Заказ мог сохраниться/).waitFor();
    const receipt = await b.getByText(/Спасибо! Заказ .* принят/).innerText();
    assert.equal(arriving, 2);
    const raw = await a.evaluate((k) => sessionStorage.getItem(k), key);
    assert.ok(raw);
    fs.writeFileSync(directory + "/attempt.json", JSON.stringify({ raw, receipt }) + "\n", {
      mode: 0o600,
    });
    await context.storageState({ path: directory + "/browser-state.json", indexedDB: true });
    await screenshot(a, "http-lost-response-390");
    await screenshot(b, "http-parallel-receipt-390");
    console.log(
      JSON.stringify({ phase, passed: true, httpRequests: arriving, receipt, screenshots }),
    );
  } else {
    const prior = JSON.parse(fs.readFileSync(directory + "/attempt.json", "utf8"));
    await context.addInitScript(({ key, raw }) => sessionStorage.setItem(key, raw), {
      key,
      raw: prior.raw,
    });
    const page = await context.newPage();
    watch(page);
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Корзина:/ }).click();
    await page.getByRole("button", { name: "Проверить и завершить заказ", exact: true }).click();
    const receipt = await page.getByText(/Спасибо! Заказ .* принят/).innerText();
    assert.equal(receipt, prior.receipt);
    assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), key), null);
    await screenshot(page, "http-recovered-390");
    await page
      .getByRole("button", { name: "Нужен ещё один заказ — проверить корзину", exact: true })
      .click();
    await page.getByRole("button", { name: "Оформить учебный заказ", exact: true }).click();
    const confirm = page.getByRole("button", {
      name: "Согласиться с новой ценой и оформить",
      exact: true,
    });
    await confirm.waitFor();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await screenshot(page, "http-price-consent-" + viewport.width);
    }
    const permission = new Promise((resolve) => process.stdin.once("data", resolve));
    console.log(JSON.stringify({ event: "awaiting_price_confirmation" }));
    assert.equal(JSON.parse(String(await permission)).continue, true);
    process.stdin.destroy(); // No more control messages; allow the test process to exit.
    await confirm.click();
    const second = await page.getByText(/Спасибо! Заказ .* принят/).innerText();
    assert.notEqual(second, prior.receipt);
    await screenshot(page, "http-explicit-repeat-1440");
    console.log(
      JSON.stringify({
        phase,
        passed: true,
        originalReceipt: receipt,
        newReceipt: second,
        screenshots,
      }),
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  await context.close();
} finally {
  await browser.close();
}
