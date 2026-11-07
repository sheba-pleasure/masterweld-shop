"""Atomic 0042 or combined 0042/0043 transaction builder; no direct live writes."""
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROPOSAL_PATH = "docs/proposals/0042_documentary_measurement_conditions.sql"
PROPOSAL_SHA256 = "2b258b9a2ec9253bd357c13843020c3bb26e2931d0c9e186f7c48b7fc8b4ebad"
IDENTITY = {"environment": "dev", "instanceId": "3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}
CHANGED_FUNCTIONS = (
    "mw_private.validate_technical_document_before_origins(jsonb,text)",
    "mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)",
)
MARKER = "mw_private.documentary_conditions_version()"
ACCESSORY_PATH = "docs/proposals/0043_accessory_characteristics.sql"
ACCESSORY_SHA256 = "0c39f8ad4d53145add3c07f8df3e6ad872ef9a11a23e3e4288c07c54d51f3378"
ACCESSORY_MARKER = "mw_private.accessory_dictionary_version()"


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def load_proposal():
    proposal = (ROOT / PROPOSAL_PATH).read_text()
    if hashlib.sha256(proposal.encode()).hexdigest() != PROPOSAL_SHA256:
        raise RuntimeError("DOCUMENTARY_INSTALL_CHECKSUM")
    return proposal


def accessory_extension():
    """Verify the exact proposal and derive expected appended rows independently."""
    proposal = (ROOT / ACCESSORY_PATH).read_text()
    if hashlib.sha256(proposal.encode()).hexdigest() != ACCESSORY_SHA256:
        raise RuntimeError("ACCESSORY_INSTALL_CHECKSUM")
    dictionary = json.loads((ROOT / "src/lib/technical/accessory-dictionary.json").read_text())
    parts = proposal.split("$accessory_seed$")
    if len(parts) != 3 or json.loads(parts[1]) != dictionary:
        raise RuntimeError("ACCESSORY_INSTALL_DICTIONARY_MISMATCH")
    expected = ""
    for key, table in (("units", "technical_units"), ("attributes", "technical_attributes"),
                       ("bindings", "technical_family_attributes")):
        # The expected result includes every old row and exactly the reviewed additions.
        # It does not exclude new codes from the final data check.
        expected += """
UPDATE documentary_old_rows SET fingerprint=(
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(row_value ORDER BY row_value::text),'[]'::jsonb)::text,'UTF8')),'hex')
 FROM (SELECT to_jsonb(t) row_value FROM public.""" + table + """ t
       UNION ALL SELECT value FROM jsonb_array_elements(""" + literal(json.dumps(dictionary[key])) + """::jsonb)) expected
) WHERE schema_name='public' AND name=""" + literal(table) + ";\n"
    return proposal, expected


def transaction(source_sha, image_id, *, accessories=False):
    """Return one bounded transaction. Caller must drain the old app before execution.

    No shell/DB access here. A COMMIT transport error must be resolved by reading
    the receipt, never by replaying the transaction automatically.
    """
    if not re.fullmatch("[0-9a-f]{40}", source_sha or ""):
        raise RuntimeError("DOCUMENTARY_INSTALL_REVISION")
    if not re.fullmatch("sha256:[0-9a-f]{64}", image_id or ""):
        raise RuntimeError("DOCUMENTARY_INSTALL_IMAGE")
    if type(accessories) is not bool:
        raise RuntimeError("DOCUMENTARY_INSTALL_MODE")
    proposal = load_proposal()
    expected_rows = ""
    extra_guard = ""
    markers = (MARKER,)
    receipts = [(PROPOSAL_PATH, PROPOSAL_SHA256)]
    if accessories:
        accessory_proposal, expected_rows = accessory_extension()
        proposal += "\n" + accessory_proposal
        markers += (ACCESSORY_MARKER,)
        receipts.append((ACCESSORY_PATH, ACCESSORY_SHA256))
        extra_guard = """
 IF to_regprocedure('mw_private.accessory_dictionary_version()') IS NOT NULL
 THEN RAISE EXCEPTION 'ACCESSORY_INSTALL_ALREADY_PRESENT'; END IF;
 IF EXISTS(SELECT 1 FROM mw_private.dev_migration_receipts WHERE path=""" + literal(ACCESSORY_PATH) + """)
 THEN RAISE EXCEPTION 'ACCESSORY_INSTALL_RECEIPT_EXISTS'; END IF;
"""
    changed = ",".join(literal(signature) + "::regprocedure" for signature in CHANGED_FUNCTIONS)
    return """
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(hashtextextended('masterweld-dev-schema-install',0));
DO $identity$ BEGIN
 IF public.mw_environment_identity() IS DISTINCT FROM """ + literal(json.dumps(IDENTITY)) + """::jsonb
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_DEV_REQUIRED'; END IF;
 IF to_regprocedure('mw_private.documentary_conditions_version()') IS NOT NULL
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_ALREADY_PRESENT'; END IF;
 IF to_regclass('mw_private.dev_migration_receipts') IS NULL
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_RECEIPTS_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM mw_private.dev_migration_receipts WHERE path=""" + literal(PROPOSAL_PATH) + """)
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_RECEIPT_EXISTS'; END IF;
""" + extra_guard + """END $identity$;

CREATE TEMP TABLE documentary_old_rows(schema_name text,name text,fingerprint text) ON COMMIT DROP;
DO $rows_before$ DECLARE t record; fingerprint text; BEGIN
 FOR t IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('public','mw_private')
  ORDER BY schemaname,tablename LOOP
  -- Keep the data check and constraint updates in one snapshot without writers.
  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',t.schemaname,t.tablename);
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text,''UTF8'')),''hex'') FROM %I.%I r',
    t.schemaname,t.tablename) INTO fingerprint;
  INSERT INTO documentary_old_rows VALUES(t.schemaname,t.tablename,fingerprint);
 END LOOP;
END $rows_before$;

CREATE TEMP TABLE documentary_old_functions ON COMMIT DROP AS
 SELECT p.oid,CASE WHEN p.oid IN(""" + changed + """) THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END AS metadata
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','mw_private');
CREATE TEMP TABLE documentary_old_relations ON COMMIT DROP AS
 SELECT c.oid,jsonb_build_array(c.relname,c.relnamespace,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) AS metadata
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','mw_private') AND c.relkind IN('r','p','v','m','S','f');
CREATE TEMP TABLE documentary_old_columns ON COMMIT DROP AS
 SELECT to_jsonb(a) AS metadata FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','mw_private');
CREATE TEMP TABLE documentary_old_policies ON COMMIT DROP AS SELECT * FROM pg_policy;
CREATE TEMP TABLE documentary_old_triggers ON COMMIT DROP AS
 SELECT t.* FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','mw_private');
CREATE TEMP TABLE documentary_old_roles ON COMMIT DROP AS SELECT * FROM pg_roles;
CREATE TEMP TABLE documentary_old_memberships ON COMMIT DROP AS SELECT * FROM pg_auth_members;
CREATE TEMP TABLE documentary_old_constraints ON COMMIT DROP AS
 SELECT c.oid,to_jsonb(c) AS metadata FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
 WHERE n.nspname IN('public','mw_private') AND NOT
 ((c.conrelid='public.technical_attributes'::regclass AND c.conname='technical_attributes_required_context_check')
 OR (c.conrelid='public.source_fact_prompts'::regclass AND c.conname='source_fact_prompts_field_check'));
""" + expected_rows + proposal + """
-- All checks precede the receipt and COMMIT. A failure rolls back the schema too.
DO $preservation$ DECLARE t record; fingerprint text; role_name text; signature text; BEGIN
 FOR t IN SELECT * FROM documentary_old_rows LOOP
  EXECUTE format('SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb)::text,''UTF8'')),''hex'') FROM %I.%I r',
    t.schema_name,t.name) INTO fingerprint;
  IF fingerprint IS DISTINCT FROM t.fingerprint
  THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_ROWS_CHANGED'; END IF;
 END LOOP;
 IF EXISTS(
  WITH current_functions AS (
   SELECT p.oid,CASE WHEN p.oid IN(""" + changed + """) THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END metadata
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN('public','mw_private') AND p.oid NOT IN(""" + ",".join(literal(marker) + "::regprocedure" for marker in markers) + """))
  SELECT 1 FROM documentary_old_functions b FULL JOIN current_functions a USING(oid)
  WHERE b.metadata IS DISTINCT FROM a.metadata)
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_FUNCTIONS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_relations AS (
   SELECT c.oid,jsonb_build_array(c.relname,c.relnamespace,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) metadata
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','mw_private') AND c.relkind IN('r','p','v','m','S','f'))
  SELECT 1 FROM documentary_old_relations b FULL JOIN current_relations a USING(oid)
  WHERE b.metadata IS DISTINCT FROM a.metadata)
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_RELATIONS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_columns AS (
   SELECT to_jsonb(a) AS metadata FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','mw_private'))
  (TABLE documentary_old_columns EXCEPT TABLE current_columns) UNION ALL
  (TABLE current_columns EXCEPT TABLE documentary_old_columns))
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_COLUMNS_CHANGED'; END IF;
 IF EXISTS((TABLE documentary_old_policies EXCEPT TABLE pg_policy) UNION ALL (TABLE pg_policy EXCEPT TABLE documentary_old_policies))
 OR EXISTS((TABLE documentary_old_roles EXCEPT TABLE pg_roles) UNION ALL (TABLE pg_roles EXCEPT TABLE documentary_old_roles))
 OR EXISTS((TABLE documentary_old_memberships EXCEPT TABLE pg_auth_members) UNION ALL (TABLE pg_auth_members EXCEPT TABLE documentary_old_memberships))
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_ACCESS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_triggers AS (
   SELECT trg.* FROM pg_trigger trg JOIN pg_class c ON c.oid=trg.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','mw_private'))
  (TABLE documentary_old_triggers EXCEPT TABLE current_triggers) UNION ALL
  (TABLE current_triggers EXCEPT TABLE documentary_old_triggers))
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_TRIGGERS_CHANGED'; END IF;
 IF EXISTS(
  WITH current_constraints AS (
   SELECT c.oid,to_jsonb(c) metadata FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
   WHERE n.nspname IN('public','mw_private') AND NOT
   ((c.conrelid='public.technical_attributes'::regclass AND c.conname='technical_attributes_required_context_check')
   OR (c.conrelid='public.source_fact_prompts'::regclass AND c.conname='source_fact_prompts_field_check')))
  SELECT 1 FROM documentary_old_constraints b FULL JOIN current_constraints a USING(oid)
  WHERE b.metadata IS DISTINCT FROM a.metadata)
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_CONSTRAINTS_CHANGED'; END IF;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH signature IN ARRAY ARRAY[""" + ",".join(map(literal, (*CHANGED_FUNCTIONS, *markers))) + """] LOOP
   IF has_function_privilege(role_name,signature,'EXECUTE')
   THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_PRIVATE_ACCESS'; END IF;
  END LOOP;
 END LOOP;
 IF mw_private.documentary_conditions_version() IS DISTINCT FROM 1
 THEN RAISE EXCEPTION 'DOCUMENTARY_INSTALL_VERSION'; END IF;
""" + ("""
 IF mw_private.accessory_dictionary_version() IS DISTINCT FROM 1
 THEN RAISE EXCEPTION 'ACCESSORY_INSTALL_VERSION'; END IF;
""" if accessories else "") + """END $preservation$;
INSERT INTO mw_private.dev_migration_receipts(path,sha256) VALUES """ + ",".join(
    "(" + literal(path) + "," + literal(checksum) + ")" for path, checksum in receipts) + """;
NOTIFY pgrst,'reload schema';
-- Emit the exact source/image identity only after COMMIT, for caller diagnostics.
COMMIT;
SELECT jsonb_build_object('state','recorded','sourceSha',""" + literal(source_sha) + """,'imageId',""" + literal(image_id) + """,
 'proposalSha256',""" + literal(PROPOSAL_SHA256) + """);
"""
