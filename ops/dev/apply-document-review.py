#!/usr/bin/env python3
"""Apply only 0027 to DEV after a verified backup and rehearsal in a separate offline container."""
import fcntl
import hashlib
import importlib.util
import json
import pathlib
import re
import subprocess
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[2]
PATH="docs/migrations/0027_document_review.sql"
BASELINE_SQL="SELECT jsonb_object_agg(proname,encode(sha256(convert_to(pg_get_functiondef(oid),'UTF8')),'hex')) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('bot_pending_preview','bot_catalog_import','bot_pending_operation')"
EXPECTED={"bot_catalog_import":"53297fa869d78f216b757fe926f1d3c6ebf5b8f03222e2deab99d0c4b52f0ba0","bot_pending_preview":"afddcac083e875d0d81161907ab64162cc43bce5d43ea42f4f91d3f7790646a1","bot_pending_operation":"e4eb0626b67f4809d654e19130050411abcf82ab5f2da9044489cf02796ca97a"}
spec=importlib.util.spec_from_file_location("backup",ROOT/"ops/standalone/database-backup.py")
backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
def transaction(migration,expected):
    checksum=hashlib.sha256(migration.encode()).hexdigest()
    return """
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF mw_environment_identity() IS DISTINCT FROM '{"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}'::jsonb
 THEN RAISE EXCEPTION 'DOCUMENT_DEV_REQUIRED'; END IF;
 IF to_regclass('public.document_intakes') IS NULL OR to_regclass('public.document_reviews') IS NOT NULL THEN RAISE EXCEPTION 'DOCUMENT_ALREADY_APPLIED'; END IF;
 IF ("""+BASELINE_SQL+""") IS DISTINCT FROM '"""+json.dumps(expected)+"""'::jsonb
 THEN RAISE EXCEPTION 'DOCUMENT_BASELINE'; END IF;
END $guard$;
CREATE TEMP TABLE document_before(name text,fingerprint text) ON COMMIT DROP;
DO $before$ DECLARE t record; h text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
  EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',t.tablename);
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM public.%I r',t.tablename) INTO h;
  INSERT INTO document_before VALUES(t.tablename,h);
 END LOOP;
END $before$;
"""+migration+"""
DO $after$ DECLARE t record; h text; BEGIN
 FOR t IN SELECT * FROM document_before LOOP
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM public.%I r',t.name) INTO h;
  IF h IS DISTINCT FROM t.fingerprint THEN RAISE EXCEPTION 'DOCUMENT_EXISTING_DATA_CHANGED'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['document_reviews','document_review_rows','document_review_prompts','document_import_origins']) t CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE'))
    OR has_function_privilege('anon','bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb)','EXECUTE')
    OR has_function_privilege('service_role','mw_private.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)','EXECUTE')
    OR has_table_privilege('anon','document_intakes','SELECT') OR has_table_privilege('service_role','document_intakes','INSERT')
    OR has_function_privilege('anon','bot_document_intake(bigint,text,uuid,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'DOCUMENT_PRIVILEGES'; END IF;
END $after$;
CREATE TABLE IF NOT EXISTS mw_private.dev_migration_receipts(path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES('"""+PATH+"','"+checksum+"""');
COMMIT;
"""
def main():
    backup.require(not subprocess.check_output(["git","status","--porcelain"],cwd=ROOT).strip(),"COMMIT_SOURCE_REQUIRED")
    sha=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
    migration=(ROOT/PATH).read_text()
    expected=EXPECTED
    with (ROOT/"ops/.state/dev/update.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        backup.validate_source("mw-dev-db","masterweld_dev",backup.DEV_ID)
        actual=json.loads(backup.sql("mw-dev-db","masterweld_dev",BASELINE_SQL))
        backup.require(actual==expected,"DOCUMENT_BASELINE")
        backup.require(backup.sql("mw-dev-db","masterweld_dev","SELECT to_regclass('public.document_intakes') IS NOT NULL AND to_regclass('public.document_reviews') IS NULL")=="t","DOCUMENT_ALREADY_APPLIED")
        state=backup.backup(ROOT,"dev",upload=True)
        folder=ROOT/"ops/.state/database-backups/dev"/state["run"]
        name="mw-review-rehearsal-"+uuid.uuid4().hex[:12]
        backup.run(["docker","run","-d","--name",name,"--network","none","--label","mw.environment=qa",
          "-e","POSTGRES_HOST_AUTH_METHOD=trust","-e","POSTGRES_DB=recovery",backup.IMAGE])
        try:
            backup.ready(name)
            roles=(folder/"content/roles.sql").read_text()
            roles,n=re.subn(r"(?m)^CREATE ROLE postgres;$","",roles)
            backup.require(n==1,"ROLES_INVALID")
            backup.sql(name,"recovery",roles)
            with (folder/"content/database.dump").open("rb") as stream:
                subprocess.run(["docker","exec","-i",name,"pg_restore","-U","postgres","-d","recovery",
                   "--exit-on-error","--single-transaction"],stdin=stream,check=True,capture_output=True)
            backup.sql(name,"recovery",transaction(migration,expected))
            backup.run(["docker","restart",name]);backup.ready(name)
            backup.require(backup.sql(name,"recovery","SELECT count(*) FROM document_reviews")=="0","REHEARSAL_NOT_EMPTY")
        finally:
            backup.run(["docker","rm","-fv",name])
        backup.validate_source("mw-dev-db","masterweld_dev",backup.DEV_ID)
        backup.sql("mw-dev-db","masterweld_dev",transaction(migration,expected))
        report={"environment":"dev","migration":"0027","sourceSha":sha,"sha256":hashlib.sha256(migration.encode()).hexdigest(),
          "backupRun":state["run"],"rehearsalNetwork":"none","rehearsalRestart":True,"existingRowsUnchanged":True}
        backup.write(folder/"document-review-migration.json",(json.dumps(report,indent=2)+"\n").encode())
        print(json.dumps(report))
if __name__=="__main__":main()
