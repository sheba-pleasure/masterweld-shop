-- Private provenance only. Neither a model snapshot nor its link publishes a product.
CREATE TABLE public.document_import_model_links (
 batch_id uuid NOT NULL,
 line integer NOT NULL,
 review_id uuid NOT NULL,
 row_index integer NOT NULL,
 model_revision integer NOT NULL,
 decision_id uuid REFERENCES public.document_model_decisions(id),
 identity jsonb,
 source_hash text,
 product_id uuid REFERENCES public.products(id),
 product_identity jsonb,
 linked_at timestamptz,
 PRIMARY KEY(batch_id,line),
 FOREIGN KEY(batch_id,line) REFERENCES public.catalog_import_items(batch_id,line) ON DELETE CASCADE,
 FOREIGN KEY(review_id,row_index) REFERENCES public.document_review_rows(review_id,row_index),
 CHECK((decision_id IS NULL AND identity IS NULL AND source_hash IS NULL)
    OR(decision_id IS NOT NULL AND identity IS NOT NULL AND source_hash IS NOT NULL))
);
CREATE INDEX document_import_model_product ON public.document_import_model_links(product_id,linked_at DESC);
ALTER TABLE public.document_import_model_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_import_model_links FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION mw_private.document_product_identity(p public.products) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('sku',p.sku,'title',p.title,'brand',p.brand,'category_id',p.category_id)
$$;
REVOKE ALL ON FUNCTION mw_private.document_product_identity(public.products) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION mw_private.document_import_model_view(p_actor bigint,p_batch uuid,p_line integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l document_import_model_links%ROWTYPE; b catalog_imports%ROWTYPE; p products%ROWTYPE;
 m jsonb; state text;
BEGIN
 SELECT * INTO b FROM catalog_imports WHERE id=p_batch AND staff_telegram_id=p_actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_NOT_FOUND'; END IF;
 SELECT * INTO l FROM document_import_model_links WHERE batch_id=p_batch AND line=p_line;
 IF NOT FOUND THEN RETURN NULL; END IF;
 m:=public.bot_document_model(p_actor,'get',l.review_id,NULL,l.row_index);
 IF b.state='undone' THEN state:='undone';
 ELSIF b.state='canceled' THEN state:='canceled';
 ELSIF (m->>'revision')::integer<>l.model_revision THEN state:='model_changed';
 ELSIF l.identity IS NULL THEN state:='unconfirmed';
 ELSIF NOT (m->>'usable')::boolean THEN state:='model_changed';
 ELSIF l.product_id IS NULL THEN state:='preview';
 ELSE
   SELECT * INTO p FROM products WHERE id=l.product_id;
   IF NOT FOUND OR p.assortment_decision::text='excluded' THEN state:='excluded';
   ELSIF mw_private.document_product_identity(p) IS DISTINCT FROM l.product_identity THEN state:='product_changed';
   ELSE state:='linked'; END IF;
 END IF;
 RETURN jsonb_build_object('review_id',l.review_id,'row',l.row_index,'model_revision',l.model_revision,
   'decision_id',l.decision_id,'identity',l.identity,'state',state,'product_id',l.product_id,
   'document_id',m->'document_id','file_name',m->'file_name','linked_at',l.linked_at);
END $$;
REVOKE ALL ON FUNCTION mw_private.document_import_model_view(bigint,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.bot_catalog_import(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
 p_payload jsonb DEFAULT '{}',p_page integer DEFAULT 0,p_revision integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b catalog_imports%ROWTYPE; i catalog_import_items%ROWTYPE; l document_import_model_links%ROWTYPE;
 e document_model_decisions%ROWTYPE; p products%ROWTYPE;
 rid uuid; result jsonb; m jsonb; provenance jsonb; row_id integer; source_sku text;
 entry jsonb; entries jsonb:='[]'; v jsonb; only_models boolean:=false; model_count integer; capture_ready boolean;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_DENIED'; END IF;
 IF p_op IN('preview','apply') AND EXISTS(SELECT 1 FROM document_import_origins
   WHERE import_id=p_id AND review_id IS NULL) THEN RAISE EXCEPTION 'DOCUMENT_REVIEW_REQUIRED'; END IF;
 IF p_id IS NOT NULL THEN
   SELECT * INTO b FROM catalog_imports WHERE id=p_id AND staff_telegram_id=p_actor FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_NOT_FOUND'; END IF;
   SELECT review_id INTO rid FROM document_import_origins WHERE import_id=p_id;
 END IF;
 IF p_op='apply' AND rid IS NOT NULL AND b.state='preview' THEN
   IF p_revision IS DISTINCT FROM b.revision THEN RAISE EXCEPTION 'IMPORT_STALE'; END IF;
   IF b.expires_at<now() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
   -- A pre-0030 preview has no captured model decisions: require a fresh human-visible preview.
   IF EXISTS(SELECT 1 FROM catalog_import_items x LEFT JOIN document_import_model_links q
      ON q.batch_id=x.batch_id AND q.line=x.line WHERE x.batch_id=b.id AND q.batch_id IS NULL)
   THEN RAISE EXCEPTION 'IMPORT_MODEL_PREVIEW_REQUIRED'; END IF;
   FOR l IN SELECT * FROM document_import_model_links WHERE batch_id=b.id ORDER BY line LOOP
     m:=public.bot_document_model(p_actor,'get',l.review_id,NULL,l.row_index);
     IF (m->>'revision')::integer<>l.model_revision OR
        (l.identity IS NOT NULL AND NOT (m->>'usable')::boolean)
     THEN RAISE EXCEPTION 'IMPORT_MODEL_CHANGED'; END IF;
   END LOOP;
   only_models:=NOT EXISTS(SELECT 1 FROM catalog_import_items WHERE batch_id=b.id AND kind<>'unchanged')
      AND EXISTS(SELECT 1 FROM document_import_model_links WHERE batch_id=b.id AND identity IS NOT NULL);
   IF only_models THEN
     LOCK TABLE products,product_costs IN SHARE ROW EXCLUSIVE MODE;
     FOR i IN SELECT * FROM catalog_import_items WHERE batch_id=b.id ORDER BY product_id LOOP
       SELECT * INTO p FROM products WHERE id=i.product_id;
       IF NOT FOUND OR to_jsonb(p) IS DISTINCT FROM i.before_product
         OR (SELECT to_jsonb(c) FROM product_costs c WHERE product_id=i.product_id) IS DISTINCT FROM i.before_cost
         OR (SELECT count(*) FROM products WHERE lower(btrim(sku))=lower(btrim(i.sku)))<>1
       THEN RAISE EXCEPTION 'IMPORT_CONFLICT'; END IF;
     END LOOP;
     UPDATE catalog_imports SET state='applied',applied_at=now() WHERE id=b.id;
     INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'catalog_import_model_links_apply',
       jsonb_build_object('batch_id',b.id));
   END IF;
 END IF;
 result:=mw_private.bot_catalog_import(p_actor,CASE WHEN only_models THEN 'get' ELSE p_op END,p_id,p_payload,p_page,p_revision);
 IF rid IS NOT NULL AND p_op='preview' THEN
   SELECT * INTO b FROM catalog_imports WHERE id=p_id;
   IF coalesce(b.mapping->>'sku','') !~ '^([0-9]|[12][0-9])$' OR (b.mapping->>'sku')::integer>=jsonb_array_length(b.source->'header')
   THEN RAISE EXCEPTION 'IMPORT_MODEL_SOURCE'; END IF;
   FOR i IN SELECT * FROM catalog_import_items WHERE batch_id=b.id ORDER BY line LOOP
     provenance:=b.source->'provenance'->(i.line-2);
     row_id:=coalesce(provenance->>'review_row_id',provenance->>'source_row')::integer;
     IF row_id IS NULL THEN RAISE EXCEPTION 'IMPORT_MODEL_SOURCE'; END IF;
     m:=public.bot_document_model(p_actor,'get',rid,NULL,row_id);
     IF m->'header' IS DISTINCT FROM b.source->'header' OR m->'cells' IS DISTINCT FROM b.source->'rows'->(i.line-2)
       OR NOT (m->>'eligible')::boolean
     THEN RAISE EXCEPTION 'IMPORT_MODEL_SOURCE'; END IF;
     source_sku:=regexp_replace(coalesce(b.source->'rows'->(i.line-2)->>((b.mapping->>'sku')::integer),''),
       '^[[:space:] ﻿]+|[[:space:] ﻿]+$','','g');
     IF i.kind<>'error' AND i.sku IS DISTINCT FROM source_sku THEN RAISE EXCEPTION 'IMPORT_MODEL_SOURCE'; END IF;
     e:=NULL;
     IF (m->>'usable')::boolean THEN
       SELECT * INTO e FROM document_model_decisions WHERE review_id=rid AND row_index=row_id
         AND base_revision=(m->>'revision')::integer-1 AND decision='confirmed';
       IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_MODEL_SOURCE'; END IF;
     END IF;
     INSERT INTO document_import_model_links(batch_id,line,review_id,row_index,model_revision,decision_id,identity,source_hash)
       VALUES(b.id,i.line,rid,row_id,(m->>'revision')::integer,e.id,e.identity,
         CASE WHEN e.id IS NULL THEN NULL ELSE encode(sha256(convert_to(e.source_snapshot::text,'UTF8')),'hex') END);
   END LOOP;
 ELSIF rid IS NOT NULL AND p_op='apply' AND b.state='preview' AND result->>'state'='applied' THEN
   UPDATE document_import_model_links q SET product_id=ci.product_id,
     product_identity=mw_private.document_product_identity(prod),linked_at=now()
   FROM catalog_import_items ci JOIN products prod ON prod.id=ci.product_id
   WHERE q.batch_id=b.id AND ci.batch_id=q.batch_id AND ci.line=q.line;
   GET DIAGNOSTICS model_count=ROW_COUNT;
   IF model_count>0 AND NOT only_models THEN
     INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'catalog_import_model_links_apply',
       jsonb_build_object('batch_id',b.id,'count',model_count));
   END IF;
 END IF;
 IF rid IS NOT NULL AND result ? 'items' THEN
   FOR entry IN SELECT * FROM jsonb_array_elements(result->'items') LOOP
     v:=mw_private.document_import_model_view(p_actor,p_id,(entry->>'line')::integer);
     entries:=entries||jsonb_build_array(entry||jsonb_build_object('document_model',v));
   END LOOP;
   SELECT count(*) INTO model_count FROM document_import_model_links WHERE batch_id=p_id AND identity IS NOT NULL;
   SELECT EXISTS(SELECT 1 FROM catalog_import_items WHERE batch_id=p_id) AND NOT EXISTS(
     SELECT 1 FROM catalog_import_items ci LEFT JOIN document_import_model_links q ON q.batch_id=ci.batch_id AND q.line=ci.line
     WHERE ci.batch_id=p_id AND q.batch_id IS NULL) INTO capture_ready;
   result:=result||jsonb_build_object('items',entries,'document_review_id',rid,'model_count',model_count,'model_capture_ready',capture_ready);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) TO service_role;

