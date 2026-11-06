#!/usr/bin/env python3
"""Apply an explicit technical migration only to identified DEV after backup/rehearsal."""
import fcntl
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import uuid
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONTAINER = "mw-dev-db"
DB = "masterweld_dev"
IDENTITY = {"environment": "dev", "instanceId": "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}
MIGRATION = ROOT / "docs/migrations/0017_technical_catalog.sql"

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)

def sql(query, database=DB):
    return run(["docker","exec","-i",CONTAINER,"psql","-U","postgres","-d",database,
                "-X","-Atq","-v","ON_ERROR_STOP=1"],input=query.encode()).stdout.decode().strip()

def validate_identity(actual):
    if actual != IDENTITY:
        raise RuntimeError("TECH_DEV_IDENTITY_MISMATCH")

def require_clean_source():
    if run(["git","status","--porcelain","--untracked-files=normal"],cwd=ROOT).stdout.strip():
        raise RuntimeError("COMMIT_SOURCE_BEFORE_MIGRATION")
    return run(["git","rev-parse","HEAD"],cwd=ROOT).stdout.decode().strip()

def transaction(migration, read_fix=False, version_guard=False):
    if read_fix and version_guard: raise RuntimeError("UNSUPPORTED_MIGRATION_ARGUMENT")
    guard = """
IF to_regclass('public.technical_cards') IS NULL THEN RAISE EXCEPTION 'TECH_BASELINE_MISSING'; END IF;
IF to_regprocedure('public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint)') IS NOT NULL
  THEN RAISE EXCEPTION 'TECH_ALREADY_APPLIED'; END IF;
IF strpos(pg_get_functiondef('public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text)'::regprocedure),
  'technical-read-alias-v2')>0 THEN RAISE EXCEPTION 'TECH_ALREADY_APPLIED'; END IF;
""" if read_fix else """
IF to_regclass('public.technical_cards') IS NOT NULL THEN RAISE EXCEPTION 'TECH_ALREADY_APPLIED'; END IF;
"""
    if version_guard:
        guard = """
IF to_regprocedure('public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint)') IS NOT NULL
  THEN RAISE EXCEPTION 'TECH_ALREADY_APPLIED'; END IF;
IF to_regprocedure('public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text)') IS NULL
  THEN RAISE EXCEPTION 'TECH_BASELINE_MISSING'; END IF;
IF strpos(pg_get_functiondef('public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text)'::regprocedure),
  'technical-read-alias-v2')=0 THEN RAISE EXCEPTION 'TECH_BASELINE_MISSING'; END IF;
"""
    # Fingerprint each existing application table inside the transaction. No SQL
    # seed changes a product, old specs, price, order, staff row or delivery receipt.
    return """
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
IF public.mw_environment_identity() IS DISTINCT FROM '{"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}'::jsonb
THEN RAISE EXCEPTION 'TECH_DEV_IDENTITY_MISMATCH'; END IF;
""" + guard + """
IF to_regclass('public.telegram_bot_updates') IS NULL THEN RAISE EXCEPTION 'TECH_BASELINE_MISSING'; END IF;
END $guard$;
CREATE TEMP TABLE technical_before(table_name text PRIMARY KEY, fingerprint text) ON COMMIT DROP;
DO $before$ DECLARE t record; h text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
    EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',t.tablename);
    EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM public.%I r',t.tablename) INTO h;
    INSERT INTO technical_before VALUES(t.tablename,h);
  END LOOP;
END $before$;
""" + migration + """
DO $after$ DECLARE t record; h text; BEGIN
  FOR t IN SELECT * FROM technical_before LOOP
    EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM public.%I r',t.table_name) INTO h;
    IF h IS DISTINCT FROM t.fingerprint THEN RAISE EXCEPTION 'TECH_EXISTING_DATA_CHANGED'; END IF;
  END LOOP;
  IF TECH_REQUIRE_EMPTY AND ((SELECT count(*) FROM technical_cards)<>0 OR (SELECT count(*) FROM technical_revisions)<>0
    OR (SELECT count(*) FROM technical_changes)<>0) THEN RAISE EXCEPTION 'TECH_UNEXPECTED_BACKFILL'; END IF;
  IF (SELECT count(*) FROM technical_attributes)<>40 OR (SELECT count(*) FROM technical_families)<>48
    THEN RAISE EXCEPTION 'TECH_DICTIONARY_MISSING'; END IF;
  IF has_table_privilege('anon','technical_revisions','SELECT')
    OR has_table_privilege('service_role','technical_revisions','INSERT')
    OR has_function_privilege('anon','TECH_RPC_SIGNATURE','EXECUTE')
    OR has_function_privilege('authenticated','TECH_RPC_SIGNATURE','EXECUTE')
    THEN RAISE EXCEPTION 'TECH_PRIVILEGE_OPEN'; END IF;
END $after$;
COMMIT;
""".replace("TECH_REQUIRE_EMPTY", "false" if read_fix or version_guard else "true").replace(
    "TECH_RPC_SIGNATURE", "bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint)" if version_guard
    else "bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text)")

