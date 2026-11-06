-- DEV first. Apply explicitly after backup/rehearsal; never during application release.
-- Assortment intent is independent of publication. Existing products remain visible as before.
ALTER TABLE public.products ADD COLUMN assortment_decision text NOT NULL DEFAULT 'review'
  CHECK (assortment_decision IN ('review','sell','excluded'));
ALTER TABLE public.products ADD COLUMN assortment_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.products ADD CONSTRAINT excluded_products_hidden
  CHECK (assortment_decision <> 'excluded' OR status = 'hidden');
CREATE FUNCTION public.bump_assortment_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.assortment_revision := OLD.assortment_revision + 1; RETURN NEW; END $$;
CREATE TRIGGER products_assortment_revision BEFORE UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.bump_assortment_revision();

CREATE TABLE public.assortment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_telegram_id bigint NOT NULL,
  query text NOT NULL DEFAULT '',
  decision_filter text NOT NULL,
  state text NOT NULL DEFAULT 'selecting'
    CHECK (state IN ('selecting','preview','applied','undo_preview','undone','canceled')),
  action text CHECK (action IN ('sell','exclude','review','hide')),
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  applied_at timestamptz
);
CREATE INDEX assortment_batches_actor ON public.assortment_batches(staff_telegram_id,created_at DESC);
CREATE TABLE public.assortment_batch_items (
  batch_id uuid NOT NULL REFERENCES public.assortment_batches(id),
  position integer NOT NULL,
  -- Intentionally no cascading product FK: retain evidence if a future purge is approved.
  product_id uuid NOT NULL,
  title text NOT NULL,
  sku text,
  category text,
  selected boolean NOT NULL DEFAULT false,
  before_decision text NOT NULL,
  before_status public.product_status NOT NULL,
  before_revision bigint NOT NULL,
  after_revision bigint,
  PRIMARY KEY(batch_id,position),
  UNIQUE(batch_id,product_id)
);
ALTER TABLE public.assortment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assortment_batch_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assortment_batches, public.assortment_batch_items FROM PUBLIC,anon,authenticated,service_role;
-- Only the RPC may write these tables, even with a service key.
GRANT SELECT ON public.assortment_batches, public.assortment_batch_items TO service_role;

