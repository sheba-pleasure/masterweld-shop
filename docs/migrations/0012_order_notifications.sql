-- 0012: durable per-order/per-staff notifications. DEV first; production requires release review.
-- No historical backfill. The order and recipient snapshot commit atomically.
CREATE TABLE public.order_notifications (
  order_id uuid NOT NULL REFERENCES public.shop_orders(id) ON DELETE CASCADE,
  staff_telegram_id bigint NOT NULL CHECK (staff_telegram_id > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','skipped','failed','uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  telegram_message_id bigint,
  reason text CHECK (reason IN ('no_access','order_not_new','rate_limit','delivery_rejected','delivery_uncertain','worker_interrupted','read_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, staff_telegram_id)
);
ALTER TABLE public.order_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.order_notifications TO service_role;
CREATE INDEX order_notifications_pending ON public.order_notifications (available_at, created_at) WHERE state = 'pending';

CREATE FUNCTION public.enqueue_order_notifications() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Snapshot identities only. The worker uses permissions.ts for authorization at dispatch.
  INSERT INTO public.order_notifications (order_id, staff_telegram_id)
    SELECT NEW.id, telegram_id FROM public.staff WHERE active AND telegram_id > 0
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_order_notifications() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER shop_order_notifications AFTER INSERT ON public.shop_orders
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_order_notifications();

CREATE FUNCTION public.claim_order_notification() RETURNS SETOF public.order_notifications
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_order uuid; v_staff bigint;
BEGIN
  -- A crashed worker may already have sent the message. Never replay an abandoned send.
  UPDATE public.order_notifications SET state='uncertain', reason='worker_interrupted', updated_at=now()
    WHERE state='sending' AND claimed_at < now() - interval '5 minutes';
  SELECT order_id, staff_telegram_id INTO v_order, v_staff
    FROM public.order_notifications
    WHERE state='pending' AND available_at <= now() AND attempts < 3
    ORDER BY available_at, created_at, order_id, staff_telegram_id
    LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY UPDATE public.order_notifications
    SET state='sending', attempts=attempts+1, claim_token=gen_random_uuid(),
        claimed_at=now(), updated_at=now()
    WHERE order_id=v_order AND staff_telegram_id=v_staff RETURNING *;
END $$;
REVOKE ALL ON FUNCTION public.claim_order_notification() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_notification() TO service_role;
NOTIFY pgrst, 'reload schema';
