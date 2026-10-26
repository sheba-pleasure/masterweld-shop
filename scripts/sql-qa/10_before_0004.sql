-- Baseline (synthetic rows only): before 0004 the legacy public INSERT is open.
SET ROLE anon;
SELECT qa.check('before 0004: anon direct INSERT succeeds (known vulnerability)',
  qa.err($q$INSERT INTO public.shop_orders(name,phone,items,total) VALUES ('Тест','+70000000001','[{"x":1}]',1)$q$) IS NULL);
SELECT qa.check('before 0004: anon reads 0 orders (no SELECT policy)',
  coalesce((SELECT count(*) FROM public.shop_orders), 0) = 0);
RESET ROLE;
