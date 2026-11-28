// Offline UI regression/visual evidence for the private Svarog report only.
// Run in the existing Playwright container with --network none and /report read-only.
import { chromium } from "/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

process.umask(0o077);
const filename = process.env.SVAROG_REPORT_FILE ?? "catalog-review.html";
assert.match(filename, /^catalog-review(?:-[a-z0-9]+)?[.]html$/);
const origin = "file:///report/" + filename;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const errors = [];
const requests = [];
const evidence = { browser: await browser.version(), source: origin,
  sourceHtmlSha256: createHash("sha256").update(readFileSync("/report/" + filename)).digest("hex"),
  widths: [], screenshots: [], checks: [] };

async function screenshot(page, name) {
  const path = "/artifacts/" + name + ".png";
  await page.screenshot({ path, animations: "disabled", fullPage: false });
  chmodSync(path, 0o600);
  evidence.screenshots.push(path);
}
async function count(page) {
  const text = await page.locator("#count").innerText();
  return Number(text.split(" из ")[0].replace(/[^0-9]/g, ""));
}
async function noOverflow(page, width) {
  const dimensions = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(dimensions.scroll <= width, "Horizontal overflow: " + JSON.stringify(dimensions));
}
async function filteredRows(page) {
  return page.evaluate(() => {
    const data = JSON.parse(document.getElementById("data").textContent);
    const input = document.getElementById("search").value.trim().toLocaleLowerCase("ru");
    const tokens = input.split(/\s+/).filter(Boolean);
    const category = document.getElementById("category").value;
    const status = document.getElementById("status").value;
    return data.rows.filter(row => tokens.every(token =>
      [row.code, row.title, row.article, row.category].join(" ").toLocaleLowerCase("ru").includes(token))
      && (!category || category === row.category)
      && (!status || (status === "duplicate" ? row.duplicate
        : status === "formula" ? row.formula
        : status === "review" ? row.reasons.length > 0
        : row.change === status))).length;
  });
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 1000 : 844 },
      reducedMotion: "reduce", locale: "ru-RU", hasTouch: width === 390,
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", request => {
      if (!request.url().startsWith("file:")) requests.push(request.url());
    });
    page.on("requestfailed", request => errors.push("Request failed: " + request.url()));
    await page.goto(origin, { waitUntil: "load" });
    await page.locator(".item").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await count(page), 2008);
    await noOverflow(page, width);
    await screenshot(page, "svarog-overview-" + width);
    evidence.widths.push({ width, height: width === 1440 ? 1000 : 844 });

    await page.locator("#search").fill("MIG");
    const mig = await count(page);
    assert.ok(mig > 0 && mig < 2008);
    assert.equal(mig, await filteredRows(page));
    await page.locator("#category").selectOption({ label: "Сварочные аппараты" });
    const migEquipment = await count(page);
    assert.ok(migEquipment > 0 && migEquipment < mig);
    assert.equal(migEquipment, await filteredRows(page));
    await page.locator("#rows").scrollIntoViewIfNeeded();
    await noOverflow(page, width);
    await screenshot(page, "svarog-mig-equipment-" + width);
    evidence.checks.push({ width, searchMig: mig, searchMigEquipment: migEquipment });

    const details = page.getByRole("button", { name: "Разобрать строку", exact: true }).first();
    await details.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#detail").evaluate(el => el.open), true);
    const title = await page.locator("#detail-title").innerText();
    assert.equal(await page.getByRole("dialog", { name: title, exact: true }).count(), 1,
      "Dialog must have an accessible name linked to its heading");
    assert.match(await page.locator("#detail-body").innerText(), /Не назначена этим прайсом/);
    assert.match(await page.locator("#detail-body").innerText(), /строка/);
    await noOverflow(page, width);
    await screenshot(page, "svarog-dialog-" + width);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#detail").evaluate(el => el.open), false);
    assert.equal(await details.evaluate(el => el === document.activeElement), true);

    await page.locator("#reset").click();
    assert.equal(await count(page), 2008);
    assert.equal(await page.locator("#search").evaluate(el => el === document.activeElement), true);
    await page.locator("#search").fill("НичегоНеНайдено_qa_90210");
    assert.equal(await count(page), 0);
    await page.getByRole("heading", { name: "Совпадений нет" }).waitFor();
    assert.equal(await page.locator("#next").isDisabled(), true);
    assert.equal(await page.locator("#prev").isDisabled(), true);
    await page.locator("#rows").scrollIntoViewIfNeeded();
    await screenshot(page, "svarog-empty-" + width);

    await page.locator("#search").fill("   ");
    assert.equal(await count(page), 2008);
    await page.locator("#status").selectOption("duplicate");
    assert.equal(await count(page), 83);
    assert.equal(await filteredRows(page), 83);
    assert.equal(await page.locator(".item").count(), 30);
    const firstCode = await page.locator(".item .code").first().innerText();
    await page.locator("#next").click();
    assert.notEqual(await page.locator(".item .code").first().innerText(), firstCode);
    assert.match(await page.locator("#page").innerText(), /^2 \/ 3$/);
    await page.locator("#prev").click();
    await page.locator("#rows").scrollIntoViewIfNeeded();
    await noOverflow(page, width);
    await screenshot(page, "svarog-duplicates-" + width);

    await page.locator("#status").selectOption("formula");
    assert.equal(await count(page), 67);
    assert.equal(await page.locator(".price").first().innerText(), "Сумма требует уточнения");
    await page.locator("#status").selectOption("review");
    assert.equal(await count(page), 505);

    await page.locator("#reset").click();
    await page.locator("#search").fill("00000101566");
    assert.equal(await count(page), 1);
    const mobileMetrics = await page.locator("input,select,button").evaluateAll(elements =>
      elements.filter(el => el.getClientRects().length).map(el => {
        const box = el.getBoundingClientRect();
        return { height: box.height, width: box.width };
      }));
    assert.ok(mobileMetrics.every(box => box.height >= 44 && box.width >= 44));
    evidence.checks.push({ width, duplicates: 83, formulaPrices: 67, reviewRows: 505,
      emptyState: true, whitespaceSearch: true, pagination: true,
      leadingZeroCodeSearch: true, keyboardDialogEscapeAndFocus: true, overflow: false,
      visibleControlsAtLeast44px: true,
      bodyFont: await page.locator("body").evaluate(el => getComputedStyle(el).fontFamily) });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  evidence.errors = errors;
  evidence.networkRequests = requests;
  evidence.passed = true;
  writeFileSync("/artifacts/result.json", JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} catch (error) {
  writeFileSync("/artifacts/failure.json", JSON.stringify({ ...evidence, error: error.message, errors, requests }, null, 2), { mode: 0o600 });
  throw error;
} finally {
  await browser.close();
}
