# Паспорт проекта

Интернет-магазин «Мастер Сварщик».
Каноническая папка: /home/codex/projects/masterweld.ru.
Репозиторий: https://github.com/sheba-pleasure/masterweld-shop.
Интеграция: dev. Выпуск: main после «обнови main» и проверки.

Стек: React 19, TypeScript, TanStack Start/Router/Query, Tailwind 4.
Рабочая Cloud-база: Supabase, состояние заново проверяется перед выпуском.
DEV: отдельный PostgreSQL 17 + PostgREST 12, совместимый с используемыми REST/RPC-вызовами Supabase-клиента.
Это не полный self-hosted Supabase: Auth, Storage, Realtime и Studio пока не развёрнуты. Личный кабинет является заглушкой и в исходном приложении.

Браузер → каталог → корзина → createOrder → серверный пересчёт → shop_orders.
Telegram → реальный отправитель/private chat → staff/права → операция/RPC → аудит.
Данные DEV никогда не переносятся в production вместе с кодом.
Начало документации: README.md.

Исследование характеристик сварочного оборудования и UX каталога (06.11.2026): `research/welding-catalog-2026-11-06/` — 5 исходных файлов и ZIP-пакет, проверенные после копирования на сервер. Это материалы для дальнейшего внедрения, а не реализованные фильтры или наполненные характеристики товаров. История сохранения: `CHANGELOG.md`.
