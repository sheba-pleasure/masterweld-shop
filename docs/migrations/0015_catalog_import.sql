-- DEV first, explicit backup/rehearsal required. Runtime never applies migrations.
-- Supersedes the unconnected 0008 price-only mutation path; retains its history.
REVOKE EXECUTE ON FUNCTION public.bot_import_create_batch(bigint,text,text,text,jsonb,jsonb),
 public.bot_import_approve(uuid,bigint), public.bot_import_apply(uuid,bigint),
 public.bot_import_rollback(uuid,bigint) FROM service_role;
REVOKE INSERT,UPDATE,DELETE ON public.import_batches,public.import_rows,public.import_events FROM service_role;

CREATE INDEX products_import_sku ON public.products(lower(btrim(sku)));
CREATE TABLE public.catalog_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 staff_telegram_id bigint NOT NULL,
 request_key text NOT NULL,
 file_name text NOT NULL,
 checksum text NOT NULL,
 source jsonb NOT NULL,
 mapping jsonb NOT NULL,
 decimal_format text NOT NULL DEFAULT 'comma' CHECK(decimal_format IN ('comma','dot')),
 state text NOT NULL DEFAULT 'config' CHECK(state IN ('config','preview','applied','undo_preview','undone','canceled')),
 revision integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 applied_at timestamptz,
 UNIQUE(staff_telegram_id,request_key)
);
CREATE INDEX catalog_imports_actor ON public.catalog_imports(staff_telegram_id,created_at DESC);
CREATE TABLE public.catalog_import_items (
 batch_id uuid NOT NULL REFERENCES public.catalog_imports(id),
 line integer NOT NULL,
 sku text NOT NULL,
 product_id uuid,
 kind text NOT NULL CHECK(kind IN ('new','update','unchanged','error')),
 errors jsonb NOT NULL DEFAULT '[]',
 patch jsonb NOT NULL,
 before_product jsonb,
 after_product jsonb,
 before_cost jsonb,
 after_cost jsonb,
 PRIMARY KEY(batch_id,line)
);
ALTER TABLE public.catalog_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_import_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_imports,public.catalog_import_items FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.catalog_imports,public.catalog_import_items TO service_role;

