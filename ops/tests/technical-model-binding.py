#!/usr/bin/env python3
"""Isolated PostgreSQL: technical facts follow the reviewed model and source generation."""
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

def technical(op,pid=None,change=None,doc=None,expected=None,version=None,actor=101,error=None):
    args={"p_staff_telegram_id":actor,"p_op":op,"p_product_id":pid,"p_change_id":change}
    if doc is not None:args.update(p_document=doc,p_review_state="verified",p_expected_version=version)
    if expected is not None:args["p_expected_model"]=expected
    q="SET ROLE service_role; SELECT bot_technical_catalog("+",".join(
      k+"=>"+("NULL" if v is None else lit(json.dumps(v) if isinstance(v,dict) else v)) for k,v in args.items())+")"
    out=sql(q,error);return json.loads(out) if not error else None
def public(pid):
    out=sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")")
    return json.loads(out) if out else None
def editor(op,session=None,pid=None,doc=None,actor=101,error=None):
    args={"p_staff_telegram_id":actor,"p_op":op}
    if pid:args["p_product_id"]=pid
    if session:args.update(p_session_id=session["id"],p_revision=session["revision"])
    if doc:
        data=dict(session["data"]);data["document"]=doc;args["p_data"]=data
    if op=="preview":args["p_review_state"]="verified"
    out=sql("SET ROLE service_role; SELECT bot_technical_editor("+",".join(
      k+"=>"+lit(json.dumps(v) if isinstance(v,dict) else v) for k,v in args.items())+")",error)
    return json.loads(out)["session"] if not error else None
def preview_technical(pid,doc):
    c=technical("read",pid)["card"]
    return technical("preview",pid,doc=doc,expected=c["model_context"],version=c["version"])
DOC={"family_code":"power_mma","sources":[{
 "key":"manual","kind":"synthetic","publisher":"Training manufacturer","model":"MODEL-220",
 "title":"[Учебный] Не паспорт","url":"https://example.invalid/manual","locator":"Таблица 1",
 "checked_on":"2026-11-07","sha256":""}],
 "values":[{"attribute_code":"mma_current_max_a","process":"mma","state":"known","value":100,
 "unit_code":"a","context":{},"source_key":"manual"}]}
