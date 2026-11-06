#!/usr/bin/env python3
"""Real isolated PostgreSQL: private originals, duplicate receipts, worker leases and safe import handoff."""
import base64
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import time
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[2]
NAME="mw-intake-qa-"+uuid.uuid4().hex[:12]
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
created=False
try:
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
        "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"]);created=True
    for _ in range(100):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.2)
    else: raise RuntimeError("PG_NOT_READY")
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
        *sorted((ROOT/"docs/migrations").glob("*.sql"))]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    spec=importlib.util.spec_from_file_location("migration",ROOT/"ops/dev/apply-document-intake.py")
    migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
    assert json.loads(sql(migration.BASELINE_SQL))==migration.EXPECTED,"Baseline must match migrations built from source, not just live state"
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false);")
    # Enrollment is audited and duplicate requests return the first result.
    enroll="SET ROLE service_role; SELECT bot_enroll_sellers(101,'qa:enroll',ARRAY[201,202]::bigint[]);"
    assert sql(enroll)==sql(enroll)
    assert sql("SELECT count(*) FROM staff WHERE telegram_id IN(201,202) AND role='seller' AND NOT elevated AND active")=="2"
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='staff_enroll_sellers'")=="1"
    sql("SET ROLE service_role; SELECT bot_enroll_sellers(103,'qa:no',ARRAY[203]::bigint[])","STAFF_DENIED")
    sql("SET ROLE service_role; SELECT bot_enroll_sellers(101,'qa:bad',ARRAY[102]::bigint[])","STAFF_EXISTING_REVIEW")
    sql("SET ROLE service_role; SELECT bot_enroll_sellers(101,'qa:enroll',ARRAY[203]::bigint[])","STAFF_REQUEST_CONFLICT")
    for role in ("anon","authenticated","service_role"):
        sql(f"SET ROLE {role}; SELECT original FROM document_intakes","permission denied")
    rpc("home",103,error="DOCUMENT_DENIED")
    first=upload();assert upload()["id"]==first["id"]
    assert upload(actor=102)["id"]!=first["id"]
    rpc("get",102,first["id"],error="DOCUMENT_NOT_FOUND")
    claim=worker("claim");assert claim["id"]==first["id"]
    assert hashlib.sha256(base64.b64decode(claim["base64"])).hexdigest()==first["checksum"]
    worker("finish",claim["id"],str(uuid.uuid4()),{},error="DOCUMENT_LEASE")
    content={"version":"document-v1","sha256":first["checksum"],"tables":[{
        "label":"Training","header":["sku","title","price"],"rows":[["DEV-ONLY","Training","10"]],
        "row_locators":["sheet:1/row:2"]}],"blocks":[],"warnings":[],"coverage":{"complete":True}}
    worker("finish",claim["id"],claim["lease"],{**content,"version":None},error="DOCUMENT_RESULT")
    worker("finish",claim["id"],claim["lease"],content)
    worker("finish",claim["id"],claim["lease"],content,error="DOCUMENT_LEASE")
    assert rpc("get",id=first["id"])["state"]=="review"
    linked=rpc("table",id=first["id"],payload={"index":0})
    assert linked["state"]=="config"
    assert rpc("table",id=first["id"],payload={"index":0})["id"]==linked["id"]
    assert sql("SELECT count(*) FROM products")=="0"
    assert sql("SELECT count(*) FROM catalog_imports")=="1"
    assert sql("SELECT count(*) FROM document_import_links")=="1"
    # Restart retains both the original and the one import link.
    command(["docker","restart",NAME])
    for _ in range(100):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.2)
    else: raise RuntimeError("PG_NOT_READY")
    assert rpc("table",id=first["id"],payload={"index":0})["id"]==linked["id"]
    second=worker("claim")
    assert second["id"]!=claim["id"]
    rpc("cancel",102,second["id"])
    worker("finish",second["id"],second["lease"],content,error="DOCUMENT_LEASE")
    third=upload(b"different")
    thirdclaim=worker("claim");assert thirdclaim["id"]==third["id"]
    sql("UPDATE document_intakes SET leased_at=now()-interval '11 minutes' WHERE id="+lit(third["id"]))
    assert worker("claim")["idle"]
    assert rpc("get",id=third["id"])["state"]=="failed"
    assert upload(b"different")["state"]=="failed"
    assert sql("SELECT count(*) FROM shop_orders")=="0"
    print("PASS: private originals, seller denial, enrollment replay, duplicate files, lease/cancel/restart, one import handoff, no catalog/order mutations")
finally:
    if created: subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
