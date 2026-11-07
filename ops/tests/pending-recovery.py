#!/usr/bin/env python3
"""Durable pending apply/cancel/read outcomes: offline disposable PostgreSQL, synthetic data only."""
import concurrent.futures
import importlib.util
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-pending-qa-" + uuid.uuid4().hex[:12]
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


PRODUCT="10000000-0000-4000-8000-000000000001"
PHOTO1="10000000-0000-4000-8000-000000000011"
PHOTO2="10000000-0000-4000-8000-000000000012"
PHOTO3="10000000-0000-4000-8000-000000000013"
ACTIONS=["price","stock","title","description","specs","brand","sku","category","status",
         "photo_main","photo_reorder","photo_delete"]
def pending(actor=101,action="title",before=None,after=None,expired=False):
    key=str(uuid.uuid4())
    if before is None: before={"title":sql("SELECT title FROM products WHERE id="+lit(PRODUCT))}
    if after is None: after={"title":"[Учебный] Изменено"}
    sql("INSERT INTO pending_actions(id,staff_telegram_id,product_id,action,before_value,after_value,expires_at) VALUES("+
        ",".join(map(lit,[key,actor,PRODUCT,action,json.dumps(before),json.dumps(after)]))+
        ",now()+interval "+lit("-1 minute" if expired else "15 minutes")+")")
    return key
def operation(key,op="apply",actor=101,error=None,db=DB):
    output=sql("SET ROLE service_role; SELECT bot_pending_operation("+",".join(map(lit,[actor,key,op]))+")",error,db)
    return json.loads(output) if not error else None
def count(table,db=DB):
    return int(sql("SELECT count(*) FROM "+table,db=db))
def row(key):
    return sql("SELECT to_jsonb(a) FROM pending_actions a WHERE id="+lit(key))
