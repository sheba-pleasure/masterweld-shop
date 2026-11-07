#!/usr/bin/env python3
"""Isolated PostgreSQL: source-backed fact decisions, question binding and recovery."""
import argparse
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
from unittest import mock

parser=argparse.ArgumentParser()
parser.add_argument("--documentary-conditions",action="store_true")
parser.add_argument("--accessory-characteristics",action="store_true")
args=parser.parse_args()
accessory_characteristics=args.accessory_characteristics
documentary_conditions=args.documentary_conditions or accessory_characteristics
accessory_report=None
ROOT=pathlib.Path(__file__).resolve().parents[2]
NAME="mw-source-fact-qa-"+uuid.uuid4().hex[:12]
compatibility_spec=importlib.util.spec_from_file_location("app_compatibility",ROOT/"ops/dev/app_compatibility.py")
compatibility=importlib.util.module_from_spec(compatibility_spec)
compatibility_spec.loader.exec_module(compatibility)
def check_app_schema(expected):
    # Run the exact deployment query against this isolated database, never DEV.
    state=json.loads(sql(compatibility.SCHEMA_SQL))
    if expected=="incomplete":
        try: compatibility.validate_schema(state)
        except RuntimeError as error: assert str(error)=="DEV_SOURCE_FACT_SCHEMA_INCOMPLETE"
        else: raise AssertionError("PARTIAL_SCHEMA_ACCEPTED")
    else: assert (compatibility.CAPABILITY in compatibility.validate_schema(state)) is expected
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
    tables=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN('staff_audit_log','source_fact_reviews','source_fact_rows','source_fact_prompts') ORDER BY tablename").splitlines()
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
    check_app_schema(False)
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
    check_app_schema("incomplete")
    assert snapshot()==before,"MIGRATION_DATA_CHANGED"
    for role in ["anon","authenticated","service_role"]:
        for table_name in ["source_fact_reviews","source_fact_rows","source_fact_prompts"]:
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
    # Each answer belongs only to the actor's exact persisted question and row.
    assert facts("input")["idle"]
    facts("input",actor=103,error="SOURCE_FACT_DENIED")
    step("prompt",v,index=3,payload={"field":"value"},error="SOURCE_FACT_ATTRIBUTE")
    step("prompt",v,payload={"field":"source_key"},error="SOURCE_FACT_INPUT")
    v=step("prompt",v,payload={"field":"value"})
    assert v["prompt"]["message_id"] is None and facts("input")==v
    step("reply",v,payload={"reply_to":900,"value":165},error="SOURCE_FACT_WRONG_QUESTION")
    step("bind",v,payload={"message_id":0},error="SOURCE_FACT_INPUT")
    v=step("bind",v,payload={"message_id":900})
    assert step("bind",v,payload={"message_id":900})==v
    step("bind",v,payload={"message_id":901},error="SOURCE_FACT_QUESTION_BOUND")
    step("reply",v,payload={"reply_to":901,"value":165},error="SOURCE_FACT_WRONG_QUESTION")
    step("reply",v,index=1,payload={"reply_to":900,"value":165},error="SOURCE_FACT_QUESTION_STALE")
    step("reply",v,payload={"reply_to":900,"value":165,"attribute_code":"other"},error="SOURCE_FACT_INPUT")
    facts("reply",request,v["review"]["revision"],payload={"reply_to":900,"value":165},
      actor=102,error="SOURCE_FACT_NOT_FOUND")
    old_question=copy.deepcopy(v)
    sql("""CREATE FUNCTION public.qa_reply_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='source_fact_reply' THEN RAISE EXCEPTION 'QA_REPLY_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_reply_audit_failure BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION public.qa_reply_audit_failure();""")
    step("reply",v,payload={"reply_to":900,"value":165},error="QA_REPLY_FAILURE")
    assert facts("input")==v
    sql("DROP TRIGGER qa_reply_audit_failure ON staff_audit_log; DROP FUNCTION qa_reply_audit_failure()")
    v=step("reply",v,payload={"reply_to":900,"value":165})
    assert v["prompt"] is None and facts("input")["idle"]
    assert v["row"]["draft"]["value"]==165 and v["row"]["proposal"]["value"]==160
    step("reply",old_question,payload={"reply_to":900,"value":175},error="SOURCE_FACT_STALE_BUTTON")
    # Context is collected one explicit field at a time, without changing value or other conditions.
    v=step("prompt",v,index=1,payload={"field":"current_a"})
    v=step("bind",v,index=1,payload={"message_id":902})
    step("reply",v,index=1,payload={"reply_to":902,"value":-1},error="TECH_BAD_CONTEXT")
    v=step("reply",v,index=1,payload={"reply_to":902,"value":160})
    assert v["row"]["draft"]==value("mma_duty_cycle_pct",60,{"current_a":160})
    v=step("prompt",v,index=1,payload={"field":"temperature_c"})
    v=step("bind",v,index=1,payload={"message_id":903})
    step("reply",v,index=1,payload={"reply_to":903,"value":"40"},error="TECH_BAD_CONTEXT")
    v=step("reply",v,index=1,payload={"reply_to":903,"value":40})
    assert v["row"]["draft"]["context"]=={"current_a":160,"temperature_c":40}
    # Return this row to the original incomplete draft for the acceptance checks below.
    v=step("save",v,index=1,payload={"draft":value("mma_duty_cycle_pct",60)})
    v=step("accept",v)
    v=step("prompt",v,payload={"field":"value"})
    assert v["row"]["decision"]=="pending"
    v=step("bind",v,payload={"message_id":904})
    command(["docker","restart",NAME]);ready()
    assert facts("input")==v
    previous=copy.deepcopy(v)
    # Explicit resume makes a new revision and cannot silently bind an old question to a new message.
    v=step("prompt",v,payload={"field":"value"})
    v=step("bind",v,payload={"message_id":905})
    step("reply",previous,payload={"reply_to":904,"value":180},error="SOURCE_FACT_STALE_BUTTON")
    step("reply",v,payload={"reply_to":904,"value":180},error="SOURCE_FACT_WRONG_QUESTION")
    v=step("cancel_input",v)
    assert v["row"]["draft"]["value"]==165 and v["row"]["decision"]=="pending" and facts("input")["idle"]
    # A question can be canceled without restoring approval or losing saved corrections.
    v=step("prompt",v,payload={"field":"publisher"})
    v=step("bind",v,payload={"message_id":906})
    step("reply",v,payload={"reply_to":906,"value":" "},error="SOURCE_FACT_INPUT")
    v=step("reply",v,payload={"reply_to":906,"value":"Учебный издатель"})
    assert v["review"]["publisher"]=="Учебный издатель"
    # Keep the existing explicit-publisher-required acceptance test independent.
    sql("UPDATE source_fact_reviews SET publisher=NULL WHERE id="+lit(request))
    v=facts("get",request)
    ordinary="INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at) VALUES(101,'new_title',now()+interval '1 hour')"
    technical="INSERT INTO technical_editor_sessions(staff_telegram_id,product_id,base_version,data) VALUES(101,"+lit(pid)+",0,'{}')"
    doc_prompt="INSERT INTO document_review_prompts(actor,review_id,revision,row_index,column_index) VALUES(101,"+lit(r["id"])+",0,0,0)"
    competitors=[("bot_editor_states",ordinary),("technical_editor_sessions",technical),("document_review_prompts",doc_prompt)]
    v=step("prompt",v,payload={"field":"value"})
    for table_name,query in competitors:
        sql(query,error="SOURCE_FACT_INPUT_ACTIVE")
    # Older text input also blocks starting this editor; failed attempts leave no question/revision.
    v=step("cancel_input",v)
    for table_name,query in competitors:
        sql(query)
        step("prompt",v,payload={"field":"value"},error="SOURCE_FACT_OTHER_INPUT")
        assert facts("get",request)==v
        sql("DELETE FROM "+table_name)
    args="101,'prompt',"+lit(request)+","+str(v["review"]["revision"])+",0,'{\"field\":\"value\"}'"
    sql("BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT bot_source_fact_review("+args+"); COMMIT;",
      error="EDITOR_ISOLATION_REQUIRED")
    assert facts("get",request)==v
    # Real competing transactions: only one of the two editors may acquire this actor.
    def attempt(query):
        result=subprocess.run(["docker","exec","-i",NAME,"psql","-X","-Atq","-U","postgres","-v","ON_ERROR_STOP=1"],
          input="BEGIN; "+query+"; SELECT pg_sleep(0.05); COMMIT;",capture_output=True,text=True)
        return result.returncode,result.stderr
    for table_name,query in competitors:
        args="101,'prompt',"+lit(request)+","+str(v["review"]["revision"])+",0,'{\"field\":\"value\"}'"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(attempt,["SELECT bot_source_fact_review("+args+")",query]))
        assert sum(code==0 for code,_ in outcomes)==1,outcomes
        assert any("SOURCE_FACT_OTHER_INPUT" in err or "SOURCE_FACT_INPUT_ACTIVE" in err for _,err in outcomes),outcomes
        v=facts("get",request)
        if v["prompt"] is not None:
            v=step("cancel_input",v)
        sql("DELETE FROM "+table_name)
    # A revoked privileged question must not trap the employee, nor accept a reply after a role restore
    # if an ordinary editor was opened in between.
    v=step("prompt",v,payload={"field":"value"})
    v=step("bind",v,payload={"message_id":907})
    sql("UPDATE staff SET role='seller' WHERE telegram_id=101")
    facts("input",error="SOURCE_FACT_DENIED")
    sql(ordinary)
    sql("UPDATE staff SET role='admin' WHERE telegram_id=101")
    step("reply",v,payload={"reply_to":907,"value":166},error="SOURCE_FACT_OTHER_INPUT")
    assert facts("input")==v
    v=step("cancel_input",v)
    sql("DELETE FROM bot_editor_states")
    # An expired question is not silently rebound. A new explicit prompt can replace the expired row.
    v=step("prompt",v,payload={"field":"value"})
    v=step("bind",v,payload={"message_id":908})
    sql("UPDATE source_fact_prompts SET expires_at=now()-interval '1 minute' WHERE actor=101")
    assert facts("input")["idle"]
    step("reply",v,payload={"reply_to":908,"value":166},error="SOURCE_FACT_QUESTION_STALE")
    v=step("prompt",v,payload={"field":"value"})
    v=step("bind",v,payload={"message_id":909})
    # Any row action invalidates the pending answer; it may not change the next decision.
    old_question=copy.deepcopy(v)
    v=step("skip",v,index=3)
    assert facts("input")["idle"]
    step("reply",old_question,payload={"reply_to":909,"value":166},error="SOURCE_FACT_STALE_BUTTON")
    v=step("reset",v,index=3)
    v=facts("get",request)
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
    assert v["document_id"]==f["id"] and v["document_checksum"]==f["checksum"]
    assert v["next_pending"] is None and prepared[0]["next_pending"]==1
    # Check the real PostgreSQL response against the UI boundary, not only a handwritten TS fixture.
    script="""import { sourceFactReviewResponse, renderSourceFactReview } from './src/lib/technical/source-review-view.ts';
      let raw=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>raw+=chunk);
      process.stdin.on('end',()=>{for(const value of JSON.parse(raw)) {
        const parsed=sourceFactReviewResponse.parse(value);
        renderSourceFactReview(parsed,'list',parsed.row.row_index);
        renderSourceFactReview(parsed,'row',parsed.row.row_index);
      }});"""
    subprocess.run([str(ROOT/"node_modules/.bin/tsx"),"-e",script],cwd=ROOT,
      input=json.dumps([prepared[0],old_question,v]),capture_output=True,text=True,check=True)
    # The merge is private and read-only. A new source must never overwrite an old key.
    for role in ["anon","authenticated","service_role"]:
        assert sql("SELECT has_function_privilege("+lit(role)+",'mw_private.source_fact_merge_preview(jsonb,jsonb,uuid)','EXECUTE')")=="f"
    def merge(previous,incoming,error=None):
        raw=sql("SELECT mw_private.source_fact_merge_preview("+
          ("NULL" if previous is None else lit(json.dumps(previous)))+","+
          lit(json.dumps(incoming))+","+lit(request)+")",error)
        if error:return None
        return {**json.loads(raw),"before_revision":str(uuid.uuid4()) if previous is not None else None}
    incoming=copy.deepcopy(v["review"]["prepared_document"])
    new_source=copy.deepcopy(incoming["sources"][0])
    collision_key="sf"+request.replace("-","")+"_0"
    previous_source={**new_source,"key":collision_key,"publisher":"Прежний изготовитель",
      "title":"Прежний паспорт","sha256":"b"*64}
    def known(code,val,context=None,source=collision_key):
        return {**value(code,val,context),"state":"known","source_key":source}
    previous={"family_code":"power_mma","sources":[previous_source],
      "values":[known("mma_current_max_a",150),
        known("mma_duty_cycle_pct",50,{"temperature_c":40.0,"current_a":160.0}),
        known("mma_duty_cycle_pct",80,{"current_a":100,"temperature_c":40}),
        {**known("mma_current_min_a",None),"state":"unknown","source_key":None}]}
    plan=merge(previous,incoming)
    assert [c["kind"] for c in plan["changes"]]==["replaced","replaced","retained","retained","added"]
    assert len(plan["after_document"]["values"])==5
    assert plan["after_document"]["values"][2:4]==previous["values"][2:4]
    assert plan["after_document"]["sources"][0]==previous_source
    assert plan["after_document"]["values"][0]["source_key"]!=collision_key
    assert plan["before_document"]==previous
    assert plan["after_document"]["values"][0]["value"]==170
    assert plan["after_document"]["values"][1]["value"]==60
    # Same source key in the two documents refers to different sources; namespace them independently.
    same_key=copy.deepcopy(previous)
    same_key["sources"][0]["key"]=new_source["key"]
    for fact in same_key["values"]:
        if fact["state"]=="known":fact["source_key"]=new_source["key"]
    same_plan=merge(same_key,incoming)
    assert same_plan["after_document"]["values"][2]["source_key"]==new_source["key"]
    assert same_plan["after_document"]["values"][0]["source_key"]!=new_source["key"]
    # A value may be unchanged but its evidence replaces the previous source; show it as replacement.
    same_value=copy.deepcopy(previous)
    same_value["values"][0]["value"]=170
    assert merge(same_value,incoming)["changes"][0]["kind"]=="replaced"
    # Another family removes every old fact from the new draft, while preserving its full snapshot.
    other_family={"family_code":"power_tig_dc","sources":[previous_source],"values":[
      {"attribute_code":"tig_current_max_a","process":"tig","state":"known","value":200,
       "unit_code":"a","context":{},"source_key":collision_key}]}
    family_plan=merge(other_family,incoming)
    assert [c["kind"] for c in family_plan["changes"]]==["removed","added","added","added"]
    assert family_plan["before_document"]==other_family
    assert collision_key not in [s["key"] for s in family_plan["after_document"]["sources"]]
    # Limits reject the complete plan instead of dropping retained values or sources.
    many=copy.deepcopy(previous);many["values"]=[
      known("mma_duty_cycle_pct",60,{"current_a":i,"temperature_c":20}) for i in range(128)]
    merge(many,incoming,error="SOURCE_FACT_MERGE_VALUE_LIMIT")
    many["sources"]=[{**previous_source,"key":"old_"+str(i)} for i in range(32)]
    many["values"]=[known("mma_duty_cycle_pct",60,{"current_a":i,"temperature_c":20},source="old_"+str(i)) for i in range(32)]
    merge(many,incoming,error="SOURCE_FACT_MERGE_SOURCE_LIMIT")
    def large_doc(start):
        sources=[{**previous_source,"key":"large_"+str(i),"publisher":"P"*1000,
          "model":"M"*1000,"title":"T"*1000,"locator":"L"*1000} for i in range(16)]
        return {"family_code":"power_mma","sources":sources,"values":[
          known("mma_duty_cycle_pct",60,{"current_a":i,"temperature_c":20,
            "gas":"Газ"*30,"material":"Материал"*14},source="large_"+str(i%16))
          for i in range(start,start+64)]}
    merge(large_doc(0),large_doc(64),error="SOURCE_FACT_MERGE_SIZE_LIMIT")
    # Incoming bounds must also agree with the retained minimum.
    contradictory=copy.deepcopy(previous)
    contradictory["values"]=[known("mma_current_min_a",180)]
    merge(contradictory,incoming,error="TECH_REVERSED_RANGE")
    assert v["review"]["merge_preview"]["before_document"] is None
    assert all(c["kind"]=="added" for c in v["review"]["merge_preview"]["changes"])
    # Parse real SQL plans and render every change, including removed/retained values and source collisions.
    merge_script="""import { sourceFactMergePreview, sourceFactMergeSummary, sourceFactMergeDetail } from './src/lib/technical/source-review-merge.ts';
      let raw=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>raw+=chunk);
      process.stdin.on('end',()=>{for(const value of JSON.parse(raw)) {
        const parsed=sourceFactMergePreview.parse(value);
        sourceFactMergeSummary(parsed);
        parsed.changes.forEach((_,i)=>sourceFactMergeDetail(parsed,i));
      }});"""
    subprocess.run([str(ROOT/"node_modules/.bin/tsx"),"-e",merge_script],cwd=ROOT,
      input=json.dumps([plan,same_plan,family_plan,v["review"]["merge_preview"]]),
      capture_output=True,text=True,check=True)
    # Exercise the public review RPC against a real previous technical revision.
    # Keep this scenario in a rolled-back test transaction so the old-data assertion remains meaningful.
    sql("BEGIN; DO $merge_rpc$ DECLARE t jsonb; r jsonb; saved_plan jsonb; i integer; expected_doc jsonb:="+
      lit(json.dumps(previous))+"::jsonb; incoming_doc jsonb:="+lit(json.dumps(incoming))+"::jsonb; BEGIN "+
      "PERFORM bot_source_fact_review(101,'cancel',"+lit(request)+","+str(v["review"]["revision"])+"); "+
      "t:=bot_technical_catalog(101,'preview',"+lit(pid)+",NULL,expected_doc,'verified',0,mw_private.technical_model_context("+lit(pid)+")); "+
      "PERFORM bot_technical_catalog(101,'apply',p_change_id:=(t->>'change_id')::uuid); "+
      "r:=bot_source_fact_review(101,'prepare',"+lit(str(uuid.uuid4()))+",NULL,0,"+lit(json.dumps(payload))+"); "+
      """FOR i IN 0..2 LOOP
        r:=bot_source_fact_review(101,'save',(r->'review'->>'id')::uuid,(r->'review'->>'revision')::integer,i,
          jsonb_build_object('draft',(incoming_doc->'values'->i)-ARRAY['state','source_key']));
        r:=bot_source_fact_review(101,'accept',(r->'review'->>'id')::uuid,(r->'review'->>'revision')::integer,i);
      END LOOP;
      r:=bot_source_fact_review(101,'skip',(r->'review'->>'id')::uuid,(r->'review'->>'revision')::integer,3);
      r:=bot_source_fact_review(101,'publisher',(r->'review'->>'id')::uuid,(r->'review'->>'revision')::integer,0,'{"text":"Учебный изготовитель"}');
      r:=bot_source_fact_review(101,'preview',(r->'review'->>'id')::uuid,(r->'review'->>'revision')::integer);
      saved_plan:=r->'review'->'merge_preview';
      IF saved_plan->'before_document' IS DISTINCT FROM expected_doc
        OR saved_plan->>'before_revision' IS NULL
        OR jsonb_array_length(saved_plan->'after_document'->'values')<>5
        OR (SELECT count(*) FROM technical_revisions)<>1
        OR EXISTS(SELECT 1 FROM technical_editor_sessions)
        THEN RAISE EXCEPTION 'QA_MERGE_RPC_DAMAGED_PREVIOUS'; END IF;
      r:=bot_source_fact_review(101,'get',(r->'review'->>'id')::uuid);
      IF r->'review'->'merge_preview' IS DISTINCT FROM saved_plan THEN RAISE EXCEPTION 'QA_MERGE_PLAN_REFRESHED'; END IF;
      -- Simulate a historical technical binding from an older model selection.
      UPDATE technical_change_models SET context=jsonb_set(context,'{revision}','999')
        WHERE change_id=(t->>'change_id')::uuid;
      r:=bot_source_fact_review(101,'edit',(r->'review'->>'id')::uuid,(r->'review'->>'revision')::integer);
      BEGIN
        PERFORM bot_source_fact_review(101,'preview',(r->'review'->>'id')::uuid,(r->'review'->>'revision')::integer);
        RAISE EXCEPTION 'QA_MERGE_ACCEPTED_OLD_MODEL';
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM<>'SOURCE_FACT_PREVIOUS_MODEL_STALE' THEN RAISE; END IF;
      END;
    END $merge_rpc$; ROLLBACK;""")
    assert snapshot()==before,"REVIEW_CHANGED_OLD_TABLES"
    assert sql("SELECT count(*) FROM technical_revisions")=="0"
    command(["docker","restart",NAME]);ready()
    assert facts("get",request)=={**v,"row":facts("get",request)["row"]} # Default selected row may differ.
    v=step("edit",v)
    assert v["review"]["prepared_document"] is None and v["review"]["merge_preview"] is None
    # A subsequent technical edit invalidates the captured base; it is never silently refreshed.
    sql("INSERT INTO technical_cards(product_id,version) VALUES("+lit(pid)+",1)")
    assert not facts("get",request)["usable"]
    step("preview",v,error="SOURCE_FACT_SOURCE_STALE")
    v=step("cancel",v)
    assert step("cancel",v)["review"]["phase"]=="canceled"
    assert facts("prepare",request,payload=payload)["review"]["phase"]=="canceled"
    fresh=facts("prepare",str(uuid.uuid4()),payload=payload)
    fresh=step("prompt",fresh,payload={"field":"value"})
    fresh=step("bind",fresh,payload={"message_id":910})
    act("withdraw",act("withdraw_prepare",approved)["review"])
    assert not facts("get",fresh["review"]["id"])["usable"]
    step("save",fresh,payload={"draft":value("mma_current_max_a",180)},error="SOURCE_FACT_SOURCE_STALE")
    step("reply",fresh,payload={"reply_to":910,"value":180},error="SOURCE_FACT_SOURCE_STALE")
    assert not facts("input")["usable"] # A stale source is not reported as no pending question.
    fresh=step("cancel_input",fresh)
    assert facts("input")["idle"]
    step("cancel",fresh)
    # 0040 is a separate additive WIP migration; no pre-existing value changes at installation.
    origin_baseline=snapshot()
    origin_migration=(ROOT/"docs/migrations/0040_technical_source_origins.sql").read_text()
    sql("BEGIN;"+origin_migration+"COMMIT;")
    check_app_schema("incomplete")
    origin_after=snapshot();origin_after.pop("technical_fact_origins")
    assert origin_after==origin_baseline,"ORIGIN_MIGRATION_CHANGED_DATA"
    for role in ["anon","authenticated","service_role"]:
        sql("SET ROLE "+role+"; SELECT * FROM technical_fact_origins",error="permission denied")
        for signature in [
          "mw_private.technical_origin_status(jsonb,uuid,boolean)",
          "mw_private.technical_origin_transition(jsonb,jsonb)",
          "mw_private.bot_technical_catalog_before_origins(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb)",
          "mw_private.bot_technical_editor_before_origins(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint)"]:
            assert sql("SELECT has_function_privilege("+lit(role)+","+lit(signature)+",'EXECUTE')")=="f"
    def technical(op,doc=None,change=None,version=None,error=None):
        model_context=sql("SELECT mw_private.technical_model_context("+lit(pid)+")")
        args=["101",lit(op),lit(pid),lit(change) if change else "NULL",
          lit(json.dumps(doc)) if doc is not None else "NULL",lit("verified"),
          str(version) if version is not None else "NULL",lit(model_context)]
        raw=sql("SET ROLE service_role; SELECT bot_technical_catalog("+",".join(args)+")",error)
        return json.loads(raw) if not error else None
    def editor(op,session=None,data=None,source_revision=None,error=None):
        args=["101",lit(op),lit(session["id"]) if session else "NULL",
          str(session["revision"]) if session else "NULL",lit(pid),
          lit(source_revision) if source_revision else "NULL",
          lit(json.dumps(data)) if data is not None else "NULL",lit("verified")]
        raw=sql("SET ROLE service_role; SELECT bot_technical_editor("+",".join(args)+")",error)
        return json.loads(raw)["session"] if not error else None
    origin_approval=approve_source(pid,f["id"])
    origin_payload={**payload,"source_id":origin_approval["source_id"]}
    origin_view=facts("prepare",str(uuid.uuid4()),payload=origin_payload)
    origin_view=step("save",origin_view,payload={"draft":value("mma_current_max_a",170)})
    origin_view=step("accept",origin_view)
    for ix in [1,2,3]:origin_view=step("skip",origin_view,index=ix)
    origin_view=step("publisher",origin_view,payload={"text":"Учебный изготовитель"})
    origin_view=step("preview",origin_view)
    origin_doc=copy.deepcopy(origin_view["review"]["prepared_document"])
    origin_id=str(uuid.uuid4())
    # Registration must match an accepted row and its exact prepared source, even inside trusted code.
    for wrong_row,wrong_snapshot,wrong_fact in [
      (1,{k:v for k,v in origin_doc["sources"][0].items() if k!="key"},origin_doc["values"][0]),
      (0,{**{k:v for k,v in origin_doc["sources"][0].items() if k!="key"},"sha256":"d"*64},origin_doc["values"][0]),
      (0,{k:v for k,v in origin_doc["sources"][0].items() if k!="key"},{**origin_doc["values"][0],"value":999}),
    ]:
        sql("INSERT INTO technical_fact_origins(id,product_id,source_id,review_id,row_index,source_snapshot,original_fact) VALUES("+
          ",".join([lit(origin_id),lit(pid),lit(origin_approval["source_id"]),lit(origin_view["review"]["id"]),str(wrong_row),
            lit(json.dumps(wrong_snapshot)),lit(json.dumps(wrong_fact))])+")",error="TECH_ORIGIN_INVALID")
    # Fixture for the future atomic handoff. No service role can insert such records directly.
    sql("INSERT INTO technical_fact_origins(id,product_id,source_id,review_id,row_index,source_snapshot,original_fact) VALUES("+
      ",".join([lit(origin_id),lit(pid),lit(origin_approval["source_id"]),lit(origin_view["review"]["id"]),"0",
        lit(json.dumps({k:v for k,v in origin_doc["sources"][0].items() if k!="key"})),
        lit(json.dumps(origin_doc["values"][0]))])+")")
    origin_doc["values"][0]["origin_ref"]=origin_id
    assert not json.loads(sql("SELECT mw_private.technical_origin_status("+lit(json.dumps(origin_doc))+","+lit(pid)+")"))["usable"]
    # Complete the isolated handoff fixture. In application code this must be one atomic transaction.
    sql("UPDATE source_fact_reviews SET phase='handed' WHERE id="+lit(origin_view["review"]["id"]))
    sql("UPDATE technical_fact_origins SET original_fact=original_fact",error="TECH_ORIGIN_IMMUTABLE")
    sql("DELETE FROM technical_fact_origins",error="TECH_ORIGIN_IMMUTABLE")
    assert not json.loads(sql("SELECT mw_private.technical_origin_status("+
      lit(json.dumps(origin_doc))+","+lit(str(uuid.uuid4()))+")"))["usable"]
    for ref in [None,"bad","10000000-0000-4000-8000-000000000000"]:
        bad=copy.deepcopy(origin_doc);bad["values"][0]["origin_ref"]=ref
        technical("preview",bad,version=1,error="TECH_ORIGIN_INVALID" if ref in [None,"bad"] else "TECH_SOURCE_REVIEW_REQUIRED")
    unknown=copy.deepcopy(origin_doc)
    unknown["values"][0].update(state="unknown",value=None,source_key=None)
    technical("preview",unknown,version=1,error="TECH_ORIGIN_INVALID")
    duplicated=copy.deepcopy(origin_doc)
    duplicated["values"].append({**duplicated["values"][0],"context":{"temperature_c":40}})
    technical("preview",duplicated,version=1,error="TECH_ORIGIN_INVALID")
    first_change=technical("preview",origin_doc,version=1)
    technical("apply",change=first_change["change_id"])
    published=technical("read")["card"]["published_revision"]
    sql("UPDATE products SET status='published',assortment_decision='sell' WHERE id="+lit(pid))
    public_card=json.loads(sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")"))
    assert public_card["values"][0]["value"]==170 and "origin_ref" not in json.dumps(public_card)
    assert origin_id not in json.dumps(public_card)
    e=editor("start")
    assert e["data"]["document"]==origin_doc and e["source_binding"]=={"usable":True,"total":1,"unavailable":0}
    stripped=copy.deepcopy(e["data"]);stripped["document"]["values"][0].pop("origin_ref")
    editor("save",e,stripped,error="TECH_ORIGIN_REMOVED")
    technical("preview",stripped["document"],version=2,error="TECH_ORIGIN_REMOVED")
    assert editor("get",e)["data"]==e["data"]
    # A source-key rename preserves the descriptor and provenance; changing its checksum does not.
    renamed=copy.deepcopy(e["data"])
    renamed["document"]["sources"][0]["key"]="renamed"
    renamed["document"]["values"][0]["source_key"]="renamed"
    e=editor("save",e,renamed)
    changed_source=copy.deepcopy(e["data"]);changed_source["document"]["sources"][0]["sha256"]="c"*64
    editor("save",e,changed_source,error="TECH_ORIGIN_INVALID")
    # Updating a human-reviewed value retains the same origin reference.
    edited=copy.deepcopy(e["data"]);edited["document"]["values"][0]["value"]=171
    e=editor("save",e,edited)
    e=editor("preview",e)
    assert e["data"]["document"]["values"][0]["origin_ref"]==origin_id
    # Withdrawing the actual approved source invalidates both reads and an already prepared apply.
    act("withdraw",act("withdraw_prepare",origin_approval)["review"])
    assert sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")")==""
    assert editor("get",e)["source_binding"]=={"usable":False,"total":1,"unavailable":1}
    editor("apply",e,error="TECH_SOURCE_REVIEW_REQUIRED")
    view=technical("read")["card"]
    assert view["published"] is None and view["source_review"]["required"]
    assert view["source_review"]["previous_revision"]==published
    assert technical("apply",change=first_change["change_id"])["duplicate"]
    assert sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")")==""
    technical("undo",change=first_change["change_id"],error="TECH_SOURCE_REVIEW_REQUIRED")
    editor("cancel",e)
    clone=editor("start",source_revision=published)
    assert clone["data"]["document"]["values"][0]["origin_ref"]==origin_id
    editor("preview",clone,error="TECH_SOURCE_REVIEW_REQUIRED")
    command(["docker","restart",NAME]);ready()
    assert editor("get",clone)["source_binding"]["unavailable"]==1
    # Source review intentionally cannot start while a technical draft is open.
    editor("cancel",clone)
    # Renewing approval for the same bytes does not reauthorize the withdrawn origin.
    renewed=approve_source(pid,f["id"])
    assert renewed["source_id"]!=origin_approval["source_id"]
    clone=editor("start",source_revision=published)
    assert not clone["source_binding"]["usable"]
    # Removing a fact is allowed; remaining stale facts would still block preview.
    removed=copy.deepcopy(clone["data"]);removed["document"]["values"]=[];removed["document"]["sources"]=[]
    clone=editor("save",clone,removed)
    assert clone["source_binding"]=={"usable":True,"total":0,"unavailable":0}
    # A separate explicit manual review may add a new value. No automatic reassignment of its source.
    manual=copy.deepcopy(clone["data"])
    manual["document"]=copy.deepcopy(origin_doc)
    manual["document"]["values"][0].pop("origin_ref")
    manual["document"]["sources"][0].update(sha256="",url="https://example.com/new-manual",title="Новый проверенный вручную документ")
    manual["document"]["values"][0]["value"]=180
    clone=editor("save",clone,manual)
    clone=editor("preview",clone)
    clone=editor("apply",clone)
    assert json.loads(sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")"))["values"][0]["value"]==180
    editor("undo",clone,error="TECH_SOURCE_UNDO_REVIEW")
    assert technical("apply",change=first_change["change_id"])["duplicate"]
    assert json.loads(sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")"))["values"][0]["value"]==180
    origin_ui_script="""import { editorData } from './src/lib/technical/editor.ts';
      import { technicalSourceBinding, sourceBindingText } from './src/lib/technical/source-binding.ts';
      let raw=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>raw+=chunk);
      process.stdin.on('end',()=>{for(const session of JSON.parse(raw)) {
        editorData.parse(session.data);
        sourceBindingText(technicalSourceBinding.parse(session.source_binding));
      }});"""
    subprocess.run([str(ROOT/"node_modules/.bin/tsx"),"-e",origin_ui_script],cwd=ROOT,
      input=json.dumps([e,editor("get",e),clone]),capture_output=True,text=True,check=True)
    handoff_baseline=snapshot()
    handoff_migration=(ROOT/"docs/migrations/0041_source_fact_handoff.sql").read_text()
    sql("BEGIN;"+handoff_migration+"COMMIT;")
    check_app_schema(True)
    assert snapshot()==handoff_baseline,"HANDOFF_MIGRATION_CHANGED_DATA"
    for role in ["anon","authenticated","service_role"]:
        assert sql("SELECT has_function_privilege("+lit(role)+",'mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)','EXECUTE')")=="f"
    if documentary_conditions:
        # Proposed 0042 runs only in this disposable database, never live DEV.
        proposal=(ROOT/"docs/proposals/0042_documentary_measurement_conditions.sql").read_text()
        if accessory_characteristics:
            accessory_sql=(ROOT/"docs/proposals/0043_accessory_characteristics.sql").read_text()
            sql("BEGIN;"+accessory_sql+"ROLLBACK;",error="ACCESSORY_DOCUMENTARY_CONDITIONS_REQUIRED")
        measurement={
          "family_code":"power_mma",
          "sources":[{"key":"manual","kind":"synthetic","publisher":"Учебный изготовитель",
            "model":"Учебная модель","title":"[Учебный] Условия из документа",
            "url":"https://example.invalid/conditions","locator":"Учебная таблица",
            "checked_on":"2026-11-06","sha256":""}],
          "values":[{**value("mma_current_max_a",160,{"test_conditions":"Кабель: 8 м; ПН 60 %."}),
            "state":"known","source_key":"manual"}]}
        def validate_measurement(document,error=None):
            return sql("SELECT validate_technical_document("+lit(json.dumps(document))+",'verified')",error)
        validate_measurement(measurement,"TECH_BAD_CONTEXT")
        def all_rows():
            tables=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
            return {t:sql('SELECT md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),\'\')) FROM public."'+t+'" t') for t in tables}
        sql("CREATE TABLE public.documentary_install_empty(id integer)")
        baseline=all_rows()
        acl_before=sql("""SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl) ORDER BY p.oid)
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','mw_private')""")
        installer_spec=importlib.util.spec_from_file_location("documentary_conditions_installation",
          ROOT/"ops/dev/documentary_conditions_installation.py")
        installer=importlib.util.module_from_spec(installer_spec)
        installer_spec.loader.exec_module(installer)
        sql("""CREATE TABLE mw_private.dev_migration_receipts(
          path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
          INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES ('previous-test','unchanged');""")
        assert installer.IDENTITY==compatibility.IDENTITY
        for revision,image,error in [
          ("short","sha256:"+"b"*64,"DOCUMENTARY_INSTALL_REVISION"),
          ("a"*40,"mutable:tag","DOCUMENTARY_INSTALL_IMAGE"),
        ]:
            try: installer.transaction(revision,image)
            except RuntimeError as failure: assert str(failure)==error
            else: raise AssertionError("INVALID_INSTALL_IDENTITY_ACCEPTED")
        with mock.patch.object(installer,"PROPOSAL_SHA256","0"*64):
            try: installer.transaction("a"*40,"sha256:"+"b"*64)
            except RuntimeError as failure: assert str(failure)=="DOCUMENTARY_INSTALL_CHECKSUM"
            else: raise AssertionError("MODIFIED_INSTALL_PROPOSAL_ACCEPTED")
        install_sql=installer.transaction("a"*40,"sha256:"+"b"*64)
        def unchanged_installation():
            assert all_rows()==baseline
            assert sql("SELECT to_regprocedure('mw_private.documentary_conditions_version()') IS NULL")=="t"
            assert sql("SELECT jsonb_object_agg(path,sha256) FROM mw_private.dev_migration_receipts")=='{"previous-test": "unchanged"}'
            validate_measurement(measurement,"TECH_BAD_CONTEXT")
        # Corruption after proposal execution must roll back both schema and data.
        for injected,expected_error in [
          ("UPDATE public.staff SET name='Unexpected' WHERE telegram_id=101;", "DOCUMENTARY_INSTALL_ROWS_CHANGED"),
          ("UPDATE mw_private.dev_migration_receipts SET sha256='Changed';", "DOCUMENTARY_INSTALL_ROWS_CHANGED"),
          ("GRANT EXECUTE ON FUNCTION mw_private.validate_technical_document_before_origins(jsonb,text) TO anon;", "DOCUMENTARY_INSTALL_FUNCTIONS_CHANGED"),
          ("CREATE FUNCTION public.unexpected_install_function() RETURNS int LANGUAGE sql AS 'SELECT 1';", "DOCUMENTARY_INSTALL_FUNCTIONS_CHANGED"),
          ("GRANT UPDATE ON public.products TO anon;", "DOCUMENTARY_INSTALL_RELATIONS_CHANGED"),
          ("CREATE POLICY unexpected_install_policy ON public.products FOR UPDATE TO anon USING(true);", "DOCUMENTARY_INSTALL_ACCESS_CHANGED"),
          ("CREATE ROLE unexpected_install_role;", "DOCUMENTARY_INSTALL_ACCESS_CHANGED"),
          ("ALTER TABLE public.technical_attributes ADD CONSTRAINT unexpected_install_check CHECK(true);", "DOCUMENTARY_INSTALL_CONSTRAINTS_CHANGED"),
          ("ALTER TABLE public.documentary_install_empty ADD COLUMN unexpected_install_column text;", "DOCUMENTARY_INSTALL_COLUMNS_CHANGED"),
        ]:
            sql(install_sql.replace("-- All checks precede",injected+"\n-- All checks precede"),error=expected_error)
            unchanged_installation()
        # Wrong instance and modified baseline fail before the proposal can commit.
        sql(install_sql.replace("DO $identity$", "UPDATE mw_private.environment SET environment='production'; DO $identity$",1),
          error="DOCUMENTARY_INSTALL_DEV_REQUIRED")
        unchanged_installation()
        assert json.loads(sql("SELECT public.mw_environment_identity()"))==installer.IDENTITY
        bad_baseline="ALTER FUNCTION mw_private.validate_technical_document_before_origins(jsonb,text) COST 101;"
        sql(install_sql.replace(proposal,bad_baseline+proposal),error="DOCUMENTARY_CONDITIONS_BASELINE")
        unchanged_installation()
        # Late failure prevents the receipt and proposed functions from surviving.
        sql(install_sql.replace("NOTIFY pgrst","SELECT 1/0; NOTIFY pgrst"),error="division by zero")
        unchanged_installation()
        result=sql(install_sql)
        assert json.loads(result)["state"]=="recorded"
        assert sql("SELECT sha256 FROM mw_private.dev_migration_receipts WHERE path="+lit(installer.PROPOSAL_PATH))==installer.PROPOSAL_SHA256
        sql(install_sql,error="DOCUMENTARY_INSTALL_ALREADY_PRESENT")
        assert sql("SELECT count(*) FROM mw_private.dev_migration_receipts")=="2"
        assert all_rows()==baseline,"DOCUMENTARY_CONDITIONS_CHANGED_ROWS"
        assert compatibility.validate_schema(json.loads(sql(compatibility.SCHEMA_SQL)))==frozenset({
          compatibility.CAPABILITY,compatibility.DOCUMENTARY_CAPABILITY})
        acl_after=sql("""SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl) ORDER BY p.oid)
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','mw_private')
          AND p.oid<>'mw_private.documentary_conditions_version()'::regprocedure""")
        assert acl_before==acl_after,"DOCUMENTARY_CONDITIONS_CHANGED_ACL"
        for role in ["anon","authenticated","service_role"]:
            for signature in ["mw_private.documentary_conditions_version()",
              "mw_private.validate_technical_document_before_origins(jsonb,text)",
              "mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)"]:
                assert sql("SELECT has_function_privilege("+lit(role)+","+lit(signature)+",'EXECUTE')")=="f"
        if accessory_characteristics:
            from accessory_checks import check_accessories
            accessory_report=check_accessories(sql,ROOT)
        validate_measurement(measurement)
        for note in ["v","Полные условия\nБез пересчёта единиц", "🧰"*500]:
            candidate=copy.deepcopy(measurement)
            candidate["values"][0]["context"]["test_conditions"]=note
            validate_measurement(candidate)
        for note in ["", " \t\r\n", "\u00a0\u2003\ufeff", "🧰"*501, " "*500+"A", 0, True, [], {}, None]:
            candidate=copy.deepcopy(measurement)
            candidate["values"][0]["context"]["test_conditions"]=note
            validate_measurement(candidate,"TECH_BAD_CONTEXT")
        distinct=copy.deepcopy(measurement)
        distinct["values"].append({**distinct["values"][0],"value":120,
          "context":{"test_conditions":"Кабель: 16 м; ПН 100 %."}})
        validate_measurement(distinct)
        distinct["values"][1]["context"]=distinct["values"][0]["context"]
        validate_measurement(distinct,"TECH_BAD_VALUE")
        unknown=copy.deepcopy(measurement)
        unknown["values"][0].update(state="unknown",value=None,source_key=None)
        validate_measurement(unknown,"TECH_UNKNOWN_HAS_VALUE")
        # Required context remains real validation, not a UI-only prompt.
        sql("BEGIN; UPDATE technical_attributes SET required_context=ARRAY['test_conditions'] WHERE code='mma_current_max_a';"+
          "SELECT validate_technical_document("+lit(json.dumps({**measurement,"values":[
            {**measurement["values"][0],"context":{}}]}))+",'verified'); ROLLBACK;",error="TECH_CONTEXT_REQUIRED")
        sql("BEGIN;"+proposal+"ROLLBACK;",error="DOCUMENTARY_CONDITIONS_BASELINE")
        # Same persisted question, actor, decision invalidation and handoff as every other field.
        candidate=copy.deepcopy(payload);candidate["source_id"]=renewed["source_id"]
        extra=facts("prepare",str(uuid.uuid4()),payload=candidate)
        extra=step("accept",extra)
        extra=step("prompt",extra,payload={"field":"test_conditions"})
        assert extra["row"]["decision"]=="pending"
        extra=step("bind",extra,payload={"message_id":942})
        question=copy.deepcopy(extra)
        step("reply",extra,payload={"reply_to":943,"value":"Wrong question"},error="SOURCE_FACT_WRONG_QUESTION")
        for note in ["", "\u00a0", "🧰"*501, 17]:
            step("reply",extra,payload={"reply_to":942,"value":note},error="TECH_BAD_CONTEXT")
        facts("reply",extra["review"]["id"],extra["review"]["revision"],payload={"reply_to":942,"value":"Foreign"},
          actor=102,error="SOURCE_FACT_NOT_FOUND")
        command(["docker","restart",NAME]);ready()
        assert facts("get",extra["review"]["id"])["prompt"]["field"]=="test_conditions"
        note="Учебные условия: кабель 8 м; ПН 60 %.\nТолько для указанной модификации."
        extra=step("reply",extra,payload={"reply_to":942,"value":note})
        assert extra["row"]["draft"]["context"]["test_conditions"]==note
        assert extra["row"]["decision"]=="pending" and extra["prompt"] is None
        step("reply",question,payload={"reply_to":942,"value":"Duplicate"},error="SOURCE_FACT_STALE_BUTTON")
        extra=step("accept",extra)
        for index in [1,2,3]:extra=step("skip",extra,index=index)
        extra=step("publisher",extra,payload={"text":"Учебный изготовитель"})
        extra=step("preview",extra)
        assert extra["review"]["prepared_document"]["values"][0]["context"]["test_conditions"]==note
        transferred=step("handoff",extra,payload={"confirm_plan":True,"replace_family":False})
        session=editor("get",{"id":transferred["review"]["editor_session_id"],"revision":0})
        assert any(v["context"].get("test_conditions")==note for v in session["data"]["document"]["values"])
        editor("cancel",session)
        assert step("handoff",extra,payload={"confirm_plan":True,"replace_family":False})["review"]["editor_session_id"]==session["id"]
    def ready_facts(approval,family="power_mma",maximum=190,all_rows=True):
        candidate=copy.deepcopy(payload)
        candidate["source_id"]=approval["source_id"];candidate["result"]["family_code"]=family
        result=facts("prepare",str(uuid.uuid4()),payload=candidate)
        for index,draft in [
          (0,value("mma_current_max_a",maximum)),
          (1,value("mma_duty_cycle_pct",60,{"current_a":160,"temperature_c":40})),
          (2,value("mma_duty_cycle_pct",100,{"current_a":120,"temperature_c":40})),
        ]:
            if index and not all_rows:result=step("skip",result,index=index)
            else:
                result=step("save",result,index=index,payload={"draft":draft})
                result=step("accept",result,index=index)
        result=step("skip",result,index=3)
        result=step("publisher",result,payload={"text":"Учебный изготовитель"})
        return step("preview",result)
    consent={"confirm_plan":True,"replace_family":False}
    handoff=ready_facts(renewed)
    assert handoff["handoff_supported"] and handoff["retained_sources"]["usable"]
    facts("handoff",handoff["review"]["id"],handoff["review"]["revision"],payload=consent,actor=103,error="SOURCE_FACT_DENIED")
    facts("handoff",handoff["review"]["id"],handoff["review"]["revision"],payload=consent,actor=102,error="SOURCE_FACT_NOT_FOUND")
    step("handoff",handoff,error="SOURCE_FACT_CONFIRM_REQUIRED")
    facts("handoff",handoff["review"]["id"],handoff["review"]["revision"]-1,payload=consent,error="SOURCE_FACT_STALE_BUTTON")
    step("handoff",handoff,payload={**consent,"replace_family":True},error="SOURCE_FACT_FAMILY_CONFIRM_REQUIRED")
    # Any existing technical session survives the refused transfer.
    occupied=editor("start")
    step("handoff",handoff,payload=consent,error="SOURCE_FACT_OTHER_INPUT")
    assert editor("get",occupied)["data"]==occupied["data"]
    editor("cancel",occupied)
    # Expiry requires a fresh explicit preview; it never silently refreshes during handoff.
    sql("UPDATE source_fact_reviews SET preview_expires_at=now()-interval '1 second' WHERE id="+lit(handoff["review"]["id"]))
    step("handoff",handoff,payload=consent,error="SOURCE_FACT_PREVIEW_EXPIRED")
    handoff=step("preview",step("edit",handoff))
    handoff_args="101,'handoff',"+lit(handoff["review"]["id"])+","+str(handoff["review"]["revision"])+",0,"+lit(json.dumps(consent))
    # A changed product/base cannot be accepted with the old displayed plan.
    sql("BEGIN; UPDATE technical_cards SET version=version+1 WHERE product_id="+lit(pid)+
      "; SELECT bot_source_fact_review("+handoff_args+");",error="SOURCE_FACT_SOURCE_STALE")
    # A changed stored plan cannot be silently recomputed into something else.
    sql("BEGIN; UPDATE source_fact_reviews SET merge_preview=jsonb_set(merge_preview,'{after_document,values,0,value}','999') WHERE id="+
      lit(handoff["review"]["id"])+"; SELECT bot_source_fact_review("+handoff_args+");",error="SOURCE_FACT_MERGE_RESULT")
    # Actual source withdrawal between preview and handoff is refused. The transaction is rolled back.
    sql("BEGIN; DO $withdraw_handoff$ DECLARE s jsonb; BEGIN "+
      "s:=bot_product_sources(101,'withdraw_prepare',NULL,"+lit(renewed["id"])+","+str(renewed["revision"])+"); "+
      "s:=bot_product_sources(101,'withdraw',NULL,"+lit(renewed["id"])+",(s->'review'->>'revision')::integer); "+
      "BEGIN PERFORM bot_source_fact_review("+handoff_args+"); RAISE EXCEPTION 'QA_HANDOFF_AFTER_WITHDRAW'; "+
      "EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'SOURCE_FACT_SOURCE_STALE' THEN RAISE; END IF; END; "+
      "END $withdraw_handoff$; ROLLBACK;")
    transfer_baseline=snapshot()
    sql("""CREATE FUNCTION public.qa_handoff_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='source_fact_handoff' THEN RAISE EXCEPTION 'QA_HANDOFF_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_handoff_audit_failure BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION public.qa_handoff_audit_failure();""")
    step("handoff",handoff,payload=consent,error="QA_HANDOFF_AUDIT_FAILURE")
    assert snapshot()==transfer_baseline,"HANDOFF_LEFT_PARTIAL_EDITOR_OR_ORIGINS"
    assert facts("get",handoff["review"]["id"])["review"]==handoff["review"]
    sql("DROP TRIGGER qa_handoff_audit_failure ON staff_audit_log; DROP FUNCTION qa_handoff_audit_failure()")
    catalog_before=sql("SELECT row_to_json(c)::text FROM technical_cards c WHERE product_id="+lit(pid))
    revisions_before=sql("SELECT count(*) FROM technical_revisions")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        transferred=list(pool.map(lambda _:step("handoff",handoff,payload=consent),range(8)))
    session_ids={x["review"]["editor_session_id"] for x in transferred}
    assert len(session_ids)==1 and None not in session_ids
    transferred_view=transferred[0]
    receipt_session={"id":next(iter(session_ids)),"revision":0}
    received=editor("get",receipt_session)
    assert received["phase"]=="editing" and received["source_binding"]=={"usable":True,"total":3,"unavailable":0}
    assert sql("SELECT count(*) FROM technical_fact_origins WHERE review_id="+lit(handoff["review"]["id"]))=="3"
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='source_fact_handoff' AND details->>'review_id'="+lit(handoff["review"]["id"]))=="1"
    assert sql("SELECT row_to_json(c)::text FROM technical_cards c WHERE product_id="+lit(pid))==catalog_before
    assert sql("SELECT count(*) FROM technical_revisions")==revisions_before
    assert all("origin_ref" in fact for fact in received["data"]["document"]["values"])
    # The exact displayed values/sources survive; the only added data is private origin metadata.
    displayed=copy.deepcopy(received["data"]["document"])
    for fact in displayed["values"]:fact.pop("origin_ref")
    assert displayed==handoff["review"]["merge_preview"]["after_document"]
    command(["docker","restart",NAME]);ready()
    assert step("handoff",handoff,payload=consent)["review"]["editor_session_id"]==received["id"]
    received=editor("preview",received)
    received=editor("apply",received)
    assert json.loads(sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")"))["values"][0]["value"]==190
    # A new document can replace one fact while old withdrawn facts remain editable only for removal.
    act("withdraw",act("withdraw_prepare",renewed)["review"])
    third_approval=approve_source(pid,f["id"])
    retained_review=ready_facts(third_approval,maximum=195,all_rows=False)
    assert retained_review["retained_sources"]=={"usable":False,"total":2,"unavailable":2}
    retained_transfer=step("handoff",retained_review,payload=consent)
    retained_session=editor("get",{"id":retained_transfer["review"]["editor_session_id"],"revision":0})
    assert retained_session["source_binding"]=={"usable":False,"total":3,"unavailable":2}
    editor("preview",retained_session,error="TECH_SOURCE_REVIEW_REQUIRED")
    cleaned=copy.deepcopy(retained_session["data"])
    cleaned["document"]["values"]=[fact for fact in cleaned["document"]["values"] if fact["attribute_code"]=="mma_current_max_a"]
    used={fact["source_key"] for fact in cleaned["document"]["values"]}
    cleaned["document"]["sources"]=[source for source in cleaned["document"]["sources"] if source["key"] in used]
    retained_session=editor("save",retained_session,cleaned)
    assert retained_session["source_binding"]=={"usable":True,"total":1,"unavailable":0}
    retained_session=editor("apply",editor("preview",retained_session))
    editor("undo",retained_session,error="TECH_SOURCE_UNDO_REVIEW")
    # Changing a family has a separate explicit consent and still creates only a draft.
    family_review=ready_facts(third_approval,family="power_multiprocess")
    step("handoff",family_review,payload=consent,error="SOURCE_FACT_FAMILY_CONFIRM_REQUIRED")
    family_transfer=step("handoff",family_review,payload={**consent,"replace_family":True})
    family_session=editor("get",{"id":family_transfer["review"]["editor_session_id"],"revision":0})
    assert family_session["data"]["document"]["family_code"]=="power_multiprocess"
    assert json.loads(sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")"))["family"]["code"]=="power_mma"
    editor("cancel",family_session)
    another=editor("start")
    # Replaying a canceled/completed transfer always names its original session, never this later one.
    assert step("handoff",family_review,payload=consent)["review"]["editor_session_id"]==family_session["id"]
    assert editor("get",another)["data"]==another["data"]
    editor("cancel",another)
    handoff_ui_script="""import { sourceFactReviewResponse, renderSourceFactReview } from './src/lib/technical/source-review-view.ts';
      let raw=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>raw+=chunk);
      process.stdin.on('end',()=>{for(const rawView of JSON.parse(raw)) {
        const view=sourceFactReviewResponse.parse(rawView);
        renderSourceFactReview(view,'list',view.row.row_index);
        if(view.review.phase==='preview') renderSourceFactReview(view,'askhandoff',view.row.row_index);
      }});"""
    subprocess.run([str(ROOT/"node_modules/.bin/tsx"),"-e",handoff_ui_script],cwd=ROOT,
      input=json.dumps([handoff,transferred_view,retained_review,retained_transfer,family_review,family_transfer]),
      capture_output=True,text=True,check=True)
    # Combined import/identity/model/provenance path, exclusively in this isolated DB.
    # Real service RPCs perform changes; no fixture UPDATE repairs invalidated history.
    def plain_import(patch,sku="CHOICE-A"):
        header=["sku",*patch]
        rows=[[sku,*[str(v) for v in patch.values()]]]
        batch=catalog("upload",payload={"request_key":str(uuid.uuid4().int % 10**18),
          "file_name":"[Учебный] Повторный импорт.csv",
          "checksum":hashlib.sha256(json.dumps(rows).encode()).hexdigest(),
          "source":{"header":header,"rows":rows},"mapping":{key:i for i,key in enumerate(header)}})
        batch=catalog("preview",batch["id"],batch["revision"],{"rows":[
          {"line":2,"sku":sku,"values":patch,"errors":[]}]})
        assert batch["counts"]["error"]==0
        return catalog("apply",batch["id"],batch["revision"])
    def undo_import(batch):
        prepared=catalog("undo_preview",batch["id"],batch["revision"])
        undone=catalog("undo",prepared["id"],prepared["revision"])
        assert undone["state"]=="undone"
        assert catalog("undo",prepared["id"],prepared["revision"])["state"]=="undone"
        return undone
    def public_facts():
        raw=sql("SET ROLE anon; SELECT public_product_technical("+lit(pid)+")")
        return json.loads(raw) if raw else None
    def stable_history():
        return sql("""SELECT jsonb_build_object(
          'origins',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM technical_fact_origins t),
          'revisions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM technical_revisions t),
          'documents',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM document_intakes t))""")
    existing_facts=public_facts()
    assert existing_facts["values"][0]["value"]==195
    histories=stable_history()
    price_import=plain_import({"price":17,"stock_qty":3,"in_stock":True})
    assert public_facts()==existing_facts
    undo_import(price_import)
    assert public_facts()==existing_facts and stable_history()==histories
    # Changing identity invalidates the technical card; restoring the text is not approval.
    title_import=plain_import({"title":"[Учебный] Другая модификация","price":12})
    assert public_facts() is None
    undo_import(title_import)
    assert public_facts() is None and stable_history()==histories
    assert technical("read")["card"]["identity_review"]["required"]
    editor("apply",retained_session) # Completed receipt only.
    assert step("handoff",retained_review,payload=consent)["review"]["editor_session_id"]==retained_session["id"]
    assert public_facts() is None and stable_history()==histories
    # A fresh explicit preview/apply is required even when identity text was restored.
    identity_review=editor("start",source_revision=retained_session["applied_revision"])
    identity_review=editor("apply",editor("preview",identity_review))
    assert public_facts()["values"][0]["value"]==195
    if accessory_characteristics:
        # A new source is explicitly reviewed; values are not inferred from an old MMA passport.
        torch_text="Учебная горелка MODEL-220. Постоянный ток: 160 А; ПН 60 %. Только учебный режим."
        torch_file=upload(torch_text.encode())
        job=worker("claim")
        worker("finish",job["id"],job["lease"],{"version":"document-v1","sha256":torch_file["checksum"],
          "tables":[],"blocks":[{"locator":"page:1","page":1,"text":torch_text}],"warnings":[],"coverage":{"complete":True}})
        torch_source=approve_source(pid,torch_file["id"])
        torch_payload={"source_id":torch_source["source_id"],"result":{
          "version":"source-candidates-v1","checksum":torch_file["checksum"],"family_code":"tig_torch",
          "candidates":[{"attribute_code":"tig_torch_max_dc_a","unit_code":"a","process":"tig","value":160,
            "issues":["model_scope_review"],"evidence":{"kind":"block","block":0,"locator":"page:1","page":1,
              "start":0,"end":len(torch_text),"offset_unit":"unicode_codepoints","quote":torch_text}}],
          "unmatched_entries":[],"fields_without_candidates":[],"warnings":[]}}
        torch=facts("prepare",str(uuid.uuid4()),payload=torch_payload)
        step("accept",torch,error="TECH_CONTEXT_REQUIRED")
        torch=step("prompt",torch,payload={"field":"duty_pct"})
        torch=step("bind",torch,payload={"message_id":1941})
        torch=step("reply",torch,payload={"reply_to":1941,"value":60})
        step("accept",torch,error="TECH_CONTEXT_REQUIRED")
        torch=step("prompt",torch,payload={"field":"test_conditions"})
        torch=step("bind",torch,payload={"message_id":1942})
        torch=step("reply",torch,payload={"reply_to":1942,"value":"Только учебный режим."})
        torch=step("accept",torch)
        torch=step("publisher",torch,payload={"text":"Учебный изготовитель"})
        torch=step("preview",torch)
        step("handoff",torch,payload=consent,error="SOURCE_FACT_FAMILY_CONFIRM_REQUIRED")
        card_before=sql("SELECT row_to_json(c)::text FROM technical_cards c WHERE product_id="+lit(pid))
        transferred=step("handoff",torch,payload={**consent,"replace_family":True})
        torch_session=editor("get",{"id":transferred["review"]["editor_session_id"],"revision":0})
        assert sql("SELECT row_to_json(c)::text FROM technical_cards c WHERE product_id="+lit(pid))==card_before
        assert torch_session["data"]["document"]["family_code"]=="tig_torch"
        assert torch_session["data"]["document"]["values"][0]["context"]=={"duty_pct":60,"test_conditions":"Только учебный режим."}
        torch_session=editor("apply",editor("preview",torch_session))
        published_torch=public_facts()
        assert published_torch["family"]["code"]=="tig_torch"
        assert published_torch["values"][0]["value"]==160
        assert published_torch["values"][0]["context"]["duty_pct"]==60
        assert step("handoff",torch,payload={**consent,"replace_family":True})["review"]["editor_session_id"]==torch_session["id"]
        command(["docker","restart",NAME]);ready()
        assert public_facts()==published_torch
        accessory_report["checks"]+=["human_conditions_before_acceptance","explicit_family_change",
          "handoff_draft_only","separate_preview_apply","public_conditions","replay_and_restart"]
    # An imported model source changes the generation even if title and price are unchanged.
    previous_context=technical("read")["card"]["model_context"]
    pid_again,model_import,_=imported("MODEL-330")
    assert pid_again==pid and choice("get",pid)["current"]["state"]=="stale"
    assert public_facts() is None
    undo_import(model_import)
    assert choice("get",pid)["current"]["state"]=="selected"
    assert technical("read")["card"]["model_context"]!=previous_context
    assert public_facts() is None
    if accessory_characteristics:
        editor("apply",torch_session) # Receipt only; never refreshes the model binding.
        step("handoff",torch,payload={**consent,"replace_family":True})
        assert public_facts() is None
    stale_copy=editor("start",source_revision=identity_review["applied_revision"])
    assert not stale_copy["source_binding"]["usable"]
    editor("preview",stale_copy,error="TECH_SOURCE_REVIEW_REQUIRED")
    editor("cancel",stale_copy)
    # Old source/handoff/apply receipts cannot refresh the source generation.
    act("confirm",third_approval)
    editor("apply",identity_review)
    step("handoff",retained_review,payload=consent)
    assert public_facts() is None
    # Exclusion is an explicit audited assortment action, never a raw fixture update.
    def assortment(op,batch=None,value="",revision=None):
        args=["101",lit(op),lit(batch) if batch else "NULL",lit(value),"0",lit("CHOICE-A"),
          str(revision) if revision is not None else "NULL"]
        return json.loads(sql("SET ROLE service_role; SELECT bot_assortment("+",".join(args)+")"))
    excluded=assortment("start",value="all")
    excluded=assortment("all",excluded["id"])
    assert excluded["selected"]==1
    excluded=assortment("preview",excluded["id"],"exclude",excluded["revision"])
    assortment("apply",excluded["id"])
    def assert_excluded():
        assert sql("SELECT status||':'||assortment_decision FROM products WHERE id="+lit(pid))=="hidden:excluded"
        assert public_facts() is None
        assert sql("SET ROLE anon; SELECT count(*) FROM products WHERE id="+lit(pid))=="0"
    assert_excluded()
    excluded_history=stable_history()
    repeat=plain_import({"title":"[Учебный] Повторная поставка","price":25,"stock_qty":10,"in_stock":True})
    assert repeat["counts"]["excluded"]==1
    assert_excluded()
    undo_import(repeat)
    assert_excluded()
    assert stable_history()==excluded_history
    editor("apply",identity_review)
    assert_excluded()
    command(["docker","restart",NAME]);ready()
    assert_excluded()
    assert stable_history()==excluded_history
    print(json.dumps({"ok":True,"accessory_characteristics":accessory_report,"documentary_conditions":({
      "proposal_sha256":hashlib.sha256(proposal.encode()).hexdigest(),
      "checks":["exact_unicode","existing_rows_unchanged","existing_acl_unchanged","distinct_conditions",
        "required_condition","bound_human_reply","decision_withdrawal","restart_question","handoff_receipt",
        "atomic_install_preservation","install_corruption_rollback","wrong_instance_rollback",
        "changed_baseline_rollback","late_failure_no_receipt","installed_repeat_refused"]
      } if documentary_conditions else None),"migration_sha256":hashlib.sha256(migration.encode()).hexdigest(),
      "handoff_migration_sha256":hashlib.sha256(handoff_migration.encode()).hexdigest(),
      "origin_migration_sha256":hashlib.sha256(origin_migration.encode()).hexdigest(),
      "checks":["private_roles","exact_unicode_quote","table_origin","foreign_source","stable_prepare",
       "audit_atomicity","CAS","human_corrections","required_conditions","duplicate_resolution",
       "bound_questions","restart_with_question","explicit_resume","cancel_input","exclusive_editors_both_orders","concurrent_editor_starts",
       "reply_audit_atomicity","revoked_restored_role","expired_question","row_action_invalidates_question","withdrawn_source_question",
       "publisher_required","preview_only","same_page_grouping","ui_response_contract","next_pending","old_data_preserved","restart",
       "stale_base","withdrawn_source","cancel_receipt","merge_preserves_old_facts","merge_source_collision",
       "merge_equal_conditions","merge_family_removal","merge_limits_no_truncation","merge_bounds","merge_ui_contract",
       "merge_rpc_previous_revision","merge_rejects_previous_model","origin_private","origin_immutable","origin_preserved_on_save",
       "origin_removed_rejected","origin_source_replacement_rejected","withdrawn_origin_hides_public","withdrawn_origin_blocks_apply",
       "clone_keeps_origin","renewed_source_does_not_reauthorize","origin_receipt_no_republish","origin_undo_guard","explicit_removal_and_new_review",
       "origin_registration_matches_accepted_row","origin_inactive_before_handoff","origin_ui_contract",
       "handoff_permissions","handoff_confirmation","handoff_expiry","handoff_changed_base","handoff_frozen_plan",
       "handoff_withdrawn_source","handoff_preserves_existing_editor","handoff_audit_atomicity","handoff_concurrency",
       "handoff_no_publication","handoff_restart_receipt","handoff_retained_stale_facts","handoff_family_consent",
       "handoff_receipt_not_later_session","handoff_ui_contract","application_schema_compatibility",
       "price_import_preserves_facts","price_undo_preserves_facts","identity_import_and_undo_require_review",
       "identity_old_receipts_no_republish","model_reimport_and_undo_keep_stale_origins","old_source_receipts_no_refresh",
       "excluded_reimport_and_undo_stay_hidden","import_preserves_immutable_history","excluded_restart"]}))
finally:
    if created:subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
