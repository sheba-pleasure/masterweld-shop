#!/usr/bin/env python3
"""Exact DEV 0043 -> inquiry-price transition. No catalog writes or backup work."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
CANONICAL = Path("/home/codex/projects/masterweld.ru")
STATE = CANONICAL / "ops/.state/dev"
MIGRATION = "docs/proposals/0045_catalog_inquiry_price.sql"
MIGRATION_SHA = "29b2bb49b7738c1694aea26192fc1a188c68109df43c222c7d718ead8479da1b"
BASELINE_FUNCTIONS = {
    "public.bot_assortment(bigint,text,uuid,text,integer,text,integer)": "f8de5930eefe5b386ee02093a960c5bf69dfb5cf88faa314a81252009e08708c",
    "public.bot_apply_pending(uuid,bigint)": "32384e4ef9bab2c10e51933ead3cb8a19376ca1b917415356655d1a2531325ca",
    "mw_private.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)": "b35ec8e3fe289436bf9198200774964817dc0f526bf7a719f03cbc724825cbbf",
}
NEW_FUNCTIONS = ("mw_private.inquiry_price_version()", "mw_private.reject_inquiry_price_order()")
PRICE_BASELINE_SQL = """SELECT EXISTS(
 SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='public.products'::regclass AND a.attname='price' AND NOT a.attisdropped
  AND a.attnotnull AND a.atthasdef AND format_type(a.atttypid,a.atttypmod)='numeric(12,2)'
  AND pg_get_expr(d.adbin,d.adrelid)='0')"""
sys.path.insert(0, str(ROOT / "ops/dev"))
import app_compatibility as guard
import documentary_transition
import restart

spec = importlib.util.spec_from_file_location("inquiry_transition_runtime", ROOT / "ops/dev/apply-documentary-conditions.py")
transition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transition)
# Source is the exact checked worktree; runtime state/secrets always remain canonical.
transition.STATE = STATE
transition.JOURNAL = STATE / "inquiry-price-transition.json"
transition.PREVIOUS_PREFIX = "mw-dev-before-inquiry-price-"
restart.ROOT = CANONICAL


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def load_migration():
    value = (ROOT / MIGRATION).read_text()
    if hashlib.sha256(value.encode()).hexdigest() != MIGRATION_SHA:
        raise RuntimeError("INQUIRY_MIGRATION_CHECKSUM")
    return value


def baseline_function_sql():
    return """SELECT jsonb_object_agg(signature,encode(sha256(convert_to(
        pg_get_functiondef(to_regprocedure(signature)),'UTF8')),'hex'))
        FROM unnest(ARRAY[""" + ",".join(map(literal, BASELINE_FUNCTIONS)) + """]) signature"""


def schema_snapshot(name):
    """Reuse the complete release guard inside the atomic migration transaction."""
    probe = guard.SCHEMA_SQL.strip()
    if not probe.startswith("BEGIN TRANSACTION ") or not probe.endswith("COMMIT;"):
        raise RuntimeError("INQUIRY_SCHEMA_PROBE_CONTRACT")
    probe = probe.split(";", 1)[1].rsplit("COMMIT;", 1)[0].strip()
    if probe.count("SELECT jsonb_build_object(") != 1 or not probe.endswith(");"):
        raise RuntimeError("INQUIRY_SCHEMA_PROBE_CONTRACT")
    probe = probe.replace("SELECT jsonb_build_object(",
                          "CREATE TEMP TABLE " + name + " ON COMMIT DROP AS SELECT jsonb_build_object(", 1)
    return probe[:-1] + " AS state;\nSET LOCAL statement_timeout='60s';\n"


def expected_schema(installed):
    return {"identity": guard.IDENTITY, "sourceFacts": [True] * 6,
            "documentaryConditions": [True] * 6, "accessoryDictionary": [True] * 4,
            "inquiryPrice": [installed] * 6}


def binding_path(source_sha):
    return "ops/dev/apply-inquiry-prices.py@" + source_sha


def transaction(source_sha, image_id, migration=None):
    """Pure builder: capture all old values/permissions, then commit one exact receipt."""
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha or "") or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id or ""):
        raise RuntimeError("INQUIRY_EXACT_SOURCE_IMAGE_REQUIRED")
    migration = load_migration() if migration is None else migration
    if hashlib.sha256(migration.encode()).hexdigest() != MIGRATION_SHA:
        raise RuntimeError("INQUIRY_MIGRATION_CHECKSUM")
    changed = ",".join(literal(x) + "::regprocedure" for x in BASELINE_FUNCTIONS)
    added = ",".join(literal(x) + "::regprocedure" for x in NEW_FUNCTIONS)
    return """
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(hashtextextended('masterweld-dev-schema-install',0));
""" + schema_snapshot("inquiry_schema_before") + """
DO $baseline$ BEGIN
 IF (SELECT state FROM inquiry_schema_before) IS DISTINCT FROM """ + literal(json.dumps(expected_schema(False))) + """::jsonb
 THEN RAISE EXCEPTION 'INQUIRY_EXACT_0043_REQUIRED'; END IF;
 IF to_regclass('mw_private.supplier_publications') IS NOT NULL
  OR to_regclass('mw_private.supplier_raw_sources') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.products'::regclass
       AND attname='test_archive' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'INQUIRY_SVAROG_SCHEMA_EXCLUDED'; END IF;
 IF (""" + baseline_function_sql() + """) IS DISTINCT FROM """ + literal(json.dumps(BASELINE_FUNCTIONS)) + """::jsonb
 THEN RAISE EXCEPTION 'INQUIRY_FUNCTION_BASELINE'; END IF;
 IF NOT (""" + PRICE_BASELINE_SQL + """) THEN RAISE EXCEPTION 'INQUIRY_PRICE_COLUMN_BASELINE'; END IF;
 IF to_regclass('mw_private.dev_migration_receipts') IS NULL
 THEN RAISE EXCEPTION 'INQUIRY_RECEIPTS_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM mw_private.dev_migration_receipts WHERE path=""" + literal(MIGRATION) + """
   OR path LIKE 'ops/dev/apply-inquiry-prices.py@%')
 THEN RAISE EXCEPTION 'INQUIRY_ALREADY_RECORDED'; END IF;
