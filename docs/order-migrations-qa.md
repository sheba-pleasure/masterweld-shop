# QA SQL-миграций заказов 0003 / 0004 / 0010 (+0011) — интернет-магазин «Мастер Сварщик»

Дата: 26.10.2026. К облачной БД — **только read-only metadata-запросы, никаких изменений данных
или схемы**. Миграции к облаку не применялись; INSERT/DDL туда не выполнялись.

## Версии и подтверждённое состояние облака
- Локальный тест: **PostgreSQL 17.9**. Облачная БД: **17.11** (тот же major 17, другая patch-версия).
- Read-only metadata облака, подтверждено 26.10.2026: `has_schema_privilege(anon|authenticated,'public','CREATE')=false`;
  на `public.shop_orders` у anon и authenticated есть GRANT SELECT, у anon — INSERT;
  публичная INSERT-политика присутствует; `order_events` не создан.
- Открытый **GRANT SELECT сам по себе НЕ означает чтения персональных данных**: RLS включён и
  SELECT-политики нет, поэтому строки клиентским ролям не возвращаются. 0011 — дополнительная
  защита (defense-in-depth): убирает и сами привилегии, чтобы ПДн не зависели от одного слоя.
- Реальные роли, владельцы и default privileges облака **не копировались**; локально созданы
  собственные роли и эмулирован худший случай (ALL по умолчанию для anon/authenticated).

## Что реально запущено
- Одноразовый локальный кластер в `/tmp/mw-sqlqa.*`, только unix-socket, `listen_addresses=''`.
  Скрипт снимает все `PG*`/`DATABASE_URL`/`SUPABASE_DB*`, отказывается работать, если `PGHOST`
  не `/tmp/mw-sqlqa.*` или сервер доступен по TCP; после прогона кластер удаляется.
- Системные файлы не изменяются. Не под root скрипт работает от текущего пользователя.
  Под root postgres запускается от **существующей** не-root учётки (`QA_PG_UID`, по умолчанию
  65534); если её нет — выход с кодом 4 и понятным сообщением.
- Запуск в песочнице: `QA_PG_UID=1000 bash scripts/sql-qa/run-order-migrations-qa.sh`.
  Токены, контакты и сеть не нужны; только синтетические строки.
- Порядок: роли → preflight «no_shop_orders» → 0000 → 0002 → preflight «before» → baseline → 0003 → 0004 → проверки →
  preflight «after 0004» → 0011 → 0010 → повтор 0004/0011/0010 → тесты функций →
  preflight «after all» → повтор 0003 → конкурентность.

**Итог: 68 реальных SQL-проверок (64 функциональных + 4 preflight), 0 провалов, exit 0.**
Это не production E2E.

## Read-only preflight
`scripts/sql-qa/preflight-order-migrations.sql` — один SELECT по системным каталогам, без строк
заказов и ПДн. Все объекты (shop_orders, order_events, order_status, RPC) разрешаются через
`to_regclass`/`to_regtype`, права проверяются только по найденным OID — поэтому запрос возвращает
false/NULL, а не ошибку, даже при полном отсутствии shop_orders (роли anon/authenticated/
service_role должны существовать). Столбцы 1–16 сохранены; добавлены в конец:
`m0003_enum_values_ok` (ровно new/processing/ready/completed/canceled в этом порядке) и
`m0003_status_definition_ok` (status NOT NULL, тип public.order_status, DEFAULT 'new').
Скрипт сам ни к чему не подключается; в облаке — только ручным read-only SQL.
В harness выполняется в сессии `default_transaction_read_only=on` в 4 точках: до создания
shop_orders (регресс отсутствующей таблицы), до 0003, после 0004 без 0011, после всех.

## Сценарии
Положительные: service_role INSERT после 0004; new→processing→ready→completed
(seller/admin/director); отмена из new/processing/ready; elevate on/off активным director;
повторный запуск 0004/0010/0011.

Отрицательные (реальные попытки): INSERT и SELECT заказов от anon/authenticated после
0004+0011 — отказ; EXECUTE обеих RPC от anon/authenticated — `permission denied`, PUBLIC нет в ACL;
незаконные переходы, NULL, canceled терминален; устаревший expected status и неизвестный заказ —
`BOT_ORDER_CONFLICT` без записей; неактивные/неизвестные сотрудники — `BOT_DENIED` без записей;
elevate не директором или неактивным — отказ; устаревшее ожидание — конфликт.

Атомарность: ошибка в `staff_audit_log` и отдельно в `order_events` откатывает всё; ошибка аудита
при elevate откатывает флаг. Конкурентность: вторая сессия ждала FOR UPDATE и получила
`BOT_ORDER_CONFLICT`; итог — один переход и одно событие.

## Найденные дефекты и исправления
1. 0004 отзывает только INSERT, 0003 не отзывает права на `order_events`. При default
   privileges у клиентских ролей остаются GRANT-ы; ПДн закрыты только RLS. Файлы
   `drizzle/migrations/*` read-only, поэтому добавлена review-only
   `docs/migrations/0011_order_privileges_hardening.sql` (только REVOKE/GRANT) — defense-in-depth.
2. 0010: `search_path = public` → `public, pg_temp`. Все имена таблиц в 0010 уже схемно
   квалифицированы; это защитное усиление, эксплуатируемая уязвимость через временные объекты
   **не доказана и не заявляется**.
3. 0003 не идемпотентна (повтор падает). Не исправлено (файл read-only); drizzle применяет её
   один раз; ручной повтор запрещён.

## Требования к применению (только после отдельного разрешения владельца)
0003 → внедрить и проверить серверный createOrder → 0004 + 0011 → preflight и проверка отказа
прямого INSERT/SELECT → 0010 → regression & Telegram E2E. 0004/0011 — после серверного пути,
до внешнего запуска.

## Блокеры
- Нет разрешения применять миграции к облаку; production E2E и живой Telegram не выполнялись.
- Default privileges/владельцы облака не сверены; различие 17.9 vs 17.11 не проверено.
- Юридические блокеры запуска (docs/legal-launch-checklist-2026.md).

## Откат
- 0010: удаление двух RPC возвращает бот в fail-closed (безопасно).
- 0011/0004: возврат публичного INSERT **небезопасен** — только отдельным решением с остановкой
  приёма заказов; автоматически не выполнять.
- 0003: колонку и таблицу оставить (additive).

## Прочие проверки 26.10.2026 (повторный прогон)
- SQL harness: exit 0 (68/68). Без `QA_PG_UID` под root: exit 4 (ожидаемый отказ).
- `npm test` 421/421 exit 0 (mock, не SQL); `npm run build` exit 0; `bash -n` exit 0.
- `npm run lint` в этом этапе не перезапускался; baseline прошлого прогона — **exit 1**, 407 ошибок/6 предупреждений — все в ранее существующих
  файлах (`src/integrations`, `src/components`, `src/lib`, `src/test`, `scripts/prelaunch-check.mjs`),
  в `scripts/sql-qa` ни одной. Изменённые файлы — .sql/.sh/.md, ESLint их не проверяет; это
  «неприменимо», а не «успешно».
