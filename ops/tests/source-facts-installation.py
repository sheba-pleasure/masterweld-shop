#!/usr/bin/env python3
"""Exercise the exact 0038–0041 installer transaction with isolated synthetic data."""
import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import time
import uuid
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/dev"))
spec = importlib.util.spec_from_file_location("source_fact_installation", ROOT / "ops/dev/apply-source-facts.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
NAME = "mw-source-install-qa-" + uuid.uuid4().hex[:12]
CHECKS = []
CREATED = False


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs)


def sql(query, error=None):
    result = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-X", "-Atq", "-U", "postgres",
                             "-v", "ON_ERROR_STOP=1"], input=query, capture_output=True, text=True, timeout=120)
    if error:
        assert result.returncode and error in result.stderr, result.stderr
    elif result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def ready():
    for _ in range(100):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True).returncode == 0:
            return
        time.sleep(.2)
    raise RuntimeError("QA_DATABASE_NOT_READY")


def snapshot():
    names = ("public.products", "public.product_costs", "public.shop_orders",
             "mw_private.qa_preserved", "mw_private.dev_migration_receipts")
    return {name: sql("SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text) FROM " + name + " r") for name in names}


def untouched(before):
    assert snapshot() == before, "OLD_DATA_CHANGED"
    assert json.loads(sql(guard.BASELINE_SQL)) == guard.EXPECTED, "BASELINE_FUNCTIONS_CHANGED"
    state = json.loads(sql(guard.compatibility.SCHEMA_SQL))
    assert guard.compatibility.validate_schema(state) is False, "PARTIAL_MIGRATION_SURVIVED"


def corrupt(bundle, statement, position=-1):
    modified = copy.deepcopy(bundle)
    path = list(modified)[position]
    modified[path] += "\n" + statement + "\n"
    return modified


