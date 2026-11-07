-- Atomic, owner-bound transfer of the reviewed frozen plan. No product or publication writes.
ALTER FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb)
 RENAME TO bot_source_fact_review_before_handoff;
ALTER FUNCTION public.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_source_fact_review_before_handoff(bigint,text,uuid,integer,integer,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_source_fact_review(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
 p_revision integer DEFAULT NULL,p_index integer DEFAULT 0,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $handoff$
DECLARE r source_fact_reviews%ROWTYPE; line source_fact_rows%ROWTYPE; e technical_editor_sessions%ROWTYPE;
 result jsonb; before_document jsonb; before_revision uuid; plan jsonb; document jsonb;
 source jsonb; original_fact jsonb; target_fact jsonb; started jsonb; source_status jsonb;
 origin_id uuid; target_index integer; found_count integer; accepted_count integer:=0; replace_family boolean;
BEGIN
 IF p_op IS DISTINCT FROM 'handoff' THEN
  result:=mw_private.bot_source_fact_review_before_handoff(p_actor,p_op,p_id,p_revision,p_index,p_payload);
 ELSE
  PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active
   AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_FACT_DENIED'; END IF;
  PERFORM pg_advisory_xact_lock(14757,31);
  SELECT * INTO r FROM source_fact_reviews WHERE id=p_id AND actor=p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_FACT_NOT_FOUND'; END IF;
  IF r.phase='handed' THEN
   -- Receipt only: never create another session or return a later draft as this transfer.
   IF r.editor_session_id IS NULL THEN RAISE EXCEPTION 'SOURCE_FACT_HANDOFF_RESULT'; END IF;
  ELSE
   IF p_revision IS NULL OR p_revision<>r.revision THEN RAISE EXCEPTION 'SOURCE_FACT_STALE_BUTTON'; END IF;
   IF r.phase<>'preview' OR r.prepared_document IS NULL OR r.merge_preview IS NULL
    THEN RAISE EXCEPTION 'SOURCE_FACT_NOT_PREVIEW'; END IF;
   IF r.expires_at<=now() OR r.preview_expires_at IS NULL OR r.preview_expires_at<=now()
    THEN RAISE EXCEPTION 'SOURCE_FACT_PREVIEW_EXPIRED'; END IF;
   IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR p_payload-'replace_family' IS DISTINCT FROM '{"confirm_plan":true}'::jsonb
    THEN RAISE EXCEPTION 'SOURCE_FACT_CONFIRM_REQUIRED'; END IF;
   PERFORM 1 FROM products WHERE id=r.product_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_FACT_SOURCE_STALE'; END IF;
   IF NOT mw_private.product_document_source_usable(r.source_id)
    OR r.model_context IS DISTINCT FROM mw_private.technical_model_context(r.product_id)
    OR r.base_version IS DISTINCT FROM coalesce((SELECT version FROM technical_cards WHERE product_id=r.product_id),0)
    THEN RAISE EXCEPTION 'SOURCE_FACT_SOURCE_STALE'; END IF;
   SELECT c.published_revision,t.document INTO before_revision,before_document
    FROM technical_cards c LEFT JOIN technical_revisions t ON t.id=c.published_revision WHERE c.product_id=r.product_id;
   IF r.merge_preview->'before_revision' IS DISTINCT FROM coalesce(to_jsonb(before_revision),'null'::jsonb)
    OR r.merge_preview->'before_document' IS DISTINCT FROM coalesce(before_document,'null'::jsonb)
    THEN RAISE EXCEPTION 'SOURCE_FACT_SOURCE_STALE'; END IF;
   -- Compare against the displayed plan. Never silently refresh its base or its contents.
   plan:=mw_private.source_fact_merge_preview(before_document,r.prepared_document,r.id)
    ||jsonb_build_object('before_revision',before_revision);
   IF plan IS DISTINCT FROM r.merge_preview THEN RAISE EXCEPTION 'SOURCE_FACT_MERGE_RESULT'; END IF;
   replace_family:=before_document IS NOT NULL
    AND before_document->>'family_code' IS DISTINCT FROM r.family_code;
   IF p_payload->'replace_family' IS DISTINCT FROM to_jsonb(replace_family)
    THEN RAISE EXCEPTION 'SOURCE_FACT_FAMILY_CONFIRM_REQUIRED'; END IF;
   IF EXISTS(SELECT 1 FROM source_fact_rows WHERE review_id=r.id AND decision='pending')
    THEN RAISE EXCEPTION 'SOURCE_FACT_DECISIONS_REQUIRED'; END IF;
   IF EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=p_actor AND consumed_at IS NULL AND expires_at>now())
    OR EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=p_actor AND phase IN('editing','preview') AND expires_at>now())
    OR EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=p_actor AND expires_at>now())
    OR EXISTS(SELECT 1 FROM source_fact_prompts WHERE actor=p_actor AND expires_at>now())
    THEN RAISE EXCEPTION 'SOURCE_FACT_OTHER_INPUT'; END IF;
   started:=public.bot_technical_editor(p_actor,'start',p_product_id=>r.product_id);
   SELECT * INTO e FROM technical_editor_sessions WHERE id=(started->'session'->>'id')::uuid AND staff_telegram_id=p_actor;
   IF NOT FOUND OR e.product_id<>r.product_id OR e.base_version<>r.base_version
    OR e.base_document IS DISTINCT FROM before_document
    OR NOT EXISTS(SELECT 1 FROM technical_editor_models WHERE session_id=e.id AND context=r.model_context)
    THEN RAISE EXCEPTION 'SOURCE_FACT_HANDOFF_RESULT'; END IF;
   document:=r.merge_preview->'after_document';
   FOR line IN SELECT * FROM source_fact_rows WHERE review_id=r.id AND decision='accepted' ORDER BY row_index LOOP
    SELECT count(*),min(ordinality)::integer-1 INTO found_count,target_index
     FROM jsonb_array_elements(r.prepared_document->'values') WITH ORDINALITY
     WHERE value-ARRAY['state','source_key']=line.draft;
    IF found_count<>1 THEN RAISE EXCEPTION 'SOURCE_FACT_HANDOFF_RESULT'; END IF;
    original_fact:=r.prepared_document->'values'->target_index;
    SELECT value INTO source FROM jsonb_array_elements(r.prepared_document->'sources')
     WHERE value->>'key'=original_fact->>'source_key';
    SELECT count(*),min(ordinality)::integer-1 INTO found_count,target_index
     FROM jsonb_array_elements(document->'values') WITH ORDINALITY
     WHERE value-'source_key'=original_fact-'source_key';
    IF found_count<>1 THEN RAISE EXCEPTION 'SOURCE_FACT_HANDOFF_RESULT'; END IF;
    target_fact:=document->'values'->target_index;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(document->'sources') s
      WHERE s->>'key'=target_fact->>'source_key' AND s-'key'=source-'key')
     THEN RAISE EXCEPTION 'SOURCE_FACT_HANDOFF_RESULT'; END IF;
    INSERT INTO technical_fact_origins(product_id,source_id,review_id,row_index,source_snapshot,original_fact)
     VALUES(r.product_id,r.source_id,r.id,line.row_index,source-'key',original_fact) RETURNING id INTO origin_id;
    document:=jsonb_set(document,ARRAY['values',target_index::text,'origin_ref'],to_jsonb(origin_id::text));
    accepted_count:=accepted_count+1;
   END LOOP;
   IF accepted_count NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'SOURCE_FACT_ACCEPTED_LIMIT'; END IF;
   PERFORM validate_technical_document(document,'pending_review');
   UPDATE source_fact_reviews SET phase='handed',editor_session_id=e.id,revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   -- Old withdrawn facts may remain in a draft for explicit removal, never for application.
   IF NOT (mw_private.technical_origin_status(document,r.product_id,false)->>'usable')::boolean
    THEN RAISE EXCEPTION 'TECH_ORIGIN_INVALID'; END IF;
   UPDATE technical_editor_sessions SET data=jsonb_set(data,'{document}',document),revision=revision+1,
    prompt_message_id=NULL,updated_at=now() WHERE id=e.id;
   DELETE FROM source_fact_prompts WHERE actor=p_actor AND review_id=r.id;
   INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'source_fact_handoff',
    jsonb_build_object('review_id',r.id,'product_id',r.product_id,'session_id',e.id,'revision',r.revision,'accepted',accepted_count));
  END IF;
  result:=mw_private.bot_source_fact_review_before_handoff(p_actor,'get',r.id,NULL,p_index,'{}');
 END IF;
 IF result->'review' IS NOT NULL THEN
  source_status:=mw_private.technical_origin_status(result->'review'->'merge_preview'->'after_document',
    (result->'review'->>'product_id')::uuid);
  result:=result||jsonb_build_object('handoff_supported',true,'retained_sources',source_status);
 END IF;
 RETURN result;
END $handoff$;
REVOKE ALL ON FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_source_fact_review(bigint,text,uuid,integer,integer,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
