#!/usr/bin/env python3
"""Catalog import transactions in a disposable PostgreSQL, no network/DEV/prod access."""
import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-import-qa-" + uuid.uuid4().hex[:12]
seq = 0

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)

def sql(query, check=True):
    r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-At", "-v", "ON_ERROR_STOP=1"],
                       input=query, text=True, capture_output=True)
    if check and r.returncode:
        raise RuntimeError(r.stderr)
    return r

def scalar(query):
    return sql(query).stdout.strip()

def literal(x):
    if x is None:
        return "NULL"
    if isinstance(x, int):
        return str(x)
    return "'" + str(x).replace("'", "''") + "'"

def rpc(op, batch=None, payload=None, revision=None, actor=101, page=0, error=None):
    args = [actor, op, batch, json.dumps(payload or {}), page, revision]
    result = sql("SET ROLE service_role; SELECT bot_catalog_import(" + ",".join(map(literal, args)) + ");", not error)
    if error:
        assert result.returncode and error in result.stderr, result.stderr
        return None
    return json.loads(result.stdout.splitlines()[-1])

def row(sku, values, line=2, errors=None):
    return {"line": line, "sku": sku, "values": values, "errors": errors or []}

def upload(rows, actor=101):
    global seq
    seq += 1
    payload = {"request_key": str(seq), "file_name": "qa.csv", "checksum": hashlib.sha256(json.dumps(rows).encode()).hexdigest(),
               "source": {"header": ["sku", "price"], "rows": [[r["sku"], "10"] for r in rows]},
               "mapping": {"sku": 0, "price": 1}}
    b = rpc("upload", payload=payload, actor=actor)
    assert rpc("upload", payload=payload, actor=actor)["id"] == b["id"]
    return b

def preview(rows, actor=101):
    b = upload(rows, actor)
    return rpc("preview", b["id"], {"rows": rows}, revision=b["revision"], actor=actor)

