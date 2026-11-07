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
NAME="mw-model-qa-"+uuid.uuid4().hex[:12]
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

created=False
try:
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
             "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
           *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0028"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    f=upload(b"model identity training")
    c=worker("claim")
    original={"version":"document-v1","sha256":f["checksum"],"tables":[{"label":"Training",
      "header":["sku","title","price"],"rows":[["A","Training 220","10"],["B","Training 380","20"]],
      "row_locators":["sheet:1/row:2","sheet:1/row:3"]}],"blocks":[],"warnings":[],"coverage":{"complete":True}}
    worker("finish",c["id"],c["lease"],original)
    r=review("open",f["id"]);rid=r["id"]
    before=sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id="+lit(f["id"]))
    spec=importlib.util.spec_from_file_location("migration",ROOT/"ops/dev/apply-document-model.py")
    migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
    assert json.loads(sql(migration.BASELINE_SQL))==migration.EXPECTED
    sql(migration.transaction((ROOT/migration.PATH).read_text(),migration.EXPECTED))
    sql(migration.transaction((ROOT/migration.PATH).read_text(),migration.EXPECTED),"DOCUMENT_ALREADY_APPLIED")
    assert sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id="+lit(f["id"]))==before
    for role in ("anon","authenticated","service_role"):
        for table in ("document_model_checks","document_model_decisions"):
            sql("SET ROLE "+role+"; SELECT * FROM "+table,"permission denied")
    sql("SET ROLE anon; SELECT bot_document_model(101,'get',"+lit(rid)+")","permission denied")
    sql("SET ROLE service_role; SELECT mw_private.bot_document_review(101,'get',"+lit(rid)+")","permission denied")
    model("get",rid,actor=103,error="DOCUMENT_MODEL_DENIED")
    model("get",rid,actor=102,error="DOCUMENT_NOT_FOUND")
    m=model("get",rid)
    assert m["revision"]==0 and not m["eligible"] and not m["usable"]
    assert sql("SELECT count(*) FROM document_model_checks")=="0"
    model("start",rid,0,error="DOCUMENT_MODEL_ROW_REVIEW")
    r=review("approve",rid,r["revision"])
    # An ordinary cell question cannot be replaced by the model editor.
    r=review("edit",rid,r["revision"],row=1,col=0)
    model("start",rid,0,error="DOCUMENT_INPUT_ACTIVE")
    r=review("cancel",rid,r["revision"],row=1)
    m=model("start",rid,0)
    assert m["focus"]==0 and m["prompt"]["kind"]=="model"
    review("edit",rid,r["revision"],col=0,error="DOCUMENT_MODEL_INPUT_ACTIVE")
    model("reply",rid,m["revision"],payload={"reply_to":100,"value":"Manufacturer"},error="DOCUMENT_MODEL_QUESTION")
    model("bind",rid,m["revision"],payload={"message_id":100})
    command(["docker","restart",NAME]);ready()
    model("reply",rid,m["revision"],payload={"reply_to":99,"value":"Wrong"},error="DOCUMENT_MODEL_QUESTION")
    # Expired questions cannot save; explicit restart renews only this model question.
    sql("UPDATE document_review_prompts SET expires_at=now()-interval '1 second' WHERE actor=101")
    model("reply",rid,m["revision"],payload={"reply_to":100,"value":"Late"},error="DOCUMENT_MODEL_QUESTION")
    model("resume",rid,m["revision"],error="DOCUMENT_MODEL_QUESTION")
    m=model("start",rid,m["revision"])
    model("bind",rid,m["revision"],payload={"message_id":100})
    oldrev=m["revision"]
    m=model("reply",rid,m["revision"],payload={"reply_to":100,"value":"Training manufacturer"})
    assert m["focus"]==1 and m["manufacturer"]=="Training manufacturer"
    model("reply",rid,oldrev,payload={"reply_to":100,"value":"Repeat"},error="DOCUMENT_MODEL_STALE")
    model("bind",rid,m["revision"],payload={"message_id":101})
    m=model("reply",rid,m["revision"],payload={"reply_to":101,"value":"MODEL-220"})
    assert m["focus"]==-1 and m["prompt"] is None and m["variant_mode"]=="unknown"
    model("confirm",rid,m["revision"],error="DOCUMENT_MODEL_INCOMPLETE")
    m=model("novar",rid,m["revision"]);confirmrev=m["revision"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        answers=list(pool.map(lambda _:model("confirm",rid,confirmrev),range(3)))
    assert len({x["revision"] for x in answers})==1
    m=answers[0];assert m["state"]=="confirmed" and m["usable"] and len(m["history"])==1
    assert sql("SELECT count(*) FROM document_model_decisions")=="1"
    # Changing the reviewed source makes its previous model unusable, even after reapproval.
    r=review("get",rid)
    r=review("edit",rid,r["revision"],col=1)
    review("bind",rid,r["revision"],col=1,payload={"message_id":110})
    r=review("save",rid,r["revision"],col=1,payload={"value":"Training 380","reply_to":110})
    r=review("approve",rid,r["revision"])
    changed=model("get",rid)
    assert changed["stale"] and not changed["usable"]
    assert not model("confirm",rid,confirmrev)["usable"]  # Receipt never overwrites newer source.
    model("askmodel",rid,m["revision"],error="DOCUMENT_MODEL_SOURCE_CHANGED")
    m=model("start",rid,m["revision"])
    assert m["manufacturer"]=="" and m["model"]=="" and m["variant_mode"]=="unknown"
    m=model("cancel",rid,m["revision"]);assert m["prompt"] is None
    m=model("uncertain",rid,m["revision"])
    assert m["state"]=="needs_review" and not m["usable"] and len(m["history"])==2
    assert model("confirm",rid,confirmrev)["state"]=="needs_review"
    sql("UPDATE document_review_rows SET retired=true WHERE review_id="+lit(rid)+" AND row_index=0")
    assert not model("get",rid)["eligible"]
    model("start",rid,m["revision"],error="DOCUMENT_MODEL_ROW_REVIEW")
    sql("UPDATE staff SET active=false WHERE telegram_id=101")
    model("get",rid,error="DOCUMENT_MODEL_DENIED")
    assert sql("SELECT md5(to_jsonb(d)::text) FROM document_intakes d WHERE id="+lit(f["id"]))==before
    for table in ("products","product_costs","shop_orders","order_notifications","catalog_imports"):
        assert sql("SELECT count(*) FROM "+table)=="0"
    print(json.dumps({"ok":True,"humanModelDecision":True,"duplicateConfirmation":True,
                     "changedSourceInvalidatesModel":True,"originalUnchanged":True,"restart":True,
                     "catalogUnchanged":True,"noImport":True}))
finally:
    if created:subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