CREATE FUNCTION public.bot_assortment(
  p_staff_telegram_id bigint, p_op text,
  p_batch_id uuid DEFAULT NULL, p_value text DEFAULT '',
  p_page integer DEFAULT 0, p_query text DEFAULT '', p_revision integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.staff%ROWTYPE;
  b public.assortment_batches%ROWTYPE;
  n integer; chosen integer; pg integer; changed integer := 0;
  entries jsonb; counts jsonb; recent jsonb;
BEGIN
  -- Mirrors manage_assortment in permissions.ts, checked again under a row lock.
  SELECT * INTO s FROM public.staff WHERE telegram_id=p_staff_telegram_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active OR NOT (s.role::text='admin' OR (s.role::text='director' AND s.elevated)) THEN
    RAISE EXCEPTION 'ASSORT_DENIED';
  END IF;
  IF p_op IS NULL OR p_value IS NULL OR p_page IS NULL OR p_page<0 OR p_page>624 THEN
    RAISE EXCEPTION 'ASSORT_BAD_INPUT';
  END IF;
  IF p_op='home' THEN
    SELECT jsonb_build_object('review',count(*) FILTER(WHERE assortment_decision='review'),
      'sell',count(*) FILTER(WHERE assortment_decision='sell'),
      'excluded',count(*) FILTER(WHERE assortment_decision='excluded')) INTO counts FROM public.products;
    SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO recent FROM (
      SELECT id,state,action,created_at FROM public.assortment_batches
      WHERE staff_telegram_id=p_staff_telegram_id AND state<>'canceled'
      ORDER BY created_at DESC,id LIMIT 5
    ) r;
    RETURN jsonb_build_object('ok',true,'home',true,'counts',counts,'recent',recent);
  ELSIF p_op='start' THEN
    IF p_value NOT IN ('review','sell','excluded','all') OR p_query IS NULL OR length(p_query)>120 THEN
      RAISE EXCEPTION 'ASSORT_BAD_INPUT';
    END IF;
    -- One active selection/preview per actor; creating a new one invalidates old buttons.
    UPDATE public.assortment_batches SET state='canceled'
      WHERE staff_telegram_id=p_staff_telegram_id AND state IN ('selecting','preview');
    INSERT INTO public.assortment_batches(staff_telegram_id,query,decision_filter)
      VALUES(p_staff_telegram_id,btrim(p_query),p_value) RETURNING * INTO b;
    INSERT INTO public.assortment_batch_items(batch_id,position,product_id,title,sku,category,
      before_decision,before_status,before_revision)
    SELECT b.id,row_number() OVER(ORDER BY p.title,p.id),p.id,p.title,p.sku,c.name,
      p.assortment_decision,p.status,p.assortment_revision
    FROM public.products p LEFT JOIN public.categories c ON c.id=p.category_id
    WHERE (p_value='all' OR p.assortment_decision=p_value) AND NOT EXISTS (
      SELECT 1 FROM regexp_split_to_table(lower(btrim(p_query)), '\s+') word
      WHERE word<>'' AND strpos(lower(concat_ws(' ',p.title,p.sku,p.brand,c.name)),word)=0
    )
    ORDER BY p.title,p.id LIMIT 5001;
    SELECT count(*) INTO n FROM public.assortment_batch_items WHERE batch_id=b.id;
    IF n>5000 THEN RAISE EXCEPTION 'ASSORT_TOO_MANY'; END IF;
  ELSE
    SELECT * INTO b FROM public.assortment_batches WHERE id=p_batch_id FOR UPDATE;
    IF NOT FOUND OR b.staff_telegram_id<>p_staff_telegram_id THEN RAISE EXCEPTION 'ASSORT_NOT_FOUND'; END IF;
    IF p_op NOT IN ('get','select','unselect','all','none','preview','apply','cancel','undo_preview','undo') THEN
      RAISE EXCEPTION 'ASSORT_BAD_INPUT';
    END IF;
    IF p_op='cancel' AND b.state IN ('selecting','preview') THEN
      UPDATE public.assortment_batches SET state='canceled' WHERE id=b.id;
    ELSIF p_op IN ('select','unselect','all','none','preview') THEN
      IF b.state<>'selecting' THEN RAISE EXCEPTION 'ASSORT_CLOSED'; END IF;
      IF b.expires_at<now() THEN RAISE EXCEPTION 'ASSORT_EXPIRED'; END IF;
      IF p_op IN ('select','unselect') THEN
        IF p_value !~ '^[1-9][0-9]{0,3}$' THEN RAISE EXCEPTION 'ASSORT_BAD_INPUT'; END IF;
        UPDATE public.assortment_batch_items SET selected=(p_op='select')
          WHERE batch_id=b.id AND position=p_value::integer;
        IF NOT FOUND THEN RAISE EXCEPTION 'ASSORT_BAD_INPUT'; END IF;
      ELSIF p_op IN ('all','none') THEN
        UPDATE public.assortment_batch_items SET selected=(p_op='all') WHERE batch_id=b.id;
      ELSE
        IF p_value NOT IN ('sell','exclude','review','hide') OR p_revision IS DISTINCT FROM b.revision THEN
          RAISE EXCEPTION 'ASSORT_STALE';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.assortment_batch_items WHERE batch_id=b.id AND selected) THEN
          RAISE EXCEPTION 'ASSORT_EMPTY';
        END IF;
        UPDATE public.assortment_batches SET state='preview',action=p_value,expires_at=now()+interval '30 minutes' WHERE id=b.id;
      END IF;
      UPDATE public.assortment_batches SET revision=revision+1 WHERE id=b.id;
    ELSIF p_op='apply' AND b.state NOT IN ('applied','undo_preview','undone') THEN
      IF b.state<>'preview' THEN RAISE EXCEPTION 'ASSORT_CLOSED'; END IF;
      IF b.expires_at<now() THEN RAISE EXCEPTION 'ASSORT_EXPIRED'; END IF;
      -- Stable order prevents lock inversions between administrators.
      PERFORM p.id FROM public.products p JOIN public.assortment_batch_items i ON i.product_id=p.id
        WHERE i.batch_id=b.id AND i.selected ORDER BY p.id FOR UPDATE OF p;
      IF EXISTS(SELECT 1 FROM public.assortment_batch_items i LEFT JOIN public.products p ON p.id=i.product_id
        WHERE i.batch_id=b.id AND i.selected AND (p.id IS NULL OR p.assortment_revision<>i.before_revision)) THEN
        RAISE EXCEPTION 'ASSORT_CONFLICT';
      END IF;
      UPDATE public.products p SET
        assortment_decision=CASE b.action WHEN 'sell' THEN 'sell' WHEN 'exclude' THEN 'excluded' WHEN 'review' THEN 'review' ELSE p.assortment_decision END,
        status=CASE b.action WHEN 'exclude' THEN 'hidden'::public.product_status WHEN 'hide' THEN 'hidden'::public.product_status
          WHEN 'review' THEN 'draft'::public.product_status ELSE p.status END
      FROM public.assortment_batch_items i WHERE i.batch_id=b.id AND i.selected AND p.id=i.product_id;
      GET DIAGNOSTICS changed=ROW_COUNT;
      UPDATE public.assortment_batch_items i SET after_revision=p.assortment_revision
        FROM public.products p WHERE i.batch_id=b.id AND i.selected AND p.id=i.product_id;
      UPDATE public.assortment_batches SET state='applied',applied_at=now() WHERE id=b.id;
      INSERT INTO public.staff_audit_log(telegram_id,action,details) VALUES(p_staff_telegram_id,'assortment_apply',
        jsonb_build_object('batch_id',b.id,'action',b.action,'count',changed));
    ELSIF p_op='undo_preview' THEN
      IF b.state NOT IN ('applied','undo_preview') THEN RAISE EXCEPTION 'ASSORT_CLOSED'; END IF;
      IF b.applied_at<now()-interval '7 days' THEN RAISE EXCEPTION 'ASSORT_EXPIRED'; END IF;
      UPDATE public.assortment_batches SET state='undo_preview',expires_at=now()+interval '30 minutes' WHERE id=b.id;
    ELSIF p_op='undo' AND b.state<>'undone' THEN
      IF b.state<>'undo_preview' THEN RAISE EXCEPTION 'ASSORT_CLOSED'; END IF;
      IF b.expires_at<now() OR b.applied_at<now()-interval '7 days' THEN RAISE EXCEPTION 'ASSORT_EXPIRED'; END IF;
      PERFORM p.id FROM public.products p JOIN public.assortment_batch_items i ON i.product_id=p.id
        WHERE i.batch_id=b.id AND i.selected ORDER BY p.id FOR UPDATE OF p;
      IF EXISTS(SELECT 1 FROM public.assortment_batch_items i LEFT JOIN public.products p ON p.id=i.product_id
        WHERE i.batch_id=b.id AND i.selected AND (p.id IS NULL OR p.assortment_revision IS DISTINCT FROM i.after_revision)) THEN
        RAISE EXCEPTION 'ASSORT_CONFLICT';
      END IF;
      -- Re-publication is only safe while the original card is still ready.
      IF EXISTS(SELECT 1 FROM public.assortment_batch_items i JOIN public.products p ON p.id=i.product_id
        WHERE i.batch_id=b.id AND i.selected AND i.before_status='published' AND
        (length(btrim(p.title))<3 OR p.price<=0 OR NOT EXISTS(
          SELECT 1 FROM public.product_photos f WHERE f.product_id=p.id AND f.deleted_at IS NULL))) THEN
        RAISE EXCEPTION 'ASSORT_NOT_READY';
      END IF;
      UPDATE public.products p SET assortment_decision=i.before_decision,status=i.before_status
        FROM public.assortment_batch_items i WHERE i.batch_id=b.id AND i.selected AND p.id=i.product_id;
      GET DIAGNOSTICS changed=ROW_COUNT;
      UPDATE public.assortment_batches SET state='undone' WHERE id=b.id;
      INSERT INTO public.staff_audit_log(telegram_id,action,details) VALUES(p_staff_telegram_id,'assortment_undo',
        jsonb_build_object('batch_id',b.id,'count',changed));
    END IF;
  END IF;
  SELECT * INTO b FROM public.assortment_batches WHERE id=b.id;
  SELECT count(*),count(*) FILTER(WHERE selected) INTO n,chosen FROM public.assortment_batch_items WHERE batch_id=b.id;
  -- Preview pages show only selected rows, with the complete count and frozen scope.
  pg:=least(p_page,greatest(0,((CASE WHEN b.state='selecting' THEN n ELSE chosen END)-1)/8));
  SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO entries FROM (
    SELECT position,title,sku,category,selected,before_decision,before_status
    FROM public.assortment_batch_items WHERE batch_id=b.id AND (b.state='selecting' OR selected)
    ORDER BY position OFFSET pg*8 LIMIT 8
  ) r;
  SELECT jsonb_build_object(
    'published',count(*) FILTER(WHERE selected AND before_status='published'),
    'hidden',count(*) FILTER(WHERE selected AND before_status='hidden'),
    'draft',count(*) FILTER(WHERE selected AND before_status='draft')) INTO counts
    FROM public.assortment_batch_items WHERE batch_id=b.id;
  RETURN jsonb_build_object('ok',true,'id',b.id,'state',b.state,'action',b.action,'query',b.query,
    'filter',b.decision_filter,'revision',b.revision,'total',n,'selected',chosen,'counts',counts,
    'page',pg,'pages',greatest(1,ceil((CASE WHEN b.state='selecting' THEN n ELSE chosen END)/8.0)),
    'items',entries,'expiresAt',b.expires_at);
END $$;
REVOKE ALL ON FUNCTION public.bot_assortment(bigint,text,uuid,text,integer,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_assortment(bigint,text,uuid,text,integer,text,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