created = False
try:
    run(["docker", "run", "-d", "--name", NAME, "--network", "none", "--label", "mw.environment=isolated-qa",
         "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    created = True
    for _ in range(120):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], capture_output=True).returncode == 0:
            break
        time.sleep(0.25)
    else:
        raise RuntimeError("QA_POSTGRES_NOT_READY")
    paths = [ROOT / "ops/dev/bootstrap.sql", *sorted((ROOT / "drizzle/migrations").glob("*.sql")),
             *sorted((ROOT / "docs/migrations").glob("*.sql"))]
    sql("BEGIN;\n" + "\n".join(p.read_text() for p in paths) + "\nCOMMIT;")
    sql("""
    INSERT INTO staff(telegram_id,name,role,elevated,active) VALUES
      (101,'QA admin','admin',false,true),(102,'QA other','admin',false,true),
      (103,'QA seller','seller',false,true),(104,'QA inactive','admin',false,false),
      (105,'QA director','director',false,true),(106,'QA full','director',true,true);
    INSERT INTO products(slug,sku,title,price,status,assortment_decision,in_stock,stock_qty) VALUES
      ('keep','KEEP','Keep original',100,'published','sell',true,5),
      ('excluded','EXCLUDED','Excluded original',200,'hidden','excluded',false,0),
      ('untouched','UNTOUCHED','Outside the file',300,'published','review',true,2);
    INSERT INTO product_costs(product_id,cost_price) SELECT id,80 FROM products WHERE sku='KEEP';
    INSERT INTO product_photos(product_id,url) SELECT id,'/qa.png' FROM products;
    INSERT INTO shop_orders(name,phone,items,total) VALUES('QA receipt','+79990000000','[{"sku":"KEEP","title":"Old title","price":100,"qty":1}]',100);
    """)
    orders = scalar("SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY id)::text) FROM shop_orders o")
    untouched = scalar("SELECT to_jsonb(p) FROM products p WHERE sku='UNTOUCHED'")
    for actor in [103, 104, 105, 999]:
        rpc("home", actor=actor, error="IMPORT_DENIED")
    assert rpc("home", actor=106)["ok"]
    assert scalar("SELECT has_function_privilege('anon','bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)','EXECUTE')") == "f"
    assert scalar("SELECT has_table_privilege('service_role','catalog_imports','UPDATE')") == "f"
    assert scalar("SELECT has_table_privilege('anon','catalog_import_items','SELECT')") == "f"
    assert scalar("SELECT has_function_privilege('service_role','bot_import_apply(uuid,bigint)','EXECUTE')") == "f"
    # Preview only; excluded goods stay excluded even when title, price and stock change.
    rows = [row("KEEP", {"price":125, "cost_price":90}),
            row("EXCLUDED", {"price":250, "title":"Excluded changed", "in_stock":True},3),
            row("NEW-1", {"price":75, "title":"New draft", "cost_price":50},4)]
    b = preview(rows)
    assert b["counts"] == {"new":1,"update":2,"unchanged":0,"error":0,"excluded":1}
    assert scalar("SELECT price FROM products WHERE sku='KEEP'") == "100.00"
    rpc("get", b["id"], actor=102, error="IMPORT_NOT_FOUND")
    rpc("apply", b["id"], revision=b["revision"]-1, error="IMPORT_STALE")
    rpc("apply", b["id"], revision=b["revision"])
    rpc("apply", b["id"], revision=b["revision"])
    assert scalar("SELECT count(*) FROM staff_audit_log WHERE action='catalog_import_apply'") == "1"
    assert scalar("SELECT status||','||assortment_decision||','||price FROM products WHERE sku='EXCLUDED'") == "hidden,excluded,250.00"
    assert scalar("SELECT status||','||assortment_decision FROM products WHERE sku='NEW-1'") == "draft,review"
    assert scalar("SELECT status||','||assortment_decision FROM products WHERE sku='KEEP'") == "published,sell"
    assert scalar("SET ROLE anon; SELECT count(*) FROM products WHERE sku IN ('EXCLUDED','NEW-1')").splitlines()[-1] == "0"
    assert scalar("SELECT to_jsonb(p) FROM products p WHERE sku='UNTOUCHED'") == untouched
    assert scalar("SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY id)::text) FROM shop_orders o") == orders
    rpc("undo", b["id"], error="IMPORT_CLOSED")
    rpc("undo_preview", b["id"])
    rpc("undo", b["id"])
    rpc("undo", b["id"])
    assert scalar("SELECT price FROM products WHERE sku='KEEP'") == "100.00"
    assert scalar("SELECT cost_price FROM product_costs c JOIN products p ON p.id=c.product_id WHERE sku='KEEP'") == "80.00"
    assert scalar("SELECT status||','||assortment_decision FROM products WHERE sku='NEW-1'") == "hidden,excluded"
    assert scalar("SELECT title||','||status||','||assortment_decision FROM products WHERE sku='EXCLUDED'") == "Excluded original,hidden,excluded"
    assert scalar("SELECT count(*) FROM product_photos") == "3"
    assert scalar("SELECT count(*) FROM staff_audit_log WHERE action='catalog_import_undo'") == "1"
    # Re-importing a rolled-back new product cannot resurrect it.
    c = preview([row("NEW-1",{"price":77,"title":"Same archived product"})])
    assert c["counts"]["new"] == 0 and c["counts"]["excluded"] == 1
    rpc("apply", c["id"], revision=c["revision"])
    assert scalar("SELECT status||','||assortment_decision FROM products WHERE sku='NEW-1'") == "hidden,excluded"
    # Atomic rejection of invalid/ambiguous SKU/unknown category/unauthorized fields.
    invalid_sets = [
      [row("KEEP",{"price":120}), row("keep",{"price":130},3)],
      [row("MISSING-TITLE",{"price":10})],
      [row("KEEP",{"category_slug":"missing"})],
      [row("KEEP",{},errors=["FORMULA"])],
      [row("KEEP",{"price":-10})],
    ]
    for invalid in invalid_sets:
        c = preview(invalid)
        assert c["counts"]["error"] > 0
        rpc("apply", c["id"], revision=c["revision"], error="IMPORT_BLOCKED")
    c = upload([row("KEEP",{"status":"published"})])
    rpc("preview", c["id"], {"rows":[row("KEEP",{"status":"published"})]}, revision=0, error="IMPORT_BAD_INPUT")
    sql("INSERT INTO products(slug,sku,title) VALUES('ambiguous','keep','Duplicate SKU')")
    c = preview([row("KEEP",{"price":110})])
    assert c["counts"]["error"] == 1
    sql("DELETE FROM products WHERE slug='ambiguous'")  # own isolated fixture only
    # A late SKU insertion cannot make a second card.
    c = preview([row("LATE",{"price":10,"title":"Late insert"})])
    sql("INSERT INTO products(slug,sku,title) VALUES('late','LATE','New from another writer')")
    rpc("apply", c["id"], revision=c["revision"], error="IMPORT_CONFLICT")
    assert scalar("SELECT count(*) FROM products WHERE sku='LATE'") == "1"
    # Assortment changed after preview: import may not overwrite or ignore that decision.
    c = preview([row("KEEP",{"price":115})])
    sql("UPDATE products SET assortment_decision='excluded',status='hidden' WHERE sku='KEEP'")
    rpc("apply", c["id"], revision=c["revision"], error="IMPORT_CONFLICT")
    c = preview([row("KEEP",{"price":115})])
    rpc("apply", c["id"], revision=c["revision"])
    assert scalar("SELECT status||','||assortment_decision FROM products WHERE sku='KEEP'") == "hidden,excluded"
    rpc("undo_preview",c["id"])
    sql("UPDATE products SET title='Subsequent edit' WHERE sku='KEEP'")
    rpc("undo",c["id"],error="IMPORT_CONFLICT")
    assert scalar("SELECT title FROM products WHERE sku='KEEP'") == "Subsequent edit"
    # Private cost changes also invalidate confirmation, including imports not writing cost.
    c = preview([row("KEEP",{"price":116})])
    sql("UPDATE product_costs SET cost_price=81 WHERE product_id=(SELECT id FROM products WHERE sku='KEEP')")
    rpc("apply",c["id"],revision=c["revision"],error="IMPORT_CONFLICT")
    # Expiry, configuration revision and permission revocation.
    c = upload([row("KEEP",{"price":116})])
    c = rpc("map",c["id"],{"field":"price","column":1},revision=0)
    rpc("preview",c["id"],{"rows":[row("KEEP",{"price":116})]},revision=0,error="IMPORT_STALE")
    c = preview([row("KEEP",{"price":116})], actor=106)
    sql("UPDATE staff SET elevated=false WHERE telegram_id=106")
    rpc("apply",c["id"],revision=c["revision"],actor=106,error="IMPORT_DENIED")
    c = preview([row("KEEP",{"price":116})])
    sql("UPDATE catalog_imports SET expires_at=now()-interval '1 minute' WHERE id="+literal(c["id"]))
    rpc("apply",c["id"],revision=c["revision"],error="IMPORT_EXPIRED")
    # Repeated concurrent confirmations create one batch of 1105 products.
    big = [row("BULK-"+str(i),{"title":"QA bulk "+str(i),"price":10},i+2) for i in range(1105)]
    start = time.monotonic()
    c = preview(big)
    assert c["counts"]["new"] == 1105 and c["pages"] == 369
    def apply(pair):
        batch,actor=pair
        return sql("SELECT bot_catalog_import("+str(actor)+",'apply',"+literal(batch["id"])+",'{}',0,"+str(batch["revision"])+");",False)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(apply,[(c,101)]*8))
    assert all(r.returncode==0 for r in results)
    assert scalar("SELECT count(*) FROM products WHERE sku LIKE 'BULK-%'")=="1105"
    assert scalar("SELECT count(*) FROM staff_audit_log WHERE action='catalog_import_apply' AND details->>'batch_id'="+literal(c["id"]))=="1"
    rpc("undo_preview",c["id"]); rpc("undo",c["id"])
    assert scalar("SELECT count(*) FROM products WHERE sku LIKE 'BULK-%' AND assortment_decision='excluded' AND status='hidden'")=="1105"
    # Distinct administrators with overlapping snapshots: second one must conflict.
    a=preview([row("EXCLUDED",{"price":201})],actor=101)
    b=preview([row("EXCLUDED",{"price":202})],actor=102)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(apply,[(a,101),(b,102)]))
    assert sum(r.returncode==0 for r in results)==1
    assert sum("IMPORT_CONFLICT" in r.stderr for r in results)==1
    # Mandatory audit failure rolls product mutation back.
    c=preview([row("EXCLUDED",{"price":999})])
    before=scalar("SELECT price FROM products WHERE sku='EXCLUDED'")
    sql("""CREATE FUNCTION qa_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'QA_AUDIT_FAILED'; END $$;
      CREATE TRIGGER qa_fail BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION qa_fail();""")
    rpc("apply",c["id"],revision=c["revision"],error="QA_AUDIT_FAILED")
    assert scalar("SELECT price FROM products WHERE sku='EXCLUDED'")==before
    assert scalar("SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY id)::text) FROM shop_orders o")==orders
    print(json.dumps({"engine":"PostgreSQL 17.6","bulkProducts":1105,"concurrentConfirmations":8,
      "excludedRemainHidden":True,"rollbackArchivesNew":True,"ordersPreserved":True,"conflictsAtomic":True,
      "costsPrivate":True,"legacyWritesRevoked":True,"bulkPhaseSeconds":round(time.monotonic()-start,2)}))
finally:
    if created:
        run(["docker","rm","-f",NAME])
