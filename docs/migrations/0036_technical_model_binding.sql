-- Freeze the human model choice alongside new technical drafts and changes.
-- Originals and historical revisions are not rewritten or retroactively declared model-verified.
CREATE TABLE public.technical_editor_models (
 session_id uuid PRIMARY KEY REFERENCES public.technical_editor_sessions(id),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object')
);
CREATE TABLE public.technical_change_models (
 change_id uuid PRIMARY KEY REFERENCES public.technical_changes(id),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object')
);
ALTER TABLE public.technical_editor_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.technical_change_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.technical_editor_models,public.technical_change_models FROM PUBLIC,anon,authenticated,service_role;

-- Monotonic source generation prevents import undo from silently restoring old facts.
CREATE TABLE public.technical_model_generations (
 product_id uuid PRIMARY KEY REFERENCES public.products(id),
 version bigint NOT NULL CHECK(version>0)
);
ALTER TABLE public.technical_model_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.technical_model_generations FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION mw_private.technical_model_source_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='catalog_imports' THEN
  IF (OLD.state IN('applied','undo_preview')) IS NOT DISTINCT FROM (NEW.state IN('applied','undo_preview'))
   THEN RETURN NEW; END IF;
  FOR target IN SELECT DISTINCT product_id FROM document_import_model_links WHERE batch_id=NEW.id AND product_id IS NOT NULL LOOP
   INSERT INTO technical_model_generations(product_id,version) VALUES(target,1)
    ON CONFLICT(product_id) DO UPDATE SET version=technical_model_generations.version+1;
  END LOOP;
 ELSE
  IF TG_OP='UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN RETURN NEW; END IF;
  FOR target IN SELECT DISTINCT v FROM unnest(ARRAY[
   CASE WHEN TG_OP<>'INSERT' THEN OLD.product_id END,
   CASE WHEN TG_OP<>'DELETE' THEN NEW.product_id END]) v WHERE v IS NOT NULL LOOP
   INSERT INTO technical_model_generations(product_id,version) VALUES(target,1)
    ON CONFLICT(product_id) DO UPDATE SET version=technical_model_generations.version+1;
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mw_private.technical_model_source_changed() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER technical_model_source_links AFTER INSERT OR UPDATE OR DELETE ON public.document_import_model_links
 FOR EACH ROW EXECUTE FUNCTION mw_private.technical_model_source_changed();
CREATE TRIGGER technical_model_source_import AFTER UPDATE OF state ON public.catalog_imports
 FOR EACH ROW EXECUTE FUNCTION mw_private.technical_model_source_changed();

