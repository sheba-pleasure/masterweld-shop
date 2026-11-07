#!/usr/bin/env python3
"""Install 0038–0041 together in the exact DEV database, preserving existing values."""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import subprocess

import app_compatibility as compatibility
import restart as dev_restart

ROOT = pathlib.Path(__file__).resolve().parents[2]
IDENTITY = compatibility.IDENTITY
MIGRATIONS = {
    "docs/migrations/0038_technical_measurement_conditions.sql": "ba7fbdf8a58cb4558d7550ba73f96b8451d37ab8a3f2b5a94c3696b0c9279589",
    "docs/migrations/0039_source_fact_review.sql": "0e13a7497a551026d1ed1929fcc3f7bb05ec6914851268ac70f1f695195136ee",
    "docs/migrations/0040_technical_source_origins.sql": "2ac7d8cb31ba3c1884d8809bc469fb442373cf07aa3ce0b0921378f039de623d",
    "docs/migrations/0041_source_fact_handoff.sql": "b9f926773df2bebc98b514e28445a145137d12aaa755638dd952b8f297ff1ae9",
}
EXPECTED = {
    "public.validate_technical_document(jsonb,text)": "c2653b48a40fee1292347dc1b4ba9e44e8905d59e73d14c711c0f28f1119942b",
    "public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb)": "43f770dbcb961118f02fdff39c8d5ac8c10fef3890def7246586fbe07958b276",
    "public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint)": "5a81569d105005d0da7fa69371c71278e3dc8eb124c4ea5a1c662f0553af3e3e",
    "public.public_product_technical(uuid)": "5be5c61894ebac2f8cc182e8f0d9b230a751e34a7185bbf264fd4e7a544239cc",
    "mw_private.technical_model_context(uuid)": "692779a4e31efab3073f5ac47517de3b7ec9bcdcbd362df429efb4bb65d7426a",
    "mw_private.product_model_choice_current(uuid)": "8a4c632d21d7d7033015332cddc8372b093b4b0f8ef77096aad7f8ff5a0d2ba5",
    "public.bot_product_sources(bigint,text,uuid,uuid,integer,jsonb)": "aed6e945ecd9cb0173e1e2fcb41747e06e70ac2b4ff31ca882953c77740bd7af",
    "public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb)": "c72684ff5e0de81adf8cdf080ca36cc4016315e30772d213cdc7d8c691e8bcaf",
}
NEW_TABLES = ("source_fact_reviews", "source_fact_rows", "source_fact_prompts", "technical_fact_origins")


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


BASELINE_SQL = """
SELECT jsonb_object_agg(signature,encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(signature)),'UTF8')),'hex'))
FROM unnest(ARRAY[""" + ",".join(map(literal, EXPECTED)) + """]) signature
"""
RECEIPTS_SQL = "SELECT coalesce(jsonb_object_agg(path,sha256),'{}'::jsonb) FROM mw_private.dev_migration_receipts WHERE path IN(" + ",".join(map(literal, MIGRATIONS)) + ")"


def load_bundle():
    bundle = {path: (ROOT / path).read_text() for path in MIGRATIONS}
    if checksums(bundle) != MIGRATIONS:
        raise RuntimeError("SOURCE_FACT_MIGRATION_CHECKSUM")
    return bundle


def checksums(bundle):
    return {path: hashlib.sha256(content.encode()).hexdigest() for path, content in bundle.items()}


