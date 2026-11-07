-- Work in progress. No live installation until atomic handoff and its acceptance checks are ready.
-- Private per-fact provenance survives editing, revision cloning and source-key renaming.
CREATE TABLE public.technical_fact_origins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 product_id uuid NOT NULL REFERENCES public.products(id),
 source_id uuid NOT NULL REFERENCES public.product_document_sources(id),
 review_id uuid NOT NULL,
 row_index integer NOT NULL,
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=12000),
 original_fact jsonb NOT NULL CHECK(jsonb_typeof(original_fact)='object' AND octet_length(original_fact::text)<=24000),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(review_id,row_index) REFERENCES public.source_fact_rows(review_id,row_index),
 UNIQUE(review_id,row_index)
);
ALTER TABLE public.technical_fact_origins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.technical_fact_origins FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION mw_private.technical_origin_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r source_fact_reviews%ROWTYPE; item source_fact_rows%ROWTYPE; snapshot jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TECH_ORIGIN_IMMUTABLE'; END IF;
 SELECT * INTO r FROM source_fact_reviews WHERE id=NEW.review_id;
 SELECT * INTO item FROM source_fact_rows WHERE review_id=NEW.review_id AND row_index=NEW.row_index;
 SELECT value-'key' INTO snapshot FROM jsonb_array_elements(r.prepared_document->'sources')
  WHERE value->>'key'=NEW.original_fact->>'source_key';
 IF r.phase IS DISTINCT FROM 'preview' OR r.expires_at<=now() OR r.preview_expires_at IS NULL OR r.preview_expires_at<=now()
  OR r.product_id IS DISTINCT FROM NEW.product_id OR r.source_id IS DISTINCT FROM NEW.source_id
  OR item.decision IS DISTINCT FROM 'accepted' OR NEW.original_fact->>'state' IS DISTINCT FROM 'known'
  OR NEW.original_fact-ARRAY['state','source_key'] IS DISTINCT FROM item.draft
  OR snapshot IS DISTINCT FROM NEW.source_snapshot
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.prepared_document->'values') v WHERE v=NEW.original_fact)
  OR NOT mw_private.product_document_source_usable(NEW.source_id)
  OR r.base_version IS DISTINCT FROM coalesce((SELECT version FROM technical_cards WHERE product_id=NEW.product_id),0)
 THEN RAISE EXCEPTION 'TECH_ORIGIN_INVALID'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mw_private.technical_origin_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER technical_origin_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.technical_fact_origins
 FOR EACH ROW EXECUTE FUNCTION mw_private.technical_origin_immutable();

ALTER FUNCTION public.validate_technical_document(jsonb,text) RENAME TO validate_technical_document_before_origins;
ALTER FUNCTION public.validate_technical_document_before_origins(jsonb,text) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.validate_technical_document_before_origins(jsonb,text)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.validate_technical_document(p_document jsonb,p_review_state text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; values_without_origins jsonb:='[]'; seen text[]:='{}';
BEGIN
 IF p_document IS NULL OR jsonb_typeof(p_document->'values') IS DISTINCT FROM 'array'
   OR octet_length(p_document::text)>131072 THEN RAISE EXCEPTION 'TECH_BAD_DOCUMENT'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_document->'values') LOOP
  IF item ? 'origin_ref' THEN
   IF jsonb_typeof(item->'origin_ref') IS DISTINCT FROM 'string'
    OR item->>'origin_ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR item->>'state' IS DISTINCT FROM 'known' OR (item->>'origin_ref')=ANY(seen)
    THEN RAISE EXCEPTION 'TECH_ORIGIN_INVALID'; END IF;
   seen:=array_append(seen,item->>'origin_ref');
  END IF;
  values_without_origins:=values_without_origins||jsonb_build_array(item-'origin_ref');
 END LOOP;
 PERFORM mw_private.validate_technical_document_before_origins(
  jsonb_set(p_document,'{values}',values_without_origins),p_review_state);
END $$;
REVOKE ALL ON FUNCTION public.validate_technical_document(jsonb,text)
 FROM PUBLIC,anon,authenticated,service_role;

