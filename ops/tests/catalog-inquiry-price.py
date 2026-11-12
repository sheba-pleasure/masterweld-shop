#!/usr/bin/env python3
"""Isolated 0043 -> 0045 SQL acceptance. No live data, bot delivery or email."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/dev"))
import app_compatibility as guard

spec = importlib.util.spec_from_file_location("inquiry_installation", ROOT / "ops/dev/apply-inquiry-prices.py")
installation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installation)

NAME = "mw-inquiry-price-qa-" + uuid.uuid4().hex[:12]


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=180)


def sql(query, error=None):
    result = subprocess.run(
        ["docker", "exec", "-i", NAME, "psql", "-X", "-Atq", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
        input=query, capture_output=True, text=True, timeout=120,
    )
    if error:
        assert result.returncode and error in result.stderr, result.stderr
    elif result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def rpc(op, batch=None, payload=None, revision=None, actor=101, error=None):
    query = "SET ROLE service_role; SELECT bot_catalog_import(" + ",".join([
        str(actor), literal(op), literal(batch) if batch else "NULL",
        literal(json.dumps(payload or {})), "0", str(revision) if revision is not None else "NULL",
    ]) + ");"
    result = sql(query, error)
    return json.loads(result) if not error else None


def assortment(op, batch=None, value="", query="", revision=None, error=None):
    args = ["101", literal(op), literal(batch) if batch else "NULL", literal(value),
            "0", literal(query), str(revision) if revision is not None else "NULL"]
    result = sql("SET ROLE service_role; SELECT bot_assortment(" + ",".join(args) + ");", error)
    return json.loads(result) if not error else None


sequence = 0


def upload():
    global sequence
    sequence += 1
    return rpc("upload", payload=dict(
        request_key=str(sequence), checksum="a" * 64, file_name="Isolated inquiry fixture.csv",
        source=dict(header=["Артикул", "Название"], rows=[["NEW-" + str(sequence), "Учебная модель"]]),
        mapping=dict(sku=0, title=1, brand=-1, price=-1, cost_price=-1, in_stock=-1, stock_qty=-1, category_slug=-1),
    ))


def row(sku, **values):
    return dict(line=2, sku=sku, values=values, errors=[])


created = False
try:
    command(["docker", "run", "-d", "--name", NAME, "--network", "none", "--label",
             "mw.environment=isolated-qa", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    created = True
    for _ in range(100):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True, timeout=10).returncode == 0:
            break
        time.sleep(.2)
    else:
        raise RuntimeError("QA_DATABASE_NOT_READY")
    paths = [
        ROOT / "ops/dev/bootstrap.sql", *sorted((ROOT / "drizzle/migrations").glob("*.sql")),
        *[p for p in sorted((ROOT / "docs/migrations").glob("*.sql")) if p.name[:4] <= "0041"],
        ROOT / "docs/proposals/0042_documentary_measurement_conditions.sql",
        ROOT / "docs/proposals/0043_accessory_characteristics.sql",
    ]
    sql("BEGIN;" + "\n".join(p.read_text() for p in paths) + "COMMIT;")
    sql((ROOT / "ops/dev/identity.sql").read_text())
    sql("CREATE TABLE mw_private.dev_migration_receipts(path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());"
        "ALTER TABLE mw_private.dev_migration_receipts ENABLE ROW LEVEL SECURITY;"
        "REVOKE ALL ON mw_private.dev_migration_receipts FROM PUBLIC,anon,authenticated,service_role;"
        "INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES('isolated-baseline','" + "c" * 64 + "');")
    existing = str(uuid.uuid4())
    sql("INSERT INTO staff(telegram_id,name,role,active,elevated) VALUES"
        "(101,'Учебный администратор','admin',true,false),(102,'Учебный продавец','seller',true,false),"
        "(103,'Другой учебный администратор','admin',true,false);"
        "INSERT INTO products(id,slug,title,sku,price,status,assortment_decision) VALUES(" +
        literal(existing) + ",'existing','Исходный учебный товар','EXISTING',500,'hidden','excluded');")
    assert guard.validate_schema(json.loads(sql(guard.SCHEMA_SQL))) == guard.SCHEMA_0043_CAPABILITIES
    before = sql("SELECT to_jsonb(p) FROM products p WHERE id=" + literal(existing))
    batch = upload()
    assert "inquiry_price" not in batch
    signatures = ["public.bot_apply_pending(uuid,bigint)",
                  "mw_private.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)",
                  "public.bot_assortment(bigint,text,uuid,text,integer,text,integer)"]
    baseline_functions = {signature: sql("SELECT encode(sha256(convert_to(pg_get_functiondef(" +
        literal(signature) + "::regprocedure),'UTF8')),'hex')") for signature in signatures}
    proposal = (ROOT / "docs/proposals/0045_catalog_inquiry_price.sql").read_text()
    wrapped = installation.transaction("a" * 40, "sha256:" + "b" * 64)
    # Failure/corruption after the proposed DDL rolls back schema, data and permissions.
    for injected, message in [
        ("SELECT 1/0;", "division by zero"),
        ("UPDATE products SET price=501 WHERE id=" + literal(existing) + ";", "INQUIRY_EXISTING_VALUES_CHANGED"),
        ("GRANT SELECT ON mw_private.dev_migration_receipts TO anon;", "INQUIRY_RELATIONS_CHANGED"),
    ]:
        sql(wrapped.replace("DO $preservation$", injected + "DO $preservation$", 1), message)
        assert sql("SELECT attnotnull FROM pg_attribute WHERE attrelid='products'::regclass AND attname='price'") == "t"
        assert sql("SELECT to_jsonb(p) FROM products p WHERE id=" + literal(existing)) == before
        assert sql("SELECT count(*) FROM mw_private.dev_migration_receipts") == "1"
    sql(wrapped)
    assert sql("SELECT count(*) FROM mw_private.dev_migration_receipts") == "3"
    sql(wrapped, "INQUIRY_EXACT_0043_REQUIRED")
    assert guard.validate_schema(json.loads(sql(guard.SCHEMA_SQL))) == guard.SCHEMA_0045_CAPABILITIES
    probe = guard.SCHEMA_SQL.replace("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;", "").replace("COMMIT;", "")
    for damage in [
        "ALTER TABLE catalog_imports ALTER COLUMN inquiry_price DROP DEFAULT;",
        "ALTER TABLE products ALTER COLUMN price SET DEFAULT 0;",
        "ALTER TABLE shop_orders DISABLE TRIGGER reject_inquiry_price_order;",
        "CREATE OR REPLACE FUNCTION mw_private.inquiry_price_version() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 2';",
    ]:
        damaged = json.loads(sql("BEGIN;" + damage + probe + "ROLLBACK;"))
        try:
            guard.validate_schema(damaged)
        except RuntimeError as error:
            assert "INQUIRY_SCHEMA_INCOMPLETE" in str(error)
        else:
            raise AssertionError("Damaged inquiry schema was accepted")
    assert sql("SELECT to_jsonb(p) FROM products p WHERE id=" + literal(existing)) == before
    assert sql("SELECT count(*) FROM products") == "1"
    assert sql("SELECT inquiry_price FROM catalog_imports WHERE id=" + literal(batch["id"])) == "f"
    # Neither the private implementation nor direct table writes become available.
    sql("SET ROLE service_role; SELECT mw_private.bot_catalog_import(101,'get');", "permission denied")
    sql("SET ROLE service_role; UPDATE catalog_imports SET inquiry_price=true;", "permission denied")
    sql("SET ROLE anon; SELECT * FROM catalog_imports;", "permission denied")
    rpc("inquiry_price", batch["id"], dict(enabled=True), 0, actor=102, error="IMPORT_DENIED")
    rpc("inquiry_price", batch["id"], dict(enabled=True), 0, actor=103, error="IMPORT_NOT_FOUND")
    rpc("inquiry_price", batch["id"], dict(enabled="true"), 0, error="IMPORT_BAD_INPUT")
    rpc("inquiry_price", batch["id"], dict(enabled=True, price=0), 0, error="IMPORT_BAD_INPUT")
    # Default remains strict; absence is accepted only after actor-owned opt-in.
    unpriced = row("NEW-1", title="Учебная модель", brand="Сварог")
    view = rpc("preview", batch["id"], dict(rows=[unpriced]), 0)
    assert view["counts"]["error"] == 1 and "NEW_REQUIRED" in view["items"][0]["errors"]
    configured = rpc("inquiry_price", batch["id"], dict(enabled=True), view["revision"])
    assert configured["inquiry_price"] is True and configured["state"] == "config" and configured["items"] == []
    rpc("apply", batch["id"], revision=view["revision"], error="IMPORT_CLOSED")
    rpc("inquiry_price", batch["id"], dict(enabled=False), view["revision"], error="IMPORT_STALE")
    assert rpc("source", batch["id"])["inquiry_price"] is True
    # Exact repeat at the current revision is a read, not another settings audit.
    same = rpc("inquiry_price", batch["id"], dict(enabled=True), configured["revision"])
    assert same["revision"] == configured["revision"]
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='catalog_import_inquiry_price'") == "1"
    preview = rpc("preview", batch["id"], dict(rows=[unpriced]), configured["revision"])
    assert preview["counts"]["new"] == 1 and preview["counts"]["error"] == 0
    assert preview["items"][0]["after_product"]["price"] is None
    assert sql("SELECT count(*) FROM products") == "1"  # Preview does not create a product.
    applied = rpc("apply", batch["id"], revision=preview["revision"])
    assert applied["state"] == "applied"
    product = json.loads(sql("SELECT to_jsonb(p) FROM products p WHERE sku='NEW-1'"))
    assert product["price"] is None and product["stock_qty"] is None
    assert product["status"] == "draft" and product["assortment_decision"] == "review"
    # Receipt replay and a changed source value cannot apply again.
    rpc("apply", batch["id"], dict(rows=[row("NEW-1", price=900)]), preview["revision"])
    assert sql("SELECT price IS NULL FROM products WHERE id=" + literal(product["id"])) == "t"
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='catalog_import_apply'") == "1"
    rpc("inquiry_price", batch["id"], dict(enabled=False), preview["revision"], error="IMPORT_CLOSED")
    # No-price existing row preserves its price and exclusion; no zero-price order.
    update = upload()
    update = rpc("inquiry_price", update["id"], dict(enabled=True), update["revision"])
    update = rpc("preview", update["id"], dict(rows=[row("EXISTING", title="Уточнённое учебное название")]), update["revision"])
    assert update["items"][0]["after_product"]["price"] == 500
    rpc("apply", update["id"], revision=update["revision"])
    current = json.loads(sql("SELECT to_jsonb(p) FROM products p WHERE id=" + literal(existing)))
    assert current["price"] == 500 and current["status"] == "hidden" and current["assortment_decision"] == "excluded"
    sql("INSERT INTO shop_orders(name,phone,items,total) VALUES('Учебный','70000000000'," +
        literal(json.dumps([dict(product_id=product["id"], qty=1, price=0, title="QA")])) + ",0);", "ORDER_INQUIRY_ONLY")
    # Explicit null, zero, strings and negative price are never accepted by import.
    invalid = upload()
    invalid = rpc("inquiry_price", invalid["id"], dict(enabled=True), invalid["revision"])
    for value in [None, 0, -1, "100", 1.234]:
        invalid = rpc("preview", invalid["id"], dict(rows=[row("INVALID", title="Учебная модель", price=value)]), invalid["revision"])
        assert invalid["counts"]["error"] == 1 and "BAD_PRICE" in invalid["items"][0]["errors"]
    # An explicit positive price applies normally to an inquiry product, and undo restores NULL.
    priced = upload()
    priced = rpc("preview", priced["id"], dict(rows=[row("NEW-1", price=1200)]), priced["revision"])
    rpc("apply", priced["id"], revision=priced["revision"])
    assert sql("SELECT price=1200 FROM products WHERE id=" + literal(product["id"])) == "t"
    rpc("undo_preview", priced["id"])
    rpc("undo", priced["id"])
    assert sql("SELECT price IS NULL FROM products WHERE id=" + literal(product["id"])) == "t"
    rpc("apply", priced["id"], revision=priced["revision"])
    assert sql("SELECT price IS NULL FROM products WHERE id=" + literal(product["id"])) == "t"
    # New-row undo archives it; repeating a source cannot resurrect an excluded SKU.
    rpc("undo_preview", batch["id"])
    # A later price apply/undo changes the row revision, so old creation undo must conflict.
    rpc("undo", batch["id"], error="IMPORT_CONFLICT")
    retry = upload()
    retry = rpc("preview", retry["id"], dict(rows=[row("EXISTING", price=700)]), retry["revision"])
    rpc("apply", retry["id"], revision=retry["revision"])
    assert sql("SELECT status='hidden' AND assortment_decision='excluded' FROM products WHERE id=" + literal(existing)) == "t"
    # NULL compare-and-set, stale pending, and rollback use the original receipt path.
    pending = json.loads(sql("SET ROLE service_role; SELECT bot_pending_preview(101," + literal(str(uuid.uuid4())) +
        ",'prepare'," + literal(product["id"]) + ",'price','{\"price\":null}','{\"price\":150}');"))
    stale = json.loads(sql("SET ROLE service_role; SELECT bot_pending_preview(101," + literal(str(uuid.uuid4())) +
        ",'prepare'," + literal(product["id"]) + ",'price','{\"price\":null}','{\"price\":250}');"))
    sql("SET ROLE service_role; SELECT bot_pending_operation(101," + literal(pending["pending_id"]) + ",'apply');")
    sql("SET ROLE service_role; SELECT bot_pending_operation(101," + literal(stale["pending_id"]) + ",'apply');", "BOT_PENDING_CONFLICT")
    undo = json.loads(sql("SET ROLE service_role; SELECT bot_pending_preview(101," + literal(str(uuid.uuid4())) +
        ",'rollback',NULL,NULL,NULL,NULL," + literal(pending["pending_id"]) + ");"))
    sql("SET ROLE service_role; SELECT bot_pending_operation(101," + literal(undo["pending_id"]) + ",'apply');")
    assert sql("SELECT price IS NULL FROM products WHERE id=" + literal(product["id"])) == "t"
    # Publication requires a positive price even when title and photo are present.
    sql("INSERT INTO product_photos(product_id,url,is_main) VALUES(" +
        literal(product["id"]) + ",'/isolated-fixture.png',true);")
    publish = json.loads(sql("SET ROLE service_role; SELECT bot_pending_preview(101," + literal(str(uuid.uuid4())) +
        ",'prepare'," + literal(product["id"]) + ",'status','{\"status\":\"draft\"}','{\"status\":\"published\"}');"))
    sql("SET ROLE service_role; SELECT bot_pending_operation(101," + literal(publish["pending_id"]) + ",'apply');",
        "BOT_PUBLISH_MISSING_FIELDS")
    assert sql("SELECT status='draft' AND price IS NULL FROM products WHERE id=" + literal(product["id"])) == "t"
    # A price rollback cannot remove a published card's price. All fixtures are isolated.
    price_again = json.loads(sql("SET ROLE service_role; SELECT bot_pending_preview(101," + literal(str(uuid.uuid4())) +
        ",'prepare'," + literal(product["id"]) + ",'price','{\"price\":null}','{\"price\":150}');"))
    sql("SET ROLE service_role; SELECT bot_pending_operation(101," + literal(price_again["pending_id"]) + ",'apply');")
    sql("SET ROLE service_role; SELECT bot_pending_operation(101," + literal(publish["pending_id"]) + ",'apply');")
    remove_price = json.loads(sql("SET ROLE service_role; SELECT bot_pending_preview(101," + literal(str(uuid.uuid4())) +
        ",'rollback',NULL,NULL,NULL,NULL," + literal(price_again["pending_id"]) + ");"))
    sql("SET ROLE service_role; SELECT bot_pending_operation(101," + literal(remove_price["pending_id"]) + ",'apply');",
        "BOT_PUBLISH_MISSING_FIELDS")
    assert sql("SELECT status='published' AND price=150 FROM products WHERE id=" + literal(product["id"])) == "t"
    # Defensive re-publication guard against a legacy NULL-price snapshot.
    # This malformed fixture is possible only via direct privileged writes in disposable QA.
    legacy = str(uuid.uuid4())
    sql("INSERT INTO products(id,slug,title,sku,price,status,assortment_decision) VALUES(" +
        literal(legacy) + ",'legacy-inquiry','Учебная исходная карточка','LEGACY-INQUIRY',NULL,'published','sell');"
        "INSERT INTO product_photos(product_id,url,is_main) VALUES(" +
        literal(legacy) + ",'/isolated-fixture.png',true);")
    hidden = assortment("start", value="all", query="LEGACY-INQUIRY")
    assert hidden["total"] == 1
    hidden = assortment("all", hidden["id"])
    hidden = assortment("preview", hidden["id"], value="hide", revision=hidden["revision"])
    assortment("apply", hidden["id"])
    assortment("undo_preview", hidden["id"])
    assortment("undo", hidden["id"], error="ASSORT_NOT_READY")
    assert sql("SELECT status='hidden' AND price IS NULL FROM products WHERE id=" + literal(legacy)) == "t"
    print(json.dumps(dict(ok=True,baseline="0043",proposal="0045",actor_ownership=True,
        explicit_setting=True,preview_only=True,draft_inquiry=True,existing_price_preserved=True,
        excluded_preserved=True,invalid_prices_rejected=True,import_undo=True,pending_cas_undo=True,
        checkout_null_rejected=True,null_publication_rejected=True,published_null_undo_rejected=True,
        assortment_null_republication_rejected=True,failed_migration_rollback=True,baseline_functions=baseline_functions,
        installation_wrapper=True,proposal_sha256=installation.MIGRATION_SHA,live_database=False)))
finally:
    if created:
        command(["docker", "rm", "-f", "-v", NAME])
