#!/usr/bin/env python3
"""Real isolated PostgreSQL: dictionary upgrade, value validation, human preview/apply/undo."""
import copy
import datetime
import importlib.util
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-consumable-qa-" + uuid.uuid4().hex[:12]
PRODUCT = "10000000-0000-4000-8000-000000000001"

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)

def sql(query, error=None):
    r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-X", "-Atq", "-U", "postgres",
                        "-v", "ON_ERROR_STOP=1"], input=query, capture_output=True, text=True)
    if error:
        assert r.returncode and error in r.stderr, r.stderr
    elif r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()

def lit(value):
    if value is None: return "NULL"
    if isinstance(value, int): return str(value)
    return "'" + str(value).replace("'", "''") + "'"

def rpc(op, doc=None, change=None, actor=101, review="verified", version=None, error=None):
    if version is None and op == "preview":
        version = int(sql("SELECT coalesce((SELECT version FROM technical_cards WHERE product_id=" + lit(PRODUCT) + "),0)"))
    args = [actor, op, PRODUCT, change, json.dumps(doc) if doc else None, review, version]
    result = sql("SET ROLE service_role; SELECT bot_technical_catalog(" + ",".join(map(lit, args)) + ")", error)
    return json.loads(result) if not error else None

def fact(code, value, unit="none", state="known"):
    return {"attribute_code": code, "process": "general", "state": state, "value": value,
            "unit_code": unit, "context": {}, "source_key": "manual" if state == "known" else None}

def document(family, values):
    return {"family_code": family, "sources": [{
        "key": "manual", "kind": "synthetic", "publisher": "Учебный изготовитель",
        "model": "DEV CONSUMABLE", "title": "[Учебный] Не паспорт реального товара",
        "url": "https://example.invalid/consumable", "locator": "Учебная таблица 1",
        "checked_on": datetime.date.today().isoformat(), "sha256": "",
    }], "values": values}

def public():
    raw = sql("SET ROLE anon; SELECT public_product_technical(" + lit(PRODUCT) + ")")
    return json.loads(raw) if raw else None

