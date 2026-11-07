#!/usr/bin/env python3
"""Build a disposable production-shaped database from SQL; no live reads or backups."""
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/production"))
from preflight import expected_schema_files, schema_errors
from app_compatibility import SCHEMA_SQL, KNOWN_CAPABILITIES, validate_schema

NAME = "mw-prod-schema-qa-" + uuid.uuid4().hex[:12]
IMAGE = "postgres:17.6-alpine"
IDENTITY = {"environment": "production", "instanceId": "ba2eec4a-5166-45ec-8b5a-e71c2213c015"}
BOOTSTRAP = """
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOINHERIT LOGIN;
GRANT anon,authenticated,service_role TO authenticator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
"""
IDENTITY_SQL = """
CREATE SCHEMA mw_private;
REVOKE ALL ON SCHEMA mw_private FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE mw_private.environment (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 environment text NOT NULL CHECK(environment='production'),instance_id uuid NOT NULL UNIQUE);
INSERT INTO mw_private.environment VALUES(true,'production','""" + IDENTITY["instanceId"] + """');
CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=mw_private,pg_temp AS $identity$
 SELECT jsonb_build_object('environment',environment,'instanceId',instance_id)
 FROM mw_private.environment WHERE singleton $identity$;
REVOKE ALL ON FUNCTION public.mw_environment_identity() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mw_environment_identity() TO service_role;
CREATE TABLE mw_private.schema_files(path text PRIMARY KEY,sha256 text NOT NULL);
"""
NEW_ACCESS_CHECK = """
DO $checks$
DECLARE t text; role_name text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'product_model_choices','technical_identity_events','technical_editor_models',
  'technical_change_models','technical_model_generations','product_source_reviews',
  'product_document_sources','source_fact_reviews','source_fact_rows',
  'source_fact_prompts','technical_fact_origins'] LOOP
  IF to_regclass('public.'||t) IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.'||t))
    THEN RAISE EXCEPTION 'NEW_PRIVATE_TABLE_MISSING_OR_UNPROTECTED: %',t; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(role_name,'public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    THEN RAISE EXCEPTION 'NEW_PRIVATE_TABLE_EXPOSED: %',t; END IF;
  END LOOP;
 END LOOP;
 IF has_table_privilege('anon','product_costs','SELECT')
   OR has_table_privilege('authenticated','product_costs','SELECT')
   OR has_table_privilege('anon','shop_orders','INSERT')
   OR has_table_privilege('service_role','shop_orders','INSERT')
 THEN RAISE EXCEPTION 'PUBLIC_COST_OR_ORDER_BYPASS'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='mw_private' AND
    (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')
     OR has_function_privilege('service_role',p.oid,'EXECUTE')))
 THEN RAISE EXCEPTION 'PRIVATE_RPC_EXPOSED'; END IF;
END $checks$;
"""

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs)


def sql(query, expected_error=None):
    result = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-X", "-U", "postgres",
                             "-Atq", "-v", "ON_ERROR_STOP=1"],
                            input=query, capture_output=True, text=True, timeout=120)
    if expected_error is not None:
        if not result.returncode or expected_error not in result.stderr:
            raise RuntimeError("EXPECTED_SQL_REFUSAL_MISSING: " + result.stderr[-2000:])
        return None
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    return result.stdout.strip()


def wait_ready():
    for _ in range(60):
        result = subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                                capture_output=True, timeout=10)
        if result.returncode == 0:
            return
        time.sleep(.3)
    raise RuntimeError("DISPOSABLE_DATABASE_NOT_READY")


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def statements(paths, hashes):
    return "\n".join((ROOT / path).read_text() + "\nINSERT INTO mw_private.schema_files VALUES (" +
                     literal(path) + "," + literal(hashes[path]) + ");" for path in paths)


def fingerprint():
    # Includes all empty/new tables as well as row contents; synthetic data only.
    return json.loads(sql("""
DO $snapshot$
DECLARE t record; result jsonb:='{}'; value text;
BEGIN
 FOR t IN SELECT schemaname,tablename FROM pg_tables
           WHERE schemaname IN ('public','mw_private') ORDER BY schemaname,tablename LOOP
  EXECUTE format('SELECT count(*)::text||'':''||md5(coalesce(string_agg(row_to_json(x)::text,E''\\n'' ORDER BY row_to_json(x)::text),'''')) FROM %I.%I x',
                 t.schemaname,t.tablename) INTO value;
  result:=result||jsonb_build_object(t.schemaname||'.'||t.tablename,value);
 END LOOP;
 PERFORM set_config('mw.qa_fingerprint',result::text,false);
END $snapshot$;
SELECT current_setting('mw.qa_fingerprint')::jsonb;
"""))


def probes(expanded=False):
    before = fingerprint()
    settings = ("SET mw.rehearsal_attributes='131'; SET mw.rehearsal_bindings='166'; "
                "SET mw.rehearsal_units='19';\n") if expanded else ""
    results = {}
    for key, filename in [("technical", "check-technical-upgrade.sql"),
                          ("documents", "check-document-upgrade.sql")]:
        results[key] = json.loads(sql(settings + (ROOT / "ops/standalone" / filename).read_text()))
        if fingerprint() != before:
            raise RuntimeError("PROBE_FIXTURES_NOT_ROLLED_BACK:" + key)
    return results


def check_dictionary():
    seeds = [json.loads((ROOT / ("src/lib/technical/" + name + "-dictionary.json")).read_text())
             for name in ["pilot", "consumable", "accessory"]]
    for table, key, identity in [
        ("technical_units", "units", ("code",)),
        ("technical_families", "families", ("code",)),
        ("technical_attributes", "attributes", ("code",)),
        ("technical_family_attributes", "bindings", ("family_code", "attribute_code")),
    ]:
        expected = [row for seed in seeds for row in seed.get(key, [])]
        actual = json.loads(sql("SELECT json_agg(t) FROM " + table + " t;"))
        index = lambda rows: {tuple(row[k] for k in identity): row for row in rows}
        if len(actual) != len(expected) or index(actual) != index(expected):
            raise RuntimeError("EXACT_DICTIONARY_MISMATCH:" + table)


