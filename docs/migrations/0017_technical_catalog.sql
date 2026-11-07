-- Additive P0. Explicit DEV migration after backup/rehearsal; no Cloud/product rewrite.
-- Dictionary is deployment-managed. Staff values use the audited preview/apply RPC only.
CREATE TABLE public.technical_units (
  code text PRIMARY KEY CHECK(code ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL,
  dimension text NOT NULL
);
CREATE TABLE public.technical_families (
  code text PRIMARY KEY CHECK(code ~ '^[a-z][a-z0-9_]{0,79}$'),
  label text NOT NULL
);
CREATE TABLE public.technical_attributes (
  code text PRIMARY KEY CHECK(code ~ '^[a-z][a-z0-9_]{0,79}$'),
  label text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('number','integer','boolean','text','enum','number_list','enum_list')),
  unit_code text NOT NULL REFERENCES public.technical_units(code),
  options text[] NOT NULL DEFAULT '{}',
  processes text[] NOT NULL DEFAULT '{general}',
  required_context text[] NOT NULL DEFAULT '{}',
  fixed_context jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(fixed_context)='object'),
  minimum numeric,
  maximum numeric,
  CHECK(minimum IS NULL OR maximum IS NULL OR minimum <= maximum),
  CHECK(processes <@ ARRAY['general','mma','mig','tig','cut','fcaw']),
  CHECK(cardinality(processes)>0),
  CHECK(required_context <@ ARRAY['current_a','temperature_c','pressure_bar','gas','cooling','duty_pct','material','diameter_mm'])
);
CREATE TABLE public.technical_family_attributes (
  family_code text NOT NULL REFERENCES public.technical_families(code),
  attribute_code text NOT NULL REFERENCES public.technical_attributes(code),
  label text,
  options_override text[],
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY(family_code,attribute_code)
);
CREATE TABLE public.technical_cards (
  product_id uuid PRIMARY KEY REFERENCES public.products(id),
  version bigint NOT NULL DEFAULT 0,
  published_revision uuid
);
CREATE TABLE public.technical_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.technical_cards(product_id),
  family_code text NOT NULL REFERENCES public.technical_families(code),
  review_state text NOT NULL CHECK(review_state IN ('pending_review','verified','conflict')),
  document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
  staff_telegram_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id,id)
);
ALTER TABLE public.technical_cards ADD CONSTRAINT technical_published_same_product
  FOREIGN KEY(product_id,published_revision) REFERENCES public.technical_revisions(product_id,id);
