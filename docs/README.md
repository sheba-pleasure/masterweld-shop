# Навигатор документации `docs/`

Индекс сгруппирован по ролям и задачам. Исходные пути файлов сохранены без переноса, чтобы не ломать ссылки из `AGENTS.md`, `STATUS.md`, `ops/` и открытых PR.

## 1. Управление, запуск и совместная работа

- [OWNER.md](OWNER.md): правила управления и выпуска для владельца
- [STAFF.md](STAFF.md): памятка для сотрудников магазина
- [LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md): чеклист перед открытием рабочего магазина
- [COLLABORATION.md](COLLABORATION.md): правила совместной работы и PR
- [WORKFLOW.md](WORKFLOW.md): процесс разработки, проверок и «Обнови main»
- [REPO-HYGIENE.md](REPO-HYGIENE.md): аудит веток, CI и порядка в репозитории
- [legal-launch-checklist-2026.md](legal-launch-checklist-2026.md): юридические требования к запуску
- [seo-indexing-safety-2026-10-26.md](seo-indexing-safety-2026-10-26.md): защита индексации старого сайта

## 2. Архитектура, среды и независимость

- [ARCHITECTURE.md](ARCHITECTURE.md): архитектура приложения и данных
- [INDEPENDENT-SHOP.md](INDEPENDENT-SHOP.md): отделение магазина от Lovable и собственный стек
- [ENVIRONMENTS.md](ENVIRONMENTS.md): разделение DEV и production
- [ASSETS.md](ASSETS.md): работа со статикой и медиафайлами
- [TELEGRAM-SHOP.md](TELEGRAM-SHOP.md): два Telegram-бота и Mini App
- [DEV-BOT-CHECK.md](DEV-BOT-CHECK.md): проверка тестового бота
- [DEV-ACCEPTANCE-20261106.md](DEV-ACCEPTANCE-20261106.md): приёмка DEV-среды

## 3. Каталог, импорт и обработка документов

- [ASSORTMENT.md](ASSORTMENT.md): управление ассортиментом и флагом «Не продаём»
- [CATALOG-IMPORT.md](CATALOG-IMPORT.md): массовый импорт каталога
- [CATALOG-INPUT.md](CATALOG-INPUT.md): правила ввода и валидации позиций
- [CATALOG-COVERAGE.md](CATALOG-COVERAGE.md): аудит покрытия каталога
- [CATALOG-QUESTIONS.md](CATALOG-QUESTIONS.md): привязка пошаговых вопросов бота
- [CATALOG-RECONCILIATION.md](CATALOG-RECONCILIATION.md): сверка каталога
- [DOCUMENT-PIPELINE.md](DOCUMENT-PIPELINE.md): распознавание и проверка документов до импорта
- [DOCUMENT-SOURCE-READER.md](DOCUMENT-SOURCE-READER.md): чтение исходных файлов документов
- [DOCUMENT-IMPORT-RETURN.md](DOCUMENT-IMPORT-RETURN.md): возврат из разбора документа в импорт
- [LEGACY-EXCEL-INTAKE.md](LEGACY-EXCEL-INTAKE.md): разбор старых Excel-прайсов
- [PHOTO-BUTTON-IDENTITY.md](PHOTO-BUTTON-IDENTITY.md): неизменяемые идентификаторы кнопок фото

## 4. Технические характеристики (ТТХ)

- [CATALOG-TECHNICAL-MODEL.md](CATALOG-TECHNICAL-MODEL.md): модель данных технических характеристик
- [TECHNICAL-CATALOG-P0.md](TECHNICAL-CATALOG-P0.md): основа P0 и границы готовности
- [TECHNICAL-CARD-UI.md](TECHNICAL-CARD-UI.md): отображение ТТХ на сайте и в Mini App
- [TECHNICAL-EDITOR.md](TECHNICAL-EDITOR.md): редактор характеристик в служебном боте
- [TECHNICAL-IDENTITY-REVIEW.md](TECHNICAL-IDENTITY-REVIEW.md): проверка идентичности моделей
- [TECHNICAL-MODEL-BINDING.md](TECHNICAL-MODEL-BINDING.md): привязка параметров к точным моделям
- [PRODUCT-MODEL-CHOICE.md](PRODUCT-MODEL-CHOICE.md): выбор модели товара при разборе
- [PRIMARY-SOURCE-REVIEW.md](PRIMARY-SOURCE-REVIEW.md): проверка первичных источников
- [SOURCE-FACT-CANDIDATES.md](SOURCE-FACT-CANDIDATES.md): кандидаты фактов из источников
- [DOCUMENTARY-CONDITIONS.md](DOCUMENTARY-CONDITIONS.md): документальные условия измерения
- [ACCESSORY-CHARACTERISTICS.md](ACCESSORY-CHARACTERISTICS.md): характеристики оснастки
- [CONSUMABLE-CHARACTERISTICS.md](CONSUMABLE-CHARACTERISTICS.md): характеристики расходников

