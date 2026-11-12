# Среды и обслуживание

Описание обновлено 11.11.2026. Установленные версии и даты проверок — в [STATUS.md](../STATUS.md); исторические проверки ниже сохраняют свои даты.

| Объект | DEV | Рабочая среда |
|---|---|---|
| Сайт | masterweld-dev.138-124-106-211.sslip.io | shop.masterweld.ru, пока не выпущен |
| Боты | @testmw639bot, подключён; /shop для проверки Mini App | @msvarbot — покупатели; @masterweldermanagerbot — сотрудники. Подготовлены, новый backend ещё не подключён |
| База | mw-dev-db / masterweld_dev | mw-prod-db / masterweld_production, пока пустая |
| Volume | mw-dev-pgdata | mw-prod-pgdata |
| REST | mw-dev-rest | mw-prod-rest → mw-prod-api, loopback :18084 |
| Вход | Caddy → mw-dev-gateway | Требует настройки |
| Приложение | mw-dev-app | mw-shop-slot-a/b |
| Секреты | ops/.secrets/dev (700/600) | ops/.secrets/production (700/600); полный shop.env.candidate подготовлен и проверен, активный shop.env отсутствует |
| Instance ID | 3a6a67bc-5ce6-46a4-af72-e6ab78800e49 | Должен быть другим |

Исторический Cloud сохранён без изменений. Целевая рабочая база теперь самостоятельная; перенос данных и файлов ещё не выполнен. Подготовка и границы независимости: [INDEPENDENT-SHOP.md](INDEPENDENT-SHOP.md). Новые резервные копии, выгрузки и расписания запрещены действующим указанием владельца; существующие механизмы не изменять.

## Документы в DEV

Дополнительно работают mw-dev-document-parser и mw-dev-document-worker. Parser подключён только к внутренней mw-dev-document-private, не получает ключей базы или Telegram. Worker подключён к двум внутренним сетям, имеет отдельный document-worker.env только с DEV-доступом к базе. Публичных портов нет; оба контейнера непривилегированные, read-only, с лимитами ресурсов. Версии приложения и worker указаны в STATUS.md.

Для проверки: docker logs --tail 20 mw-dev-document-worker и раздел /documents в боте. Перезапуск не сбрасывает задания; зависший lease становится ошибкой для ручного разбора, без слепого повтора. Оригиналы сохраняются в БД и входят в её резервирование. [Порядок](DOCUMENT-PIPELINE.md).

## Команды из корня проекта

- python3 ops/dev/up.py — создать/возобновить DEV БД/REST/gateway; данные сохраняются.
- python3 ops/dev/build.py — собрать точный локальный commit DEV-образа; рабочая копия должна быть чистой.
- python3 ops/dev/restart.py <полный-local-SHA> — запустить собранный DEV-образ, сохранить предыдущий и проверить HTTP.
- python3 ops/dev/connect-telegram.py — проверить отдельного бота, перезапустить активный образ и установить DEV-webhook. Сначала нужен правильный токен.
- sudo python3 ops/dev/install-caddy.py — добавить DEV-блок, проверить/reload Caddy, сохранить остальные сайты.
- docker logs --tail 50 mw-dev-app — журнал.
- python3 ops/dev/notification-status.py — состояние доставки уведомлений DEV; код 1 при проблемных/зависших записях.
- docker ps --filter label=mw.environment=dev — контейнеры.

Работающий контейнер — собранная версия. Правка файла не меняет сайт до повторной сборки/запуска.
Перед обновлением DEV: diff, тесты, сохранение предыдущего контейнера/образа.

## HTTPS

Caddy автоматически выпускает/продлевает сертификат. Let's Encrypt проверен 06.11.2026, срок до 04.02.2027.
Конфиг: /opt/remnawave/caddy/Caddyfile; блок BEGIN/END MASTERWELD DEV. Резервная копия сохранена рядом.
Не переписывать конфигурацию чужих сайтов.

## Telegram

Токен @testmw639bot: ops/.secrets/dev/telegram-token, права 600.
Нужны TELEGRAM_TRANSPORT=direct, независимый TELEGRAM_WEBHOOK_SECRET, проверенные BOT_ID/USERNAME.
Пустой webhook не доказывает отсутствие polling. Сверять назначение бота и токены других контейнеров.
Не выполнять drop_pending_updates. Не использовать рабочий токен в DEV.
Сотрудники назначаются явно по числовому Telegram ID; автоматического повышения прав нет.
ORDER_NOTIFICATIONS_ENABLED=true включает уведомления о новых заказах только для проверенного DEV-бота. Очередь сохраняется при перезапусках; диагностика и порядок разбора — [уведомления](ORDER-NOTIFICATIONS.md).

Рабочие бот-токены и отдельные webhook-секреты подготовлены в ops/.secrets/production/bots.env (0600), не подключены к DEV. Старый webhook @masterweldermanagerbot ещё ведёт в Lovable. Подробный порядок переключения: [TELEGRAM-SHOP.md](TELEGRAM-SHOP.md).

## База

Фактически установленная DEV-схема — 0000–0043; самостоятельная production — 0000–0013. up.py при первом bootstrap читает SQL из drizzle/migrations и docs/migrations только для отдельной пустой DEV-базы. Он не включает отдельные 0042/0043 из docs/proposals и не заменяет их охраняемую установку. Не использовать up.py как способ воссоздать полную текущую схему без отдельной проверки состава. Уже существующую базу он автоматически не мигрирует. Следующие записи описывают прежние установки, а не команды повторить их. В существующую базу 0012 применена отдельно после резервной копии before-notifications-20261106T032258Z.dump.
0016 проверена на восстановленном backup before-bots-20261106T065308Z.dump и применена только в DEV. Бизнес-данные и прежние квитанции webhook не изменились. Production остаётся на 0013.

0015 проверена на восстановленном backup before-import-20261106T061910Z.dump и применена только к DEV. Отпечатки товаров, цен, фото, заказов и уведомлений после миграции совпали. Production остаётся на 0000–0013; для неё 0014 и 0015 требуют отдельной проверки.

0014 отдельно проверена на восстановленном backup before-assortment-20261106T054727Z.dump и применена только к DEV. В уже созданной самостоятельной production-базе её пока нет. Новые установки получают все файлы миграций; существующие базы не мигрируют при up.py или автодеплое приложения.

0013 проверена на восстановленной копии и отдельно применена только к DEV после backup before-submissions-20261106T043016Z.dump. Прямой INSERT shop_orders для service_role закрыт; новая серверная функция пишет через RPC. Старые версии оформления после этой миграции несовместимы.

После bootstrap это не универсальный migration runner. Новые миграции проверяются отдельно.
Применение SQL в DEV ничего не доказывает о Cloud.
По указанию владельца новые pg_dump, выгрузки и расписания не запускать. Перед production учитывать имеющиеся доказательства восстановления с их датой и ограничениями; не считать старый отчёт подтверждением текущего полного состояния.
Не удалять volumes ради перезапуска. Не использовать docker system prune --volumes.

Источники: [Caddy HTTPS](https://caddyserver.com/docs/automatic-https), [PostgREST](https://docs.postgrest.org/en/v12/references/configuration.html), [Telegram webhook](https://core.telegram.org/bots/api#setwebhook).