def check_target(hashes):
    if json.loads(sql("SELECT public.mw_environment_identity();")) != IDENTITY:
        raise RuntimeError("IDENTITY_CHANGED")
    ledger = json.loads(sql("SELECT json_agg(s ORDER BY path) FROM mw_private.schema_files s;"))
    if schema_errors(ledger, hashes):
        raise RuntimeError("TARGET_LEDGER_MISMATCH")
    if validate_schema(json.loads(sql(SCHEMA_SQL)), IDENTITY) != KNOWN_CAPABILITIES:
        raise RuntimeError("TARGET_CAPABILITIES_MISMATCH")
    sql(NEW_ACCESS_CHECK)
    check_dictionary()


def main():
    hashes = expected_schema_files(ROOT)
    paths = sorted(hashes, key=lambda path: pathlib.Path(path).name)
    baseline = [path for path in paths if pathlib.Path(path).name[:4] <= "0013"]
    first = [path for path in paths if "0014" <= pathlib.Path(path).name[:4] <= "0031"]
    latest = [path for path in paths if "0032" <= pathlib.Path(path).name[:4] <= "0043"]
    if len(baseline) != 14 or len(first) != 18 or len(latest) != 12 or len(paths) != 44:
        raise RuntimeError("REHEARSAL_SCOPE_CHANGED")
    report = {"syntheticOnly": True, "liveDatabaseRead": False, "backupCreated": False,
              "sourceSha": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
              "sourceDirty": bool(run(["git", "status", "--porcelain"]).stdout.strip()),
              "migrations": hashes, "checks": {}}
    created = False
    try:
        run(["docker", "run", "--pull=never", "-d", "--name", NAME, "--network", "none",
             "--label", "mw.environment=isolated-qa", "--label", "mw.purpose=production-schema-rehearsal",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE])
        created = True
        wait_ready()
        # Reproduce the standalone 0013 schema and production marker using fixtures;
        # no real configuration, credentials, data or database names are accessed.
        sql("BEGIN;\n" + BOOTSTRAP + "\n".join((ROOT / p).read_text() for p in baseline) +
            "\n" + IDENTITY_SQL + "\n" +
            "\n".join("INSERT INTO mw_private.schema_files VALUES (" + literal(p) + "," +
                      literal(hashes[p]) + ");" for p in baseline) + "\nCOMMIT;")
        sql("BEGIN;\n" + statements(first, hashes) + "\nCOMMIT;")
        report["checks"]["baseline0031"] = probes()
        before = fingerprint()
        upgrade = statements(latest, hashes)
        sql("BEGIN;\n" + upgrade + "\nSELECT 1/0;\nCOMMIT;", expected_error="division by zero")
        if fingerprint() != before:
            raise RuntimeError("FAILED_TRANSACTION_CHANGED_DATABASE")
        if sql("SELECT to_regprocedure('mw_private.accessory_dictionary_version()') IS NULL;") != "t":
            raise RuntimeError("FAILED_TRANSACTION_LEFT_MARKER")
        report["checks"]["failedUpgradeRolledBack"] = True
        sql("BEGIN;\n" + upgrade + "\nCOMMIT;")
        check_target(hashes)
        after = fingerprint()
        if any(after.get(table) != value for table, value in before.items()
               if table not in {"mw_private.schema_files", "public.technical_units",
                                "public.technical_attributes", "public.technical_family_attributes"}):
            raise RuntimeError("UNEXPECTED_EXISTING_DATA_CHANGE")
        report["checks"]["target0043"] = probes(expanded=True)
        report["checks"]["accessoryFlow"] = json.loads(sql((ROOT / "ops/tests/production-accessory-flow.sql").read_text()))
        if fingerprint() != after:
            raise RuntimeError("ACCESSORY_FIXTURES_NOT_ROLLED_BACK")
        sql("BEGIN;\n" + upgrade + "\nCOMMIT;", expected_error="already exists")
        if fingerprint() != after:
            raise RuntimeError("REPEATED_UPGRADE_CHANGED_DATABASE")
        run(["docker", "restart", NAME])
        wait_ready()
        check_target(hashes)
        if fingerprint() != after:
            raise RuntimeError("RESTART_CHANGED_DATABASE")
        report["checks"]["repeatRefused"] = True
        report["checks"]["restartPreserved"] = True
        report["checks"]["privateAccessAndNoDirectOrders"] = True
        report["passed"] = True
    finally:
        if created:
            run(["docker", "rm", "-f", "-v", NAME])
    report["temporaryResourcesRemoved"] = True
    report["sources"] = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in [
        "ops/tests/production-schema.py", "ops/tests/production-accessory-flow.sql",
        "ops/standalone/check-technical-upgrade.sql",
        "ops/standalone/check-document-upgrade.sql", "ops/production/preflight.py",
        "ops/production/app_compatibility.py", "ops/accessory_compatibility.py",
        "src/lib/technical/pilot-dictionary.json", "src/lib/technical/consumable-dictionary.json",
        "src/lib/technical/accessory-dictionary.json"]}
    folder = ROOT / "ops/.state/production-schema-rehearsal" / NAME
    folder.mkdir(parents=True, mode=0o700)
    (folder / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": True, "report": str(folder / "report.json"),
                      "temporaryResourcesRemoved": True, "syntheticOnly": True}))


if __name__ == "__main__":
    main()