CREATE TABLE public.technical_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id),
  staff_telegram_id bigint NOT NULL,
  expected_version bigint NOT NULL,
  review_state text NOT NULL CHECK(review_state IN ('pending_review','verified','conflict')),
  document jsonb NOT NULL,
  state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','applied','undone')),
  before_published_revision uuid REFERENCES public.technical_revisions(id),
  after_revision uuid REFERENCES public.technical_revisions(id),
  after_version bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  applied_at timestamptz
);
CREATE INDEX technical_revisions_product ON public.technical_revisions(product_id,created_at DESC);
CREATE INDEX technical_changes_actor ON public.technical_changes(staff_telegram_id,created_at DESC);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['technical_units','technical_families','technical_attributes',
    'technical_family_attributes','technical_cards','technical_revisions','technical_changes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  END LOOP;
END $$;
-- No direct table grants: only explicit read/RPC projections are exposed.

CREATE FUNCTION public.validate_technical_document(p_document jsonb,p_review_state text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v jsonb; s jsonb; x jsonb; a public.technical_attributes%ROWTYPE;
  family text; process text; state text; n numeric; key text; val jsonb;
  source_keys text[] := '{}'; fact_keys text[] := '{}'; context_key text; family_options text[];
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
    key:=a.code||':'||process;
    IF NOT process=ANY(a.processes) OR key=ANY(fact_keys) OR v->>'unit_code'<>a.unit_code
      OR state NOT IN ('known','unknown','not_applicable') THEN RAISE EXCEPTION 'TECH_BAD_VALUE'; END IF;
    fact_keys:=array_append(fact_keys,key);
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

CREATE FUNCTION public.bot_technical_catalog(
  p_staff_telegram_id bigint,p_op text,p_product_id uuid DEFAULT NULL,
  p_change_id uuid DEFAULT NULL,p_document jsonb DEFAULT NULL,
  p_review_state text DEFAULT 'pending_review'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  s public.staff%ROWTYPE; c public.technical_cards%ROWTYPE; b public.technical_changes%ROWTYPE;
  approver boolean; revision_id uuid; result jsonb;
BEGIN
  -- Mirrors edit_products / publish_products in permissions.ts; lock against revocation.
  SELECT * INTO s FROM staff WHERE telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active OR NOT(s.role::text IN ('admin','seller') OR (s.role::text='director' AND s.elevated))
    THEN RAISE EXCEPTION 'TECH_DENIED'; END IF;
  approver:=s.role::text='admin' OR (s.role::text='director' AND s.elevated);
  IF p_op IS NULL OR p_op NOT IN ('read','preview','apply','undo') THEN RAISE EXCEPTION 'TECH_BAD_INPUT'; END IF;
  IF p_op IN ('read','preview') THEN
    PERFORM 1 FROM products WHERE id=p_product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TECH_PRODUCT_NOT_FOUND'; END IF;
    IF p_op='read' THEN
      INSERT INTO staff_audit_log(telegram_id,action,details)
        VALUES(p_staff_telegram_id,'technical_read',jsonb_build_object('product_id',p_product_id));
      SELECT jsonb_build_object('version',coalesce(c.version,0),'published_revision',c.published_revision,
        'revisions',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (
          SELECT id,review_state,document,created_at FROM technical_revisions WHERE product_id=p_product_id
          ORDER BY created_at DESC,id LIMIT 10) r),'[]'::jsonb)) INTO result
        FROM (SELECT p_product_id AS id) p LEFT JOIN technical_cards c ON c.product_id=p.id;
      RETURN jsonb_build_object('ok',true,'product_id',p_product_id,'card',result);
    END IF;
    IF p_review_state='verified' AND NOT approver THEN RAISE EXCEPTION 'TECH_REVIEW_DENIED'; END IF;
    PERFORM validate_technical_document(p_document,p_review_state);
    INSERT INTO technical_cards(product_id) VALUES(p_product_id) ON CONFLICT DO NOTHING;
    SELECT * INTO c FROM technical_cards WHERE product_id=p_product_id FOR UPDATE;
    INSERT INTO technical_changes(product_id,staff_telegram_id,expected_version,review_state,document,before_published_revision)
      VALUES(p_product_id,p_staff_telegram_id,c.version,p_review_state,p_document,c.published_revision) RETURNING * INTO b;
    INSERT INTO staff_audit_log(telegram_id,action,details)
      VALUES(p_staff_telegram_id,'technical_preview',jsonb_build_object('change_id',b.id,'product_id',p_product_id));
    RETURN jsonb_build_object('ok',true,'change_id',b.id,'state',b.state,'version',c.version,
      'review_state',b.review_state,'document',b.document,'expires_at',b.expires_at);
  END IF;
  SELECT * INTO b FROM technical_changes WHERE id=p_change_id FOR UPDATE;
  IF NOT FOUND OR b.staff_telegram_id<>p_staff_telegram_id THEN RAISE EXCEPTION 'TECH_CHANGE_NOT_FOUND'; END IF;
  IF (b.review_state='verified' OR (p_op='undo' AND b.before_published_revision IS NOT NULL)) AND NOT approver
    THEN RAISE EXCEPTION 'TECH_REVIEW_DENIED'; END IF;
  PERFORM 1 FROM products WHERE id=b.product_id FOR UPDATE;
  SELECT * INTO c FROM technical_cards WHERE product_id=b.product_id FOR UPDATE;
  IF (p_op='apply' AND b.state='applied') OR (p_op='undo' AND b.state='undone') THEN
    RETURN jsonb_build_object('ok',true,'state',b.state,'change_id',b.id,'duplicate',true);
  END IF;
  IF p_op='apply' THEN
    IF b.state<>'preview' OR b.expires_at<now() THEN RAISE EXCEPTION 'TECH_PREVIEW_EXPIRED'; END IF;
    IF c.version<>b.expected_version THEN RAISE EXCEPTION 'TECH_CONFLICT'; END IF;
    PERFORM validate_technical_document(b.document,b.review_state);
    INSERT INTO technical_revisions(product_id,family_code,review_state,document,staff_telegram_id)
      VALUES(b.product_id,b.document->>'family_code',b.review_state,b.document,p_staff_telegram_id) RETURNING id INTO revision_id;
    UPDATE technical_cards SET version=version+1,
      published_revision=CASE WHEN b.review_state='verified' THEN revision_id ELSE published_revision END
      WHERE product_id=b.product_id;
    UPDATE technical_changes SET state='applied',after_revision=revision_id,after_version=c.version+1,applied_at=now()
      WHERE id=b.id;
  ELSE
    IF b.state<>'applied' OR b.applied_at<now()-interval '7 days' THEN RAISE EXCEPTION 'TECH_UNDO_EXPIRED'; END IF;
    IF c.version<>b.after_version THEN RAISE EXCEPTION 'TECH_CONFLICT'; END IF;
    UPDATE technical_cards SET version=version+1,published_revision=b.before_published_revision WHERE product_id=b.product_id;
    UPDATE technical_changes SET state='undone' WHERE id=b.id;
  END IF;
  INSERT INTO staff_audit_log(telegram_id,action,details)
    VALUES(p_staff_telegram_id,'technical_'||p_op,jsonb_build_object('change_id',b.id,'product_id',b.product_id,
      'before_version',c.version,'after_version',c.version+1,'revision_id',coalesce(revision_id,b.after_revision)));
  RETURN jsonb_build_object('ok',true,'change_id',b.id,'state',CASE WHEN p_op='apply' THEN 'applied' ELSE 'undone' END,
    'version',c.version+1);
END $$;
REVOKE ALL ON FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text) TO service_role;

