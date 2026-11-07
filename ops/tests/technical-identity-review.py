#!/usr/bin/env python3
"""Isolated PostgreSQL: identity edits cannot keep or replay old published technical facts."""
import concurrent.futures
import copy
import datetime
import importlib.util
import json
import pathlib
import subprocess
import time
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[2]
NAME="mw-tech-identity-qa-"+uuid.uuid4().hex[:12]
PRODUCT="10000000-0000-4000-8000-000000000001"
EMPTY="10000000-0000-4000-8000-000000000002"
OTHER="10000000-0000-4000-8000-000000000003"
CATEGORY="20000000-0000-4000-8000-000000000001"
def run(args):return subprocess.run(args,check=True,capture_output=True,text=True)
def sql(q,error=None):
    r=subprocess.run(["docker","exec","-i",NAME,"psql","-X","-Atq","-U","postgres","-v","ON_ERROR_STOP=1"],
                     input=q,capture_output=True,text=True)
    if error:assert r.returncode and error in r.stderr,r.stderr
    elif r.returncode:raise RuntimeError(r.stderr)
    return r.stdout.strip()
def lit(v):
    if v is None:return "NULL"
    if isinstance(v,int):return str(v)
    return "'"+str(v).replace("'","''")+"'"
def ready():
    for _ in range(100):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0:return
        time.sleep(.2)
    raise RuntimeError("PG_NOT_READY")
def rpc(op,doc=None,change=None,product=PRODUCT,actor=101,version=None,error=None):
    if version is None and op=="preview":
        version=int(sql("SELECT coalesce((SELECT version FROM technical_cards WHERE product_id="+lit(product)+"),0)"))
    q="SET ROLE service_role; SELECT bot_technical_catalog("+",".join(map(lit,[
        actor,op,product,change,json.dumps(doc) if doc else None,"verified",version]))+")"
    r=sql(q,error);return json.loads(r) if not error else None
def editor(op,session=None,extra=None,product=PRODUCT,error=None):
    args={"p_staff_telegram_id":101,"p_op":op,**(extra or {})}
    if op=="start":args["p_product_id"]=product
    if session:args.update(p_session_id=session["id"],p_revision=session["revision"])
    r=sql("SET ROLE service_role; SELECT bot_technical_editor("+",".join(
        k+"=>"+lit(json.dumps(v) if isinstance(v,dict) else v) for k,v in args.items())+")",error)
    return json.loads(r)["session"] if not error else None
def public(product=PRODUCT):
    r=sql("SET ROLE anon; SELECT public_product_technical("+lit(product)+")")
    return json.loads(r) if r else None
def snapshot():
    return sql("""SELECT jsonb_build_object(
      'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM products p),
      'cards',(SELECT jsonb_agg(to_jsonb(c) ORDER BY product_id) FROM technical_cards c),
      'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM technical_revisions r),
      'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM technical_identity_events e))""")
DOC={"family_code":"power_mma","sources":[{
    "key":"manual","kind":"synthetic","publisher":"Учебный изготовитель","model":"MODEL-A",
    "title":"[Учебный] Не паспорт товара","url":"https://example.invalid/manual","locator":"Таблица 1",
    "checked_on":datetime.date.today().isoformat(),"sha256":""}],
    "values":[{"attribute_code":"mma_current_max_a","process":"mma","state":"known","value":100,
               "unit_code":"a","context":{},"source_key":"manual"}]}
def preview_apply(doc=DOC,product=PRODUCT):
    b=rpc("preview",doc,product=product);rpc("apply",change=b["change_id"]);return b
def wait_holder(tag):
    for _ in range(150):
        if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name="+lit(tag)+" AND wait_event='PgSleep'")=="1":return
        time.sleep(.01)
    raise RuntimeError("COMPETING_TRANSACTION_DID_NOT_HOLD_LOCK")

