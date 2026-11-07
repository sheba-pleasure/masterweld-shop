-- Durable staff editor. No new public write path; source/role/version guards remain in 0019.
CREATE TABLE public.technical_editor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_telegram_id bigint NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id),
  base_version bigint NOT NULL,
  base_document jsonb,
  source_revision uuid REFERENCES public.technical_revisions(id),
  revision integer NOT NULL DEFAULT 0,
  phase text NOT NULL DEFAULT 'editing' CHECK(phase IN ('editing','preview','applied','canceled','undone','expired')),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=196608),
  change_id uuid REFERENCES public.technical_changes(id),
  prompt_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE UNIQUE INDEX technical_editor_one_active ON public.technical_editor_sessions(staff_telegram_id)
  WHERE phase IN ('editing','preview');
CREATE INDEX technical_editor_owner ON public.technical_editor_sessions(staff_telegram_id,created_at DESC);
ALTER TABLE public.technical_editor_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.technical_editor_sessions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_technical_editor(
  p_staff_telegram_id bigint,p_op text,p_session_id uuid DEFAULT NULL,
  p_revision integer DEFAULT NULL,p_product_id uuid DEFAULT NULL,p_source_revision uuid DEFAULT NULL,
  p_data jsonb DEFAULT NULL,p_review_state text DEFAULT 'pending_review',p_prompt_message_id bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $editor$
DECLARE
  s public.staff%ROWTYPE; e public.technical_editor_sessions%ROWTYPE;
  c public.technical_cards%ROWTYPE; r public.technical_revisions%ROWTYPE;
  base jsonb; doc jsonb; result jsonb; title text; approver boolean;
BEGIN
  SELECT * INTO s FROM staff WHERE telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active OR NOT(s.role::text IN ('admin','seller') OR (s.role::text='director' AND s.elevated))
    THEN RAISE EXCEPTION 'TECH_DENIED'; END IF;
  approver:=s.role::text='admin' OR (s.role::text='director' AND s.elevated);
  IF p_op IS NULL OR p_op NOT IN ('current','latest','get','start','save','prompt','preview','edit','apply','cancel','undo')
    THEN RAISE EXCEPTION 'TECH_EDITOR_BAD_INPUT'; END IF;

  IF p_op='current' THEN
    SELECT * INTO e FROM technical_editor_sessions WHERE staff_telegram_id=p_staff_telegram_id
      AND phase IN ('editing','preview') AND expires_at>now() ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'session',null); END IF;
  ELSIF p_op='latest' THEN
    SELECT * INTO e FROM technical_editor_sessions WHERE staff_telegram_id=p_staff_telegram_id
      ORDER BY updated_at DESC,id LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'session',null); END IF;
  ELSIF p_op='start' THEN
    IF p_source_revision IS NOT NULL THEN
      SELECT * INTO r FROM technical_revisions WHERE id=p_source_revision;
      IF NOT FOUND OR (NOT approver AND r.staff_telegram_id<>p_staff_telegram_id)
        THEN RAISE EXCEPTION 'TECH_REVIEW_DENIED'; END IF;
      IF p_product_id IS NOT NULL AND p_product_id<>r.product_id THEN RAISE EXCEPTION 'TECH_REVIEW_DENIED'; END IF;
      p_product_id:=r.product_id;
    END IF;
    UPDATE technical_editor_sessions SET phase='expired',revision=revision+1,updated_at=now(),prompt_message_id=NULL
      WHERE staff_telegram_id=p_staff_telegram_id AND phase IN ('editing','preview') AND expires_at<=now();
    IF EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=p_staff_telegram_id AND phase IN ('editing','preview'))
      THEN RAISE EXCEPTION 'TECH_EDITOR_ACTIVE'; END IF;
    PERFORM 1 FROM products WHERE id=p_product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TECH_PRODUCT_NOT_FOUND'; END IF;
    SELECT * INTO c FROM technical_cards WHERE product_id=p_product_id;
    IF c.published_revision IS NOT NULL THEN
      SELECT document INTO base FROM technical_revisions WHERE id=c.published_revision AND product_id=p_product_id;
    END IF;
    doc:=base;
    IF p_source_revision IS NOT NULL THEN
      SELECT * INTO r FROM technical_revisions WHERE id=p_source_revision AND product_id=p_product_id;
      IF NOT FOUND OR (NOT approver AND r.staff_telegram_id<>p_staff_telegram_id)
        THEN RAISE EXCEPTION 'TECH_REVIEW_DENIED'; END IF;
      doc:=r.document;
    END IF;
    INSERT INTO technical_editor_sessions(staff_telegram_id,product_id,base_version,base_document,source_revision,data)
      VALUES(p_staff_telegram_id,p_product_id,coalesce(c.version,0),base,
        coalesce(p_source_revision,c.published_revision),
        jsonb_build_object('document',doc,'screen','home','page',0,'field',NULL,'fact',NULL,'pending',NULL,'source',NULL,'sourceField',0))
      RETURNING * INTO e;
  ELSE
    SELECT * INTO e FROM technical_editor_sessions WHERE id=p_session_id AND staff_telegram_id=p_staff_telegram_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'TECH_EDITOR_NOT_FOUND'; END IF;
    IF p_op<>'get' THEN
      -- Same confirmation is safe to inspect again after a lost HTTP/Telegram result.
      IF (p_op='apply' AND e.phase='applied') OR (p_op='undo' AND e.phase='undone') OR (p_op='cancel' AND e.phase='canceled') THEN
        NULL;
      ELSE
        IF p_revision IS NULL OR p_revision<>e.revision THEN RAISE EXCEPTION 'TECH_EDITOR_STALE'; END IF;
        IF p_op<>'undo' AND (e.expires_at<=now() OR e.phase NOT IN ('editing','preview'))
          THEN RAISE EXCEPTION 'TECH_EDITOR_EXPIRED'; END IF;
        IF p_op='save' THEN
          IF e.phase<>'editing' OR p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>196608
            THEN RAISE EXCEPTION 'TECH_EDITOR_BAD_INPUT'; END IF;
          UPDATE technical_editor_sessions SET data=p_data,prompt_message_id=NULL,revision=revision+1,updated_at=now()
            WHERE id=e.id RETURNING * INTO e;
        ELSIF p_op='prompt' THEN
          IF e.phase<>'editing' OR p_prompt_message_id IS NULL OR p_prompt_message_id<=0
            THEN RAISE EXCEPTION 'TECH_EDITOR_BAD_INPUT'; END IF;
          UPDATE technical_editor_sessions SET prompt_message_id=p_prompt_message_id,updated_at=now()
            WHERE id=e.id RETURNING * INTO e;
        ELSIF p_op='preview' THEN
          IF e.phase<>'editing' THEN RAISE EXCEPTION 'TECH_EDITOR_BAD_INPUT'; END IF;
          result:=bot_technical_catalog(p_staff_telegram_id,'preview',e.product_id,NULL,e.data->'document',p_review_state,e.base_version);
          UPDATE technical_editor_sessions SET phase='preview',change_id=(result->>'change_id')::uuid,
            prompt_message_id=NULL,revision=revision+1,updated_at=now() WHERE id=e.id RETURNING * INTO e;
        ELSIF p_op='edit' THEN
          IF e.phase<>'preview' THEN RAISE EXCEPTION 'TECH_EDITOR_BAD_INPUT'; END IF;
          UPDATE technical_editor_sessions SET phase='editing',change_id=NULL,prompt_message_id=NULL,
            revision=revision+1,updated_at=now() WHERE id=e.id RETURNING * INTO e;
        ELSIF p_op='apply' THEN
          IF e.phase<>'preview' OR e.change_id IS NULL THEN RAISE EXCEPTION 'TECH_EDITOR_BAD_INPUT'; END IF;
          result:=bot_technical_catalog(p_staff_telegram_id,'apply',p_change_id=>e.change_id);
          UPDATE technical_editor_sessions SET phase='applied',prompt_message_id=NULL,revision=revision+1,updated_at=now()
            WHERE id=e.id RETURNING * INTO e;
        ELSIF p_op='cancel' THEN
          UPDATE technical_editor_sessions SET phase='canceled',prompt_message_id=NULL,revision=revision+1,updated_at=now()
            WHERE id=e.id RETURNING * INTO e;
        ELSIF p_op='undo' THEN
          IF e.phase<>'applied' OR e.change_id IS NULL THEN RAISE EXCEPTION 'TECH_EDITOR_BAD_INPUT'; END IF;
          result:=bot_technical_catalog(p_staff_telegram_id,'undo',p_change_id=>e.change_id);
          UPDATE technical_editor_sessions SET phase='undone',prompt_message_id=NULL,revision=revision+1,updated_at=now()
            WHERE id=e.id RETURNING * INTO e;
        END IF;
      END IF;
    END IF;
  END IF;
  -- Bounded metadata audit; draft contents never enter logs.
  INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_staff_telegram_id,'technical_editor_'||p_op,
    jsonb_build_object('session_id',e.id,'product_id',e.product_id,'revision',e.revision,'phase',e.phase));
  SELECT products.title INTO title FROM products WHERE id=e.product_id;
  RETURN jsonb_build_object('ok',true,'session',
    (to_jsonb(e)-'staff_telegram_id') || jsonb_build_object('product_title',title,
      'review_state',(SELECT review_state FROM technical_changes WHERE id=e.change_id),
      'applied_revision',(SELECT after_revision FROM technical_changes WHERE id=e.change_id)));
END $editor$;
REVOKE ALL ON FUNCTION public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_technical_editor(bigint,text,uuid,integer,uuid,uuid,jsonb,text,bigint) TO service_role;
NOTIFY pgrst, 'reload schema';
