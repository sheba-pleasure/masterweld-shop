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
NAME = "mw-preview-request-qa-" + uuid.uuid4().hex[:12]
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
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<"0025"]]
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
    migration=(ROOT/"docs/migrations/0025_pending_preview_requests.sql").read_text()
    sql(operator.transaction(migration,preview_requests=True))
    assert row(key)==previous
    sql(operator.transaction(migration,preview_requests=True),"TECH_ALREADY_APPLIED")
    for role in ["anon","authenticated","service_role"]:
        assert sql("SELECT has_table_privilege("+lit(role)+",'bot_pending_requests','SELECT')")=="f"
        assert sql("SELECT has_function_privilege("+lit(role)+",'bot_prepare_rollback(uuid,bigint)','EXECUTE')")=="f"
    for verb in ["INSERT","UPDATE","DELETE","TRUNCATE"]:
        assert sql("SELECT has_table_privilege('service_role','pending_actions',"+lit(verb)+")")=="f"
    for role in ["anon","authenticated"]:
        sql("SET ROLE "+role+"; SELECT bot_pending_preview(101,"+lit(str(uuid.uuid4()))+",'read')","permission denied")
        sql("SET ROLE "+role+"; SELECT bot_pending_history(101)","permission denied")

    def preview(request,op="prepare",actor=101,action="title",before=None,after=None,source=None,error=None,db=DB):
        before=before if before is not None else {"title":"[Учебный] Товар"}
        after=after if after is not None else {"title":"[Учебный] Изменено"}
        q="SET ROLE service_role; SELECT bot_pending_preview("+",".join(map(lit,[
            actor,request,op,PRODUCT,action,json.dumps(before),json.dumps(after),source]))+")"
        output=sql(q,error,db)
        return json.loads(output) if not error else None
    def history(actor=101,offset=0,error=None):
        out=sql("SET ROLE service_role; SELECT bot_pending_history("+str(actor)+","+str(offset)+")",error)
        return json.loads(out) if not error else None
    request=str(uuid.uuid4())
    untouched=catalog()
    assert preview(request,"read")["state"]=="not_found" and count("bot_pending_requests")==0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(lambda _:preview(request),range(8)))
    target=results[0]["pending_id"]
    assert all(r["pending_id"]==target and r["state"]=="pending" for r in results)
    assert sum(not r["replayed"] for r in results)==1
    assert count("bot_pending_requests")==1 and count("pending_actions")==2 and count("staff_audit_log")==0
    stored=row(target)
    assert preview(request,after={"title":"Changed request"})["pending_id"]==target
    assert row(target)==stored and catalog()==untouched
    preview(request,"read",actor=102,error="BOT_PENDING_NOT_OWNER")
    sql("UPDATE staff SET active=false WHERE telegram_id=101")
    preview(request,"read",error="BOT_PENDING_PERMISSION_DENIED"); history(error="BOT_PENDING_PERMISSION_DENIED")
    sql("UPDATE staff SET active=true WHERE telegram_id=101")
    assert operation(target)["state"]=="applied"
    assert preview(request,"read")["state"]=="applied"
    # Reverse preview, audit and receipt are one transaction and one stable result.
    undo_request=str(uuid.uuid4())
    audits=count("staff_audit_log")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        undos=list(pool.map(lambda _:preview(undo_request,"rollback",source=target),range(8)))
    undo=undos[0]["pending_id"]
    assert all(r["pending_id"]==undo for r in undos) and count("staff_audit_log")==audits+1
    assert operation(undo,"cancel")["state"]=="canceled"
    assert preview(undo_request,"rollback",source=target)["state"]=="canceled"
    assert count("staff_audit_log")==audits+2
    assert preview(str(uuid.uuid4()),"rollback",actor=102,source=target,error="BOT_PENDING_NOT_OWNER") is None
    # Cancellation/expiry never create a replacement or extend the first TTL.
    expired_request=str(uuid.uuid4()); expired=preview(expired_request)["pending_id"]
    sql("UPDATE pending_actions SET expires_at=now()-interval '1 minute' WHERE id="+lit(expired))
    stored=row(expired); assert preview(expired_request)["state"]=="expired" and row(expired)==stored

    # Mirror every role/action; no reader may discover the owner's private rows.
    for actor in [101,103,104,105,106]:
        for action in ACTIONS:
            allowed=(actor in [101,106] or actor==105 and action in ["price","stock"]
                     or actor==103 and action not in ["price","category","status"])
            field={"stock":"in_stock","category":"category_id"}.get(action,action)
            before=after={field:"synthetic"}
            if action.startswith("photo_"): before=after={"photo_id":PHOTO1}
            rid=str(uuid.uuid4())
            r=preview(rid,actor=actor,action=action,before=before,after=after,
                      error=None if allowed else "BOT_PENDING_PERMISSION_DENIED")
            if allowed:
                assert preview(rid,"read",actor=actor)["pending_id"]==r["pending_id"]
    assert history(102)==[]
    for actor in [103,105,106]:
        rows=history(actor)
        assert 0<len(rows)<=11
        assert all(set(r)=={"id","action","created_at","title","state"} for r in rows)
        assert all((actor==106 or actor==105 and r["action"] in ["price","stock"]
                    or actor==103 and r["action"] not in ["price","category","status"]) for r in rows)
    assert len(history())==11
    assert set(r["id"] for r in history()[:10]).isdisjoint(r["id"] for r in history(offset=10))
    history(offset=-1,error="BOT_BAD_VALUE"); history(offset=10001,error="BOT_BAD_VALUE")
    counts={t:count(t) for t in ["pending_actions","bot_pending_requests","staff_audit_log"]}
    preview(str(uuid.uuid4()),before={"purchase_cost":100},error="BOT_BAD_VALUE")
    preview(str(uuid.uuid4()),after={},error="BOT_BAD_VALUE")
    preview(str(uuid.uuid4()),after={"title":"x"*20001},error="BOT_BAD_VALUE")
    assert counts=={t:count(t) for t in counts}
    # A failed receipt insert must roll back direct or rollback pending AND its audit.
    sql("CREATE FUNCTION qa_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_FAILURE'; END $$;"
        "CREATE TRIGGER qa_fail BEFORE INSERT ON bot_pending_requests FOR EACH ROW EXECUTE FUNCTION qa_fail();")
    for op in ["prepare","rollback"]:
        preview(str(uuid.uuid4()),op,source=target if op=="rollback" else None,error="QA_FAILURE")
        assert counts=={t:count(t) for t in counts}
    sql("DROP TRIGGER qa_fail ON bot_pending_requests; DROP FUNCTION qa_fail()")
    # A later read is observational, preserving all rows and product values.
    fingerprints=sql("SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM pending_actions a")
    preview(request,"read"); history()
    assert fingerprints==sql("SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM pending_actions a")
    dump=run(["docker","exec",NAME,"pg_dump","-U","postgres","-d",DB,"-Fc"]).stdout
    run(["docker","exec",NAME,"createdb","-U","postgres","restored"])
    run(["docker","exec","-i",NAME,"pg_restore","-U","postgres","-d","restored","--exit-on-error"],input=dump)
    run(["docker","restart",NAME])
    for _ in range(120):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.25)
    else: raise RuntimeError("PG_RESTART_FAILED")
    assert preview(request,"read",db="restored")["pending_id"]==target
    assert preview(undo_request,"rollback",source=target,db="restored")["state"]=="canceled"
    assert counts=={t:count(t,db="restored") for t in counts}
    print(json.dumps({"concurrentPreviewSingle":True,"reversePreviewAuditSingle":True,
        "receiptFailureRollsBack":True,"permissionsAndHistory":True,"readDoesNotMutate":True,
        "expiryCancellationPreserved":True,"legacyWritesClosed":True,"dumpRestoreRestart":True}))
finally:
    if created: run(["docker","rm","-f","-v",NAME])
