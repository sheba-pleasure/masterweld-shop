#!/usr/bin/env python3
"""Atomic input-to-preview handoff: offline disposable PostgreSQL, synthetic data only."""
import concurrent.futures
import importlib.util
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-previews-qa-" + uuid.uuid4().hex[:12]
DB = "postgres"

def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, **kw)

def sql(query, error=None, db=DB):
    r = subprocess.run(["docker","exec","-i",NAME,"psql","-U","postgres","-d",db,
                        "-X","-Atq","-v","ON_ERROR_STOP=1"], input=query,text=True,capture_output=True)
    if error:
        assert r.returncode and error in r.stderr, r.stderr
    elif r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()

def lit(value):
    if value is None: return "NULL"
    if isinstance(value, bool): return str(value).lower()
    if isinstance(value, int): return str(value)
    return "'" + str(value).replace("'","''") + "'"

PRODUCT = "10000000-0000-4000-8000-000000000001"
CATEGORY = "10000000-0000-4000-8000-000000000002"

def start(actor=101, state="edit_title", expired=False):
    revision=str(uuid.uuid4())
    payload={"_revision":revision,"_prompt_message_id":200,"cats":[{"id":CATEGORY,"name":"QA"}]}
    sql("UPDATE bot_editor_states SET consumed_at=now() WHERE staff_telegram_id="+str(actor))
    sql("INSERT INTO bot_editor_states(staff_telegram_id,state,product_id,data,expires_at) VALUES("+
        ",".join(map(lit,[actor,state,PRODUCT,json.dumps(payload)]))+",now()+interval "+
        lit("-1 minute" if expired else "15 minutes")+
        ") ON CONFLICT(staff_telegram_id) DO UPDATE SET state=excluded.state,data=excluded.data,"
        "product_id=excluded.product_id,expires_at=excluded.expires_at,consumed_at=NULL;")
    return revision

def preview(revision, value="Новое название", actor=101, mode="prepare", error=None, db=DB):
    output=sql("SET ROLE service_role; SELECT bot_editor_preview("+
        ",".join(map(lit,[actor,revision,mode,json.dumps(value,ensure_ascii=False)]))+");",error,db)
    return json.loads(output) if not error else None

def state(actor=101,db=DB):
    return sql("SELECT to_jsonb(e) FROM bot_editor_states e WHERE staff_telegram_id="+str(actor),db=db)

def count(table,db=DB):
    return int(sql("SELECT count(*) FROM "+table,db=db))

