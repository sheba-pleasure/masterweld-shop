-- Reuse the existing atomic outcome; no historical mutation or guessed backfill.
CREATE FUNCTION public.bot_pending_operation(p_staff_telegram_id bigint,p_pending_id uuid,p_op text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $operation$
DECLARE
  s public.staff%ROWTYPE;
  a public.pending_actions%ROWTYPE;
  result_state text;
  title text;
  changed boolean:=false;
BEGIN
  IF p_pending_id IS NULL OR p_op IS NULL OR p_op NOT IN ('apply','cancel','read')
    THEN RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION'; END IF;
  SELECT * INTO s FROM public.staff WHERE telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active THEN RAISE EXCEPTION 'BOT_PENDING_PERMISSION_DENIED'; END IF;
  SELECT * INTO a FROM public.pending_actions WHERE id=p_pending_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PENDING_NOT_FOUND'; END IF;
  IF a.staff_telegram_id<>p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
  IF a.action NOT IN ('price','stock','title','description','specs','brand','sku','category','status',
    'photo_main','photo_reorder','photo_delete') THEN RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION'; END IF;
  -- Mirror permissions.ts / PENDING_PERMISSION, including read and cancellation.
  IF NOT (s.role::text='admin' OR (s.role::text='director' AND s.elevated)
    OR (s.role::text='director' AND a.action IN ('price','stock'))
    OR (s.role::text='seller' AND a.action IN ('stock','title','description','specs','brand','sku',
      'photo_main','photo_reorder','photo_delete')))
    THEN RAISE EXCEPTION 'BOT_PENDING_PERMISSION_DENIED'; END IF;

  -- A terminal result takes precedence over the new button and expiry.
  -- An old row without outcome is uncertain, never proof that it was applied.
  IF a.consumed_at IS NULL AND a.outcome IS NULL AND a.expires_at>now() AND p_op<>'read' THEN
    IF p_op='cancel' THEN
      PERFORM public.bot_cancel_pending(p_pending_id,p_staff_telegram_id);
    ELSIF a.action='photo_main' THEN
      PERFORM public.bot_set_photo_main(p_pending_id,p_staff_telegram_id);
    ELSIF a.action='photo_reorder' THEN
      PERFORM public.bot_reorder_photo(p_pending_id,p_staff_telegram_id);
    ELSIF a.action='photo_delete' THEN
      PERFORM public.bot_delete_photo_meta(p_pending_id,p_staff_telegram_id);
    ELSE
      PERFORM public.bot_apply_pending(p_pending_id,p_staff_telegram_id);
    END IF;
    changed:=true;
    SELECT * INTO a FROM public.pending_actions WHERE id=p_pending_id;
  END IF;
  result_state:=CASE
    WHEN a.outcome IN ('applied','canceled') AND a.consumed_at IS NOT NULL THEN a.outcome
    WHEN a.consumed_at IS NOT NULL OR a.outcome IS NOT NULL THEN 'uncertain'
    WHEN a.expires_at<=now() THEN 'expired'
    ELSE 'pending' END;
  SELECT p.title INTO title FROM public.products p WHERE p.id=a.product_id;
  RETURN jsonb_build_object('state',result_state,'pending_id',a.id,'action',a.action,
    'product_id',a.product_id,'title',title,'before',a.before_value,'after',a.after_value,
    'replayed',NOT changed,'expires_at',a.expires_at);
END $operation$;
REVOKE ALL ON FUNCTION public.bot_pending_operation(bigint,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_pending_operation(bigint,uuid,text) TO service_role;
-- Keep old implementations callable only by the SECURITY DEFINER wrapper.
REVOKE ALL ON FUNCTION public.bot_apply_pending(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.bot_cancel_pending(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.bot_set_photo_main(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.bot_reorder_photo(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.bot_delete_photo_meta(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst, 'reload schema';
