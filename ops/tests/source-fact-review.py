#!/usr/bin/env python3
"""Isolated PostgreSQL: source-backed fact decisions, question binding and recovery."""
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
    print(json.dumps({"ok":True,"migration_sha256":hashlib.sha256(migration.encode()).hexdigest(),
      "checks":["private_roles","exact_unicode_quote","table_origin","foreign_source","stable_prepare",
       "audit_atomicity","CAS","human_corrections","required_conditions","duplicate_resolution",
       "bound_questions","restart_with_question","explicit_resume","cancel_input","exclusive_editors_both_orders","concurrent_editor_starts",
       "reply_audit_atomicity","revoked_restored_role","expired_question","row_action_invalidates_question","withdrawn_source_question",
       "publisher_required","preview_only","same_page_grouping","ui_response_contract","next_pending","old_data_preserved","restart",
       "stale_base","withdrawn_source","cancel_receipt","merge_preserves_old_facts","merge_source_collision",
       "merge_equal_conditions","merge_family_removal","merge_limits_no_truncation","merge_bounds","merge_ui_contract",
       "merge_rpc_previous_revision","merge_rejects_previous_model"]}))
finally:
    if created:subprocess.run(["docker","rm","-f",NAME],capture_output=True)
