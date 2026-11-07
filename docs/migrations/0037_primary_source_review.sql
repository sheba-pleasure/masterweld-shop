-- A human attaches an owned immutable original to an explicitly selected model.
-- This is a document-to-model decision, never a technical fact approval or publication.
CREATE TABLE public.product_source_reviews (
 id uuid PRIMARY KEY,
 actor bigint NOT NULL REFERENCES public.staff(telegram_id),
 product_id uuid NOT NULL REFERENCES public.products(id),
 model_context jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 0,
 phase text NOT NULL DEFAULT 'draft' CHECK(phase IN('draft','preview','confirmed','canceled','expired','withdraw_preview','withdrawn')),
 document_id uuid REFERENCES public.document_intakes(id),
 document_checksum text,
 source_kind text CHECK(source_kind IN('manual','manufacturer','test_report','supplier')),
 source_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 preview_expires_at timestamptz,
 CHECK(revision>=0),
 CHECK((document_id IS NULL)=(document_checksum IS NULL))
);
CREATE UNIQUE INDEX product_source_one_draft ON public.product_source_reviews(actor)
 WHERE phase IN('draft','preview','withdraw_preview');
CREATE TABLE public.product_document_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 review_id uuid NOT NULL UNIQUE REFERENCES public.product_source_reviews(id),
 actor bigint NOT NULL REFERENCES public.staff(telegram_id),
 product_id uuid NOT NULL REFERENCES public.products(id),
 document_id uuid NOT NULL REFERENCES public.document_intakes(id),
 document_checksum text NOT NULL CHECK(document_checksum ~ '^[0-9a-f]{64}$'),
 source_kind text NOT NULL CHECK(source_kind IN('manual','manufacturer','test_report','supplier')),
 model_context jsonb NOT NULL,
 context_hash text NOT NULL CHECK(context_hash ~ '^[0-9a-f]{64}$'),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 withdrawn_at timestamptz
);
ALTER TABLE public.product_source_reviews ADD FOREIGN KEY(source_id) REFERENCES public.product_document_sources(id);
CREATE UNIQUE INDEX product_source_one_active_file ON public.product_document_sources(actor,product_id,document_id,context_hash)
 WHERE withdrawn_at IS NULL;
