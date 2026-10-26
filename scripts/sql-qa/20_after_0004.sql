SELECT qa.check('0003: status column default new',
  (SELECT column_default FROM information_schema.columns WHERE table_name='shop_orders' AND column_name='status') LIKE '''new''%');
SELECT qa.check('0003: existing order got status new', (SELECT bool_and(status='new') FROM public.shop_orders));
SELECT qa.check('0004: policy removed', NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='shop_orders'));
SELECT qa.check('0004: anon has no INSERT privilege', NOT has_table_privilege('anon','public.shop_orders','INSERT'));
SELECT qa.check('0004: authenticated has no INSERT privilege', NOT has_table_privilege('authenticated','public.shop_orders','INSERT'));
-- Defect evidence under legacy default privileges (fixed by 0011):
SELECT qa.check('DEFECT before 0011: anon still has SELECT on shop_orders (legacy defaults)',
  has_table_privilege('anon','public.shop_orders','SELECT'));
SELECT qa.check('DEFECT before 0011: anon has privileges on order_events (legacy defaults)',
  has_table_privilege('anon','public.order_events','SELECT'));
SET ROLE anon;
SELECT qa.check('0004: anon real INSERT rejected',
  qa.err($q$INSERT INTO public.shop_orders(name,phone,items,total) VALUES ('Тест','+70000000002','[1]',1)$q$) IS NOT NULL);
RESET ROLE;
SET ROLE authenticated;
SELECT qa.check('0004: authenticated real INSERT rejected',
  qa.err($q$INSERT INTO public.shop_orders(name,phone,items,total) VALUES ('Тест','+70000000003','[1]',1)$q$) IS NOT NULL);
RESET ROLE;
SET ROLE service_role;
SELECT qa.check('0004: service_role INSERT works (createOrder path)',
  qa.err($q$INSERT INTO public.shop_orders(name,phone,items,total) VALUES ('Сервер','+70000000004','[1]',1)$q$) IS NULL);
RESET ROLE;
