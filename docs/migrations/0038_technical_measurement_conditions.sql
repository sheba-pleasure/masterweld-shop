-- Preserve history and data. Correct duplicate detection before reviewing extracted facts.
DO $baseline$ BEGIN
 IF encode(sha256(convert_to(pg_get_functiondef('public.validate_technical_document(jsonb,text)'::regprocedure),'UTF8')),'hex')
   IS DISTINCT FROM 'c2653b48a40fee1292347dc1b4ba9e44e8905d59e73d14c711c0f28f1119942b'
 THEN RAISE EXCEPTION 'TECH_CONDITIONS_BASELINE'; END IF;
END $baseline$;

CREATE OR REPLACE FUNCTION public.validate_technical_document(p_document jsonb,p_review_state text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v jsonb; s jsonb; x jsonb; a public.technical_attributes%ROWTYPE;
  family text; process text; state text; n numeric; key text; val jsonb;
  source_keys text[] := '{}'; fact_keys jsonb[] := '{}'; fact_key jsonb; context_key text; family_options text[];
BEGIN
  IF p_review_state IS NULL OR p_review_state NOT IN ('pending_review','verified','conflict')
    OR p_document IS NULL OR jsonb_typeof(p_document)<>'object'
    OR octet_length(p_document::text)>131072
    OR (p_document - ARRAY['family_code','sources','values'])<>'{}'::jsonb
    OR jsonb_typeof(p_document->'family_code') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_document->'sources') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_document->'values') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'TECH_BAD_DOCUMENT';
  END IF;
  family := p_document->>'family_code';
  IF NOT EXISTS(SELECT 1 FROM technical_families WHERE code=family)
    OR jsonb_array_length(p_document->'sources')>32
    OR jsonb_array_length(p_document->'values')>128 THEN RAISE EXCEPTION 'TECH_BAD_DOCUMENT'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(p_document->'sources') LOOP
    IF jsonb_typeof(s)<>'object'
      OR (s - ARRAY['key','kind','publisher','model','title','url','locator','checked_on','sha256'])<>'{}'::jsonb
      THEN RAISE EXCEPTION 'TECH_BAD_SOURCE'; END IF;
    FOREACH key IN ARRAY ARRAY['key','kind','publisher','model','title','url','locator','checked_on','sha256'] LOOP
      IF jsonb_typeof(s->key) IS DISTINCT FROM 'string' OR length(s->>key)>1000
        THEN RAISE EXCEPTION 'TECH_BAD_SOURCE'; END IF;
    END LOOP;
    IF s->>'key' !~ '^[a-z][a-z0-9_]{0,39}$' OR (s->>'key')=ANY(source_keys)
      OR s->>'kind' NOT IN ('manufacturer','manual','test_report','supplier','research','synthetic')
      OR length(btrim(s->>'publisher'))<1 OR length(btrim(s->>'model'))<1
      OR length(btrim(s->>'title'))<1 OR length(btrim(s->>'locator'))<1
      OR (s->>'url'<>'' AND s->>'url' !~ '^https://[a-zA-Z0-9.-]+/[^?#@[:space:]]*$')
      OR (s->>'sha256'<>'' AND s->>'sha256' !~ '^[0-9a-f]{64}$')
      OR (s->>'url'='' AND s->>'sha256'='')
      OR s->>'checked_on' !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'TECH_BAD_SOURCE'; END IF;
    BEGIN
      IF (s->>'checked_on')::date>current_date THEN RAISE EXCEPTION 'TECH_BAD_SOURCE'; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'TECH_BAD_SOURCE';
    END;
    IF s->>'kind'='synthetic' THEN
      IF public.mw_environment_identity()->>'environment' IS DISTINCT FROM 'dev'
        OR s->>'title' NOT LIKE '[Учебный]%' THEN RAISE EXCEPTION 'TECH_SYNTHETIC_DEV_ONLY'; END IF;
    ELSIF p_review_state='verified' AND s->>'kind' NOT IN ('manufacturer','manual','test_report') THEN
      RAISE EXCEPTION 'TECH_PRIMARY_SOURCE_REQUIRED';
    END IF;
    source_keys := array_append(source_keys,s->>'key');
  END LOOP;
  FOR v IN SELECT value FROM jsonb_array_elements(p_document->'values') LOOP
    IF jsonb_typeof(v)<>'object'
      OR (v - ARRAY['attribute_code','process','state','value','unit_code','context','source_key'])<>'{}'::jsonb
      THEN RAISE EXCEPTION 'TECH_BAD_VALUE'; END IF;
    FOREACH key IN ARRAY ARRAY['attribute_code','process','state','unit_code'] LOOP
      IF jsonb_typeof(v->key) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'TECH_BAD_VALUE'; END IF;
    END LOOP;
    IF NOT (v ? 'value') OR NOT (v ? 'source_key') OR jsonb_typeof(v->'context') IS DISTINCT FROM 'object'
      THEN RAISE EXCEPTION 'TECH_BAD_VALUE'; END IF;
    SELECT d.* INTO a FROM technical_attributes d JOIN technical_family_attributes f
      ON f.attribute_code=d.code WHERE f.family_code=family AND d.code=v->>'attribute_code';
    IF NOT FOUND THEN RAISE EXCEPTION 'TECH_ATTRIBUTE_NOT_APPLICABLE'; END IF;
    SELECT options_override INTO family_options FROM technical_family_attributes
      WHERE family_code=family AND attribute_code=a.code;
    IF family_options IS NOT NULL THEN a.options:=family_options; END IF;
    process:=v->>'process'; state:=v->>'state'; val:=v->'value';
    -- The same attribute can have different measured values under different conditions.
    -- JSONB equality also treats 160 and 160.0 as the same condition.
    fact_key:=jsonb_build_array(a.code,process,v->'context');
    IF NOT process=ANY(a.processes) OR fact_key=ANY(fact_keys) OR v->>'unit_code'<>a.unit_code
      OR state NOT IN ('known','unknown','not_applicable') THEN RAISE EXCEPTION 'TECH_BAD_VALUE'; END IF;
    fact_keys:=array_append(fact_keys,fact_key);
    IF ((v->'context') - ARRAY['current_a','temperature_c','pressure_bar','gas','cooling','duty_pct','material','diameter_mm'])<>'{}'::jsonb
      THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
    FOR context_key,x IN SELECT * FROM jsonb_each(v->'context') LOOP
      IF context_key IN ('gas','cooling','material') THEN
        IF jsonb_typeof(x)<>'string' OR length(btrim(x#>>'{}')) NOT BETWEEN 1 AND 120 THEN
          RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
        IF context_key='cooling' AND x#>>'{}' NOT IN ('air','liquid') THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
      ELSE
        IF jsonb_typeof(x)<>'number' THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
        n:=(x#>>'{}')::numeric;
        IF n NOT BETWEEN -100 AND 1000000 OR (context_key<>'temperature_c' AND n<0)
          OR (context_key='duty_pct' AND n>100) OR (context_key IN ('pressure_bar','diameter_mm') AND n<=0)
          THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
      END IF;
    END LOOP;
    IF state<>'known' THEN
      IF val<>'null'::jsonb OR v->'source_key'<>'null'::jsonb OR v->'context'<>'{}'::jsonb
        THEN RAISE EXCEPTION 'TECH_UNKNOWN_HAS_VALUE'; END IF;
      CONTINUE;
    END IF;
    IF jsonb_typeof(v->'source_key') IS DISTINCT FROM 'string' OR NOT (v->>'source_key')=ANY(source_keys)
      THEN RAISE EXCEPTION 'TECH_SOURCE_REQUIRED'; END IF;
    IF NOT (v->'context' ?& a.required_context) OR NOT (v->'context' @> a.fixed_context)
      THEN RAISE EXCEPTION 'TECH_CONTEXT_REQUIRED'; END IF;
    IF a.kind IN ('number','integer') THEN
      IF jsonb_typeof(val)<>'number' THEN RAISE EXCEPTION 'TECH_BAD_TYPE'; END IF;
      n:=(val#>>'{}')::numeric;
      IF abs(n)>1000000000 OR (a.kind='integer' AND n<>trunc(n))
        OR (a.minimum IS NOT NULL AND n<a.minimum) OR (a.maximum IS NOT NULL AND n>a.maximum)
        THEN RAISE EXCEPTION 'TECH_BAD_RANGE'; END IF;
    ELSIF a.kind='boolean' THEN
      IF jsonb_typeof(val)<>'boolean' THEN RAISE EXCEPTION 'TECH_BAD_TYPE'; END IF;
    ELSIF a.kind IN ('text','enum') THEN
      IF jsonb_typeof(val)<>'string' OR length(btrim(val#>>'{}')) NOT BETWEEN 1 AND 500
        THEN RAISE EXCEPTION 'TECH_BAD_TYPE'; END IF;
      IF a.kind='enum' AND NOT (val#>>'{}')=ANY(a.options) THEN RAISE EXCEPTION 'TECH_BAD_OPTION'; END IF;
    ELSE
      IF jsonb_typeof(val)<>'array' OR jsonb_array_length(val) NOT BETWEEN 1 AND 32
        THEN RAISE EXCEPTION 'TECH_BAD_TYPE'; END IF;
      IF (SELECT count(*) FROM jsonb_array_elements(val)) <>
         (SELECT count(DISTINCT value) FROM jsonb_array_elements(val)) THEN RAISE EXCEPTION 'TECH_DUPLICATE_VALUE'; END IF;
      FOR x IN SELECT value FROM jsonb_array_elements(val) LOOP
        IF a.kind='number_list' THEN
          IF jsonb_typeof(x)<>'number' THEN RAISE EXCEPTION 'TECH_BAD_TYPE'; END IF;
          n:=(x#>>'{}')::numeric;
          IF abs(n)>1000000000 OR (a.minimum IS NOT NULL AND n<a.minimum)
            OR (a.maximum IS NOT NULL AND n>a.maximum) THEN RAISE EXCEPTION 'TECH_BAD_RANGE'; END IF;
        ELSIF jsonb_typeof(x)<>'string' OR NOT (x#>>'{}')=ANY(a.options) THEN
          RAISE EXCEPTION 'TECH_BAD_OPTION';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  -- Do not allow contradictory bounds for the same process and conditions.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_document->'values') lo
    JOIN jsonb_array_elements(p_document->'values') hi ON
      replace(lo->>'attribute_code','_min_','_max_')=hi->>'attribute_code'
      AND strpos(lo->>'attribute_code','_min_')>0
      AND lo->>'process'=hi->>'process' AND lo->'context'=hi->'context'
    WHERE lo->>'state'='known' AND hi->>'state'='known'
      AND CASE WHEN jsonb_typeof(lo->'value')='number' AND jsonb_typeof(hi->'value')='number'
        THEN (lo->>'value')::numeric>(hi->>'value')::numeric ELSE false END
  ) THEN RAISE EXCEPTION 'TECH_REVERSED_RANGE'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.validate_technical_document(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

