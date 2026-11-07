#!/usr/bin/env python3
"""Isolated PostgreSQL: explicit product model choice, receipts and invalidation."""
import base64
import concurrent.futures
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import time
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[2]
NAME="mw-model-choice-qa-"+uuid.uuid4().hex[:12]
def command(args):
    return subprocess.run(args,check=True,capture_output=True,text=True)
def sql(q,error=None):
    r=subprocess.run(["docker","exec","-i",NAME,"psql","-X","-Atq","-U","postgres","-v","ON_ERROR_STOP=1"],
        input=q,capture_output=True,text=True)
    if error: assert r.returncode and error in r.stderr,r.stderr
    elif r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip()
def lit(value):
    return "'"+str(value).replace("'","''")+"'"
def rpc(op,actor=101,id=None,payload=None,error=None):
    q="SET ROLE service_role; SELECT bot_document_intake("+str(actor)+","+lit(op)+","+(lit(id) if id else "NULL")+","+lit(json.dumps(payload or {}))+");"
    r=sql(q,error)
    return json.loads(r) if not error else None
def worker(op,id=None,lease=None,result=None,error=None):
    r=sql("SET ROLE service_role; SELECT document_worker("+",".join([lit(op),lit(id) if id else "NULL",
        lit(lease) if lease else "NULL",lit(json.dumps(result)) if result is not None else "NULL"])+");",error)
    return json.loads(r) if not error else None
def upload(content=b"sku,title,price\nDEV-ONLY,Training,10",actor=101):
    return rpc("upload",actor,payload={"file_name":"training.csv","base64":base64.b64encode(content).decode()})

def review(op, rid=None, rev=None, row=0, col=None, payload=None, actor=101, error=None):
    args=[str(actor),lit(op),lit(rid) if rid else "NULL",str(rev) if rev is not None else "NULL",
          str(row),"NULL" if col is None else str(col),lit(json.dumps(payload or {}))]
    result=sql("SET ROLE service_role; SELECT bot_document_review("+",".join(args)+");",error)
    return json.loads(result) if not error else None
def ready():
    for _ in range(100):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0:return
        time.sleep(.2)
    raise RuntimeError("PG_NOT_READY")
def model(op, rid, revision=None, row=0, payload=None, actor=101, error=None):
    args=[str(actor),lit(op),lit(rid),str(revision) if revision is not None else "NULL",str(row),lit(json.dumps(payload or {}))]
    result=sql("SET ROLE service_role; SELECT bot_document_model("+",".join(args)+");",error)
    return json.loads(result) if not error else None


def catalog(op,bid=None,revision=None,payload=None,actor=101,error=None):
    args=[str(actor),lit(op),lit(bid) if bid else "NULL",lit(json.dumps(payload or {})),"0",str(revision) if revision is not None else "NULL"]
    r=sql("SET ROLE service_role; SELECT bot_catalog_import("+",".join(args)+");",error)
    return json.loads(r) if not error else None
def links(pid,actor=101,error=None):
    r=sql("SET ROLE service_role; SELECT bot_product_document_models("+str(actor)+","+lit(pid)+");",error)
    return json.loads(r) if not error else None
def confirm(rid,row=0,name="MODEL-220"):
    m=model("get",rid,row=row)
    m=model("start",rid,m["revision"],row=row)
    for value in ["Training manufacturer",name]:
        model("bind",rid,m["revision"],row=row,payload={"message_id":100})
        m=model("reply",rid,m["revision"],row=row,payload={"reply_to":100,"value":value})
    m=model("novar",rid,m["revision"],row=row)
    return model("confirm",rid,m["revision"],row=row)
def document(rows):
    f=upload(json.dumps(rows).encode())
    c=worker("claim")
    worker("finish",c["id"],c["lease"],{"version":"document-v1","sha256":f["checksum"],"tables":[{
        "label":"Training","header":["sku","title","price"],"rows":rows,
        "row_locators":["sheet:1/row:"+str(i+2) for i in range(len(rows))]}],
        "blocks":[],"warnings":[],"coverage":{"complete":True}})
    return f,review("open",f["id"])
def normalized(rows):
    return [{"line":i+2,"sku":r[0],"values":{"title":r[1],"price":int(r[2])},"errors":[]} for i,r in enumerate(rows)]
def preview(b,rows):
    return catalog("preview",b["id"],b["revision"],{"rows":normalized(rows)})

def choice(op,pid=None,batch=None,line=None,request=None,actor=101,error=None):
    args=[str(actor),lit(op),lit(pid) if pid else "NULL",lit(batch) if batch else "NULL",
          str(line) if line is not None else "NULL",lit(request) if request else "NULL"]
    result=sql("SET ROLE service_role; SELECT bot_product_model_choice("+",".join(args)+");",error)
    return json.loads(result) if not error else None