created=False
try:
    run(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
         "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0034"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES(101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    sql("INSERT INTO categories(id,name,slug) VALUES("+lit(CATEGORY)+",'Training category','training-category')")
    for pid,sku in [(PRODUCT,"QA-IDENTITY"),(EMPTY,"QA-EMPTY"),(OTHER,"QA-OTHER")]:
        sql("INSERT INTO products(id,sku,slug,title,brand,price,status,assortment_decision) VALUES("+
            ",".join(map(lit,[pid,sku,sku.lower(),"[Учебный] MODEL-A","BRAND-A",10,"published","sell"]))+")")
    original=preview_apply();original_public=public()
    preview_apply(product=OTHER);other_public=public(OTHER)
    preview_before_migration=rpc("preview",DOC)
    spec=importlib.util.spec_from_file_location("identity_guard",ROOT/"ops/dev/apply-technical-identity-review.py")
    guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
    migration=(ROOT/guard.PATH).read_text()
    sql(guard.transaction(migration,{}),"TECH_IDENTITY_BASELINE")
    sql(guard.transaction(migration+"\nUPDATE products SET title='Changed by migration';"),"TECH_IDENTITY_EXISTING_DATA_CHANGED")
    assert public()==original_public
    assert sql("SELECT to_regclass('public.technical_identity_events') IS NULL")=="t"
    sql(guard.transaction(migration+"\nGRANT SELECT ON technical_identity_events TO service_role;"),"TECH_IDENTITY_PRIVILEGES")
    sql(guard.transaction(migration))
    sql(guard.transaction(migration),"TECH_IDENTITY_SCHEMA_REVIEW")
    assert public()==original_public
    assert rpc("read")["card"]["identity_review"]=={"required":False}
    # Existing pending work remains usable if identity has not changed.
    rpc("apply",change=preview_before_migration["change_id"])
    rpc("undo",change=preview_before_migration["change_id"])
    assert public()==original_public
    for role in ["anon","authenticated","service_role"]:
        sql("SET ROLE "+role+"; SELECT * FROM technical_identity_events","permission denied")
        sql("SET ROLE "+role+"; SELECT mw_private.technical_product_identity_changed()","permission denied")
        sql("SET ROLE "+role+"; SELECT mw_private.bot_technical_catalog_before_identity(101,'read',"+lit(PRODUCT)+")","permission denied")
    for actor in [999]:
        rpc("read",actor=actor,error="TECH_DENIED")
    assert rpc("read",actor=103)["card"]["published_revision"]==original_public["revision_id"]
    stale=rpc("preview",DOC)
    stale_version=stale["version"]
    sql("UPDATE products SET title=title,price=11,stock_qty=7,in_stock=true,description='Description' WHERE id="+lit(PRODUCT))
    assert public()==original_public
    assert rpc("read")["card"]["version"]==stale_version
    assert sql("SELECT count(*) FROM technical_identity_events")=="0"
    # Even read-before-first-preview must be protected when no card existed.
    empty_read=rpc("read",product=EMPTY)
    session=editor("start",product=EMPTY)
    session["data"]["document"]=copy.deepcopy(DOC)
    session=editor("save",session,{"p_data":session["data"]})
    sql("UPDATE products SET sku='QA-EMPTY-NEW' WHERE id="+lit(EMPTY))
    rpc("preview",DOC,product=EMPTY,version=empty_read["card"]["version"],error="TECH_CONFLICT")
    editor("preview",session,{"p_review_state":"verified"},product=EMPTY,error="TECH_CONFLICT")
    editor("cancel",session,product=EMPTY)
    # Identity edits invalidate old published facts and stale apply/undo across every write path.
    for column,value in [("brand","BRAND-B"),("sku","QA-IDENTITY-B"),("title","[Учебный] MODEL-B"),("category_id",CATEGORY)]:
        before_version=rpc("read")["card"]["version"]
        sql("UPDATE products SET "+column+"="+lit(value)+" WHERE id="+lit(PRODUCT))
        assert public() is None
        assert rpc("read")["card"]["version"]==before_version+1
        assert public(OTHER)==other_public
    info=rpc("read")["card"]["identity_review"]
    assert info["required"] and info["previous_revision"]==original_public["revision_id"]
    rpc("apply",change=stale["change_id"],error="TECH_CONFLICT")
    rpc("apply",change=original["change_id"])
    assert public() is None
    rpc("undo",change=original["change_id"],error="TECH_CONFLICT")
    assert json.loads(sql("SELECT document FROM technical_revisions WHERE id="+lit(original_public["revision_id"])))==DOC
    sql("UPDATE products SET title='[Учебный] MODEL-A',brand='BRAND-A',sku='QA-IDENTITY',category_id=NULL WHERE id="+lit(PRODUCT))
    assert public() is None  # reversing product fields never re-verifies technical facts
    # Explicit source review: old values become a draft, not a public card.
    session=editor("start",extra={"p_source_revision":original_public["revision_id"]})
    assert session["data"]["document"]==DOC and public() is None
    session["data"]["document"]["sources"][0]["locator"]="Таблица 1, повторно проверено"
    session=editor("save",session,{"p_data":session["data"]})
    session=editor("preview",session,{"p_review_state":"verified"})
    assert session["phase"]=="preview" and public() is None
    session=editor("apply",session)
    assert session["phase"]=="applied"
    assert rpc("read")["card"]["identity_review"]=={"required":False}
    editor("undo",session)
    assert public() is None and rpc("read")["card"]["identity_review"]["required"]
    # Event write failure rolls back product, version and pointer as one transaction.
    preview_apply()
    before=snapshot()
    sql("""CREATE FUNCTION qa_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_EVENT_FAILURE'; END $$;
      CREATE TRIGGER qa_event_failure BEFORE INSERT ON technical_identity_events FOR EACH ROW EXECUTE FUNCTION qa_event_failure();""")
    sql("UPDATE products SET brand='Must rollback' WHERE id="+lit(PRODUCT),"QA_EVENT_FAILURE")
    assert snapshot()==before
    sql("DROP TRIGGER qa_event_failure ON technical_identity_events; DROP FUNCTION qa_event_failure()")
    # Force each lock ordering: both must finish without stale publication or lost versions.
    race=rpc("preview",DOC)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        holder=pool.submit(sql,"BEGIN; SET application_name='identity-first'; UPDATE products SET brand='IDENTITY-FIRST' WHERE id="+lit(PRODUCT)+"; SELECT pg_sleep(2); COMMIT;")
        wait_holder("identity-first")
        contender=pool.submit(rpc,"apply",change=race["change_id"],error="TECH_CONFLICT")
        holder.result();contender.result()
    assert public() is None
    race=rpc("preview",DOC)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        holder=pool.submit(sql,"BEGIN; SET application_name='technical-first'; SET ROLE service_role; SELECT bot_technical_catalog(101,'apply',p_change_id=>"+lit(race["change_id"])+"); SELECT pg_sleep(2); COMMIT;")
        wait_holder("technical-first")
        contender=pool.submit(sql,"UPDATE products SET brand='TECHNICAL-FIRST' WHERE id="+lit(PRODUCT))
        holder.result();contender.result()
    assert public() is None
    count=sql("SELECT count(*) FROM technical_identity_events")
    run(["docker","restart",NAME]);ready()
    assert public() is None and sql("SELECT count(*) FROM technical_identity_events")==count
    rpc("apply",change=race["change_id"])
    assert public() is None
    print(json.dumps({"ok":True,"previousDataPreservedAtMigration":True,"identityFieldsTested":["title","brand","sku","category_id"],
      "priceStockAndNoOpPreserveFacts":True,"oldPreviewsAndUndoBlocked":True,"duplicateApplyCannotRepublish":True,
      "readBeforeFirstCardProtected":True,"humanRecheckRequired":True,"failureRollsBackWholeMutation":True,
      "bothConcurrentOrdersSafe":True,"restartRetainsInvalidation":True,"otherProductUnchanged":True}))
finally:
    if created:subprocess.run(["docker","rm","-f",NAME],capture_output=True)
