#!/usr/bin/env python3
"""Real PostgreSQL tests in a disposable, network-isolated container. No DEV/prod writes."""
import concurrent.futures
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-assortment-qa-" + uuid.uuid4().hex[:12]

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)

def sql(query, check=True):
    result = subprocess.run(
        ["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-At", "-v", "ON_ERROR_STOP=1"],
        input=query, text=True, capture_output=True,
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result

def scalar(query):
    return sql(query).stdout.strip()

def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"

def rpc(op, batch=None, value="", page=0, query="", revision=None, actor=101, error=None):
    args = ",".join(map(quote, [actor, op, batch, value, page, query, revision]))
    result = sql("SET ROLE service_role; SELECT public.bot_assortment(" + args + ");", check=not error)
    if error:
        assert result.returncode and error in result.stderr, result.stderr
        return None
    return json.loads(result.stdout.splitlines()[-1])

def preview(action, actor=101, query="QA"):
    result = rpc("start", value="all", query=query, actor=actor)
    result = rpc("all", result["id"], actor=actor)
    return rpc("preview", result["id"], value=action, revision=result["revision"], actor=actor)

created = False
try:
    run(["docker", "run", "-d", "--name", NAME, "--network", "none",
         "--label", "mw.environment=isolated-qa",
         "--tmpfs", "/var/lib/postgresql/data",
         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    created = True
    for _ in range(80):
        ready = subprocess.run(["docker", "exec", NAME, "pg_isready", "-U", "postgres"],
                               capture_output=True)
        if ready.returncode == 0:
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
    INSERT INTO categories(id,slug,name) VALUES('11111111-1111-4111-8111-111111111111','qa','Сварочные маски');
    INSERT INTO products(slug,title,sku,brand,price,status,category_id)
      SELECT 'qa-'||i,'QA товар '||lpad(i::text,4,'0'),'QA-'||i,'Учебный',100,'published',
        '11111111-1111-4111-8111-111111111111' FROM generate_series(1,1105) i;
    INSERT INTO product_photos(product_id,url,is_main) SELECT id,'/qa-placeholder.png',true FROM products;
    INSERT INTO product_costs(product_id,cost_price) SELECT id,30 FROM products;
    INSERT INTO shop_orders(name,phone,items,total)
      SELECT 'QA receipt','+79990000000',jsonb_agg(jsonb_build_object('id',id,'title',title,'price',price,'qty',1)),100
      FROM products WHERE slug='qa-1';
    """)
    receipt = scalar("SELECT md5(row_to_json(o)::text) FROM shop_orders o")
    counts = scalar("SELECT (SELECT count(*) FROM product_photos)||','||(SELECT count(*) FROM product_costs)")
    # Search tokens include category/brand; wildcard characters are literal, not SQL patterns.
    assert rpc("start", value="all", query="маски учебный")["total"] == 1105
    assert rpc("start", value="all", query="%")["total"] == 0
    assert rpc("home")["counts"]["review"] == 1105
    for actor in [103, 104, 105, 999]:
        rpc("home", actor=actor, error="ASSORT_DENIED")
    assert rpc("home", actor=106)["ok"]
    assert scalar("SELECT has_function_privilege('anon','bot_assortment(bigint,text,uuid,text,integer,text,integer)','EXECUTE')") == "f"
    assert scalar("SELECT has_table_privilege('service_role','assortment_batches','INSERT')") == "f"
    assert scalar("SELECT has_table_privilege('anon','assortment_batch_items','SELECT')") == "f"
    # Select >1000, move to final page, no PostgREST result-cap truncation.
    b = rpc("start", value="review")
    assert b["total"] == 1105 and b["pages"] == 139 and b["selected"] == 0
    rpc("apply", b["id"], error="ASSORT_CLOSED")
    rpc("preview", b["id"], value="exclude", revision=0, error="ASSORT_EMPTY")
    b = rpc("all", b["id"])
    assert b["selected"] == 1105
    assert len(rpc("get", b["id"], page=138)["items"]) == 1
    old_revision = b["revision"]
    b = rpc("unselect", b["id"], value="1")
    b = rpc("unselect", b["id"], value="1")  # desired state, not a replay-sensitive toggle
    assert b["selected"] == 1104
    rpc("preview", b["id"], value="exclude", revision=old_revision, error="ASSORT_STALE")
    b = rpc("preview", b["id"], value="exclude", revision=b["revision"])
    rpc("apply", b["id"], actor=102, error="ASSORT_NOT_FOUND")
    rpc("all", b["id"], error="ASSORT_CLOSED")
    # New matching rows after preview must never join the frozen batch.
    sql("INSERT INTO products(slug,title,price,status) VALUES('new-later','QA later',50,'published')")
    applied = rpc("apply", b["id"])
    assert applied["state"] == "applied"
    assert scalar("SELECT count(*) FROM products WHERE assortment_decision='excluded'") == "1104"
    assert scalar("SET ROLE anon; SELECT count(*) FROM products").splitlines()[-1] == "2"
    assert scalar("SELECT status FROM products WHERE slug='new-later'") == "published"
    assert rpc("apply", b["id"])["state"] == "applied"
    assert scalar("SELECT count(*) FROM staff_audit_log WHERE action='assortment_apply'") == "1"
    assert scalar("SELECT md5(row_to_json(o)::text) FROM shop_orders o") == receipt
    assert scalar("SELECT (SELECT count(*) FROM product_photos)||','||(SELECT count(*) FROM product_costs)") == counts
    assert "excluded_products_hidden" in sql("UPDATE products SET status='published' WHERE assortment_decision='excluded'", False).stderr
    rpc("undo", b["id"], error="ASSORT_CLOSED")
    rpc("undo_preview", b["id"])
    assert rpc("undo", b["id"])["state"] == "undone"
    rpc("undo", b["id"])
    assert scalar("SELECT count(*) FROM staff_audit_log WHERE action='assortment_undo'") == "1"
    assert scalar("SELECT count(*) FROM products WHERE assortment_decision='excluded'") == "0"
    # Conflict rolls back every selected row; newer edits survive.
    b = preview("exclude")
    sql("UPDATE products SET price=price+1 WHERE slug='qa-2'")
    rpc("apply", b["id"], error="ASSORT_CONFLICT")
    assert scalar("SELECT count(*) FROM products WHERE assortment_decision='excluded'") == "0"
    # Same-transaction edits also increment revision (updated_at alone cannot guarantee this).
    result = sql("BEGIN; UPDATE products SET price=price+1 WHERE slug='qa-3'; SELECT public.bot_assortment(101,'apply'," + quote(b["id"]) + "); COMMIT;", False)
    assert "ASSORT_CONFLICT" in result.stderr
    # Atomic cancel and expiration.
    rpc("cancel", b["id"])
    rpc("apply", b["id"], error="ASSORT_CLOSED")
    b = preview("hide")
    sql("UPDATE assortment_batches SET expires_at=now()-interval '1 minute' WHERE id=" + quote(b["id"]))
    rpc("apply", b["id"], error="ASSORT_EXPIRED")
    # Concurrent different admins: exactly one succeeds against the same snapshot.
    a = preview("hide", actor=101, query="QA-1105")
    b = preview("exclude", actor=102, query="QA-1105")
    def attempt(pair):
        batch, actor = pair
        return sql("SELECT public.bot_assortment(" + str(actor) + ",'apply'," + quote(batch["id"]) + ");", False)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, [(a,101),(b,102)]))
    assert sum(r.returncode == 0 for r in results) == 1
    assert sum("ASSORT_CONFLICT" in r.stderr for r in results) == 1
    # Duplicate confirmations, including parallel connections, create a single audit.
    b = preview("exclude", query="QA-1104")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(attempt, [(b,101)] * 8))
    assert all(r.returncode == 0 for r in results)
    assert scalar("SELECT count(*) FROM staff_audit_log WHERE action='assortment_apply' AND details->>'batch_id'=" + quote(b["id"])) == "1"
    rpc("undo_preview", b["id"])
    sql("UPDATE products SET price=price+1 WHERE slug='qa-1104'")
    rpc("undo", b["id"], error="ASSORT_CONFLICT")
    assert scalar("SELECT assortment_decision FROM products WHERE slug='qa-1104'") == "excluded"
    # Sell does not publish; review restores as a draft.
    b = preview("sell", query="QA-1104")
    rpc("apply", b["id"])
    assert scalar("SELECT assortment_decision||','||status FROM products WHERE slug='qa-1104'") == "sell,hidden"
    b = preview("review", query="QA-1104")
    rpc("apply", b["id"])
    assert scalar("SELECT assortment_decision||','||status FROM products WHERE slug='qa-1104'") == "review,draft"
    # Photo edits don't bump product revision: undo must independently recheck readiness.
    b = preview("exclude", query="QA-1103")
    rpc("apply", b["id"])
    rpc("undo_preview", b["id"])
    sql("UPDATE product_photos SET deleted_at=now() WHERE product_id=(SELECT id FROM products WHERE slug='qa-1103')")
    rpc("undo", b["id"], error="ASSORT_NOT_READY")
    # Permission is rechecked on confirmation, not only at menu time.
    b = preview("hide", actor=106, query="QA-1102")
    sql("UPDATE staff SET elevated=false WHERE telegram_id=106")
    rpc("apply", b["id"], actor=106, error="ASSORT_DENIED")
    # Auditing is in the same transaction, so unavailable journal rolls product writes back.
    b = preview("exclude", query="QA-1101")
    sql("""CREATE FUNCTION qa_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'QA_AUDIT_FAILED'; END $$;
      CREATE TRIGGER qa_fail BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION qa_fail_audit();""")
    rpc("apply", b["id"], error="QA_AUDIT_FAILED")
    assert scalar("SELECT assortment_decision FROM products WHERE slug='qa-1101'") == "review"
    sql("DROP TRIGGER qa_fail ON staff_audit_log")
    # More than 5000 requires a narrower search, never silently truncates.
    sql("INSERT INTO products(slug,title) SELECT 'extra-'||i,'QA extra '||i FROM generate_series(1,4000) i")
    rpc("start", value="all", error="ASSORT_TOO_MANY")
    assert rpc("get", b["id"])["state"] == "preview", "Failed start must preserve earlier selection"
    print(json.dumps({
      "database": "disposable PostgreSQL 17.6", "bulkSelection": 1105,
      "concurrentConfirmations": 8, "duplicateAuditRows": 0,
      "crossActorDenied": True, "roleRevocationDenied": True, "atomicConflict": True,
      "receiptPhotosCostsPreserved": True, "publicVisibility": True,
      "undoAndPublicationGuards": True, "maxBatchNotTruncated": True,
    }))
finally:
    if created:
        run(["docker", "rm", "-f", NAME])
