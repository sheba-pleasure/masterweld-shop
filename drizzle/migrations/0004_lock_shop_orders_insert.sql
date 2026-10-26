-- Этап A, шаг 3 (применять ПОСЛЕДНИМ, после развёртывания серверного оформления заказа):
-- закрывает прямой INSERT в shop_orders из браузера.
-- Заказы после этого принимает только серверная точка createOrder (service_role).
--
-- ВНИМАНИЕ: ДО ПРИМЕНЕНИЯ этой миграции backend остаётся уязвим к прямому INSERT
-- произвольных заказов с клиентскими ценами/составом (RLS из 0002 разрешает вставку anon/authenticated).
-- Не применять, пока код createOrder не развёрнут и не проверен.

-- 1. Отзываем право вставки у публичных ролей.
REVOKE INSERT ON public.shop_orders FROM anon, authenticated;

-- 2. Удаляем публичную политику вставки.
DROP POLICY IF EXISTS "Shoppers can place an order" ON public.shop_orders;

-- 3. service_role сохраняет полный доступ (GRANT ALL из 0002 не меняется).
-- Чтение заказов остаётся закрытым для anon/authenticated (политик SELECT нет).