CREATE FUNCTION mw_private.technical_model_context(p_product uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (mw_private.product_model_choice_current(p_product)-'selected_at') || jsonb_build_object('sources_version',
  coalesce((SELECT version FROM technical_model_generations WHERE product_id=p_product),0))
$$;
CREATE FUNCTION mw_private.technical_revision_model_matches(p_revision uuid,p_product uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved jsonb; current_model jsonb;
BEGIN
 IF p_revision IS NULL THEN RETURN true; END IF;
 current_model:=mw_private.technical_model_context(p_product);
 SELECT m.context INTO saved FROM technical_changes c JOIN technical_change_models m ON m.change_id=c.id
  WHERE c.after_revision=p_revision AND c.product_id=p_product;
 -- Old unbound revisions remain historical. Once a choice exists, recheck them explicitly.
 IF NOT FOUND THEN RETURN current_model->>'state'='unselected'; END IF;
 RETURN saved=current_model AND current_model->>'state' NOT IN('stale','excluded');
END $$;
REVOKE ALL ON FUNCTION mw_private.technical_model_context(uuid),mw_private.technical_revision_model_matches(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint)
 RENAME TO bot_technical_catalog_before_model;
ALTER FUNCTION public.bot_technical_catalog_before_model(bigint,text,uuid,uuid,jsonb,text,bigint) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_technical_catalog_before_model(bigint,text,uuid,uuid,jsonb,text,bigint)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_technical_catalog(
 p_staff_telegram_id bigint,p_op text,p_product_id uuid DEFAULT NULL,p_change_id uuid DEFAULT NULL,
 p_document jsonb DEFAULT NULL,p_review_state text DEFAULT 'pending_review',p_expected_version bigint DEFAULT NULL,
 p_expected_model jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; b technical_changes%ROWTYPE; current_model jsonb; saved jsonb; published uuid;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_staff_telegram_id AND active
  AND(role::text IN('admin','seller') OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TECH_DENIED'; END IF;
 -- Same ordering as document import/model choice. Recheck evidence after acquiring the lock.
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_op IN('apply','undo') THEN
  SELECT * INTO b FROM technical_changes WHERE id=p_change_id AND staff_telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TECH_CHANGE_NOT_FOUND'; END IF;
  p_product_id:=b.product_id;
 END IF;
 PERFORM 1 FROM products WHERE id=p_product_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TECH_PRODUCT_NOT_FOUND'; END IF;
 current_model:=mw_private.technical_model_context(p_product_id);
 IF p_op='preview' THEN
  IF p_expected_model IS NULL THEN RAISE EXCEPTION 'TECH_MODEL_CONTEXT_REQUIRED'; END IF;
  IF p_expected_model IS DISTINCT FROM current_model THEN RAISE EXCEPTION 'TECH_MODEL_CHANGED'; END IF;
  IF p_review_state='verified' AND current_model->>'state' IN('stale','excluded')
   THEN RAISE EXCEPTION 'TECH_MODEL_REVIEW_REQUIRED'; END IF;
 ELSIF (p_op='apply' AND b.state='preview') OR (p_op='undo' AND b.state='applied') THEN
  SELECT context INTO saved FROM technical_change_models WHERE change_id=b.id;
  IF FOUND THEN
   IF saved IS DISTINCT FROM current_model THEN RAISE EXCEPTION 'TECH_MODEL_CHANGED'; END IF;
   IF b.review_state='verified' AND current_model->>'state' IN('stale','excluded')
    THEN RAISE EXCEPTION 'TECH_MODEL_REVIEW_REQUIRED'; END IF;
  ELSIF current_model->>'state'<>'unselected' THEN RAISE EXCEPTION 'TECH_MODEL_CONTEXT_REQUIRED';
  END IF;
  IF p_op='undo' AND NOT mw_private.technical_revision_model_matches(b.before_published_revision,b.product_id)
   THEN RAISE EXCEPTION 'TECH_MODEL_UNDO_REVIEW'; END IF;
 END IF;
 result:=mw_private.bot_technical_catalog_before_model(p_staff_telegram_id,p_op,p_product_id,p_change_id,
  p_document,p_review_state,p_expected_version);
 IF p_op='preview' THEN
  INSERT INTO technical_change_models(change_id,context) VALUES((result->>'change_id')::uuid,current_model);
  result:=result||jsonb_build_object('model_context',current_model);
 ELSIF p_op='read' THEN
  published:=(result->'card'->>'published_revision')::uuid;
  result:=jsonb_set(result,'{card,model_context}',current_model);
  result:=jsonb_set(result,'{card,model_review}',jsonb_build_object(
    'required',NOT mw_private.technical_revision_model_matches(published,p_product_id),'previous_revision',published));
  IF NOT mw_private.technical_revision_model_matches(published,p_product_id) THEN
   result:=jsonb_set(jsonb_set(result,'{card,published}','null'),'{card,published_revision}','null');
  END IF;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint,jsonb) TO service_role;

ALTER FUNCTION public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint)
 RENAME TO bot_technical_editor_before_model;
ALTER FUNCTION public.bot_technical_editor_before_model(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_technical_editor_before_model(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_technical_editor(
 p_staff_telegram_id bigint,p_op text,p_session_id uuid DEFAULT NULL,p_revision integer DEFAULT NULL,
 p_product_id uuid DEFAULT NULL,p_source_revision uuid DEFAULT NULL,p_data jsonb DEFAULT NULL,
 p_review_state text DEFAULT 'pending_review',p_prompt_message_id bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; preview jsonb; e technical_editor_sessions%ROWTYPE; saved jsonb; current_model jsonb;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_staff_telegram_id AND active
  AND(role::text IN('admin','seller') OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TECH_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_op='preview' THEN
  SELECT * INTO e FROM technical_editor_sessions WHERE id=p_session_id AND staff_telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TECH_EDITOR_NOT_FOUND'; END IF;
  IF p_revision IS NULL OR p_revision<>e.revision THEN RAISE EXCEPTION 'TECH_EDITOR_STALE'; END IF;
  IF e.expires_at<=now() OR e.phase<>'editing' THEN RAISE EXCEPTION 'TECH_EDITOR_EXPIRED'; END IF;
  SELECT context INTO saved FROM technical_editor_models WHERE session_id=e.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TECH_MODEL_CONTEXT_REQUIRED'; END IF;
  preview:=public.bot_technical_catalog(p_staff_telegram_id,'preview',e.product_id,NULL,e.data->'document',
    p_review_state,e.base_version,saved);
  UPDATE technical_editor_sessions SET phase='preview',change_id=(preview->>'change_id')::uuid,
   prompt_message_id=NULL,revision=revision+1,updated_at=now() WHERE id=e.id RETURNING * INTO e;
  INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_staff_telegram_id,'technical_editor_preview',
   jsonb_build_object('session_id',e.id,'product_id',e.product_id,'revision',e.revision,'phase',e.phase));
  -- Reuse the original bounded reader; no second mutation implementation for apply/undo/cancel.
  result:=mw_private.bot_technical_editor_before_model(p_staff_telegram_id,'get',e.id);
 ELSE
  result:=mw_private.bot_technical_editor_before_model(p_staff_telegram_id,p_op,p_session_id,p_revision,
    p_product_id,p_source_revision,p_data,p_review_state,p_prompt_message_id);
 END IF;
 IF result->'session' IS NOT NULL AND result->'session'<>'null'::jsonb THEN
  SELECT * INTO e FROM technical_editor_sessions WHERE id=(result->'session'->>'id')::uuid;
  current_model:=mw_private.technical_model_context(e.product_id);
  IF p_op='start' THEN
   INSERT INTO technical_editor_models(session_id,context) VALUES(e.id,current_model);
  END IF;
  SELECT context INTO saved FROM technical_editor_models WHERE session_id=e.id;
  result:=jsonb_set(result,'{session,model_binding}',jsonb_build_object(
   'captured',saved,'current',current_model,'matches',saved IS NOT NULL AND saved=current_model));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint) TO service_role;

ALTER FUNCTION public.public_product_technical(uuid) RENAME TO public_product_technical_before_model;
ALTER FUNCTION public.public_product_technical_before_model(uuid) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.public_product_technical_before_model(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.public_product_technical(p_product_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT mw_private.public_product_technical_before_model(p_product_id)
 WHERE mw_private.technical_revision_model_matches(
  (SELECT published_revision FROM technical_cards WHERE product_id=p_product_id),p_product_id)
$$;
REVOKE ALL ON FUNCTION public.public_product_technical(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_product_technical(uuid) TO anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
