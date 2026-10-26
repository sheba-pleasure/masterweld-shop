-- READ-ONLY preflight: which of 0003/0004/0010/0011 look applied.
-- Pure SELECT over system catalogs; reads no order rows and no personal data.
-- Never run automatically against the cloud DB; only manually as read-only SQL.
-- Safe when ANY of shop_orders / order_status / order_events / RPCs is missing:
-- every object is resolved via to_regclass/to_regtype (NULL instead of error)
-- and privilege functions get an OID only inside guarded CASE branches.
-- Requires the API roles anon / authenticated / service_role to exist.
-- Columns 1-16 keep their previous meaning; definition checks are appended at the end.
WITH o AS (
  SELECT to_regclass('public.shop_orders')  AS shop_orders,
         to_regclass('public.order_events') AS order_events,
         to_regtype('public.order_status')  AS order_status
), st AS (
  SELECT a.attnotnull, a.atttypid, pg_get_expr(d.adbin, d.adrelid) AS def
  FROM o JOIN pg_attribute a ON a.attrelid = o.shop_orders AND a.attname = 'status' AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
), rpc AS (
  SELECT p.oid, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('bot_change_order_status','bot_toggle_elevated')
)
SELECT
  current_setting('server_version_num')::int                                         AS pg_version_num,
  o.order_status IS NOT NULL                                                         AS m0003_enum,
  EXISTS (SELECT 1 FROM st)                                                          AS m0003_status_column,
  o.order_events IS NOT NULL                                                         AS m0003_order_events,
  coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = o.order_events), false)  AS m0003_order_events_rls,
  CASE WHEN o.order_events IS NULL THEN false ELSE
    has_table_privilege('anon', o.order_events, 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated', o.order_events, 'SELECT,INSERT,UPDATE,DELETE') END AS order_events_client_any_grant,
  CASE WHEN o.shop_orders IS NULL THEN false ELSE has_table_privilege('anon', o.shop_orders, 'SELECT') END          AS anon_select_grant,
  CASE WHEN o.shop_orders IS NULL THEN false ELSE has_table_privilege('anon', o.shop_orders, 'INSERT') END          AS anon_insert_grant,
  CASE WHEN o.shop_orders IS NULL THEN false ELSE has_table_privilege('authenticated', o.shop_orders, 'SELECT') END AS auth_select_grant,
  CASE WHEN o.shop_orders IS NULL THEN false ELSE has_table_privilege('authenticated', o.shop_orders, 'INSERT') END AS auth_insert_grant,
  EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = o.shop_orders
          AND pol.polcmd IN ('a','*')
          AND (pol.polroles @> ARRAY[0::oid]
               OR pol.polroles && ARRAY(SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated')))) AS public_insert_policy,
  (SELECT relrowsecurity FROM pg_class WHERE oid = o.shop_orders)                    AS shop_orders_rls,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='bot_change_order_status')          AS m0010_status_rpc,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='bot_toggle_elevated')              AS m0010_elevate_rpc,
  EXISTS (SELECT 1 FROM rpc
          WHERE has_function_privilege('anon', rpc.oid, 'EXECUTE')
             OR has_function_privilege('authenticated', rpc.oid, 'EXECUTE')
             OR rpc.proacl IS NULL
             OR EXISTS (SELECT 1 FROM aclexplode(rpc.proacl) a WHERE a.grantee = 0)) AS rpc_client_or_public_execute,
  coalesce((SELECT bool_and(has_function_privilege('service_role', rpc.oid, 'EXECUTE')) FROM rpc), false) AS rpc_service_execute,
  -- appended: structural correctness of 0003
  coalesce((SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = o.order_status)
           = ARRAY['new','processing','ready','completed','canceled'], false)        AS m0003_enum_values_ok,
  coalesce((SELECT st.attnotnull AND st.atttypid = o.order_status
                   AND st.def ~ '^''new''::(public\.)?order_status$' FROM st), false) AS m0003_status_definition_ok
FROM o;
