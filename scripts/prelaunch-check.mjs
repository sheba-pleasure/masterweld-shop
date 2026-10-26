#!/usr/bin/env node
// Pre-launch диагностика интернет-магазина «Мастер Сварщик».
//
// ТОЛЬКО ЧТЕНИЕ: скрипт читает файлы проекта и статические документы.
// НИЧЕГО не меняет: ни БД, ни noindex, ни файлы. Запуск: node scripts/prelaunch-check.mjs
//
// ВАЖНО: скрипт НИКОГДА не объявляет GO. Максимум — READY_FOR_HUMAN_REVIEW
// или BLOCKED. Финальное решение о запуске принимает только человек.
// Если факт нельзя проверить из локального кода (например, применена ли
// миграция в живой базе) — честно печатается UNKNOWN.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), "utf8") : null);

const results = [];
const add = (level, area, detail) => results.push({ level, area, detail });

// --- 1. noindex должен ОСТАВАТЬСЯ (скрипт только проверяет, никогда не меняет) ---
const rootRoute = read("src/routes/__root.tsx");
if (!rootRoute) {
  add("UNKNOWN", "noindex", "src/routes/__root.tsx не найден");
} else if (/robots"[^}]*noindex, nofollow/.test(rootRoute.replace(/\n/g, " "))) {
  add("OK", "noindex", "noindex, nofollow на месте (как и требуется до решения о запуске)");
} else {
  add("BLOCKED", "noindex", "noindex, nofollow НЕ найден в __root — проверьте вручную");
}

// --- 2. Заглушки: личный кабинет / доставка / оплата ---
const siteActions = read("src/components/SiteActions.tsx") ?? "";
if (/Готовим раздел/.test(siteActions)) {
  add("OK", "личный кабинет", "заглушка «Готовим раздел» присутствует (как задумано)");
} else {
  add("UNKNOWN", "личный кабинет", "маркер заглушки не найден — проверить вручную");
}
add("BLOCKED", "доставка", "условия доставки не зафиксированы; заказ принимается с «уточним доставку» по телефону");
add("BLOCKED", "оплата", "онлайн-оплата не реализована; решение по эквайрингу не принято (см. docs/legal-launch-checklist-2026.md)");

// --- 3. Реквизиты продавца ---
const legal = read("docs/legal-launch-checklist-2026.md") ?? "";
if (/LEGAL_LAUNCH_BLOCKED/.test(legal)) {
  add("BLOCKED", "реквизиты продавца", "LEGAL_LAUNCH_BLOCKED: ОГРН/ОГРНИП и адрес не подтверждены владельцем");
} else {
  add("UNKNOWN", "реквизиты продавца", "чеклист не найден или статус не отмечен");
}

// --- 4. Миграции: файлы есть, применённость в БД из кода не проверить ---
const migDir = resolve(ROOT, "docs/migrations");
const migFiles = existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort() : [];
add(
  "UNKNOWN",
  "миграции",
  `подготовленные файлы: ${migFiles.join(", ") || "нет"}; применённость в живой базе из локального кода НЕ проверяется — статус UNKNOWN, требуется подтверждение владельца/агента с доступом к БД`,
);

// --- 5. Документы cookie / персональных данных ---
const hasPdnDoc = existsSync(resolve(ROOT, "src/routes/privacy.tsx")) ||
  existsSync(resolve(ROOT, "src/routes/privacy/index.tsx")) ||
  (existsSync(resolve(ROOT, "docs")) && readdirSync(resolve(ROOT, "docs")).some((f) => /privacy|pdn|personal/i.test(f)));
if (hasPdnDoc) {
  add("OK", "персональные данные", "найден документ политики ПДн");
} else {
  add("BLOCKED", "персональные данные", "политики обработки ПДн и согласия при заказе нет — 152-ФЗ");
}
add("UNKNOWN", "cookie", "cookie-баннер/документ о cookie не найден; нужно ли — зависит от состава cookies (аналитика не подключена)");

// --- 6. Транспорт Telegram-файлов ---
const photos = read("src/lib/bot/photos.ts") ?? "";
if (/TELEGRAM_PHOTO_UPLOAD_VERIFIED\s*=\s*false/.test(photos)) {
  add("BLOCKED", "Telegram-файлы", "загрузка фото/прайса из Telegram fail-closed (TELEGRAM_PHOTO_UPLOAD_VERIFIED=false) — транспорт не подтверждён");
} else {
  add("UNKNOWN", "Telegram-файлы", "флаг TELEGRAM_PHOTO_UPLOAD_VERIFIED не найден — проверить вручную");
}

// --- Сводка ---
const blocked = results.filter((r) => r.level === "BLOCKED").length;
const unknown = results.filter((r) => r.level === "UNKNOWN").length;

console.log("=== Prelaunch-диагностика «Мастер Сварщик» (только чтение) ===\n");
for (const r of results) console.log(`[${r.level}] ${r.area}: ${r.detail}`);
console.log(`\nBLOCKED: ${blocked}, UNKNOWN: ${unknown}`);
console.log(
  blocked > 0 || unknown > 0
    ? "Вердикт: BLOCKED — запуск запрещён до закрытия пунктов и подтверждения человеком."
    : "Вердикт: READY_FOR_HUMAN_REVIEW — автоматический GO не выдаётся; решение принимает человек.",
);