CREATE FUNCTION public.bot_catalog_import(
 p_actor bigint, p_op text, p_id uuid DEFAULT NULL, p_payload jsonb DEFAULT '{}',
 p_page integer DEFAULT 0, p_revision integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 s public.staff%ROWTYPE; b public.catalog_imports%ROWTYPE; p public.products%ROWTYPE;
 i public.catalog_import_items%ROWTYPE;
 x jsonb; v jsonb; errs jsonb; bp jsonb; ap jsonb; bc jsonb; ac jsonb;
 dup text[]; key text; val jsonb; cat uuid; matches integer; n integer; pg integer;
 entries jsonb; counts jsonb; recent jsonb; v_kind text;
BEGIN
 SELECT * INTO s FROM public.staff WHERE telegram_id=p_actor FOR UPDATE;
 -- import_prices + view_costs: raw files may contain purchase costs even in unmapped columns.
 IF NOT FOUND OR NOT s.active OR NOT(s.role::text='admin' OR (s.role::text='director' AND s.elevated)) THEN
   RAISE EXCEPTION 'IMPORT_DENIED';
 END IF;
 IF p_op IS NULL OR p_page IS NULL OR p_page<0 OR p_page>1666 OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN
   RAISE EXCEPTION 'IMPORT_BAD_INPUT';
 END IF;
 IF p_op='home' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO recent FROM (
     SELECT id,file_name,state,created_at FROM public.catalog_imports
     WHERE staff_telegram_id=p_actor ORDER BY created_at DESC,id LIMIT 5
   ) r;
   RETURN jsonb_build_object('ok',true,'home',true,'recent',recent);
 ELSIF p_op='upload' THEN
   IF coalesce(p_payload->>'request_key','') !~ '^[0-9]{1,18}$' OR coalesce(p_payload->>'checksum','') !~ '^[0-9a-f]{64}$'
      OR length(coalesce(p_payload->>'file_name','')) NOT BETWEEN 1 AND 200
      OR jsonb_typeof(p_payload->'source'->'header') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_payload->'source'->'rows') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_payload->'mapping') IS DISTINCT FROM 'object'
      OR octet_length(p_payload::text)>4500000 THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
   IF jsonb_array_length(p_payload->'source'->'rows') NOT BETWEEN 1 AND 5000 OR
      jsonb_array_length(p_payload->'source'->'header') NOT BETWEEN 2 AND 30 THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
   SELECT * INTO b FROM public.catalog_imports WHERE staff_telegram_id=p_actor AND request_key=p_payload->>'request_key';
   IF FOUND THEN
     IF b.checksum<>p_payload->>'checksum' THEN RAISE EXCEPTION 'IMPORT_CONFLICT'; END IF;
   ELSE
     INSERT INTO public.catalog_imports(staff_telegram_id,request_key,file_name,checksum,source,mapping)
       VALUES(p_actor,p_payload->>'request_key',p_payload->>'file_name',p_payload->>'checksum',p_payload->'source',p_payload->'mapping')
       RETURNING * INTO b;
   END IF;
 ELSE
   SELECT * INTO b FROM public.catalog_imports WHERE id=p_id FOR UPDATE;
   IF NOT FOUND OR b.staff_telegram_id<>p_actor THEN RAISE EXCEPTION 'IMPORT_NOT_FOUND'; END IF;
   IF p_op NOT IN ('get','source','map','decimal','preview','apply','cancel','undo_preview','undo') THEN
     RAISE EXCEPTION 'IMPORT_BAD_INPUT';
   END IF;
   IF p_op IN ('map','decimal','preview') THEN
     IF b.state NOT IN ('config','preview') THEN RAISE EXCEPTION 'IMPORT_CLOSED'; END IF;
     IF b.expires_at<now() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
     IF p_revision IS DISTINCT FROM b.revision THEN RAISE EXCEPTION 'IMPORT_STALE'; END IF;
   END IF;
   IF p_op='source' THEN
     IF b.state NOT IN ('config','preview') THEN RAISE EXCEPTION 'IMPORT_CLOSED'; END IF;
     RETURN jsonb_build_object('ok',true,'id',b.id,'source',b.source,'mapping',b.mapping,'decimal',b.decimal_format,'revision',b.revision);
   ELSIF p_op='cancel' AND b.state IN ('config','preview') THEN
     UPDATE public.catalog_imports SET state='canceled' WHERE id=b.id;
   ELSIF p_op='map' THEN
     key:=p_payload->>'field';
     IF key IS NULL OR key NOT IN ('sku','title','brand','price','cost_price','in_stock','stock_qty','category_slug')
       OR coalesce(p_payload->>'column','') !~ '^(-1|[0-9]{1,2})$'
       OR (p_payload->>'column')::integer>=jsonb_array_length(b.source->'header') THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
     UPDATE public.catalog_imports SET mapping=jsonb_set(mapping,ARRAY[key],p_payload->'column'),state='config',revision=revision+1 WHERE id=b.id;
     DELETE FROM public.catalog_import_items WHERE batch_id=b.id;
   ELSIF p_op='decimal' THEN
     IF coalesce(p_payload->>'decimal','') NOT IN ('comma','dot') THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
     UPDATE public.catalog_imports SET decimal_format=p_payload->>'decimal',state='config',revision=revision+1 WHERE id=b.id;
     DELETE FROM public.catalog_import_items WHERE batch_id=b.id;
   ELSIF p_op='preview' THEN
     IF jsonb_typeof(p_payload->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
     IF jsonb_array_length(p_payload->'rows') NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
     -- Consistent snapshot of products and private costs. Readers are not blocked.
     LOCK TABLE public.products,public.product_costs IN SHARE ROW EXCLUSIVE MODE;
     DELETE FROM public.catalog_import_items WHERE batch_id=b.id;
     SELECT array_agg(k) INTO dup FROM (
       SELECT lower(btrim(e->>'sku')) k FROM jsonb_array_elements(p_payload->'rows') e
       GROUP BY lower(btrim(e->>'sku')) HAVING count(*)>1
     ) duplicates;
     FOR x IN SELECT * FROM jsonb_array_elements(p_payload->'rows') LOOP
       IF jsonb_typeof(x->'values') IS DISTINCT FROM 'object' OR jsonb_typeof(x->'errors') IS DISTINCT FROM 'array'
         OR coalesce(x->>'line','') !~ '^[0-9]{1,4}$' OR (x->>'line')::integer NOT BETWEEN 2 AND 5001
         THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
       v:=x->'values'; errs:=x->'errors'; bp:=NULL; ap:=NULL; bc:=NULL; ac:=NULL; cat:=NULL;
       IF coalesce(x->>'sku','') !~ '^[A-Za-zА-Яа-яЁё0-9._/+-]{1,60}$' THEN errs:=errs||'"BAD_SKU"'::jsonb; END IF;
       IF lower(btrim(x->>'sku'))=ANY(dup) THEN errs:=errs||'"DUPLICATE_SKU"'::jsonb; END IF;
       FOR key,val IN SELECT * FROM jsonb_each(v) LOOP
         IF key NOT IN ('title','brand','price','cost_price','in_stock','stock_qty','category_slug') THEN
           RAISE EXCEPTION 'IMPORT_BAD_INPUT';
         ELSIF key IN ('price','cost_price') THEN
           IF jsonb_typeof(val)<>'number' OR val::text !~ '^[0-9]+(\.[0-9]{1,2})?$'
             OR val::text::numeric<=0 OR val::text::numeric>10000000 THEN errs:=errs||'"BAD_PRICE"'::jsonb; END IF;
         ELSIF key='in_stock' THEN
           IF jsonb_typeof(val)<>'boolean' THEN errs:=errs||'"BAD_STOCK"'::jsonb; END IF;
         ELSIF key='stock_qty' THEN
           IF jsonb_typeof(val)<>'number' OR val::text !~ '^[0-9]+$' OR val::text::numeric>1000000 THEN errs:=errs||'"BAD_QTY"'::jsonb; END IF;
         ELSE
           IF jsonb_typeof(val)<>'string' OR length(v->>key)>(CASE WHEN key='title' THEN 200 WHEN key='brand' THEN 100 ELSE 120 END)
             OR length(btrim(v->>key))<(CASE WHEN key='title' THEN 3 ELSE 1 END) THEN errs:=errs||'"BAD_TEXT"'::jsonb; END IF;
         END IF;
       END LOOP;
       IF v ? 'stock_qty' AND jsonb_array_length(errs)=0 THEN
         IF NOT(v ? 'in_stock') OR (v->>'in_stock')::boolean<>((v->>'stock_qty')::integer>0) THEN errs:=errs||'"STOCK_CONFLICT"'::jsonb; END IF;
       END IF;
       IF v ? 'category_slug' THEN
         SELECT id INTO cat FROM public.categories WHERE slug=v->>'category_slug';
         IF NOT FOUND THEN errs:=errs||'"CATEGORY_NOT_FOUND"'::jsonb; END IF;
       END IF;
       SELECT count(*) INTO matches FROM public.products WHERE lower(btrim(sku))=lower(btrim(x->>'sku'));
       IF matches>1 THEN errs:=errs||'"AMBIGUOUS_SKU"'::jsonb;
       ELSIF matches=1 THEN
         SELECT * INTO p FROM public.products WHERE lower(btrim(sku))=lower(btrim(x->>'sku'));
         bp:=to_jsonb(p);
         SELECT to_jsonb(c) INTO bc FROM public.product_costs c WHERE product_id=p.id;
       END IF;
       IF bp IS NULL AND (NOT(v ? 'title') OR NOT(v ? 'price')) THEN errs:=errs||'"NEW_REQUIRED"'::jsonb; END IF;
       ap:=coalesce(bp,jsonb_build_object('id',gen_random_uuid(),'sku',x->>'sku','title','',
         'brand',NULL,'category_id',NULL,'price',0,'in_stock',false,'stock_qty',NULL,
         'status','draft','assortment_decision','review'))||(v-'cost_price'-'category_slug');
       IF v ? 'category_slug' THEN ap:=ap||jsonb_build_object('category_id',cat); END IF;
       ac:=CASE WHEN v ? 'cost_price' THEN jsonb_build_object('cost_price',v->'cost_price') ELSE bc END;
       v_kind:=CASE WHEN jsonb_array_length(errs)>0 THEN 'error' WHEN bp IS NULL THEN 'new'
         WHEN ap=bp AND (NOT(v ? 'cost_price') OR ac->'cost_price'=bc->'cost_price') THEN 'unchanged' ELSE 'update' END;
       INSERT INTO public.catalog_import_items(batch_id,line,sku,product_id,kind,errors,patch,before_product,after_product,before_cost,after_cost)
         VALUES(b.id,(x->>'line')::integer,left(coalesce(x->>'sku',''),60),(ap->>'id')::uuid,v_kind,errs,v,bp,ap,bc,ac);
     END LOOP;
     UPDATE public.catalog_imports SET state='preview',revision=revision+1,expires_at=now()+interval '30 minutes' WHERE id=b.id;
   ELSIF p_op='apply' AND b.state NOT IN ('applied','undo_preview','undone') THEN
     IF b.state<>'preview' THEN RAISE EXCEPTION 'IMPORT_CLOSED'; END IF;
     IF p_revision IS DISTINCT FROM b.revision THEN RAISE EXCEPTION 'IMPORT_STALE'; END IF;
     IF b.expires_at<now() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
     IF EXISTS(SELECT 1 FROM public.catalog_import_items WHERE batch_id=b.id AND kind='error')
       OR NOT EXISTS(SELECT 1 FROM public.catalog_import_items WHERE batch_id=b.id AND kind IN ('new','update')) THEN RAISE EXCEPTION 'IMPORT_BLOCKED'; END IF;
     -- Includes phantom SKU inserts from every writer, including the older single-card editor.
     LOCK TABLE public.products,public.product_costs IN SHARE ROW EXCLUSIVE MODE;
     FOR i IN SELECT * FROM public.catalog_import_items WHERE batch_id=b.id ORDER BY product_id LOOP
       SELECT count(*) INTO matches FROM public.products WHERE lower(btrim(sku))=lower(btrim(i.sku));
       SELECT to_jsonb(c) INTO bc FROM public.product_costs c WHERE product_id=i.product_id;
       SELECT * INTO p FROM public.products WHERE id=i.product_id;
       IF i.kind='new' THEN
         IF FOUND OR matches<>0 THEN RAISE EXCEPTION 'IMPORT_CONFLICT'; END IF;
       ELSIF NOT FOUND OR matches<>1 OR to_jsonb(p) IS DISTINCT FROM i.before_product OR bc IS DISTINCT FROM i.before_cost THEN
         RAISE EXCEPTION 'IMPORT_CONFLICT';
       END IF;
     END LOOP;
     FOR i IN SELECT * FROM public.catalog_import_items WHERE batch_id=b.id AND kind IN ('new','update') ORDER BY product_id LOOP
       ap:=i.after_product;
       IF i.kind='new' THEN
         INSERT INTO public.products(id,slug,sku,title,brand,category_id,price,in_stock,stock_qty,status,assortment_decision)
           VALUES(i.product_id,'import-'||i.product_id,ap->>'sku',ap->>'title',ap->>'brand',(ap->>'category_id')::uuid,
             (ap->>'price')::numeric,(ap->>'in_stock')::boolean,(ap->>'stock_qty')::integer,'draft','review');
       ELSE
         -- Status and assortment_decision intentionally never assigned here.
         UPDATE public.products SET title=ap->>'title',brand=ap->>'brand',category_id=(ap->>'category_id')::uuid,
           price=(ap->>'price')::numeric,in_stock=(ap->>'in_stock')::boolean,stock_qty=(ap->>'stock_qty')::integer WHERE id=i.product_id;
       END IF;
       IF i.patch ? 'cost_price' THEN
         INSERT INTO public.product_costs(product_id,cost_price) VALUES(i.product_id,(i.patch->>'cost_price')::numeric)
           ON CONFLICT(product_id) DO UPDATE SET cost_price=excluded.cost_price,updated_at=now();
       END IF;
       SELECT to_jsonb(c) INTO ac FROM public.product_costs c WHERE product_id=i.product_id;
       UPDATE public.catalog_import_items SET after_product=(SELECT to_jsonb(q) FROM public.products q WHERE id=i.product_id),
         after_cost=ac WHERE batch_id=b.id AND line=i.line;
     END LOOP;
     UPDATE public.catalog_imports SET state='applied',applied_at=now() WHERE id=b.id;
     INSERT INTO public.staff_audit_log(telegram_id,action,details) VALUES(p_actor,'catalog_import_apply',jsonb_build_object('batch_id',b.id,'checksum',b.checksum));
   ELSIF p_op='undo_preview' THEN
     IF b.state NOT IN ('applied','undo_preview') THEN RAISE EXCEPTION 'IMPORT_CLOSED'; END IF;
     IF b.applied_at<now()-interval '7 days' THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
     UPDATE public.catalog_imports SET state='undo_preview',expires_at=now()+interval '30 minutes' WHERE id=b.id;
   ELSIF p_op='undo' AND b.state<>'undone' THEN
     IF b.state<>'undo_preview' THEN RAISE EXCEPTION 'IMPORT_CLOSED'; END IF;
     IF b.expires_at<now() OR b.applied_at<now()-interval '7 days' THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
     LOCK TABLE public.products,public.product_costs IN SHARE ROW EXCLUSIVE MODE;
     FOR i IN SELECT * FROM public.catalog_import_items WHERE batch_id=b.id AND kind IN ('new','update') ORDER BY product_id LOOP
       SELECT * INTO p FROM public.products WHERE id=i.product_id;
       SELECT to_jsonb(c) INTO bc FROM public.product_costs c WHERE product_id=i.product_id;
       IF to_jsonb(p) IS DISTINCT FROM i.after_product OR bc IS DISTINCT FROM i.after_cost THEN RAISE EXCEPTION 'IMPORT_CONFLICT'; END IF;
     END LOOP;
     FOR i IN SELECT * FROM public.catalog_import_items WHERE batch_id=b.id AND kind IN ('new','update') ORDER BY product_id LOOP
       IF i.kind='new' THEN
         -- Preserve possible order/photo references; imported drafts are archived, never deleted.
         UPDATE public.products SET status='hidden',assortment_decision='excluded' WHERE id=i.product_id;
       ELSE
         bp:=i.before_product;
         UPDATE public.products SET title=bp->>'title',brand=bp->>'brand',category_id=(bp->>'category_id')::uuid,
           price=(bp->>'price')::numeric,in_stock=(bp->>'in_stock')::boolean,stock_qty=(bp->>'stock_qty')::integer WHERE id=i.product_id;
         IF i.patch ? 'cost_price' THEN
           IF i.before_cost IS NULL THEN DELETE FROM public.product_costs WHERE product_id=i.product_id;
           ELSE
             INSERT INTO public.product_costs(product_id,cost_price) VALUES(i.product_id,(i.before_cost->>'cost_price')::numeric)
               ON CONFLICT(product_id) DO UPDATE SET cost_price=excluded.cost_price,updated_at=now();
           END IF;
         END IF;
       END IF;
     END LOOP;
     UPDATE public.catalog_imports SET state='undone' WHERE id=b.id;
     INSERT INTO public.staff_audit_log(telegram_id,action,details) VALUES(p_actor,'catalog_import_undo',jsonb_build_object('batch_id',b.id));
   END IF;
 END IF;
 SELECT * INTO b FROM public.catalog_imports WHERE id=b.id;
 SELECT jsonb_build_object('new',count(*) FILTER(WHERE kind='new'),'update',count(*) FILTER(WHERE kind='update'),
   'unchanged',count(*) FILTER(WHERE kind='unchanged'),'error',count(*) FILTER(WHERE kind='error'),
   'excluded',count(*) FILTER(WHERE before_product->>'assortment_decision'='excluded')) INTO counts
   FROM public.catalog_import_items WHERE batch_id=b.id;
 SELECT count(*) INTO n FROM public.catalog_import_items WHERE batch_id=b.id;
 pg:=least(p_page,greatest(0,(n-1)/3));
 SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO entries FROM (
   SELECT line,sku,kind,errors,patch,before_product,after_product,before_cost,after_cost
   FROM public.catalog_import_items WHERE batch_id=b.id ORDER BY (kind='error') DESC,line OFFSET pg*3 LIMIT 3
 ) r;
 RETURN jsonb_build_object('ok',true,'id',b.id,'file',b.file_name,'state',b.state,'revision',b.revision,
   'header',b.source->'header','sample',b.source->'rows'->0,'mapping',b.mapping,'decimal',b.decimal_format,
   'fileRows',jsonb_array_length(b.source->'rows'),'counts',counts,'items',entries,'page',pg,'pages',greatest(1,ceil(n/3.0)));
END $$;
REVOKE ALL ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) TO service_role;
NOTIFY pgrst,'reload schema';
