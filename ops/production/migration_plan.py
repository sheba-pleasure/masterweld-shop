#!/usr/bin/env python3
"""Inspect, prepare and check an empty PRO migration. No command executes a plan."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import uuid

from preflight import DEV_ID, ROOT, expected_schema_files

# Structural metadata only. No row values, role passwords or physical statistics.
# OIDs intentionally bind this fingerprint to one database, not another restore.
METADATA_SQL = """
WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname IN ('public','mw_private')),
rels AS (SELECT oid FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns)),
items(kind,value) AS (
 SELECT 'namespace',to_jsonb(n) FROM pg_namespace n WHERE oid IN (SELECT oid FROM ns)
 UNION ALL SELECT 'relation',jsonb_build_array(oid,relname,relnamespace,reltype,relowner,
   relam,relkind,relpersistence,relisshared,relrowsecurity,relforcerowsecurity,
   relreplident,relispartition,relacl,reloptions,relpartbound)
 FROM pg_class WHERE oid IN (SELECT oid FROM rels)
 UNION ALL SELECT 'column',to_jsonb(a) FROM pg_attribute a WHERE attrelid IN (SELECT oid FROM rels)
 UNION ALL SELECT 'function',to_jsonb(p) FROM pg_proc p WHERE pronamespace IN (SELECT oid FROM ns)
 UNION ALL SELECT 'type',to_jsonb(t) FROM pg_type t WHERE typnamespace IN (SELECT oid FROM ns)
 UNION ALL SELECT 'constraint',to_jsonb(c) FROM pg_constraint c WHERE connamespace IN (SELECT oid FROM ns)
 UNION ALL SELECT 'policy',to_jsonb(p) FROM pg_policy p WHERE polrelid IN (SELECT oid FROM rels)
 UNION ALL SELECT 'trigger',to_jsonb(t) FROM pg_trigger t WHERE tgrelid IN (SELECT oid FROM rels)
 UNION ALL SELECT 'default',to_jsonb(d) FROM pg_attrdef d WHERE adrelid IN (SELECT oid FROM rels)
 UNION ALL SELECT 'index',to_jsonb(i) FROM pg_index i WHERE indrelid IN (SELECT oid FROM rels)
 UNION ALL SELECT 'rule',to_jsonb(r) FROM pg_rewrite r WHERE ev_class IN (SELECT oid FROM rels)
 UNION ALL SELECT 'enum',to_jsonb(e) FROM pg_enum e
   WHERE enumtypid IN (SELECT oid FROM pg_type WHERE typnamespace IN (SELECT oid FROM ns))
 UNION ALL SELECT 'sequence',to_jsonb(s) FROM pg_sequence s WHERE seqrelid IN (SELECT oid FROM rels)
 UNION ALL SELECT 'default_acl',to_jsonb(a) FROM pg_default_acl a
   WHERE defaclnamespace=0 OR defaclnamespace IN (SELECT oid FROM ns)
 UNION ALL SELECT 'role',to_jsonb(r)-'rolpassword' FROM pg_roles r
 UNION ALL SELECT 'membership',to_jsonb(m) FROM pg_auth_members m
)
SELECT encode(sha256(convert_to(
 coalesce(jsonb_agg(jsonb_build_array(kind,value) ORDER BY kind,value::text),'[]')::text,'UTF8')),'hex')
FROM items
"""
COUNTS_SQL = """
DO $counts$
DECLARE t record; amount bigint; counts jsonb:='{}'; receipt jsonb:='null';
BEGIN
 FOR t IN SELECT schemaname,tablename FROM pg_tables
   WHERE schemaname='public' ORDER BY tablename LOOP
  EXECUTE format('SELECT count(*) FROM %I.%I',t.schemaname,t.tablename) INTO amount;
  counts:=counts||jsonb_build_object(t.tablename,amount);
 END LOOP;
 IF to_regclass('mw_private.production_migration_receipts') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(r ORDER BY operation_id),''[]'') FROM mw_private.production_migration_receipts r'
   INTO receipt;
 END IF;
 PERFORM set_config('mw.plan_counts',counts::text,true);
 PERFORM set_config('mw.plan_receipts',receipt::text,true);
