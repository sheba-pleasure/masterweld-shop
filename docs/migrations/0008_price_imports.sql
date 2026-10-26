-- Этап D: импорт прайса и закупочных цен в интернет-магазине «Мастер Сварщик».
-- Совместимая (additive) миграция. НЕ ПРИМЕНЯТЬ до ревизии и развёртывания
-- кода (см. docs/price-import-rollout.md).
--
-- Файл — материал для ревизии. Применение выполняется инструментом миграций
-- Lovable (он создаёт свою журнальную запись), а не автозапуском этого файла.
--
-- Что делает:
--   1. Таблицы import_batches / import_rows / import_events — батчи импорта
--      с checksum (идемпотентность), построчным состоянием, снимками
--      before/after для отката и журналом событий. Доступ ТОЛЬКО service_role
--      (RLS включён, публичных политик нет).
--   2. Транзакционные RPC (SECURITY DEFINER, REVOKE PUBLIC/anon/authenticated,
--      GRANT только service_role):
--        bot_import_create_batch — идемпотентное создание батча по checksum,
--          валидация всех значений на уровне БД, RBAC (import_prices;
--          cost-строки — дополнительно view_costs);
--        bot_import_approve — подтверждение батча (approved_by + аудит);
--        bot_import_apply — all-or-nothing применение: блокировки FOR UPDATE,
--          сверка before-снимков (optimistic concurrency), UPDATE товаров +
--          product_costs + row_status + аудит в ОДНОЙ транзакции; при любом
--          конфликте транзакция откатывается целиком, ничего не меняется;
--        bot_import_rollback — откат только applied-батча, с жёсткой сверкой
--          текущего значения с after-снимком (иначе BOT_IMPORT_ROLLBACK_CONFLICT).
--   3. Запреты на уровне схемы: import_rows.action только price/stock/qty/cost;
--      категория, название, slug, source_url, status, old_price через импорт
--      НЕ меняются (в RPC их просто нет).
--
-- Политика частичных сбоев: apply — строго all-or-nothing. Конфликт любой
-- строки откатывает весь батч; батч остаётся в статусе approved и может быть
-- повторён после устранения конфликта. Построчные row_status обновляются в
-- той же транзакции, поэтому «половина применённого» невозможна.

-- =====================================================================
-- 1. Таблицы
-- =====================================================================

CREATE TABLE public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 исходного прайса: повторная загрузка того же файла не создаёт
  -- дубль (идемпотентность на уровне схемы).
  checksum text NOT NULL UNIQUE,
  source_name text,
  supplier_name text,
  status text NOT NULL DEFAULT 'staging'
    CHECK (status IN ('staging', 'approved', 'applied', 'rolled_back', 'canceled', 'failed')),
  proposed_by bigint NOT NULL,
  approved_by bigint,
  approved_at timestamptz,
  applied_at timestamptz,
  rolled_back_at timestamptz,
  -- Сводка diff (counts) без закупочных деталей — для отображения и аудита.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.import_batches IS
  'Батчи импорта прайса: staging → approved → applied → rolled_back. checksum UNIQUE — идемпотентность повторной загрузки.';
COMMENT ON COLUMN public.import_batches.summary IS
  'Сводка diff (matched/unmatched/ambiguous/invalid/unchanged/proposed) без закупочных цен.';

CREATE TABLE public.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  sku text NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id),
  -- Категория/название/slug/source_url/status/old_price сюда не входят НИКОГДА.
  action text NOT NULL CHECK (action IN ('price', 'stock', 'qty', 'cost')),
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  row_status text NOT NULL DEFAULT 'proposed'
    CHECK (row_status IN ('proposed', 'applied', 'skipped', 'conflict', 'failed')),
  error text,
  applied_at timestamptz,
  UNIQUE (batch_id, line_no, action)
);

COMMENT ON TABLE public.import_rows IS
  'Строки батча импорта: снимки before/after для отката; действие только price/stock/qty/cost.';

CREATE TABLE public.import_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  staff_telegram_id bigint NOT NULL,
  event text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.import_events IS
  'Журнал событий батча импорта (создан/подтверждён/применён/откат/отменён) с actor и временем.';

