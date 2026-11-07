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
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0030"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    def batch(rows, name=None):
        f,r=document(rows)
        for n in range(len(rows)):r=review("approve",r["id"],r["revision"],row=n)
        if name:
            for n in range(len(rows)):confirm(r["id"],row=n,name=name)
        b=catalog("get",review("handoff",r["id"],r["revision"])["import_id"])
        return f,r,preview(b,rows)
    rows=[["C","Training","10"]]
    f1,r1,b1=batch(rows,"MODEL-220")
    catalog("apply",b1["id"],b1["revision"])
    pid=sql("SELECT id FROM products WHERE sku='C'")
    f2,r2,b2=batch(rows,"MODEL-380")
    spec=importlib.util.spec_from_file_location("migration",ROOT/"ops/dev/apply-document-model-conflicts.py")
    migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
    assert json.loads(sql(migration.BASELINE_SQL))==migration.EXPECTED
    sql(migration.transaction((ROOT/migration.PATH).read_text(),migration.EXPECTED))
    sql(migration.transaction((ROOT/migration.PATH).read_text(),migration.EXPECTED),"DOCUMENT_ALREADY_APPLIED")
    catalog("apply",b2["id"],b2["revision"],error="IMPORT_MODEL_COMPARISON_REQUIRED")
    for role in ["anon","authenticated","service_role"]:
        for table in ["document_import_model_comparisons","document_import_model_resolutions"]:
            sql("SET ROLE "+role+"; SELECT * FROM "+table,"permission denied")
    sql("SET ROLE service_role; SELECT mw_private.bot_catalog_import_models(101,'get',"+lit(b2["id"])+")","permission denied")
    b2=preview(b2,rows)
    assert b2["model_blocked"]==1 and b2["items"][0]["model_conflict"]
    before=sql("SELECT to_jsonb(p) FROM products p WHERE id="+lit(pid))
    catalog("apply",b2["id"],b2["revision"],error="IMPORT_MODEL_CONFLICT")
    catalog("model_accept",b2["id"],b2["revision"],{"line":2},actor=103,error="IMPORT_DENIED")
    catalog("model_compare",b2["id"],b2["revision"],{"line":2},actor=102,error="IMPORT_NOT_FOUND")
    comp=catalog("model_compare",b2["id"],b2["revision"],{"line":2})["model_comparison"]
    assert comp["previous"][0]["model"]=="MODEL-220" and comp["incoming"]["model"]=="MODEL-380"
    assert not comp["accepted"]
    accepted=catalog("model_accept",b2["id"],b2["revision"],{"line":2})
    assert accepted["model_blocked"]==0
    catalog("model_accept",b2["id"],b2["revision"],{"line":2})
    assert sql("SELECT count(*) FROM document_import_model_resolutions")=="1"
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='catalog_import_model_resolution'")=="1"
    assert sql("SELECT to_jsonb(p) FROM products p WHERE id="+lit(pid))==before
    old_revision=b2["revision"]
    b2=preview(b2,rows)
    assert b2["model_blocked"]==1
    catalog("model_accept",b2["id"],old_revision,{"line":2},error="IMPORT_STALE")
    catalog("apply",b2["id"],b2["revision"],error="IMPORT_MODEL_CONFLICT")
    catalog("model_accept",b2["id"],b2["revision"],{"line":2})
    # Unknown incoming model cannot discard the conflicting old evidence.
    model("uncertain",r2["id"],model("get",r2["id"])["revision"])
    catalog("apply",b2["id"],b2["revision"],error="IMPORT_MODEL_CHANGED")
    b2=preview(b2,rows)
    assert b2["model_blocked"]==1
    catalog("model_accept",b2["id"],b2["revision"],{"line":2},error="IMPORT_MODEL_IDENTITY_REQUIRED")
    confirm(r2["id"],name="MODEL-380");b2=preview(b2,rows)
    catalog("model_accept",b2["id"],b2["revision"],{"line":2})
    # A second source added after preview invalidates the exact evidence decision.
    f3,r3,b3=batch(rows,"MODEL-220")
    assert b3["model_blocked"]==0
    catalog("apply",b3["id"],b3["revision"])
    catalog("apply",b2["id"],b2["revision"],error="IMPORT_MODEL_EVIDENCE_CHANGED")
    catalog("model_accept",b2["id"],b2["revision"],{"line":2},error="IMPORT_MODEL_EVIDENCE_CHANGED")
    assert catalog("get",b2["id"])["model_blocked"]==1
    b2=preview(b2,rows);catalog("model_accept",b2["id"],b2["revision"],{"line":2})
    catalog("apply",b2["id"],b2["revision"]);catalog("apply",b2["id"],b2["revision"])
    assert links(pid)["conflicting"]
    assert sql("SELECT to_jsonb(p) FROM products p WHERE id="+lit(pid))==before
    # Undo retains the human receipt and drops that batch from future comparisons.
    receipts=sql("SELECT count(*) FROM document_import_model_resolutions")
    catalog("undo_preview",b2["id"]);catalog("undo",b2["id"])
    assert sql("SELECT count(*) FROM document_import_model_resolutions")==receipts
    f4,r4,b4=batch(rows,"MODEL-220")
    assert b4["model_blocked"]==0
    # Cross-owner sources participate without exposing private files or download links.
    sql("UPDATE catalog_imports SET staff_telegram_id=102 WHERE id IN("+lit(b1["id"])+","+lit(b3["id"])+")")
    f5,r5,b5=batch(rows,"MODEL-380")
    assert b5["model_blocked"]==1
    compare=catalog("model_compare",b5["id"],b5["revision"],{"line":2})["model_comparison"]
    assert len(compare["previous"])==1 and compare["previous"][0]["model"]=="MODEL-220"
    assert "file_name" not in json.dumps(compare) and "document_id" not in json.dumps(compare)
    # Cancel is a safe exit; neither new price nor identity is applied.
    catalog("cancel",b5["id"])
    catalog("model_accept",b5["id"],b5["revision"],{"line":2},error="IMPORT_CLOSED")
    assert sql("SELECT to_jsonb(p) FROM products p WHERE id="+lit(pid))==before
    # Concurrent imports cannot both rely on the absence of previous model evidence.
    sql("INSERT INTO products(slug,sku,title,price,status,assortment_decision) VALUES ('parallel','P','Parallel',10,'hidden','excluded')")
    parallel_rows=[["P","Parallel","10"]]
    _,_,pa=batch(parallel_rows,"P-220")
    _,_,pb=batch(parallel_rows,"P-380")
    def apply_parallel(b):
        try:
            return catalog("apply",b["id"],b["revision"])["state"]
        except RuntimeError as error:
            assert "IMPORT_MODEL_EVIDENCE_CHANGED" in str(error),str(error)
            return "blocked"
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes=list(pool.map(apply_parallel,[pa,pb]))
    assert sorted(outcomes)==["applied","blocked"],outcomes
    assert sql("SELECT status::text||':'||assortment_decision::text FROM products WHERE sku='P'")=="hidden:excluded"
    digest=sql("SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY id)::text) FROM document_import_model_resolutions q")
    sql("CREATE DATABASE model_restore")
    dump=subprocess.check_output(["docker","exec",NAME,"pg_dump","-U","postgres","-d","postgres","-Fc"])
    subprocess.run(["docker","exec","-i",NAME,"pg_restore","-U","postgres","-d","model_restore","--exit-on-error","--single-transaction"],input=dump,check=True,capture_output=True)
    command(["docker","restart",NAME]);ready()
    restored=command(["docker","exec",NAME,"psql","-U","postgres","-d","model_restore","-Atq","-c","SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY id)::text) FROM document_import_model_resolutions q"]).stdout.strip()
    assert restored==digest
    for table in ["shop_orders","order_notifications"]:
        assert sql("SELECT count(*) FROM "+table)=="0"
    print(json.dumps({"ok":True,"conflictBlocked":True,"explicitDecision":True,"unknownBlocked":True,
      "newEvidenceInvalidates":True,"concurrentApply":True,"crossOwnerComparison":True,"duplicateDecision":True,"undoKeepsHistory":True,"restoreRestart":True}))
finally:
    if created:subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
