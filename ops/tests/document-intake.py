#!/usr/bin/env python3
"""Real isolated PostgreSQL: private originals, duplicate receipts, worker leases and safe import handoff."""
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
        *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4] <= "0026"]]
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
    # Completion before the confirmation wins: cancel must preserve the actual extraction.
    finished=rpc("get",id=first["id"])
    assert rpc("cancel",id=first["id"])==finished
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='document_cancel'")=="0"
    linked=rpc("table",id=first["id"],payload={"index":0})
    assert linked["state"]=="config"
    assert rpc("table",id=first["id"],payload={"index":0})["id"]==linked["id"]
    assert sql("SELECT count(*) FROM products")=="0"
    assert sql("SELECT count(*) FROM catalog_imports")=="1"
    assert sql("SELECT count(*) FROM document_import_links")=="1"
    # New review gate must also block the legacy unreviewed preview, without erasing it.
    sql((ROOT/"ops/dev/identity.sql").read_text())
    review_spec=importlib.util.spec_from_file_location("review_migration",ROOT/"ops/dev/apply-document-review.py")
    review_migration=importlib.util.module_from_spec(review_spec);review_spec.loader.exec_module(review_migration)
    sql(review_migration.transaction((ROOT/review_migration.PATH).read_text(),review_migration.EXPECTED))
    rpc("table",id=first["id"],payload={"index":0},error="DOCUMENT_REVIEW_REQUIRED")
    def review(op, rid=None, rev=None, row=0, col=None, payload=None, actor=101, error=None):
        args=[str(actor),lit(op),lit(rid) if rid else "NULL",str(rev) if rev is not None else "NULL",
              str(row),"NULL" if col is None else str(col),lit(json.dumps(payload or {}))]
        result=sql("SET ROLE service_role; SELECT bot_document_review("+",".join(args)+");",error)
        return json.loads(result) if not error else None
    for role in ("anon","authenticated","service_role"):
        sql(f"SET ROLE {role}; SELECT * FROM document_review_rows","permission denied")
    sql("SET ROLE anon; SELECT bot_document_review(101,'input')","permission denied")
    sql("SET ROLE service_role; SELECT mw_private.bot_catalog_import(101,'home')","permission denied")
    sql("SET ROLE service_role; SELECT bot_catalog_import(101,'apply',"+lit(linked["id"])+", '{}',0,0)",
        "DOCUMENT_REVIEW_REQUIRED")
    review("open",first["id"],actor=103,error="DOCUMENT_DENIED")
    review("open",first["id"],actor=102,error="DOCUMENT_NOT_FOUND")
    r=review("open",first["id"]); rid=r["id"]
    assert r["counts"]=={"pending":1,"approved":0,"excluded":0,"total":1}
    assert review("open",first["id"])["id"]==rid
    assert r["locator"]=="sheet:1/row:2"
    review("handoff",rid,0,error="DOCUMENT_UNREVIEWED")
    sql("INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at) VALUES(101,'new_title',now()+interval '1 hour')")
    review("edit",rid,0,col=2,error="DOCUMENT_OTHER_INPUT")
    sql("DELETE FROM bot_editor_states WHERE staff_telegram_id=101")
    r=review("edit",rid,0,col=2);assert r["revision"]==1
    sql("UPDATE staff SET role='seller' WHERE telegram_id=101")
    sql("INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at) VALUES(101,'new_title',now()+interval '1 hour')")
    sql("DELETE FROM bot_editor_states WHERE staff_telegram_id=101")
    sql("UPDATE staff SET role='admin' WHERE telegram_id=101")
    sql("INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at) VALUES(101,'new_title',now()+interval '1 hour')",
        "DOCUMENT_INPUT_ACTIVE")
    review("save",rid,1,col=2,payload={"value":"12","reply_to":500},error="DOCUMENT_PROMPT")
    review("bind",rid,1,col=2,payload={"message_id":500})
    review("save",rid,1,col=2,payload={"value":"12","reply_to":499},error="DOCUMENT_PROMPT")
    r=review("save",rid,1,col=2,payload={"value":"12","reply_to":500})
    assert r["cells"]==["DEV-ONLY","Training","12"] and r["original"]==["DEV-ONLY","Training","10"]
    assert r["decision"]=="pending"
    review("save",rid,1,col=2,payload={"value":"99","reply_to":500},error="DOCUMENT_STALE")
    r=review("approve",rid,r["revision"]);assert r["counts"]["approved"]==1
    review("handoff",rid,r["revision"],error="DOCUMENT_LEGACY_IMPORT")
    sql("SET ROLE service_role; SELECT bot_catalog_import(101,'cancel',"+lit(linked["id"])+")")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        concurrent_results=list(pool.map(lambda _: review("handoff",rid,r["revision"]),range(4)))
    assert len({v["import_id"] for v in concurrent_results})==1
    new_import=concurrent_results[0]["import_id"]
    assert review("handoff",rid,r["revision"])["import_id"]==new_import
    assert review("get",rid)["import_id"]==new_import
    review("edit",rid,r["revision"],col=2,error="DOCUMENT_FROZEN")
    assert sql("SELECT source->'rows' FROM catalog_imports WHERE id="+lit(new_import))=='[["DEV-ONLY", "Training", "12"]]'
    assert sql("SELECT source->'provenance'->0->>'locator' FROM catalog_imports WHERE id="+lit(new_import))=="sheet:1/row:2"
    assert sql("SELECT count(*) FROM catalog_imports")=="2"
    assert sql("SELECT count(*) FROM products")=="0"
    sql("SET ROLE service_role; SELECT bot_catalog_import(101,'apply',"+lit(linked["id"])+", '{}',0,0)",
        "DOCUMENT_REVIEW_REQUIRED")
    assert rpc("get",id=first["id"])["extraction"]==content
    # Restart retains originals, edited derivatives, and the one reviewed import link.
    command(["docker","restart",NAME])
    for _ in range(100):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.2)
    else: raise RuntimeError("PG_NOT_READY")
    assert review("handoff",rid,r["revision"])["import_id"]==new_import
    assert review("get",rid)["original"]==["DEV-ONLY","Training","10"]
    second=worker("claim")
    assert second["id"]!=claim["id"]
    stopped=rpc("cancel",102,second["id"]);assert stopped["state"]=="canceled"
    # A lost result/repeated confirmation never revives the job or creates another cancellation.
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        repeated=list(pool.map(lambda _: rpc("cancel",102,second["id"]),range(8)))
    assert all(result==stopped for result in repeated)
    assert rpc("get",102,second["id"])==stopped
    assert upload(actor=102)["id"]==second["id"]
    assert upload(actor=102)["state"]=="canceled"
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='document_cancel'")=="1"
    original=rpc("original",102,second["id"])
    assert hashlib.sha256(base64.b64decode(original["original_base64"])).hexdigest()==stopped["checksum"]
    worker("finish",second["id"],second["lease"],content,error="DOCUMENT_LEASE")
    third=upload(b"different")
    thirdclaim=worker("claim");assert thirdclaim["id"]==third["id"]
    sql("UPDATE document_intakes SET leased_at=now()-interval '11 minutes' WHERE id="+lit(third["id"]))
    assert worker("claim")["idle"]
    assert rpc("get",id=third["id"])["state"]=="failed"
    assert upload(b"different")["state"]=="failed"
    assert sql("SELECT count(*) FROM shop_orders")=="0"
    # A prompt remains bound across a real database restart; expired and revoked access fail closed.
    # New documents require every row to be decided; changes revoke prior approval.
    fourth=upload(b"review rows")
    claim4=worker("claim");assert claim4["id"]==fourth["id"]
    content4={**content,"sha256":fourth["checksum"],"tables":[{**content["tables"][0],
      "rows":[["A","Product A","20"],["B","Product B","30"],["C","Product C","40"]],
      "row_locators":["sheet:1/row:2","sheet:1/row:3","sheet:1/row:4"]}]}
    worker("finish",claim4["id"],claim4["lease"],content4)
    q=review("open",fourth["id"]);qid=q["id"]
    q=review("approve",qid,q["revision"]);assert q["row"]==1
    q=review("exclude",qid,q["revision"],row=1);assert q["row"]==2
    review("handoff",qid,q["revision"],error="DOCUMENT_UNREVIEWED")
    q=review("approve",qid,q["revision"],row=2)
    q=review("edit",qid,q["revision"],col=2)
    review("bind",qid,q["revision"],col=2,payload={"message_id":501})
    assert q["decision"]=="pending"
    review("handoff",qid,q["revision"],error="DOCUMENT_UNREVIEWED")
    old_revision=q["revision"]
    sql("UPDATE staff SET active=false WHERE telegram_id=101")
    review("save",qid,old_revision,col=2,payload={"value":"25","reply_to":501},error="DOCUMENT_DENIED")
    sql("UPDATE staff SET active=true WHERE telegram_id=101")
    command(["docker","restart",NAME])
    for _ in range(100):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.2)
    else: raise RuntimeError("PG_NOT_READY")
    assert review("input")["prompt"]["message_id"]==501
    q=review("save",qid,old_revision,col=2,payload={"value":"25","reply_to":501})
    assert q["decision"]=="pending"
    q=review("approve",qid,q["revision"])
    result=review("handoff",qid,q["revision"])
    source=json.loads(sql("SELECT source FROM catalog_imports WHERE id="+lit(result["import_id"])))
    assert source["rows"]==[["A","Product A","25"],["C","Product C","40"]]
    assert [p["source_row"] for p in source["provenance"]]==[0,2]
    assert sql("SELECT count(*) FROM products")=="0"
    print("PASS: cancellation/completion race, duplicate cancellation, canceled upload receipt, private originals, enrollment, review ownership, exact questions, stale edits, approval invalidation, skipped rows, provenance, legacy gate, restart, one reviewed handoff, no catalog/order mutations")
finally:
    if created: subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
