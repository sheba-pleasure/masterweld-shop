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

created=False
try:
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
             "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
      *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0032"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false),(104,'Director','director',false),(105,'Elevated','director',true)")
    pid,b,r=imported("MODEL-220")
    before=fingerprint()
    migration=(ROOT/"docs/migrations/0033_product_model_choice.sql").read_text()
    spec=importlib.util.spec_from_file_location("choice_migration",ROOT/"ops/dev/apply-product-model-choice.py")
    guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
    sql(guard.transaction(migration,{}),error="MODEL_CHOICE_BASELINE")
    sql(guard.transaction(migration+"\nUPDATE products SET title='UNEXPECTED';"),error="MODEL_CHOICE_EXISTING_DATA_CHANGED")
    assert fingerprint()==before
    assert sql("SELECT to_regclass('public.product_model_choices') IS NULL")=="t"
    sql(guard.transaction(migration+"\nGRANT SELECT ON product_model_choices TO authenticated;"),error="MODEL_CHOICE_PRIVILEGES")
    assert sql("SELECT to_regclass('public.product_model_choices') IS NULL")=="t"
    sql(guard.transaction(migration))
    sql(guard.transaction(migration),error="MODEL_CHOICE_SCHEMA_REVIEW")
    assert fingerprint()==before
    assert sql("SELECT count(*) FROM product_model_choices")=="0"
    sql("BEGIN;"+migration+"COMMIT;",error="already exists")
    for role in ["anon","authenticated","service_role"]:
        for table in ["product_model_choices","product_model_selection"]:
            sql("SET ROLE "+role+"; SELECT * FROM "+table,error="permission denied")
        if role!="service_role":
            sql("SET ROLE "+role+"; SELECT bot_product_model_choice(101,'get',"+lit(pid)+")",error="permission denied")
        for fn,args in [("product_model_row_snapshot",lit(r["id"])+",0"),
                        ("product_model_choice_evidence",lit(pid)),("product_model_choice_current",lit(pid))]:
            sql("SET ROLE "+role+"; SELECT mw_private."+fn+"("+args+")",error="permission denied")
    for actor in [999,103,104]:
        choice("get",pid,actor=actor,error="MODEL_CHOICE_DENIED")
    assert choice("get",pid,actor=105)["current"]["state"]=="unselected"
    choice("prepare",pid,b["id"],2,str(uuid.uuid4()),actor=102,error="MODEL_CHOICE_SOURCE_NOT_FOUND")
    p=prepare(pid,b);req=p["request"]["id"]
    assert p["request"]["state"]=="prepared" and p["current"]["state"]=="unselected"
    assert prepare(pid,b,request=req)["request"]["id"]==req
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='product_model_choice_prepare'")=="1"
    choice("read",request=req,actor=102,error="MODEL_CHOICE_NOT_FOUND")
    choice("prepare",pid,b["id"],3,req,error="MODEL_CHOICE_SOURCE_NOT_FOUND")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        outcomes=list(pool.map(lambda _:confirm_choice(p),range(4)))
    assert all(v["current"]["revision"]==1 and v["current"]["usable"] for v in outcomes)
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='product_model_choice_confirm'")=="1"
    assert fingerprint()==before
    # Current identity is shared with authorized reviewers; another owner's source files are not.
    shared=choice("get",pid,actor=102)
    assert shared["current"]["identity"]["model"]=="MODEL-220"
    assert shared["request"] is None and "file_name" not in json.dumps(shared)
    sql("UPDATE products SET price=12,in_stock=true WHERE id="+lit(pid))
    assert choice("get",pid)["current"]["usable"]
    sql("UPDATE products SET assortment_decision='excluded',status='hidden' WHERE id="+lit(pid))
    assert choice("get",pid)["current"]["state"]=="excluded"
    choice("prepare",pid,b["id"],2,str(uuid.uuid4()),error="MODEL_CHOICE_SOURCE_REVIEW")
    sql("UPDATE products SET assortment_decision='review' WHERE id="+lit(pid))
    sql("UPDATE products SET title='Changed identity' WHERE id="+lit(pid))
    assert choice("get",pid)["current"]["state"]=="stale"
    sql("UPDATE products SET title='Training device',price=10 WHERE id="+lit(pid))
    # A new conflicting source invalidates the earlier decision and requires a fresh preview.
    same_pid,b2,r2=imported("MODEL-380")
    assert same_pid==pid and choice("get",pid)["current"]["state"]=="stale"
    p2=prepare(pid,b2)
    assert p2["request"]["other_models"]==1
    competing=prepare(pid,b)
    selected=confirm_choice(p2)
    assert selected["current"]["identity"]["model"]=="MODEL-380" and selected["current"]["revision"]==2
    confirm_choice(competing,error="MODEL_CHOICE_STALE")
    assert confirm_choice(p)["current"]["choice_id"]==p2["request"]["id"]
    assert choice("cancel",request=req)["current"]["choice_id"]==p2["request"]["id"]
    # Expiry/cancellation and a failed audit cannot mutate the selected model.
    expired=prepare(pid,b)
    sql("UPDATE product_model_choices SET expires_at=now()-interval '1 second' WHERE id="+lit(expired["request"]["id"]))
    assert choice("read",request=expired["request"]["id"])["request"]["state"]=="expired"
    confirm_choice(expired,error="MODEL_CHOICE_EXPIRED")
    canceled=prepare(pid,b)
    choice("cancel",request=canceled["request"]["id"])
    confirm_choice(canceled,error="MODEL_CHOICE_CANCELED")
    pending=prepare(pid,b)
    sql("""CREATE FUNCTION test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='product_model_choice_confirm' THEN RAISE EXCEPTION 'TEST_CHOICE_AUDIT'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_audit BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION test_audit_failure();""")
    confirm_choice(pending,error="TEST_CHOICE_AUDIT")
    assert choice("read",request=pending["request"]["id"])["request"]["state"]=="prepared"
    assert choice("get",pid)["current"]["choice_id"]==p2["request"]["id"]
    sql("DROP TRIGGER test_audit ON staff_audit_log; DROP FUNCTION test_audit_failure()")
    # Changed model evidence cannot be confirmed from an old prepared choice.
    m=model("get",r2["id"]);model("start",r2["id"],m["revision"])
    assert choice("get",pid)["current"]["state"]=="stale"
    confirm_choice(pending,error="MODEL_CHOICE_STALE")
    model("cancel",r2["id"],model("get",r2["id"])["revision"])
    # Explicit withdrawal also has a preview and one durable result.
    clear=choice("prepare_clear",pid,request=str(uuid.uuid4()))
    assert clear["request"]["state"]=="prepared"
    cleared=confirm_choice(clear)
    assert cleared["current"]["state"]=="withdrawn" and not cleared["current"]["usable"]
    assert confirm_choice(p2)["current"]["state"]=="withdrawn"
    assert confirm_choice(clear)["current"]["revision"]==3
    choice("prepare_clear",pid,request=str(uuid.uuid4()),error="MODEL_CHOICE_ALREADY_EMPTY")
    # Source undo makes the last choice unusable; it never chooses another source automatically.
    p3=prepare(pid,b)
    confirm_choice(p3)
    catalog("undo_preview",b2["id"]);catalog("undo",b2["id"])
    assert choice("get",pid)["current"]["state"]=="stale"
    command(["docker","restart",NAME]);ready()
    recovered=confirm_choice(p3)
    assert recovered["request"]["state"]=="confirmed" and not recovered["current"]["usable"]
    # Two different prepared decisions race: one wins, one must be reviewed again.
    left=prepare(pid,b);right=prepare(pid,b)
    def race(v):
        try:return confirm_choice(v)
        except RuntimeError as exc:
            assert "MODEL_CHOICE_STALE" in str(exc)
            return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(race,[left,right]))
    assert sum(x is not None for x in results)==1
    # An active question must be finished before a new choice or confirmation.
    waiting=prepare(pid,b)
    _,question=document([["QUESTION","Training question","1"]])
    question=review("edit",question["id"],question["revision"],col=2)
    choice("prepare",pid,b["id"],2,str(uuid.uuid4()),error="MODEL_CHOICE_INPUT_ACTIVE")
    confirm_choice(waiting,error="MODEL_CHOICE_INPUT_ACTIVE")
    review("cancel",question["id"],question["revision"])
    confirm_choice(waiting)
    sql("UPDATE staff SET active=false WHERE telegram_id=101")
    choice("read",request=p3["request"]["id"],error="MODEL_CHOICE_DENIED")
    print(json.dumps({"ok":True,"privateTables":True,"humanChoice":True,"parallelReceipts":4,
      "changedEvidenceBlocked":True,"oldConfirmCannotRestore":True,"auditAtomic":True,
      "pricesDoNotChangeIdentity":True,"explicitWithdrawal":True,"restartRecovery":True}))
finally:
    if created:subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