-- Доступ: ТОЛЬКО service_role (бот). Публичных политик нет — таблицы закрыты.
GRANT ALL ON public.import_batches TO service_role;
GRANT ALL ON public.import_rows TO service_role;
GRANT ALL ON public.import_events TO service_role;
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_events ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- 2. RBAC-хелпер: права на импорт и на закупочные цены
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_import_role(p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff public.staff%ROWTYPE;
BEGIN
  SELECT * INTO v_staff FROM public.staff
   WHERE telegram_id = p_staff_telegram_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_IMPORT_FORBIDDEN'; END IF;
  -- import_prices: админ или директор с полным доступом (как permissions.ts).
  -- view_costs: админ или любой директор (как permissions.ts).
  RETURN jsonb_build_object(
    'import', v_staff.role = 'admin' OR (v_staff.role = 'director' AND v_staff.elevated),
    'costs', v_staff.role = 'admin' OR v_staff.role = 'director'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bot_import_role(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_import_role(bigint) TO service_role;

-- =====================================================================
-- 3. Валидация значений на уровне БД (не доверяем только TypeScript)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_import_validate_after(p_action text, p_after jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_price numeric;
  v_qty numeric;
BEGIN
  IF p_action IN ('price', 'cost') THEN
    IF (p_after->>'value') IS NULL
       OR (p_after->>'value') !~ '^[0-9]+(\.[0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'BOT_IMPORT_BAD_VALUE';
    END IF;
    v_price := (p_after->>'value')::numeric;
    IF v_price <= 0 OR v_price > 10000000 THEN RAISE EXCEPTION 'BOT_IMPORT_BAD_VALUE'; END IF;
  ELSIF p_action = 'stock' THEN
    IF jsonb_typeof(p_after->'value') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'BOT_IMPORT_BAD_VALUE';
    END IF;
  ELSIF p_action = 'qty' THEN
    IF (p_after->>'value') IS NULL OR (p_after->>'value') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'BOT_IMPORT_BAD_VALUE';
    END IF;
    v_qty := (p_after->>'value')::numeric;
    IF v_qty > 1000000 THEN RAISE EXCEPTION 'BOT_IMPORT_BAD_VALUE'; END IF;
  ELSE
    RAISE EXCEPTION 'BOT_IMPORT_BAD_ACTION';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_import_validate_after(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_import_validate_after(text, jsonb) TO service_role;

-- =====================================================================
-- 4. Создание батча (идемпотентно по checksum)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_import_create_batch(
  p_staff_telegram_id bigint,
  p_checksum text,
  p_source_name text,
  p_supplier_name text,
  p_summary jsonb,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role jsonb := public.bot_import_role(p_staff_telegram_id);
  v_existing public.import_batches%ROWTYPE;
  v_id uuid;
  v_row jsonb;
  v_action text;
  v_before jsonb;
  v_after jsonb;
  v_has_costs boolean := false;
BEGIN
  IF NOT coalesce((v_role->>'import')::boolean, false) THEN
    RAISE EXCEPTION 'BOT_IMPORT_FORBIDDEN';
  END IF;
  IF p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'BOT_IMPORT_BAD_CHECKSUM';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0
     OR jsonb_array_length(p_rows) > 10000 THEN
    RAISE EXCEPTION 'BOT_IMPORT_BAD_ROWS';
  END IF;

  -- Идемпотентность: тот же checksum — возвращаем существующий батч, дубль не создаём.
  SELECT * INTO v_existing FROM public.import_batches WHERE checksum = p_checksum;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'existing', true,
      'batch_id', v_existing.id, 'status', v_existing.status);
  END IF;

  INSERT INTO public.import_batches (checksum, source_name, supplier_name, summary, proposed_by)
  VALUES (p_checksum, left(p_source_name, 200), left(p_supplier_name, 200),
          coalesce(p_summary, '{}'::jsonb), p_staff_telegram_id)
  RETURNING id INTO v_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_action := v_row->>'action';
    v_before := v_row->'before';
    v_after := v_row->'after';
    IF v_action IS NULL OR v_action NOT IN ('price', 'stock', 'qty', 'cost') THEN
      RAISE EXCEPTION 'BOT_IMPORT_BAD_ACTION';
    END IF;
    IF v_action = 'cost' THEN v_has_costs := true; END IF;
    -- Валидация after на уровне БД: неверное значение откатывает весь батч.
    PERFORM public.bot_import_validate_after(v_action, v_after);
    -- Товар обязан существовать; SKU строки не переопределяет товар.
    IF NOT EXISTS (
      SELECT 1 FROM public.products WHERE id = (v_row->>'product_id')::uuid
    ) THEN
      RAISE EXCEPTION 'BOT_IMPORT_PRODUCT_NOT_FOUND';
    END IF;
    INSERT INTO public.import_rows (batch_id, line_no, sku, product_id, action, before_value, after_value)
    VALUES (v_id, (v_row->>'line_no')::integer, left(v_row->>'sku', 60),
            (v_row->>'product_id')::uuid, v_action, v_before, v_after);
  END LOOP;

  -- Закупочные строки требуют права view_costs (продавец их не импортирует).
  IF v_has_costs AND NOT coalesce((v_role->>'costs')::boolean, false) THEN
    RAISE EXCEPTION 'BOT_IMPORT_COST_FORBIDDEN';
  END IF;

  INSERT INTO public.import_events (batch_id, staff_telegram_id, event, details)
  VALUES (v_id, p_staff_telegram_id, 'created', jsonb_build_object(
    'rows', jsonb_array_length(p_rows), 'has_costs', v_has_costs,
    'summary', coalesce(p_summary, '{}'::jsonb), 'at', now()));

  RETURN jsonb_build_object('ok', true, 'existing', false, 'batch_id', v_id, 'status', 'staging');
END;
$$;

REVOKE ALL ON FUNCTION public.bot_import_create_batch(bigint, text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_import_create_batch(bigint, text, text, text, jsonb, jsonb)
  TO service_role;

-- =====================================================================
-- 5. Подтверждение батча
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_import_approve(p_batch_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role jsonb := public.bot_import_role(p_staff_telegram_id);
  v_batch public.import_batches%ROWTYPE;
BEGIN
  IF NOT coalesce((v_role->>'import')::boolean, false) THEN
    RAISE EXCEPTION 'BOT_IMPORT_FORBIDDEN';
  END IF;
  SELECT * INTO v_batch FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_IMPORT_NOT_FOUND'; END IF;
  IF v_batch.status <> 'staging' THEN RAISE EXCEPTION 'BOT_IMPORT_BAD_STATUS'; END IF;
  IF now() >= v_batch.expires_at THEN RAISE EXCEPTION 'BOT_IMPORT_EXPIRED'; END IF;

  UPDATE public.import_batches
     SET status = 'approved', approved_by = p_staff_telegram_id, approved_at = now()
   WHERE id = v_batch.id;

  INSERT INTO public.import_events (batch_id, staff_telegram_id, event, details)
  VALUES (v_batch.id, p_staff_telegram_id, 'approved', jsonb_build_object('at', now()));

  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch.id, 'status', 'approved');
END;
$$;

REVOKE ALL ON FUNCTION public.bot_import_approve(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_import_approve(uuid, bigint) TO service_role;

-- =====================================================================
-- 6. Применение батча — строго all-or-nothing
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_import_apply(p_batch_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role jsonb := public.bot_import_role(p_staff_telegram_id);
  v_batch public.import_batches%ROWTYPE;
  v_row public.import_rows%ROWTYPE;
  v_prod public.products%ROWTYPE;
  v_ok boolean;
  v_applied integer := 0;
BEGIN
  IF NOT coalesce((v_role->>'import')::boolean, false) THEN
    RAISE EXCEPTION 'BOT_IMPORT_FORBIDDEN';
  END IF;
  -- FOR UPDATE: параллельные apply/rollback одного батча сериализуются.
  SELECT * INTO v_batch FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_IMPORT_NOT_FOUND'; END IF;
  -- Повторный apply невозможен: применяется только approved-батч (идемпотентно-безопасно).
  IF v_batch.status <> 'approved' THEN RAISE EXCEPTION 'BOT_IMPORT_BAD_STATUS'; END IF;
  IF v_batch.approved_by IS NULL THEN RAISE EXCEPTION 'BOT_IMPORT_NOT_APPROVED'; END IF;
  IF now() >= v_batch.expires_at THEN RAISE EXCEPTION 'BOT_IMPORT_EXPIRED'; END IF;

  -- Закупочные строки в батче требуют view_costs у применяющего.
  IF EXISTS (SELECT 1 FROM public.import_rows WHERE batch_id = v_batch.id AND action = 'cost')
     AND NOT coalesce((v_role->>'costs')::boolean, false) THEN
    RAISE EXCEPTION 'BOT_IMPORT_COST_FORBIDDEN';
  END IF;

  -- Фаза 1: блокировка всех товаров батча в стабильном порядке (без deadlock)
  -- и сверка before-снимков. Любой конфликт — исключение, транзакция целиком
  -- откатывается: ни одна строка не применяется (all-or-nothing).
  FOR v_row IN
    SELECT * FROM public.import_rows WHERE batch_id = v_batch.id ORDER BY product_id, id
  LOOP
    SELECT * INTO v_prod FROM public.products WHERE id = v_row.product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOT_IMPORT_PRODUCT_NOT_FOUND'; END IF;

    IF v_row.action = 'price' THEN
      v_ok := (v_row.before_value ? 'value')
        AND round(v_prod.price * 100) = round((v_row.before_value->>'value')::numeric * 100);
    ELSIF v_row.action = 'stock' THEN
      v_ok := (v_row.before_value ? 'value')
        AND v_prod.in_stock = (v_row.before_value->>'value')::boolean;
    ELSIF v_row.action = 'qty' THEN
      v_ok := (v_row.before_value ? 'value')
        AND v_prod.stock_qty IS NOT DISTINCT FROM (v_row.before_value->>'value')::integer;
    ELSE -- cost
      SELECT count(*) = 1 INTO v_ok FROM public.product_costs
       WHERE product_id = v_row.product_id
         AND (before_value->>'value') IS NOT NULL
         AND round(cost_price * 100) = round((v_row.before_value->>'value')::numeric * 100);
      -- Отсутствие строки cost в before: значение было NULL.
      IF (v_row.before_value->'value') = 'null'::jsonb THEN
        v_ok := NOT EXISTS (
          SELECT 1 FROM public.product_costs WHERE product_id = v_row.product_id
        );
      END IF;
    END IF;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'BOT_IMPORT_CONFLICT: строка % (SKU %): значение изменилось с момента предпросмотра',
        v_row.line_no, v_row.sku;
    END IF;
  END LOOP;

  -- Фаза 2: применение всех строк (те же транзакции, блокировки удерживаются).
  FOR v_row IN
    SELECT * FROM public.import_rows WHERE batch_id = v_batch.id ORDER BY product_id, id
  LOOP
    IF v_row.action = 'price' THEN
      UPDATE public.products SET price = (v_row.after_value->>'value')::numeric
       WHERE id = v_row.product_id;
    ELSIF v_row.action = 'stock' THEN
      UPDATE public.products SET in_stock = (v_row.after_value->>'value')::boolean
       WHERE id = v_row.product_id;
    ELSIF v_row.action = 'qty' THEN
      UPDATE public.products SET stock_qty = (v_row.after_value->>'value')::integer
       WHERE id = v_row.product_id;
    ELSE -- cost: отдельная защищённая таблица, upsert
      INSERT INTO public.product_costs (product_id, cost_price, updated_at)
      VALUES (v_row.product_id, (v_row.after_value->>'value')::numeric, now())
      ON CONFLICT (product_id) DO UPDATE
        SET cost_price = EXCLUDED.cost_price, updated_at = now();
    END IF;
    UPDATE public.import_rows
       SET row_status = 'applied', applied_at = now()
     WHERE id = v_row.id;
    v_applied := v_applied + 1;
  END LOOP;

  UPDATE public.import_batches
     SET status = 'applied', applied_at = now()
   WHERE id = v_batch.id;

  -- Аудит обязателен: actor / time / батч / сводка.
  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id, 'price_import_applied', jsonb_build_object(
    'batch_id', v_batch.id, 'rows', v_applied,
    'checksum', v_batch.checksum, 'summary', v_batch.summary, 'at', now()));

  INSERT INTO public.import_events (batch_id, staff_telegram_id, event, details)
  VALUES (v_batch.id, p_staff_telegram_id, 'applied',
          jsonb_build_object('rows', v_applied, 'at', now()));

  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch.id, 'status', 'applied', 'rows', v_applied);
END;
$$;

REVOKE ALL ON FUNCTION public.bot_import_apply(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_import_apply(uuid, bigint) TO service_role;

-- =====================================================================
-- 7. Откат применённого батча (all-or-nothing, жёсткая сверка after)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_import_rollback(p_batch_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role jsonb := public.bot_import_role(p_staff_telegram_id);
  v_batch public.import_batches%ROWTYPE;
  v_row public.import_rows%ROWTYPE;
  v_prod public.products%ROWTYPE;
  v_ok boolean;
  v_restored integer := 0;
BEGIN
  IF NOT coalesce((v_role->>'import')::boolean, false) THEN
    RAISE EXCEPTION 'BOT_IMPORT_FORBIDDEN';
  END IF;
  SELECT * INTO v_batch FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_IMPORT_NOT_FOUND'; END IF;
  -- Откат только фактически применённого батча.
  IF v_batch.status <> 'applied' THEN RAISE EXCEPTION 'BOT_IMPORT_BAD_STATUS'; END IF;

  -- Фаза 1: сверка — текущее значение ТОЧНО равно after-снимку. Если после
  -- применения значение меняли ещё раз (ручная правка, другой импорт) —
  -- молчаливый откат запрещён: конфликт, батч не меняется.
  FOR v_row IN
    SELECT * FROM public.import_rows WHERE batch_id = v_batch.id ORDER BY product_id, id
  LOOP
    SELECT * INTO v_prod FROM public.products WHERE id = v_row.product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOT_IMPORT_PRODUCT_NOT_FOUND'; END IF;

    IF v_row.action = 'price' THEN
      v_ok := round(v_prod.price * 100) = round((v_row.after_value->>'value')::numeric * 100);
    ELSIF v_row.action = 'stock' THEN
      v_ok := v_prod.in_stock = (v_row.after_value->>'value')::boolean;
    ELSIF v_row.action = 'qty' THEN
      v_ok := v_prod.stock_qty IS NOT DISTINCT FROM (v_row.after_value->>'value')::integer;
    ELSE -- cost
      v_ok := EXISTS (
        SELECT 1 FROM public.product_costs
         WHERE product_id = v_row.product_id
           AND round(cost_price * 100) = round((v_row.after_value->>'value')::numeric * 100)
      );
    END IF;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'BOT_IMPORT_ROLLBACK_CONFLICT: строка % (SKU %): значение изменилось после применения — откат запрещён',
        v_row.line_no, v_row.sku;
    END IF;
  END LOOP;

  -- Фаза 2: восстановление before-снимков.
  FOR v_row IN
    SELECT * FROM public.import_rows WHERE batch_id = v_batch.id ORDER BY product_id, id
  LOOP
    IF v_row.action = 'price' THEN
      UPDATE public.products SET price = (v_row.before_value->>'value')::numeric
       WHERE id = v_row.product_id;
    ELSIF v_row.action = 'stock' THEN
      UPDATE public.products SET in_stock = (v_row.before_value->>'value')::boolean
       WHERE id = v_row.product_id;
    ELSIF v_row.action = 'qty' THEN
      UPDATE public.products SET stock_qty = (v_row.before_value->>'value')::integer
       WHERE id = v_row.product_id;
    ELSE -- cost: восстановить прежнее значение или удалить строку, если её не было
      IF (v_row.before_value->'value') = 'null'::jsonb THEN
        DELETE FROM public.product_costs WHERE product_id = v_row.product_id;
      ELSE
        INSERT INTO public.product_costs (product_id, cost_price, updated_at)
        VALUES (v_row.product_id, (v_row.before_value->>'value')::numeric, now())
        ON CONFLICT (product_id) DO UPDATE
          SET cost_price = EXCLUDED.cost_price, updated_at = now();
      END IF;
    END IF;
    UPDATE public.import_rows SET row_status = 'skipped' WHERE id = v_row.id;
    v_restored := v_restored + 1;
  END LOOP;

  UPDATE public.import_batches
     SET status = 'rolled_back', rolled_back_at = now()
   WHERE id = v_batch.id;

  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id, 'price_import_rolled_back', jsonb_build_object(
    'batch_id', v_batch.id, 'rows', v_restored,
    'checksum', v_batch.checksum, 'at', now()));

  INSERT INTO public.import_events (batch_id, staff_telegram_id, event, details)
  VALUES (v_batch.id, p_staff_telegram_id, 'rolled_back',
          jsonb_build_object('rows', v_restored, 'at', now()));

  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch.id, 'status', 'rolled_back', 'rows', v_restored);
END;
$$;

REVOKE ALL ON FUNCTION public.bot_import_rollback(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_import_rollback(uuid, bigint) TO service_role;

-- =====================================================================
-- Ограничения и заметки для ревизии
-- =====================================================================
--
-- 1. Импорт НЕ меняет: категорию, название, slug, source_url, status,
--    old_price, фото. В схеме и RPC таких действий нет.
-- 2. Закупочные цены идут только в public.product_costs (отдельная
--    защищённая таблица, без публичного доступа). cost-строки требуют
--    view_costs; продавцу импорт закупочных цен запрещён (BOT_IMPORT_COST_FORBIDDEN).
-- 3. apply/rollback — строго all-or-nothing: конфликт любой строки
--    откатывает всю транзакцию; батч остаётся approved (apply) или applied
--    (rollback) и может быть повторён после устранения конфликта.
-- 4. Идемпотентность: checksum UNIQUE — повторная загрузка того же файла
--    возвращает существующий батч; повторный apply/rollback того же батча
--    невозможен (BOT_IMPORT_BAD_STATUS).
-- 5. Применение qty (stock_qty) — только при явном подтверждении склада в
--    UI; здесь проверка передаётся вызывающим (code-level confirmQty).
-- 6. TTL батча 24 часа; просроченный staging/approved не применяется.
-- 7. Загрузка самого файла прайса из Telegram пока BLOCKED (gateway-бинарники
--    не проверены) — см. docs/price-import-rollout.md.
