#!/usr/bin/env python3
"""Isolated PostgreSQL: explicit product model choice, receipts and invalidation."""
import base64
import copy
import concurrent.futures
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import time
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[2]
NAME="mw-source-fact-qa-"+uuid.uuid4().hex[:12]
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


def facts(op,rid=None,rev=None,index=0,payload=None,actor=101,error=None):
    args=[str(actor),lit(op),lit(rid) if rid else "NULL",str(rev) if rev is not None else "NULL",str(index),lit(json.dumps(payload or {}))]
    raw=sql("SET ROLE service_role; SELECT bot_source_fact_review("+",".join(args)+")",error)
    return json.loads(raw) if not error else None
def step(op,v,index=0,payload=None,error=None):
    return facts(op,v["review"]["id"],v["review"]["revision"],index,payload,error=error)
def snapshot():
    tables=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN('staff_audit_log','source_fact_reviews','source_fact_rows') ORDER BY tablename").splitlines()
    return {t:sql('SELECT md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),\'\')) FROM public."'+t+'" t') for t in tables}
def approve_source(pid,doc):
    r=sources("start",pid,rid=str(uuid.uuid4()))["review"]
    r=act("choose",r,{"document_id":doc})["review"]
    r=act("kind",r,{"kind":"manual"})["review"]
    r=act("preview",r)["review"]
    return act("confirm",r)["review"]
def value(code,val,context=None):
    return {"attribute_code":code,"process":"mma","unit_code":"pct" if "duty" in code else "a",
      "value":val,"context":context or {}}