def imported(name,sku="CHOICE-A",actor=101):
    assert actor==101
    rows=[[sku,"Training device","10"]]
    f=upload(json.dumps([name,sku,str(uuid.uuid4())]).encode())
    job=worker("claim")
    worker("finish",job["id"],job["lease"],{"version":"document-v1","sha256":f["checksum"],
      "tables":[{"label":"Training","header":["sku","title","price"],"rows":rows,"row_locators":["sheet:1/row:2"]}],
      "blocks":[],"warnings":[],"coverage":{"complete":True}})
    r=review("open",f["id"])
    r=review("approve",r["id"],r["revision"])
    confirm(r["id"],name=name)
    b=catalog("get",review("handoff",r["id"],r["revision"])["import_id"])
    b=preview(b,rows)
    if b.get("model_blocked",0):
        catalog("model_accept",b["id"],b["revision"],{"line":2})
    b=catalog("apply",b["id"],b["revision"])
    pid=sql("SELECT product_id FROM catalog_import_items WHERE batch_id="+lit(b["id"])+" AND line=2")
    return pid,b,r

def prepare(pid,batch,actor=101,request=None):
    return choice("prepare",pid,batch["id"],2,request or str(uuid.uuid4()),actor)

def confirm_choice(view,actor=101,error=None):
    return choice("confirm",request=view["request"]["id"],actor=actor,error=error)

def fingerprint():
    return sql("""SELECT jsonb_build_object(
      'products',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM products p),
      'costs',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY product_id),'[]') FROM product_costs p),
      'orders',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM shop_orders p),
      'documents',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM document_intakes p))""")


def sources(op,pid=None,rid=None,rev=None,payload=None,actor=101,error=None):
    args=[str(actor),lit(op),lit(pid) if pid else "NULL",lit(rid) if rid else "NULL",
          str(rev) if rev is not None else "NULL",lit(json.dumps(payload or {}))]
    out=sql("SET ROLE service_role; SELECT bot_product_sources("+",".join(args)+");",error)
    return json.loads(out) if not error else None

def act(op,r,payload=None,actor=101,error=None):
    return sources(op,rid=r["id"],rev=r["revision"],payload=payload,actor=actor,error=error)

def snapshot():
    tables=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN('staff_audit_log','product_source_reviews','product_document_sources') ORDER BY tablename").splitlines()
    return {t:sql('SELECT md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),\'\')) FROM public."'+t+'" t') for t in tables}

def prepared(pid,doc,kind="manual"):
    r=sources("start",pid,rid=str(uuid.uuid4()))["review"]
    r=act("choose",r,{"document_id":doc})["review"]
    r=act("kind",r,{"kind":kind})["review"]
    return act("preview",r)["review"]

