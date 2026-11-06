#!/usr/bin/env python3
"""Atomic catalog draft outcomes: offline disposable PostgreSQL, synthetic data only."""
import concurrent.futures
import importlib.util
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-drafts-qa-" + uuid.uuid4().hex[:12]
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

def start(actor=101, sku=None, title="[Учебный] Товар", price=100, expired=False):
    revision = str(uuid.uuid4())
    payload = json.dumps({"_revision":revision,"title":title,"sku":sku,"price":price},ensure_ascii=False)
    # Fixtures replace only their own inactive states; no real tables or actors exist here.
    sql("UPDATE bot_editor_states SET consumed_at=now() WHERE staff_telegram_id="+str(actor))
    sql("INSERT INTO bot_editor_states(staff_telegram_id,state,data,expires_at) VALUES("+str(actor)+
        ",'new_confirm',"+lit(payload)+",now()+interval "+lit("-1 minute" if expired else "15 minutes")+
        ") ON CONFLICT(staff_telegram_id) DO UPDATE SET state=excluded.state,data=excluded.data,"
        "expires_at=excluded.expires_at,consumed_at=NULL,product_id=NULL;")
    return revision

def finish(revision, actor=101, accept=True, error=None, db=DB):
    value = sql("SET ROLE service_role; SELECT bot_finish_draft("+",".join(map(lit,[actor,revision,accept]))+");",error,db)
    return json.loads(value) if not error else None

def state(actor=101, db=DB):
    return sql("SELECT to_jsonb(e) FROM bot_editor_states e WHERE staff_telegram_id="+str(actor),db=db)

def count(table, db=DB):
    return int(sql("SELECT count(*) FROM "+table,db=db))

