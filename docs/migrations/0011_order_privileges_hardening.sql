-- REVIEW ONLY / НЕ ПРИМЕНЕНА. Применять сразу после 0004 (и до/вместе с 0010), до внешнего запуска.
-- Причина (QA 26.10.2026, docs/order-migrations-qa.md): 0003/0004 в drizzle/migrations
-- защищены от редактирования. 0004 отзывает только INSERT, 0003 не отзывает права
-- на order_events. Если в проекте действуют default privileges, выдающие anon/authenticated
-- права на новые таблицы, у клиентских ролей остаются SELECT/UPDATE/DELETE на заказы
-- (ПДн закрыты только RLS без политик). Эта миграция закрывает и привилегии.
-- Только REVOKE/GRANT, без изменения строк. Идемпотентна.
REVOKE ALL ON public.shop_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.order_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.shop_orders TO service_role;
GRANT ALL ON public.order_events TO service_role;
ALTER TABLE public.shop_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