created=False
try:
    NAME="mw-tech-model-qa-"+uuid.uuid4().hex[:12]
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
             "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
      *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0035"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES(101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    pid,b,r=imported("MODEL-220")
    sql("UPDATE products SET status='published',assortment_decision='sell' WHERE id="+lit(pid))
    # Existing unbound technical facts and pending changes are retained at installation.
    before_card=technical("read",pid)["card"]
    old=technical("preview",pid,doc=DOC,version=before_card["version"])
    technical("apply",change=old["change_id"])
    old_public=public(pid)
    old_draft=editor("start",pid=pid)
    old_draft=editor("save",old_draft,doc=DOC)
    before=fingerprint()
    migration=(ROOT/"docs/migrations/0036_technical_model_binding.sql").read_text()
    spec=importlib.util.spec_from_file_location("binding_guard",ROOT/"ops/dev/apply-technical-model-binding.py")
    guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
    sql(guard.transaction(migration,{}),error="TECH_MODEL_BASELINE")
    sql(guard.transaction(migration+"\nUPDATE products SET title='Unexpected';"),error="TECH_MODEL_EXISTING_DATA_CHANGED")
    assert fingerprint()==before
    sql(guard.transaction(migration+"\nGRANT SELECT ON technical_editor_models TO service_role;"),error="TECH_MODEL_PRIVILEGES")
    sql(guard.transaction(migration))
    sql(guard.transaction(migration),error="TECH_MODEL_SCHEMA_REVIEW")
    assert fingerprint()==before and public(pid)==old_public
    editor("preview",old_draft,error="TECH_MODEL_CONTEXT_REQUIRED")
    editor("cancel",old_draft)
    # New direct previews require the model context actually read, not a silently refreshed choice.
    card=technical("read",pid)["card"]
    technical("preview",pid,doc=DOC,version=card["version"],error="TECH_MODEL_CONTEXT_REQUIRED")
    fresh=preview_technical(pid,DOC)
    technical("apply",change=fresh["change_id"])
    assert public(pid)
    technical("undo",change=fresh["change_id"])
    assert public(pid)==old_public
    selected=confirm_choice(prepare(pid,b))
    assert selected["current"]["usable"]
    assert public(pid) is None # Historical unbound facts cannot stand in for a chosen model.
    read=technical("read",pid)["card"]
    assert read["model_review"]["required"] and read["published"] is None
    assert read["model_context"]["identity"]["model"]=="MODEL-220"
    assert read["model_review"]["previous_revision"]==old_public["revision_id"]
    technical("preview",pid,doc=DOC,version=card["version"],expected=card["model_context"],error="TECH_MODEL_CHANGED")
    technical("read",pid,actor=999,error="TECH_DENIED")
    for role in ["anon","authenticated","service_role"]:
        for table in ["technical_editor_models","technical_change_models","technical_model_generations"]:
            sql("SET ROLE "+role+"; SELECT * FROM "+table,error="permission denied")
        sql("SET ROLE "+role+"; SELECT mw_private.technical_model_context("+lit(pid)+")",error="permission denied")
        sql("SET ROLE "+role+"; SELECT mw_private.bot_technical_editor_before_model(101,'current')",error="permission denied")
    # Owner sees the current identity; seller can read it without supplier-file access.
    assert technical("read",pid,actor=103)["card"]["model_context"]==read["model_context"]
    source_model=read["model_context"]
    technical("preview",pid,doc=DOC,version=read["version"],expected=source_model,actor=103,error="TECH_REVIEW_DENIED")
    s=editor("start",pid=pid)
    assert s["model_binding"]["captured"]==source_model and s["model_binding"]["matches"]
    s=editor("save",s,doc=DOC)
    s=editor("preview",s)
    s=editor("apply",s)
    published=public(pid)
    assert published and published["values"][0]["value"]==100
    assert "model_context" not in published and "choice_id" not in json.dumps(published)
    editor("apply",s) # Receipt replay, no second revision.
    assert public(pid)==published
    # Undo must not restore the older revision tied to no chosen model.
    editor("undo",s,error="TECH_MODEL_UNDO_REVIEW")
    current=preview_technical(pid,DOC)
    technical("apply",change=current["change_id"])
    technical("undo",change=current["change_id"])
    assert public(pid)==published
    waiting=preview_technical(pid,DOC)
    editing=editor("start",pid=pid)
    editing=editor("save",editing,doc=DOC)
    clear=choice("prepare_clear",pid,request=str(uuid.uuid4()),actor=102)
    choice("confirm",request=clear["request"]["id"],actor=102)
    assert public(pid) is None
    changed=editor("get",editing)
    assert not changed["model_binding"]["matches"] and changed["model_binding"]["current"]["state"]=="withdrawn"
    editor("preview",editing,error="TECH_MODEL_CHANGED")
    technical("apply",change=waiting["change_id"],error="TECH_MODEL_CHANGED")
    editor("apply",s) # Old receipt cannot republish facts.
    assert public(pid) is None
    confirm_choice(selected) # Old choice receipt cannot restore the chosen model.
    assert public(pid) is None
    editor("cancel",editing)
    confirm_choice(prepare(pid,b))
    assert public(pid) is None # Re-selecting the same identity is a new human decision/revision.
    # Price/stock preserve the explicit choice and technical evidence.
    latest=preview_technical(pid,DOC);technical("apply",change=latest["change_id"])
    new_public=public(pid)
    sql("UPDATE products SET price=17,stock_qty=3 WHERE id="+lit(pid))
    assert public(pid)==new_public
    # A new applied source for the same SKU makes the previous choice stale without editing identity fields.
    pid2,b2,r2=imported("MODEL-330")
    assert pid2==pid and choice("get",pid)["current"]["state"]=="stale"
    assert public(pid) is None
    stale=technical("read",pid)["card"]
    technical("preview",pid,doc=DOC,version=stale["version"],expected=stale["model_context"],error="TECH_MODEL_REVIEW_REQUIRED")
    # Undo restores the old evidence, but cannot make bound technical facts reappear.
    undo=catalog("undo_preview",b2["id"],b2["revision"])
    catalog("undo",undo["id"],undo["revision"])
    assert choice("get",pid)["current"]["state"]=="selected"
    assert public(pid) is None
    # Failure to persist binding rolls back the entire preview and its audit.
    confirm_choice(prepare(pid,b))
    counts=sql("SELECT count(*)||':'||(SELECT count(*) FROM staff_audit_log) FROM technical_changes")
    sql("""CREATE FUNCTION qa_binding_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_BINDING_FAIL'; END $$;
      CREATE TRIGGER qa_binding_fail BEFORE INSERT ON technical_change_models FOR EACH ROW EXECUTE FUNCTION qa_binding_fail();""")
    c=technical("read",pid)["card"]
    counts=sql("SELECT count(*)||':'||(SELECT count(*) FROM staff_audit_log) FROM technical_changes")
    technical("preview",pid,doc=DOC,version=c["version"],expected=c["model_context"],error="QA_BINDING_FAIL")
    assert sql("SELECT count(*)||':'||(SELECT count(*) FROM staff_audit_log) FROM technical_changes")==counts
    sql("DROP TRIGGER qa_binding_fail ON technical_change_models; DROP FUNCTION qa_binding_fail()")
    # Force both transaction orders for choice withdrawal versus technical confirmation.
    def wait_holder(tag):
        for _ in range(150):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name="+lit(tag)+" AND wait_event='PgSleep'")=="1":return
            time.sleep(.01)
        raise RuntimeError("LOCK_HOLDER_NOT_OBSERVED")
    race=preview_technical(pid,DOC)
    clear=choice("prepare_clear",pid,request=str(uuid.uuid4()),actor=102)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(sql,"BEGIN; SET application_name='model-first'; SET ROLE service_role; SELECT bot_product_model_choice(102,'confirm',p_request=>"+lit(clear["request"]["id"])+"); SELECT pg_sleep(2); COMMIT;")
        wait_holder("model-first")
        second=pool.submit(technical,"apply",change=race["change_id"],error="TECH_MODEL_CHANGED")
        first.result();second.result()
    assert public(pid) is None
    confirm_choice(prepare(pid,b))
    race=preview_technical(pid,DOC)
    clear=choice("prepare_clear",pid,request=str(uuid.uuid4()),actor=102)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(sql,"BEGIN; SET application_name='technical-first'; SET ROLE service_role; SELECT bot_technical_catalog(101,'apply',p_change_id=>"+lit(race["change_id"])+"); SELECT pg_sleep(2); COMMIT;")
        wait_holder("technical-first")
        second=pool.submit(choice,"confirm",request=clear["request"]["id"],actor=102)
        first.result();second.result()
    assert public(pid) is None
    command(["docker","restart",NAME]);ready()
    assert public(pid) is None and editor("get",s)["phase"]=="applied"
    print(json.dumps({"ok":True,"existingDataPreserved":True,"modelSnapshotFrozen":True,
      "readPreviewApplyAndUndoChecked":True,"sourceEvidenceChangesHideFacts":True,"modelReplayCannotRepublish":True,
      "priceStockPreserved":True,"sellerCannotApprove":True,"privateFilesNotExposed":True,
      "failedBindingRollsBackPreview":True,"restartPreservesHistory":True,"sourceUndoCannotRepublish":True,"bothConcurrentOrdersSafe":True}))
finally:
    if created:subprocess.run(["docker","rm","-f",NAME],capture_output=True)
