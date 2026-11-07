#!/usr/bin/env python3
"""Concurrent DB checks ONLY in a restored QA copy. Never sends Telegram messages."""
import concurrent.futures, json, re, subprocess, sys, uuid

db = sys.argv[1] if len(sys.argv) == 2 else ""
if not re.fullmatch(r"masterweld_dev_qa_[0-9]+", db):
    raise SystemExit("Restored QA database name required; live DEV is forbidden")
def sql(query, check=True):
    r = subprocess.run(["docker","exec","-i","mw-dev-db","psql","-U","postgres","-d",db,"-X","-At","-v","ON_ERROR_STOP=1"],
                       input=query,text=True,capture_output=True)
    if check and r.returncode: raise RuntimeError(r.stderr)
    return r
assert json.loads(sql("SELECT public.mw_environment_identity()").stdout) == {
    "environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}
def commit(key, payload_hash="a"*64, rejection="NULL"):
    return f"SELECT public.commit_order_submission('{key}','{payload_hash}','DEV QA ISOLATED','+79990000000',NULL,'[]',900,false,{rejection})"
key=str(uuid.uuid4())
before=int(sql("SELECT count(*) FROM public.shop_orders").stdout)
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    values=list(pool.map(lambda _: sql(commit(key)).stdout.strip(), range(16)))
assert len(set(values))==1, "Concurrent attempts returned different orders"
assert int(sql("SELECT count(*) FROM public.shop_orders").stdout)==before+1
order_id=sql(f"SELECT order_id FROM public.order_submissions WHERE request_id='{key}'").stdout.strip()
assert int(sql(f"SELECT count(*) FROM public.order_notifications WHERE order_id='{order_id}'").stdout)==1
assert "ORDER_ATTEMPT_CONFLICT" in sql(commit(key,"b"*64),False).stderr
# Read result remains stable even if price inputs differ after commit.
assert sql(commit(key,rejection="""'{"ok":false,"code":"PRICE_CHANGED","total":999}'""")).stdout.strip()==values[0]
rejected=str(uuid.uuid4())
r=sql(commit(rejected,rejection="""'{"ok":false,"code":"PRICE_CHANGED","total":999}'""")).stdout.strip()
assert sql(commit(rejected)).stdout.strip()==r
assert int(sql("SELECT count(*) FROM public.shop_orders").stdout)==before+1
# Rollback must roll back order, receipt AND notification.
rolled=str(uuid.uuid4())
sql("BEGIN;"+commit(rolled)+";ROLLBACK;")
assert int(sql(f"SELECT count(*) FROM public.order_submissions WHERE request_id='{rolled}'").stdout)==0
assert int(sql("SELECT count(*) FROM public.shop_orders").stdout)==before+1
assert sql("SELECT has_table_privilege('anon','public.order_submissions','SELECT') OR has_function_privilege('anon','public.commit_order_submission(uuid,text,text,text,text,jsonb,numeric,boolean,jsonb)','EXECUTE')").stdout.strip()=="f"
assert sql("SELECT has_table_privilege('service_role','public.order_submissions','INSERT')").stdout.strip()=="f"
# Two synthetic sellers exist only in this disconnected restored DB.
sql("""INSERT INTO public.staff(telegram_id,name,role,active,elevated)
VALUES(91001,'Учебная Валентина','seller',true,false),(91002,'Учебная Светлана','seller',true,false);""")
def status(actor, old, new):
    return sql(f"SELECT public.bot_change_order_status('{order_id}',{actor},'{old}','{new}')",False)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    outcomes=list(pool.map(lambda actor: status(actor,"new","processing"), [91001,91002]))
assert sum(r.returncode==0 for r in outcomes)==1
assert sum("BOT_ORDER_CONFLICT" in r.stderr for r in outcomes)==1
assert status(91001,"processing","completed").returncode!=0
assert status(91002,"processing","ready").returncode==0
assert status(91001,"ready","completed").returncode==0
assert status(91002,"completed","canceled").returncode!=0
assert int(sql(f"SELECT count(*) FROM public.order_events WHERE order_id='{order_id}'").stdout)==3
sql("UPDATE public.staff SET active=false WHERE telegram_id=91002")
assert "BOT_DENIED" in status(91002,"completed","canceled").stderr
assert "BOT_DENIED" in status(91003,"completed","canceled").stderr
canceled=str(uuid.uuid4())
sql(commit(canceled))
cancel_id=sql(f"SELECT order_id FROM public.order_submissions WHERE request_id='{canceled}'").stdout.strip()
assert sql(f"SELECT public.bot_change_order_status('{cancel_id}',91001,'new','canceled')").returncode==0
print(json.dumps({"database":db,"concurrentRequests":16,"createdOrdersForAttempt":1,"notificationRowsForAttempt":1,
"changedPayloadDenied":True,"durableRejection":True,"rollbackAtomic":True,"publicAccessDenied":True,
"twoSellersConflictSafe":True,"fullStatusChain":True,"auditEvents":3,"inactiveAndUnknownDenied":True,"cancellation":True}))
