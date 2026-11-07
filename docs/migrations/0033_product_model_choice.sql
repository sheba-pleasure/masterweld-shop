-- Explicit human selection for future enrichment. No product fields or publication are changed.
CREATE TABLE public.product_model_choices (
 id uuid PRIMARY KEY,
 actor bigint NOT NULL REFERENCES public.staff(telegram_id),
 product_id uuid NOT NULL REFERENCES public.products(id),
 kind text NOT NULL CHECK(kind IN('select','clear')),
 batch_id uuid, line integer,
 base_revision integer NOT NULL CHECK(base_revision>=0),
 identity jsonb,
 evidence jsonb NOT NULL,
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 confirmed_at timestamptz, canceled_at timestamptz,
 FOREIGN KEY(batch_id,line) REFERENCES public.document_import_model_links(batch_id,line),
 CHECK((kind='select' AND batch_id IS NOT NULL AND line IS NOT NULL AND identity IS NOT NULL)
    OR(kind='clear' AND batch_id IS NULL AND line IS NULL AND identity IS NULL)),
 CHECK(confirmed_at IS NULL OR canceled_at IS NULL)
);
CREATE TABLE public.product_model_selection (
 product_id uuid PRIMARY KEY REFERENCES public.products(id),
 revision integer NOT NULL CHECK(revision>0),
 choice_id uuid NOT NULL REFERENCES public.product_model_choices(id)
);
ALTER TABLE public.product_model_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_model_selection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_model_choices,public.product_model_selection FROM PUBLIC,anon,authenticated,service_role;

-- Match the source snapshot used by 0029. Read-only: never repair or approve a source.
CREATE FUNCTION mw_private.product_model_row_snapshot(p_review uuid,p_row integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('document_id',d.id,'checksum',d.checksum,'table_index',r.table_index,
   'row_index',v.row_index,'header',coalesce(r.header_override,t.value->'header'),'cells',v.cells,
   'origin',v.origin,'source_row',v.source_row,'source_note',v.source_note,
   'locator',CASE WHEN v.origin='manual' THEN NULL ELSE t.value->'row_locators'->coalesce(v.source_row,v.row_index) END)
 FROM document_reviews r JOIN document_intakes d ON d.id=r.document_id
 JOIN document_review_rows v ON v.review_id=r.id AND v.row_index=p_row
 CROSS JOIN LATERAL (SELECT d.extraction->'tables'->r.table_index AS value) t
 WHERE r.id=p_review
$$;

-- Includes all owners' active evidence, but callers only see identities/counts, never foreign files.
-- Price/stock updates and merely preparing an import undo do not change model evidence.
CREATE FUNCTION mw_private.product_model_choice_evidence(p_product uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('product',mw_private.document_product_identity(p),
  'excluded',p.assortment_decision::text='excluded',
  'sources',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'batch',q.batch_id,'line',q.line,'decision_id',q.decision_id,'identity',q.identity,
    'model_revision',q.model_revision,'source_hash',q.source_hash,'product_identity',q.product_identity,
    'current_model_revision',c.revision,'current_model_state',c.state,'current_source_hash',c.source_hash,
    'row_hash',encode(sha256(convert_to(mw_private.product_model_row_snapshot(q.review_id,q.row_index)::text,'UTF8')),'hex'),
    'eligible',NOT v.retired AND v.decision='approved' AND r.structure_draft IS NULL
   ) ORDER BY q.batch_id,q.line)
   FROM document_import_model_links q JOIN catalog_imports b ON b.id=q.batch_id
   JOIN document_reviews r ON r.id=q.review_id
   JOIN document_review_rows v ON v.review_id=q.review_id AND v.row_index=q.row_index
   LEFT JOIN document_model_checks c ON c.review_id=q.review_id AND c.row_index=q.row_index
   WHERE q.product_id=p.id AND b.state IN('applied','undo_preview')),'[]'::jsonb))
 FROM products p WHERE p.id=p_product