created = False
try:
    run(["docker", "run", "-d", "--name", NAME, "--network", "none", "--label", "mw.environment=isolated-qa",
         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    created = True
    for _ in range(100):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True).returncode == 0: break
        time.sleep(.2)
    else: raise RuntimeError("PG_NOT_READY")
    paths = [ROOT / "ops/dev/bootstrap.sql", *sorted((ROOT / "drizzle/migrations").glob("*.sql")),
             *[p for p in sorted((ROOT / "docs/migrations").glob("*.sql")) if p.name[:4] <= "0033"]]
    sql("BEGIN;\n" + "\n".join(p.read_text() for p in paths) + "\nCOMMIT;")
    sql((ROOT / "ops/dev/identity.sql").read_text())
    sql("INSERT INTO staff(telegram_id,name,role,elevated) VALUES (101,'Admin','admin',false),(102,'Other','admin',false),(103,'Seller','seller',false)")
    sql("INSERT INTO products(id,sku,slug,title,price,status,assortment_decision,specs) VALUES(" +
        lit(PRODUCT) + ",'DEV-CONSUMABLE','dev-consumable','[Учебный] Существующий товар',10,'published','sell','Legacy specs')")
    # A verified card and an unapplied old-dictionary preview must survive the additive migration.
    old = document("power_mma", [dict(fact("mma_current_max_a", 100, "a"), process="mma")])
    initial = rpc("preview", old); rpc("apply", change=initial["change_id"])
    public_before = public()
    old_preview = rpc("preview", old)
    old_version = int(sql("SELECT version FROM technical_cards WHERE product_id=" + lit(PRODUCT)))
    spec = importlib.util.spec_from_file_location("consumable_guard", ROOT / "ops/dev/apply-consumable-characteristics.py")
    guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    migration = (ROOT / guard.PATH).read_text()
    for extra, error in [
        ("UPDATE products SET title='Unexpected';", "CONSUMABLE_EXISTING_DATA_CHANGED"),
        ("UPDATE technical_attributes SET minimum=-1 WHERE code='mma_current_max_a';", "CONSUMABLE_DICTIONARY_MISMATCH"),
        ("GRANT SELECT ON technical_attributes TO anon;", "CONSUMABLE_SECURITY_CHANGED"),
        ("GRANT EXECUTE ON FUNCTION validate_technical_document(jsonb,text) TO anon;", "CONSUMABLE_SECURITY_CHANGED"),
    ]:
        sql(guard.transaction(migration + "\n" + extra), error)
        assert json.loads(sql(guard.DICTIONARY_SQL)) == guard.BEFORE
        assert public() == public_before
    sql("UPDATE technical_attributes SET label='Wrong baseline' WHERE code='mma_current_max_a'")
    sql(guard.transaction(migration), "CONSUMABLE_BASELINE")
    sql("UPDATE technical_attributes SET label=" + lit(guard.BEFORE["attributes"]["mma_current_max_a"]["label"]) + " WHERE code='mma_current_max_a'")
    sql(guard.transaction(migration))
    assert json.loads(sql(guard.DICTIONARY_SQL)) == guard.AFTER
    sql(guard.transaction(migration), "CONSUMABLE_BASELINE")
    assert public() == public_before
    assert int(sql("SELECT version FROM technical_cards WHERE product_id=" + lit(PRODUCT))) == old_version
    rpc("apply", change=old_preview["change_id"]); rpc("undo", change=old_preview["change_id"])
    assert public() == public_before
    for role in ["anon", "authenticated", "service_role"]:
        for table in guard.TABLES.values():
            sql("SET ROLE " + role + "; SELECT * FROM " + table, "permission denied")
            sql("SET ROLE " + role + "; UPDATE " + table + " SET " +
                ("sort_order=0" if table == "technical_family_attributes" else "label='Wrong'"), "permission denied")
    # Exercise every new binding through the unchanged production RPC validator.
    definitions = guard.AFTER["attributes"]
    by_family = {}
    for binding in guard.EXTENSION["bindings"]:
        attr = definitions[binding["attribute_code"]]
        value = {"number": 1.25, "integer": 2, "boolean": False,
                 "text": "Учебное дословное обозначение", "number_list": [0.8, 1.0]}[attr["kind"]]
        by_family.setdefault(binding["family_code"], []).append(fact(attr["code"], value, attr["unit_code"]))
    for family, values in by_family.items():
        rpc("preview", document(family, values))
    assert public() == public_before  # a preview is never publication
    rod = document("consumable_tig_rod", [fact("filler_rod_diameter_mm", 1.6, "mm"),
          fact("filler_rod_class", "Учебная маркировка"),
          fact("filler_rod_length_mm", None, "mm", "unknown")])
    rpc("preview", rod, actor=103, error="TECH_REVIEW_DENIED")
    supplier = copy.deepcopy(rod); supplier["sources"][0]["kind"] = "supplier"
    rpc("preview", supplier, error="TECH_PRIMARY_SOURCE_REQUIRED")
    pending = rpc("preview", supplier, review="pending_review")
    rpc("apply", change=pending["change_id"])
    assert public() == public_before
    for doc, error in [
        (document("consumable_tig_rod", [fact("filler_rod_diameter_mm", -1, "mm")]), "TECH_BAD_RANGE"),
        (document("consumable_tungsten", [fact("tungsten_qty_pack", 1.5, "count")]), "TECH_BAD_RANGE"),
        (document("consumable_tungsten", [fact("tungsten_qty_pack", 0, "count")]), "TECH_BAD_RANGE"),
        (document("feed_rollers", [fact("roller_wire_diameters_mm", [0.8, 0.8], "mm")]), "TECH_DUPLICATE_VALUE"),
        (document("consumable_tig_rod", [fact("filler_rod_diameter_mm", 1.6, "kg")]), "TECH_BAD_VALUE"),
        (document("consumable_tig_rod", [fact("tungsten_qty_pack", 2, "count")]), "TECH_ATTRIBUTE_NOT_APPLICABLE"),
        (document("mig_liner", [fact("mig_liner_wire_diameter_min_mm", 2, "mm"),
                               fact("mig_liner_wire_diameter_max_mm", 1, "mm")]), "TECH_REVERSED_RANGE"),
        (document("consumable_saw_flux", [fact("saw_flux_grain_min_mm", 2, "mm"),
                                        fact("saw_flux_grain_max_mm", 1, "mm")]), "TECH_REVERSED_RANGE"),
    ]:
        rpc("preview", doc, error=error)
    approved = rpc("preview", rod)
    assert public() == public_before
    rpc("apply", change=approved["change_id"], actor=102, error="TECH_CHANGE_NOT_FOUND")
    rpc("apply", change=approved["change_id"])
    published = public()
    assert published["family"]["code"] == "consumable_tig_rod"
    assert next(v for v in published["values"] if v["code"] == "filler_rod_diameter_mm")["value"] == 1.6
    rpc("apply", change=approved["change_id"])
    assert public() == published
    run(["docker", "restart", NAME])
    for _ in range(100):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True).returncode == 0: break
        time.sleep(.2)
    else: raise RuntimeError("PG_RESTART_FAILED")
    assert public() == published
    rpc("undo", change=approved["change_id"]); rpc("undo", change=approved["change_id"])
    assert public() == public_before
    sql("UPDATE products SET status='hidden',assortment_decision='excluded' WHERE id=" + lit(PRODUCT))
    hidden = rpc("preview", rod); rpc("apply", change=hidden["change_id"])
    assert public() is None
    assert sql("SELECT assortment_decision FROM products WHERE id=" + lit(PRODUCT)) == "excluded"
    print(json.dumps({"ok": True, "attributesAdded": len(guard.EXTENSION["attributes"]),
                      "bindingsTested": len(guard.EXTENSION["bindings"]), "familiesTested": len(by_family),
                      "oldDataAndPreviewPreserved": True, "badMigrationRolledBack": True,
                      "humanReviewRequired": True, "restartAndDuplicateApplyUndo": True, "excludedNotPublished": True}))
finally:
    if created:
        subprocess.run(["docker", "rm", "-f", NAME], capture_output=True)
