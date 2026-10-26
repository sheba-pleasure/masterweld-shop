-- Этап C1: двухшаговые операции бота (preview → confirm) для панели управления
-- каталогом интернет-магазина «Мастер Сварщик».
--
-- Совместимая (additive) миграция: не трогает существующие строки и колонки.
-- НЕ ПРИМЕНЯТЬ до ревизии, вместе с развёртыванием кода
-- (см. docs/telegram-catalog-rollout.md).
--
-- Файл — материал для ревизии. Применение выполняется инструментом миграций
-- Lovable (он создаёт свою журнальную запись), а не автозапуском этого файла.
--
-- Назначение: каждая изменяющая операция (/price, /stock) сначала сохраняется
-- сюда снимком «было → станет» и TTL; применение — только через подтверждение,
-- с защитой от повторного применения (consumed_at) и сравнением before_value
-- с текущим значением товара перед UPDATE.
--
-- outcome различает применённое и отменённое действие: consumed_at NOT NULL
-- сам по себе НЕ означает «применено» (он выставляется и при отмене). Откат
-- разрешён только для outcome = 'applied' (см. bot_prepare_rollback в 0006).

CREATE TABLE public.pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_telegram_id bigint NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('price', 'stock')),
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  -- 'applied' | 'canceled' | NULL (NULL — legacy-строки без доказательства
  -- применения: откат для них запрещён, fail closed).
  outcome text CHECK (outcome IN ('applied', 'canceled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Выборки по сотруднику (аудит, диагностика).
CREATE INDEX pending_actions_staff_idx ON public.pending_actions (staff_telegram_id, created_at DESC);

-- Защита от повторного применения: одноразовость через consumed_at
-- (условный UPDATE ... WHERE consumed_at IS NULL), см. код бота.

-- Доступ: только service_role (бот). Публичных политик нет — таблица закрыта RLS.
GRANT ALL ON public.pending_actions TO service_role;
ALTER TABLE public.pending_actions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pending_actions IS
  'Двухшаговые операции бота (preview→confirm): TTL, anti-replay через consumed_at, сравнение before_value перед UPDATE.';
COMMENT ON COLUMN public.pending_actions.before_value IS
  'Снимок значения до изменения: {"price": число} или {"in_stock": bool}.';
COMMENT ON COLUMN public.pending_actions.after_value IS
  'Предлагаемое значение: {"price": число} или {"in_stock": bool}.';
COMMENT ON COLUMN public.pending_actions.consumed_at IS
  'Момент применения или отмены. NOT NULL означает, что повторное применение запрещено.';
COMMENT ON COLUMN public.pending_actions.outcome IS
  'Итог действия: applied (применено), canceled (отменено) или NULL (legacy без доказательства применения — откат запрещён).';