def catalog():
    return sql("SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM products p),"
               "'photos',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM product_photos p))")
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
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<"0024"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql("""CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $f$
      SELECT '{"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}'::jsonb $f$;
      INSERT INTO staff(telegram_id,name,role,elevated,active) VALUES
      (101,'QA owner','admin',false,true),(102,'QA other','admin',false,true),
      (103,'QA seller','seller',false,true),(104,'QA inactive','admin',false,false),
      (105,'QA director','director',false,true),(106,'QA elevated','director',true,true);
      INSERT INTO products(id,title,slug,price,status,assortment_decision)
      VALUES('10000000-0000-4000-8000-000000000001','[Учебный] Товар','qa',100,'hidden','excluded');
      INSERT INTO product_photos(id,product_id,url,sort_order,is_main) VALUES
      ('10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001','https://example.invalid/1.jpg',0,true),
      ('10000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000001','https://example.invalid/2.jpg',1,false),
      ('10000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000001','https://example.invalid/3.jpg',2,false);""")
    key=pending(); previous=row(key)
    spec=importlib.util.spec_from_file_location("operator",ROOT/"ops/dev/apply-technical-catalog.py")
    operator=importlib.util.module_from_spec(spec); spec.loader.exec_module(operator)
    migration=(ROOT/"docs/migrations/0024_pending_result_recovery.sql").read_text()
    sql(operator.transaction(migration,pending_recovery=True))
    assert row(key)==previous
    sql(operator.transaction(migration,pending_recovery=True),"TECH_ALREADY_APPLIED")
    for role in ["anon","authenticated","service_role"]:
        for fn in ["bot_apply_pending","bot_cancel_pending","bot_set_photo_main","bot_reorder_photo","bot_delete_photo_meta"]:
            assert sql("SELECT has_function_privilege("+lit(role)+","+lit(fn+"(uuid,bigint)")+",'EXECUTE')")=="f"
    for role in ["anon","authenticated"]:
        sql("SET ROLE "+role+"; SELECT bot_pending_operation(101,"+lit(key)+",'read')","permission denied")
    # Current SQL role checks cover every pending kind, including read and cancel.
    for actor in [101,103,104,105,106]:
        for action in ACTIONS:
            allowed=(actor in [101,106] or actor==105 and action in ["price","stock"]
                or actor==103 and action not in ["price","category","status"])
            fixture=pending(actor,action)
            operation(fixture,"read",actor,error=None if allowed else "BOT_PENDING_PERMISSION_DENIED")
            if not allowed: operation(fixture,"cancel",actor,error="BOT_PENDING_PERMISSION_DENIED")
    untouched=catalog(); unchanged=row(key)
    assert operation(key,"read")["state"]=="pending"
    assert catalog()==untouched and row(key)==unchanged and count("staff_audit_log")==0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(lambda _:operation(key),range(8)))
    assert all(r["state"]=="applied" for r in results)
    assert sum(not r["replayed"] for r in results)==1
    assert count("staff_audit_log")==1
    assert operation(key,"cancel")["state"]=="applied"
    assert count("staff_audit_log")==1
    operation(key,actor=102,error="BOT_PENDING_NOT_OWNER")
    sql("UPDATE staff SET active=false WHERE telegram_id=101")
    operation(key,"read",error="BOT_PENDING_PERMISSION_DENIED")
    sql("UPDATE staff SET active=true WHERE telegram_id=101")
    canceled=pending(); assert operation(canceled,"cancel")["state"]=="canceled"
    assert operation(canceled)["state"]=="canceled"
    # First committed apply/cancel wins and every follower reports that same outcome.
    raced=pending(action="stock",before={"in_stock":True},after={"in_stock":False})
    audits=count("staff_audit_log")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(operation,raced,"apply"); b=pool.submit(operation,raced,"cancel")
        race=[a.result(),b.result()]
    assert race[0]["state"]==race[1]["state"] and count("staff_audit_log")==audits+1
    expired=pending(expired=True); unchanged=row(expired)
    assert operation(expired)["state"]=="expired" and row(expired)==unchanged
    legacy=pending(); sql("UPDATE pending_actions SET consumed_at=now() WHERE id="+lit(legacy))
    assert operation(legacy)["state"]=="uncertain"
    conflict=pending(before={"title":"wrong"}); unchanged=row(conflict)
    operation(conflict,error="BOT_PENDING_CONFLICT"); assert row(conflict)==unchanged
    # Failure in the audit rolls back the product and receipt outcome together.
    attempted=pending(after={"title":"[Учебный] После сбоя"}); unchanged=row(attempted); untouched=catalog()
    sql("CREATE FUNCTION qa_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_FAILURE'; END $$;"
        "CREATE TRIGGER qa_fail BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION qa_fail();")
    operation(attempted,error="QA_FAILURE")
    assert row(attempted)==unchanged and catalog()==untouched
    sql("DROP TRIGGER qa_fail ON staff_audit_log; DROP FUNCTION qa_fail()")
    assert operation(attempted)["state"]=="applied"
    # All three photo transports use the same durable outcome without duplicate audits.
    photo_cases=[
      ("photo_main",{"photo_id":PHOTO2,"sort_order":1,"is_main":False,"prev_main_id":PHOTO1},{"photo_id":PHOTO2}),
      ("photo_reorder",{"photo_id":PHOTO3,"sort_order":2},{"photo_id":PHOTO3,"sort_order":1}),
      ("photo_delete",{"photo_id":PHOTO3,"sort_order":1,"is_main":False},{"photo_id":PHOTO3,"deleted":True}),
    ]
    photo_results=[]
    for action,before,after in photo_cases:
        photo=pending(action=action,before=before,after=after); audits=count("staff_audit_log")
        assert operation(photo)["state"]=="applied"
        after_catalog=catalog()
        assert operation(photo)["state"]=="applied" and operation(photo,"cancel")["state"]=="applied"
        assert catalog()==after_catalog and count("staff_audit_log")==audits+1
        photo_results.append(photo)
    # A reverse pending from the existing rollback workflow confirms through this wrapper too.
    reverse=json.loads(sql("SET ROLE service_role; SELECT bot_prepare_rollback("+lit(attempted)+",101)"))
    undo=reverse["pending_id"]; assert operation(undo)["state"]=="applied"
    assert operation(undo)["state"]=="applied"
    sizes={t:count(t) for t in ["pending_actions","staff_audit_log","products","product_photos"]}
    dump=run(["docker","exec",NAME,"pg_dump","-U","postgres","-d",DB,"-Fc"]).stdout
    run(["docker","exec",NAME,"createdb","-U","postgres","restored"])
    run(["docker","exec","-i",NAME,"pg_restore","-U","postgres","-d","restored","--exit-on-error"],input=dump)
    run(["docker","restart",NAME])
    for _ in range(120):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.25)
    else: raise RuntimeError("RESTART_FAILED")
    for db in [DB,"restored"]:
        assert operation(key,"read",db=db)["state"]=="applied"
        assert operation(canceled,db=db)["state"]=="canceled"
        assert operation(legacy,db=db)["state"]=="uncertain"
        for photo in photo_results: assert operation(photo,db=db)["state"]=="applied"
        assert {t:count(t,db) for t in sizes}==sizes
    print(json.dumps({"singleApplyAudit":True,"cancelRaceSameResult":True,"readNeverMutates":True,
      "rightsAllKindsRechecked":True,"legacyUnknownNeverReplayed":True,"photoKindsCovered":True,
      "auditFailureFullRollback":True,"rollbackConfirmationCovered":True,"restartDumpRestore":True}))
finally:
    if created: run(["docker","rm","-fv",NAME])