END $counts$;
"""
INSPECTION_SQL = """
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s';
""" + COUNTS_SQL + """
SELECT jsonb_build_object(
 'identity',public.mw_environment_identity(),
 'files',(SELECT coalesce(jsonb_object_agg(path,sha256),'{}') FROM mw_private.schema_files),
 'counts',current_setting('mw.plan_counts')::jsonb,
 'privateTables',(SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='mw_private'),
 'receipts',current_setting('mw.plan_receipts')::jsonb,
 'schemaFingerprint',(""" + METADATA_SQL + """));
COMMIT;
"""
DICTIONARIES = {
    "technical_units": "units", "technical_families": "families",
    "technical_attributes": "attributes", "technical_family_attributes": "bindings",
}
SEEDS = ["src/lib/technical/" + name + "-dictionary.json" for name in ("pilot", "consumable", "accessory")]


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def json_literal(value):
    return literal(canonical(value)) + "::jsonb"


def identity_check(value):
    if not isinstance(value, dict) or set(value) != {"environment", "instanceId"}:
        raise ValueError("PLAN_IDENTITY_INVALID")
    try:
        parsed = str(uuid.UUID(value["instanceId"]))
    except (ValueError, TypeError, AttributeError):
        raise ValueError("PLAN_IDENTITY_INVALID") from None
    if value["environment"] != "production" or parsed != value["instanceId"] or parsed == DEV_ID:
        raise ValueError("PLAN_PRODUCTION_REQUIRED")


def inventory():
    expected = expected_schema_files(ROOT)
    paths = sorted(expected, key=lambda p: pathlib.Path(p).name)
    numbers = [pathlib.Path(p).name[:4] for p in paths]
    if numbers != [f"{n:04d}" for n in range(44)]:
        raise ValueError("PLAN_MIGRATION_SCOPE_CHANGED")
    return expected, paths


def baseline_check(state, expected):
    identity_check(state.get("identity"))
    baseline = {p: h for p, h in expected.items() if pathlib.Path(p).name[:4] <= "0013"}
    if state.get("files") != baseline:
        raise ValueError("PLAN_BASELINE_LEDGER_REQUIRED")
    counts = state.get("counts")
    if not isinstance(counts, dict) or not counts or any(type(n) is not int or n != 0 for n in counts.values()):
        raise ValueError("PLAN_EMPTY_DATABASE_REQUIRED")
    if state.get("privateTables") != ["environment", "schema_files"]:
        raise ValueError("PLAN_PRIVATE_BASELINE_CHANGED")
    if state.get("receipts") is not None:
        raise ValueError("PLAN_EXISTING_RECEIPTS_REVIEW_REQUIRED")
    if not re.fullmatch(r"[0-9a-f]{64}", state.get("schemaFingerprint", "")):
        raise ValueError("PLAN_SCHEMA_FINGERPRINT_REQUIRED")


def build_plan(state, source_sha, operation_id):
    expected, paths = inventory()
    baseline_check(state, expected)
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("PLAN_SOURCE_SHA_REQUIRED")
    if str(uuid.UUID(operation_id)) != operation_id:
        raise ValueError("PLAN_OPERATION_INVALID")
    sources = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest()
               for p in ["ops/production/migration_plan.py", "ops/production/preflight.py", *SEEDS]}
    manifest = {
        "version": 1, "operationId": operation_id, "sourceSha": source_sha,
        "identity": state["identity"], "baseline": state,
        "targetFiles": expected, "sources": sources,
        "scope": "empty-standalone-production-0013-to-0043",
    }
    payload_hash = digest(manifest)
    chunks = ["""
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SET LOCAL idle_in_transaction_session_timeout='60s';
SELECT pg_advisory_xact_lock(741863,43);
DO $baseline$
DECLARE locked_table record; actual text; amount bigint;
BEGIN
 IF public.mw_environment_identity() IS DISTINCT FROM """ + json_literal(state["identity"]) + """
  THEN RAISE EXCEPTION 'PLAN_IDENTITY_CHANGED'; END IF;
 FOR locked_table IN SELECT schemaname,tablename FROM pg_tables
   WHERE schemaname IN ('public','mw_private') ORDER BY schemaname,tablename LOOP
  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',locked_table.schemaname,locked_table.tablename);
 END LOOP;
 IF to_regclass('mw_private.production_migration_receipts') IS NOT NULL
  THEN RAISE EXCEPTION 'PLAN_ALREADY_ATTEMPTED_READ_STATUS'; END IF;
 SELECT (""" + METADATA_SQL + """) INTO actual;
 IF actual <> """ + literal(state["schemaFingerprint"]) + """
  THEN RAISE EXCEPTION 'PLAN_SCHEMA_CHANGED'; END IF;
 IF (SELECT jsonb_object_agg(path,sha256) FROM mw_private.schema_files)
   IS DISTINCT FROM """ + json_literal(state["files"]) + """
  THEN RAISE EXCEPTION 'PLAN_LEDGER_CHANGED'; END IF;
 FOR locked_table IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',locked_table.tablename) INTO amount;
  IF amount<>0 THEN RAISE EXCEPTION 'PLAN_DATABASE_NO_LONGER_EMPTY'; END IF;
 END LOOP;