CREATE INDEX product_source_owner_product ON public.product_document_sources(actor,product_id,confirmed_at DESC);
ALTER TABLE public.product_source_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_document_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_source_reviews,public.product_document_sources FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_product_sources(p_actor bigint,p_op text,p_product uuid DEFAULT NULL,
 p_id uuid DEFAULT NULL,p_revision integer DEFAULT NULL,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $sources$
DECLARE r product_source_reviews%ROWTYPE; d document_intakes%ROWTYPE; s product_document_sources%ROWTYPE;
 p products%ROWTYPE; context_now jsonb; result jsonb; docs jsonb; sources jsonb; active_review_id uuid;
 page integer:=0; total integer; display_phase text; usable boolean; target_doc uuid;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active
  AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_DENIED'; END IF;
 IF p_op IS NULL OR p_op NOT IN('home','start','get','documents','choose','kind','preview','edit','confirm','cancel','withdraw_prepare','withdraw','withdraw_cancel')
  THEN RAISE EXCEPTION 'SOURCE_OPERATION'; END IF;
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>2048
  THEN RAISE EXCEPTION 'SOURCE_BAD_INPUT'; END IF;
 IF p_payload ? 'page' THEN
  IF p_payload->>'page' IS NULL OR p_payload->>'page' !~ '^[0-9]{1,6}$' THEN RAISE EXCEPTION 'SOURCE_BAD_PAGE'; END IF;
  page:=(p_payload->>'page')::integer;
 END IF;
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_op NOT IN('home','start') THEN
  SELECT * INTO r FROM product_source_reviews WHERE id=p_id AND actor=p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND'; END IF;
  IF p_product IS NOT NULL AND p_product<>r.product_id THEN RAISE EXCEPTION 'SOURCE_REQUEST_MISMATCH'; END IF;
  p_product:=r.product_id;
 END IF;
 SELECT * INTO p FROM products WHERE id=p_product FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_PRODUCT_NOT_FOUND'; END IF;
 context_now:=mw_private.technical_model_context(p.id);
 IF p_op='start' THEN
  IF p_id IS NULL THEN RAISE EXCEPTION 'SOURCE_REQUEST_REQUIRED'; END IF;
  SELECT * INTO r FROM product_source_reviews WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
   IF r.actor<>p_actor OR r.product_id<>p.id THEN RAISE EXCEPTION 'SOURCE_REQUEST_MISMATCH'; END IF;
  ELSE
   IF context_now->>'state'<>'selected' THEN RAISE EXCEPTION 'SOURCE_MODEL_REQUIRED'; END IF;
   IF EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=p_actor AND expires_at>now())
    OR EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=p_actor AND consumed_at IS NULL AND expires_at>now())
    OR EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=p_actor AND phase IN('editing','preview') AND expires_at>now())
    THEN RAISE EXCEPTION 'SOURCE_INPUT_ACTIVE'; END IF;
   UPDATE product_source_reviews SET phase=CASE WHEN phase='withdraw_preview' THEN 'confirmed' ELSE 'expired' END,
    revision=revision+1 WHERE actor=p_actor AND phase IN('draft','preview','withdraw_preview') AND expires_at<=now();
   SELECT id INTO active_review_id FROM product_source_reviews WHERE actor=p_actor AND phase IN('draft','preview','withdraw_preview');
   IF FOUND THEN RAISE EXCEPTION 'SOURCE_DRAFT_ACTIVE'; END IF;
   INSERT INTO product_source_reviews(id,actor,product_id,model_context) VALUES(p_id,p_actor,p.id,context_now) RETURNING * INTO r;
   INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'product_source_start',jsonb_build_object('review_id',r.id,'product_id',p.id));
  END IF;
 ELSIF p_op IN('choose','kind','preview','edit','confirm','cancel','withdraw_prepare','withdraw','withdraw_cancel') THEN
  -- Repeated terminal decisions only return their receipt. They never resurrect a withdrawn source.
  IF (p_op='confirm' AND r.source_id IS NOT NULL) OR (p_op='withdraw' AND r.phase='withdrawn')
   OR (p_op='cancel' AND r.phase='canceled') THEN NULL;
  ELSE
   IF p_revision IS NULL OR p_revision<>r.revision THEN RAISE EXCEPTION 'SOURCE_STALE_BUTTON'; END IF;
   IF p_op IN('choose','kind','preview','edit','confirm') THEN
    IF r.phase NOT IN('draft','preview') OR r.expires_at<=now() THEN RAISE EXCEPTION 'SOURCE_EXPIRED'; END IF;
    IF r.model_context IS DISTINCT FROM context_now OR context_now->>'state'<>'selected' THEN RAISE EXCEPTION 'SOURCE_MODEL_CHANGED'; END IF;
   END IF;
   IF p_op='choose' THEN
    IF r.phase<>'draft' OR p_payload->>'document_id' IS NULL OR p_payload->>'document_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN RAISE EXCEPTION 'SOURCE_BAD_INPUT'; END IF;
    target_doc:=(p_payload->>'document_id')::uuid;
    SELECT * INTO d FROM document_intakes WHERE id=target_doc AND staff_telegram_id=p_actor AND state='review';
    IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_DOCUMENT_NOT_FOUND'; END IF;
    UPDATE product_source_reviews SET document_id=d.id,document_checksum=d.checksum,source_kind=NULL,revision=revision+1
     WHERE id=r.id RETURNING * INTO r;
   ELSIF p_op='kind' THEN
    IF r.phase<>'draft' OR r.document_id IS NULL OR p_payload->>'kind' IS NULL
      OR p_payload->>'kind' NOT IN('manual','manufacturer','test_report','supplier') THEN RAISE EXCEPTION 'SOURCE_BAD_INPUT'; END IF;
    UPDATE product_source_reviews SET source_kind=p_payload->>'kind',revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   ELSIF p_op IN('preview','confirm') THEN
    IF (p_op='preview' AND r.phase<>'draft') OR (p_op='confirm' AND r.phase<>'preview')
     OR r.document_id IS NULL OR r.source_kind IS NULL THEN RAISE EXCEPTION 'SOURCE_NOT_READY'; END IF;
    SELECT * INTO d FROM document_intakes WHERE id=r.document_id AND staff_telegram_id=p_actor AND state='review' FOR UPDATE;
    IF NOT FOUND OR d.checksum IS DISTINCT FROM r.document_checksum THEN RAISE EXCEPTION 'SOURCE_DOCUMENT_CHANGED'; END IF;
    IF p_op='preview' THEN
     UPDATE product_source_reviews SET phase='preview',preview_expires_at=now()+interval '15 minutes',revision=revision+1 WHERE id=r.id RETURNING * INTO r;
    ELSE
     IF r.preview_expires_at IS NULL OR r.preview_expires_at<=now() THEN RAISE EXCEPTION 'SOURCE_PREVIEW_EXPIRED'; END IF;
     IF EXISTS(SELECT 1 FROM product_document_sources WHERE actor=p_actor AND product_id=p.id AND document_id=d.id
       AND context_hash=encode(sha256(convert_to(context_now::text,'UTF8')),'hex') AND withdrawn_at IS NULL)
      THEN RAISE EXCEPTION 'SOURCE_ALREADY_CONFIRMED'; END IF;
     INSERT INTO product_document_sources(review_id,actor,product_id,document_id,document_checksum,source_kind,model_context,context_hash)
      VALUES(r.id,p_actor,p.id,d.id,d.checksum,r.source_kind,r.model_context,encode(sha256(convert_to(r.model_context::text,'UTF8')),'hex'))
      RETURNING * INTO s;
     UPDATE product_source_reviews SET phase='confirmed',source_id=s.id,revision=revision+1 WHERE id=r.id RETURNING * INTO r;
    END IF;
   ELSIF p_op='edit' THEN
    IF r.phase<>'preview' THEN RAISE EXCEPTION 'SOURCE_NOT_READY'; END IF;
    UPDATE product_source_reviews SET phase='draft',preview_expires_at=NULL,revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   ELSIF p_op='cancel' THEN
    IF r.phase NOT IN('draft','preview') THEN RAISE EXCEPTION 'SOURCE_NOT_READY'; END IF;
    UPDATE product_source_reviews SET phase='canceled',revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   ELSIF p_op='withdraw_prepare' THEN
    IF r.phase<>'confirmed' OR r.source_id IS NULL THEN RAISE EXCEPTION 'SOURCE_NOT_READY'; END IF;
    UPDATE product_source_reviews SET phase=CASE WHEN phase='withdraw_preview' THEN 'confirmed' ELSE 'expired' END,
     revision=revision+1 WHERE actor=p_actor AND phase IN('draft','preview','withdraw_preview') AND expires_at<=now() AND id<>r.id;
    IF EXISTS(SELECT 1 FROM product_source_reviews WHERE actor=p_actor AND phase IN('draft','preview','withdraw_preview') AND id<>r.id)
     THEN RAISE EXCEPTION 'SOURCE_DRAFT_ACTIVE'; END IF;
    UPDATE product_source_reviews SET phase='withdraw_preview',preview_expires_at=now()+interval '15 minutes',
     expires_at=now()+interval '24 hours',revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   ELSIF p_op='withdraw' THEN
    IF r.phase<>'withdraw_preview' OR r.preview_expires_at<=now() THEN RAISE EXCEPTION 'SOURCE_PREVIEW_EXPIRED'; END IF;
    UPDATE product_document_sources SET withdrawn_at=now() WHERE id=r.source_id AND actor=p_actor AND withdrawn_at IS NULL;
    UPDATE product_source_reviews SET phase='withdrawn',revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   ELSIF p_op='withdraw_cancel' THEN
    IF r.phase<>'withdraw_preview' THEN RAISE EXCEPTION 'SOURCE_NOT_READY'; END IF;
    UPDATE product_source_reviews SET phase='confirmed',preview_expires_at=NULL,revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   END IF;
   INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'product_source_'||p_op,
    jsonb_build_object('review_id',r.id,'product_id',p.id,'revision',r.revision,'source_id',r.source_id));
  END IF;
 END IF;
 IF p_op='documents' AND p_revision IS DISTINCT FROM r.revision THEN RAISE EXCEPTION 'SOURCE_STALE_BUTTON'; END IF;
 IF r.id IS NOT NULL THEN
  SELECT * INTO d FROM document_intakes WHERE id=r.document_id AND staff_telegram_id=p_actor;
  SELECT * INTO s FROM product_document_sources WHERE id=r.source_id AND actor=p_actor;
  display_phase:=CASE WHEN r.phase IN('draft','preview') AND r.expires_at<=now() THEN 'expired' ELSE r.phase END;
  usable:=r.model_context=context_now AND context_now->>'state'='selected'
    AND d.id IS NOT NULL AND d.state='review' AND d.checksum=r.document_checksum;
  IF p_op='documents' THEN
   SELECT count(*) INTO total FROM document_intakes WHERE staff_telegram_id=p_actor AND state='review';
   SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') INTO docs FROM (
    SELECT id,file_name FROM document_intakes WHERE staff_telegram_id=p_actor AND state='review'
    ORDER BY created_at DESC,id LIMIT 8 OFFSET page*8) q;
  END IF;
  result:=jsonb_build_object('id',r.id,'product_id',r.product_id,'revision',r.revision,'phase',display_phase,
   'model_context',r.model_context,'model_matches',r.model_context=context_now AND context_now->>'state'='selected',
   'document',CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'file_name',d.file_name,'checksum',d.checksum,
    'coverage',d.extraction->'coverage','warnings',d.extraction->'warnings') END,
   'source_kind',r.source_kind,'source_id',r.source_id,'usable',coalesce(usable AND s.id IS NOT NULL AND s.withdrawn_at IS NULL,false),
   'can_confirm',coalesce(r.expires_at>now() AND r.preview_expires_at>now() AND ((r.phase='preview' AND usable AND r.source_kind IS NOT NULL)
     OR(r.phase='withdraw_preview' AND s.id IS NOT NULL AND s.withdrawn_at IS NULL)),false),
   'documents',docs,'page',page,'pages',greatest(1,ceil(total/8.0)::integer));
 END IF;
 IF p_op='home' THEN
  SELECT count(*) INTO total FROM product_document_sources WHERE actor=p_actor AND product_id=p.id;
  SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') INTO sources FROM (
   SELECT src.review_id,src.source_kind,doc.file_name,src.withdrawn_at,
    (src.model_context=context_now AND context_now->>'state'='selected' AND src.withdrawn_at IS NULL
     AND doc.state='review' AND src.document_checksum=doc.checksum) AS usable
   FROM product_document_sources src JOIN document_intakes doc ON doc.id=src.document_id AND doc.staff_telegram_id=p_actor
   WHERE src.actor=p_actor AND src.product_id=p.id ORDER BY src.confirmed_at DESC,src.id LIMIT 8 OFFSET page*8) q;
 END IF;
 SELECT id INTO active_review_id FROM product_source_reviews WHERE actor=p_actor AND phase IN('draft','preview','withdraw_preview')
  AND expires_at>now() LIMIT 1;
 RETURN jsonb_build_object('ok',true,'product_id',p.id,'title',p.title,'current_model',context_now,'review',result,
  'active_review',active_review_id,'sources',sources,'page',page,'pages',greatest(1,ceil(total/8.0)::integer));
END $sources$;
REVOKE ALL ON FUNCTION public.bot_product_sources(bigint,text,uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_product_sources(bigint,text,uuid,uuid,integer,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
