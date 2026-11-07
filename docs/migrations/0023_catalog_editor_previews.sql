-- Atomic handoff from ordinary input to a recoverable preview. No backfill.
CREATE TABLE public.bot_editor_previews (
  revision uuid PRIMARY KEY,
  staff_telegram_id bigint NOT NULL REFERENCES public.staff(telegram_id),
  pending_id uuid NOT NULL UNIQUE REFERENCES public.pending_actions(id),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bot_editor_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_editor_previews FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.bot_editor_previews IS
  'Private ordinary-input receipts. A revision keeps its first preview; reading never repeats a mutation.';

CREATE FUNCTION public.bot_editor_preview(p_staff_telegram_id bigint,p_revision uuid,
  p_mode text,p_value jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $preview$
DECLARE
  s public.staff%ROWTYPE;
  e public.bot_editor_states%ROWTYPE;
  p public.products%ROWTYPE;
  r public.bot_editor_previews%ROWTYPE;
  a public.pending_actions%ROWTYPE;
  field text;
  v text;
  cat uuid;
  old_cat text;
  new_cat text;
  idx integer;
  result jsonb;
BEGIN
  IF p_revision IS NULL OR p_mode IS NULL OR p_mode NOT IN ('prepare','read')
    THEN RAISE EXCEPTION 'PREVIEW_BAD_REQUEST'; END IF;
  SELECT * INTO s FROM public.staff WHERE telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active OR NOT(s.role::text IN ('admin','seller')
    OR (s.role::text='director' AND s.elevated)) THEN RAISE EXCEPTION 'PREVIEW_PERMISSION_DENIED'; END IF;

  SELECT * INTO r FROM public.bot_editor_previews WHERE revision=p_revision;
  IF FOUND THEN
    IF r.staff_telegram_id<>p_staff_telegram_id THEN RAISE EXCEPTION 'PREVIEW_NOT_OWNER'; END IF;
    SELECT * INTO a FROM public.pending_actions WHERE id=r.pending_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PREVIEW_NOT_FOUND'; END IF;
    IF a.action='category' AND s.role::text='seller' THEN RAISE EXCEPTION 'PREVIEW_PERMISSION_DENIED'; END IF;
    RETURN r.snapshot || jsonb_build_object('replayed',true,'outcome',a.outcome,
      'consumed_at',a.consumed_at,'expired',a.expires_at<=now());
  END IF;
  IF p_mode='read' THEN RAISE EXCEPTION 'PREVIEW_NOT_FOUND'; END IF;

  SELECT * INTO e FROM public.bot_editor_states WHERE staff_telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR e.data->>'_revision' IS DISTINCT FROM p_revision::text
    OR e.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'PREVIEW_STEP_CHANGED'; END IF;
  IF e.expires_at<=now() THEN RAISE EXCEPTION 'PREVIEW_STEP_EXPIRED'; END IF;
  IF e.state='pick_cat' THEN
    IF s.role::text='seller' THEN RAISE EXCEPTION 'PREVIEW_PERMISSION_DENIED'; END IF;
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' OR p_value::text !~ '^[0-9]{1,3}$'
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    idx:=(p_value::text)::integer;
    cat:=(e.data->'cats'->idx->>'id')::uuid;
    SELECT name INTO new_cat FROM public.categories WHERE id=cat;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOT_CATEGORY_NOT_FOUND'; END IF;
    field:='category';
  ELSE
    field:=substring(e.state FROM 6);
    IF e.state NOT IN ('edit_title','edit_description','edit_specs','edit_brand','edit_sku')
      THEN RAISE EXCEPTION 'PREVIEW_STEP_CHANGED'; END IF;
    IF p_value IS NOT NULL AND jsonb_typeof(p_value) NOT IN ('string','null')
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    v:=p_value#>>'{}';
    IF (field='title' AND (v IS NULL OR char_length(v) NOT BETWEEN 3 AND 300))
      OR (field IN ('description','specs') AND char_length(v)>5000)
      OR (field='brand' AND char_length(v)>100)
      OR (field='sku' AND v IS NOT NULL AND v !~ '^[A-Za-zА-Яа-яЁё0-9._/+-]{1,60}$')
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
  END IF;
  SELECT * INTO p FROM public.products WHERE id=e.product_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PRODUCT_NOT_FOUND'; END IF;
  a.id:=gen_random_uuid();
  a.action:=field;
  IF field='category' THEN
    SELECT name INTO old_cat FROM public.categories WHERE id=p.category_id;
    a.before_value:=jsonb_build_object('category_id',p.category_id);
    a.after_value:=jsonb_build_object('category_id',cat);
  ELSE
    a.before_value:=jsonb_build_object(field,to_jsonb(p)->field);
    a.after_value:=jsonb_build_object(field,v);
  END IF;
  result:=jsonb_build_object('id',a.id,'revision',p_revision,'action',field,
    'product_id',p.id,'title',p.title,'sku',p.sku,
    'before',a.before_value,'after',a.after_value,'old_category',old_cat,'new_category',new_cat);
  INSERT INTO public.pending_actions(id,staff_telegram_id,product_id,action,before_value,after_value,expires_at)
    VALUES(a.id,p_staff_telegram_id,p.id,field,a.before_value,a.after_value,now()+interval '15 minutes');
  INSERT INTO public.bot_editor_previews(revision,staff_telegram_id,pending_id,snapshot)
    VALUES(p_revision,p_staff_telegram_id,a.id,result);
  UPDATE public.bot_editor_states SET consumed_at=now() WHERE staff_telegram_id=p_staff_telegram_id;
  RETURN result || jsonb_build_object('replayed',false,'outcome',NULL,'consumed_at',NULL,'expired',false);
END $preview$;
REVOKE ALL ON FUNCTION public.bot_editor_preview(bigint,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_editor_preview(bigint,uuid,text,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
