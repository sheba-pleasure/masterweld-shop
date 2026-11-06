-- Bot identities must not collide when Telegram assigns equal update IDs.
-- Preserve legacy staff claims: never delete/release uncertain mutations.
CREATE TABLE public.telegram_bot_updates (
  bot_id bigint NOT NULL CHECK(bot_id > 0),
  update_id bigint NOT NULL CHECK(update_id >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(bot_id, update_id)
);
ALTER TABLE public.telegram_bot_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_bot_updates FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.telegram_bot_updates TO service_role;

CREATE FUNCTION public.claim_telegram_bot_update(p_bot_id bigint,p_update_id bigint,p_legacy_staff boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_bot_id IS NULL OR p_bot_id<=0 OR p_update_id IS NULL OR p_update_id<0 OR p_legacy_staff IS NULL THEN
    RAISE EXCEPTION 'INVALID_TELEGRAM_CLAIM';
  END IF;
  IF p_legacy_staff THEN
    -- Dual-write retains replay protection even if the application is rolled back.
    INSERT INTO public.telegram_updates(update_id) VALUES(p_update_id) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;
  INSERT INTO public.telegram_bot_updates(bot_id,update_id) VALUES(p_bot_id,p_update_id)
    ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.claim_telegram_bot_update(bigint,bigint,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_telegram_bot_update(bigint,bigint,boolean) TO service_role;
NOTIFY pgrst, 'reload schema';