END $baseline$;

CREATE TEMP TABLE inquiry_old_rows(schema_name text,name text,columns text,fingerprint text) ON COMMIT DROP;
DO $capture$ DECLARE t record; cols text; fingerprint text; BEGIN
 FOR t IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('public','mw_private')
  ORDER BY schemaname,tablename LOOP
  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',t.schemaname,t.tablename);
  SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) INTO cols
   FROM information_schema.columns WHERE table_schema=t.schemaname AND table_name=t.tablename;
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text,''UTF8'')),''hex'') FROM %I.%I r',
   t.schemaname,t.tablename) INTO fingerprint;
  INSERT INTO inquiry_old_rows VALUES(t.schemaname,t.tablename,cols,fingerprint);
 END LOOP;
END $capture$;
CREATE TEMP TABLE inquiry_old_functions ON COMMIT DROP AS
 SELECT p.oid,CASE WHEN p.oid IN(""" + changed + """) THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END metadata
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','mw_private');
CREATE TEMP TABLE inquiry_old_relations ON COMMIT DROP AS
 SELECT c.oid,jsonb_build_array(c.relname,c.relnamespace,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) metadata
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','mw_private') AND c.relkind IN('r','p','v','m','S','f');
CREATE TEMP TABLE inquiry_old_columns ON COMMIT DROP AS
 SELECT a.attrelid,a.attnum,
 CASE WHEN a.attrelid='public.products'::regclass AND a.attname='price'
 THEN to_jsonb(a)-'attnotnull'-'atthasdef' ELSE to_jsonb(a) END metadata
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','mw_private');
CREATE TEMP TABLE inquiry_old_defaults ON COMMIT DROP AS
 SELECT d.* FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
 JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','mw_private') AND NOT(a.attrelid='public.products'::regclass AND a.attname='price');
