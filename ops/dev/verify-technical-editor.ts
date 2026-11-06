/** DEV acceptance: real database/Telegram; incoming buttons and answers are simulated. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { StaffMember } from "../../src/lib/bot/permissions";
const envPath=new URL("../.secrets/dev/app.env",import.meta.url);
assert.equal(statSync(envPath).mode & 0o077,0);
for(const line of readFileSync(envPath,"utf8").split("\n")) {
  const i=line.indexOf("="); if(i>0)process.env[line.slice(0,i)]=line.slice(i+1);
}
const origin="https://masterweld-dev.138-124-106-211.sslip.io", actor=7540652678;
assert.equal(process.env["APP_ENV"],"dev");assert.equal(process.env["PUBLIC_ORIGIN"],origin);
assert.equal(process.env["TELEGRAM_BOT_ID"],"8996533708");
process.env["SUPABASE_URL"]=origin+"/backend";
const {supabaseAdmin:db}=await import("../../src/integrations/supabase/client.server");
assert.deepEqual((await db.rpc("mw_environment_identity" as never)).data,{environment:"dev",instanceId:"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"});
const memberResult=await db.from("staff").select("*").eq("telegram_id",actor).single();
assert.equal(memberResult.error,null);
const member=memberResult.data as StaffMember;
assert.equal(member.active,true);assert.equal(member.role,"admin");
const productId="20000000-0000-4000-8000-000000000001";
const product=await db.from("products").select("*").eq("id",productId).single();
assert.equal(product.error,null);assert.equal(product.data?.sku,"DEV-001");
assert.equal(product.data?.title,"ТЕСТ — сварочный аппарат");
const {tg}=await import("../../src/lib/bot/telegram.server");
const me=await (await tg("getMe",{})).json();
assert.equal(me.result.id,8996533708);assert.equal(me.result.username,"testmw639bot");
const rpc=db.rpc.bind(db) as unknown as (name:string,args:Record<string,unknown>)=>Promise<{data:any;error:unknown}>;
async function editor(op:string,extra:Record<string,unknown>={}) {
  const r=await rpc("bot_technical_editor",{p_staff_telegram_id:actor,p_op:op,...extra});
  assert.equal(r.error,null);assert.equal(r.data.ok,true);return r.data.session;
}
assert.equal(await editor("current"),null,"Do not replace the owner's existing draft");
const publicBefore=await rpc("public_product_technical",{p_product_id:productId});
assert.equal(publicBefore.error,null);
assert.ok(publicBefore.data.sources.every((s:any)=>s.kind==="synthetic"));
function unchangedTables(){
 return execFileSync("docker",["exec","-i","mw-dev-db","psql","-U","postgres","-d","masterweld_dev","-X","-Atq","-v","ON_ERROR_STOP=1"],{
 input:`SELECT jsonb_build_object(
 'products',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM products r),
 'orders',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY id)::text) FROM shop_orders r),
 'notifications',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY order_id,staff_telegram_id)::text) FROM order_notifications r));`,encoding:"utf8"}).trim();
}
const before=unchangedTables();
const messages:{messageId:number;forceReply:boolean}[]=[];
const realFetch=globalThis.fetch;
globalThis.fetch=(async(input,init)=>{
 const url=String(input);
 if(url.startsWith("https://api.telegram.org/") && url.endsWith("/sendMessage")){
   const body=JSON.parse(String(init?.body)); assert.equal(body.chat_id,actor);
   const response=await realFetch(input,init), result=await response.clone().json();
   assert.equal(result.ok,true);
   messages.push({messageId:result.result.message_id,forceReply:body.reply_markup?.force_reply===true});
   return response;
 }
 return realFetch(input,init);
}) as typeof fetch;
const {technicalEditor}=await import("../../src/lib/technical/editor.server");
const {fields}=await import("../../src/lib/technical/editor");
const chat={id:actor,type:"private"},from={id:actor};
const invoke=(input:Parameters<typeof technicalEditor>[3])=>technicalEditor(member,chat,from,input);
const click=(s:any,action:string,index?:number)=>invoke({callback:"te:"+s.id+":"+s.revision+":"+action+(index===undefined?"":":"+index)});
await invoke({callback:"te:start:"+productId});
let s=await editor("current");assert.equal(s.product_id,productId);
const sessionId=s.id, baseVersion=s.base_version;
await click(s,"fields");s=await editor("current");
await click(s,"field",fields(s.data).findIndex(f=>f.attribute_code==="mma_current_max_a"));s=await editor("current");
await click(s,"process",0);s=await editor("current");
const factIndex=s.data.document.values.findIndex((v:any)=>v.attribute_code==="mma_current_max_a");
assert.ok(factIndex>=0);
await click(s,"existing",factIndex);s=await editor("current");
assert.equal(s.data.screen,"value");assert.ok(s.prompt_message_id>0);
const oldRevision=s.revision;
await invoke({text:"161",replyTo:s.prompt_message_id-1});
assert.equal((await editor("current")).revision,oldRevision);
await invoke({text:"161",replyTo:s.prompt_message_id});s=await editor("current");
assert.equal(s.data.screen,"sources");
const sourceIndex=s.data.document.sources.findIndex((v:any)=>v.key===s.data.pending.source_key);
assert.ok(sourceIndex>=0);
await click(s,"source",sourceIndex);s=await editor("current");
assert.equal(s.data.document.values[factIndex].value,161);
await click(s,"verified");s=await editor("current");
assert.equal(s.phase,"preview");assert.equal(s.base_version,baseVersion);
await click(s,"review");await click(s,"before");
const preview=structuredClone(s);
await click(s,"apply");s=await editor("get",{p_session_id:sessionId});
assert.equal(s.phase,"applied");
const after=(await rpc("public_product_technical",{p_product_id:productId})).data;
assert.equal(after.values.find((v:any)=>v.code==="mma_current_max_a").value,161);
await click(preview,"apply");
assert.equal((await editor("get",{p_session_id:sessionId})).applied_revision,s.applied_revision);
await click(s,"askundo");await click(s,"undo_yes");
assert.equal((await editor("get",{p_session_id:sessionId})).phase,"undone");
assert.deepEqual((await rpc("public_product_technical",{p_product_id:productId})).data,publicBefore.data);
assert.equal(unchangedTables(),before);
assert.equal(await editor("current"),null);
const report={environment:"dev",sessionId,baseVersion,incomingUpdates:"simulated",realHttpsDatabase:true,realTelegramMessages:messages,
 boundReply:true,oldReplyRejected:true,applyDuplicateSameRevision:true,publicValueVerified:true,undoRestoresPublishedCard:true,
 productOrdersNotificationsUnchanged:true,physicalTelegramClicks:false};
const directory=new URL("../.state/dev/artifacts/technical-editor-20261106/",import.meta.url);
mkdirSync(directory,{recursive:true,mode:0o700});
writeFileSync(new URL("result.json",directory),JSON.stringify(report,null,2)+"\n",{mode:0o600,flag:"wx"});
console.log(JSON.stringify(report));
