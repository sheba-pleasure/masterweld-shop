-- Work in progress: private, human-reviewed derivatives of an approved document.
-- No catalog/publication writes. Do not deploy before the review UI and source dependency guards.
CREATE TABLE public.source_fact_reviews (
 id uuid PRIMARY KEY,
 actor bigint NOT NULL REFERENCES public.staff(telegram_id),
 source_id uuid NOT NULL REFERENCES public.product_document_sources(id),
 product_id uuid NOT NULL REFERENCES public.products(id),
 family_code text NOT NULL REFERENCES public.technical_families(code),
 model_context jsonb NOT NULL,
 base_version bigint NOT NULL,
 extraction jsonb NOT NULL CHECK(jsonb_typeof(extraction)='object' AND octet_length(extraction::text)<=1500000),
 publisher text CHECK(publisher IS NULL OR length(btrim(publisher)) BETWEEN 1 AND 1000),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 phase text NOT NULL DEFAULT 'reviewing' CHECK(phase IN('reviewing','preview','handed','canceled','expired')),
 editor_session_id uuid REFERENCES public.technical_editor_sessions(id),
 prepared_document jsonb,
 merge_preview jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 preview_expires_at timestamptz
);
CREATE UNIQUE INDEX source_fact_one_review ON public.source_fact_reviews(actor) WHERE phase IN('reviewing','preview');
CREATE TABLE public.source_fact_rows (
 review_id uuid NOT NULL REFERENCES public.source_fact_reviews(id),
 row_index integer NOT NULL CHECK(row_index BETWEEN 0 AND 255),
 proposal jsonb NOT NULL CHECK(jsonb_typeof(proposal)='object'),
 draft jsonb CHECK(draft IS NULL OR jsonb_typeof(draft)='object'),
 decision text NOT NULL DEFAULT 'pending' CHECK(decision IN('pending','accepted','skipped')),
 decided_at timestamptz,
 locator_override text CHECK(locator_override IS NULL OR length(btrim(locator_override)) BETWEEN 1 AND 1000),
 PRIMARY KEY(review_id,row_index)
);
CREATE TABLE public.source_fact_prompts (
 actor bigint PRIMARY KEY REFERENCES public.staff(telegram_id),
 review_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>=0),
 row_index integer NOT NULL,
 field text NOT NULL CHECK(field IN('value','publisher','locator','current_a','temperature_c','pressure_bar',
   'gas','cooling','duty_pct','material','diameter_mm')),
 message_id bigint CHECK(message_id>0),
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(review_id,row_index) REFERENCES public.source_fact_rows(review_id,row_index)
);
ALTER TABLE public.source_fact_prompts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.source_fact_prompts FROM PUBLIC,anon,authenticated,service_role;

-- Serialize all question starts on the same actor, including entry through older editors.
CREATE FUNCTION mw_private.source_fact_input_exclusive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $exclusive$
DECLARE actor_id bigint;
BEGIN
 IF TG_TABLE_NAME IN('source_fact_prompts','document_review_prompts') THEN
  IF NEW.expires_at<=now() THEN RETURN NEW; END IF;
  actor_id:=NEW.actor;
 ELSIF TG_TABLE_NAME='bot_editor_states' THEN
  IF NEW.consumed_at IS NOT NULL OR NEW.expires_at<=now() THEN RETURN NEW; END IF;
  actor_id:=NEW.staff_telegram_id;
 ELSE
  IF NEW.phase NOT IN('editing','preview') OR NEW.expires_at<=now() THEN RETURN NEW; END IF;
  actor_id:=NEW.staff_telegram_id;
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'EDITOR_ISOLATION_REQUIRED'; END IF;
 PERFORM 1 FROM staff WHERE telegram_id=actor_id FOR UPDATE;
 IF TG_TABLE_NAME='source_fact_prompts' THEN
  IF NOT EXISTS(SELECT 1 FROM source_fact_reviews r WHERE r.id=NEW.review_id AND r.actor=actor_id
     AND r.phase='reviewing' AND r.revision=NEW.revision AND NEW.expires_at<=r.expires_at)
   THEN RAISE EXCEPTION 'SOURCE_FACT_QUESTION_STALE'; END IF;
  IF EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=actor_id AND consumed_at IS NULL AND expires_at>now())
   OR EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=actor_id AND phase IN('editing','preview') AND expires_at>now())
   OR EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=actor_id AND expires_at>now())
   THEN RAISE EXCEPTION 'SOURCE_FACT_OTHER_INPUT'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM source_fact_prompts p JOIN source_fact_reviews r ON r.id=p.review_id
    JOIN staff owner ON owner.telegram_id=p.actor WHERE p.actor=actor_id AND p.expires_at>now()
     AND r.actor=p.actor AND r.revision=p.revision AND r.phase='reviewing' AND r.expires_at>now()
     AND owner.active AND(owner.role::text='admin' OR(owner.role::text='director' AND owner.elevated)))
   THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT_ACTIVE'; END IF;
 END IF;
 RETURN NEW;
