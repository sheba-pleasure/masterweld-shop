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
NAME="mw-structure-qa-"+uuid.uuid4().hex[:12]
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
created=False
try:
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
        "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"]);created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
        *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0027"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    f=upload(b"structure training")
    c=worker("claim")
    original={"version":"document-v1","sha256":f["checksum"],"tables":[{"label":"Training",
      "header":["sku","Wrong name","price"],"rows":[["A\\nB".replace("\\n","\n"),"Alpha\\nBeta".replace("\\n","\n"),"10"],
        ["C","Gamma","30"],["D","Skip","40"]],"row_locators":["sheet:1/row:2","sheet:1/row:3","sheet:1/row:4"]}],
      "blocks":[],"warnings":[],"coverage":{"complete":True}}
    worker("finish",c["id"],c["lease"],original)
    r=review("open",f["id"]);rid=r["id"]
    r=review("approve",rid,r["revision"],row=1)
    r=review("exclude",rid,r["revision"],row=2)
    # The guarded ALTER must preserve existing reviews and decisions, not require an empty database.
    spec=importlib.util.spec_from_file_location("migration",ROOT/"ops/dev/apply-document-structure.py")
    migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
    assert json.loads(sql(migration.BASELINE_SQL))==migration.EXPECTED
    sql(migration.transaction((ROOT/migration.PATH).read_text(),migration.EXPECTED))
    sql(migration.transaction((ROOT/migration.PATH).read_text(),migration.EXPECTED),"DOCUMENT_ALREADY_APPLIED")
    def act(op, row=None, col=None, payload=None,error=None):
        global r
        result=review(op,rid,r["revision"],r["row"] if row is None else row,col,payload,error=error)
        if result:r=result
        return result
    for role in ("anon","authenticated","service_role"):
        sql(f"SET ROLE {role}; SELECT * FROM document_structure_changes","permission denied")
    sql("SET ROLE service_role; SELECT mw_private.document_structure(101,'add',"+lit(rid)+",2,0,NULL,'{}')","permission denied")
    review("st_add",rid,2,actor=103,error="DOCUMENT_DENIED")
    review("st_add",rid,2,actor=102,error="DOCUMENT_NOT_FOUND")
    act("get",row=0)
    # Header choice is only a draft; no silently changed import or approval.
    act("st_head",col=1);assert r["header"][1]=="Wrong name" and r["counts"]["approved"]==1
    act("st_standard",col=1)
    act("approve",error="DOCUMENT_STRUCTURE_ACTIVE")
    act("handoff",error="DOCUMENT_STRUCTURE_ACTIVE")
    act("st_apply",error="DOCUMENT_STRUCTURE_PREVIEW")
    act("st_preview");revision=r["revision"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results=list(pool.map(lambda _:review("st_apply",rid,revision),range(3)))
    r=results[0]
    assert len({x["revision"] for x in results})==1
    assert r["header"]==["sku","title","price"] and r["original_header"][1]=="Wrong name"
    assert r["counts"]=={"total":3,"pending":2,"approved":0,"excluded":1}
    act("st_undo");assert r["header"][1]=="Wrong name" and r["counts"]["approved"]==1
    review("st_undo",rid,revision+1) # duplicate undo
    act("st_head",col=1);act("st_standard",col=1);act("st_preview");act("st_apply")
    # Add cancellation retains all prior rows.
    act("st_add");act("st_cancel");assert r["counts"]["total"]==3
    act("st_add")
    act("st_focus",col=0,payload={"guided":True})
    act("st_save",col=0,payload={"value":"M","reply_to":900},error="DOCUMENT_PROMPT")
    act("st_bind",col=0,payload={"message_id":900})
    command(["docker","restart",NAME]);ready()
    act("st_save",col=0,payload={"value":"M","reply_to":899},error="DOCUMENT_PROMPT")
    act("st_save",col=0,payload={"value":"M","reply_to":900})
    assert r["structure_draft"]["focus"]==1
    act("st_bind",col=1,payload={"message_id":901})
    act("st_save",col=1,payload={"value":"Missing product","reply_to":901})
    act("st_skip",col=2)
    assert r["structure_draft"]["focus"]==-1
    act("st_preview",error="DOCUMENT_SOURCE_NOTE")
    act("st_where",col=-1);act("st_preview");act("st_apply")
    manual=r["row"]
    assert manual==3 and r["position"]==2 and r["prev_row"]==0 and r["next_row"]==1
    assert r["source_origin"]=="manual" and r["original"]==[] and r["decision"]=="pending"
    act("st_undo")
    assert r["counts"]["total"]==3 and r["row"]==0
    # Stable IDs never recycle after undo.
    act("st_split",col=2)
    assert r["structure_draft"]["rows"]==[["A","Alpha",""],["B","Beta",""]]
    sql("INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at) VALUES(101,'new_title',now()+interval '1 hour')","DOCUMENT_INPUT_ACTIVE")
    act("save",col=2,payload={"value":"unsafe","reply_to":901},error="DOCUMENT_STRUCTURE_ACTIVE")
    act("st_focus",col=2)
    act("st_copy",col=2);act("st_focus",col=32);act("st_copy",col=32)
    act("st_preview");split_base=r["revision"]
    act("st_apply");first_child=r["row"]
    assert first_child==4 and r["next_row"]==5 and r["prev_row"] is None and r["position"]==1
    assert r["cells"]==["A","Alpha","10"] and r["original"]==original["tables"][0]["rows"][0]
    assert r["source_origin"]=="split" and r["locator"]=="sheet:1/row:2" and r["counts"]["total"]==4
    # Retried apply must not split a second time. Old row updates never redirect to a new product.
    assert review("st_apply",rid,split_base,row=0)["counts"]["total"]==4
    review("approve",rid,r["revision"],row=0,error="DOCUMENT_ROW_REPLACED")
    assert review("get",rid,row=0)["row"]==first_child
    act("st_undo") # invoked from the new active row, restores original
    assert r["row"]==0 and r["counts"]["total"]==3
    act("st_split",col=2);act("st_preview");act("st_apply")
    assert r["row"]==6 and r["next_row"]==7
    undo_revision=r["revision"]
    act("approve")
    review("st_undo",rid,undo_revision,row=6,error="DOCUMENT_STALE")
    act("st_undo",error="DOCUMENT_UNDO_CONFLICT")
    # Complete human decisions are mandatory; handoff is one preview, never a product publication.
    act("handoff",error="DOCUMENT_UNREVIEWED")
    while r["counts"]["pending"]:
        act("next");act("approve")
    reviewed=review("get",rid,row=6)
    handoff=review("handoff",rid,reviewed["revision"],row=6)
    assert review("handoff",rid,reviewed["revision"],row=6)==handoff
    imported=json.loads(sql("SELECT source FROM catalog_imports WHERE id="+lit(handoff["import_id"])))
    assert imported["rows"]==[["A","Alpha",""],["B","Beta",""],["C","Gamma","30"]]
    assert imported["provenance"][0]["source_row"]==0 and imported["provenance"][0]["origin"]=="split"
    assert sql("SELECT count(*) FROM products")=="0" and sql("SELECT count(*) FROM catalog_imports")=="1"
    assert rpc("get",id=f["id"])["extraction"]==original
    print(json.dumps({"ok":True,"structure":"headers/missing/split/undo","immutableOriginal":True,
      "guards":"human/revision/private/exclusive/reply/restart","products":0,"imports":1}))
finally:
    if created:subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
