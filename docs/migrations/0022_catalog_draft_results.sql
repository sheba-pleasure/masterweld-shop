-- Durable result for a single confirmed ordinary catalog draft.
-- No backfill: historical products and unfinished inputs remain unchanged.
CREATE TABLE public.bot_draft_results (
  revision uuid PRIMARY KEY,
  staff_telegram_id bigint NOT NULL REFERENCES public.staff(telegram_id),
  outcome text NOT NULL CHECK (outcome IN ('created','canceled')),
  product_id uuid REFERENCES public.products(id),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome='created')=(product_id IS NOT NULL))
);
ALTER TABLE public.bot_draft_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_draft_results FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.bot_draft_results IS
  'Private immutable draft outcomes. Same revision returns the same result after response loss or restart.';

CREATE FUNCTION public.bot_finish_draft(p_staff_telegram_id bigint,p_revision uuid,p_accept boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $finish$
DECLARE
  s public.staff%ROWTYPE;
  e public.bot_editor_states%ROWTYPE;
  receipt public.bot_draft_results%ROWTYPE;
  answer jsonb;
  v_sku text;
  price numeric;
BEGIN
  IF p_revision IS NULL OR p_accept IS NULL THEN RAISE EXCEPTION 'DRAFT_BAD_REQUEST'; END IF;
  -- Same edit_products rule as permissions.ts, checked again under a staff row lock.
  SELECT * INTO s FROM public.staff WHERE telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active OR NOT(s.role::text IN ('admin','seller')
    OR (s.role::text='director' AND s.elevated)) THEN RAISE EXCEPTION 'DRAFT_PERMISSION_DENIED'; END IF;

  SELECT * INTO receipt FROM public.bot_draft_results WHERE revision=p_revision;
  IF FOUND THEN
    IF receipt.staff_telegram_id<>p_staff_telegram_id THEN RAISE EXCEPTION 'DRAFT_NOT_OWNER'; END IF;
    RETURN receipt.result || jsonb_build_object('replayed',true);
  END IF;

  SELECT * INTO e FROM public.bot_editor_states WHERE staff_telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR e.state<>'new_confirm' OR e.data->>'_revision' IS DISTINCT FROM p_revision::text
    THEN RAISE EXCEPTION 'DRAFT_STEP_CHANGED'; END IF;
  IF e.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'DRAFT_STEP_CONSUMED'; END IF;
  IF e.expires_at<=now() THEN RAISE EXCEPTION 'DRAFT_STEP_EXPIRED'; END IF;

  IF p_accept THEN
    IF jsonb_typeof(e.data->'title') IS DISTINCT FROM 'string'
      OR jsonb_typeof(e.data->'price') IS DISTINCT FROM 'number'
      OR (e.data ? 'sku' AND jsonb_typeof(e.data->'sku') NOT IN ('string','null'))
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    v_sku:=nullif(btrim(e.data->>'sku'),'');
    IF v_sku IS NOT NULL AND v_sku !~ '^[A-Za-zА-Яа-яЁё0-9._/+-]{1,60}$'
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    price:=(e.data->>'price')::numeric;
    -- The importer uses the same table lock. Serialize SKU/slug decisions with all
    -- product writes, including different staff and imports; no guessed uniqueness.
    LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
    IF v_sku IS NOT NULL AND EXISTS(SELECT 1 FROM public.products p WHERE lower(btrim(p.sku))=lower(v_sku))
      THEN RAISE EXCEPTION 'BOT_SKU_DUPLICATE'; END IF;
    answer:=public.bot_create_draft(p_staff_telegram_id,e.data->>'title',v_sku,price);
    answer:=answer || jsonb_build_object('outcome','created','revision',p_revision);
  ELSE
    answer:=jsonb_build_object('ok',true,'outcome','canceled','revision',p_revision);
  END IF;

  INSERT INTO public.bot_draft_results(revision,staff_telegram_id,outcome,product_id,result)
    VALUES(p_revision,p_staff_telegram_id,answer->>'outcome',(answer->>'product_id')::uuid,answer);
  UPDATE public.bot_editor_states SET consumed_at=now() WHERE staff_telegram_id=p_staff_telegram_id;
  RETURN answer || jsonb_build_object('replayed',false);
END $finish$;
REVOKE ALL ON FUNCTION public.bot_finish_draft(bigint,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_finish_draft(bigint,uuid,boolean) TO service_role;
-- The old service entry point has no receipt. Keep its implementation for the
-- atomic wrapper, but stop old app versions from bypassing the durable result.
REVOKE ALL ON FUNCTION public.bot_create_draft(bigint,text,text,numeric) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst, 'reload schema';
