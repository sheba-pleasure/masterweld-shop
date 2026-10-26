-- Этап C2A: редактор карточек товара в Telegram-боте интернет-магазина
-- «Мастер Сварщик». Совместимая (additive) миграция поверх 0005.
--
-- НЕ ПРИМЕНЯТЬ до ревизии, вместе с развёртыванием кода
-- (см. docs/telegram-catalog-editor-rollout.md).
--
-- Файл — материал для ревизии. Применение выполняется инструментом миграций
-- Lovable (он создаёт свою журнальную запись), а не автозапуском этого файла.
--
-- Что делает:
--   1. Расширяет допустимые action в pending_actions (CHECK пересоздаётся шире,
--      данные не меняются).
--   2. Создаёт bot_editor_states — состояния диалогов редактора (TTL).
--   3. Транзакционные RPC (только service_role): атомарное применение/отмена
--      pending, подготовка отката, создание черновика.
--   4. Строгие guards: outcome applied/canceled (колонка из 0005), проверка
--      after_value на уровне БД (цена > 0 и ≤ 10 000 000, не более 2 знаков
--      после запятой), откат только при точном совпадении текущего значения
--      с after_value исходного действия.
--   slug и source_url НИКОГДА не входят в изменяемые поля.

-- =====================================================================
-- 1. Расширение action в pending_actions (без изменения данных)
-- =====================================================================

ALTER TABLE public.pending_actions DROP CONSTRAINT IF EXISTS pending_actions_action_check;
ALTER TABLE public.pending_actions ADD CONSTRAINT pending_actions_action_check
  CHECK (action IN ('price', 'stock', 'title', 'description', 'specs', 'brand', 'sku', 'category', 'status'));

-- =====================================================================
-- 2. Состояния диалогов редактора (stateful ввод), TTL
-- =====================================================================