CREATE FUNCTION public.public_product_technical(p_product_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('product_id',p.id,'revision_id',r.id,
    'family',jsonb_build_object('code',f.code,'label',f.label),
    'verified_on',r.created_at::date,
    'values',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'code',a.code,'label',coalesce(fa.label,a.label),'kind',a.kind,'process',v->>'process',
      'state',v->>'state','value',v->'value',
      'unit',jsonb_build_object('code',u.code,'label',u.label),
      'context',v->'context','source_key',v->'source_key'
    ) ORDER BY fa.sort_order,a.code,v->>'process')
      FROM jsonb_array_elements(r.document->'values') v
      JOIN technical_attributes a ON a.code=v->>'attribute_code'
      JOIN technical_units u ON u.code=a.unit_code
      JOIN technical_family_attributes fa ON fa.family_code=r.family_code AND fa.attribute_code=a.code),'[]'::jsonb),
    'sources',r.document->'sources')
  FROM products p JOIN technical_cards c ON c.product_id=p.id
    JOIN technical_revisions r ON r.id=c.published_revision AND r.product_id=p.id AND r.review_state='verified'
    JOIN technical_families f ON f.code=r.family_code
  WHERE p.id=p_product_id AND p.status='published' AND p.assortment_decision<>'excluded';
$$;
REVOKE ALL ON FUNCTION public.public_product_technical(uuid) FROM PUBLIC,service_role;
GRANT EXECUTE ON FUNCTION public.public_product_technical(uuid) TO anon,authenticated,service_role;