END $exclusive$;
REVOKE ALL ON FUNCTION mw_private.source_fact_input_exclusive() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER source_fact_input_guard BEFORE INSERT OR UPDATE ON public.source_fact_prompts
 FOR EACH ROW EXECUTE FUNCTION mw_private.source_fact_input_exclusive();
CREATE TRIGGER source_fact_document_guard BEFORE INSERT OR UPDATE ON public.document_review_prompts
 FOR EACH ROW EXECUTE FUNCTION mw_private.source_fact_input_exclusive();
CREATE TRIGGER source_fact_ordinary_guard BEFORE INSERT OR UPDATE ON public.bot_editor_states
 FOR EACH ROW EXECUTE FUNCTION mw_private.source_fact_input_exclusive();
CREATE TRIGGER source_fact_technical_guard BEFORE INSERT OR UPDATE ON public.technical_editor_sessions
 FOR EACH ROW EXECUTE FUNCTION mw_private.source_fact_input_exclusive();

ALTER TABLE public.source_fact_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_fact_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.source_fact_reviews,public.source_fact_rows FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION mw_private.product_document_source_usable(p_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT s.withdrawn_at IS NULL AND d.state='review' AND s.document_checksum=d.checksum
   AND s.model_context=mw_private.technical_model_context(s.product_id)
   AND s.model_context->>'state'='selected'
 FROM product_document_sources s JOIN document_intakes d ON d.id=s.document_id AND d.staff_telegram_id=s.actor
 WHERE s.id=p_source),false)