-- Reading cannot raise an exception or leak private source IDs: it reports a bounded status.
-- p_require_live=false permits removing a stale fact while preserving the remaining draft.
CREATE FUNCTION mw_private.technical_origin_status(p_document jsonb,p_product uuid,p_require_live boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fact jsonb; source jsonb; origin technical_fact_origins%ROWTYPE;
 total integer:=0; unavailable integer:=0; valid boolean; seen text[]:='{}';
BEGIN
 IF p_document IS NULL OR p_document='null'::jsonb THEN
  RETURN jsonb_build_object('usable',true,'total',0,'unavailable',0);
 END IF;
 IF jsonb_typeof(p_document->'values') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p_document->'sources') IS DISTINCT FROM 'array'
  THEN RETURN jsonb_build_object('usable',false,'total',0,'unavailable',0); END IF;
 FOR fact IN SELECT value FROM jsonb_array_elements(p_document->'values') WHERE value ? 'origin_ref' LOOP
  total:=total+1;
  SELECT * INTO origin FROM technical_fact_origins WHERE id=CASE
   WHEN jsonb_typeof(fact->'origin_ref')='string'
    AND fact->>'origin_ref' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   THEN (fact->>'origin_ref')::uuid END;
  valid:=FOUND AND fact->>'state'='known' AND origin.product_id=p_product
   AND NOT coalesce((fact->>'origin_ref')=ANY(seen),true);
  seen:=array_append(seen,fact->>'origin_ref');
  SELECT value INTO source FROM jsonb_array_elements(p_document->'sources')
   WHERE value->>'key'=fact->>'source_key';
  valid:=valid AND FOUND AND source-'key'=origin.source_snapshot;
  valid:=valid AND EXISTS(
   SELECT 1 FROM source_fact_reviews r JOIN product_document_sources s ON s.id=r.source_id
    WHERE r.id=origin.review_id AND r.phase='handed' AND s.id=origin.source_id AND r.product_id=p_product
     AND s.product_id=p_product AND s.document_checksum=origin.source_snapshot->>'sha256'
     AND r.model_context->'identity'->>'model'=origin.source_snapshot->>'model');
  IF p_require_live THEN valid:=valid AND mw_private.product_document_source_usable(origin.source_id); END IF;
  IF valid IS DISTINCT FROM true THEN unavailable:=unavailable+1; END IF;
 END LOOP;
 RETURN jsonb_build_object('usable',unavailable=0,'total',total,'unavailable',unavailable);
END $$;
REVOKE ALL ON FUNCTION mw_private.technical_origin_status(jsonb,uuid,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

-- Losing a provenance reference must be an explicit removal/retraction, never an implicit
-- replacement with untracked known facts. A separate later manual review can add a new fact.
CREATE FUNCTION mw_private.technical_origin_transition(p_before jsonb,p_after jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE removed boolean;
BEGIN
 IF p_after IS NOT NULL AND p_after<>'null'::jsonb AND jsonb_typeof(p_after->'values') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'TECH_ORIGIN_INVALID'; END IF;
 SELECT EXISTS(
  SELECT 1 FROM jsonb_array_elements(coalesce(nullif(p_before,'null')->'values','[]')) old
   WHERE old ? 'origin_ref' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(coalesce(nullif(p_after,'null')->'values','[]')) new
     WHERE new->>'origin_ref'=old->>'origin_ref')) INTO removed;
 IF removed AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(coalesce(nullif(p_after,'null')->'values','[]')) new
   WHERE new->>'state'='known' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(coalesce(nullif(p_before,'null')->'values','[]')) old WHERE old=new))
  THEN RAISE EXCEPTION 'TECH_ORIGIN_REMOVED'; END IF;