def main():
    if sys.argv[1:] not in ([], ["--read-fix"], ["--editor-version"]): raise RuntimeError("UNSUPPORTED_MIGRATION_ARGUMENT")
    read_fix = sys.argv[1:] == ["--read-fix"]
    version_guard = sys.argv[1:] == ["--editor-version"]
    migration_path = (ROOT / "docs/migrations/0019_technical_editor_version.sql" if version_guard else
                      ROOT / "docs/migrations/0018_technical_read_alias.sql" if read_fix else MIGRATION)
    sha = require_clean_source()
    info = json.loads(run(["docker","inspect",CONTAINER]).stdout)[0]
    if info["Config"].get("Labels",{}).get("mw.environment") != "dev":
        raise RuntimeError("TECH_FOREIGN_CONTAINER")
    validate_identity(json.loads(sql("SELECT public.mw_environment_identity()")))
    missing = sql("SELECT to_regclass('public.technical_cards') IS NULL") == "t"
    if missing == (read_fix or version_guard):
        raise RuntimeError("TECH_WRONG_MIGRATION_BASELINE")
    state = ROOT / "ops/.state/dev"
    with (state / "update.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        folder = state / "backups"
        folder.mkdir(parents=True,exist_ok=True,mode=0o700)
        prefix = "before-technical-editor-version-" if version_guard else "before-technical-read-fix-" if read_fix else "before-technical-"
        dump = folder / (prefix + stamp + "-" + uuid.uuid4().hex[:8] + ".dump")
        fd = os.open(dump,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,"wb") as target:
            subprocess.run(["docker","exec",CONTAINER,"pg_dump","-U","postgres","-d",DB,"-Fc"],
                           stdout=target,stderr=subprocess.PIPE,check=True)
        rehearsal = "mw_tech_rehearsal_" + uuid.uuid4().hex
        run(["docker","exec",CONTAINER,"createdb","-U","postgres",rehearsal])
        migration = migration_path.read_text()
        try:
            with dump.open("rb") as stream:
                run(["docker","exec","-i",CONTAINER,"pg_restore","-U","postgres","-d",rehearsal,
                     "--single-transaction","--exit-on-error"],stdin=stream)
            validate_identity(json.loads(sql("SELECT public.mw_environment_identity()",rehearsal)))
            sql(transaction(migration,read_fix,version_guard),rehearsal)
        finally:
            run(["docker","exec",CONTAINER,"dropdb","-U","postgres",rehearsal])
        # Recheck the target, then apply exactly the already rehearsed bytes.
        validate_identity(json.loads(sql("SELECT public.mw_environment_identity()")))
        sql(transaction(migration,read_fix,version_guard))
        report = {"environment":"dev","sourceSha":sha,"migration":"0019" if version_guard else "0018" if read_fix else "0017",
                  "migrationSha256":hashlib.sha256(migration.encode()).hexdigest(),
                  "backup":dump.name,"backupSha256":hashlib.sha256(dump.read_bytes()).hexdigest(),
                  "restoredCopyRehearsed":True,"existingTablesUnchanged":True,"seededProductValues":False,
                  "appliedAt":datetime.now(timezone.utc).isoformat()}
        report_path = dump.with_suffix(".json")
        fd = os.open(report_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,"w") as stream: json.dump(report,stream,indent=2)
        print(json.dumps(report))

if __name__ == "__main__":
    main()
