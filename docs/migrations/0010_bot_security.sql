-- REVIEW ONLY / НЕ ПРИМЕНЕНА. Requires 0000 + 0003. No new tables or row changes.
-- QA 26.10.2026: search_path pinned to "public, pg_temp" (pg_temp last) so a caller cannot shadow tables via temp objects.
-- Atomic order status + both journals. The service-only caller has verified
-- Telegram signature and private actor; DB rechecks active role under lock.
CREATE OR REPLACE FUNCTION public.bot_change_order_status(
  p_order_id uuid, p_staff_telegram_id bigint,
  p_expected_status public.order_status, p_next_status public.order_status
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_staff public.staff%ROWTYPE;
  v_order public.shop_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_staff FROM public.staff WHERE telegram_id = p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT v_staff.active OR v_staff.role::text NOT IN ('admin','director','seller') THEN
    RAISE EXCEPTION 'BOT_DENIED';
  END IF;
  SELECT * INTO v_order FROM public.shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'BOT_ORDER_CONFLICT';
  END IF;
  IF p_next_status IS NULL OR NOT (
    (v_order.status = 'new' AND p_next_status IN ('processing','canceled')) OR
    (v_order.status = 'processing' AND p_next_status IN ('ready','canceled')) OR
    (v_order.status = 'ready' AND p_next_status IN ('completed','canceled'))
  ) THEN RAISE EXCEPTION 'BOT_ORDER_TRANSITION'; END IF;
  UPDATE public.shop_orders SET status = p_next_status WHERE id = p_order_id;
  INSERT INTO public.staff_audit_log (telegram_id, action, details)
    VALUES (p_staff_telegram_id, 'order_status', jsonb_build_object(
      'order_id', p_order_id, 'from', p_expected_status, 'to', p_next_status));
  INSERT INTO public.order_events (order_id, from_status, to_status, staff_telegram_id)
    VALUES (p_order_id, p_expected_status, p_next_status, p_staff_telegram_id);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.bot_change_order_status(uuid,bigint,public.order_status,public.order_status) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_change_order_status(uuid,bigint,public.order_status,public.order_status) TO service_role;

-- Same permission as toggle_full_access in permissions.ts: active director only.
CREATE OR REPLACE FUNCTION public.bot_toggle_elevated(
  p_staff_telegram_id bigint, p_expected_elevated boolean, p_elevated boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_staff public.staff%ROWTYPE;
BEGIN
  SELECT * INTO v_staff FROM public.staff WHERE telegram_id = p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT v_staff.active OR v_staff.role::text <> 'director' THEN
    RAISE EXCEPTION 'BOT_DENIED';
  END IF;
  IF p_elevated IS NULL OR v_staff.elevated IS DISTINCT FROM p_expected_elevated THEN
    RAISE EXCEPTION 'BOT_ELEVATION_CONFLICT';
  END IF;
  UPDATE public.staff SET elevated = p_elevated WHERE telegram_id = p_staff_telegram_id;
  INSERT INTO public.staff_audit_log (telegram_id, action)
    VALUES (p_staff_telegram_id, CASE WHEN p_elevated THEN 'full_access_on' ELSE 'full_access_off' END);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.bot_toggle_elevated(bigint,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_toggle_elevated(bigint,boolean,boolean) TO service_role;