-- P0 vocabulary only. No family assignment, product values, prices or publication changes.
-- Mirrors src/lib/technical/pilot-dictionary.json; reviewed subset of the research proposal.
DO $seed$ DECLARE d jsonb := $technical_seed${"version":1,"scope":"P0 pilot definitions; no actual SKU facts or automatic family assignment","units":[{"code":"none","label":"—","dimension":"dimensionless"},{"code":"a","label":"А","dimension":"current"},{"code":"pct","label":"%","dimension":"ratio"},{"code":"mm","label":"мм","dimension":"length"},{"code":"v","label":"В","dimension":"voltage"},{"code":"l_min","label":"л/мин","dimension":"volume_flow"},{"code":"kg","label":"кг","dimension":"mass"},{"code":"din","label":"DIN","dimension":"shade"},{"code":"ms","label":"мс","dimension":"time"},{"code":"c","label":"°C","dimension":"temperature"},{"code":"bar","label":"бар","dimension":"pressure"},{"code":"kw","label":"кВт","dimension":"active_power"},{"code":"kva","label":"кВА","dimension":"apparent_power"},{"code":"count","label":"шт","dimension":"count"}],"families":[{"code":"power_mma","label":"Сварочные инверторы MMA"},{"code":"power_mig","label":"Полуавтоматы MIG/MAG и FCAW"},{"code":"power_tig_dc","label":"Аргонодуговые аппараты TIG DC"},{"code":"power_tig_acdc","label":"Аргонодуговые аппараты TIG AC/DC"},{"code":"power_multiprocess","label":"Многопроцессные аппараты MMA/MIG/TIG"},{"code":"power_cut","label":"Аппараты воздушно-плазменной резки CUT"},{"code":"power_saw","label":"Источники сварки под флюсом SAW"},{"code":"power_spot","label":"Контактная точечная и шовная сварка"},{"code":"power_stud","label":"Аппараты приварки шпилек"},{"code":"power_laser","label":"Лазерная ручная сварка"},{"code":"pipe_socket","label":"Паяльники для раструбной сварки пластиковых труб"},{"code":"pipe_electrofusion","label":"Аппараты электромуфтовой сварки"},{"code":"weld_generator","label":"Сварочные электрогенераторы"},{"code":"consumable_mma_electrodes","label":"Покрытые электроды MMA"},{"code":"consumable_mig_wire_solid","label":"Сплошная проволока MIG/MAG"},{"code":"consumable_flux_wire","label":"Порошковая сварочная проволока FCAW"},{"code":"consumable_tig_rod","label":"Присадочные прутки TIG"},{"code":"consumable_saw_wire","label":"Проволока SAW"},{"code":"consumable_saw_flux","label":"Флюс для сварки SAW"},{"code":"consumable_tungsten","label":"Вольфрамовые неплавящиеся электроды TIG"},{"code":"mig_torch","label":"Сварочные горелки MIG/MAG"},{"code":"tig_torch","label":"Сварочные горелки TIG"},{"code":"cut_torch","label":"Плазмотроны CUT"},{"code":"mig_contact_tip","label":"Контактные наконечники MIG/MAG"},{"code":"mig_gas_nozzle","label":"Газовые сопла MIG/MAG"},{"code":"mig_liner","label":"Каналы/направляющие проволоки MIG"},{"code":"feed_rollers","label":"Ролики подачи сварочной проволоки"},{"code":"tig_kit_parts","label":"Цанги, линзы, керамические сопла TIG"},{"code":"cut_parts","label":"Сопла, электроды, защитные колпачки CUT"},{"code":"mma_holder","label":"Электрододержатели MMA"},{"code":"ground_clamp","label":"Зажимы массы сварочные"},{"code":"welding_cable","label":"Сварочные кабели и соединения"},{"code":"mask_adf","label":"Маски сварщика с автозатемнением"},{"code":"mask_passive","label":"Маски и щитки с постоянным фильтром"},{"code":"welding_gloves","label":"Краги и перчатки сварщика"},{"code":"workwear","label":"Костюмы, куртки, нарукавники сварщика"},{"code":"fume_extraction","label":"Вытяжки сварочных аэрозолей"},{"code":"wire_feeder","label":"Выносные подающие механизмы"},{"code":"water_cooler","label":"Блоки водяного охлаждения горелок"},{"code":"welding_magnets","label":"Магнитные угольники, держатели"},{"code":"welding_table","label":"Сварочные столы и оснастка"},{"code":"oxy_torch","label":"Газовые сварочные горелки и резаки"},{"code":"oxy_cut_nozzle","label":"Газовые мундштуки и сопла резаков"},{"code":"gas_regulator","label":"Редукторы/расходомеры/подогреватели газа"},{"code":"gas_hose","label":"Газовые рукава и соединители"},{"code":"air_compressor","label":"Воздушные компрессоры для плазморезов"},{"code":"gas_cylinder","label":"Газовые баллоны, переходники, тележки"},{"code":"brazing_solder","label":"Припои и флюсы для пайки"}],"attributes":[{"code":"mains_nominal_v","label":"Номинальное напряжение сети","kind":"number","unit_code":"v","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mma_current_min_a","label":"Минимальный ток MMA","kind":"number","unit_code":"a","options":[],"processes":["mma"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mma_current_max_a","label":"Максимальный ток MMA","kind":"number","unit_code":"a","options":[],"processes":["mma"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mma_duty_cycle_pct","label":"ПН MMA (при указанном токе)","kind":"number","unit_code":"pct","options":[],"processes":["mma"],"required_context":["current_a","temperature_c"],"fixed_context":{},"minimum":0,"maximum":100},{"code":"hot_start","label":"Hot Start","kind":"boolean","unit_code":"none","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"mig_current_min_a","label":"Ток MIG/MAG минимум","kind":"number","unit_code":"a","options":[],"processes":["mig"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mig_current_max_a","label":"Ток MIG/MAG максимум","kind":"number","unit_code":"a","options":[],"processes":["mig"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mig_duty_cycle_pct","label":"ПН MIG (условия указаны отдельно)","kind":"number","unit_code":"pct","options":[],"processes":["mig"],"required_context":["current_a","temperature_c"],"fixed_context":{},"minimum":0,"maximum":100},{"code":"mig_wire_diameters_mm","label":"Поддерживаемые диаметры проволоки MIG","kind":"number_list","unit_code":"mm","options":[],"processes":["mig"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"tig_polarity_modes","label":"Род тока TIG","kind":"enum_list","unit_code":"none","options":["dc","ac"],"processes":["tig"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"tig_current_min_a","label":"Ток TIG минимум","kind":"number","unit_code":"a","options":[],"processes":["tig"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"tig_current_max_a","label":"Ток TIG максимум","kind":"number","unit_code":"a","options":[],"processes":["tig"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"tig_start_modes","label":"Поджиг дуги HF/Lift/касанием","kind":"enum_list","unit_code":"none","options":["hf","lift","contact"],"processes":["tig"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"tig_pulse","label":"Импульсный режим TIG","kind":"boolean","unit_code":"none","options":[],"processes":["tig"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"tig_duty_cycle_pct","label":"ПН TIG","kind":"number","unit_code":"pct","options":[],"processes":["tig"],"required_context":["current_a","temperature_c"],"fixed_context":{},"minimum":0,"maximum":100},{"code":"cut_current_min_a","label":"Ток CUT минимум","kind":"number","unit_code":"a","options":[],"processes":["cut"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"cut_current_max_a","label":"Ток CUT максимум","kind":"number","unit_code":"a","options":[],"processes":["cut"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"cut_recommended_thickness_mm","label":"Рекомендуемая толщина реза","kind":"number","unit_code":"mm","options":[],"processes":["cut"],"required_context":["material"],"fixed_context":{},"minimum":0,"maximum":null},{"code":"cut_severance_thickness_mm","label":"Предельный разделительный рез","kind":"number","unit_code":"mm","options":[],"processes":["cut"],"required_context":["material"],"fixed_context":{},"minimum":0,"maximum":null},{"code":"cut_piercing_thickness_mm","label":"Толщина прожига","kind":"number","unit_code":"mm","options":[],"processes":["cut"],"required_context":["material"],"fixed_context":{},"minimum":0,"maximum":null},{"code":"compressed_air_flow_l_min","label":"Требуемый расход воздуха","kind":"number","unit_code":"l_min","options":[],"processes":["cut"],"required_context":["pressure_bar"],"fixed_context":{},"minimum":0,"maximum":null},{"code":"integrated_compressor","label":"Встроенный компрессор","kind":"boolean","unit_code":"none","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"pilot_arc","label":"Пилотная дуга","kind":"boolean","unit_code":"none","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"cut_duty_cycle_pct","label":"ПН CUT","kind":"number","unit_code":"pct","options":[],"processes":["cut"],"required_context":["current_a","temperature_c"],"fixed_context":{},"minimum":0,"maximum":100},{"code":"electrode_diameter_mm","label":"Диаметр электрода","kind":"number","unit_code":"mm","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"electrode_current_min_a","label":"Ток, нижняя граница для этого диаметра","kind":"number","unit_code":"a","options":[],"processes":["mma"],"required_context":["diameter_mm"],"fixed_context":{},"minimum":0,"maximum":null},{"code":"electrode_current_max_a","label":"Ток, верхняя граница для этого диаметра","kind":"number","unit_code":"a","options":[],"processes":["mma"],"required_context":["diameter_mm"],"fixed_context":{},"minimum":0,"maximum":null},{"code":"wire_diameter_mm","label":"Диаметр проволоки","kind":"number","unit_code":"mm","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"wire_spool_net_mass_kg","label":"Масса проволоки на катушке","kind":"number","unit_code":"kg","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"flux_wire_gas_mode","label":"Самозащитная или под газом","kind":"enum","unit_code":"none","options":["self_shielded","gas_shielded"],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"mig_torch_amp_co2_a","label":"Номинальный ток в CO₂","kind":"number","unit_code":"a","options":[],"processes":["mig"],"required_context":["gas","cooling","duty_pct","temperature_c"],"fixed_context":{"gas":"CO2"},"minimum":0,"maximum":null},{"code":"mig_torch_amp_m21_a","label":"Номинальный ток в смеси M21","kind":"number","unit_code":"a","options":[],"processes":["mig"],"required_context":["gas","cooling","duty_pct","temperature_c"],"fixed_context":{"gas":"M21"},"minimum":0,"maximum":null},{"code":"mig_torch_wire_diameters_mm","label":"Поддерживаемые диаметры проволоки","kind":"number_list","unit_code":"mm","options":[],"processes":["mig"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mask_optical_class","label":"Оптический класс (четыре цифры)","kind":"text","unit_code":"none","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"mask_dark_shade_min_din","label":"Нижний предел затемнения DIN","kind":"number","unit_code":"din","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mask_dark_shade_max_din","label":"Верхний предел затемнения DIN","kind":"number","unit_code":"din","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mask_sensors","label":"Количество датчиков","kind":"integer","unit_code":"count","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mask_switching_time_ms","label":"Время затемнения при заданной t","kind":"number","unit_code":"ms","options":[],"processes":["general"],"required_context":["temperature_c"],"fixed_context":{},"minimum":0,"maximum":null},{"code":"mask_grinding_mode","label":"Режим шлифовки","kind":"boolean","unit_code":"none","options":[],"processes":["general"],"required_context":[],"fixed_context":{},"minimum":null,"maximum":null},{"code":"power_consumption_kva","label":"Полная мощность в указанном режиме","kind":"number","unit_code":"kva","options":[],"processes":["mma","mig","tig"],"required_context":[],"fixed_context":{},"minimum":0,"maximum":null}],"bindings":[{"family_code":"power_mma","attribute_code":"mains_nominal_v","label":"Номинальное напряжение сети","sort_order":0,"options_override":null},{"family_code":"power_mma","attribute_code":"mma_current_min_a","label":"Минимальный ток MMA","sort_order":1,"options_override":null},{"family_code":"power_mma","attribute_code":"mma_current_max_a","label":"Максимальный ток MMA","sort_order":2,"options_override":null},{"family_code":"power_mma","attribute_code":"mma_duty_cycle_pct","label":"ПН MMA (при указанном токе)","sort_order":3,"options_override":null},{"family_code":"power_mma","attribute_code":"hot_start","label":"Hot Start","sort_order":4,"options_override":null},{"family_code":"power_mig","attribute_code":"mains_nominal_v","label":"Номинальная сеть","sort_order":5,"options_override":null},{"family_code":"power_mig","attribute_code":"mig_current_min_a","label":"Ток MIG/MAG минимум","sort_order":6,"options_override":null},{"family_code":"power_mig","attribute_code":"mig_current_max_a","label":"Ток MIG/MAG максимум","sort_order":7,"options_override":null},{"family_code":"power_mig","attribute_code":"mig_duty_cycle_pct","label":"ПН MIG (условия указаны отдельно)","sort_order":8,"options_override":null},{"family_code":"power_mig","attribute_code":"mig_wire_diameters_mm","label":"Поддерживаемые диаметры проволоки MIG","sort_order":9,"options_override":null},{"family_code":"power_tig_dc","attribute_code":"tig_polarity_modes","label":"Род тока TIG","sort_order":10,"options_override":["dc"]},{"family_code":"power_tig_dc","attribute_code":"tig_current_min_a","label":"Ток TIG минимум","sort_order":11,"options_override":null},{"family_code":"power_tig_dc","attribute_code":"tig_current_max_a","label":"Ток TIG максимум","sort_order":12,"options_override":null},{"family_code":"power_tig_dc","attribute_code":"tig_start_modes","label":"Поджиг дуги HF/Lift/касанием","sort_order":13,"options_override":null},{"family_code":"power_tig_dc","attribute_code":"tig_pulse","label":"Импульсный режим TIG","sort_order":14,"options_override":null},{"family_code":"power_tig_dc","attribute_code":"tig_duty_cycle_pct","label":"ПН TIG","sort_order":15,"options_override":null},{"family_code":"power_tig_dc","attribute_code":"mains_nominal_v","label":"Номинальная сеть","sort_order":16,"options_override":null},{"family_code":"power_tig_acdc","attribute_code":"tig_polarity_modes","label":"Род тока TIG (AC/DC)","sort_order":17,"options_override":null},{"family_code":"power_tig_acdc","attribute_code":"tig_current_min_a","label":"Ток TIG минимум","sort_order":18,"options_override":null},{"family_code":"power_tig_acdc","attribute_code":"tig_current_max_a","label":"Ток TIG максимум","sort_order":19,"options_override":null},{"family_code":"power_tig_acdc","attribute_code":"tig_start_modes","label":"Поджиг HF/Lift","sort_order":20,"options_override":null},{"family_code":"power_tig_acdc","attribute_code":"tig_pulse","label":"Импульсный TIG","sort_order":21,"options_override":null},{"family_code":"power_tig_acdc","attribute_code":"tig_duty_cycle_pct","label":"ПН TIG","sort_order":22,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"mma_current_min_a","label":"Ток MMA минимум","sort_order":23,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"mma_current_max_a","label":"Ток MMA максимум","sort_order":24,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"mig_current_min_a","label":"Ток MIG минимум","sort_order":25,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"mig_current_max_a","label":"Ток MIG максимум","sort_order":26,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"tig_current_min_a","label":"Ток TIG минимум","sort_order":27,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"tig_current_max_a","label":"Ток TIG максимум","sort_order":28,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"tig_polarity_modes","label":"Род тока TIG","sort_order":29,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"tig_start_modes","label":"Поджиг TIG","sort_order":30,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"mig_wire_diameters_mm","label":"Диаметры MIG-проволоки","sort_order":31,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"mig_duty_cycle_pct","label":"ПН MIG","sort_order":32,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"mma_duty_cycle_pct","label":"ПН MMA","sort_order":33,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"tig_duty_cycle_pct","label":"ПН TIG","sort_order":34,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"mains_nominal_v","label":"Напряжение сети","sort_order":35,"options_override":null},{"family_code":"power_cut","attribute_code":"mains_nominal_v","label":"Номинальная сеть","sort_order":36,"options_override":null},{"family_code":"power_cut","attribute_code":"cut_current_min_a","label":"Ток CUT минимум","sort_order":37,"options_override":null},{"family_code":"power_cut","attribute_code":"cut_current_max_a","label":"Ток CUT максимум","sort_order":38,"options_override":null},{"family_code":"power_cut","attribute_code":"cut_recommended_thickness_mm","label":"Рекомендуемая толщина реза","sort_order":39,"options_override":null},{"family_code":"power_cut","attribute_code":"cut_severance_thickness_mm","label":"Предельный разделительный рез","sort_order":40,"options_override":null},{"family_code":"power_cut","attribute_code":"cut_piercing_thickness_mm","label":"Толщина прожига","sort_order":41,"options_override":null},{"family_code":"power_cut","attribute_code":"compressed_air_flow_l_min","label":"Требуемый расход воздуха","sort_order":42,"options_override":null},{"family_code":"power_cut","attribute_code":"integrated_compressor","label":"Встроенный компрессор","sort_order":43,"options_override":null},{"family_code":"power_cut","attribute_code":"pilot_arc","label":"Пилотная дуга","sort_order":44,"options_override":null},{"family_code":"power_cut","attribute_code":"cut_duty_cycle_pct","label":"ПН CUT","sort_order":45,"options_override":null},{"family_code":"power_saw","attribute_code":"mains_nominal_v","label":"Питающая сеть","sort_order":46,"options_override":null},{"family_code":"power_stud","attribute_code":"mains_nominal_v","label":"Питающая сеть","sort_order":47,"options_override":null},{"family_code":"power_laser","attribute_code":"mains_nominal_v","label":"Питающая сеть","sort_order":48,"options_override":null},{"family_code":"pipe_electrofusion","attribute_code":"mains_nominal_v","label":"Питающая сеть","sort_order":49,"options_override":null},{"family_code":"weld_generator","attribute_code":"mma_current_max_a","label":"Ток MMA встроенного поста (если есть)","sort_order":50,"options_override":null},{"family_code":"consumable_mma_electrodes","attribute_code":"electrode_diameter_mm","label":"Диаметр электрода","sort_order":51,"options_override":null},{"family_code":"consumable_mma_electrodes","attribute_code":"electrode_current_min_a","label":"Ток, нижняя граница для этого диаметра","sort_order":52,"options_override":null},{"family_code":"consumable_mma_electrodes","attribute_code":"electrode_current_max_a","label":"Ток, верхняя граница для этого диаметра","sort_order":53,"options_override":null},{"family_code":"consumable_mig_wire_solid","attribute_code":"wire_diameter_mm","label":"Диаметр проволоки","sort_order":54,"options_override":null},{"family_code":"consumable_mig_wire_solid","attribute_code":"wire_spool_net_mass_kg","label":"Масса проволоки на катушке","sort_order":55,"options_override":null},{"family_code":"consumable_flux_wire","attribute_code":"wire_diameter_mm","label":"Диаметр","sort_order":56,"options_override":null},{"family_code":"consumable_flux_wire","attribute_code":"flux_wire_gas_mode","label":"Самозащитная или под газом","sort_order":57,"options_override":null},{"family_code":"consumable_flux_wire","attribute_code":"wire_spool_net_mass_kg","label":"Масса проволоки","sort_order":58,"options_override":null},{"family_code":"mig_torch","attribute_code":"mig_torch_amp_co2_a","label":"Номинальный ток в CO₂","sort_order":59,"options_override":null},{"family_code":"mig_torch","attribute_code":"mig_torch_amp_m21_a","label":"Номинальный ток в смеси M21","sort_order":60,"options_override":null},{"family_code":"mig_torch","attribute_code":"mig_torch_wire_diameters_mm","label":"Поддерживаемые диаметры проволоки","sort_order":61,"options_override":null},{"family_code":"mask_adf","attribute_code":"mask_optical_class","label":"Оптический класс (четыре цифры)","sort_order":62,"options_override":null},{"family_code":"mask_adf","attribute_code":"mask_dark_shade_min_din","label":"Нижний предел затемнения DIN","sort_order":63,"options_override":null},{"family_code":"mask_adf","attribute_code":"mask_dark_shade_max_din","label":"Верхний предел затемнения DIN","sort_order":64,"options_override":null},{"family_code":"mask_adf","attribute_code":"mask_sensors","label":"Количество датчиков","sort_order":65,"options_override":null},{"family_code":"mask_adf","attribute_code":"mask_switching_time_ms","label":"Время затемнения при заданной t","sort_order":66,"options_override":null},{"family_code":"mask_adf","attribute_code":"mask_grinding_mode","label":"Режим шлифовки","sort_order":67,"options_override":null},{"family_code":"power_multiprocess","attribute_code":"power_consumption_kva","label":"Полная мощность по режиму","sort_order":100,"options_override":null}]}$technical_seed$::jsonb; BEGIN
  INSERT INTO technical_units SELECT * FROM jsonb_to_recordset(d->'units') AS x(code text,label text,dimension text);
  INSERT INTO technical_families SELECT * FROM jsonb_to_recordset(d->'families') AS x(code text,label text);
  INSERT INTO technical_attributes(code,label,kind,unit_code,options,processes,required_context,fixed_context,minimum,maximum)
    SELECT * FROM jsonb_to_recordset(d->'attributes') AS x(code text,label text,kind text,unit_code text,
      options text[],processes text[],required_context text[],fixed_context jsonb,minimum numeric,maximum numeric);
  INSERT INTO technical_family_attributes(family_code,attribute_code,label,sort_order,options_override)
    SELECT * FROM jsonb_to_recordset(d->'bindings') AS x(family_code text,attribute_code text,label text,sort_order integer,options_override text[]);
END $seed$;
NOTIFY pgrst, 'reload schema';
