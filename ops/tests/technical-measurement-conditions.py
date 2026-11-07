#!/usr/bin/env python3
"""Isolated PostgreSQL: real duplicates versus distinct measurement conditions."""
import copy
import datetime
import hashlib
import json
import pathlib
import subprocess
import time
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[2]
NAME="mw-tech-conditions-qa-"+uuid.uuid4().hex[:12]
PID="10000000-0000-4000-8000-000000000038"
def run(args):
    return subprocess.run(args,check=True,capture_output=True,text=True)
def sql(query,error=None):
    r=subprocess.run(["docker","exec","-i",NAME,"psql","-X","-Atq","-U","postgres","-v","ON_ERROR_STOP=1"],
        input=query,capture_output=True,text=True)
    if error: assert r.returncode and error in r.stderr,r.stderr
    elif r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip()
def lit(v):
    return "'"+str(v).replace("'","''")+"'"
def fact(value,current=160,temp=40):
    return {"attribute_code":"mma_duty_cycle_pct","process":"mma","state":"known","value":value,
      "unit_code":"pct","context":{"current_a":current,"temperature_c":temp},"source_key":"manual"}
def document(values):
    return {"family_code":"power_mma","sources":[{"key":"manual","kind":"synthetic","publisher":"Учебный изготовитель",
      "model":"Учебная модель","title":"[Учебный] Разные условия измерения","url":"https://example.invalid/conditions",
      "locator":"Учебная таблица","checked_on":datetime.date.today().isoformat(),"sha256":""}],"values":values}
def validate(doc,error=None):
    return sql("SELECT validate_technical_document("+lit(json.dumps(doc))+",'verified');",error)
def snapshot():
    names=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
    return {t:sql('SELECT md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),\'\')) FROM public."'+t+'" t') for t in names}
def rpc(op,doc=None,change=None,error=None):
    model=json.loads(sql("SELECT mw_private.technical_model_context("+lit(PID)+")"))
    version=sql("SELECT coalesce((SELECT version FROM technical_cards WHERE product_id="+lit(PID)+"),0)")
    args=["101",lit(op),lit(PID),lit(change) if change else "NULL",lit(json.dumps(doc)) if doc else "NULL",
          "'verified'",version,lit(json.dumps(model))]
    raw=sql("SET ROLE service_role; SELECT bot_technical_catalog("+",".join(args)+")",error)
    return json.loads(raw) if not error else None
created=False
try:
    run(["docker","run","-d","--name",NAME,"--network","none","--label","mw.environment=isolated-qa",
         "-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17.6-alpine"])
    created=True
    for _ in range(100):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0:break
        time.sleep(.2)
    else:raise RuntimeError("PG_NOT_READY")
    paths=[ROOT/"ops/dev/bootstrap.sql",*sorted((ROOT/"drizzle/migrations").glob("*.sql")),
      *[p for p in sorted((ROOT/"docs/migrations").glob("*.sql")) if p.name[:4]<="0037"]]
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in paths)+"\nCOMMIT;")
    sql((ROOT/"ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role) VALUES(101,'Admin','admin')")
    sql("INSERT INTO products(id,sku,slug,title,price,status) VALUES("+lit(PID)+",'TEST-CONDITIONS','test-conditions','Учебный товар',10,'published')")
    doc=document([fact(60),fact(100,120)])
    validate(doc,error="TECH_BAD_VALUE")  # Reproduce the existing server/editor inconsistency.
    before=snapshot()
    migration=(ROOT/"docs/migrations/0038_technical_measurement_conditions.sql").read_text()
    sql("BEGIN;"+migration+"COMMIT;")
    assert snapshot()==before,"MIGRATION_CHANGED_ROWS"
    validate(doc)
    validate(document([fact(60),fact(100,160,20)]))
    validate(document([fact(60),fact(60)]),error="TECH_BAD_VALUE")
    same=fact(70,160.0,40.0)
    same["context"]={"temperature_c":40.0,"current_a":160.0}
    validate(document([fact(60),same]),error="TECH_BAD_VALUE")
    missing=fact(60);del missing["context"]["temperature_c"]
    validate(document([missing]),error="TECH_CONTEXT_REQUIRED")
    bad=fact(101)
    validate(document([bad]),error="TECH_BAD_RANGE")
    wrong_unit=fact(60);wrong_unit["unit_code"]="a"
    validate(document([wrong_unit]),error="TECH_BAD_VALUE")
    low=fact(180);low.update(attribute_code="mma_current_min_a",unit_code="a")
    high=fact(160);high.update(attribute_code="mma_current_max_a",unit_code="a")
    validate(document([low,high]),error="TECH_REVERSED_RANGE")
    high["context"]["temperature_c"]=20
    validate(document([low,high]))
    # Only the definer RPC can write. The validator remains a private helper.
    for role in ["anon","authenticated","service_role"]:
        assert sql("SELECT has_function_privilege("+lit(role)+",'validate_technical_document(jsonb,text)','EXECUTE')")=="f"
    prepared=rpc("preview",doc)
    first=rpc("apply",change=prepared["change_id"])
    rpc("apply",change=prepared["change_id"])
    assert sql("SELECT count(*) FROM technical_revisions WHERE product_id="+lit(PID))=="1"
    public=json.loads(sql("SET ROLE anon; SELECT public_product_technical("+lit(PID)+")"))
    assert len(public["values"])==2
    assert sorted(v["context"]["current_a"] for v in public["values"])==[120,160]
    run(["docker","restart",NAME])
    for _ in range(100):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0:break
        time.sleep(.2)
    else:raise RuntimeError("PG_RESTART")
    assert json.loads(sql("SET ROLE anon; SELECT public_product_technical("+lit(PID)+")"))==public
    rpc("undo",change=prepared["change_id"])
    assert sql("SET ROLE anon; SELECT public_product_technical("+lit(PID)+")")==""
    sql("BEGIN;"+migration+"COMMIT;",error="TECH_CONDITIONS_BASELINE")
    print(json.dumps({"ok":True,"migration_sha256":hashlib.sha256(migration.encode()).hexdigest(),
      "checks":["old_bug_reproduced","data_preserved","distinct_conditions","numeric_context_equality",
        "real_duplicates_rejected","required_conditions","units_ranges","private_helper","public_values",
        "apply_receipt","restart","undo"]}))
finally:
    if created:subprocess.run(["docker","rm","-f",NAME],capture_output=True)