def transaction(bundle, expected=EXPECTED):
    """Pure SQL builder also exercised with deliberate corruption in isolated tests."""
    if list(bundle) != list(MIGRATIONS):
        raise RuntimeError("SOURCE_FACT_MIGRATION_ORDER")
    receipts = ",".join("(" + literal(path) + "," + literal(digest) + ")" for path, digest in checksums(bundle).items())
    return """
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF public.mw_environment_identity() IS DISTINCT FROM """ + literal(json.dumps(IDENTITY)) + """::jsonb
 THEN RAISE EXCEPTION 'SOURCE_FACT_DEV_REQUIRED'; END IF;
 IF to_regclass('public.product_document_sources') IS NULL
  OR to_regclass('public.source_fact_reviews') IS NOT NULL
  OR to_regclass('public.source_fact_rows') IS NOT NULL
  OR to_regclass('public.source_fact_prompts') IS NOT NULL
  OR to_regclass('public.technical_fact_origins') IS NOT NULL
  OR to_regprocedure('public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb)') IS NOT NULL
  OR to_regprocedure('mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'SOURCE_FACT_INSTALL_SCHEMA_REVIEW'; END IF;
 IF (""" + BASELINE_SQL + """) IS DISTINCT FROM """ + literal(json.dumps(expected)) + """::jsonb
 THEN RAISE EXCEPTION 'SOURCE_FACT_INSTALL_BASELINE'; END IF;
END $guard$;

CREATE TEMP TABLE source_fact_existing_values(schema_name text,name text,columns text,fingerprint text) ON COMMIT DROP;
CREATE TEMP TABLE source_fact_existing_functions ON COMMIT DROP AS
 SELECT p.oid,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','mw_private') AND p.prokind='f';
DO $before$ DECLARE t record; fingerprint text; cols text; BEGIN
 FOR t IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('public','mw_private')
  ORDER BY schemaname,tablename LOOP
  EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE',t.schemaname,t.tablename);
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text,''UTF8'')),''hex'') FROM %I.%I r',
    t.schemaname,t.tablename) INTO fingerprint;
  SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) INTO cols FROM information_schema.columns
   WHERE table_schema=t.schemaname AND table_name=t.tablename;
  INSERT INTO source_fact_existing_values VALUES(t.schemaname,t.tablename,cols,fingerprint);
 END LOOP;
END $before$;
""" + "\n".join(bundle.values()) + """
DO $after$ DECLARE t record; fingerprint text; table_name text; role_name text; signature text; f record; tr record; BEGIN
 FOR t IN SELECT * FROM source_fact_existing_values LOOP
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text,''UTF8'')),''hex'') FROM (SELECT %s FROM %I.%I) r',
    t.columns,t.schema_name,t.name) INTO fingerprint;
  IF fingerprint IS DISTINCT FROM t.fingerprint THEN RAISE EXCEPTION 'SOURCE_FACT_EXISTING_VALUES_CHANGED'; END IF;
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['source_fact_reviews','source_fact_rows','source_fact_prompts','technical_fact_origins'] LOOP
  EXECUTE format('SELECT count(*)::text FROM public.%I',table_name) INTO fingerprint;
  IF fingerprint IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'SOURCE_FACT_NEW_TABLE_NOT_EMPTY'; END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.'||table_name)) IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'SOURCE_FACT_TABLE_PRIVILEGES'; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(role_name,'public.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    THEN RAISE EXCEPTION 'SOURCE_FACT_TABLE_PRIVILEGES'; END IF;
  END LOOP;
 END LOOP;
 -- Includes moved previous RPC implementations: their OID survives a schema/name change.
 FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='mw_private' AND p.prokind='f' AND NOT EXISTS(
   SELECT 1 FROM source_fact_existing_functions b WHERE b.oid=p.oid AND b.definition=pg_get_functiondef(p.oid)) LOOP
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(role_name,f.oid,'EXECUTE')
    THEN RAISE EXCEPTION 'SOURCE_FACT_PRIVATE_FUNCTION_PRIVILEGES'; END IF;
  END LOOP;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY[
   'public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb)',
   'public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb)',
   'public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint)'
 ] LOOP
  IF has_function_privilege('anon',signature,'EXECUTE') OR has_function_privilege('authenticated',signature,'EXECUTE')
   OR NOT has_function_privilege('service_role',signature,'EXECUTE')
   THEN RAISE EXCEPTION 'SOURCE_FACT_PUBLIC_FUNCTION_PRIVILEGES'; END IF;
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(role_name,'public.validate_technical_document(jsonb,text)','EXECUTE')
   OR NOT has_function_privilege(role_name,'public.public_product_technical(uuid)','EXECUTE')
   THEN RAISE EXCEPTION 'SOURCE_FACT_READER_PRIVILEGES'; END IF;
 END LOOP;
 FOR tr IN SELECT * FROM (VALUES
  ('source_fact_input_guard','public.source_fact_prompts','mw_private.source_fact_input_exclusive()'),
  ('source_fact_document_guard','public.document_review_prompts','mw_private.source_fact_input_exclusive()'),
  ('source_fact_ordinary_guard','public.bot_editor_states','mw_private.source_fact_input_exclusive()'),
  ('source_fact_technical_guard','public.technical_editor_sessions','mw_private.source_fact_input_exclusive()'),
  ('technical_origin_immutable','public.technical_fact_origins','mw_private.technical_origin_immutable()')
 ) AS expected(name,relation,handler) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=tr.name AND tgrelid=tr.relation::regclass
     AND tgfoid=tr.handler::regprocedure AND tgenabled='O' AND NOT tgisinternal)
   THEN RAISE EXCEPTION 'SOURCE_FACT_TRIGGER_REQUIRED'; END IF;
 END LOOP;
END $after$;
CREATE TABLE IF NOT EXISTS mw_private.dev_migration_receipts(
 path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES """ + receipts + """;
NOTIFY pgrst,'reload schema';
COMMIT;
"""


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