try:
    command(["docker", "run", "-d", "--name", NAME, "--network", "none",
             "--label", "mw.environment=isolated-qa",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    CREATED = True
    ready()
    paths = [ROOT / "ops/dev/bootstrap.sql", *sorted((ROOT / "drizzle/migrations").glob("*.sql")),
             *[p for p in sorted((ROOT / "docs/migrations").glob("*.sql")) if p.name[:4] <= "0037"]]
    sql("BEGIN;\n" + "\n".join(path.read_text() for path in paths) + "\nCOMMIT;")
    sql((ROOT / "ops/dev/identity.sql").read_text())
    sql("""
INSERT INTO staff(telegram_id,name,role) VALUES(101,'Учебный администратор','admin');
INSERT INTO products(id,sku,slug,title,price,status,assortment_decision)
 VALUES('10000000-0000-4000-8000-000000000041','QA-INSTALL','qa-install','Учебный товар',123.45,'hidden','excluded');
INSERT INTO product_costs(product_id,cost_price) VALUES('10000000-0000-4000-8000-000000000041',89.12);
INSERT INTO shop_orders(name,phone,items,total) VALUES('Учебный покупатель','00000','[]',0);
CREATE TABLE mw_private.qa_preserved(id integer PRIMARY KEY, note text, original bytea, details jsonb);
INSERT INTO mw_private.qa_preserved VALUES(1,'Исходная строка',decode('0001ff','hex'),'{"unchanged":true,"zero":0}'),(2,NULL,NULL,NULL);
CREATE TABLE mw_private.dev_migration_receipts(path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES('earlier-reviewed-migration','preserve-original-receipt');
""")
    bundle = guard.load_bundle()
    before = snapshot()
    sql(guard.transaction(bundle, {}), error="SOURCE_FACT_INSTALL_BASELINE")
    untouched(before)
    CHECKS.append("exact_baseline_required")

    sql("UPDATE mw_private.environment SET environment='production'")
    sql(guard.transaction(bundle), error="SOURCE_FACT_DEV_REQUIRED")
    sql("UPDATE mw_private.environment SET environment='dev'")
    untouched(before)
    sql("UPDATE mw_private.environment SET instance_id='00000000-0000-4000-8000-000000000041'")
    sql(guard.transaction(bundle), error="SOURCE_FACT_DEV_REQUIRED")
    sql("UPDATE mw_private.environment SET instance_id=" + guard.literal(guard.IDENTITY["instanceId"]))
    untouched(before)
    CHECKS.append("environment_and_instance_required")

    sql("CREATE TABLE public.source_fact_prompts(keep_me text); INSERT INTO public.source_fact_prompts VALUES('Existing partial state')")
    sql(guard.transaction(bundle), error="SOURCE_FACT_INSTALL_SCHEMA_REVIEW")
    assert sql("SELECT keep_me FROM source_fact_prompts") == "Existing partial state"
    sql("DROP TABLE source_fact_prompts")
    untouched(before)
    CHECKS.append("partial_schema_preserved_and_refused")

    cases = [
        ("UPDATE products SET title='Unexpected change';", "SOURCE_FACT_EXISTING_VALUES_CHANGED", "product_values_preserved"),
        ("UPDATE shop_orders SET comment='Unexpected change';", "SOURCE_FACT_EXISTING_VALUES_CHANGED", "orders_preserved"),
        ("UPDATE product_costs SET cost_price=1;", "SOURCE_FACT_EXISTING_VALUES_CHANGED", "purchase_costs_preserved"),
        ("UPDATE mw_private.qa_preserved SET note='Unexpected change';", "SOURCE_FACT_EXISTING_VALUES_CHANGED", "private_values_preserved"),
        ("UPDATE mw_private.dev_migration_receipts SET sha256='Changed';", "SOURCE_FACT_EXISTING_VALUES_CHANGED", "old_receipts_preserved"),
        ("GRANT SELECT ON source_fact_rows TO service_role;", "SOURCE_FACT_TABLE_PRIVILEGES", "table_grants_refused"),
        ("ALTER TABLE source_fact_reviews DISABLE ROW LEVEL SECURITY;", "SOURCE_FACT_TABLE_PRIVILEGES", "rls_required"),
        ("GRANT EXECUTE ON FUNCTION mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb) TO service_role;",
         "SOURCE_FACT_PRIVATE_FUNCTION_PRIVILEGES", "private_implementation_closed"),
        ("GRANT EXECUTE ON FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb) TO anon;",
         "SOURCE_FACT_PUBLIC_FUNCTION_PRIVILEGES", "public_rpc_closed"),
        ("ALTER TABLE source_fact_prompts DISABLE TRIGGER source_fact_input_guard;", "SOURCE_FACT_TRIGGER_REQUIRED", "input_trigger_required"),
        ("DO $$ BEGIN RAISE EXCEPTION 'QA_INSTALL_FAILURE'; END $$;", "QA_INSTALL_FAILURE", "last_step_failure_atomic"),
    ]
    for statement, error, check in cases:
        sql(guard.transaction(corrupt(bundle, statement)), error=error)
        untouched(before)
        CHECKS.append(check)
    sql(guard.transaction(corrupt(bundle, "DO $$ BEGIN RAISE EXCEPTION 'QA_MID_FAILURE'; END $$;", 1)), error="QA_MID_FAILURE")
    untouched(before)
    CHECKS.append("middle_step_failure_atomic")

    first_path = next(iter(bundle))
    sql("INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES(" + guard.literal(first_path) + ",'Conflicting receipt')")
    conflicting = snapshot()
    sql(guard.transaction(bundle), error="duplicate key value violates unique constraint")
    untouched(conflicting)
    sql("DELETE FROM mw_private.dev_migration_receipts WHERE path=" + guard.literal(first_path))
    untouched(before)
    CHECKS.append("receipt_conflict_rolls_back_all_steps")

    sql(guard.transaction(bundle))
    after = snapshot()
    assert {k: v for k, v in before.items() if not k.endswith("dev_migration_receipts")} == {
        k: v for k, v in after.items() if not k.endswith("dev_migration_receipts")
    }
    assert sql("SELECT sha256 FROM mw_private.dev_migration_receipts WHERE path='earlier-reviewed-migration'") == "preserve-original-receipt"
    assert json.loads(sql(guard.RECEIPTS_SQL)) == guard.MIGRATIONS
    assert guard.compatibility.validate_schema(json.loads(sql(guard.compatibility.SCHEMA_SQL))) is True
    for table in guard.NEW_TABLES:
        assert sql("SELECT count(*) FROM public." + table) == "0"
    CHECKS += ["all_four_steps_committed_together", "new_tables_empty", "all_four_receipts_recorded"]

    sql(guard.transaction(bundle), error="SOURCE_FACT_INSTALL_SCHEMA_REVIEW")
    assert snapshot() == after
    command(["docker", "restart", NAME])
    ready()
    assert snapshot() == after
    with patch.object(guard, "sql", sql), patch.object(guard.compatibility, "schema_requirements", return_value=True):
        recorded = guard.inspect_installation()
        assert recorded["state"] == "recorded" and recorded["migrationChecksums"] == guard.MIGRATIONS
    assert snapshot() == after
    CHECKS += ["reapplication_refused", "restart_preserves_receipts", "uncertain_result_read_only_recovery"]
    print(json.dumps({"ok": True, "migrationChecksums": guard.MIGRATIONS, "checks": CHECKS}))
finally:
    if CREATED:
        subprocess.run(["docker", "rm", "-f", "-v", NAME], capture_output=True)
