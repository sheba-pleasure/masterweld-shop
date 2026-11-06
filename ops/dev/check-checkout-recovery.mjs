// Isolated Chromium; never uses Browser Skill or a user's Telegram session.
import { chromium } from "/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const origin="https://masterweld-dev.138-124-106-211.sslip.io";
const key="mw.checkout-attempt.v1";
const phase=process.env.MW_QA_PHASE ?? "lost-response";
assert.ok(["lost-response","after-restart"].includes(phase));
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:"reduce"});
const errors=[];
page.on("pageerror",e=>errors.push(e.message));
try {
 if(phase==="after-restart"){
  const prior=JSON.parse(readFileSync("/artifacts/mw-checkout-attempt.json","utf8"));
  await page.addInitScript(({key,value})=>sessionStorage.setItem(key,value),{key,value:prior.raw});
 }
 await page.goto(origin,{waitUntil:"networkidle",timeout:45000});
 assert.match(await page.locator("body").innerText(),/Тестовый магазин/);
 if(phase==="lost-response"){
  await page.getByRole("button",{name:"В корзину",exact:true}).first().click();
  await page.getByRole("button",{name:/Корзина: 1 шт/}).click();
  await page.getByLabel("Имя покупателя",{exact:true}).fill("DEV QA E2E-20261106-RECOVERY");
  await page.getByLabel("Телефон покупателя",{exact:true}).fill("+79990000001");
  await page.getByLabel("Комментарий к заказу",{exact:true}).fill("Проверка обрыва ответа. Учебный заказ. Не звонить.");
  let intercepted=0;
  await page.route(origin+"/**",async route=>{
   if(route.request().method()==="POST" && intercepted===0){
    intercepted++;
    // Playwright route.fetch omits Fetch Metadata; preserve this same-origin browser request.
    assert.equal((await route.request().allHeaders()).origin, origin);
    const response=await route.fetch({headers:{...await route.request().allHeaders(),"sec-fetch-site":"same-origin"}});
    if (!response.ok()) console.log("QA HTTP", response.status(), (await response.text()).slice(0,1600));
    assert.equal(response.ok(),true,"Server processed original request");
    await route.abort("connectionfailed"); // Lost AFTER server commit.
   }else await route.continue();
  });
  await page.getByRole("button",{name:"Оформить учебный заказ",exact:true}).evaluate(b=>{b.click();b.click();});
  await page.getByText(/Не удалось получить подтверждение/).waitFor();
  assert.equal(intercepted,1,"Double click must dispatch one request");
  const raw=await page.evaluate(k=>sessionStorage.getItem(k),key);
  assert.ok(raw);
  writeFileSync("/artifacts/mw-checkout-attempt.json",JSON.stringify({raw})+"\n",{mode:0o600});
  await page.screenshot({path:"/artifacts/mw-recovery-mobile.png",animations:"disabled"});
  await page.unrouteAll();
  await page.reload({waitUntil:"networkidle"});
  await page.getByRole("button",{name:/Корзина:/}).click();
  assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),raw);
 }else{
  await page.getByRole("button",{name:/Корзина:/}).click();
 }
 await page.getByRole("button",{name:"Проверить и завершить заказ",exact:true}).waitFor();
 await page.screenshot({path:"/artifacts/mw-recovery-pending-final.png",animations:"disabled"});
 await page.getByRole("button",{name:"Проверить и завершить заказ",exact:true}).click();
 await page.getByText(/Спасибо! Заказ .* принят/).waitFor({timeout:15000});
 const confirmation=await page.getByText(/Спасибо! Заказ .* принят/).innerText();
 assert.equal(await page.evaluate(k=>sessionStorage.getItem(k),key),null);
 const resultFile=phase==="lost-response"?"/artifacts/mw-checkout-recovered.json":"/artifacts/mw-checkout-restarted.json";
 if(phase==="after-restart") assert.equal(confirmation,JSON.parse(readFileSync("/artifacts/mw-checkout-recovered.json","utf8")).confirmation);
 writeFileSync(resultFile,JSON.stringify({phase,confirmation,errors})+"\n",{mode:0o600});
 await page.screenshot({path:"/artifacts/mw-recovery-success-mobile.png",animations:"disabled"});
 await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:"/artifacts/mw-recovery-success-desktop.png",animations:"disabled"});
 assert.deepEqual(errors,[]);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 console.log(JSON.stringify({phase,confirmation,errors}));
} finally {await browser.close();}