def sql(query):
    return run(["docker", "exec", "-i", "mw-dev-db", "psql", "-X", "-Atq", "-U", "postgres",
                "-d", "masterweld_dev", "-v", "ON_ERROR_STOP=1"], input=query).stdout.strip()


def source_revision():
    if run(["git", "status", "--porcelain"], cwd=ROOT).stdout.strip():
        raise RuntimeError("COMMIT_SOURCE_REQUIRED")
    return run(["git", "rev-parse", "HEAD"], cwd=ROOT).stdout.strip()


def inspect_installation():
    installed = compatibility.schema_requirements()
    if installed:
        receipts = json.loads(sql(RECEIPTS_SQL))
        if receipts != MIGRATIONS:
            raise RuntimeError("SOURCE_FACT_RECEIPTS_REQUIRE_REVIEW")
        return {"state": "recorded", "migrationChecksums": receipts,
                "note": "Receipt read only; this does not prove application acceptance"}
    if json.loads(sql(BASELINE_SQL)) != EXPECTED:
        raise RuntimeError("SOURCE_FACT_INSTALL_BASELINE")
    return {"state": "baseline_verified", "migrationChecksums": MIGRATIONS}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Read identity, schema and receipts only")
    mode.add_argument("--apply", metavar="FULL_SHA", help="Install the bundle for this exact committed image")
    args = parser.parse_args()
    os.umask(0o077)
    bundle = load_bundle()
    if args.check:
        print(json.dumps(inspect_installation()))
        return
    sha = source_revision()
    if sha != args.apply:
        raise RuntimeError("SOURCE_FACT_EXACT_SOURCE_REQUIRED")
    state = ROOT / "ops/.state/dev"
    with (state / "update.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        image = compatibility.inspect("image", "masterweld-dev:" + sha)
        image_id = compatibility.validate_image(image, sha, True)
        if inspect_installation()["state"] != "baseline_verified":
            raise RuntimeError("SOURCE_FACT_ALREADY_RECORDED_USE_CHECK")
        tests = {}
        for name in ("source-facts-installation", "source-fact-review"):
            tests[name] = json.loads(run(["python3", str(ROOT / ("ops/tests/" + name + ".py"))], cwd=ROOT).stdout)
            if tests[name].get("ok") is not True:
                raise RuntimeError("SOURCE_FACT_INSTALL_REHEARSAL_FAILED")
        if source_revision() != sha:
            raise RuntimeError("SOURCE_FACT_SOURCE_CHANGED")
        dev_restart.preflight_image(image_id, sha)
        # The transaction repeats identity/baseline checks and checks every old value.
        # On uncertain transport failure, inspect --check; never auto-replay this write.
        sql(transaction(bundle))
        recorded = inspect_installation()
        if recorded["state"] != "recorded":
            raise RuntimeError("SOURCE_FACT_INSTALL_RECEIPT_MISSING")
        report = {"environment": "dev", "sourceSha": sha, "imageId": image_id,
                  "migrationChecksums": MIGRATIONS, "existingPublicAndPrivateValuesUnchanged": True,
                  "isolatedRehearsals": tests, "candidatePreflightPassed": True,
                  "applicationSwitched": False, "backupCreated": False, "productionChanged": False}
        temporary = state / "source-facts-migration.json.next"
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(state / "source-facts-migration.json")
        print(json.dumps(report))


if __name__ == "__main__":
    main()
