#!/usr/bin/env python3
"""Real isolated PostgreSQL: human model identity, stale source, receipts and prompt isolation."""
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
NAME="mw-document-return-qa-"+uuid.uuid4().hex[:12]
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
    f=upload((json.dumps(rows)+"\nFixture: "+uuid.uuid4().hex).encode())
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
created=False
try:
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
             "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0031"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    spec=importlib.util.spec_from_file_location("migration",ROOT/"ops/dev/apply-document-import-return.py")
    migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
    assert json.loads(sql(migration.BASELINE_SQL))==migration.EXPECTED
    text=(ROOT/migration.PATH).read_text()
    sql(migration.transaction(text,{"bot_catalog_import":"wrong"}),"DOCUMENT_BASELINE")
    sql(migration.transaction(text,migration.EXPECTED))
    sql(migration.transaction(text,migration.EXPECTED),"DOCUMENT_ALREADY_APPLIED")
    def batch(rows, model_name=None):
        f,r=document(rows)
        for n in range(len(rows)):r=review("approve",r["id"],r["revision"],row=n)
        if model_name:confirm(r["id"],name=model_name)
        b=catalog("get",review("handoff",r["id"],r["revision"])["import_id"])
        return f,review("get",r["id"]),preview(b,rows)
    def begin_return(b):
        return catalog("return_prepare",b["id"],b["revision"])
    def finish_return(p, **kwargs):
        return catalog("return_confirm",p["id"],p["revision"],
            {"review_revision":p["document_review_revision"]},**kwargs)
    def fingerprint(table):
        return sql("SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')::text) FROM "+table+" t")
    originals=lambda:fingerprint("document_intakes")
    rows=[["RETURN-A","Training A","10"],["RETURN-B","Training B","20"]]
    f,r,b=batch(rows,"MODEL-220")
    immutable=originals();source=catalog("source",b["id"])["source"]
    frozen_models=fingerprint("document_import_model_links")
    products=fingerprint("products");costs=fingerprint("product_costs")
    for role in ["anon","authenticated","service_role"]:
        sql("SET ROLE "+role+"; SELECT * FROM document_import_returns","permission denied")
        sql("SET ROLE "+role+"; SELECT mw_private.bot_catalog_import_conflicts(101,'get',"+lit(b["id"])+")","permission denied")
    begin=begin_return(b)
    assert begin["document_return_prepare"] and begin["document_can_return"]
    assert review("get",r["id"])["import_id"]==b["id"]
    finish_return(begin,actor=103,error="IMPORT_DENIED")
    finish_return(begin,actor=102,error="IMPORT_NOT_FOUND")
    catalog("return_confirm",b["id"],b["revision"],{},error="IMPORT_BAD_INPUT")
    catalog("return_confirm",b["id"],b["revision"],{"review_revision":r["revision"]-1},error="IMPORT_STALE")
    # Preparing a return is read-only; an active model question must be resolved first.
    m=model("start",r["id"],model("get",r["id"])["revision"])
    finish_return(begin,error="IMPORT_RETURN_INPUT_ACTIVE")
    model("cancel",r["id"],m["revision"])
    confirm(r["id"]); b=preview(b,rows);begin=begin_return(b)
    frozen_models=fingerprint("document_import_model_links")
    # Force a failure after cancellation: no partial return or receipt may survive.
    sql("CREATE FUNCTION mw_private.fail_return() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='document_import_return' THEN RAISE EXCEPTION 'TEST_RETURN_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_return_failure BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION mw_private.fail_return();")
    finish_return(begin,error="TEST_RETURN_FAILURE")
    assert catalog("get",b["id"])["state"]=="preview"
    assert review("get",r["id"])["import_id"]==b["id"]
    assert sql("SELECT count(*) FROM document_import_returns")=="0"
    sql("DROP TRIGGER test_return_failure ON staff_audit_log; DROP FUNCTION mw_private.fail_return()")
    # Concurrent duplicate confirmation produces one receipt/audit, preserving evidence.
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(lambda _:finish_return(begin),range(4)))
    assert all(x["document_returned"] and x["state"]=="canceled" for x in results)
    assert all(x["document_return_review"]["import_id"] is None for x in results)
    assert sql("SELECT count(*) FROM document_import_returns")=="1"
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='document_import_return'")=="1"
    reopened=review("get",r["id"])
    assert reopened["import_id"] is None and reopened["legacy_import_id"] is None
    assert reopened["revision"]==begin["document_review_revision"]+1
    assert reopened["counts"]["approved"]==2
    assert model("get",r["id"])["usable"]
    assert originals()==immutable and fingerprint("document_import_model_links")==frozen_models
    assert fingerprint("products")==products and fingerprint("product_costs")==costs
    assert json.loads(sql("SELECT source FROM catalog_imports WHERE id="+lit(b["id"])))==source
    # A changed SKU invalidates only that row and its model; the next handoff requires review.
    edited=review("edit",r["id"],reopened["revision"],col=0)
    review("bind",r["id"],edited["revision"],col=0,payload={"message_id":200})
    edited=review("save",r["id"],edited["revision"],col=0,payload={"reply_to":200,"value":"RETURN-C"})
    assert edited["counts"]["pending"]==1 and edited["counts"]["approved"]==1
    assert not model("get",r["id"])["usable"]
    review("handoff",r["id"],edited["revision"],error="DOCUMENT_UNREVIEWED")
    approved=review("approve",r["id"],edited["revision"])
    next_id=review("handoff",r["id"],approved["revision"])["import_id"]
    assert next_id!=b["id"]
    assert catalog("get",next_id)["state"]=="config"
    assert catalog("source",next_id)["source"]["rows"][0][0]=="RETURN-C"
    # Old receipt cannot cancel/unfreeze a later import, including after restart.
    command(["docker","restart",NAME]);ready()
    finish_return(begin)
    assert review("get",r["id"])["import_id"]==next_id
    assert catalog("get",next_id)["state"]=="config"
    assert catalog("get",b["id"])["document_returned"]
    catalog("apply",b["id"],b["revision"],error="IMPORT_CLOSED")
    assert fingerprint("products")==products
    assert json.loads(sql("SELECT source FROM catalog_imports WHERE id="+lit(b["id"])))==source
    assert originals()==immutable
    # Expired or explicitly canceled previews can return; applied/undone ones cannot.
    f2,r2,b2=batch([["EXPIRED","Training","10"]])
    sql("UPDATE catalog_imports SET expires_at=now()-interval '1 minute' WHERE id="+lit(b2["id"]))
    finish_return(begin_return(b2))
    f3,r3,b3=batch([["CANCELED","Training","10"]])
    catalog("cancel",b3["id"])
    finish_return(begin_return(b3))
    f4,r4,b4=batch([["APPLIED","Training","10"]])
    prepared4=begin_return(b4)
    catalog("apply",b4["id"],b4["revision"])
    finish_return(prepared4,error="IMPORT_RETURN_UNAVAILABLE")
    catalog("return_prepare",b4["id"],b4["revision"],error="IMPORT_RETURN_UNAVAILABLE")
    catalog("undo_preview",b4["id"]);catalog("undo",b4["id"])
    finish_return(prepared4,error="IMPORT_RETURN_UNAVAILABLE")
    # Direct CSV imports do not pretend to have a correctable document.
    direct=catalog("upload",payload={"request_key":"8888888","checksum":"a"*64,"file_name":"direct.csv",
        "source":{"header":["sku","title","price"],"rows":[["DIRECT","Training","10"]]},
        "mapping":{"sku":0,"title":1,"price":2,"brand":-1,"cost_price":-1,"in_stock":-1,"stock_qty":-1,"category_slug":-1}})
    catalog("return_prepare",direct["id"],direct["revision"],error="IMPORT_RETURN_UNAVAILABLE")
    # An outdated preparation must not silently cancel a newly refreshed preview.
    f5,r5,b5=batch([["STALE","Training","10"]])
    p5=begin_return(b5)
    b5=preview(b5,[["STALE","Training","10"]])
    finish_return(p5,error="IMPORT_STALE")
    assert catalog("get",b5["id"])["state"]=="preview"
    # Apply and return race: exactly one result wins, with no partial mutation.
    for n in range(4):
        f6,r6,b6=batch([["RACE-"+str(n),"Training","10"]])
        p6=begin_return(b6)
        def race(op):
            try:
                return ("ok",finish_return(p6) if op=="return" else catalog("apply",b6["id"],b6["revision"]))
            except RuntimeError as error:return ("error",str(error))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(race,["return","apply"]))
        current=catalog("get",b6["id"])
        count=sql("SELECT count(*) FROM products WHERE sku="+lit("RACE-"+str(n)))
        pointer=review("get",r6["id"])["import_id"]
        if current["state"]=="applied":
            assert count=="1" and pointer==b6["id"] and outcomes[0][0]=="error"
        else:
            assert current["state"]=="canceled" and count=="0" and pointer is None
    print(json.dumps({"ok":True,"checks":["prepare read-only","exact revisions","permissions","atomic rollback",
       "concurrent duplicate","original and frozen source preserved","model invalidation","new human review",
       "old receipt after new handoff/restart","expired/canceled recovery","applied/undone denied",
       "direct CSV denied","apply/return race"],"live_data_touched":False}))
finally:
    if created:subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