CREATE FUNCTION public.bot_product_document_models(p_actor bigint,p_product uuid,p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p products%ROWTYPE; l record; entries jsonb:='[]'; pg integer; total integer; conflicts boolean;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_DENIED'; END IF;
 IF p_page IS NULL OR p_page NOT BETWEEN 0 AND 1666 THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
 SELECT * INTO p FROM products WHERE id=p_product;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_PRODUCT_NOT_FOUND'; END IF;
 SELECT count(*) INTO total FROM document_import_model_links q JOIN catalog_imports b ON b.id=q.batch_id
   WHERE q.product_id=p_product AND b.staff_telegram_id=p_actor;
 pg:=least(p_page,greatest(0,(total-1)/3));
 FOR l IN SELECT q.* FROM document_import_model_links q JOIN catalog_imports b ON b.id=q.batch_id
   WHERE q.product_id=p_product AND b.staff_telegram_id=p_actor ORDER BY q.linked_at DESC,q.batch_id,q.line
   OFFSET pg*3 LIMIT 3 LOOP
   entries:=entries||jsonb_build_array(mw_private.document_import_model_view(p_actor,l.batch_id,l.line)
     ||jsonb_build_object('import_id',l.batch_id,'line',l.line));
 END LOOP;
 -- Conflicting current evidence across all owners must never become one silently chosen model.
 SELECT count(DISTINCT q.identity)>1 INTO conflicts FROM document_import_model_links q
   JOIN catalog_imports b ON b.id=q.batch_id JOIN document_model_checks c ON c.review_id=q.review_id AND c.row_index=q.row_index
   WHERE q.product_id=p_product AND b.state IN('applied','undo_preview') AND c.state='confirmed'
     AND c.revision=q.model_revision AND c.source_hash=q.source_hash
     AND q.product_identity=mw_private.document_product_identity(p);
 RETURN jsonb_build_object('ok',true,'product_id',p.id,'title',p.title,'sku',p.sku,
   'items',entries,'page',pg,'pages',greatest(1,ceil(total/3.0)),'conflicting',conflicts,
   'excluded',p.assortment_decision::text='excluded');
END $$;
REVOKE ALL ON FUNCTION public.bot_product_document_models(bigint,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_product_document_models(bigint,uuid,integer) TO service_role;
NOTIFY pgrst,'reload schema';
