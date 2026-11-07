# Разработка и выпуск

Правило владельца от 06.11.2026 заменяет прежний режим «Выпускай».

## Обычная работа

Прочитать AGENTS.md, README.md, STATUS.md. Сверить GitHub dev/main и локальный diff.
Работать в ветке от актуального dev, проверять на DEV. Сохранять через PR в dev.
Неполную работу держать в рабочей ветке/draft PR. main до команды владельца не менять.
Lovable используется только для дизайна. В связанном проекте допустим разбор/обсуждение макетов; backend, Cloud, интеграции и выпуск через него не изменять. Полезные UI-решения вручную переносить в ветку DEV. Наши сборка и сервер работают без редактора; см. INDEPENDENT-SHOP.md.
Локальная копия первоначально имела самостоятельную историю. База сверки — GitHub dev f19af109d69d7e0819876a76481eb7b5196f3e58. Исходная локальная ветка сохранена; рабочая GitHub-ветка строится с родителем актуального dev и полным сохранением его файлов. Native Git Sync Lovable выключен; обычный Git CLI теперь авторизован. Не переписывать опубликованную историю.

## «Обнови main»

Команда разрешает выпуск, но не отменяет проверку. До merge подготовить release report:

- dev SHA, состав и соответствие проверенной DEV-версии;
- тесты, сборка, desktop/mobile, заказ и новая цена;
- отдельный бот, права, действия, повтор событий;
- production-конфигурация, независимые ключи и instance_id;
- production-БД, миграции и имеющиеся доказательства восстановления с указанием их возраста и ограничений; по действующему указанию владельца новые копии, выгрузки и расписания не создавать;
- откат приложения и последствия для данных;
- готовность реального приёма покупателей;
- остаток, забытые условия и приоритет следующего шага.

Неизвестное считается непроверенным. При блокере main не обновлять.
При готовности: PR dev → main, merge без переписывания истории, точный main SHA и разрешение на сервере; дождаться автоматического выпуска.
После команды сообщить: выпущено/остановлено, версию, проверки, остаток и следующий шаг.

## Автоматическая часть

verify: push dev/main и PR в обе ветки.
deploy-production: только успешный verify от push main.
Сервер сначала требует разрешение на точный SHA; произвольный push без него не выпускается.
Production-образ собирается с production public-настройками; DEV-образ не переносится.
Передача по SSH с закреплённым host key; forced command принимает только check/deploy и полный SHA.
Сервер повторно проверяет merge/CI, SHA и среду образа; release.sh выполняет blue/green, smoke и автооткат. Smoke требует точный SHA и production-среду из readiness до/после переключения; старый HTTP 200 не подтверждает новый выпуск. Manifest и runtime RELEASE_SHA обязаны совпасть. Подробности и границы: [RELEASE-HEALTH.md](RELEASE-HEALTH.md).
Выпуск и откат дополнительно читают схему локальной production-базы и проверяют совместимость неизменяемого образа. Несовместимый аварийный возврат оставляет вход в подтверждённом 503 и уведомления на паузе; [порядок и ограничения](PRODUCTION-SCHEMA-COMPATIBILITY.md).
Разрешение одноразовое, срок 24 часа. После сбоя нужен новый разбор. Миграции/данные не переносятся.

## Настройка автодеплоя пока не завершена

Уже настроены GitHub CLI, серверный GitHub credential, ограниченный SSH deploy key, закреплённый host key и repository secrets. Gateway mw-shop-gateway подготовлен на 127.0.0.1:18080 и пока отвечает 503; внешний Caddy не переключён. Собственная пустая production-база/ключи/маркер подготовлены; параметры двух рабочих ботов сохранены отдельно, но не активированы. Нужны перенос данных, полная конфигурация, домен, production public-параметры и проверенное переключение webhook сотрудников с Lovable. См. TELEGRAM-SHOP.md. shop.masterweld.ru пока не разрешается в IPv4 при проверке сервера.
GitHub variables: MW_DEPLOY_HOST, MW_DEPLOY_USER, MW_PRODUCTION_ORIGIN, MW_PRODUCTION_SUPABASE_URL, MW_PRODUCTION_PUBLIC_KEY, MW_PRODUCTION_PROJECT_ID.
GitHub secrets: MW_DEPLOY_SSH_KEY, MW_DEPLOY_KNOWN_HOSTS.
Сервер: ops/.secrets/github-read-token (600). Сейчас это защищённая копия OAuth credential GitHub CLI; имя файла обозначает использование для чтения проверок, а не ограниченный scope токена. Исходная авторизация имеет repo/workflow-доступ.
GitHub environments не используются: доступность зависит от тарифа private-репозитория. Проверку разрешения выполняет сервер. [Документация GitHub](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
authorized_keys: restrict и forced command python3 /home/codex/projects/masterweld.ru/ops/production/receive.py; без произвольного shell.
Разрешение: ops/.state/production/approval.json (600). Структуру проверяет ops/production/gate.py. passed=true ставится только с реальным evidence.
Наличие workflow не означает действующий автодеплой.

## Проверки

npm run typecheck
npm test
node --test ops/runtime/environment.test.mjs
python3 -m unittest discover -s ops/production -p 'test_*.py'
npm run build
NITRO_PRESET=node-server npm run build
bash ops/tests/release-synthetic.sh
python3 ops/tests/production-compatibility.py
python3 ops/tests/release-containers.py

Последняя команда требует локальные node:22-bookworm-slim, nginx:1.27-alpine и postgres:17.6-alpine; создаёт отдельные учебные ресурсы, проверяет настоящий gateway и удаляет их. Состав, настройки и ограничения: [RELEASE-CONTAINER-REHEARSAL.md](RELEASE-CONTAINER-REHEARSAL.md).

Инфраструктура: HTTPS/сертификат/noindex, заказ DEV, SQL-права, маркер базы, возврат предыдущей версии.
TypeScript: npm run typecheck — обязательный этап verify сразу после установки зависимостей. Действует неизменённый строгий tsconfig: src/**/*.ts/tsx (включая тесты), vite.config.ts и vitest.config.ts. Отдельные ops/*.ts этим tsconfig не охвачены; для них сохраняются собственные проверки. Не отключать strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes или noPropertyAccessFromIndexSignature ради зелёной проверки. Полный lint имеет старый долг; изменённые участки проверяются отдельно.

## Откат

ops/rollback.sh возвращает предыдущий утверждённый совместимый контейнер offline: без GitHub и загрузки образа, но с чтением схемы локальной базы и неизменяемого образа контейнера. Несовместимый контейнер не запускается. БД не откатывает.
При первом неудачном выпуске без предыдущего контейнера вход должен честно отвечать недоступностью.
