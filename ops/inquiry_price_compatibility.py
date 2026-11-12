"""Shared read-only markers for nullable-price import; separate from sourced Svarog."""
CAPABILITY = "mw.capabilities.inquiry-price"


def probe_sql():
    return """
DO $inquiry_probe$
DECLARE present boolean; flags jsonb;
BEGIN
 present:=to_regprocedure('mw_private.inquiry_price_version()') IS NOT NULL
   OR to_regprocedure('mw_private.reject_inquiry_price_order()') IS NOT NULL
   OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.catalog_imports')
     AND attname='inquiry_price' AND NOT attisdropped)
   OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.shop_orders')
     AND tgname='reject_inquiry_price_order');
 flags:=jsonb_build_array(
   present,
   EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=to_regprocedure('mw_private.inquiry_price_version()')
     AND p.prorettype='integer'::regtype AND p.provolatile='i' AND l.lanname='sql' AND p.prosrc='SELECT 1')
   AND EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid=to_regclass('public.catalog_imports') AND a.attname='inquiry_price'
     AND a.atttypid='boolean'::regtype AND a.attnotnull AND NOT a.attisdropped
     AND pg_get_expr(d.adbin,d.adrelid)='false'),
   present AND EXISTS(SELECT 1 FROM pg_attribute a
     WHERE a.attrelid=to_regclass('public.products') AND a.attname='price' AND NOT a.attnotnull
     AND NOT a.atthasdef AND NOT a.attisdropped),
   present AND EXISTS(SELECT 1 FROM pg_proc
     WHERE oid=to_regprocedure('public.bot_apply_pending(uuid,bigint)')
     AND position('AND round(v_prod.price * 100) IS NOT DISTINCT FROM' in prosrc)>0
     AND position('IF v_ok IS DISTINCT FROM true' in prosrc)>0
     AND position('IF v_price IS NULL AND v_prod.status=''published''' in prosrc)>0
     AND position('NOT (v_after ? ''price'') OR NOT (v_before ? ''price'')' in prosrc)>0
     AND position('v_prod.price IS NULL OR v_prod.price <= 0 OR v_photos = 0' in prosrc)>0)
   AND EXISTS(SELECT 1 FROM pg_proc
     WHERE oid=to_regprocedure('public.bot_assortment(bigint,text,uuid,text,integer,text,integer)')
     AND position('length(btrim(p.title))<3 OR p.price IS NULL OR p.price<=0 OR NOT EXISTS(' in prosrc)>0),
   EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc f ON f.oid=t.tgfoid
     WHERE t.tgrelid=to_regclass('public.shop_orders') AND t.tgname='reject_inquiry_price_order'
     AND t.tgenabled='O' AND NOT t.tgisinternal
     AND t.tgfoid=to_regprocedure('mw_private.reject_inquiry_price_order()')
     AND t.tgtype=7 AND f.prosecdef
     AND position('ORDER BY p.id FOR SHARE' in f.prosrc)>0
     AND position('WHERE p.price IS NULL' in f.prosrc)>0
     AND position('ORDER_INQUIRY_ONLY' in f.prosrc)>0),
   EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('mw_private.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)')
     AND position('ELSIF p_op=''inquiry_price'' THEN' in prosrc)>0
     AND position('(NOT(v ? ''price'') AND NOT b.inquiry_price)' in prosrc)>0
     AND position('''price'',NULL,''in_stock'',false' in prosrc)>0
     AND position('''catalog_import_inquiry_price''' in prosrc)>0)
 );
 PERFORM set_config('mw.inquiry_price_schema',flags::text,true);
 PERFORM set_config('mw.inquiry_price_present',present::text,true);
END $inquiry_probe$;
"""