## 5. Восстановление состояний и заказы

- [ORDER-NOTIFICATIONS.md](ORDER-NOTIFICATIONS.md): уведомления о новых заказах (0012)
- [CATALOG-PREVIEW-RECOVERY.md](CATALOG-PREVIEW-RECOVERY.md): восстановление предпросмотра каталога
- [DRAFT-RECOVERY.md](DRAFT-RECOVERY.md): восстановление черновиков
- [PENDING-RESULT-RECOVERY.md](PENDING-RESULT-RECOVERY.md): восстановление результатов действий (0024)
- [PREVIEW-REQUEST-RECOVERY.md](PREVIEW-REQUEST-RECOVERY.md): восстановление прямых предпросмотров (0025)

## 6. Production, миграции, релизы и проверки

- [VERIFICATION.md](VERIFICATION.md): журнал доказательств и проверок
- [RELEASE-READINESS.md](RELEASE-READINESS.md): готовность релиза
- [RELEASE-HEALTH.md](RELEASE-HEALTH.md): проверка health/readiness
- [RELEASE-CONTAINER-REHEARSAL.md](RELEASE-CONTAINER-REHEARSAL.md): контейнерная репетиция выпуска
- [PRODUCTION-PREFLIGHT.md](PRODUCTION-PREFLIGHT.md): предпусковая проверка рабочего контура
- [PRODUCTION-EMPTY-MIGRATION-PLAN.md](PRODUCTION-EMPTY-MIGRATION-PLAN.md): план миграции пустой PRO БД (0013 → 0043)
- [PRODUCTION-MIGRATION-PLAN.md](PRODUCTION-MIGRATION-PLAN.md): общий план миграции production
- [PRODUCTION-SCHEMA-0043.md](PRODUCTION-SCHEMA-0043.md): схема 0043 и репетиция обновления
- [PRODUCTION-SCHEMA-COMPATIBILITY.md](PRODUCTION-SCHEMA-COMPATIBILITY.md): совместимость схемы и образов
- [OFFLINE-0025-VERIFICATION.md](OFFLINE-0025-VERIFICATION.md), [OFFLINE-0028-VERIFICATION.md](OFFLINE-0028-VERIFICATION.md), [OFFLINE-0031-VERIFICATION.md](OFFLINE-0031-VERIFICATION.md): офлайн-проверки миграций
- [order-migrations-qa.md](order-migrations-qa.md): QA миграций заказов

## 7. Перенос старого Cloud и бэкапы (исторические / заморожены)

- [CLOUD-EXPORT.md](CLOUD-EXPORT.md): экспорт из прежнего Cloud
- [CLOUD-MEDIA.md](CLOUD-MEDIA.md): перенос медиафайлов
- [CLOUD-TRANSFER.md](CLOUD-TRANSFER.md): план переноса данных
- [DATABASE-BACKUPS.md](DATABASE-BACKUPS.md): порядок резервирования БД
- [BACKUP-YANDEX.md](BACKUP-YANDEX.md): заметки по резервным копиям в Яндекс
- [production-cloud-schema-20261106.json](production-cloud-schema-20261106.json): снимок схемы Cloud (06.11.2026)

## 8. Исторические rollout-заметки и служебные папки

- [b2b-rollout.md](b2b-rollout.md)
- [order-rollout.md](order-rollout.md)
- [price-import-rollout.md](price-import-rollout.md)
- [telegram-catalog-rollout.md](telegram-catalog-rollout.md)
- [telegram-catalog-editor-rollout.md](telegram-catalog-editor-rollout.md)
- [telegram-photo-rollout.md](telegram-photo-rollout.md)
- `docs/migrations/`: SQL-миграции `0005`..`0041` (используются в `ops/` и тестах: путь не менять)
- `docs/proposals/`: проекты миграций `0042`..`0043` (используются в тестах: путь не менять)
- `docs/research/`: справочники и отчёты покрытия (используются в `verify.yml`: путь не менять)
- `docs/archive/`: архивные документы (`2026-11-06/`)
