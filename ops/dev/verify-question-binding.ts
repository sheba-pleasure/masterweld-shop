/** DEV only: actual storage and Telegram sendMessage; incoming commands are simulated. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { StaffMember } from "../../src/lib/bot/permissions";
const envPath = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(envPath).mode & 0o077, 0);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const origin = "https://masterweld-dev.138-124-106-211.sslip.io", actor = 7540652678;
assert.equal(process.env["APP_ENV"], "dev");
assert.equal(process.env["PUBLIC_ORIGIN"], origin);
assert.equal(process.env["TELEGRAM_BOT_ID"], "8996533708");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal((await (await fetch(origin + "/api/public/release-health")).json()).revision, sha);
process.env["SUPABASE_URL"] = origin + "/backend";
const { supabaseAdmin: db } = await import("../../src/integrations/supabase/client.server");
assert.deepEqual((await db.rpc("mw_environment_identity" as never)).data,
  { environment: "dev", instanceId: "3a6a67bc-5ce6-46a4-af72-e6ab78800e49" });
const memberResult = await db.from("staff").select("*").eq("telegram_id", actor).single();
assert.equal(memberResult.error, null);
const member = memberResult.data as StaffMember;
assert.equal(member.active, true);
assert.equal(member.role, "admin");
const productId = "20000000-0000-4000-8000-000000000001";
const product = await db.from("products").select("sku,title").eq("id", productId).single();
assert.equal(product.data?.sku, "DEV-001");
assert.equal(product.data?.title, "ТЕСТ — сварочный аппарат");
const { tg } = await import("../../src/lib/bot/telegram.server");
const me = await (await tg("getMe", {})).json();
assert.equal(me.result.id, 8996533708);
assert.equal(me.result.username, "testmw639bot");
const rpc = db.rpc.bind(db) as unknown as
  (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: unknown }>;
async function editor(op: string) {
  const r = await rpc("bot_technical_editor", { p_staff_telegram_id: actor, p_op: op });
  assert.equal(r.error, null);
  return r.data.session;
}
function sql(query: string) {
  return execFileSync("docker", ["exec", "-i", "mw-dev-db", "psql", "-U", "postgres",
    "-d", "masterweld_dev", "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], { input: query, encoding: "utf8" }).trim();
}
function ordinary() {
  return JSON.parse(sql("SELECT coalesce((SELECT to_jsonb(s) FROM bot_editor_states s WHERE staff_telegram_id=7540652678),'null'::jsonb);"));
}
function unchanged() {
  return sql(`SELECT jsonb_build_object(
    'products',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM products r),
    'orders',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM shop_orders r),
    'notifications',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id)::text) FROM order_notifications r),
    'technical',(SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]'::jsonb)::text) FROM technical_cards r));`);
}
const previous = ordinary();
assert.ok(!previous || previous.consumed_at || Date.parse(previous.expires_at) <= Date.now(),
  "Do not replace the owner's unfinished ordinary input");
assert.equal(await editor("current"), null, "Do not replace the owner's technical draft");
const before = unchanged();

const messages: { messageId:number; text:string; question:boolean; buttons:string[] }[] = [];
let loseQuestion=true, keyboardVerified=false, failStateRead=false;
const originalFetch=globalThis.fetch;
globalThis.fetch=(async(input,init)=>{
  const url=String(input);
  if (failStateRead && url.startsWith(origin + "/backend/") && url.includes("/bot_editor_states") && (!init?.method || init.method === "GET")) {
    return Response.json({code:"QA_READ_FAILURE",message:"Simulated state read failure"},{status:503});
  }
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/answerCallbackQuery"))
    return Response.json({ok:true,result:true});
  if (url.startsWith("https://api.telegram.org/") && url.endsWith("/sendMessage")) {
    const body=JSON.parse(String(init?.body)); assert.equal(body.chat_id,actor);
    const response=await originalFetch(input,init), result=await response.clone().json();
    assert.equal(result.ok,true);
    const question=body.reply_markup?.force_reply===true;
    if (body.reply_markup?.keyboard) {
      assert.ok(body.reply_markup.keyboard.flat().some((b:{text?:string})=>b.text==="✏️ Продолжить ввод"));
      assert.equal(body.reply_markup.is_persistent,true); keyboardVerified=true;
    }
    messages.push({messageId:result.result.message_id,text:body.text,question,
      buttons:(body.reply_markup?.inline_keyboard??[]).flat().map((b:{callback_data:string})=>b.callback_data)});
    if (question && loseQuestion) {
      loseQuestion=false;
      return Response.json({ok:false,error_code:503,description:"SIMULATED_RESPONSE_LOSS"},{status:503});
    }
    return response;
  }
  return originalFetch(input,init);
}) as typeof fetch;
const {handleUpdate}=await import("../../src/lib/bot/handler.server");
const chat={id:actor,type:"private"},from={id:actor};
const send=(text:string,replyTo?:number)=>handleUpdate({update_id:1,message:{text,chat,from,
  ...(replyTo?{reply_to_message:{message_id:replyTo}}:{})}});
const callback=(data:string)=>handleUpdate({update_id:2,callback_query:{id:"dev-simulated",data,from,
  message:{chat,message_id:1}}});
const prompt=()=>ordinary().data._prompt_message_id as number;
await send("/new");
const unbound=ordinary();
assert.equal(unbound.data._prompt_message_id,null);
assert.ok(messages.at(-1)?.text.includes("Не удалось подтвердить"));
await send("Ответ на неподтверждённый вопрос",messages[0]!.messageId);
assert.deepEqual(ordinary(),unbound);
failStateRead=true;
await callback("guide:input");
failStateRead=false;
assert.deepEqual(ordinary(),unbound);
assert.ok(messages.at(-1)?.text.includes("Не удалось проверить текущий ввод"));
assert.ok(messages.at(-1)?.buttons.includes("guide:input"));
await callback("guide:input");
const titlePrompt=prompt();
assert.ok(titlePrompt>0 && titlePrompt!==messages[0]!.messageId);
await send("ТЕСТ — привязка вопроса",titlePrompt);
const skuStep=ordinary();
assert.equal(skuStep.state,"new_sku");
await send("ЗАПОЗДАЛОЕ НАЗВАНИЕ",titlePrompt);
assert.deepEqual(ordinary(),skuStep);
await send("Текст без ответа");
assert.deepEqual(ordinary(),skuStep);
await send("-",prompt());
const pricePrompt=prompt();
await send("не цена",pricePrompt);
const priceStep=ordinary();
assert.equal(priceStep.state,"new_price");
assert.notEqual(prompt(),pricePrompt);
await send("100",pricePrompt);
assert.deepEqual(ordinary(),priceStep);
execFileSync("docker",["restart","mw-dev-app"],{stdio:"pipe"});
let ready=false;
for(let i=0;i<60;i++){
  try {const r=await fetch(origin+"/api/public/release-health");
    if(r.ok && (await r.json()).revision===sha){ready=true;break;}
  } catch { /* bounded readiness polling */ }
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert.ok(ready); assert.deepEqual(ordinary(),priceStep);
await send("✏️ Продолжить ввод");
assert.notEqual(prompt(),priceStep.data._prompt_message_id);
await send("100",prompt());
const confirm=ordinary();
assert.equal(confirm.state,"new_confirm");
await callback("guide:input");
assert.deepEqual(ordinary(),confirm);
assert.ok(messages.at(-1)?.buttons.includes("nd:c:"+confirm.data._revision));
await callback("nd:x:"+confirm.data._revision);
assert.ok(ordinary().consumed_at);
assert.equal(sql("SELECT outcome FROM bot_draft_results WHERE revision='"+confirm.data._revision+"';"),"canceled");
await send("DEV-001");
assert.ok(messages.at(-1)?.buttons.includes("prd:"+productId));
await send("/menu");
assert.ok(keyboardVerified);
assert.equal(unchanged(),before);
const report={environment:"dev",sourceSha:sha,incomingCommands:"simulated",realHttpsDatabase:true,realTelegram:true,
  questionDeliveryResponseLost:true,unboundReplyRejected:true,lateAndUnthreadedTextRejected:true,
  stateReadFailurePreservesInput:true,recoveryButtonsUsed:true,freeTextSearchOutsideEditor:true,
  invalidValueRepeatsSameQuestion:true,promptSurvivesDevAppRestart:true,resumeInvalidatesOldPrompt:true,
  confirmationRecoveryKeyPreserved:true,persistentContinueButtonDelivered:true,noActiveInputRemains:true,
  productsOrdersNotificationsAndTechnicalUnchanged:true,canceledRevision:confirm.data._revision,messages};
const directory=new URL("../.state/dev/artifacts/question-binding-"+Date.now()+"/",import.meta.url);
mkdirSync(directory,{recursive:true,mode:0o700});
writeFileSync(new URL("result.json",directory),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({verified:true,report:directory.pathname+"result.json",sourceSha:sha,
  messages:messages.map(m=>m.messageId)}));