$$;
REVOKE ALL ON FUNCTION mw_private.product_document_source_usable(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Code-point offsets, not UTF-16 indices: quotes must match the immutable source exactly.
CREATE FUNCTION mw_private.source_fact_evidence_matches(p_extraction jsonb,p_evidence jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE block jsonb; tab jsonb; idx integer; row_no integer; first_char integer; last_char integer; page_no integer;
BEGIN
 IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF p_evidence->>'kind'='block' THEN
  IF p_evidence->>'block' IS NULL OR p_evidence->>'block' !~ '^[0-9]{1,6}$'
   OR p_evidence->>'start' IS NULL OR p_evidence->>'start' !~ '^[0-9]{1,7}$'
   OR p_evidence->>'end' IS NULL OR p_evidence->>'end' !~ '^[0-9]{1,7}$'
   OR p_evidence->>'offset_unit' IS DISTINCT FROM 'unicode_codepoints'
   OR jsonb_typeof(p_evidence->'quote') IS DISTINCT FROM 'string'
   THEN RETURN false; END IF;
  idx:=(p_evidence->>'block')::integer;first_char:=(p_evidence->>'start')::integer;last_char:=(p_evidence->>'end')::integer;
  block:=p_extraction->'blocks'->idx;
  IF jsonb_typeof(block->'text') IS DISTINCT FROM 'string' OR first_char>=last_char
   OR last_char>length(block->>'text') OR p_evidence->>'locator' IS DISTINCT FROM block->>'locator'
   OR substring(block->>'text' FROM first_char+1 FOR last_char-first_char) IS DISTINCT FROM p_evidence->>'quote'
   THEN RETURN false; END IF;
  IF p_evidence->>'page' IS NOT NULL THEN
   IF p_evidence->>'page' !~ '^[1-9][0-9]{0,5}$' THEN RETURN false; END IF;
   page_no:=(p_evidence->>'page')::integer;
   IF block->>'locator' IS DISTINCT FROM 'page:'||page_no
    OR (block->>'page' IS NOT NULL AND block->>'page' IS DISTINCT FROM page_no::text)
    THEN RETURN false; END IF;
  END IF;
  RETURN true;
 ELSIF p_evidence->>'kind'='table' THEN
  IF p_evidence->>'table' IS NULL OR p_evidence->>'table' !~ '^[0-9]{1,6}$'
   OR p_evidence->>'row' IS NULL OR p_evidence->>'row' !~ '^[0-9]{1,6}$'
   THEN RETURN false; END IF;
  idx:=(p_evidence->>'table')::integer;row_no:=(p_evidence->>'row')::integer;
  tab:=p_extraction->'tables'->idx;
  RETURN coalesce(jsonb_typeof(tab->'rows'->row_no)='array'
   AND p_evidence->'header'=tab->'header' AND p_evidence->'cells'=tab->'rows'->row_no
   AND (p_evidence->>'locator' IS NOT DISTINCT FROM tab->'row_locators'->>row_no),false);
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION mw_private.source_fact_evidence_matches(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Reuse the canonical type/unit/condition validator; this metadata is internal and never saved.
CREATE FUNCTION mw_private.source_fact_validate_value(p_family text,p_value jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'object'
  OR p_value-ARRAY['attribute_code','process','unit_code','value','context']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'SOURCE_FACT_BAD_VALUE'; END IF;
 PERFORM validate_technical_document(jsonb_build_object('family_code',p_family,
  'sources',jsonb_build_array(jsonb_build_object('key','document','kind','manual',
   'publisher','Служебная проверка формата','model','Служебная проверка формата',
   'title','Служебная проверка формата','url','','sha256',repeat('0',64),'locator','Проверка формата','checked_on',current_date::text)),
  'values',jsonb_build_array(p_value||jsonb_build_object('state','known','source_key','document'))),'pending_review');
END $$;
REVOKE ALL ON FUNCTION mw_private.source_fact_validate_value(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- The plan is a frozen derivative, never a catalog write. Compare facts by exact
-- field/process/conditions; equal numbers in JSONB compare equally despite decimal spelling.
CREATE FUNCTION mw_private.source_fact_merge_preview(p_before jsonb,p_incoming jsonb,p_review uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $merge$
DECLARE item jsonb; old_fact jsonb; new_fact jsonb; old_index integer; new_index integer;
 next_values jsonb:='[]'; next_sources jsonb:='[]'; incoming_values jsonb:='[]'; changes jsonb:='[]';
 source_map jsonb:='{}'; matched integer[]:='{}'; source_key text; source_number integer:=0;
 same_family boolean; result_document jsonb;
BEGIN
 IF p_review IS NULL OR p_incoming IS NULL THEN RAISE EXCEPTION 'SOURCE_FACT_MERGE_INPUT'; END IF;
 PERFORM validate_technical_document(p_incoming,'pending_review');
 IF p_before IS NOT NULL THEN PERFORM validate_technical_document(p_before,'pending_review'); END IF;
 same_family:=p_before->>'family_code'=p_incoming->>'family_code';
 -- Give each new source a key that cannot overwrite any old source, including an unused one.
 FOR item IN SELECT value FROM jsonb_array_elements(p_incoming->'sources') LOOP
  LOOP
   source_key:='sf'||replace(p_review::text,'-','')||'_'||source_number;
   source_number:=source_number+1;
   EXIT WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_before->'sources','[]')) s
    WHERE s->>'key'=source_key);
  END LOOP;
  source_map:=source_map||jsonb_build_object(item->>'key',source_key);
  next_sources:=next_sources||jsonb_build_array(item||jsonb_build_object('key',source_key));
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_incoming->'values') LOOP
  incoming_values:=incoming_values||jsonb_build_array(CASE WHEN item->>'source_key' IS NOT NULL
   THEN item||jsonb_build_object('source_key',source_map->>(item->>'source_key')) ELSE item END);
 END LOOP;
 FOR old_fact,old_index IN SELECT value,(ordinality-1)::integer
  FROM jsonb_array_elements(coalesce(p_before->'values','[]')) WITH ORDINALITY LOOP
  IF same_family THEN
   SELECT value,(ordinality-1)::integer INTO new_fact,new_index
    FROM jsonb_array_elements(incoming_values) WITH ORDINALITY
    WHERE jsonb_build_array(value->'attribute_code',value->'process',value->'context')
     =jsonb_build_array(old_fact->'attribute_code',old_fact->'process',old_fact->'context');
   IF FOUND THEN
    changes:=changes||jsonb_build_array(jsonb_build_object('kind','replaced',
     'before_index',old_index,'after_index',jsonb_array_length(next_values)));
    next_values:=next_values||jsonb_build_array(new_fact);
    matched:=array_append(matched,new_index);
   ELSE
    changes:=changes||jsonb_build_array(jsonb_build_object('kind','retained',
     'before_index',old_index,'after_index',jsonb_array_length(next_values)));
    next_values:=next_values||jsonb_build_array(old_fact);
   END IF;
  ELSE
   changes:=changes||jsonb_build_array(jsonb_build_object('kind','removed',
    'before_index',old_index,'after_index',NULL));
  END IF;
 END LOOP;
 FOR new_fact,new_index IN SELECT value,(ordinality-1)::integer
  FROM jsonb_array_elements(incoming_values) WITH ORDINALITY LOOP
  IF NOT new_index=ANY(matched) THEN
   changes:=changes||jsonb_build_array(jsonb_build_object('kind','added','before_index',NULL,
    'after_index',jsonb_array_length(next_values)));
   next_values:=next_values||jsonb_build_array(new_fact);
  END IF;
 END LOOP;
 -- Keep every still-used old source exactly; drop only references no resulting fact uses.
 SELECT coalesce(jsonb_agg(s.value ORDER BY s.ordinality),'[]') INTO next_sources
  FROM jsonb_array_elements(coalesce(p_before->'sources','[]')||next_sources) WITH ORDINALITY s
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(next_values) v WHERE v->>'source_key'=s.value->>'key');
 IF jsonb_array_length(next_values)>128 THEN RAISE EXCEPTION 'SOURCE_FACT_MERGE_VALUE_LIMIT'; END IF;
 IF jsonb_array_length(next_sources)>32 THEN RAISE EXCEPTION 'SOURCE_FACT_MERGE_SOURCE_LIMIT'; END IF;
 result_document:=jsonb_build_object('family_code',p_incoming->'family_code',
  'sources',next_sources,'values',next_values);
 IF octet_length(result_document::text)>131072 THEN RAISE EXCEPTION 'SOURCE_FACT_MERGE_SIZE_LIMIT'; END IF;
 PERFORM validate_technical_document(result_document,'pending_review');
 RETURN jsonb_build_object('version','source-fact-merge-v1','before_document',p_before,
  'after_document',result_document,'changes',changes);
END $merge$;
REVOKE ALL ON FUNCTION mw_private.source_fact_merge_preview(jsonb,jsonb,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_source_fact_review(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
 p_revision integer DEFAULT NULL,p_index integer DEFAULT 0,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $review$
DECLARE r source_fact_reviews%ROWTYPE; line source_fact_rows%ROWTYPE; src product_document_sources%ROWTYPE;
 d document_intakes%ROWTYPE; v_proposal jsonb; supplied jsonb; all_rows jsonb; accepted_values jsonb;
 source_values jsonb; result_document jsonb; counts jsonb; current_model jsonb; selected_attribute technical_attributes%ROWTYPE;
 before_document jsonb; before_revision uuid; merge_plan jsonb;
 n integer; ix integer:=0; row_count integer; usable boolean; family text; changed boolean:=false;
 prompt source_fact_prompts%ROWTYPE; input_field text; input_value jsonb; context_number numeric;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active
  AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_FACT_DENIED'; END IF;
 IF p_op IS NULL OR p_op NOT IN('prepare','get','current','input','prompt','bind','reply','cancel_input',
  'map','save','accept','skip','reset','publisher','locator','preview','edit','cancel')
  THEN RAISE EXCEPTION 'SOURCE_FACT_OPERATION'; END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>1600000
  OR p_index IS NULL OR p_index NOT BETWEEN 0 AND 255 THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_op='input' THEN
  SELECT p.* INTO prompt FROM source_fact_prompts p JOIN source_fact_reviews r0 ON r0.id=p.review_id
   WHERE p.actor=p_actor AND r0.actor=p_actor AND p.expires_at>now() AND r0.expires_at>now()
    AND r0.revision=p.revision AND r0.phase='reviewing' FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'idle',true); END IF;
  SELECT * INTO r FROM source_fact_reviews WHERE id=prompt.review_id FOR UPDATE;
  p_index:=prompt.row_index;
 ELSIF p_op='current' THEN
  SELECT * INTO r FROM source_fact_reviews WHERE actor=p_actor ORDER BY
   (phase IN('reviewing','preview') AND expires_at>now()) DESC,created_at DESC,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'idle',true); END IF;
 ELSE
  SELECT * INTO r FROM source_fact_reviews WHERE id=p_id FOR UPDATE;
  IF FOUND AND r.actor<>p_actor THEN RAISE EXCEPTION 'SOURCE_FACT_NOT_FOUND'; END IF;
  IF NOT FOUND AND p_op<>'prepare' THEN RAISE EXCEPTION 'SOURCE_FACT_NOT_FOUND'; END IF;
 END IF;
 IF p_op='prepare' AND r.id IS NULL THEN
  IF p_id IS NULL OR p_payload->>'source_id' IS NULL
    OR p_payload->>'source_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
  SELECT * INTO src FROM product_document_sources WHERE id=(p_payload->>'source_id')::uuid AND actor=p_actor;
  IF NOT FOUND OR NOT mw_private.product_document_source_usable(src.id) THEN RAISE EXCEPTION 'SOURCE_FACT_SOURCE_STALE'; END IF;
  PERFORM 1 FROM products WHERE id=src.product_id FOR UPDATE;
  SELECT * INTO d FROM document_intakes WHERE id=src.document_id AND staff_telegram_id=p_actor;
  supplied:=p_payload->'result';family:=supplied->>'family_code';
  IF jsonb_typeof(supplied) IS DISTINCT FROM 'object'
   OR supplied->>'version' IS DISTINCT FROM 'source-candidates-v1'
   OR supplied->>'checksum' IS DISTINCT FROM d.checksum
   OR jsonb_typeof(supplied->'candidates') IS DISTINCT FROM 'array'
   OR jsonb_typeof(supplied->'unmatched_entries') IS DISTINCT FROM 'array'
   OR NOT EXISTS(SELECT 1 FROM technical_family_attributes WHERE family_code=family)
   THEN RAISE EXCEPTION 'SOURCE_FACT_RESULT'; END IF;
  row_count:=jsonb_array_length(supplied->'candidates')+jsonb_array_length(supplied->'unmatched_entries');
  IF row_count NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'SOURCE_FACT_EMPTY_OR_LIMIT'; END IF;
  UPDATE source_fact_reviews SET phase='expired',revision=revision+1
   WHERE actor=p_actor AND phase IN('reviewing','preview') AND expires_at<=now();
  IF EXISTS(SELECT 1 FROM source_fact_reviews WHERE actor=p_actor AND phase IN('reviewing','preview'))
   THEN RAISE EXCEPTION 'SOURCE_FACT_ACTIVE'; END IF;
  INSERT INTO source_fact_reviews(id,actor,source_id,product_id,family_code,model_context,base_version,extraction)
   VALUES(p_id,p_actor,src.id,src.product_id,family,src.model_context,
    coalesce((SELECT version FROM technical_cards WHERE product_id=src.product_id),0),supplied) RETURNING * INTO r;
  FOR v_proposal IN SELECT value FROM jsonb_array_elements((supplied->'candidates')||(supplied->'unmatched_entries')) LOOP
   IF jsonb_typeof(v_proposal) IS DISTINCT FROM 'object'
    OR NOT mw_private.source_fact_evidence_matches(d.extraction,v_proposal->'evidence')
    THEN RAISE EXCEPTION 'SOURCE_FACT_EVIDENCE'; END IF;
   IF ix<jsonb_array_length(supplied->'candidates') THEN
    SELECT a.* INTO selected_attribute FROM technical_attributes a JOIN technical_family_attributes f ON f.attribute_code=a.code
      WHERE f.family_code=family AND a.code=v_proposal->>'attribute_code';
    IF NOT FOUND OR v_proposal->>'unit_code' IS DISTINCT FROM selected_attribute.unit_code
     THEN RAISE EXCEPTION 'SOURCE_FACT_ATTRIBUTE'; END IF;
    INSERT INTO source_fact_rows(review_id,row_index,proposal,draft) VALUES(r.id,ix,v_proposal,
     jsonb_build_object('attribute_code',selected_attribute.code,'process',v_proposal->'process',
      'unit_code',selected_attribute.unit_code,'value',v_proposal->'value','context','{}'::jsonb));
   ELSE
    INSERT INTO source_fact_rows(review_id,row_index,proposal) VALUES(r.id,ix,v_proposal);
   END IF;
   ix:=ix+1;
  END LOOP;
  changed:=true;
 ELSIF p_op='prepare' THEN
  IF p_payload->>'source_id' IS DISTINCT FROM r.source_id::text
   OR p_payload->'result'->>'family_code' IS DISTINCT FROM r.family_code
   THEN RAISE EXCEPTION 'SOURCE_FACT_REQUEST_MISMATCH'; END IF;
 END IF;
 SELECT * INTO src FROM product_document_sources WHERE id=r.source_id AND actor=p_actor;
 SELECT * INTO d FROM document_intakes WHERE id=src.document_id AND staff_telegram_id=p_actor;
 PERFORM 1 FROM products WHERE id=r.product_id FOR UPDATE;
 current_model:=mw_private.technical_model_context(r.product_id);
 usable:=mw_private.product_document_source_usable(src.id) AND r.model_context=current_model
  AND r.base_version=coalesce((SELECT version FROM technical_cards WHERE product_id=r.product_id),0);
 IF p_op NOT IN('prepare','get','current','input') THEN
  IF p_op='cancel' AND r.phase='canceled' THEN NULL;
  ELSE
   IF p_revision IS NULL OR p_revision<>r.revision THEN RAISE EXCEPTION 'SOURCE_FACT_STALE_BUTTON'; END IF;
   IF r.phase NOT IN('reviewing','preview') OR (r.expires_at<=now() AND p_op NOT IN('cancel','cancel_input'))
    THEN RAISE EXCEPTION 'SOURCE_FACT_EXPIRED'; END IF;
   IF NOT usable AND p_op NOT IN('cancel','cancel_input') THEN RAISE EXCEPTION 'SOURCE_FACT_SOURCE_STALE'; END IF;
   IF p_op NOT IN('cancel','edit') AND r.phase<>'reviewing' THEN RAISE EXCEPTION 'SOURCE_FACT_NOT_EDITING'; END IF;
   IF p_op IN('map','save','accept','skip','reset','locator','prompt','bind','reply','cancel_input') THEN
    SELECT * INTO line FROM source_fact_rows WHERE review_id=r.id AND row_index=p_index FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_FACT_ROW'; END IF;
   END IF;
   IF p_op IN('bind','reply','cancel_input') THEN
    SELECT * INTO prompt FROM source_fact_prompts WHERE actor=p_actor AND review_id=r.id FOR UPDATE;
    IF NOT FOUND OR prompt.revision<>r.revision OR prompt.row_index<>p_index
      OR (prompt.expires_at<=now() AND p_op<>'cancel_input')
     THEN RAISE EXCEPTION 'SOURCE_FACT_QUESTION_STALE'; END IF;
   END IF;
   IF p_op='prompt' THEN
    input_field:=p_payload->>'field';
    IF input_field IS NULL OR input_field NOT IN('value','publisher','locator','current_a','temperature_c','pressure_bar',
      'gas','cooling','duty_pct','material','diameter_mm') OR p_payload-'field'<>'{}'::jsonb
     THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
    IF input_field NOT IN('publisher','locator') AND line.draft IS NULL
     THEN RAISE EXCEPTION 'SOURCE_FACT_ATTRIBUTE'; END IF;
    -- Choosing to correct a row withdraws its approval even if the next message never arrives.
    IF input_field<>'publisher' THEN
     UPDATE source_fact_rows SET decision='pending',decided_at=NULL WHERE review_id=r.id AND row_index=p_index;
    END IF;
   ELSIF p_op='bind' THEN
    IF p_payload-'message_id'<>'{}'::jsonb OR jsonb_typeof(p_payload->'message_id') IS DISTINCT FROM 'number'
      OR p_payload->>'message_id' !~ '^[1-9][0-9]{0,15}$'
     THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
    IF prompt.message_id IS NOT NULL AND prompt.message_id<>(p_payload->>'message_id')::bigint
     THEN RAISE EXCEPTION 'SOURCE_FACT_QUESTION_BOUND'; END IF;
    IF prompt.message_id IS NULL THEN
     UPDATE source_fact_prompts SET message_id=(p_payload->>'message_id')::bigint WHERE actor=p_actor;
     changed:=true;
    END IF;
   ELSIF p_op='reply' THEN
    IF p_payload-ARRAY['reply_to','value']<>'{}'::jsonb
      OR jsonb_typeof(p_payload->'reply_to') IS DISTINCT FROM 'number'
      OR p_payload->>'reply_to' !~ '^[1-9][0-9]{0,15}$'
      OR NOT p_payload ? 'value' OR octet_length(p_payload::text)>8192
     THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
    IF prompt.message_id IS NULL OR prompt.message_id<>(p_payload->>'reply_to')::bigint
     THEN RAISE EXCEPTION 'SOURCE_FACT_WRONG_QUESTION'; END IF;
    -- Rights may have been revoked and restored while another editor started.
    IF EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=p_actor AND consumed_at IS NULL AND expires_at>now())
     OR EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=p_actor AND phase IN('editing','preview') AND expires_at>now())
     OR EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=p_actor AND expires_at>now())
     THEN RAISE EXCEPTION 'SOURCE_FACT_OTHER_INPUT'; END IF;
    input_value:=p_payload->'value';input_field:=prompt.field;
    IF input_field IN('publisher','locator') THEN
     IF jsonb_typeof(input_value) IS DISTINCT FROM 'string' OR length(btrim(input_value#>>'{}')) NOT BETWEEN 1 AND 1000
      THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
     IF input_field='publisher' THEN
      UPDATE source_fact_reviews SET publisher=btrim(input_value#>>'{}') WHERE id=r.id;
     ELSE
      UPDATE source_fact_rows SET locator_override=btrim(input_value#>>'{}'),decision='pending',decided_at=NULL
       WHERE review_id=r.id AND row_index=p_index;
     END IF;
    ELSE
     IF line.draft IS NULL THEN RAISE EXCEPTION 'SOURCE_FACT_ATTRIBUTE'; END IF;
     IF input_field='value' THEN
      IF jsonb_typeof(input_value) NOT IN('string','number','boolean','array') THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
      supplied:=jsonb_set(line.draft,'{value}',input_value);
     ELSE
      IF input_field IN('gas','cooling','material') THEN
       IF jsonb_typeof(input_value) IS DISTINCT FROM 'string' OR length(btrim(input_value#>>'{}')) NOT BETWEEN 1 AND 120
        OR (input_field='cooling' AND input_value#>>'{}' NOT IN('air','liquid'))
        THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
      ELSE
       IF jsonb_typeof(input_value) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
       context_number:=(input_value#>>'{}')::numeric;
       IF context_number NOT BETWEEN -100 AND 1000000 OR (input_field<>'temperature_c' AND context_number<0)
        OR (input_field='duty_pct' AND context_number>100)
        OR (input_field IN('pressure_bar','diameter_mm') AND context_number<=0)
        THEN RAISE EXCEPTION 'TECH_BAD_CONTEXT'; END IF;
      END IF;
      supplied:=jsonb_set(line.draft,ARRAY['context',input_field],input_value);
     END IF;
     IF octet_length(supplied::text)>8192 THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
     -- Partial drafts may still lack conditions. Acceptance always runs the full canonical validator.
     UPDATE source_fact_rows SET draft=supplied,decision='pending',decided_at=NULL
      WHERE review_id=r.id AND row_index=p_index;
    END IF;
   ELSIF p_op='cancel_input' THEN
    NULL; -- Keep recorded corrections and pending decisions; only end this question.
   ELSIF p_op='map' THEN
    SELECT a.* INTO selected_attribute FROM technical_attributes a JOIN technical_family_attributes f ON f.attribute_code=a.code
     WHERE f.family_code=r.family_code AND a.code=p_payload->>'attribute_code';
    IF NOT FOUND OR p_payload->>'process' IS NULL OR NOT (p_payload->>'process')=ANY(selected_attribute.processes)
     THEN RAISE EXCEPTION 'SOURCE_FACT_ATTRIBUTE'; END IF;
    UPDATE source_fact_rows SET draft=jsonb_build_object('attribute_code',selected_attribute.code,
     'process',p_payload->>'process','unit_code',selected_attribute.unit_code,'value',NULL,'context','{}'::jsonb),
     decision='pending',decided_at=NULL WHERE review_id=r.id AND row_index=p_index;
   ELSIF p_op='save' THEN
    supplied:=p_payload->'draft';
    IF jsonb_typeof(supplied) IS DISTINCT FROM 'object'
     OR supplied-ARRAY['attribute_code','process','unit_code','value','context']<>'{}'::jsonb
     OR octet_length(supplied::text)>8192
     OR jsonb_typeof(supplied->'context') IS DISTINCT FROM 'object'
     OR NOT supplied ? 'value' THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
    SELECT a.* INTO selected_attribute FROM technical_attributes a JOIN technical_family_attributes f ON f.attribute_code=a.code
     WHERE f.family_code=r.family_code AND a.code=supplied->>'attribute_code';
    IF NOT FOUND OR supplied->>'process' IS NULL OR NOT (supplied->>'process')=ANY(selected_attribute.processes)
     OR supplied->>'unit_code' IS DISTINCT FROM selected_attribute.unit_code THEN RAISE EXCEPTION 'SOURCE_FACT_ATTRIBUTE'; END IF;
    UPDATE source_fact_rows SET draft=supplied,decision='pending',decided_at=NULL WHERE review_id=r.id AND row_index=p_index;
   ELSIF p_op='accept' THEN
    IF coalesce(line.locator_override,line.proposal->'evidence'->>'locator','')=''
      OR (coalesce(line.proposal->'issues','[]'::jsonb) ? 'locator_review' AND line.locator_override IS NULL)
     THEN RAISE EXCEPTION 'SOURCE_FACT_LOCATOR_REQUIRED'; END IF;
    PERFORM mw_private.source_fact_validate_value(r.family_code,line.draft);
    UPDATE source_fact_rows SET decision='accepted',decided_at=now() WHERE review_id=r.id AND row_index=p_index;
   ELSIF p_op IN('skip','reset') THEN
    UPDATE source_fact_rows SET decision=CASE WHEN p_op='skip' THEN 'skipped' ELSE 'pending' END,
     decided_at=CASE WHEN p_op='skip' THEN now() END WHERE review_id=r.id AND row_index=p_index;
   ELSIF p_op='locator' THEN
    IF jsonb_typeof(p_payload->'text') IS DISTINCT FROM 'string' OR length(btrim(p_payload->>'text')) NOT BETWEEN 1 AND 1000
     THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
    UPDATE source_fact_rows SET locator_override=btrim(p_payload->>'text'),decision='pending',decided_at=NULL
     WHERE review_id=r.id AND row_index=p_index;
   ELSIF p_op='publisher' THEN
    IF jsonb_typeof(p_payload->'text') IS DISTINCT FROM 'string' OR length(btrim(p_payload->>'text')) NOT BETWEEN 1 AND 1000
     THEN RAISE EXCEPTION 'SOURCE_FACT_INPUT'; END IF;
    UPDATE source_fact_reviews SET publisher=btrim(p_payload->>'text') WHERE id=r.id;
   ELSIF p_op='preview' THEN
    IF r.publisher IS NULL THEN RAISE EXCEPTION 'SOURCE_FACT_PUBLISHER_REQUIRED'; END IF;
    IF EXISTS(SELECT 1 FROM source_fact_rows WHERE review_id=r.id AND decision='pending')
      THEN RAISE EXCEPTION 'SOURCE_FACT_DECISIONS_REQUIRED'; END IF;
    SELECT count(*) INTO n FROM source_fact_rows WHERE review_id=r.id AND decision='accepted';
    IF n NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'SOURCE_FACT_ACCEPTED_LIMIT'; END IF;
    SELECT count(DISTINCT coalesce(locator_override,proposal->'evidence'->>'locator')) INTO n
     FROM source_fact_rows WHERE review_id=r.id AND decision='accepted';
    IF n>32 THEN RAISE EXCEPTION 'SOURCE_FACT_SOURCE_LIMIT'; END IF;
    -- Multiple quotes on one page share the public source; private row evidence stays separate.
    SELECT jsonb_agg(i.draft||jsonb_build_object('state','known','source_key','document_'||
      (SELECT min(j.row_index) FROM source_fact_rows j WHERE j.review_id=r.id AND j.decision='accepted'
       AND coalesce(j.locator_override,j.proposal->'evidence'->>'locator')=
           coalesce(i.locator_override,i.proposal->'evidence'->>'locator'))) ORDER BY i.row_index)
     INTO accepted_values FROM source_fact_rows i WHERE i.review_id=r.id AND i.decision='accepted';
    SELECT jsonb_agg(jsonb_build_object('key','document_'||q.source_index,'kind',src.source_kind,'publisher',r.publisher,
     'model',r.model_context->'identity'->>'model','title',d.file_name,'url','','sha256',d.checksum,
     'locator',q.locator,'checked_on',current_date::text) ORDER BY q.source_index)
     INTO source_values FROM (SELECT min(i.row_index) source_index,
       coalesce(i.locator_override,i.proposal->'evidence'->>'locator') locator
       FROM source_fact_rows i WHERE i.review_id=r.id AND i.decision='accepted'
       GROUP BY coalesce(i.locator_override,i.proposal->'evidence'->>'locator')) q;
    result_document:=jsonb_build_object('family_code',r.family_code,'sources',source_values,'values',accepted_values);
    PERFORM validate_technical_document(result_document,'pending_review');
    SELECT c.published_revision,t.document INTO before_revision,before_document
     FROM technical_cards c LEFT JOIN technical_revisions t ON t.id=c.published_revision
     WHERE c.product_id=r.product_id;
    IF NOT mw_private.technical_revision_model_matches(before_revision,r.product_id)
     THEN RAISE EXCEPTION 'SOURCE_FACT_PREVIOUS_MODEL_STALE'; END IF;
    merge_plan:=mw_private.source_fact_merge_preview(before_document,result_document,r.id);
    UPDATE source_fact_reviews SET phase='preview',preview_expires_at=now()+interval '15 minutes',
     prepared_document=result_document,merge_preview=merge_plan||jsonb_build_object('before_revision',before_revision)
     WHERE id=r.id;
   ELSIF p_op='edit' THEN
    IF r.phase<>'preview' THEN RAISE EXCEPTION 'SOURCE_FACT_NOT_PREVIEW'; END IF;
    UPDATE source_fact_reviews SET phase='reviewing',preview_expires_at=NULL,prepared_document=NULL,merge_preview=NULL WHERE id=r.id;
   ELSIF p_op='cancel' THEN
    UPDATE source_fact_reviews SET phase='canceled',preview_expires_at=NULL,prepared_document=NULL,merge_preview=NULL WHERE id=r.id;
   END IF;
   IF p_op<>'bind' THEN
    DELETE FROM source_fact_prompts WHERE actor=p_actor AND review_id=r.id;
    UPDATE source_fact_reviews SET revision=revision+1 WHERE id=r.id RETURNING * INTO r;
    IF p_op='prompt' THEN
     INSERT INTO source_fact_prompts(actor,review_id,revision,row_index,field,expires_at)
      VALUES(p_actor,r.id,r.revision,p_index,input_field,r.expires_at)
      ON CONFLICT(actor) DO UPDATE SET review_id=excluded.review_id,revision=excluded.revision,
       row_index=excluded.row_index,field=excluded.field,message_id=NULL,expires_at=excluded.expires_at;
    END IF;
    changed:=true;
   END IF;
  END IF;
 END IF;
 IF changed THEN
  INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'source_fact_'||p_op,
   jsonb_build_object('review_id',r.id,'source_id',r.source_id,'revision',r.revision,'row',p_index));
 END IF;
 SELECT jsonb_build_object('total',count(*),'pending',count(*) FILTER(WHERE decision='pending'),
  'accepted',count(*) FILTER(WHERE decision='accepted'),'skipped',count(*) FILTER(WHERE decision='skipped'))
  INTO counts FROM source_fact_rows WHERE review_id=r.id;
 SELECT jsonb_agg(to_jsonb(q) ORDER BY q.row_index) INTO all_rows FROM (
  SELECT row_index,proposal,draft,decision,locator_override FROM source_fact_rows WHERE review_id=r.id
   ORDER BY row_index LIMIT 8 OFFSET (p_index/8)*8) q;
 SELECT * INTO line FROM source_fact_rows WHERE review_id=r.id AND row_index=p_index;
 SELECT * INTO prompt FROM source_fact_prompts WHERE actor=p_actor AND review_id=r.id AND revision=r.revision
  AND expires_at>now() AND r.phase='reviewing';
 RETURN jsonb_build_object('ok',true,'idle',false,'review',to_jsonb(r)-'extraction',
  'source_review_id',src.review_id,'file_name',d.file_name,'source_kind',src.source_kind,
  'document_id',d.id,'document_checksum',src.document_checksum,
  'product_title',(SELECT title FROM products WHERE id=r.product_id),
  'usable',coalesce(usable,false),'counts',counts,'rows',coalesce(all_rows,'[]'::jsonb),
  'row',CASE WHEN line.review_id IS NOT NULL THEN to_jsonb(line) END,
  'next_pending',(SELECT row_index FROM source_fact_rows WHERE review_id=r.id AND decision='pending'
    ORDER BY (row_index>p_index) DESC,row_index LIMIT 1),
  'missing_fields',r.extraction->'fields_without_candidates','warnings',r.extraction->'warnings',
  'current_model',current_model,'prompt',CASE WHEN prompt.actor IS NOT NULL THEN to_jsonb(prompt) END);
END $review$;
REVOKE ALL ON FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb) TO service_role;
