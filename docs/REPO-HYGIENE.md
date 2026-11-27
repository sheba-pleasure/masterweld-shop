# Аудит порядка в репозитории (28.11.2026)

Сводка фактического состояния `sheba-pleasure/masterweld-shop` на базе `origin/dev` (`265256a`).

## 1. Критические орг-блокеры (требуются права `admin` владельца)

1. **GitHub Actions (`verify.yml`) заблокирован биллингом аккаунта.**
   Все последние запуски CI завершаются с `steps: []` и системным сообщением GitHub:
   `The job was not started because recent account payments have failed or your spending limit needs to be increased.`
   **Действие:** проверить `Billing & plans` на аккаунте `sheba-pleasure` (или подключить self-hosted runner).
2. **Видимость репозитория сейчас `public`.**
   В открытом доступе находятся `ops/`, IP DEV-сервера и внутренняя документация.
   **Действие:** перевести репозиторий в `private` (или явно подтвердить, что публичность намеренна).
3. **Защита веток (`Branch Protection` / `Rulesets`) отсутствует.**
   На `main` и `dev` сейчас `protected: false`, `rulesets: []`.
   **Действие:** после восстановления Actions включить защиту для `main` и `dev` (запрет `force push`, обязательный PR и зелёный `verify`).

## 2. Активные незамёрженные ветки и открытые PR

| PR | Ветка | База | Статус |
|---|---|---|---|
| `#1` | `dev` | `main` | Open (`333` коммита впереди `main`, ждёт «Обнови main») |
| `#88` | `codex/dev-acceptance-status` | `dev` | Draft |
| `#89` | `codex/document-field-navigation` | `dev` | Draft |
| `#90` | `codex/svarog-full-intake-documents-20261112` | `dev` | Draft |
| `#91` | `codex/svarog-price-updates` | `dev` | Draft |
| `#92` | `codex/ui-industrial-pro` | `dev` | Draft (новый UI витрины) |

## 3. Устаревшие ветки, уже полностью слитые в `origin/dev` (86 шт.)

Все перечисленные ниже ветки проверены через `git branch -r --merged origin/dev` и полностью входят в историю `dev`. Удаление выполняется только после подтверждения владельца.

Команда безопасной очистки (удаляет только уже слитые в `origin/dev` ветки `codex/*`):

```bash
git fetch --prune origin
git branch -r --merged origin/dev \
  | grep -E 'origin/codex/' \
  | sed 's|^[[:space:]]*origin/||' \
  | xargs -r -n 10 git push origin --delete
```

### Полный список 86 слитых веток

- `codex/accessory-measurement-conditions`
- `codex/bot-guided-recovery-20261106`
- `codex/bulk-assortment-20261106`
- `codex/capitalized-interface-labels`
- `codex/cart-tab-synchronization`
- `codex/catalog-coverage-audit`
- `codex/catalog-input-claims-20261106`
- `codex/catalog-preview-recovery-20261106`
- `codex/catalog-question-binding-20261106`
- `codex/catalog-reconcile-20261106`
- `codex/catalog-research-intake-20261106`
- `codex/checkout-confirmed-recovery`
- `codex/checkout-http-acceptance`
- `codex/checkout-price-consent`
- `codex/checkout-tab-coordination`
- `codex/cloud-backup-0028`
- `codex/cloud-media-backup-20261106`
- `codex/cloud-snapshot-restore-20261106`
- `codex/cloud-transfer-plan-20261106`
- `codex/cloud-upgrade-rehearsal-20261106`
- `codex/consumable-characteristics`
- `codex/database-backup-20261106`
- `codex/dev-acceptance-20261106`
- `codex/dev-bot-menu-20261106`
- `codex/dev-environment-20261106`
- `codex/dev-order-notifications-20261106`
- `codex/dev-release-readiness-20261106`
- `codex/document-cancel-confirmation`
- `codex/document-full-value-review`
- `codex/document-human-review-20261106`
- `codex/document-input-deployment-docs`
- `codex/document-input-recovery`
- `codex/document-intake-20261106`
- `codex/document-model-import-links`
- `codex/document-model-review`
- `codex/document-return-to-review`
- `codex/document-review-guidance`
- `codex/document-row-pages`
- `codex/document-source-reader`
- `codex/document-structure-review-20261107`
- `codex/docx-table-layout`
- `codex/exclusive-editor-dialogs-20261106`
- `codex/import-model-conflicts`
- `codex/independent-shop-20261106`
- `codex/legacy-excel-intake`
- `codex/miniapp-catalog-return`
- `codex/offline-document-upgrade-0028`
- `codex/offline-schema-0031`
- `codex/offline-upgrade-0025-20261106`
- `codex/offsite-restore-0024-20261106`
- `codex/order-card-refresh-20261106`
- `codex/pending-preview-requests-20261106`
- `codex/pending-result-recovery-20261106`
- `codex/photo-button-identity-20261106`
- `codex/primary-source-review`
- `codex/product-import-20261106`
- `codex/product-model-choice`
- `codex/production-bot-preflight-20261106`
- `codex/production-migration-inventory`
- `codex/production-migration-plan`
- `codex/production-notifications-20261106`
- `codex/production-schema-compatibility`
- `codex/production-schema-rehearsal`
- `codex/recover-catalog-drafts-20261106`
- `codex/rehearse-draft-recovery-20261106`
- `codex/rehearse-editor-exclusivity-20261106`
- `codex/rehearse-pending-recovery-20261106`
- `codex/release-container-rehearsal-20261106`
- `codex/release-identity-health-20261106`
- `codex/release-status-docs`
- `codex/schema-rehearsal-0020-20261106`
- `codex/seller-costs-simple-bot-20261106`
- `codex/shop-bots-20261106`
- `codex/source-fact-candidates`
- `codex/staff-shop-environments-20261106`
- `codex/strict-types-gate-20261106`
- `codex/table-preview-pages`
- `codex/technical-card-ui-20261106`
- `codex/technical-catalog-p0-20261106`
- `codex/technical-edit-version-20261106`
- `codex/technical-editor-20261106`
- `codex/technical-identity-review`
- `codex/technical-input-guidance`
- `codex/technical-model-binding`
- `codex/text-source-locators`
- `codex/yandex-backup-evidence-20261106`