END $$;
REVOKE ALL ON FUNCTION mw_private.technical_origin_transition(jsonb,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION mw_private.technical_revision_origins_usable(p_revision uuid,p_product uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p_revision IS NULL OR coalesce((SELECT (mw_private.technical_origin_status(r.document,p_product)->>'usable')::boolean
  FROM technical_revisions r WHERE r.id=p_revision AND r.product_id=p_product),false)
$$;
REVOKE ALL ON FUNCTION mw_private.technical_revision_origins_usable(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb)
 RENAME TO bot_technical_catalog_before_origins;
ALTER FUNCTION public.bot_technical_catalog_before_origins(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_technical_catalog_before_origins(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.bot_technical_catalog(
 p_staff_telegram_id bigint,p_op text,p_product_id uuid DEFAULT NULL,p_change_id uuid DEFAULT NULL,
 p_document jsonb DEFAULT NULL,p_review_state text DEFAULT 'pending_review',p_expected_version bigint DEFAULT NULL,
 p_expected_model jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; b technical_changes%ROWTYPE; published uuid; previous_document jsonb; source_status jsonb;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_staff_telegram_id AND active
  AND(role::text IN('admin','seller') OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TECH_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_op IN('apply','undo') THEN
  SELECT * INTO b FROM technical_changes WHERE id=p_change_id AND staff_telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TECH_CHANGE_NOT_FOUND'; END IF;
  p_product_id:=b.product_id;
 END IF;
 PERFORM 1 FROM products WHERE id=p_product_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TECH_PRODUCT_NOT_FOUND'; END IF;
 SELECT c.published_revision,r.document INTO published,previous_document
  FROM technical_cards c LEFT JOIN technical_revisions r ON r.id=c.published_revision WHERE c.product_id=p_product_id;
 IF p_op='preview' THEN
  PERFORM validate_technical_document(p_document,p_review_state);
  IF NOT (mw_private.technical_origin_status(p_document,p_product_id)->>'usable')::boolean
   THEN RAISE EXCEPTION 'TECH_SOURCE_REVIEW_REQUIRED'; END IF;
  -- A saved, owned editor draft has already passed incremental transition checks.
  -- Exact equality prevents a direct caller from borrowing a different draft's authorization.
  IF NOT EXISTS(SELECT 1 FROM technical_editor_sessions e JOIN technical_editor_models m ON m.session_id=e.id
    WHERE e.staff_telegram_id=p_staff_telegram_id AND e.product_id=p_product_id AND e.phase='editing'
     AND e.expires_at>now() AND e.base_version=p_expected_version AND e.data->'document'=p_document
     AND m.context=p_expected_model)
   THEN PERFORM mw_private.technical_origin_transition(previous_document,p_document); END IF;
 ELSIF (p_op='apply' AND b.state='preview') OR (p_op='undo' AND b.state='applied') THEN
  IF NOT (mw_private.technical_origin_status(b.document,p_product_id)->>'usable')::boolean
   THEN RAISE EXCEPTION 'TECH_SOURCE_REVIEW_REQUIRED'; END IF;
  IF p_op='undo' AND NOT mw_private.technical_revision_origins_usable(b.before_published_revision,p_product_id)
   THEN RAISE EXCEPTION 'TECH_SOURCE_UNDO_REVIEW'; END IF;
 END IF;
 -- Completed apply/undo receipts remain readable even after a source is withdrawn.
 result:=mw_private.bot_technical_catalog_before_origins(p_staff_telegram_id,p_op,p_product_id,p_change_id,
  p_document,p_review_state,p_expected_version,p_expected_model);
 IF p_op='read' THEN
  source_status:=mw_private.technical_origin_status(previous_document,p_product_id);
  result:=jsonb_set(result,'{card,source_review}',source_status||jsonb_build_object(
   'required',NOT (source_status->>'usable')::boolean,'previous_revision',published));
  IF NOT (source_status->>'usable')::boolean THEN
   result:=jsonb_set(jsonb_set(result,'{card,published}','null'),'{card,published_revision}','null');
  END IF;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb) TO service_role;

ALTER FUNCTION public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint)
 RENAME TO bot_technical_editor_before_origins;
ALTER FUNCTION public.bot_technical_editor_before_origins(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_technical_editor_before_origins(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.bot_technical_editor(
 p_staff_telegram_id bigint,p_op text,p_session_id uuid DEFAULT NULL,p_revision integer DEFAULT NULL,
 p_product_id uuid DEFAULT NULL,p_source_revision uuid DEFAULT NULL,p_data jsonb DEFAULT NULL,
 p_review_state text DEFAULT 'pending_review',p_prompt_message_id bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; e technical_editor_sessions%ROWTYPE;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_staff_telegram_id AND active
  AND(role::text IN('admin','seller') OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TECH_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_op='save' THEN
  SELECT * INTO e FROM technical_editor_sessions WHERE id=p_session_id AND staff_telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TECH_EDITOR_NOT_FOUND'; END IF;
  IF p_revision IS NULL OR p_revision<>e.revision THEN RAISE EXCEPTION 'TECH_EDITOR_STALE'; END IF;
  IF e.phase<>'editing' OR e.expires_at<=now() THEN RAISE EXCEPTION 'TECH_EDITOR_EXPIRED'; END IF;
  PERFORM mw_private.technical_origin_transition(e.data->'document',p_data->'document');
  IF NOT (mw_private.technical_origin_status(p_data->'document',e.product_id,false)->>'usable')::boolean
   THEN RAISE EXCEPTION 'TECH_ORIGIN_INVALID'; END IF;
 END IF;
 result:=mw_private.bot_technical_editor_before_origins(p_staff_telegram_id,p_op,p_session_id,p_revision,
  p_product_id,p_source_revision,p_data,p_review_state,p_prompt_message_id);
 IF result->'session' IS NOT NULL AND result->'session'<>'null'::jsonb THEN
  SELECT * INTO e FROM technical_editor_sessions WHERE id=(result->'session'->>'id')::uuid;
  result:=jsonb_set(result,'{session,source_binding}',mw_private.technical_origin_status(e.data->'document',e.product_id));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint) TO service_role;

ALTER FUNCTION public.public_product_technical(uuid) RENAME TO public_product_technical_before_origins;
ALTER FUNCTION public.public_product_technical_before_origins(uuid) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.public_product_technical_before_origins(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.public_product_technical(p_product_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT mw_private.public_product_technical_before_origins(p_product_id)
 WHERE mw_private.technical_revision_origins_usable(
  (SELECT published_revision FROM technical_cards WHERE product_id=p_product_id),p_product_id)
$$;
REVOKE ALL ON FUNCTION public.public_product_technical(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_product_technical(uuid) TO anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