END $baseline$;
"""]
    for path in paths[14:]:
        content = (ROOT / path).read_text()
        if hashlib.sha256(content.encode()).hexdigest() != expected[path]:
            raise ValueError("PLAN_SOURCE_CHANGED")
        chunks.append(content + "\nINSERT INTO mw_private.schema_files VALUES(" +
                      literal(path) + "," + literal(expected[path]) + ");")
    seeds = [json.loads((ROOT / p).read_text()) for p in SEEDS]
    dictionary_checks = []
    for table, key in DICTIONARIES.items():
        rows = [row for seed in seeds for row in seed.get(key, [])]
        # Compare complete rows, not counts or only field identifiers.
        dictionary_checks.append("""
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')
 INTO actual_dictionary FROM public.""" + table + """ t;
 SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]') INTO expected_dictionary
 FROM jsonb_array_elements(""" + json_literal(rows) + """) x;
 IF actual_dictionary IS DISTINCT FROM expected_dictionary
  THEN RAISE EXCEPTION 'PLAN_DICTIONARY_MISMATCH:""" + table + """'; END IF;
""")
    chunks.append("""
DO $target$
DECLARE checked_table record; amount bigint; actual_dictionary jsonb; expected_dictionary jsonb;
BEGIN
 IF public.mw_environment_identity() IS DISTINCT FROM """ + json_literal(state["identity"]) + """
  THEN RAISE EXCEPTION 'PLAN_IDENTITY_CHANGED'; END IF;
 IF (SELECT jsonb_object_agg(path,sha256) FROM mw_private.schema_files)
   IS DISTINCT FROM """ + json_literal(expected) + """
  THEN RAISE EXCEPTION 'PLAN_TARGET_LEDGER_MISMATCH'; END IF;
""" + "\n".join(dictionary_checks) + """
 FOR checked_table IN SELECT tablename FROM pg_tables WHERE schemaname='public'
   AND tablename NOT IN ('technical_units','technical_families','technical_attributes','technical_family_attributes') LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',checked_table.tablename) INTO amount;
  IF amount<>0 THEN RAISE EXCEPTION 'PLAN_UNEXPECTED_BUSINESS_DATA'; END IF;
 END LOOP;
 IF has_table_privilege('anon','public.product_costs','SELECT')
   OR has_table_privilege('authenticated','public.product_costs','SELECT')
   OR has_table_privilege('anon','public.shop_orders','INSERT')
   OR has_table_privilege('authenticated','public.shop_orders','INSERT')
   OR has_table_privilege('service_role','public.shop_orders','INSERT')
  THEN RAISE EXCEPTION 'PLAN_PUBLIC_WRITE_OR_COST_BYPASS'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='mw_private' AND (
   has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')
   OR has_function_privilege('service_role',p.oid,'EXECUTE')))
  THEN RAISE EXCEPTION 'PLAN_PRIVATE_FUNCTION_EXPOSED'; END IF;