created=False
try:
    run(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
         "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True
    for _ in range(120):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.25)
    else: raise RuntimeError("PG_NOT_READY")
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<"0023"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql("""CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $f$
      SELECT '{"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}'::jsonb $f$;
      INSERT INTO staff(telegram_id,name,role,elevated,active) VALUES
      (101,'QA owner','admin',false,true),(102,'QA other','admin',false,true),
      (103,'QA seller','seller',false,true),(104,'QA inactive','admin',false,false),
      (105,'QA director','director',false,true),(106,'QA elevated','director',true,true);
      INSERT INTO categories(id,name,slug) VALUES('10000000-0000-4000-8000-000000000002','QA','qa');
      INSERT INTO products(id,title,slug,price,status,assortment_decision)
      VALUES('10000000-0000-4000-8000-000000000001','[Учебный] Товар','qa',100,'hidden','excluded');""")
    rev=start(); before=state()
    spec=importlib.util.spec_from_file_location("operator",ROOT/"ops/dev/apply-technical-catalog.py")
    operator=importlib.util.module_from_spec(spec); spec.loader.exec_module(operator)
    migration=(ROOT/"docs/migrations/0023_catalog_editor_previews.sql").read_text()
    sql(operator.transaction(migration,editor_previews=True))
    assert state()==before
    sql(operator.transaction(migration,editor_previews=True),"TECH_ALREADY_APPLIED")
    for role in ["anon","authenticated","service_role"]:
        for privilege in ["SELECT","INSERT","UPDATE","DELETE"]:
            assert sql("SELECT has_table_privilege("+lit(role)+",'bot_editor_previews',"+lit(privilege)+")")=="f"
    for role in ["anon","authenticated"]:
        sql("SET ROLE "+role+"; SELECT bot_editor_preview(101,"+lit(rev)+",'read')","permission denied")
    products=sql("SELECT jsonb_agg(to_jsonb(p)) FROM products p")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(lambda i: preview(rev,"Название "+str(i)),range(8)))
    assert len({r["id"] for r in results})==1
    assert len({r["after"]["title"] for r in results})==1
    assert sum(not r["replayed"] for r in results)==1
    assert count("pending_actions")==count("bot_editor_previews")==1
    pending=results[0]["id"]
    assert json.loads(state())["consumed_at"] is not None
    later=start(); later_state=state()
    assert preview(rev,mode="read")["id"]==pending and state()==later_state
    preview(rev,actor=102,mode="read",error="PREVIEW_NOT_OWNER")
    preview(later,mode="read",error="PREVIEW_NOT_FOUND")
    assert state()==later_state
    sql("UPDATE staff SET active=false WHERE telegram_id=101")
    preview(rev,mode="read",error="PREVIEW_PERMISSION_DENIED")
    sql("UPDATE staff SET active=true WHERE telegram_id=101")
    for actor in [104,105]:
        rejected=start(actor); preview(rejected,actor=actor,error="PREVIEW_PERMISSION_DENIED")
    for actor in [103,106]:
        accepted=start(actor); assert preview(accepted,actor=actor)["id"]
    seller_cat=start(103,"pick_cat")
    preview(seller_cat,0,103,error="PREVIEW_PERMISSION_DENIED")
    category=start(state="pick_cat"); category_result=preview(category,0)
    assert category_result["after"]=={"category_id":CATEGORY}
    sql("UPDATE staff SET role='seller' WHERE telegram_id=101")
    preview(category,mode="read",error="PREVIEW_PERMISSION_DENIED")
    sql("UPDATE staff SET role='admin' WHERE telegram_id=101")
    # Failure at either write rolls back pending + receipt + consumption together.
    for table in ["pending_actions","bot_editor_previews","bot_editor_states"]:
        attempted=start(); unchanged=state()
        sizes={t:count(t) for t in ["pending_actions","bot_editor_previews"]}
        operation="UPDATE" if table=="bot_editor_states" else "INSERT"
        sql("CREATE FUNCTION qa_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_FAILURE'; END $$;"
            "CREATE TRIGGER qa_fail BEFORE "+operation+" ON "+table+" FOR EACH ROW EXECUTE FUNCTION qa_fail();")
        preview(attempted,error="QA_FAILURE")
        assert state()==unchanged and {t:count(t) for t in sizes}==sizes
        sql("DROP TRIGGER qa_fail ON "+table+"; DROP FUNCTION qa_fail();")
        assert preview(attempted)["id"]
    for field,value in [("title","x"),("title",None),("sku","bad sku"),("brand","x"*101),
                        ("description","x"*5001),("specs",{}),("title",17)]:
        invalid=start(state="edit_"+field); unchanged=state()
        preview(invalid,value,error="BOT_BAD_VALUE")
        assert state()==unchanged
    cleared=start(state="edit_brand")
    assert preview(cleared,None)["after"]=={"brand":None}
    expired=start(expired=True); unchanged=state()
    preview(expired,error="PREVIEW_STEP_EXPIRED"); assert state()==unchanged
    changed=start(); preview(str(uuid.uuid4()),error="PREVIEW_STEP_CHANGED")
    # Receipt reflects durable cancellation/application/expiry and never renews TTL.
    sql("SET ROLE service_role; SELECT bot_cancel_pending("+lit(pending)+",101)")
    assert preview(rev,mode="read")["outcome"]=="canceled"
    assert sql("SELECT jsonb_agg(to_jsonb(p)) FROM products p")==products
    sql("SET ROLE service_role; SELECT bot_apply_pending("+lit(category_result["id"])+",101)")
    assert preview(category,mode="read")["outcome"]=="applied"
    expiry=start(); exp=preview(expiry)
    sql("UPDATE pending_actions SET expires_at=now()-interval '1 minute' WHERE id="+lit(exp["id"]))
    recovered_expiry=preview(expiry)
    assert recovered_expiry["expired"] is True, (recovered_expiry,sql("SELECT to_jsonb(a) FROM pending_actions a WHERE id="+lit(exp["id"])))
    assert count("staff_audit_log")==2  # one cancellation and one confirmed category change
    assert sql("SELECT status||':'||assortment_decision FROM products WHERE id="+lit(PRODUCT))=="hidden:excluded"
    # The only product mutation is the explicitly confirmed category.
    assert sql("SELECT category_id FROM products WHERE id="+lit(PRODUCT))==CATEGORY
    dump=run(["docker","exec",NAME,"pg_dump","-U","postgres","-d",DB,"-Fc"]).stdout
    run(["docker","exec",NAME,"createdb","-U","postgres","restored"])
    run(["docker","exec","-i",NAME,"pg_restore","-U","postgres","-d","restored","--exit-on-error"],input=dump)
    run(["docker","restart",NAME])
    for _ in range(120):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.25)
    else: raise RuntimeError("RESTART_FAILED")
    for db in [DB,"restored"]:
        assert preview(rev,mode="read",db=db)["outcome"]=="canceled"
        assert preview(category,mode="read",db=db)["outcome"]=="applied"
        assert preview(expiry,mode="read",db=db)["expired"] is True
    print(json.dumps({"atomicInputPendingReceipt":True,"concurrentSinglePreview":True,
      "writeFailureFullRollback":True,"oldResultPreservesNewInput":True,"rightsRechecked":True,
      "expiryNotRenewed":True,"restartDumpRestoreRecovery":True,"migrationPreservedOldTables":True}))
finally:
    if created: run(["docker","rm","-fv",NAME])
