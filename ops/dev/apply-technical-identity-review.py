#!/usr/bin/env python3
"""DEV-only additive protection, with no new backup/upload/scheduling work."""
import fcntl
import hashlib
import json
import os
import pathlib
import subprocess

ROOT=pathlib.Path(__file__).resolve().parents[2]
PATH="docs/migrations/0035_technical_identity_review.sql"
IDENTITY={"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}
BASELINE_SQL="""SELECT jsonb_object_agg(n.nspname||'.'||p.proname,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname,p.proname) IN
 (('public','bot_technical_catalog'),('mw_private','document_product_identity'))"""
EXPECTED={
 "public.bot_technical_catalog":"f9dc2d4d4592a1ccfb19e79f543ef9b07d82c109fe0d7af297172604c33f54d3",
 "mw_private.document_product_identity":"24ff14e06d62f9855dd5643b4dfaf14cbc4f05f2e4676a8082541c97885e9943"
}
def transaction(migration,expected=EXPECTED):
    checksum=hashlib.sha256(migration.encode()).hexdigest()
    return """
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF mw_environment_identity() IS DISTINCT FROM '""" + json.dumps(IDENTITY) + """'::jsonb
 THEN RAISE EXCEPTION 'TECH_IDENTITY_DEV_REQUIRED'; END IF;
 IF to_regclass('public.technical_identity_events') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM technical_attributes WHERE code='tig_cup_size')
  OR to_regprocedure('mw_private.bot_technical_catalog_before_identity(bigint,text,uuid,uuid,jsonb,text,bigint)') IS NOT NULL
 THEN RAISE EXCEPTION 'TECH_IDENTITY_SCHEMA_REVIEW'; END IF;
 IF (""" + BASELINE_SQL + """) IS DISTINCT FROM '""" + json.dumps(expected) + """'::jsonb
 THEN RAISE EXCEPTION 'TECH_IDENTITY_BASELINE'; END IF;
END $guard$;
CREATE TEMP TABLE technical_identity_before(name text,columns text,fingerprint text) ON COMMIT DROP;
DO $before$ DECLARE t record; h text; cols text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
  EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',t.tablename);
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM public.%I r',t.tablename) INTO h;
  SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) INTO cols
   FROM information_schema.columns WHERE table_schema='public' AND table_name=t.tablename;
  INSERT INTO technical_identity_before VALUES(t.tablename,cols,h);
 END LOOP;
END $before$;
""" + migration + """
DO $after$ DECLARE t record; h text; role_name text; helper text; BEGIN
 FOR t IN SELECT * FROM technical_identity_before LOOP
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text) FROM (SELECT %s FROM public.%I) r',t.columns,t.name) INTO h;
  IF h IS DISTINCT FROM t.fingerprint THEN RAISE EXCEPTION 'TECH_IDENTITY_EXISTING_DATA_CHANGED'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM technical_identity_events) THEN RAISE EXCEPTION 'TECH_IDENTITY_NOT_EMPTY'; END IF;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(role_name,'technical_identity_events','SELECT,INSERT,UPDATE,DELETE')
  THEN RAISE EXCEPTION 'TECH_IDENTITY_PRIVILEGES'; END IF;
  FOREACH helper IN ARRAY ARRAY[
   'mw_private.technical_product_identity_changed()',
   'mw_private.bot_technical_catalog_before_identity(bigint,text,uuid,uuid,jsonb,text,bigint)'] LOOP
   IF has_function_privilege(role_name,helper,'EXECUTE') THEN RAISE EXCEPTION 'TECH_IDENTITY_PRIVILEGES'; END IF;
  END LOOP;
 END LOOP;
 IF has_function_privilege('anon','bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint)','EXECUTE')
 OR has_function_privilege('authenticated','bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint)','EXECUTE')
 OR NOT has_function_privilege('service_role','bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint)','EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='technical_identity_events'::regclass)
 OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='products'::regclass AND tgname='products_technical_identity_changed' AND tgenabled='O')<>1
 THEN RAISE EXCEPTION 'TECH_IDENTITY_PRIVILEGES'; END IF;
END $after$;
CREATE TABLE IF NOT EXISTS mw_private.dev_migration_receipts(path text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES('""" + PATH + "','" + checksum + """');
NOTIFY pgrst,'reload schema'; COMMIT;
"""

def run(args,**kwargs):
    return subprocess.run(args,check=True,capture_output=True,text=True,**kwargs)
def sql(query):
    return run(["docker","exec","-i","mw-dev-db","psql","-X","-Atq","-U","postgres","-d","masterweld_dev",
                "-v","ON_ERROR_STOP=1"],input=query).stdout.strip()
def main():
    os.umask(0o077)
    if run(["git","status","--porcelain"],cwd=ROOT).stdout.strip():raise RuntimeError("COMMIT_SOURCE_REQUIRED")
    sha=run(["git","rev-parse","HEAD"],cwd=ROOT).stdout.strip()
    state=ROOT/"ops/.state/dev"
    with (state/"update.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        container=json.loads(run(["docker","inspect","mw-dev-db"]).stdout)[0]
        if container["Config"]["Labels"].get("mw.environment")!="dev" or not container["State"]["Running"]:
            raise RuntimeError("DEV_DATABASE_REQUIRED")
        if json.loads(sql("SELECT mw_environment_identity()"))!=IDENTITY:raise RuntimeError("DEV_IDENTITY_REQUIRED")
        if json.loads(sql(BASELINE_SQL))!=EXPECTED:raise RuntimeError("TECH_IDENTITY_BASELINE")
        test=json.loads(run(["python3",str(ROOT/"ops/tests/technical-identity-review.py")],cwd=ROOT).stdout)
        if not test.get("ok"):raise RuntimeError("TECH_IDENTITY_REHEARSAL_FAILED")
        migration=(ROOT/PATH).read_text()
        sql(transaction(migration))
        checksum=hashlib.sha256(migration.encode()).hexdigest()
        if sql("SELECT sha256 FROM mw_private.dev_migration_receipts WHERE path='"+PATH+"'")!=checksum:
            raise RuntimeError("TECH_IDENTITY_RECEIPT_REVIEW")
        report={"environment":"dev","migration":"0035","sourceSha":sha,"sha256":checksum,
                "existingPublicValuesUnchanged":True,"isolatedRehearsal":test,
                "backupCreated":False,"productionChanged":False}
        (state/"technical-identity-review-migration.json").write_text(json.dumps(report,indent=2)+"\n")
        print(json.dumps(report))
if __name__=="__main__":main()
