-- DEV first. Reopen a reviewed document only by canceling its unapplied import.
-- Frozen import sources and model decisions remain historical evidence.
CREATE TABLE public.document_import_returns (
 import_id uuid PRIMARY KEY REFERENCES public.catalog_imports(id),
 review_id uuid NOT NULL REFERENCES public.document_reviews(id),
 actor bigint NOT NULL, import_revision integer NOT NULL, review_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.document_import_returns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_import_returns FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) RENAME TO bot_catalog_import_conflicts;
ALTER FUNCTION public.bot_catalog_import_conflicts(bigint,text,uuid,jsonb,integer,integer) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_catalog_import_conflicts(bigint,text,uuid,jsonb,integer,integer)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_catalog_import(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
 p_payload jsonb DEFAULT '{}',p_page integer DEFAULT 0,p_revision integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b catalog_imports%ROWTYPE; r document_reviews%ROWTYPE; receipt document_import_returns%ROWTYPE;
 result jsonb; is_return boolean:=p_op IN('return_prepare','return_confirm'); can_return boolean:=false;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active
  AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_id IS NOT NULL THEN
  SELECT * INTO b FROM catalog_imports WHERE id=p_id AND staff_telegram_id=p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_NOT_FOUND'; END IF;
  SELECT q.* INTO r FROM document_import_origins o
   JOIN document_reviews q ON q.id=o.review_id JOIN document_intakes d ON d.id=q.document_id
   WHERE o.import_id=b.id AND d.staff_telegram_id=p_actor FOR UPDATE OF q;
  SELECT * INTO receipt FROM document_import_returns WHERE import_id=b.id AND actor=p_actor;
 END IF;
 IF is_return THEN
  IF r.id IS NULL THEN RAISE EXCEPTION 'IMPORT_RETURN_UNAVAILABLE'; END IF;
  IF p_revision IS DISTINCT FROM b.revision THEN RAISE EXCEPTION 'IMPORT_STALE'; END IF;
  IF p_op='return_confirm' AND coalesce(p_payload->>'review_revision','') !~ '^[0-9]{1,7}$'
  THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
  IF receipt.import_id IS NOT NULL THEN
   -- A repeated old button only recovers its receipt, even after a later handoff.
   IF p_op='return_confirm' AND (
     receipt.import_revision IS DISTINCT FROM p_revision OR
     receipt.review_revision IS DISTINCT FROM (p_payload->>'review_revision')::integer)
   THEN RAISE EXCEPTION 'IMPORT_STALE'; END IF;
  ELSE
   IF b.state NOT IN('config','preview','canceled') OR r.handed_import_id IS DISTINCT FROM b.id
   THEN RAISE EXCEPTION 'IMPORT_RETURN_UNAVAILABLE'; END IF;
   IF r.structure_draft IS NOT NULL OR
     EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=p_actor AND expires_at>now()) OR
     EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=p_actor AND consumed_at IS NULL AND expires_at>now()) OR
     EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=p_actor AND phase IN('editing','preview') AND expires_at>now())
   THEN RAISE EXCEPTION 'IMPORT_RETURN_INPUT_ACTIVE'; END IF;
   IF p_op='return_confirm' THEN
    IF r.revision IS DISTINCT FROM (p_payload->>'review_revision')::integer
    THEN RAISE EXCEPTION 'IMPORT_STALE'; END IF;
    -- Use the existing cancellation path, inside this same transaction and lock order.
    PERFORM mw_private.bot_catalog_import_conflicts(p_actor,'cancel',b.id,'{}',0,b.revision);
    INSERT INTO document_import_returns(import_id,review_id,actor,import_revision,review_revision)
     VALUES(b.id,r.id,p_actor,b.revision,r.revision) RETURNING * INTO receipt;
    DELETE FROM document_import_links
     WHERE document_id=r.document_id AND table_index=r.table_index AND import_id=b.id;
    UPDATE document_reviews SET handed_import_id=NULL,revision=revision+1 WHERE id=r.id RETURNING * INTO r;
    INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_import_return',
     jsonb_build_object('import_id',b.id,'review_id',r.id,'import_revision',b.revision,'review_revision',r.revision));
   END IF;
  END IF;
 END IF;
 result:=mw_private.bot_catalog_import_conflicts(p_actor,
  CASE WHEN is_return THEN 'get' ELSE p_op END,p_id,p_payload,p_page,p_revision);
 IF r.id IS NOT NULL THEN
  can_return:=receipt.import_id IS NULL AND r.handed_import_id=b.id
   AND result->>'state' IN('config','preview','canceled');
  result:=result||jsonb_build_object('document_can_return',coalesce(can_return,false),
   'document_returned',receipt.import_id IS NOT NULL,
   'document_return_prepare',p_op='return_prepare' AND receipt.import_id IS NULL,
   'document_review_revision',r.revision);
 END IF;
 IF p_op='return_confirm' THEN
  result:=result||jsonb_build_object('document_return_review',public.bot_document_review(p_actor,'get',r.id));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) TO service_role;
NOTIFY pgrst,'reload schema';