CREATE TABLE public.bot_editor_states (
  staff_telegram_id bigint PRIMARY KEY,
  state text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  product_id uuid REFERENCES public.products(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Доступ: только service_role (бот). Публичных политик нет — таблица закрыта RLS.
GRANT ALL ON public.bot_editor_states TO service_role;
ALTER TABLE public.bot_editor_states ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.bot_editor_states IS
  'Состояния диалогов редактора бота (одно на сотрудника): TTL, одноразовость через consumed_at.';
COMMENT ON COLUMN public.bot_editor_states.state IS
  'edit_title/edit_description/edit_specs/edit_brand/edit_sku, pick_cat, new_title/new_sku/new_price/new_confirm.';

-- =====================================================================
-- 3. Slug: транслитерация названия (уникальность обеспечивается в bot_create_draft)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_slugify(p_title text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(
      trim(both '-' from regexp_replace(
        lower(translate(coalesce(p_title, ''),
          'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
          'abvgdeejziyklmnoprstufhccss_y_eua')),
        '[^a-z0-9]+', '-', 'g')),
      ''),
    'tovar')
$$;

REVOKE ALL ON FUNCTION public.bot_slugify(text) FROM PUBLIC, anon, authenticated;

-- =====================================================================
-- 4. Атомарное применение pending-действия (транзакция целиком)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_apply_pending(p_pending_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pending_actions%ROWTYPE;
  v_prod public.products%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_ok boolean;
  v_text text;
  v_price numeric;
  v_photos integer;
BEGIN
  -- Блокировка строки действия: параллельные подтверждения сериализуются.
  SELECT * INTO v_row FROM public.pending_actions WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PENDING_NOT_FOUND'; END IF;
  IF v_row.staff_telegram_id <> p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
  IF v_row.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'BOT_PENDING_CONSUMED'; END IF;
  IF now() >= v_row.expires_at THEN RAISE EXCEPTION 'BOT_PENDING_EXPIRED'; END IF;

  -- Блокировка строки товара: сверка «было» и UPDATE в одной транзакции.
  SELECT * INTO v_prod FROM public.products WHERE id = v_row.product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PRODUCT_NOT_FOUND'; END IF;

  v_before := v_row.before_value;
  v_after := v_row.after_value;

  -- Строгая проверка after_value на уровне БД (не доверяем только TypeScript):
  -- любое неверное значение откатывает транзакцию целиком, товар не меняется.
  IF v_row.action = 'price' THEN
    IF (v_after->>'price') IS NULL
       OR (v_after->>'price') !~ '^[0-9]+(\.[0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'BOT_BAD_VALUE';
    END IF;
    v_price := (v_after->>'price')::numeric;
    IF v_price <= 0 OR v_price > 10000000 THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
  ELSIF v_row.action = 'stock' THEN
    IF jsonb_typeof(v_after->'in_stock') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'BOT_BAD_VALUE';
    END IF;
  ELSIF v_row.action = 'status' THEN
    IF coalesce(v_after->>'status', '') NOT IN ('draft', 'published', 'hidden') THEN
      RAISE EXCEPTION 'BOT_BAD_VALUE';
    END IF;
  ELSIF v_row.action = 'category' THEN
    IF v_after->>'category_id' IS NOT NULL
       AND (v_after->>'category_id') !~ '^[0-9a-fA-F-]{36}$' THEN
      RAISE EXCEPTION 'BOT_BAD_VALUE';
    END IF;
  END IF;

  -- Сверка сохранённого «было» с текущим состоянием (оптимистичная блокировка).
  IF v_row.action = 'price' THEN
    v_ok := (v_before ? 'price')
      AND round(v_prod.price * 100) = round((v_before->>'price')::numeric * 100);
  ELSIF v_row.action = 'stock' THEN
    v_ok := (v_before ? 'in_stock')
      AND v_prod.in_stock = (v_before->>'in_stock')::boolean;
  ELSIF v_row.action IN ('title', 'description', 'specs', 'brand', 'sku') THEN
    v_ok := (v_before ? v_row.action)
      AND (to_jsonb(v_prod.*) ->> v_row.action) IS NOT DISTINCT FROM (v_before ->> v_row.action);
  ELSIF v_row.action = 'category' THEN
    v_ok := (v_before ? 'category_id')
      AND v_prod.category_id IS NOT DISTINCT FROM (v_before->>'category_id')::uuid;
  ELSIF v_row.action = 'status' THEN
    v_ok := (v_before ? 'status') AND v_prod.status::text = v_before->>'status';
  ELSE
    RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION';
  END IF;
  IF NOT v_ok THEN RAISE EXCEPTION 'BOT_PENDING_CONFLICT'; END IF;

  -- Применение к товару.
  IF v_row.action = 'price' THEN
    UPDATE public.products SET price = v_price WHERE id = v_prod.id;
  ELSIF v_row.action = 'stock' THEN
    UPDATE public.products SET in_stock = (v_after->>'in_stock')::boolean WHERE id = v_prod.id;
  ELSIF v_row.action = 'title' THEN
    v_text := btrim(coalesce(v_after->>'title', ''));
    IF length(v_text) < 3 OR length(v_text) > 300 THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
    UPDATE public.products SET title = v_text WHERE id = v_prod.id;
  ELSIF v_row.action = 'sku' THEN
    v_text := nullif(btrim(coalesce(v_after->>'sku', '')), '');
    IF v_text IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.products WHERE sku = v_text AND id <> v_prod.id
    ) THEN RAISE EXCEPTION 'BOT_SKU_DUPLICATE'; END IF;
    UPDATE public.products SET sku = v_text WHERE id = v_prod.id;
  ELSIF v_row.action IN ('description', 'specs', 'brand') THEN
    -- Динамический UPDATE безопасен: имя колонки берётся из белого списка выше.
    EXECUTE format('UPDATE public.products SET %I = $1 WHERE id = $2', v_row.action)
      USING nullif(btrim(coalesce(v_after->>v_row.action, '')), ''), v_prod.id;
  ELSIF v_row.action = 'category' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.categories WHERE id = (v_after->>'category_id')::uuid
    ) THEN RAISE EXCEPTION 'BOT_CATEGORY_NOT_FOUND'; END IF;
    UPDATE public.products SET category_id = (v_after->>'category_id')::uuid WHERE id = v_prod.id;
  ELSIF v_row.action = 'status' THEN
    IF (v_after->>'status') = 'published' THEN
      SELECT count(*) INTO v_photos FROM public.product_photos WHERE product_id = v_prod.id;
      IF btrim(v_prod.title) = '' OR v_prod.price <= 0 OR v_photos = 0 THEN
        RAISE EXCEPTION 'BOT_PUBLISH_MISSING_FIELDS';
      END IF;
    END IF;
    UPDATE public.products
      SET status = (v_after->>'status')::public.product_status
      WHERE id = v_prod.id;
  ELSE
    RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION';
  END IF;

  -- Одноразовость и итог: помечаем применённым в той же транзакции.
  -- outcome='applied' — единственное доказательство, по которому разрешён откат.
  UPDATE public.pending_actions SET consumed_at = now(), outcome = 'applied' WHERE id = v_row.id;

  -- Аудит: actor / time / before / after.
  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id, 'catalog_' || v_row.action, jsonb_build_object(
    'pending_id', v_row.id,
    'product_id', v_prod.id,
    'sku', v_prod.sku,
    'before', v_before,
    'after', v_after,
    'at', now()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_row.action,
    'product_id', v_prod.id,
    'title', v_prod.title,
    'before', v_before,
    'after', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bot_apply_pending(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_apply_pending(uuid, bigint) TO service_role;

-- =====================================================================
-- 5. Атомарная отмена pending-действия
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_cancel_pending(p_pending_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pending_actions%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.pending_actions WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PENDING_NOT_FOUND'; END IF;
  IF v_row.staff_telegram_id <> p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
  IF v_row.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'BOT_PENDING_CONSUMED'; END IF;
  IF now() >= v_row.expires_at THEN RAISE EXCEPTION 'BOT_PENDING_EXPIRED'; END IF;

  -- outcome='canceled': отмена НИКОГДА не считается применением.
  UPDATE public.pending_actions SET consumed_at = now(), outcome = 'canceled' WHERE id = v_row.id;

  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id, 'catalog_cancel', jsonb_build_object(
    'pending_id', v_row.id,
    'action', v_row.action,
    'product_id', v_row.product_id,
    'at', now()
  ));

  RETURN jsonb_build_object('ok', true, 'action', v_row.action);
END;
$$;

REVOKE ALL ON FUNCTION public.bot_cancel_pending(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_cancel_pending(uuid, bigint) TO service_role;

-- =====================================================================
-- 6. Подготовка отката: новое pending с обратными значениями (preview → confirm)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_prepare_rollback(p_pending_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src public.pending_actions%ROWTYPE;
  v_prod public.products%ROWTYPE;
  v_cur jsonb;
  v_new_id uuid;
BEGIN
  -- FOR UPDATE: параллельные попытки отката одного действия сериализуются.
  SELECT * INTO v_src FROM public.pending_actions WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PENDING_NOT_FOUND'; END IF;
  IF v_src.staff_telegram_id <> p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
  -- Откат разрешён ТОЛЬКО для фактически применённого действия. consumed_at
  -- выставляется и при отмене, поэтому решает outcome, а не consumed_at.
  -- Legacy-строки без outcome (доказательства применения нет) — fail closed.
  IF v_src.outcome IS NULL THEN RAISE EXCEPTION 'BOT_PENDING_LEGACY_NO_OUTCOME'; END IF;
  IF v_src.outcome <> 'applied' THEN RAISE EXCEPTION 'BOT_PENDING_NOT_APPLIED'; END IF;

  SELECT * INTO v_prod FROM public.products WHERE id = v_src.product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PRODUCT_NOT_FOUND'; END IF;

  -- Текущий снимок значения по действию — станет «было» для отката.
  IF v_src.action = 'price' THEN
    v_cur := jsonb_build_object('price', v_prod.price);
  ELSIF v_src.action = 'stock' THEN
    v_cur := jsonb_build_object('in_stock', v_prod.in_stock);
  ELSIF v_src.action IN ('title', 'description', 'specs', 'brand', 'sku') THEN
    v_cur := jsonb_build_object(v_src.action, to_jsonb(v_prod.*) ->> v_src.action);
  ELSIF v_src.action = 'category' THEN
    v_cur := jsonb_build_object('category_id', v_prod.category_id);
  ELSIF v_src.action = 'status' THEN
    v_cur := jsonb_build_object('status', v_prod.status::text);
  ELSE
    RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION';
  END IF;

  -- Если текущее значение уже совпадает с исходным «было» — откатывать нечего.
  IF v_cur IS NOT DISTINCT FROM v_src.before_value THEN
    RAISE EXCEPTION 'BOT_NOTHING_TO_ROLLBACK';
  END IF;
  -- Жёсткий guard: откат допустим, только если текущее значение ТОЧНО равно
  -- after_value исходного действия. Если поле меняли ещё раз после применения
  -- (например 100→200→300), молчаливый откат 300→100 запрещён — конфликт,
  -- pending rollback не создаётся.
  IF v_cur IS DISTINCT FROM v_src.after_value THEN
    RAISE EXCEPTION 'BOT_ROLLBACK_CONFLICT';
  END IF;

  INSERT INTO public.pending_actions
    (staff_telegram_id, product_id, action, before_value, after_value, expires_at)
  VALUES
    (p_staff_telegram_id, v_src.product_id, v_src.action, v_cur, v_src.before_value,
     now() + interval '15 minutes')
  RETURNING id INTO v_new_id;

  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id, 'catalog_rollback_prepared', jsonb_build_object(
    'source_pending_id', v_src.id,
    'new_pending_id', v_new_id,
    'product_id', v_src.product_id,
    'action', v_src.action,
    'at', now()
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'pending_id', v_new_id,
    'action', v_src.action,
    'product_id', v_src.product_id,
    'title', v_prod.title,
    'before', v_cur,
    'after', v_src.before_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bot_prepare_rollback(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_prepare_rollback(uuid, bigint) TO service_role;

-- =====================================================================
-- 7. Создание черновика (только draft, дубли SKU запрещены, slug уникален)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_create_draft(
  p_staff_telegram_id bigint,
  p_title text,
  p_sku text,
  p_price numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title text := btrim(coalesce(p_title, ''));
  v_sku text := nullif(btrim(coalesce(p_sku, '')), '');
  v_base text;
  v_slug text;
  v_n integer := 1;
  v_id uuid;
BEGIN
  IF length(v_title) < 3 OR length(v_title) > 300 THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
  IF p_price IS NULL OR p_price <= 0 OR p_price > 10000000
     OR round(p_price * 100) <> p_price * 100 THEN
    RAISE EXCEPTION 'BOT_BAD_VALUE';
  END IF;
  IF v_sku IS NOT NULL AND length(v_sku) > 60 THEN RAISE EXCEPTION 'BOT_BAD_VALUE'; END IF;
  -- Дублирующийся SKU — отказ, случайная позиция не выбирается.
  IF v_sku IS NOT NULL AND EXISTS (SELECT 1 FROM public.products WHERE sku = v_sku) THEN
    RAISE EXCEPTION 'BOT_SKU_DUPLICATE';
  END IF;

  v_base := public.bot_slugify(v_title);
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM public.products WHERE slug = v_slug) LOOP
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  END LOOP;

  -- Только черновик; source_url не приписывается; ID — UUID по умолчанию.
  INSERT INTO public.products (slug, title, sku, price, status)
  VALUES (v_slug, v_title, v_sku, p_price, 'draft')
  RETURNING id INTO v_id;

  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id, 'draft_created', jsonb_build_object(
    'product_id', v_id,
    'slug', v_slug,
    'title', v_title,
    'sku', v_sku,
    'price', p_price,
    'at', now()
  ));

  RETURN jsonb_build_object('ok', true, 'product_id', v_id, 'slug', v_slug, 'title', v_title);
END;
$$;

REVOKE ALL ON FUNCTION public.bot_create_draft(bigint, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_create_draft(bigint, text, text, numeric) TO service_role;
