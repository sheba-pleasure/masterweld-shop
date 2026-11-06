-- Run only in isolated DEV with ON_ERROR_STOP=1; all fixtures roll back.
BEGIN;
DO $$
BEGIN
 IF public.mw_environment_identity() <> '{"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}'::jsonb
 THEN RAISE EXCEPTION 'WRONG_ENVIRONMENT'; END IF;
END $$;
-- Hide other deliveries only in this transaction; no worker sees this change.
DELETE FROM public.order_notifications;
UPDATE public.staff SET active=false;
INSERT INTO public.staff (telegram_id,name,role,active,elevated) VALUES
 (42,'notification SQL fixture','seller',true,false),
 (43,'inactive SQL fixture','admin',false,false);
INSERT INTO public.shop_orders(id,name,phone,items,total) VALUES
 ('10000000-0000-4000-8000-000000000012','DEV SQL ROLLBACK','+79990000000','[]',900);
DO $$
DECLARE j public.order_notifications; n integer;
BEGIN
 SELECT count(*) INTO n FROM public.order_notifications;
 IF n <> 1 THEN RAISE EXCEPTION 'RECIPIENT_SNAPSHOT_FAILED'; END IF;
 IF EXISTS(SELECT 1 FROM public.order_notifications WHERE staff_telegram_id<>42) THEN RAISE EXCEPTION 'INACTIVE_RECIPIENT'; END IF;
 INSERT INTO public.order_notifications(order_id,staff_telegram_id)
 VALUES('10000000-0000-4000-8000-000000000012',42) ON CONFLICT DO NOTHING;
 SELECT count(*) INTO n FROM public.order_notifications;
 IF n <> 1 THEN RAISE EXCEPTION 'DUPLICATE'; END IF;
 SELECT * INTO j FROM public.claim_order_notification();
 IF j.state <> 'sending' OR j.attempts <> 1 OR j.claim_token IS NULL THEN RAISE EXCEPTION 'CLAIM_FAILED'; END IF;
 SELECT count(*) INTO n FROM public.claim_order_notification();
 IF n <> 0 THEN RAISE EXCEPTION 'RECLAIMED_INFLIGHT'; END IF;
 UPDATE public.order_notifications SET state='sent',telegram_message_id=1
 WHERE order_id=j.order_id AND staff_telegram_id=j.staff_telegram_id AND claim_token=j.claim_token;
 SELECT count(*) INTO n FROM public.claim_order_notification();
 IF n <> 0 THEN RAISE EXCEPTION 'RECLAIMED_SENT'; END IF;
 UPDATE public.order_notifications SET state='sending',claimed_at=now()-interval '6 minutes';
 SELECT count(*) INTO n FROM public.claim_order_notification();
 IF n <> 0 OR NOT EXISTS(SELECT 1 FROM public.order_notifications WHERE state='uncertain' AND reason='worker_interrupted')
 THEN RAISE EXCEPTION 'UNSAFE_CRASH_RETRY'; END IF;
 IF has_table_privilege('anon','public.order_notifications','SELECT') OR
    has_table_privilege('authenticated','public.order_notifications','UPDATE') OR
    has_function_privilege('anon','public.claim_order_notification()','EXECUTE')
 THEN RAISE EXCEPTION 'PUBLIC_ACCESS'; END IF;
END $$;
ROLLBACK;
