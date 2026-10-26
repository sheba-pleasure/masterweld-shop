-- Privileges after 0011 + 0010
SELECT qa.check('0011: anon no privilege on shop_orders',
  NOT has_table_privilege('anon','public.shop_orders','SELECT,INSERT,UPDATE,DELETE'));
SELECT qa.check('0011: authenticated no privilege on shop_orders',
  NOT has_table_privilege('authenticated','public.shop_orders','SELECT,INSERT,UPDATE,DELETE'));
SELECT qa.check('0011: anon/authenticated no privilege on order_events',
  NOT has_table_privilege('anon','public.order_events','SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated','public.order_events','SELECT,INSERT,UPDATE,DELETE'));
SET ROLE anon;
SELECT qa.check('anon real SELECT of orders denied', qa.err('SELECT * FROM public.shop_orders') IS NOT NULL);
RESET ROLE;
SET ROLE authenticated;
SELECT qa.check('authenticated real SELECT of orders denied', qa.err('SELECT * FROM public.shop_orders') IS NOT NULL);
RESET ROLE;

SELECT qa.check('0010: functions are SECURITY DEFINER with pinned search_path',
  (SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp'])
   FROM pg_proc WHERE proname IN ('bot_change_order_status','bot_toggle_elevated')));
SELECT qa.check('0010: PUBLIC/anon/authenticated cannot EXECUTE status fn',
  NOT has_function_privilege('anon','public.bot_change_order_status(uuid,bigint,public.order_status,public.order_status)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.bot_change_order_status(uuid,bigint,public.order_status,public.order_status)','EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname='bot_change_order_status' AND a.grantee=0));
SELECT qa.check('0010: PUBLIC/anon/authenticated cannot EXECUTE elevate fn',
  NOT has_function_privilege('anon','public.bot_toggle_elevated(bigint,boolean,boolean)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.bot_toggle_elevated(bigint,boolean,boolean)','EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname='bot_toggle_elevated' AND a.grantee=0));
SELECT qa.check('0010: service_role can EXECUTE both',
  has_function_privilege('service_role','public.bot_change_order_status(uuid,bigint,public.order_status,public.order_status)','EXECUTE')
  AND has_function_privilege('service_role','public.bot_toggle_elevated(bigint,boolean,boolean)','EXECUTE'));

-- Synthetic staff: 1 admin, 2 director, 3 seller, 4 inactive seller, 5 inactive director, 6 director
INSERT INTO public.staff(telegram_id,name,role,elevated,active) VALUES
 (1,'A','admin',false,true),(2,'D','director',false,true),(3,'S','seller',false,true),
 (4,'S2','seller',false,false),(5,'D2','director',false,false),(6,'D3','director',true,true);
CREATE TABLE qa.o(k text PRIMARY KEY, id uuid);
DO $$ DECLARE kk text; BEGIN
  FOREACH kk IN ARRAY ARRAY['flow','cancel1','cancel2','cancel3','stale','rbac','fail_audit','fail_events','anon'] LOOP
    INSERT INTO qa.o VALUES (kk, gen_random_uuid());
    INSERT INTO public.shop_orders(id,name,phone,items,total) SELECT id,'Синт','+70000000009','[1]',1 FROM qa.o WHERE qa.o.k=kk;
  END LOOP; END $$;
CREATE FUNCTION qa.st(k text, s bigint, e text, n text) RETURNS text LANGUAGE sql AS
 $$ SELECT qa.err(format('SELECT public.bot_change_order_status(%L,%s,%L,%L)', (SELECT id FROM qa.o WHERE o.k=st.k), s, e, n)) $$;
CREATE FUNCTION qa.status(k text) RETURNS text LANGUAGE sql AS $$ SELECT status::text FROM public.shop_orders WHERE id=(SELECT id FROM qa.o WHERE o.k=status.k) $$;
CREATE FUNCTION qa.ev(k text) RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.order_events WHERE order_id=(SELECT id FROM qa.o WHERE o.k=ev.k) $$;
CREATE FUNCTION qa.au(k text) RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.staff_audit_log WHERE action='order_status' AND details->>'order_id'=(SELECT id::text FROM qa.o WHERE o.k=au.k) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA qa TO PUBLIC; GRANT SELECT ON qa.o TO PUBLIC;

SET ROLE service_role;
SELECT qa.check('flow new->processing (seller)', qa.st('flow',3,'new','processing') IS NULL);
SELECT qa.check('flow processing->ready (admin)', qa.st('flow',1,'processing','ready') IS NULL);
SELECT qa.check('flow ready->completed (director)', qa.st('flow',2,'ready','completed') IS NULL);
SELECT qa.check('flow: final completed, 3 events, 3 audit rows', qa.status('flow')='completed' AND qa.ev('flow')=3 AND qa.au('flow')=3);
SELECT qa.check('illegal completed->new rejected', qa.st('flow',1,'completed','new') LIKE '%BOT_ORDER_TRANSITION%');
SELECT qa.check('illegal completed->canceled rejected', qa.st('flow',1,'completed','canceled') LIKE '%BOT_ORDER_TRANSITION%');
SELECT qa.check('illegal new->ready rejected', qa.st('cancel1',1,'new','ready') LIKE '%BOT_ORDER_TRANSITION%');
SELECT qa.check('illegal new->completed rejected', qa.st('cancel1',1,'new','completed') LIKE '%BOT_ORDER_TRANSITION%');
SELECT qa.check('illegal same-state new->new rejected', qa.st('cancel1',1,'new','new') LIKE '%BOT_ORDER_TRANSITION%');
SELECT qa.check('NULL next status rejected', qa.err(format('SELECT public.bot_change_order_status(%L,1,''new'',NULL)',(SELECT id FROM qa.o WHERE k='cancel1'))) LIKE '%BOT_ORDER_TRANSITION%');
SELECT qa.check('cancel from new', qa.st('cancel1',1,'new','canceled') IS NULL AND qa.status('cancel1')='canceled');
SELECT qa.check('cancel from processing', qa.st('cancel2',1,'new','processing') IS NULL AND qa.st('cancel2',1,'processing','canceled') IS NULL);
SELECT qa.check('cancel from ready', qa.st('cancel3',1,'new','processing') IS NULL AND qa.st('cancel3',1,'processing','ready') IS NULL AND qa.st('cancel3',1,'ready','canceled') IS NULL);
SELECT qa.check('canceled is terminal', qa.st('cancel1',1,'canceled','new') LIKE '%BOT_ORDER_TRANSITION%');
SELECT qa.check('stale expected status -> conflict, nothing written',
  qa.st('stale',1,'processing','ready') LIKE '%BOT_ORDER_CONFLICT%' AND qa.status('stale')='new' AND qa.ev('stale')=0 AND qa.au('stale')=0);
SELECT qa.check('unknown order -> conflict', qa.err(format('SELECT public.bot_change_order_status(%L,1,''new'',''processing'')', gen_random_uuid())) LIKE '%BOT_ORDER_CONFLICT%');
SELECT qa.check('inactive seller denied', qa.st('rbac',4,'new','processing') LIKE '%BOT_DENIED%');
SELECT qa.check('inactive director denied', qa.st('rbac',5,'new','processing') LIKE '%BOT_DENIED%');
SELECT qa.check('unknown telegram id denied', qa.st('rbac',999,'new','processing') LIKE '%BOT_DENIED%');
SELECT qa.check('rbac denials wrote nothing', qa.status('rbac')='new' AND qa.ev('rbac')=0 AND qa.au('rbac')=0);
RESET ROLE;

-- Atomicity: force each journal to fail and verify full rollback.
CREATE FUNCTION qa.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_JOURNAL_FAIL'; END $$;
CREATE TRIGGER qa_boom BEFORE INSERT ON public.staff_audit_log FOR EACH ROW EXECUTE FUNCTION qa.boom();
SET ROLE service_role;
SELECT qa.check('audit failure -> error', qa.st('fail_audit',1,'new','processing') LIKE '%QA_JOURNAL_FAIL%');
SELECT qa.check('audit failure -> status and order_events rolled back', qa.status('fail_audit')='new' AND qa.ev('fail_audit')=0);
RESET ROLE;
DROP TRIGGER qa_boom ON public.staff_audit_log;
CREATE TRIGGER qa_boom BEFORE INSERT ON public.order_events FOR EACH ROW EXECUTE FUNCTION qa.boom();
SET ROLE service_role;
SELECT qa.check('order_events failure -> error', qa.st('fail_events',1,'new','processing') LIKE '%QA_JOURNAL_FAIL%');
SELECT qa.check('order_events failure -> status and audit rolled back', qa.status('fail_events')='new' AND qa.au('fail_events')=0);
RESET ROLE;
DROP TRIGGER qa_boom ON public.order_events;

-- Client roles cannot call even if they try.
SET ROLE anon;
SELECT qa.check('anon real EXECUTE status fn denied', qa.st('anon',1,'new','processing') LIKE '%permission denied%');
SELECT qa.check('anon real EXECUTE elevate fn denied', qa.err('SELECT public.bot_toggle_elevated(2,false,true)') LIKE '%permission denied%');
RESET ROLE;
SET ROLE authenticated;
SELECT qa.check('authenticated real EXECUTE status fn denied', qa.st('anon',1,'new','processing') LIKE '%permission denied%');
SELECT qa.check('authenticated real EXECUTE elevate fn denied', qa.err('SELECT public.bot_toggle_elevated(2,false,true)') LIKE '%permission denied%');
RESET ROLE;
SELECT qa.check('denied calls wrote nothing', qa.status('anon')='new' AND qa.ev('anon')=0);

-- Elevation
SET ROLE service_role;
SELECT qa.check('elevate: active director on', qa.err('SELECT public.bot_toggle_elevated(2,false,true)') IS NULL);
SELECT qa.check('elevate: stale expected -> conflict', qa.err('SELECT public.bot_toggle_elevated(2,false,true)') LIKE '%BOT_ELEVATION_CONFLICT%');
SELECT qa.check('elevate: active director off', qa.err('SELECT public.bot_toggle_elevated(2,true,false)') IS NULL);
SELECT qa.check('elevate: NULL target rejected', qa.err('SELECT public.bot_toggle_elevated(2,false,NULL)') LIKE '%BOT_ELEVATION_CONFLICT%');
SELECT qa.check('elevate: admin denied', qa.err('SELECT public.bot_toggle_elevated(1,false,true)') LIKE '%BOT_DENIED%');
SELECT qa.check('elevate: seller denied', qa.err('SELECT public.bot_toggle_elevated(3,false,true)') LIKE '%BOT_DENIED%');
SELECT qa.check('elevate: inactive director denied', qa.err('SELECT public.bot_toggle_elevated(5,false,true)') LIKE '%BOT_DENIED%');
RESET ROLE;
SELECT qa.check('elevate: final state and exactly 2 audit rows for director 2',
  (SELECT elevated FROM public.staff WHERE telegram_id=2) = false
  AND (SELECT count(*) FROM public.staff_audit_log WHERE telegram_id=2 AND action LIKE 'full_access_%')=2
  AND (SELECT bool_and(NOT elevated) FROM public.staff WHERE telegram_id IN (1,3,5)));
CREATE TRIGGER qa_boom BEFORE INSERT ON public.staff_audit_log FOR EACH ROW EXECUTE FUNCTION qa.boom();
SET ROLE service_role;
SELECT qa.check('elevate: audit failure rolls back flag',
  qa.err('SELECT public.bot_toggle_elevated(2,false,true)') LIKE '%QA_JOURNAL_FAIL%');
RESET ROLE;
DROP TRIGGER qa_boom ON public.staff_audit_log;
SELECT qa.check('elevate: flag still false after rollback', (SELECT elevated FROM public.staff WHERE telegram_id=2) = false);
