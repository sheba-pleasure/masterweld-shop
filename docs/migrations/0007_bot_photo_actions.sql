-- Этап C2B: управление фотографиями товара в Telegram-боте интернет-магазина
-- «Мастер Сварщик». Совместимая (additive) миграция поверх 0005/0006.
--
-- НЕ ПРИМЕНЯТЬ до ревизии, вместе с развёртыванием кода
-- (см. docs/telegram-photo-rollout.md).
--
-- Файл — материал для ревизии. Применение выполняется инструментом миграций
-- Lovable (он создаёт свою журнальную запись), а не автозапуском этого файла.
--
-- Что делает:
--   1. Добавляет в product_photos служебные колонки (все nullable, данные
--      не меняются): deleted_at (обратимое удаление/карантин), mime,
--      size_bytes, hash (анти-дубликат SHA-256), staging_key (путь в
--      приватном staging-бакете), width/height.
--   2. Индекс (product_id, sort_order) по неудалённым фото.
--   3. Обновляет публичную политику чтения product_photos: удалённые фото
--      (deleted_at IS NOT NULL) не видны на витрине.
--   4. Расширяет CHECK pending_actions.action фото-действиями
--      (photo_main, photo_reorder, photo_delete); данные не меняются.
--   5. Транзакционные RPC (SECURITY DEFINER, REVOKE PUBLIC/anon/authenticated,
--      GRANT только service_role): bot_set_photo_main, bot_reorder_photo,
--      bot_delete_photo_meta + обновлённый bot_prepare_rollback,
--      понимающий фото-действия.
--
-- Принципы безопасности:
--   - Все RPC: блокировка строки действия и всех фото товара (FOR UPDATE),
--     проверка владельца/TTL/consumed/outcome, сверка before_value с текущим
--     состоянием, consumed_at + outcome='applied' + аудит — одной транзакцией.
--   - Удаление ОБРАТИМОЕ: файл не удаляется физически (карантин через
--     deleted_at); физическая чистка storage — отдельная процедура.
--   - Основное фото всегда sort_order = 0; последнее фото опубликованного
--     товара удалить нельзя (BOT_PHOTO_LAST_PUBLISHED).
--   - Публичное чтение галереи витриной не требует этой миграции (она нужна
--     только боту); после применения публичная политика корректно скрывает
--     фото в карантине.

-- =====================================================================
-- 1. Служебные колонки product_photos (additive, nullable)
-- =====================================================================

ALTER TABLE public.product_photos ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.product_photos ADD COLUMN IF NOT EXISTS mime text;
ALTER TABLE public.product_photos ADD COLUMN IF NOT EXISTS size_bytes bigint;
ALTER TABLE public.product_photos ADD COLUMN IF NOT EXISTS hash text;
ALTER TABLE public.product_photos ADD COLUMN IF NOT EXISTS staging_key text;
ALTER TABLE public.product_photos ADD COLUMN IF NOT EXISTS width integer;
ALTER TABLE public.product_photos ADD COLUMN IF NOT EXISTS height integer;

COMMENT ON COLUMN public.product_photos.deleted_at IS
  'Обратимое удаление (карантин): NOT NULL — фото скрыто из витрины, файл в storage сохранён.';
COMMENT ON COLUMN public.product_photos.hash IS
  'SHA-256 файла — защита от повторной загрузки дубля.';
COMMENT ON COLUMN public.product_photos.staging_key IS
  'Путь файла в приватном staging-бакете до публикации (загрузка из Telegram пока не подключена).';

-- =====================================================================
-- 2. Индекс по неудалённым фото товара
-- =====================================================================

CREATE INDEX IF NOT EXISTS product_photos_active_idx
  ON public.product_photos (product_id, sort_order)
  WHERE deleted_at IS NULL;

-- =====================================================================
-- 3. Публичное чтение: только неудалённые фото опубликованных товаров
-- =====================================================================

