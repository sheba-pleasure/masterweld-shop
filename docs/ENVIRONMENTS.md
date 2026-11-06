# Среды и обслуживание

Проверка: 06.11.2026.

| Объект | DEV | Рабочая среда |
|---|---|---|
| Сайт | masterweld-dev.138-124-106-211.sslip.io | shop.masterweld.ru, пока не выпущен |
| Бот | @testmw639bot, подключён | Отдельный; getMe перед запуском |
| База | mw-dev-db / masterweld_dev | Cloud, этой работой не менялась |
| Volume | mw-dev-pgdata | Отдельный |
| REST | mw-dev-rest | Supabase |
| Вход | Caddy → mw-dev-gateway | Требует настройки |
| Приложение | mw-dev-app | mw-shop-slot-a/b |
| Секреты | ops/.secrets/dev (700/600) | ops/.secrets/shop.env (600) |
| Instance ID | 3a6a67bc-5ce6-46a4-af72-e6ab78800e49 | Должен быть другим |

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

## База

up.py при первом bootstrap включает файлы 0000–0013 одной транзакцией только в отдельной DEV-базе. В существующую базу 0012 применена отдельно после резервной копии before-notifications-20261106T032258Z.dump.
0013 проверена на восстановленной копии и отдельно применена только к DEV после backup before-submissions-20261106T043016Z.dump. Прямой INSERT shop_orders для service_role закрыт; новая серверная функция пишет через RPC. Старые версии оформления после этой миграции несовместимы.

После bootstrap это не универсальный migration runner. Новые миграции проверяются отдельно.
Применение SQL в DEV ничего не доказывает о Cloud.
Перед существенной правкой делать pg_dump в защищённую папку; перед production проверить восстановление.
Не удалять volumes ради перезапуска. Не использовать docker system prune --volumes.

Источники: [Caddy HTTPS](https://caddyserver.com/docs/automatic-https), [PostgREST](https://docs.postgrest.org/en/v12/references/configuration.html), [Telegram webhook](https://core.telegram.org/bots/api#setwebhook).
