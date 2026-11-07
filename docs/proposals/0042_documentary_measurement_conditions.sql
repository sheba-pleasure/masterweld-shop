-- Proposal only. Do not install in DEV/PRO before compatible image guards,
-- guarded installation, full rehearsal and the accessory dictionary are ready.
-- Add a literal source condition. No existing values, sources or roles are changed.
DO $baseline$
DECLARE signature text; expected text;
BEGIN
 FOR signature,expected IN VALUES
  ('mw_private.validate_technical_document_before_origins(jsonb,text)',
   'd1552a3e2fed186b619c97cf210e969e3d1bef2e0dc26f001c21d77d8f88fb75'),
  ('mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)',
   '8dc8fb0f2fe218bfffbc847313ce90b67e580c961f76676b110784446a007653')
 LOOP
  IF to_regprocedure(signature) IS NULL OR
   encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(signature)),'UTF8')),'hex')
    IS DISTINCT FROM expected THEN RAISE EXCEPTION 'DOCUMENTARY_CONDITIONS_BASELINE'; END IF;
 END LOOP;
 IF (SELECT encode(sha256(convert_to(pg_get_constraintdef(oid),'UTF8')),'hex') FROM pg_constraint
      WHERE conrelid='public.technical_attributes'::regclass AND conname='technical_attributes_required_context_check')
    IS DISTINCT FROM 'b433c59c5b22e1e6218b686b636ca1442c7f5ea95fba71c2c09194e079383be6'
 OR (SELECT encode(sha256(convert_to(pg_get_constraintdef(oid),'UTF8')),'hex') FROM pg_constraint
      WHERE conrelid='public.source_fact_prompts'::regclass AND conname='source_fact_prompts_field_check')
    IS DISTINCT FROM 'cf0dd81c4db135ef8b23ecc37971ecc960d9e16110e3f15bf00d17bf46b09f82'
 THEN RAISE EXCEPTION 'DOCUMENTARY_CONDITIONS_CONSTRAINT_BASELINE'; END IF;
END $baseline$;

-- Rewrite only exact known fragments in the hash-checked canonical functions.
-- CREATE OR REPLACE preserves their OIDs, ownership and existing private ACLs.
DO $functions$
DECLARE signature text; definition text; old_text text; new_text text;
BEGIN
 signature := 'mw_private.validate_technical_document_before_origins(jsonb,text)';
 definition := pg_get_functiondef(signature::regprocedure);
 FOR old_text,new_text IN VALUES
  ($old$'gas','cooling','duty_pct','material','diameter_mm']$old$,
   $new$'gas','cooling','duty_pct','material','diameter_mm','test_conditions']$new$),
  ($old$IF context_key IN ('gas','cooling','material') THEN$old$,
   $new$IF context_key='test_conditions' THEN
        IF jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 500
          OR btrim(x#>>'{}',E' \t\r\n\013\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')=''
          THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
      ELSIF context_key IN ('gas','cooling','material') THEN$new$)
 LOOP
  IF length(definition)-length(replace(definition,old_text,''))<>length(old_text)
    THEN RAISE EXCEPTION 'DOCUMENTARY_CONDITIONS_PATCH'; END IF;
  definition:=replace(definition,old_text,new_text);
 END LOOP;
 EXECUTE definition;

 signature := 'mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)';
 definition := pg_get_functiondef(signature::regprocedure);
 FOR old_text,new_text IN VALUES
  ($old$'gas','cooling','duty_pct','material','diameter_mm') OR p_payload-'field'$old$,
   $new$'gas','cooling','duty_pct','material','diameter_mm','test_conditions') OR p_payload-'field'$new$),
  ($old$IF input_field IN('gas','cooling','material') THEN$old$,
   $new$IF input_field='test_conditions' THEN
       IF jsonb_typeof(input_value) IS DISTINCT FROM 'string'
        OR length(input_value#>>'{}') NOT BETWEEN 1 AND 500
        OR btrim(input_value#>>'{}',E' \t\r\n\013\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')=''
        THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
      ELSIF input_field IN('gas','cooling','material') THEN$new$)
 LOOP
  IF length(definition)-length(replace(definition,old_text,''))<>length(old_text)
    THEN RAISE EXCEPTION 'DOCUMENTARY_CONDITIONS_PATCH'; END IF;
  definition:=replace(definition,old_text,new_text);
 END LOOP;
 EXECUTE definition;
END $functions$;

ALTER TABLE public.technical_attributes DROP CONSTRAINT technical_attributes_required_context_check;
ALTER TABLE public.technical_attributes ADD CONSTRAINT technical_attributes_required_context_check
 CHECK(required_context <@ ARRAY['current_a','temperature_c','pressure_bar','gas','cooling','duty_pct','material','diameter_mm','test_conditions']);
ALTER TABLE public.source_fact_prompts DROP CONSTRAINT source_fact_prompts_field_check;
ALTER TABLE public.source_fact_prompts ADD CONSTRAINT source_fact_prompts_field_check
 CHECK(field IN('value','publisher','locator','current_a','temperature_c','pressure_bar','gas','cooling','duty_pct','material','diameter_mm','test_conditions'));

-- Compatibility probes will require a new image capability as soon as this schema
-- exists, even while no new-condition records have yet been written.
CREATE FUNCTION mw_private.documentary_conditions_version() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS 'SELECT 1';
REVOKE ALL ON FUNCTION mw_private.documentary_conditions_version()
 FROM PUBLIC,anon,authenticated,service_role;