created = False
try:
    run(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
         "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created = True
    for _ in range(120):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0:
            break
        time.sleep(.25)
    else: raise RuntimeError("PG_NOT_READY")
    paths = [ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
             *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<"0022"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql("""CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $f$
      SELECT '{"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}'::jsonb $f$;
      INSERT INTO staff(telegram_id,name,role,elevated,active) VALUES
      (101,'QA owner','admin',false,true),(102,'QA second','admin',false,true),
      (103,'QA seller','seller',false,true),(104,'QA inactive','admin',false,false),
      (105,'QA director','director',false,true),(106,'QA elevated','director',true,true);""")
    revision = start(sku="QA-FIRST")
    before = state()
    spec = importlib.util.spec_from_file_location("operator",ROOT/"ops/dev/apply-technical-catalog.py")
    operator = importlib.util.module_from_spec(spec); spec.loader.exec_module(operator)
    migration = (ROOT/"docs/migrations/0022_catalog_draft_results.sql").read_text()
    sql(operator.transaction(migration,draft_results=True))
    assert state()==before
    sql(operator.transaction(migration,draft_results=True),"TECH_ALREADY_APPLIED")
    for role in ["anon","authenticated","service_role"]:
        for privilege in ["SELECT","INSERT","UPDATE","DELETE"]:
            assert sql("SELECT has_table_privilege("+lit(role)+",'bot_draft_results',"+lit(privilege)+")")=="f"
        assert sql("SELECT has_function_privilege("+lit(role)+",'bot_create_draft(bigint,text,text,numeric)','EXECUTE')")=="f"
    for role in ["anon","authenticated"]:
        sql("SET ROLE "+role+"; SELECT bot_finish_draft(101,"+lit(revision)+",true)","permission denied")
    # Eight independent transactions all recover one product and one audit/receipt.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: finish(revision),range(8)))
    assert len({r["product_id"] for r in results})==1
    assert sum(not r["replayed"] for r in results)==1
    assert count("products")==count("staff_audit_log")==count("bot_draft_results")==1
    product = results[0]["product_id"]
    assert sql("SELECT status||':'||assortment_decision FROM products WHERE id="+lit(product))=="draft:review"
    assert finish(revision,accept=False)["outcome"]=="created"
    # Recovery uses the receipt, never consumes an unrelated later dialog.
    later = start(sku="QA-LATER")
    later_state = state()
    assert finish(revision)["product_id"]==product
    assert state()==later_state
    finish(revision,actor=102,error="DRAFT_NOT_OWNER")
    sql("UPDATE staff SET active=false WHERE telegram_id=101")
    finish(revision,error="DRAFT_PERMISSION_DENIED")
    sql("UPDATE staff SET active=true WHERE telegram_id=101")
    for actor in [104,105]:
        rejected = start(actor)
        finish(rejected,actor,error="DRAFT_PERMISSION_DENIED")
    for actor in [103,106]:
        accepted = start(actor,sku="QA-ROLE-"+str(actor))
        assert finish(accepted,actor)["outcome"]=="created"
    # Cancellation and creation race: first committed outcome wins permanently.
    contested = start(sku="QA-RACE"); before_count=count("products")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(finish,contested,101,True); b=pool.submit(finish,contested,101,False)
        race=[a.result(),b.result()]
    assert race[0]["outcome"]==race[1]["outcome"]
    assert count("products")==before_count+(race[0]["outcome"]=="created")
    canceled=start(sku="QA-CANCELED")
    assert finish(canceled,accept=False)["outcome"]=="canceled"
    assert finish(canceled)["outcome"]=="canceled"
    expired=start(expired=True); untouched=state()
    finish(expired,error="DRAFT_STEP_EXPIRED"); assert state()==untouched
    changed=start(); finish(str(uuid.uuid4()),error="DRAFT_STEP_CHANGED")
    # Audit failure and receipt failure roll back product creation AND consumption.
    for table in ["staff_audit_log","bot_draft_results"]:
        attempted=start(sku="QA-FAIL-"+table); before_state=state()
        sizes={t:count(t) for t in ["products","staff_audit_log","bot_draft_results"]}
        sql("CREATE FUNCTION qa_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_FORCED_FAILURE'; END $$;"
            "CREATE TRIGGER qa_fail BEFORE INSERT ON "+table+" FOR EACH ROW EXECUTE FUNCTION qa_fail();")
        finish(attempted,error="QA_FORCED_FAILURE")
        assert state()==before_state and {t:count(t) for t in sizes}==sizes
        sql("DROP TRIGGER qa_fail ON "+table+"; DROP FUNCTION qa_fail();")
        assert finish(attempted)["outcome"]=="created"
    invalid=start(price=0); before_state=state()
    finish(invalid,error="BOT_BAD_VALUE"); assert state()==before_state
    # Normalize SKU exactly as import; the loser keeps its unconsumed input.
    dup1=start(101,"QA-DUP"); dup2=start(102,"qa-dup")
    def competing(args):
        rev,actor=args
        try: return finish(rev,actor)
        except RuntimeError as e:
            assert "BOT_SKU_DUPLICATE" in str(e)
            return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        duplicates=list(pool.map(competing,[(dup1,101),(dup2,102)]))
    assert sum(r is not None for r in duplicates)==1
    loser=102 if duplicates[0] else 101
    assert json.loads(state(loser))["consumed_at"] is None
    # Same title, different SKUs: serialized slug allocation produces distinct URLs.
    r1=start(101,"QA-SLUG-1","[Учебный] Одинаковое название")
    r2=start(102,"QA-SLUG-2","[Учебный] Одинаковое название")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(finish,r1,101); b=pool.submit(finish,r2,102)
        slugs=[a.result()["slug"],b.result()["slug"]]
    assert len(set(slugs))==2
    sizes={t:count(t) for t in ["products","staff_audit_log","bot_draft_results"]}
    dump=run(["docker","exec",NAME,"pg_dump","-U","postgres","-d",DB,"-Fc"]).stdout
    run(["docker","exec",NAME,"createdb","-U","postgres","restored"])
    run(["docker","exec","-i",NAME,"pg_restore","-U","postgres","-d","restored","--exit-on-error"],input=dump)
    run(["docker","restart",NAME])
    for _ in range(120):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.25)
    else: raise RuntimeError("RESTART_FAILED")
    for db in [DB,"restored"]:
        assert finish(revision,db=db)["product_id"]==product
        assert finish(canceled,db=db)["outcome"]=="canceled"
        assert {t:count(t,db) for t in sizes}==sizes
    print(json.dumps({"atomicProductAuditReceipt":True,"concurrentSingleCreation":True,
      "cancelRaceDurable":True,"revokedRightsRejected":True,"oldResultPreservesNewInput":True,
      "normalizedSkuConflict":True,"slugConcurrency":True,"restartDumpRestoreRecovery":True,
      "sourceTablesUnchangedByMigration":True}))
finally:
    if created: run(["docker","rm","-fv",NAME])