END $target$;
CREATE TABLE mw_private.production_migration_receipts(
 operation_id uuid PRIMARY KEY, source_sha text NOT NULL,
 payload_hash text NOT NULL, baseline_fingerprint text NOT NULL,
 target_fingerprint text NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON mw_private.production_migration_receipts FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO mw_private.production_migration_receipts
 (operation_id,source_sha,payload_hash,baseline_fingerprint,target_fingerprint)
VALUES (""" + ",".join(literal(x) for x in (
        operation_id, source_sha, payload_hash, state["schemaFingerprint"])) + """,
 (""" + METADATA_SQL + """));
COMMIT;
""")
    return {"manifest": manifest, "payloadHash": payload_hash, "sql": "\n".join(chunks)}


def validate_plan(plan):
    manifest = plan["manifest"]
    expected = build_plan(manifest["baseline"], manifest["sourceSha"], manifest["operationId"])
    if plan != expected:
        raise ValueError("PLAN_CONTENT_OR_SOURCE_CHANGED")
    return manifest


def result_status(plan, state):
    manifest = validate_plan(plan)
    if state.get("identity") != manifest["identity"]:
        return "review_required"
    receipts = state.get("receipts")
    if receipts is None:
        return "baseline_unchanged" if state == manifest["baseline"] else "review_required"
    if not isinstance(receipts, list) or len(receipts) != 1 or state.get("files") != manifest["targetFiles"]:
        return "review_required"
    row = receipts[0]
    expected = {
        "operation_id": manifest["operationId"], "source_sha": manifest["sourceSha"],
        "payload_hash": plan["payloadHash"],
        "baseline_fingerprint": manifest["baseline"]["schemaFingerprint"],
        "target_fingerprint": state.get("schemaFingerprint"),
    }
    if any(row.get(k) != v for k, v in expected.items()) or not row.get("committed_at"):
        return "review_required"
    return "committed"


def inspect_production():
    # Fixed read-only target. No user-supplied SQL, container, or credentials.
    result = subprocess.run(["docker", "inspect", "mw-prod-db"], capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise ValueError("PLAN_DATABASE_UNAVAILABLE")
    container = json.loads(result.stdout)[0]
    if ((container.get("Config", {}).get("Labels") or {}).get("mw.environment") != "production"
            or container.get("State", {}).get("Running") is not True):
        raise ValueError("PLAN_PRODUCTION_CONTAINER_REQUIRED")
    result = subprocess.run(["docker", "exec", "-i", "mw-prod-db", "psql", "-X", "-U", "postgres",
                             "-d", "masterweld_production", "-Atq", "-v", "ON_ERROR_STOP=1"],
                            input=INSPECTION_SQL, capture_output=True, text=True, timeout=25)
    if result.returncode:
        raise ValueError("PLAN_INSPECTION_FAILED")
    state = json.loads(result.stdout)
    identity_check(state.get("identity"))
    return state


def private_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o077:
            raise ValueError("PLAN_PRIVATE_FILE_REQUIRED")
        return json.load(stream)


def private_write(path, value):
    # Exclusive creation prevents accidentally replacing a previously reviewed plan.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    inspect_args = sub.add_parser("inspect", help="Read schema metadata and counts only")
    inspect_args.add_argument("--output", type=pathlib.Path, required=True)
    plan_args = sub.add_parser("plan", help="Write an offline plan; never execute it")
    plan_args.add_argument("--inspection", type=pathlib.Path, required=True)
    plan_args.add_argument("--output", type=pathlib.Path, required=True)
    status_args = sub.add_parser("status", help="Read the receipt; never retry SQL")
    status_args.add_argument("--plan", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.command == "inspect":
        state = inspect_production()
        private_write(args.output, state)
        print(json.dumps({"inspectionWritten": True, "databaseChanged": False}))
    elif args.command == "plan":
        state = private_read(args.inspection)
        if subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True).stdout:
            raise ValueError("PLAN_CLEAN_COMMIT_REQUIRED")
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        plan = build_plan(state, sha, str(uuid.uuid4()))
        private_write(args.output, plan)
        print(json.dumps({"operationId": plan["manifest"]["operationId"], "sourceSha": sha,
                          "payloadHash": plan["payloadHash"], "executed": False, "releaseApproved": False}))
    else:
        plan = private_read(args.plan)
        validate_plan(plan)
        status = result_status(plan, inspect_production())
        print(json.dumps({"status": status, "retried": False, "releaseApproved": False}))
        if status == "review_required":
            raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        # Only our fixed diagnostic codes may leave the process; never provider stderr.
        code = str(error)
        if not re.fullmatch(r"PLAN_[A-Z_]+", code):
            code = "PLAN_INPUT_OR_OPERATION_FAILED"
        raise SystemExit(code + ": Inspect current state; do not retry installation blindly.")