created=False
try:
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
             "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
      *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0036"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false),(104,'Director','director',false),(105,'Elevated','director',true)")
    pid,b,reviewed=imported("MODEL-220")
    source_doc=review("get",reviewed["id"])["document_id"]
    before=snapshot()
    migration=(ROOT/"docs/migrations/0037_primary_source_review.sql").read_text()
    spec=importlib.util.spec_from_file_location("guard",ROOT/"ops/dev/apply-primary-source-review.py")
    guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
    sql(guard.transaction(migration,{}),error="PRIMARY_SOURCE_BASELINE")
    sql(guard.transaction(migration+"\nUPDATE products SET title='Unexpected';"),error="PRIMARY_SOURCE_EXISTING_DATA_CHANGED")
    sql(guard.transaction(migration+"\nGRANT SELECT ON product_source_reviews TO service_role;"),error="PRIMARY_SOURCE_PRIVILEGES")
    sql(guard.transaction(migration))
    sql(guard.transaction(migration),error="PRIMARY_SOURCE_SCHEMA_REVIEW")
    assert snapshot()==before,"MIGRATION_CHANGED_OLD_DATA"
    for role in ["anon","authenticated","service_role"]:
        for table in ["product_source_reviews","product_document_sources"]:
            sql("SET ROLE "+role+"; SELECT * FROM "+table,error="permission denied")
    for role in ["anon","authenticated"]:
        sql("SET ROLE "+role+"; SELECT bot_product_sources(101,'home',"+lit(pid)+")",error="permission denied")
    for actor in [103,104,999]:
        sources("home",pid,actor=actor,error="SOURCE_DENIED")
    assert sources("home",pid,actor=105)["ok"]
    sources("start",pid,rid=str(uuid.uuid4()),error="SOURCE_MODEL_REQUIRED")
    selected=confirm_choice(prepare(pid,b))
    assert selected["current"]["state"]=="selected"
    # A second actor's file must not be readable or selectable.
    foreign=upload(b"Foreign private document",actor=102)
    job=worker("claim")
    worker("finish",job["id"],job["lease"],{"version":"document-v1","sha256":foreign["checksum"],"tables":[],
      "blocks":[{"locator":"page:1","text":"Private foreign content"}],"warnings":[],"coverage":{"complete":True}})
    before=snapshot()
    req=str(uuid.uuid4())
    r=sources("start",pid,rid=req)["review"]
    assert sources("start",pid,rid=req)["review"]==r
    sources("start",pid,rid=str(uuid.uuid4()),error="SOURCE_DRAFT_ACTIVE")
    sources("get",rid=req,actor=102,error="SOURCE_NOT_FOUND")
    sources("start",pid,rid=req,actor=102,error="SOURCE_REQUEST_MISMATCH")
    docs=act("documents",r)["review"]["documents"]
    assert any(x["id"]==source_doc for x in docs)
    assert all(x["id"]!=foreign["id"] for x in docs)
    act("choose",r,{"document_id":foreign["id"]},error="SOURCE_DOCUMENT_NOT_FOUND")
    act("choose",r,{},error="SOURCE_BAD_INPUT")
    r=act("choose",r,{"document_id":source_doc})["review"]
    sources("documents",rid=req,rev=r["revision"]-1,error="SOURCE_STALE_BUTTON")
    act("preview",r,error="SOURCE_NOT_READY")
    r=act("kind",r,{"kind":"supplier"})["review"]
    r=act("preview",r)["review"]
    assert r["can_confirm"] and r["source_kind"]=="supplier"
    assert sql("SELECT count(*) FROM product_document_sources")=="0"
    # Audit failure must roll back the source and its receipt together.
    sql("""CREATE FUNCTION public.qa_source_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='product_source_confirm' THEN RAISE EXCEPTION 'QA_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_source_audit_failure BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION public.qa_source_audit_failure();""")
    act("confirm",r,error="QA_AUDIT_FAILURE")
    assert sql("SELECT count(*) FROM product_document_sources")=="0"
    assert sources("get",rid=req)["review"]==r
    sql("DROP TRIGGER qa_source_audit_failure ON staff_audit_log; DROP FUNCTION qa_source_audit_failure()")
    # Parallel confirmations all read one immutable receipt.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(lambda _:act("confirm",r),range(8)))
    saved=results[0]["review"]
    assert all(x["review"]==saved for x in results)
    assert saved["phase"]=="confirmed" and saved["usable"]
    assert sql("SELECT count(*) FROM product_document_sources")=="1"
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='product_source_confirm'")=="1"
    assert snapshot()==before,"SOURCE_FLOW_CHANGED_EXISTING_DATA"
    command(["docker","restart",NAME]);ready()
    assert act("confirm",r)["review"]==saved
    assert sources("home",pid)["sources"][0]["usable"]
    assert sources("home",pid,actor=102)["sources"]==[]
    duplicate=prepared(pid,source_doc)
    act("confirm",duplicate,error="SOURCE_ALREADY_CONFIRMED")
    act("cancel",duplicate)
    off=act("withdraw_prepare",saved)["review"]
    kept=act("withdraw_cancel",off)["review"]
    assert kept["usable"]
    off=act("withdraw_prepare",kept)["review"]
    gone=act("withdraw",off)["review"]
    assert gone["phase"]=="withdrawn" and not gone["usable"]
    assert act("withdraw",off)["review"]==gone
    assert act("confirm",r)["review"]==gone
    second=prepared(pid,source_doc)
    second_saved=act("confirm",second)["review"]
    assert second_saved["source_id"]!=saved["source_id"]
    assert act("confirm",r)["review"]["phase"]=="withdrawn"
    # Old source receipt cannot restore a model selection after it was withdrawn.
    clearing=choice("prepare_clear",pid,request=str(uuid.uuid4()))
    confirm_choice(clearing)
    stale=sources("get",rid=second["id"])["review"]
    assert not stale["model_matches"] and not stale["usable"]
    assert not act("confirm",second)["review"]["usable"]
    # Withdrawal remains possible even when the model changed.
    act("withdraw",act("withdraw_prepare",stale)["review"])
    confirm_choice(prepare(pid,b))
    third=prepared(pid,source_doc)
    sql("UPDATE product_source_reviews SET preview_expires_at=now()-interval '1 second' WHERE id="+lit(third["id"]))
    assert not sources("get",rid=third["id"])["review"]["can_confirm"]
    act("confirm",third,error="SOURCE_PREVIEW_EXPIRED")
    draft=act("edit",third)["review"]
    sql("UPDATE product_source_reviews SET expires_at=now()-interval '1 second' WHERE id="+lit(draft["id"]))
    assert sources("get",rid=draft["id"])["review"]["phase"]=="expired"
    act("preview",draft,error="SOURCE_EXPIRED")
    fourth=prepared(pid,source_doc)
    sql("UPDATE products SET title=title||' changed' WHERE id="+lit(pid))
    act("confirm",fourth,error="SOURCE_MODEL_CHANGED")
    act("cancel",fourth)
    assert sql("SELECT count(*) FROM product_source_reviews WHERE phase IN('draft','preview','withdraw_preview')")=="0"
    print(json.dumps({"ok":True,"migration_sha256":hashlib.sha256(migration.encode()).hexdigest(),
      "checks":["private_grants","actor_owned_documents","selected_model","CAS","explicit_preview",
        "audit_atomicity","parallel_confirm_once","restart_receipt","withdrawal_no_resurrection",
        "duplicate_source","model_staleness","expiry","all_existing_tables_preserved"]}))
finally:
    if created:subprocess.run(["docker","rm","-f",NAME],capture_output=True)