CREATE TEMP TABLE inquiry_old_policies ON COMMIT DROP AS SELECT * FROM pg_policy;
CREATE TEMP TABLE inquiry_old_roles ON COMMIT DROP AS SELECT * FROM pg_roles;
CREATE TEMP TABLE inquiry_old_memberships ON COMMIT DROP AS SELECT * FROM pg_auth_members;
CREATE TEMP TABLE inquiry_old_triggers ON COMMIT DROP AS
 SELECT t.* FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','mw_private');
CREATE TEMP TABLE inquiry_old_constraints ON COMMIT DROP AS
 SELECT c.oid,to_jsonb(c) metadata FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
 WHERE n.nspname IN('public','mw_private');
""" + migration + schema_snapshot("inquiry_schema_after") + """
DO $preservation$ DECLARE t record; fingerprint text; role_name text; signature text; BEGIN
 IF (SELECT state FROM inquiry_schema_after) IS DISTINCT FROM """ + literal(json.dumps(expected_schema(True))) + """::jsonb
 THEN RAISE EXCEPTION 'INQUIRY_SCHEMA_INCOMPLETE'; END IF;
 FOR t IN SELECT * FROM inquiry_old_rows LOOP
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text,''UTF8'')),''hex'') FROM (SELECT %s FROM %I.%I) r',
   t.columns,t.schema_name,t.name) INTO fingerprint;
  IF fingerprint IS DISTINCT FROM t.fingerprint THEN RAISE EXCEPTION 'INQUIRY_EXISTING_VALUES_CHANGED'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.catalog_imports WHERE inquiry_price IS DISTINCT FROM false)
 THEN RAISE EXCEPTION 'INQUIRY_IMPORT_DEFAULT_CHANGED'; END IF;
 IF EXISTS(
  WITH current_functions AS(
   SELECT p.oid,CASE WHEN p.oid IN(""" + changed + """) THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END metadata
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN('public','mw_private') AND p.oid NOT IN(""" + added + """))
  SELECT 1 FROM inquiry_old_functions b FULL JOIN current_functions a USING(oid)
  WHERE b.metadata IS DISTINCT FROM a.metadata)
 THEN RAISE EXCEPTION 'INQUIRY_FUNCTIONS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_relations AS(
   SELECT c.oid,jsonb_build_array(c.relname,c.relnamespace,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) metadata
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','mw_private') AND c.relkind IN('r','p','v','m','S','f'))
  SELECT 1 FROM inquiry_old_relations b FULL JOIN current_relations a USING(oid)
  WHERE b.metadata IS DISTINCT FROM a.metadata)
 THEN RAISE EXCEPTION 'INQUIRY_RELATIONS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_columns AS(
   SELECT a.attrelid,a.attnum,
    CASE WHEN a.attrelid='public.products'::regclass AND a.attname='price'
    THEN to_jsonb(a)-'attnotnull'-'atthasdef' ELSE to_jsonb(a) END metadata
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','mw_private')
    AND NOT(a.attrelid='public.catalog_imports'::regclass AND a.attname='inquiry_price'))
  SELECT 1 FROM inquiry_old_columns b FULL JOIN current_columns a USING(attrelid,attnum)
  WHERE b.metadata IS DISTINCT FROM a.metadata)
 THEN RAISE EXCEPTION 'INQUIRY_COLUMNS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_defaults AS(
   SELECT d.* FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
   JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','mw_private') AND NOT(a.attrelid='public.catalog_imports'::regclass AND a.attname='inquiry_price'))
  (TABLE inquiry_old_defaults EXCEPT TABLE current_defaults) UNION ALL
  (TABLE current_defaults EXCEPT TABLE inquiry_old_defaults))
 THEN RAISE EXCEPTION 'INQUIRY_DEFAULTS_CHANGED'; END IF;
 IF EXISTS((TABLE inquiry_old_policies EXCEPT TABLE pg_policy) UNION ALL (TABLE pg_policy EXCEPT TABLE inquiry_old_policies))
 OR EXISTS((TABLE inquiry_old_roles EXCEPT TABLE pg_roles) UNION ALL (TABLE pg_roles EXCEPT TABLE inquiry_old_roles))
 OR EXISTS((TABLE inquiry_old_memberships EXCEPT TABLE pg_auth_members) UNION ALL (TABLE pg_auth_members EXCEPT TABLE inquiry_old_memberships))
 THEN RAISE EXCEPTION 'INQUIRY_ACCESS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_triggers AS(
   SELECT trg.* FROM pg_trigger trg JOIN pg_class c ON c.oid=trg.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','mw_private')
    AND NOT(trg.tgrelid='public.shop_orders'::regclass AND trg.tgname='reject_inquiry_price_order'))
  (TABLE inquiry_old_triggers EXCEPT TABLE current_triggers) UNION ALL
  (TABLE current_triggers EXCEPT TABLE inquiry_old_triggers))
 THEN RAISE EXCEPTION 'INQUIRY_TRIGGERS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_constraints AS(
   SELECT c.oid,to_jsonb(c) metadata FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
   WHERE n.nspname IN('public','mw_private'))
  SELECT 1 FROM inquiry_old_constraints b FULL JOIN current_constraints a USING(oid)
  WHERE b.metadata IS DISTINCT FROM a.metadata)
 THEN RAISE EXCEPTION 'INQUIRY_CONSTRAINTS_CHANGED'; END IF;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH signature IN ARRAY ARRAY[""" + ",".join(map(literal, NEW_FUNCTIONS)) + """] LOOP
   IF has_function_privilege(role_name,signature,'EXECUTE')
   THEN RAISE EXCEPTION 'INQUIRY_NEW_FUNCTION_ACCESS'; END IF;
  END LOOP;
  IF has_table_privilege(role_name,'mw_private.dev_migration_receipts','INSERT,UPDATE,DELETE,TRUNCATE')
  THEN RAISE EXCEPTION 'INQUIRY_RECEIPT_ACCESS'; END IF;
 END LOOP;