$$;
CREATE FUNCTION mw_private.product_model_choice_current(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s product_model_selection%ROWTYPE; c product_model_choices%ROWTYPE; evidence jsonb; state text;
BEGIN
 SELECT * INTO s FROM product_model_selection WHERE product_id=p_product;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','unselected','revision',0,'usable',false); END IF;
 SELECT * INTO c FROM product_model_choices WHERE id=s.choice_id;
 evidence:=mw_private.product_model_choice_evidence(p_product);
 IF c.kind='clear' THEN state:='withdrawn';
 ELSIF evidence IS NULL OR (evidence->>'excluded')::boolean THEN state:='excluded';
 ELSIF c.evidence_hash IS DISTINCT FROM encode(sha256(convert_to(evidence::text,'UTF8')),'hex') THEN state:='stale';
 ELSE state:='selected'; END IF;
 RETURN jsonb_build_object('state',state,'revision',s.revision,'usable',state='selected',
   'choice_id',c.id,'identity',c.identity,'selected_at',c.confirmed_at);
END $$;
REVOKE ALL ON FUNCTION mw_private.product_model_row_snapshot(uuid,integer),
 mw_private.product_model_choice_evidence(uuid),mw_private.product_model_choice_current(uuid)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_product_model_choice(p_actor bigint,p_op text,p_product uuid DEFAULT NULL,
 p_batch uuid DEFAULT NULL,p_line integer DEFAULT NULL,p_request uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c product_model_choices%ROWTYPE; p products%ROWTYPE; l document_import_model_links%ROWTYPE;
 current_choice jsonb; evidence jsonb; fingerprint text; model_view jsonb; source jsonb;
 expected_kind text; state text; other_models integer; existing boolean:=false;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active
  AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MODEL_CHOICE_DENIED'; END IF;
 IF p_op NOT IN('get','prepare','prepare_clear','read','confirm','cancel') THEN RAISE EXCEPTION 'MODEL_CHOICE_OPERATION'; END IF;
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_op IN('prepare','prepare_clear','read','confirm','cancel') THEN
  IF p_request IS NULL THEN RAISE EXCEPTION 'MODEL_CHOICE_REQUEST_REQUIRED'; END IF;
  SELECT * INTO c FROM product_model_choices WHERE id=p_request FOR UPDATE;
  existing:=FOUND;
  IF existing AND c.actor<>p_actor THEN RAISE EXCEPTION 'MODEL_CHOICE_NOT_FOUND'; END IF;
 END IF;
 IF p_op IN('read','confirm','cancel') THEN
  IF NOT existing THEN RAISE EXCEPTION 'MODEL_CHOICE_NOT_FOUND'; END IF;
  IF p_product IS NOT NULL AND p_product<>c.product_id THEN RAISE EXCEPTION 'MODEL_CHOICE_REQUEST_MISMATCH'; END IF;
  p_product:=c.product_id;
 ELSIF p_op='prepare' THEN
  SELECT q.* INTO l FROM document_import_model_links q JOIN catalog_imports b ON b.id=q.batch_id
   WHERE q.batch_id=p_batch AND q.line=p_line AND b.staff_telegram_id=p_actor;
  IF NOT FOUND OR l.product_id IS NULL THEN RAISE EXCEPTION 'MODEL_CHOICE_SOURCE_NOT_FOUND'; END IF;
  IF p_product IS NOT NULL AND p_product<>l.product_id THEN RAISE EXCEPTION 'MODEL_CHOICE_REQUEST_MISMATCH'; END IF;
  p_product:=l.product_id;
 END IF;
 SELECT * INTO p FROM products WHERE id=p_product FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MODEL_CHOICE_PRODUCT_NOT_FOUND'; END IF;
 current_choice:=mw_private.product_model_choice_current(p.id);
 evidence:=mw_private.product_model_choice_evidence(p.id);
 fingerprint:=encode(sha256(convert_to(evidence::text,'UTF8')),'hex');
 IF p_op IN('prepare','prepare_clear') THEN
  expected_kind:=CASE WHEN p_op='prepare' THEN 'select' ELSE 'clear' END;
  IF existing THEN
   IF c.product_id<>p.id OR c.kind<>expected_kind OR c.batch_id IS DISTINCT FROM p_batch
     OR c.line IS DISTINCT FROM p_line THEN RAISE EXCEPTION 'MODEL_CHOICE_REQUEST_MISMATCH'; END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=p_actor AND expires_at>now())
    OR EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=p_actor AND consumed_at IS NULL AND expires_at>now())
    OR EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=p_actor AND phase IN('editing','preview') AND expires_at>now())
   THEN RAISE EXCEPTION 'MODEL_CHOICE_INPUT_ACTIVE'; END IF;
   IF expected_kind='select' THEN
    model_view:=mw_private.document_import_model_view(p_actor,l.batch_id,l.line);
    IF model_view->>'state'<>'linked' THEN RAISE EXCEPTION 'MODEL_CHOICE_SOURCE_REVIEW'; END IF;
    IF NOT EXISTS(SELECT 1 FROM catalog_imports b WHERE b.id=l.batch_id AND b.state IN('applied','undo_preview'))
    THEN RAISE EXCEPTION 'MODEL_CHOICE_SOURCE_REVIEW'; END IF;
   ELSE
    IF p_batch IS NOT NULL OR p_line IS NOT NULL THEN RAISE EXCEPTION 'MODEL_CHOICE_BAD_INPUT'; END IF;
    IF current_choice->>'state' IN('unselected','withdrawn') THEN RAISE EXCEPTION 'MODEL_CHOICE_ALREADY_EMPTY'; END IF;
   END IF;
   INSERT INTO product_model_choices(id,actor,product_id,kind,batch_id,line,base_revision,identity,evidence,evidence_hash)
    VALUES(p_request,p_actor,p.id,expected_kind,p_batch,p_line,(current_choice->>'revision')::integer,
      CASE WHEN expected_kind='select' THEN l.identity ELSE NULL END,evidence,fingerprint) RETURNING * INTO c;
   INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'product_model_choice_prepare',
    jsonb_build_object('request_id',c.id,'product_id',p.id,'kind',c.kind));
  END IF;
 END IF;
 IF p_op='confirm' AND c.confirmed_at IS NULL THEN
  IF c.canceled_at IS NOT NULL THEN RAISE EXCEPTION 'MODEL_CHOICE_CANCELED'; END IF;
  IF c.expires_at<=now() THEN RAISE EXCEPTION 'MODEL_CHOICE_EXPIRED'; END IF;
  IF (current_choice->>'revision')::integer<>c.base_revision OR c.evidence_hash<>fingerprint
  THEN RAISE EXCEPTION 'MODEL_CHOICE_STALE'; END IF;
  IF EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=p_actor AND expires_at>now())
    OR EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=p_actor AND consumed_at IS NULL AND expires_at>now())
    OR EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=p_actor AND phase IN('editing','preview') AND expires_at>now())
  THEN RAISE EXCEPTION 'MODEL_CHOICE_INPUT_ACTIVE'; END IF;
  IF c.kind='select' THEN
   model_view:=mw_private.document_import_model_view(p_actor,c.batch_id,c.line);
   IF model_view->>'state'<>'linked' THEN RAISE EXCEPTION 'MODEL_CHOICE_SOURCE_REVIEW'; END IF;
  END IF;
  UPDATE product_model_choices SET confirmed_at=now() WHERE id=c.id RETURNING * INTO c;
  INSERT INTO product_model_selection(product_id,revision,choice_id) VALUES(p.id,c.base_revision+1,c.id)
   ON CONFLICT(product_id) DO UPDATE SET revision=excluded.revision,choice_id=excluded.choice_id;
  INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'product_model_choice_confirm',
   jsonb_build_object('request_id',c.id,'product_id',p.id,'kind',c.kind));
 ELSIF p_op='cancel' AND c.confirmed_at IS NULL AND c.canceled_at IS NULL THEN
  UPDATE product_model_choices SET canceled_at=now() WHERE id=c.id RETURNING * INTO c;
  INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'product_model_choice_cancel',
   jsonb_build_object('request_id',c.id,'product_id',p.id));
 END IF;
 -- A repeated confirm recovers the old receipt and the current choice; never restores an older choice.
 current_choice:=mw_private.product_model_choice_current(p.id);
 IF c.id IS NOT NULL THEN
  state:=CASE WHEN c.confirmed_at IS NOT NULL THEN 'confirmed' WHEN c.canceled_at IS NOT NULL THEN 'canceled'
    WHEN c.expires_at<=now() THEN 'expired'
    WHEN (current_choice->>'revision')::integer<>c.base_revision OR c.evidence_hash<>fingerprint THEN 'stale'
    ELSE 'prepared' END;
  IF c.batch_id IS NOT NULL THEN source:=mw_private.document_import_model_view(p_actor,c.batch_id,c.line); END IF;
  SELECT count(DISTINCT x->'identity') INTO other_models FROM jsonb_array_elements(c.evidence->'sources') x
   WHERE x->'identity'<>'null'::jsonb AND x->'identity' IS DISTINCT FROM c.identity;
 END IF;
 RETURN jsonb_build_object('ok',true,'product_id',p.id,'title',p.title,'sku',p.sku,'current',current_choice,
  'request',CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'kind',c.kind,'state',state,
   'identity',c.identity,'source',source,'other_models',other_models,'expires_at',c.expires_at) END);
END $$;
REVOKE ALL ON FUNCTION public.bot_product_model_choice(bigint,text,uuid,uuid,integer,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_product_model_choice(bigint,text,uuid,uuid,integer,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
