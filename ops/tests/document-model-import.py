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
NAME="mw-model-import-qa-"+uuid.uuid4().hex[:12]
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
created=False
try:
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
             "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0029"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    sql("INSERT INTO products(slug,sku,title,price,status,assortment_decision) VALUES ('excluded','B','Excluded',5,'hidden','excluded'),('unchanged','C','Unchanged',10,'published','sell')")
    rows=[["A","New model","10"],["SKIP","Skipped","1"],["B","Excluded","10"],["C","Unchanged","10"],["D","Unknown model","10"]]
    f,r=document(rows);rid=r["id"]
    original=sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id="+lit(f["id"]))
    for row in range(5):
        r=review("exclude" if row==1 else "approve",rid,r["revision"],row=row)
    for row in [0,2,3]:confirm(rid,row)
    b=catalog("get",review("handoff",rid,r["revision"])["import_id"])
    kept=[rows[i] for i in [0,2,3,4]]
    b=preview(b,kept)
    spec=importlib.util.spec_from_file_location("migration",ROOT/"ops/dev/apply-document-model-import.py")
    migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
    assert json.loads(sql(migration.BASELINE_SQL))==migration.EXPECTED
    sql(migration.transaction((ROOT/migration.PATH).read_text(),migration.EXPECTED))
    sql(migration.transaction((ROOT/migration.PATH).read_text(),migration.EXPECTED),"DOCUMENT_ALREADY_APPLIED")
    catalog("apply",b["id"],b["revision"],error="IMPORT_MODEL_PREVIEW_REQUIRED")
    for role in ["anon","authenticated","service_role"]:
        sql("SET ROLE "+role+"; SELECT * FROM document_import_model_links","permission denied")
    pid=sql("SELECT id FROM products WHERE sku='C'")
    links(pid,actor=103,error="IMPORT_DENIED")
    assert links(pid,actor=102)["items"]==[]
    sql("SET ROLE anon; SELECT bot_product_document_models(101,"+lit(pid)+")","permission denied")
    catalog("get",b["id"],actor=102,error="IMPORT_NOT_FOUND")
    b=preview(b,kept)
    assert b["model_count"]==3
    assert [x["document_model"]["row"] for x in b["items"]]==[0,2,3]
    assert sql("SELECT count(*) FROM document_import_model_links WHERE batch_id="+lit(b["id"]))=="4"
    m=model("get",rid);model("uncertain",rid,m["revision"])
    before=sql("SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM products p")
    catalog("apply",b["id"],b["revision"],error="IMPORT_MODEL_CHANGED")
    assert sql("SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM products p")==before
    confirm(rid)
    b=preview(b,kept)
    # A forged line/SKU cannot attach another document row's model.
    forged=normalized(kept);forged[0]["sku"]="OTHER"
    catalog("preview",b["id"],b["revision"],{"rows":forged},error="IMPORT_MODEL_SOURCE")
    b=catalog("apply",b["id"],b["revision"])
    assert b["state"]=="applied"
    assert catalog("apply",b["id"],b["revision"])["state"]=="applied"
    assert sql("SELECT count(*) FROM document_import_model_links WHERE product_id IS NOT NULL")=="4"
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='catalog_import_model_links_apply'")=="1"
    assert sql("SELECT status::text||':'||assortment_decision::text FROM products WHERE sku='B'")=="hidden:excluded"
    assert sql("SELECT status::text||':'||assortment_decision::text FROM products WHERE sku='A'")=="draft:review"
    assert sql("SELECT count(*) FROM products WHERE sku='SKIP'")=="0"
    assert links(pid)["items"][0]["state"]=="linked"
    excluded=sql("SELECT id FROM products WHERE sku='B'")
    assert links(excluded)["items"][0]["state"]=="excluded"
    assert links(excluded)["excluded"]
    # Undo keeps history and excludes new products; historical links are not current proof.
    catalog("undo_preview",b["id"]);catalog("undo",b["id"])
    assert links(pid)["items"][0]["state"]=="undone"
    assert sql("SELECT status::text||':'||assortment_decision::text FROM products WHERE sku='A'")=="hidden:excluded"
    assert sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id="+lit(f["id"]))==original
    # A completely unchanged product can receive provenance without inventing a price mutation.
    f2,r2=document([["C","Unchanged","10"]])
    r2=review("approve",r2["id"],r2["revision"]);confirm(r2["id"])
    b2=catalog("get",review("handoff",r2["id"],r2["revision"])["import_id"])
    b2=preview(b2,[["C","Unchanged","10"]])
    assert b2["counts"]["unchanged"]==1 and b2["model_count"]==1
    before=sql("SELECT to_jsonb(p) FROM products p WHERE id="+lit(pid))
    b2=catalog("apply",b2["id"],b2["revision"]);assert b2["state"]=="applied"
    assert sql("SELECT to_jsonb(p) FROM products p WHERE id="+lit(pid))==before
    assert links(pid)["items"][0]["state"]=="linked"
    # A different confirmed variant does not silently replace the first one.
    f3,r3=document([["C","Unchanged","10"],["Z","Skipped","1"]])
    r3=review("approve",r3["id"],r3["revision"]);r3=review("exclude",r3["id"],r3["revision"],row=1)
    confirm(r3["id"],name="MODEL-380")
    b3=catalog("get",review("handoff",r3["id"],r3["revision"])["import_id"])
    b3=preview(b3,[["C","Unchanged","10"]]);catalog("apply",b3["id"],b3["revision"])
    assert links(pid)["conflicting"]
    sql("UPDATE products SET title='Changed model' WHERE id="+lit(pid))
    assert links(pid)["items"][0]["state"]=="product_changed"
    # Full schema/data dump and restore keeps the exact links after restart.
    digest=sql("SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY batch_id,line)::text) FROM document_import_model_links q")
    sql("CREATE DATABASE model_restore")
    dump=subprocess.check_output(["docker","exec",NAME,"pg_dump","-U","postgres","-d","postgres","-Fc"])
    subprocess.run(["docker","exec","-i",NAME,"pg_restore","-U","postgres","-d","model_restore","--exit-on-error","--single-transaction"],input=dump,check=True,capture_output=True)
    command(["docker","restart",NAME]);ready()
    restored=command(["docker","exec",NAME,"psql","-U","postgres","-d","model_restore","-Atq","-c","SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY batch_id,line)::text) FROM document_import_model_links q"]).stdout.strip()
    assert restored==digest
    assert links(pid)["items"][0]["state"]=="product_changed"
    for table in ["shop_orders","order_notifications"]:
        assert sql("SELECT count(*) FROM "+table)=="0"
    print(json.dumps({"ok":True,"sourceRowsPreserved":True,"stalePreviewBlocked":True,"unchangedProductLink":True,
      "duplicateApply":True,"conflictsVisible":True,"undoPreservesExclusion":True,"restoreRestart":True,"originalUnchanged":True}))
finally:
    if created:subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
