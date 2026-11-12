-- DEV first, guarded exact-0043 transition. Does not load or publish any products.
-- An explicit import setting permits only NEW products with an absent selling price.
-- Existing prices, publication, assortment, source/model checks and receipts are retained.
ALTER TABLE public.products ALTER COLUMN price DROP NOT NULL;
ALTER TABLE public.products ALTER COLUMN price DROP DEFAULT;
ALTER TABLE public.catalog_imports ADD COLUMN inquiry_price boolean NOT NULL DEFAULT false;

-- The outer actor/source/model/return wrappers remain untouched and non-bypassable.
DO $import$ DECLARE def text; old text; replacement text; BEGIN
 def:=pg_get_functiondef('mw_private.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)'::regprocedure);
 FOR old,replacement IN VALUES
 ($old$('get','source','map','decimal','preview','apply','cancel','undo_preview','undo')$old$,
  $new$('get','source','map','decimal','inquiry_price','preview','apply','cancel','undo_preview','undo')$new$),
 ($old$IF p_op IN ('map','decimal','preview') THEN$old$,
  $new$IF p_op IN ('map','decimal','inquiry_price','preview') THEN$new$),
 ($old$'decimal',b.decimal_format,'revision',b.revision);$old$,
  $new$'decimal',b.decimal_format,'revision',b.revision,'inquiry_price',b.inquiry_price);$new$),
 ($old$   ELSIF p_op='decimal' THEN$old$,
  $new$   ELSIF p_op='inquiry_price' THEN
     IF jsonb_typeof(p_payload->'enabled') IS DISTINCT FROM 'boolean'
       OR p_payload-'enabled'<>'{}'::jsonb THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
     IF b.inquiry_price IS DISTINCT FROM (p_payload->>'enabled')::boolean THEN
       UPDATE public.catalog_imports SET inquiry_price=(p_payload->>'enabled')::boolean,
         state='config',revision=revision+1 WHERE id=b.id;
       DELETE FROM public.catalog_import_items WHERE batch_id=b.id;
       INSERT INTO public.staff_audit_log(telegram_id,action,details)
         VALUES(p_actor,'catalog_import_inquiry_price',jsonb_build_object(
           'batch_id',b.id,'before',b.inquiry_price,'after',(p_payload->>'enabled')::boolean,
           'base_revision',b.revision));
     END IF;
   ELSIF p_op='decimal' THEN$new$),
 ($old$IF bp IS NULL AND (NOT(v ? 'title') OR NOT(v ? 'price')) THEN errs:=errs||'"NEW_REQUIRED"'::jsonb; END IF;$old$,
  $new$IF bp IS NULL AND (NOT(v ? 'title') OR (NOT(v ? 'price') AND NOT b.inquiry_price))
         THEN errs:=errs||'"NEW_REQUIRED"'::jsonb; END IF;$new$),
 ($old$'brand',NULL,'category_id',NULL,'price',0,'in_stock',false,'stock_qty',NULL,$old$,
  $new$'brand',NULL,'category_id',NULL,'price',NULL,'in_stock',false,'stock_qty',NULL,$new$),
 ($old$'mapping',b.mapping,'decimal',b.decimal_format,
   'fileRows'$old$,
  $new$'mapping',b.mapping,'decimal',b.decimal_format,'inquiry_price',b.inquiry_price,
   'fileRows'$new$)
 LOOP
  IF length(def)-length(replace(def,old,''))<>length(old)
    THEN RAISE EXCEPTION 'INQUIRY_IMPORT_BASELINE'; END IF;
  def:=replace(def,old,replacement);
 END LOOP;
 EXECUTE def;
END $import$;

-- NULL is a real prior state for a human-confirmed price change and its undo.
-- Missing JSON fields and invalid numbers remain errors.
DO $price$ DECLARE def text; old text; replacement text; BEGIN
 def:=pg_get_functiondef('public.bot_apply_pending(uuid,bigint)'::regprocedure);
 FOR old,replacement IN VALUES
 ($old$    IF (v_after->>'price') IS NULL
       OR (v_after->>'price') !~ '^[0-9]+(\.[0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'BOT_BAD_VALUE';
    END IF;
    v_price := (v_after->>'price')::numeric;
    IF v_price <= 0 OR v_price > 10000000 THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;$old$,
 $new$    IF NOT (v_after ? 'price') OR NOT (v_before ? 'price')
      OR jsonb_typeof(v_after->'price') NOT IN ('number','null')
      OR jsonb_typeof(v_before->'price') NOT IN ('number','null')
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    v_price := (v_after->>'price')::numeric;
    IF v_price IS NOT NULL AND (v_price <= 0 OR v_price > 10000000 OR round(v_price,2)<>v_price)
      THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    IF v_price IS NULL AND v_prod.status='published'
      THEN RAISE EXCEPTION 'BOT_PUBLISH_MISSING_FIELDS'; END IF;$new$),
 ($old$AND round(v_prod.price * 100) = round((v_before->>'price')::numeric * 100);$old$,
 $new$AND round(v_prod.price * 100) IS NOT DISTINCT FROM round((v_before->>'price')::numeric * 100);$new$),
 ($old$IF NOT v_ok THEN RAISE EXCEPTION 'BOT_PENDING_CONFLICT'; END IF;$old$,
 $new$IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'BOT_PENDING_CONFLICT'; END IF;$new$),
 ($old$v_prod.price <= 0 OR v_photos = 0$old$,
 $new$v_prod.price IS NULL OR v_prod.price <= 0 OR v_photos = 0$new$)
 LOOP
  IF length(def)-length(replace(def,old,''))<>length(old)
    THEN RAISE EXCEPTION 'INQUIRY_PRICE_BASELINE'; END IF;
  def:=replace(def,old,replacement);
 END LOOP;
 EXECUTE def;
END $price$;

-- Undoing an assortment hide must still satisfy the publication requirements.
DO $assortment$ DECLARE def text; old text; replacement text; BEGIN
 def:=pg_get_functiondef('public.bot_assortment(bigint,text,uuid,text,integer,text,integer)'::regprocedure);
 old:='length(btrim(p.title))<3 OR p.price<=0 OR NOT EXISTS(';
 replacement:='length(btrim(p.title))<3 OR p.price IS NULL OR p.price<=0 OR NOT EXISTS(';
 IF length(def)-length(replace(def,old,''))<>length(old)
   THEN RAISE EXCEPTION 'INQUIRY_ASSORTMENT_BASELINE'; END IF;
 EXECUTE replace(def,old,replacement);
END $assortment$;

-- Locks prevent a concurrent NULL-price change from racing a new order.
-- Existing order receipts still replay before the insertion path.
CREATE FUNCTION mw_private.reject_inquiry_price_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM p.id FROM products p WHERE p.id IN (
  SELECT (i->>'product_id')::uuid FROM jsonb_array_elements(NEW.items) i
 ) ORDER BY p.id FOR SHARE;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.items) i JOIN products p
   ON p.id=(i->>'product_id')::uuid WHERE p.price IS NULL)
 THEN RAISE EXCEPTION 'ORDER_INQUIRY_ONLY'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mw_private.reject_inquiry_price_order() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER reject_inquiry_price_order BEFORE INSERT ON public.shop_orders
 FOR EACH ROW EXECUTE FUNCTION mw_private.reject_inquiry_price_order();

CREATE FUNCTION mw_private.inquiry_price_version() RETURNS integer
LANGUAGE sql IMMUTABLE AS 'SELECT 1';
REVOKE ALL ON FUNCTION mw_private.inquiry_price_version() FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
