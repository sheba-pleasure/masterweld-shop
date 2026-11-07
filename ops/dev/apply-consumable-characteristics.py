#!/usr/bin/env python3
"""Add dictionary entries only, with isolated rehearsal and atomic unchanged-data guards."""
import fcntl
import hashlib
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
PATH = "docs/migrations/0034_consumable_characteristics.sql"
IDENTITY = {"environment": "dev", "instanceId": "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}
PILOT = json.loads((ROOT / "src/lib/technical/pilot-dictionary.json").read_text())
EXTENSION = json.loads((ROOT / "src/lib/technical/consumable-dictionary.json").read_text())
TABLES = {"units": "technical_units", "families": "technical_families",
          "attributes": "technical_attributes", "bindings": "technical_family_attributes"}

def mapped(dictionary):
    return {kind: {(r["family_code"] + ":" + r["attribute_code"] if kind == "bindings" else r["code"]): r
                   for r in dictionary.get(kind, [])} for kind in TABLES}

BEFORE = mapped(PILOT)
AFTER = {kind: BEFORE[kind] | mapped(EXTENSION)[kind] for kind in TABLES}
DICTIONARY_SQL = "SELECT jsonb_build_object(" + ",".join(
    "'" + kind + "',(SELECT coalesce(jsonb_object_agg(" +
    ("family_code||':'||attribute_code" if kind == "bindings" else "code") +
    ",to_jsonb(r)),'{}'::jsonb) FROM public." + table + " r)"
    for kind, table in TABLES.items()) + ")"
# The upgrade is data-only: it may not change executable code or any existing public ACL/policy.
SECURITY_SQL = """SELECT jsonb_build_object(
 'functions',(SELECT md5(jsonb_agg(jsonb_build_array(p.oid,pg_get_functiondef(p.oid),p.proacl,p.proowner) ORDER BY p.oid)::text)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('public','mw_private') AND p.prokind='f'),
 'tables',(SELECT md5(jsonb_agg(jsonb_build_array(c.oid,c.relacl,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid)::text)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),
 'policies',(SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.schemaname,p.tablename,p.policyname),'[]'::jsonb)::text)
   FROM pg_policies p WHERE schemaname='public'))"""

def quoted(value):
    return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"

def transaction(migration):
    checksum = hashlib.sha256(migration.encode()).hexdigest()
    return """
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $identity$ BEGIN
 IF mw_environment_identity() IS DISTINCT FROM """ + quoted(IDENTITY) + """
 THEN RAISE EXCEPTION 'CONSUMABLE_DEV_REQUIRED'; END IF;
 IF to_regclass('public.product_model_selection') IS NULL
 THEN RAISE EXCEPTION 'CONSUMABLE_SCHEMA_REVIEW'; END IF;
END $identity$;
CREATE TEMP TABLE consumable_before(name text,columns text,fingerprint text) ON COMMIT DROP;
DO $before$ DECLARE t record; cols text; h text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
  EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',t.tablename);
  IF t.tablename IN ('technical_units','technical_families','technical_attributes','technical_family_attributes') THEN CONTINUE; END IF;
  SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) INTO cols
   FROM information_schema.columns WHERE table_schema='public' AND table_name=t.tablename;
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM public.%I r',t.tablename) INTO h;
  INSERT INTO consumable_before VALUES(t.tablename,cols,h);
 END LOOP;
 IF (""" + DICTIONARY_SQL + """) IS DISTINCT FROM """ + quoted(BEFORE) + """
 THEN RAISE EXCEPTION 'CONSUMABLE_BASELINE'; END IF;
END $before$;
CREATE TEMP TABLE consumable_security ON COMMIT DROP AS """ + SECURITY_SQL + """;
""" + migration + """
DO $after$ DECLARE t record; h text; BEGIN
 IF (""" + DICTIONARY_SQL + """) IS DISTINCT FROM """ + quoted(AFTER) + """
 THEN RAISE EXCEPTION 'CONSUMABLE_DICTIONARY_MISMATCH'; END IF;
 FOR t IN SELECT * FROM consumable_before LOOP
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM (SELECT %s FROM public.%I) r',t.columns,t.name) INTO h;
  IF h IS DISTINCT FROM t.fingerprint THEN RAISE EXCEPTION 'CONSUMABLE_EXISTING_DATA_CHANGED'; END IF;
 END LOOP;
 IF (""" + SECURITY_SQL + """) IS DISTINCT FROM (SELECT jsonb_build_object FROM consumable_security)
 THEN RAISE EXCEPTION 'CONSUMABLE_SECURITY_CHANGED'; END IF;
END $after$;
CREATE TABLE IF NOT EXISTS mw_private.dev_migration_receipts(path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES('""" + PATH + "','" + checksum + """');
NOTIFY pgrst,'reload schema';
COMMIT;
"""

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)

def sql(query):
    return run(["docker", "exec", "-i", "mw-dev-db", "psql", "-X", "-Atq", "-U", "postgres",
                "-d", "masterweld_dev", "-v", "ON_ERROR_STOP=1"], input=query).stdout.strip()

def main():
    os.umask(0o077)
    if run(["git", "status", "--porcelain"], cwd=ROOT).stdout.strip():
        raise RuntimeError("COMMIT_SOURCE_REQUIRED")
    sha = run(["git", "rev-parse", "HEAD"], cwd=ROOT).stdout.strip()
    state = ROOT / "ops/.state/dev"
    with (state / "update.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        container = json.loads(run(["docker", "inspect", "mw-dev-db"]).stdout)[0]
        if container["Config"]["Labels"].get("mw.environment") != "dev" or not container["State"]["Running"]:
            raise RuntimeError("DEV_DATABASE_REQUIRED")
        if json.loads(sql("SELECT mw_environment_identity()")) != IDENTITY:
            raise RuntimeError("DEV_IDENTITY_REQUIRED")
        if json.loads(sql(DICTIONARY_SQL)) != BEFORE:
            raise RuntimeError("CONSUMABLE_BASELINE")
        rehearsal = json.loads(run(["python3", str(ROOT / "ops/tests/consumable-characteristics.py")], cwd=ROOT).stdout)
        if not rehearsal.get("ok"):
            raise RuntimeError("CONSUMABLE_REHEARSAL_FAILED")
        migration = (ROOT / PATH).read_text()
        sql(transaction(migration))
        checksum = hashlib.sha256(migration.encode()).hexdigest()
        if sql("SELECT sha256 FROM mw_private.dev_migration_receipts WHERE path='" + PATH + "'") != checksum:
            raise RuntimeError("CONSUMABLE_RECEIPT_REVIEW")
        report = {"environment": "dev", "migration": "0034", "sourceSha": sha, "sha256": checksum,
                  "previousDictionaryAndProductValuesUnchanged": True, "securityUnchanged": True,
                  "isolatedRehearsal": rehearsal, "backupCreated": False, "productionChanged": False}
        (state / "consumable-characteristics-migration.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))

if __name__ == "__main__":
    main()
