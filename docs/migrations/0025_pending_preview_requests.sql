-- Durable request keys for direct previews and reverse-preview preparation.
-- Existing outcomes and 0024 confirmation remain authoritative; no data backfill.
CREATE TABLE public.bot_pending_requests (
  request_id uuid PRIMARY KEY,
  staff_telegram_id bigint NOT NULL REFERENCES public.staff(telegram_id),
  pending_id uuid NOT NULL UNIQUE REFERENCES public.pending_actions(id),
  source_pending_id uuid REFERENCES public.pending_actions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bot_pending_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_pending_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_pending_preview(
  p_staff_telegram_id bigint,p_request_id uuid,p_op text,
  p_product_id uuid DEFAULT NULL,p_action text DEFAULT NULL,
  p_before jsonb DEFAULT NULL,p_after jsonb DEFAULT NULL,p_source_pending_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $preview$
DECLARE
  s public.staff%ROWTYPE;
  receipt public.bot_pending_requests%ROWTYPE;
  source public.pending_actions%ROWTYPE;
  new_id uuid;
  kind text;
  allowed_keys text[];
  reverse_result jsonb;
BEGIN
  IF p_request_id IS NULL OR p_op IS NULL OR p_op NOT IN ('prepare','rollback','read')
    THEN RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION'; END IF;
  SELECT * INTO s FROM public.staff WHERE telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active THEN RAISE EXCEPTION 'BOT_PENDING_PERMISSION_DENIED'; END IF;
  SELECT * INTO receipt FROM public.bot_pending_requests WHERE request_id=p_request_id;
  IF FOUND THEN
    IF receipt.staff_telegram_id<>p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
    -- The first committed receipt wins, including expiry and cancellation.
    RETURN public.bot_pending_operation(p_staff_telegram_id,receipt.pending_id,'read')
      || jsonb_build_object('request_id',p_request_id,'replayed',true,
        'source_pending_id',receipt.source_pending_id);
  END IF;
  IF p_op='read' THEN RETURN jsonb_build_object('state','not_found','request_id',p_request_id); END IF;
  kind:=p_action;
  IF p_op='rollback' THEN
    SELECT * INTO source FROM public.pending_actions WHERE id=p_source_pending_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PENDING_NOT_FOUND'; END IF;
    IF source.staff_telegram_id<>p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
    kind:=source.action;
  END IF;
  IF kind IS NULL OR kind NOT IN ('price','stock','title','description','specs','brand','sku','category','status',
    'photo_main','photo_reorder','photo_delete') THEN RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION'; END IF;
  -- Mirror current permissions.ts / PENDING_PERMISSION before any pending or audit write.
  IF NOT (s.role::text='admin' OR (s.role::text='director' AND s.elevated)
    OR (s.role::text='director' AND kind IN ('price','stock'))
    OR (s.role::text='seller' AND kind IN ('stock','title','description','specs','brand','sku',
      'photo_main','photo_reorder','photo_delete')))
    THEN RAISE EXCEPTION 'BOT_PENDING_PERMISSION_DENIED'; END IF;
  IF p_op='rollback' THEN
    reverse_result:=public.bot_prepare_rollback(p_source_pending_id,p_staff_telegram_id);
    new_id:=(reverse_result->>'pending_id')::uuid;
  ELSE
    IF p_source_pending_id IS NOT NULL OR p_product_id IS NULL
      OR jsonb_typeof(p_before) IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_after) IS DISTINCT FROM 'object'
      OR octet_length(p_before::text)>20000 OR octet_length(p_after::text)>20000
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    allowed_keys:=CASE kind
      WHEN 'stock' THEN ARRAY['in_stock'] WHEN 'category' THEN ARRAY['category_id']
      WHEN 'photo_main' THEN ARRAY['photo_id','is_main','sort_order','prev_main_id']
      WHEN 'photo_reorder' THEN ARRAY['photo_id','is_main','sort_order']
      WHEN 'photo_delete' THEN ARRAY['photo_id','is_main','sort_order','deleted']
      ELSE ARRAY[kind] END;
    IF p_before='{}'::jsonb OR p_after='{}'::jsonb
      OR p_before-allowed_keys<>'{}'::jsonb OR p_after-allowed_keys<>'{}'::jsonb
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    PERFORM 1 FROM public.products WHERE id=p_product_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PRODUCT_NOT_FOUND'; END IF;
    INSERT INTO public.pending_actions(staff_telegram_id,product_id,action,before_value,after_value,expires_at)
      VALUES(p_staff_telegram_id,p_product_id,kind,p_before,p_after,now()+interval '15 minutes')
      RETURNING id INTO new_id;
  END IF;
  INSERT INTO public.bot_pending_requests(request_id,staff_telegram_id,pending_id,source_pending_id)
    VALUES(p_request_id,p_staff_telegram_id,new_id,CASE WHEN p_op='rollback' THEN p_source_pending_id END);
  RETURN public.bot_pending_operation(p_staff_telegram_id,new_id,'read')
    || jsonb_build_object('request_id',p_request_id,'replayed',false,
      'source_pending_id',CASE WHEN p_op='rollback' THEN p_source_pending_id END);
END $preview$;
REVOKE ALL ON FUNCTION public.bot_pending_preview(bigint,uuid,text,uuid,text,jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_pending_preview(bigint,uuid,text,uuid,text,jsonb,jsonb,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.bot_prepare_rollback(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.pending_actions FROM service_role;

-- Read-only, actor-scoped discovery after the Telegram message itself was lost.
CREATE FUNCTION public.bot_pending_history(p_staff_telegram_id bigint,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $history$
DECLARE s public.staff%ROWTYPE; result jsonb;
BEGIN
  IF p_offset IS NULL OR p_offset<0 OR p_offset>10000 THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
  SELECT * INTO s FROM public.staff WHERE telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active THEN RAISE EXCEPTION 'BOT_PENDING_PERMISSION_DENIED'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC,r.id DESC),'[]'::jsonb) INTO result
  FROM (
    SELECT a.id,a.action,a.created_at,left(p.title,160) AS title,
      CASE WHEN a.outcome IN ('applied','canceled') AND a.consumed_at IS NOT NULL THEN a.outcome
        WHEN a.consumed_at IS NOT NULL OR a.outcome IS NOT NULL THEN 'uncertain'
        WHEN a.expires_at<=now() THEN 'expired' ELSE 'pending' END AS state
    FROM public.pending_actions a JOIN public.products p ON p.id=a.product_id
    WHERE a.staff_telegram_id=p_staff_telegram_id
      AND (s.role::text='admin' OR (s.role::text='director' AND s.elevated)
        OR (s.role::text='director' AND a.action IN ('price','stock'))
        OR (s.role::text='seller' AND a.action IN ('stock','title','description','specs','brand','sku',
          'photo_main','photo_reorder','photo_delete')))
    ORDER BY a.created_at DESC,a.id DESC LIMIT 11 OFFSET p_offset
  ) r;
  RETURN result;
END $history$;
REVOKE ALL ON FUNCTION public.bot_pending_history(bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_pending_history(bigint,integer) TO service_role;
NOTIFY pgrst,'reload schema';
