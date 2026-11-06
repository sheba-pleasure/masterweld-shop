-- Forward repair of 0017; preserve its applied checksum and all data.
CREATE OR REPLACE FUNCTION public.bot_technical_catalog(
  p_staff_telegram_id bigint,p_op text,p_product_id uuid DEFAULT NULL,
  p_change_id uuid DEFAULT NULL,p_document jsonb DEFAULT NULL,
  p_review_state text DEFAULT 'pending_review'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  s public.staff%ROWTYPE; c public.technical_cards%ROWTYPE; b public.technical_changes%ROWTYPE;
  approver boolean; revision_id uuid; result jsonb;
BEGIN
  -- technical-read-alias-v2: do not shadow the PL/pgSQL card variable in the read query.
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
      SELECT jsonb_build_object('version',coalesce(card_row.version,0),'published_revision',card_row.published_revision,
        'revisions',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (
          SELECT id,review_state,document,created_at FROM technical_revisions WHERE product_id=p_product_id
          ORDER BY created_at DESC,id LIMIT 10) r),'[]'::jsonb)) INTO result
        FROM (SELECT p_product_id AS id) p LEFT JOIN technical_cards card_row ON card_row.product_id=p.id;
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

NOTIFY pgrst, 'reload schema';