END $preservation$;
INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES
 (""" + literal(MIGRATION) + "," + literal(MIGRATION_SHA) + """),
 (""" + literal(binding_path(source_sha)) + "," + literal(hashlib.sha256(image_id.encode()).hexdigest()) + """);
NOTIFY pgrst,'reload schema';
COMMIT;
"""


def baseline():
    if guard.schema_requirements() != guard.SCHEMA_0043_CAPABILITIES:
        raise RuntimeError("INQUIRY_EXACT_0043_REQUIRED")
    if json.loads(transition.sql(baseline_function_sql())) != BASELINE_FUNCTIONS:
        raise RuntimeError("INQUIRY_FUNCTION_BASELINE")
    if transition.sql(PRICE_BASELINE_SQL) != "t":
        raise RuntimeError("INQUIRY_PRICE_COLUMN_BASELINE")
    if transition.sql("SELECT count(*) FROM mw_private.dev_migration_receipts WHERE path=" + literal(MIGRATION)
                      + " OR path LIKE 'ops/dev/apply-inquiry-prices.py@%'") != "0":
        raise RuntimeError("INQUIRY_ALREADY_RECORDED_USE_CHECK")


transition.baseline = baseline


class Adapter(transition.Adapter):
    def migrate(self, record):
        if transition.revision() != record["sourceSha"]:
            raise RuntimeError("INQUIRY_SOURCE_CHANGED")
        transition.sql(transaction(record["sourceSha"], record["imageId"]))

    def confirm_commit(self, record):
        if guard.schema_requirements() != guard.SCHEMA_0045_CAPABILITIES:
            raise RuntimeError("INQUIRY_COMMITTED_SCHEMA_REQUIRED")
        raw = transition.sql("SELECT coalesce(jsonb_object_agg(path,sha256),'{}'::jsonb) "
            "FROM mw_private.dev_migration_receipts WHERE path=" + literal(MIGRATION) +
            " OR path LIKE 'ops/dev/apply-inquiry-prices.py@%'")
        expected = {MIGRATION: MIGRATION_SHA, binding_path(record["sourceSha"]):
                    hashlib.sha256(record["imageId"].encode()).hexdigest()}
        if json.loads(raw) != expected:
            raise RuntimeError("INQUIRY_RECEIPT_REQUIRES_REVIEW")
        guard.validate_image(guard.inspect("image", record["imageId"]), record["sourceSha"],
                             guard.SCHEMA_0045_CAPABILITIES)

    def activate(self, record):
        restart.preflight_image(record["imageId"], record["sourceSha"])
        super().activate(record)


def prepare(sha):
    baseline()
    image_id = guard.validate_image(guard.inspect("image", "masterweld-dev:" + sha),
                                    sha, guard.SCHEMA_0045_CAPABILITIES)
    old = guard.inspect("container", restart.APP)
    guard.owned(old)
    if not old["State"]["Running"] or set(old["NetworkSettings"]["Networks"]) != {
            restart.EDGE_NETWORK, restart.PRIVATE_NETWORK}:
        raise RuntimeError("INQUIRY_ACTIVE_APP_REQUIRED")
    old_revision = guard.validate_previous(old)
    worker = guard.inspect("container", transition.WORKER)
    guard.owned(worker)
    record = dict(version=2, phase="prepared", operation=uuid.uuid4().hex,
                  sourceSha=sha, imageId=image_id, oldId=old["Id"], oldImage=old["Image"],
                  oldRevision=old_revision, workerId=worker["Id"], workerImage=worker["Image"])
    transition.check_record(record)
    if not transition.checked_worker(record)["State"]["Running"]:
        raise RuntimeError("INQUIRY_RUNNING_WORKER_REQUIRED")
    test = json.loads(transition.run(["python3", "-B", str(ROOT / "ops/tests/catalog-inquiry-price.py")],
                                    cwd=ROOT, timeout=300).stdout)
    if (test.get("ok") is not True or test.get("proposal_sha256") != MIGRATION_SHA
            or test.get("installation_wrapper") is not True
            or test.get("baseline_functions") != BASELINE_FUNCTIONS):
        raise RuntimeError("INQUIRY_ISOLATED_REHEARSAL_REQUIRED")
    if transition.revision() != sha:
        raise RuntimeError("INQUIRY_SOURCE_CHANGED")
    restart.preflight_image(image_id, sha)
    baseline()
    transition.persist(record, "prepared", create=True)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--apply", metavar="EXACT_SHA")
    modes.add_argument("--finish", metavar="EXACT_SHA")
    args = parser.parse_args()
    os.umask(0o077)
    load_migration()
    if args.check:
        required = guard.schema_requirements()
        record = transition.check_record(json.loads(transition.JOURNAL.read_text())) if transition.JOURNAL.exists() else None
        receipts = json.loads(transition.sql("SELECT coalesce(jsonb_object_agg(path,sha256),'{}'::jsonb) "
            "FROM mw_private.dev_migration_receipts WHERE path=" + literal(MIGRATION) +
            " OR path LIKE 'ops/dev/apply-inquiry-prices.py@%'"))
        print(json.dumps({"requiredCapabilities": sorted(required),
                          "transition": record, "receipts": receipts}))
        return
    sha = args.apply or args.finish
    if transition.revision() != sha:
        raise RuntimeError("INQUIRY_EXACT_COMMITTED_SOURCE_REQUIRED")
    with (STATE / "update.lock").open("a") as app_lock, (STATE / "document-parser-update.lock").open("a") as parser_lock:
        fcntl.flock(app_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(parser_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.apply:
            if transition.JOURNAL.exists():
                raise RuntimeError("INQUIRY_JOURNAL_EXISTS_USE_CHECK")
            record = prepare(sha)
        else:
            record = transition.check_record(json.loads(transition.JOURNAL.read_text()))
            if record["sourceSha"] != sha:
                raise RuntimeError("INQUIRY_JOURNAL_REVISION_MISMATCH")
        result = documentary_transition.execute(Adapter(), record, apply=bool(args.apply))
        print(json.dumps({**result, "backupCreated": False, "productionChanged": False,
                          "catalogChanged": False, "proposalSha256": MIGRATION_SHA}))


if __name__ == "__main__":
    main()