created=False
try:
    command(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
             "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True;ready()
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
      *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0038"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    pid,b,r=imported("MODEL-220")
    confirm_choice(prepare(pid,b))
    text="🧰 Учебная модель\r\nМаксимальный ток MMA: 160 А\r\nПН MMA: 60 %\r\nПН MMA: 100 %\n"
    f=upload(text.encode())
    job=worker("claim")
    table={"label":"Учебная таблица","header":["Параметр","Значение"],"rows":[["Сила тока","160 А"]],
      "row_locators":["page:2/table:1/row:2"]}
    worker("finish",job["id"],job["lease"],{"version":"document-v1","sha256":f["checksum"],"tables":[table],
      "blocks":[{"locator":"page:1","page":1,"text":text}],"warnings":[],"coverage":{"complete":True}})
    approved=approve_source(pid,f["id"])
    proposals=[]
    for code,val,quote in [
      ("mma_current_max_a",160,"Максимальный ток MMA: 160 А"),
      ("mma_duty_cycle_pct",60,"ПН MMA: 60 %"),
      ("mma_duty_cycle_pct",100,"ПН MMA: 100 %")]:
        proposals.append({"attribute_code":code,"unit_code":"pct" if "duty" in code else "a","process":"mma","value":val,
          "issues":["model_scope_review"],"evidence":{"kind":"block","block":0,"locator":"page:1","page":1,
            "start":text.index(quote),"end":text.index(quote)+len(quote),"offset_unit":"unicode_codepoints","quote":quote}})
    unresolved={"label":"Сила тока","raw_value":"160 А","evidence":{"kind":"table","table":0,"row":0,
      "locator":"page:2/table:1/row:2","header":table["header"],"cells":table["rows"][0]}}
    result={"version":"source-candidates-v1","checksum":f["checksum"],"family_code":"power_mma",
      "candidates":proposals,"unmatched_entries":[unresolved],"fields_without_candidates":[],"warnings":[]}
    payload={"source_id":approved["source_id"],"result":result}
    before=snapshot()
    migration=(ROOT/"docs/migrations/0039_source_fact_review.sql").read_text()
    sql("BEGIN;"+migration+"COMMIT;")
    assert snapshot()==before,"MIGRATION_DATA_CHANGED"
    for role in ["anon","authenticated","service_role"]:
        for table_name in ["source_fact_reviews","source_fact_rows"]:
            sql("SET ROLE "+role+"; SELECT * FROM "+table_name,error="permission denied")
        assert sql("SELECT has_function_privilege("+lit(role)+",'mw_private.source_fact_evidence_matches(jsonb,jsonb)','EXECUTE')")=="f"
    facts("current",actor=103,error="SOURCE_FACT_DENIED")
    assert facts("current")["idle"]
    for mutate in [
        lambda x:x["result"]["candidates"][0]["evidence"].update(quote="Changed text"),
        lambda x:x["result"]["candidates"][0]["evidence"].update(start=0),
        lambda x:x["result"]["candidates"][0]["evidence"].update(page=9),
        lambda x:x["result"]["candidates"][0]["evidence"].update(offset_unit="utf16"),
        lambda x:x["result"]["unmatched_entries"][0]["evidence"].update(cells=["Changed","160 А"]),
    ]:
        bad=copy.deepcopy(payload);mutate(bad)
        facts("prepare",str(uuid.uuid4()),payload=bad,error="SOURCE_FACT_EVIDENCE")
        assert sql("SELECT count(*) FROM source_fact_reviews")=="0"
    wrong=copy.deepcopy(payload);wrong["result"]["checksum"]="f"*64
    facts("prepare",str(uuid.uuid4()),payload=wrong,error="SOURCE_FACT_RESULT")
    facts("prepare",str(uuid.uuid4()),payload=payload,actor=102,error="SOURCE_FACT_SOURCE_STALE")
    request=str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        prepared=list(pool.map(lambda _:facts("prepare",request,payload=payload),range(8)))
    v=prepared[0]
    assert all(x==v for x in prepared)
    assert v["counts"]=={"total":4,"pending":4,"accepted":0,"skipped":0}
    facts("get",request,actor=102,error="SOURCE_FACT_NOT_FOUND")
    facts("prepare",str(uuid.uuid4()),payload=payload,error="SOURCE_FACT_ACTIVE")
    assert v["row"]["proposal"]["evidence"]["quote"]==proposals[0]["evidence"]["quote"]
    # Acceptance and its audit must commit together.
    sql("""CREATE FUNCTION public.qa_fact_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='source_fact_accept' THEN RAISE EXCEPTION 'QA_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_fact_audit_failure BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION public.qa_fact_audit_failure();""")
    step("accept",v,error="QA_AUDIT_FAILURE")
    assert facts("get",request)==v
    sql("DROP TRIGGER qa_fact_audit_failure ON staff_audit_log; DROP FUNCTION qa_fact_audit_failure()")
    old=copy.deepcopy(v)
    v=step("accept",v)
    step("skip",old,error="SOURCE_FACT_STALE_BUTTON")
    v=step("save",v,payload={"draft":value("mma_current_max_a",170)})
    assert v["row"]["decision"]=="pending" and v["row"]["proposal"]["value"]==160
    v=step("accept",v)
    step("accept",v,index=1,error="TECH_CONTEXT_REQUIRED")
    v=step("save",v,index=1,payload={"draft":value("mma_duty_cycle_pct",60,{"current_a":160,"temperature_c":40})})
    v=step("accept",v,index=1)
    v=step("save",v,index=2,payload={"draft":value("mma_duty_cycle_pct",100,{"current_a":120,"temperature_c":40})})
    v=step("accept",v,index=2)
    step("preview",v,error="SOURCE_FACT_PUBLISHER_REQUIRED")
    v=step("publisher",v,payload={"text":"Учебный изготовитель"})
    step("preview",v,error="SOURCE_FACT_DECISIONS_REQUIRED")
    v=step("map",v,index=3,payload={"attribute_code":"mma_current_max_a","process":"mma"})
    assert v["row"]["draft"]["value"] is None
    step("accept",v,index=3,error="TECH_BAD_TYPE")
    v=step("save",v,index=3,payload={"draft":value("mma_current_max_a",160)})
    v=step("accept",v,index=3)
    step("preview",v,error="TECH_BAD_VALUE") # Two maxima at the same conditions must be resolved.
    v=step("skip",v,index=3)
    v=step("preview",v)
    assert v["review"]["phase"]=="preview" and len(v["review"]["prepared_document"]["values"])==3
    assert len(v["review"]["prepared_document"]["sources"])==1 # Same physical page, separate exact private quotes.
    assert snapshot()==before,"REVIEW_CHANGED_OLD_TABLES"
    assert sql("SELECT count(*) FROM technical_revisions")=="0"
    command(["docker","restart",NAME]);ready()
    assert facts("get",request)=={**v,"row":facts("get",request)["row"]} # Default selected row may differ.
    v=step("edit",v)
    assert v["review"]["prepared_document"] is None
    # A subsequent technical edit invalidates the captured base; it is never silently refreshed.
    sql("INSERT INTO technical_cards(product_id,version) VALUES("+lit(pid)+",1)")
    assert not facts("get",request)["usable"]
    step("preview",v,error="SOURCE_FACT_SOURCE_STALE")
    v=step("cancel",v)
    assert step("cancel",v)["review"]["phase"]=="canceled"
    assert facts("prepare",request,payload=payload)["review"]["phase"]=="canceled"
    fresh=facts("prepare",str(uuid.uuid4()),payload=payload)
    act("withdraw",act("withdraw_prepare",approved)["review"])
    assert not facts("get",fresh["review"]["id"])["usable"]
    step("save",fresh,payload={"draft":value("mma_current_max_a",180)},error="SOURCE_FACT_SOURCE_STALE")
    step("cancel",fresh)
    print(json.dumps({"ok":True,"migration_sha256":hashlib.sha256(migration.encode()).hexdigest(),
      "checks":["private_roles","exact_unicode_quote","table_origin","foreign_source","stable_prepare",
       "audit_atomicity","CAS","human_corrections","required_conditions","duplicate_resolution",
       "publisher_required","preview_only","same_page_grouping","old_data_preserved","restart",
       "stale_base","withdrawn_source","cancel_receipt"]}))
finally:
    if created:subprocess.run(["docker","rm","-f",NAME],capture_output=True)
