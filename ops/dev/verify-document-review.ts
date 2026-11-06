/** DEV only. Incoming actions are simulated; storage, parser and owner Telegram delivery are real. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
const envPath = new URL("../.secrets/dev/app.env", import.meta.url);
assert.equal(statSync(envPath).mode & 0o077, 0);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
 const i = line.indexOf("="); if (i > 0) process.env[line.slice(0,i)] = line.slice(i+1);
}
const origin="https://masterweld-dev.138-124-106-211.sslip.io", actor=7540652678;
assert.equal(process.env["APP_ENV"],"dev");
assert.equal(process.env["PUBLIC_ORIGIN"],origin);
assert.equal(process.env["TELEGRAM_BOT_ID"],"8996533708");
const sha=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
assert.equal((await(await fetch(origin+"/api/public/release-health")).json()).revision,sha);
process.env["SUPABASE_URL"]=origin+"/backend";
const {supabaseAdmin:db}=await import("../../src/integrations/supabase/client.server");
assert.deepEqual((await db.rpc("mw_environment_identity" as never)).data,
 {environment:"dev",instanceId:"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"});
const {tg}=await import("../../src/lib/bot/telegram.server");
assert.equal((await(await tg("getMe",{})).json()).result.username,"testmw639bot");
const rpc=db.rpc.bind(db) as unknown as (name:string,args:Record<string,unknown>)=>Promise<{data:any;error:unknown}>;
async function call(name:string,args:Record<string,unknown>){const r=await rpc(name,args);assert.equal(r.error,null);return r.data;}
function sql(q:string){return execFileSync("docker",["exec","-i","mw-dev-db","psql","-U","postgres","-d","masterweld_dev","-X","-Atq","-v","ON_ERROR_STOP=1"],{input:q,encoding:"utf8"}).trim();}
assert.equal(sql("SELECT count(*) FROM staff WHERE telegram_id=7540652678 AND active AND role='admin'"),"1");
assert.equal(sql("SELECT count(*) FROM bot_editor_states WHERE staff_telegram_id=7540652678 AND consumed_at IS NULL AND expires_at>now()"),"0");
assert.equal((await call("bot_technical_editor",{p_staff_telegram_id:actor,p_op:"current"})).session,null);
assert.equal((await call("bot_document_review",{p_actor:actor,p_op:"input"})).idle,true);
function fingerprint(){return sql(`SELECT jsonb_object_agg(name,digest) FROM (
 SELECT 'products' name, md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) digest FROM products r UNION ALL
 SELECT 'costs',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]')::text) FROM product_costs r UNION ALL
 SELECT 'orders',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text) FROM shop_orders r UNION ALL
 SELECT 'notifications',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id),'[]')::text) FROM order_notifications r UNION ALL
 SELECT 'staff',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY telegram_id),'[]')::text) FROM staff r) a`);}
const before=fingerprint(), stamp=Date.now();
const original=Buffer.from(`sku\ttitle\tprice\nREVIEW-${stamp}-A\tТЕСТ — аппарат\t100\nREVIEW-${stamp}-B\tТЕСТ — строка для пропуска\t200\nREVIEW-${stamp}-C\tТЕСТ — маска\t300\n`);
const doc=await call("bot_document_intake",{p_actor:actor,p_op:"upload",p_payload:{file_name:"ТЕСТ-проверка-строк-"+stamp+".tsv",base64:original.toString("base64")}});
assert.equal(doc.checksum,createHash("sha256").update(original).digest("hex"));
let parsed:any;
for(let i=0;i<60;i++){
 parsed=await call("bot_document_intake",{p_actor:actor,p_op:"get",p_id:doc.id});
 if(parsed.state==="review")break;
 assert.ok(["queued","extracting"].includes(parsed.state));
 await new Promise(resolve=>setTimeout(resolve,500));
}
assert.equal(parsed.state,"review");
assert.equal(parsed.extraction.tables[0].rows.length,3);
const extraction=JSON.stringify(parsed.extraction);
const messages:{messageId:number;text:string;buttons:string[];question:boolean}[]=[];
const originalFetch=globalThis.fetch;let loseQuestion=true;
globalThis.fetch=(async(input,init)=>{
 const url=String(input);
 if(url.startsWith("https://api.telegram.org/")&&url.endsWith("/answerCallbackQuery"))return Response.json({ok:true,result:true});
 if(url.startsWith("https://api.telegram.org/")&&url.endsWith("/sendMessage")){
  const body=JSON.parse(String(init?.body));assert.equal(body.chat_id,actor);
  const res=await originalFetch(input,init),result=await res.clone().json();assert.equal(result.ok,true);
  const question=body.reply_markup?.force_reply===true;
  messages.push({messageId:result.result.message_id,text:body.text,question,buttons:(body.reply_markup?.inline_keyboard??[]).flat().map((b:{callback_data:string})=>b.callback_data)});
  if(question&&loseQuestion){loseQuestion=false;return Response.json({ok:false,error_code:503,description:"QA_LOST_QUESTION_RESPONSE"},{status:503});}
  return res;
 }
 return originalFetch(input,init);
}) as typeof fetch;
const {handleUpdate}=await import("../../src/lib/bot/handler.server");
const chat={id:actor,type:"private"},from={id:actor};
const callback=(data:string)=>handleUpdate({update_id:1,callback_query:{id:"dev-review-simulated",data,from,message:{chat,message_id:1}}});
const send=(text:string,replyTo?:number)=>handleUpdate({update_id:2,message:{chat,from,text,...(replyTo?{reply_to_message:{message_id:replyTo}}:{})}});
await callback("di:table:"+doc.id+":0");
let r=await call("bot_document_review",{p_actor:actor,p_op:"open",p_id:doc.id,p_row:0});
const rid=r.id;
async function get(row=0){return call("bot_document_review",{p_actor:actor,p_op:"get",p_id:rid,p_row:row});}
const key=(s:any,op:string,row=s.row,col?:number)=>`dr:${s.id}:${s.revision}:${op}:${row}${col===undefined?"":":"+col}`;
await callback(key(r,"edit",0,2));
let prompt=(await call("bot_document_review",{p_actor:actor,p_op:"input"})).prompt;
assert.equal(prompt.message_id,null);
const lost=messages.find(m=>m.question)!.messageId;
await send("999",lost);
assert.equal((await get()).cells[2],"100");
await send("/input");
prompt=(await call("bot_document_review",{p_actor:actor,p_op:"input"})).prompt;
assert.ok(prompt.message_id>lost);
await send("999");
assert.equal((await get()).cells[2],"100");
execFileSync("docker",["restart","mw-dev-app"],{stdio:"pipe"});
let ready=false;
for(let i=0;i<60;i++){
 try{const response=await fetch(origin+"/api/public/release-health");if(response.ok&&(await response.json()).revision===sha){ready=true;break;}}catch{}
 await new Promise(resolve=>setTimeout(resolve,500));
}
assert.ok(ready);
assert.equal((await call("bot_document_review",{p_actor:actor,p_op:"input"})).prompt.message_id,prompt.message_id);
await send("125",prompt.message_id);r=await get();
assert.equal(r.cells[2],"125");assert.equal(r.original[2],"100");assert.equal(r.decision,"pending");
await send("999",prompt.message_id);assert.equal((await get()).cells[2],"125");
await callback(key(r,"approve"));r=await get(1);
await callback(key(r,"exclude"));r=await get(2);
await callback(key(r,"approve"));r=await get(2);
assert.deepEqual(r.counts,{total:3,pending:0,approved:2,excluded:1});
await callback(key(r,"summary"));
const handoff=key(r,"handoff");
await callback(handoff);await callback(handoff);
r=await get();
assert.ok(r.import_id);
const imported=await call("bot_catalog_import",{p_actor:actor,p_op:"source",p_id:r.import_id});
assert.equal(imported.source.rows.length,2);
assert.equal(imported.source.rows[0][2],"125");
assert.deepEqual(imported.source.provenance.map((p:any)=>p.source_row),[0,2]);
assert.equal(sql("SELECT count(*) FROM document_import_origins WHERE review_id='"+rid+"'"),"1");
assert.equal(sql("SELECT state FROM catalog_imports WHERE id='"+r.import_id+"'"),"config");
assert.equal((await call("bot_document_review",{p_actor:actor,p_op:"input"})).idle,true);
assert.equal(JSON.stringify((await call("bot_document_intake",{p_actor:actor,p_op:"get",p_id:doc.id})).extraction),extraction);
assert.equal(fingerprint(),before);
const folder=new URL("../.state/dev/artifacts/document-review-"+stamp+"/",import.meta.url);
mkdirSync(folder,{recursive:true,mode:0o700});
const report={sourceSha:sha,environment:"dev",documentId:doc.id,reviewId:rid,importId:r.import_id,
 originalSha256:doc.checksum,realParser:true,realTelegram:true,incomingActions:"simulated",visualTelegramClient:false,
 sourcePreserved:true,unboundAndLateRepliesRejected:true,lostQuestionRecovered:true,promptSurvivesRestart:true,
 approved:2,excluded:1,importState:"config",duplicateHandoffOneImport:true,catalogOrdersCostsStaffNotificationsUnchanged:true,messages};
writeFileSync(new URL("result.json",folder),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({verified:true,report:folder.pathname+"result.json",sourceSha:sha,messages:messages.map(m=>m.messageId)}));