DROP POLICY IF EXISTS "Public can read photos of published products" ON public.product_photos;
CREATE POLICY "Public can read photos of published products"
  ON public.product_photos
  FOR SELECT
  TO anon, authenticated
  USING (
    deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_photos.product_id
        AND p.status = 'published'::public.product_status
    )
  );

-- =====================================================================
-- 4. Расширение action в pending_actions фото-действиями (без изменения данных)
-- =====================================================================

ALTER TABLE public.pending_actions DROP CONSTRAINT IF EXISTS pending_actions_action_check;
ALTER TABLE public.pending_actions ADD CONSTRAINT pending_actions_action_check
  CHECK (action IN ('price', 'stock', 'title', 'description', 'specs', 'brand', 'sku',
                    'category', 'status', 'photo_main', 'photo_reorder', 'photo_delete'));

-- =====================================================================
-- 5.1. Сделать фото основным (value-driven: работает и для отката)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_set_photo_main(p_pending_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pending_actions%ROWTYPE;
  v_photo public.product_photos%ROWTYPE;
  v_prev uuid;
  v_title text;
BEGIN
  SELECT * INTO v_row FROM public.pending_actions WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PENDING_NOT_FOUND'; END IF;
  IF v_row.staff_telegram_id <> p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
  IF v_row.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'BOT_PENDING_CONSUMED'; END IF;
  IF now() >= v_row.expires_at THEN RAISE EXCEPTION 'BOT_PENDING_EXPIRED'; END IF;
  IF v_row.action <> 'photo_main' THEN RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION'; END IF;

  -- Блокировка всех фото товара: сериализует параллельные изменения галереи.
  PERFORM 1 FROM public.product_photos WHERE product_id = v_row.product_id FOR UPDATE;

  SELECT * INTO v_photo FROM public.product_photos
   WHERE id = (v_row.after_value->>'photo_id')::uuid
     AND product_id = v_row.product_id
     AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PHOTO_NOT_FOUND'; END IF;

  -- Сверка «было»: целевое фото на месте и его состояние не менялось.
  IF (v_row.before_value->>'photo_id') IS NULL
     OR v_photo.id <> (v_row.before_value->>'photo_id')::uuid
     OR v_photo.is_main IS DISTINCT FROM (v_row.before_value->>'is_main')::boolean
     OR v_photo.sort_order IS DISTINCT FROM (v_row.before_value->>'sort_order')::integer THEN
    RAISE EXCEPTION 'BOT_PHOTO_CONFLICT';
  END IF;

  -- Прежнее основное фото снимаем (для отката prev_main_id = само фото — пропускаем).
  v_prev := nullif(v_row.before_value->>'prev_main_id', '')::uuid;
  IF v_prev IS NOT NULL AND v_prev <> v_photo.id THEN
    UPDATE public.product_photos SET is_main = false
     WHERE id = v_prev AND product_id = v_row.product_id;
  END IF;
  -- Гарантия единственности основного фото.
  UPDATE public.product_photos SET is_main = false
   WHERE product_id = v_row.product_id AND deleted_at IS NULL
     AND id <> v_photo.id AND is_main;
  -- Основное фото всегда первое в списке.
  UPDATE public.product_photos SET is_main = true, sort_order = 0 WHERE id = v_photo.id;

  UPDATE public.pending_actions SET consumed_at = now(), outcome = 'applied' WHERE id = v_row.id;

  SELECT title INTO v_title FROM public.products WHERE id = v_row.product_id;
  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id, 'photo_main', jsonb_build_object(
    'pending_id', v_row.id,
    'product_id', v_row.product_id,
    'photo_id', v_photo.id,
    'prev_main_id', v_prev,
    'before', v_row.before_value,
    'after', v_row.after_value,
    'at', now()
  ));

  RETURN jsonb_build_object(
    'ok', true, 'action', v_row.action, 'product_id', v_row.product_id,
    'title', v_title, 'before', v_row.before_value, 'after', v_row.after_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bot_set_photo_main(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_set_photo_main(uuid, bigint) TO service_role;

-- =====================================================================
-- 5.2. Изменить порядок фото (value-driven: after.sort_order — новая позиция)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_reorder_photo(p_pending_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pending_actions%ROWTYPE;
  v_photo public.product_photos%ROWTYPE;
  v_new integer;
  v_n integer;
  v_pos integer;
  v_title text;
  r record;
BEGIN
  SELECT * INTO v_row FROM public.pending_actions WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PENDING_NOT_FOUND'; END IF;
  IF v_row.staff_telegram_id <> p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
  IF v_row.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'BOT_PENDING_CONSUMED'; END IF;
  IF now() >= v_row.expires_at THEN RAISE EXCEPTION 'BOT_PENDING_EXPIRED'; END IF;
  IF v_row.action <> 'photo_reorder' THEN RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION'; END IF;

  PERFORM 1 FROM public.product_photos WHERE product_id = v_row.product_id FOR UPDATE;

  SELECT * INTO v_photo FROM public.product_photos
   WHERE id = (v_row.after_value->>'photo_id')::uuid
     AND product_id = v_row.product_id
     AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PHOTO_NOT_FOUND'; END IF;

  -- Основное фото всегда первое — его порядок менять нельзя.
  IF v_photo.is_main THEN RAISE EXCEPTION 'BOT_PHOTO_MAIN_CANNOT_REORDER'; END IF;

  IF v_photo.id <> (v_row.before_value->>'photo_id')::uuid
     OR v_photo.sort_order IS DISTINCT FROM (v_row.before_value->>'sort_order')::integer THEN
    RAISE EXCEPTION 'BOT_PHOTO_CONFLICT';
  END IF;

  v_new := (v_row.after_value->>'sort_order')::integer;
  SELECT count(*) INTO v_n FROM public.product_photos
   WHERE product_id = v_row.product_id AND deleted_at IS NULL AND NOT is_main;
  IF v_new IS NULL OR v_new < 1 OR v_new > v_n THEN RAISE EXCEPTION 'BOT_PHOTO_CONFLICT'; END IF;

  -- Двухфазная перенумерация без коллизий: цель → −1, остальные 1..n без
  -- пропущенного места, цель → новая позиция.
  UPDATE public.product_photos SET sort_order = -1 WHERE id = v_photo.id;
  v_pos := 0;
  FOR r IN
    SELECT id FROM public.product_photos
     WHERE product_id = v_row.product_id AND deleted_at IS NULL AND NOT is_main
       AND id <> v_photo.id
     ORDER BY sort_order, created_at
  LOOP
    v_pos := v_pos + 1;
    IF v_pos = v_new THEN v_pos := v_pos + 1; END IF;
    UPDATE public.product_photos SET sort_order = v_pos WHERE id = r.id;
  END LOOP;
  UPDATE public.product_photos SET sort_order = v_new WHERE id = v_photo.id;

  UPDATE public.pending_actions SET consumed_at = now(), outcome = 'applied' WHERE id = v_row.id;

  SELECT title INTO v_title FROM public.products WHERE id = v_row.product_id;
  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id, 'photo_reorder', jsonb_build_object(
    'pending_id', v_row.id,
    'product_id', v_row.product_id,
    'photo_id', v_photo.id,
    'before', v_row.before_value,
    'after', v_row.after_value,
    'at', now()
  ));

  RETURN jsonb_build_object(
    'ok', true, 'action', v_row.action, 'product_id', v_row.product_id,
    'title', v_title, 'before', v_row.before_value, 'after', v_row.after_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bot_reorder_photo(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_reorder_photo(uuid, bigint) TO service_role;

-- =====================================================================
-- 5.3. Обратимое удаление фото / восстановление из карантина
--      (value-driven: after.deleted = true → удалить; иначе — восстановить;
--      откат удаления приходит сюда же со swapped before/after)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bot_delete_photo_meta(p_pending_id uuid, p_staff_telegram_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pending_actions%ROWTYPE;
  v_photo public.product_photos%ROWTYPE;
  v_active integer;
  v_status text;
  v_title text;
  v_restore boolean;
BEGIN
  SELECT * INTO v_row FROM public.pending_actions WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PENDING_NOT_FOUND'; END IF;
  IF v_row.staff_telegram_id <> p_staff_telegram_id THEN RAISE EXCEPTION 'BOT_PENDING_NOT_OWNER'; END IF;
  IF v_row.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'BOT_PENDING_CONSUMED'; END IF;
  IF now() >= v_row.expires_at THEN RAISE EXCEPTION 'BOT_PENDING_EXPIRED'; END IF;
  IF v_row.action <> 'photo_delete' THEN RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION'; END IF;

  PERFORM 1 FROM public.product_photos WHERE product_id = v_row.product_id FOR UPDATE;

  SELECT * INTO v_photo FROM public.product_photos
   WHERE id = (v_row.after_value->>'photo_id')::uuid
     AND product_id = v_row.product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PHOTO_NOT_FOUND'; END IF;

  v_restore := NOT coalesce((v_row.after_value->>'deleted')::boolean, false);

  IF v_restore THEN
    -- Восстановление из карантина (откат удаления).
    IF (v_row.before_value->>'photo_id') IS NULL
       OR v_photo.id <> (v_row.before_value->>'photo_id')::uuid
       OR NOT coalesce((v_row.before_value->>'deleted')::boolean, false)
       OR v_photo.deleted_at IS NULL THEN
      RAISE EXCEPTION 'BOT_PHOTO_CONFLICT';
    END IF;
    -- Если фото возвращается основным — снять текущее основное.
    IF coalesce((v_row.after_value->>'is_main')::boolean, false) THEN
      UPDATE public.product_photos SET is_main = false
       WHERE product_id = v_row.product_id AND deleted_at IS NULL
         AND id <> v_photo.id AND is_main;
    END IF;
    UPDATE public.product_photos
       SET deleted_at = NULL,
           is_main = coalesce((v_row.after_value->>'is_main')::boolean, false),
           sort_order = coalesce((v_row.after_value->>'sort_order')::integer, v_photo.sort_order)
     WHERE id = v_photo.id;
  ELSE
    -- Обратимое удаление: только неудалённое фото, состояние не менялось.
    IF v_photo.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'BOT_PHOTO_NOT_FOUND'; END IF;
    IF v_photo.id <> (v_row.before_value->>'photo_id')::uuid
       OR v_photo.is_main IS DISTINCT FROM (v_row.before_value->>'is_main')::boolean
       OR v_photo.sort_order IS DISTINCT FROM (v_row.before_value->>'sort_order')::integer THEN
      RAISE EXCEPTION 'BOT_PHOTO_CONFLICT';
    END IF;

    -- Последнее фото опубликованного товара удалять нельзя.
    SELECT count(*) INTO v_active FROM public.product_photos
     WHERE product_id = v_row.product_id AND deleted_at IS NULL;
    IF v_active <= 1 THEN
      SELECT status::text INTO v_status FROM public.products WHERE id = v_row.product_id;
      IF v_status = 'published' THEN RAISE EXCEPTION 'BOT_PHOTO_LAST_PUBLISHED'; END IF;
    END IF;

    -- Карантин: файл в storage НЕ удаляется физически.
    UPDATE public.product_photos SET deleted_at = now(), is_main = false WHERE id = v_photo.id;

    -- Если удалили основное — назначаем первое оставшееся.
    IF v_photo.is_main THEN
      UPDATE public.product_photos SET is_main = true, sort_order = 0
       WHERE id = (
         SELECT id FROM public.product_photos
          WHERE product_id = v_row.product_id AND deleted_at IS NULL
          ORDER BY sort_order, created_at
          LIMIT 1
       );
    END IF;
  END IF;

  UPDATE public.pending_actions SET consumed_at = now(), outcome = 'applied' WHERE id = v_row.id;

  SELECT title INTO v_title FROM public.products WHERE id = v_row.product_id;
  INSERT INTO public.staff_audit_log (telegram_id, action, details)
  VALUES (p_staff_telegram_id,
          CASE WHEN v_restore THEN 'photo_restore' ELSE 'photo_quarantine' END,
          jsonb_build_object(
    'pending_id', v_row.id,
    'product_id', v_row.product_id,
    'photo_id', v_photo.id,
    'before', v_row.before_value,
    'after', v_row.after_value,
    'at', now()
  ));

  RETURN jsonb_build_object(
    'ok', true, 'action', v_row.action, 'product_id', v_row.product_id,
    'title', v_title, 'before', v_row.before_value, 'after', v_row.after_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bot_delete_photo_meta(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_delete_photo_meta(uuid, bigint) TO service_role;

-- =====================================================================
-- 5.4. bot_prepare_rollback: версия 0006 + фото-действия
--      (строгие guards: только outcome='applied' и текущее значение ТОЧНО
--      равно after_value исходного действия — см. аудит безопасности)
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
  v_photo public.product_photos%ROWTYPE;
  v_main uuid;
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
  ELSIF v_src.action IN ('photo_main', 'photo_reorder', 'photo_delete') THEN
    SELECT * INTO v_photo FROM public.product_photos
     WHERE id = (v_src.after_value->>'photo_id')::uuid
       AND product_id = v_src.product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOT_PHOTO_NOT_FOUND'; END IF;
    IF v_src.action = 'photo_main' THEN
      SELECT id INTO v_main FROM public.product_photos
       WHERE product_id = v_src.product_id AND deleted_at IS NULL AND is_main
       LIMIT 1;
      v_cur := jsonb_build_object(
        'photo_id', v_photo.id,
        'is_main', v_photo.is_main,
        'sort_order', v_photo.sort_order,
        'prev_main_id', v_main
      );
    ELSIF v_src.action = 'photo_reorder' THEN
      v_cur := jsonb_build_object(
        'photo_id', v_photo.id,
        'sort_order', v_photo.sort_order,
        'is_main', v_photo.is_main
      );
    ELSE
      -- photo_delete: current snapshot должен отражать актуальное состояние
      -- (в карантине или восстановлено) — сверка пойдёт с after_value.
      v_cur := jsonb_build_object(
        'photo_id', v_photo.id,
        'is_main', v_photo.is_main,
        'sort_order', v_photo.sort_order
      );
    END IF;
  ELSE
    RAISE EXCEPTION 'BOT_PENDING_BAD_ACTION';
  END IF;

  -- Если текущее значение уже совпадает с исходным «было» — откатывать нечего.
  IF v_cur IS NOT DISTINCT FROM v_src.before_value THEN
    RAISE EXCEPTION 'BOT_NOTHING_TO_ROLLBACK';
  END IF;
  -- Жёсткий guard: откат допустим, только если текущее значение ТОЧНО равно
  -- after_value исходного действия. Если фото/поле меняли ещё раз после
  -- применения, молчаливый откат запрещён — конфликт, pending не создаётся.
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
-- Ограничения и заметки для ревизии
-- =====================================================================
--
-- 1. Загрузка новых фото из Telegram НЕ входит в эту миграцию: код-путь
--    (getFile → /file/<path> через gateway) реализован в photos.ts как
--    адаптер, но НЕ проверен вживую — флаг TELEGRAM_PHOTO_UPLOAD_VERIFIED
--    остаётся false, попытки отвечают «Загрузка из Telegram пока не
--    подключена». См. docs/telegram-photo-rollout.md.
-- 2. staging_key/hash/mime/size_bytes/width/height заполняются только
--    будущим загрузчиком; существующие 1 077 фото остаются с NULL.
-- 3. Физическое удаление файлов из storage не выполняется: только карантин
--    (deleted_at). Чистка карантина — отдельная админ-процедура.
-- 4. sort_order основного фото всегда 0; bot_reorder_photo перенумеровывает
--    неосновные фото в 1..n.
-- 5. Откат фото-действий идёт через те же функции (value-driven) с
--    swapped before/after; sort_order основного фото при откате
--    восстанавливается как 0.
