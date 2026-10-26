-- Этап A: статусы заказов и журнал их смены.
-- Совместимая (additive) миграция: не трогает существующие строки и колонки.
-- Применять ТОЛЬКО после ревизии, вместе с развёртыванием кода (см. docs/order-rollout.md).

-- 1. Статус заказа.
CREATE TYPE public.order_status AS ENUM ('new', 'processing', 'ready', 'completed', 'canceled');

ALTER TABLE public.shop_orders
  ADD COLUMN IF NOT EXISTS status public.order_status NOT NULL DEFAULT 'new';

COMMENT ON COLUMN public.shop_orders.status IS 'Статус обработки заказа; меняется только сотрудниками через Telegram-бот (service_role).';

-- 2. Журнал смен статуса (кто/когда/было/стало). Заполняется ботом.
CREATE TABLE public.order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.shop_orders(id),
  from_status public.order_status,
  to_status public.order_status NOT NULL,
  staff_telegram_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_id_idx ON public.order_events (order_id);

-- Доступ: только service_role (бот). Публичных политик нет — таблица закрыта RLS.
GRANT ALL ON public.order_events TO service_role;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;

-- 3. Существующие заказы получают статус 'new' автоматически (DEFAULT).
