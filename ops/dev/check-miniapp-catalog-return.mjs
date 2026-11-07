// Independent Chromium against DEV. Telegram SDK is simulated; no customer session or order.
import { chromium } from "/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const origin = "https://masterweld-dev.138-124-106-211.sslip.io";
const expected = process.env.MW_EXPECT_SHA;
assert.match(expected ?? "", /^[0-9a-f]{40}$/);
const health = await (await fetch(origin + "/api/public/release-health")).json();
assert.deepEqual(health, { ready: true, revision: expected, environment: "dev" });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      reducedMotion: "reduce",
    });
    const errors = [];
    const writes = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        !["GET", "HEAD"].includes(request.method()) &&
        url.pathname !== "/backend/rest/v1/rpc/public_product_technical"
      ) {
        writes.push(request.method() + " " + url.pathname);
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      const qa = { back: null, visible: false, ready: false };
      window.__returnQA = qa;
      window.Telegram = {
        WebApp: {
          ready() {
            qa.ready = true;
          },
          expand() {},
          safeAreaInset: { top: 24, bottom: 16 },
          contentSafeAreaInset: { top: 20, bottom: 8 },
          onEvent() {},
          offEvent() {},
          BackButton: {
            show() {
              qa.visible = true;
            },
            hide() {
              qa.visible = false;
            },
            onClick(fn) {
              qa.back = fn;
            },
            offClick(fn) {
              if (qa.back === fn) qa.back = null;
            },
          },
        },
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400)
        errors.push(response.status() + " " + new URL(response.url()).pathname);
    });
    await page.goto(origin + "/?miniapp=1&q=DEV&min=1&max=999999&sort=price-asc", {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    await page.waitForFunction(() => window.__returnQA.ready);
    assert.match(await page.locator("body").innerText(), /Тестовый магазин/);
    const link = page.locator('a[href^="/product/"]').first();
    await link.waitFor();
    const before = Object.fromEntries(
      new URL(await link.getAttribute("href"), origin).searchParams,
    );
    for (const key of ["q", "min", "max", "sort"])
      assert.ok(before[key], "catalog link carries " + key);
    await link.click();
    await page.waitForFunction(() => window.__returnQA.visible);
    await page.getByRole("link", { name: "← К выбранным товарам", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: `/artifacts/miniapp-product-${width}.png`, fullPage: true });
    await page.evaluate(() => window.__returnQA.back());
    await page.waitForURL((url) => url.pathname === "/");
    await page.waitForFunction(() => !window.__returnQA.visible);
    const returned = Object.fromEntries(new URL(page.url()).searchParams);
    assert.deepEqual(returned, before, "Telegram BackButton preserves selected catalog filters");
    await page.getByPlaceholder("Модель, артикул или бренд…", { exact: true }).waitFor();
    assert.equal(
      await page.getByPlaceholder("Модель, артикул или бренд…", { exact: true }).inputValue(),
      "DEV",
    );
    await page.screenshot({ path: `/artifacts/miniapp-return-${width}.png`, fullPage: true });
    // Reopening the product and returning again must not leave duplicate SDK handlers.
    await page.locator('a[href^="/product/"]').first().click();
    await page.waitForFunction(() => window.__returnQA.visible);
    await page.evaluate(() => window.__returnQA.back());
    await page.waitForURL((url) => url.pathname === "/");
    assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), before);
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    results.push({ width, returned, noWrites: true, errors, telegramSDK: "simulated" });
    await context.close();
  }
  writeFileSync(
    "/artifacts/miniapp-catalog-return.json",
    JSON.stringify({ revision: expected, results, telegramClient: false }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ok: true, revision: expected, results, telegramClient: false }));
} finally {
  await browser.close();
}
