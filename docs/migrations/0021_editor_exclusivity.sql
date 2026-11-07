-- One active guided editor per staff member across the ordinary and technical dialogs.
-- Additive, no row cleanup: existing conflicting drafts require an explicit human decision.
LOCK TABLE public.bot_editor_states, public.technical_editor_sessions IN SHARE ROW EXCLUSIVE MODE;
DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bot_editor_states b JOIN public.technical_editor_sessions t
      ON t.staff_telegram_id=b.staff_telegram_id
    WHERE b.consumed_at IS NULL AND b.expires_at>now()
      AND t.phase IN ('editing','preview') AND t.expires_at>now()
  ) THEN RAISE EXCEPTION 'EDITOR_EXISTING_CONFLICT'; END IF;
END $check$;

CREATE FUNCTION public.bot_editor_exclusive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $guard$
BEGIN
  IF TG_TABLE_NAME='bot_editor_states' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.expires_at<=now() THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='technical_editor_sessions' THEN
    IF NEW.phase NOT IN ('editing','preview') OR NEW.expires_at<=now() THEN RETURN NEW; END IF;
  ELSE RAISE EXCEPTION 'EDITOR_TABLE_INVALID';
  END IF;

  -- The PostgREST path is READ COMMITTED: after a competing writer releases this
  -- lock, the following query sees its committed dialog. Reject older snapshots.
  IF current_setting('transaction_isolation')<>'read committed'
    THEN RAISE EXCEPTION 'EDITOR_ISOLATION_REQUIRED'; END IF;
  -- The technical RPC already takes this same row lock before any session write.
  PERFORM 1 FROM public.staff WHERE telegram_id=NEW.staff_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EDITOR_STAFF_MISSING'; END IF;
  IF TG_TABLE_NAME='bot_editor_states' THEN
    IF EXISTS(SELECT 1 FROM public.technical_editor_sessions
      WHERE staff_telegram_id=NEW.staff_telegram_id AND phase IN ('editing','preview') AND expires_at>now())
      THEN RAISE EXCEPTION 'EDITOR_TECHNICAL_ACTIVE'; END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM public.bot_editor_states
      WHERE staff_telegram_id=NEW.staff_telegram_id AND consumed_at IS NULL AND expires_at>now())
      THEN RAISE EXCEPTION 'EDITOR_ORDINARY_ACTIVE'; END IF;
  END IF;
  RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION public.bot_editor_exclusive() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER bot_editor_exclusive_guard BEFORE INSERT OR UPDATE ON public.bot_editor_states
  FOR EACH ROW EXECUTE FUNCTION public.bot_editor_exclusive();
CREATE TRIGGER technical_editor_exclusive_guard BEFORE INSERT OR UPDATE ON public.technical_editor_sessions
  FOR EACH ROW EXECUTE FUNCTION public.bot_editor_exclusive();
COMMENT ON FUNCTION public.bot_editor_exclusive() IS
  'Serializes guided editor starts by staff row; conflicting active drafts are preserved and new input is refused.';
