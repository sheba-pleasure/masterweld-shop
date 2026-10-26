#!/usr/bin/env bash
# Выпуск: ops/release.sh <40-hex SHA>
# Все проверки (SHA, lock, ключи, gateway, GitHub merge+verify, образ, состояние) — ДО любых действий.
# Новый образ в неактивном slot → health+smoke+noindex → переключение → smoke →
# при сбое возврат прежнего slot (или 503, если прежнего нет). Предыдущий контейнер сохраняется.
# БД не трогает и миграции не запускает.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

SHA="${1:-}"
require_sha "$SHA"
acquire_lock
[ -f "$SECRETS_ENV" ] || die "нет $SECRETS_ENV (серверные ключи)"
(( (8#$(stat -c %a "$SECRETS_ENV") & 8#077) == 0 )) || die "$SECRETS_ENV должен иметь права 600"
docker inspect "$GATEWAY_NAME" >/dev/null 2>&1 || die "gateway $GATEWAY_NAME не запущен (ops/gateway-up.sh)"
require_github_approval "$SHA"
require_image "$SHA"

ACTIVE="$(state_get active_slot)"; ACTIVE_SHA="$(state_get active_sha)"
if [ -n "$ACTIVE" ]; then
  [ "$(container_sha "$(slot_name "$ACTIVE")" || true)" = "$ACTIVE_SHA" ] \
    || die "состояние active ($ACTIVE/$ACTIVE_SHA) не совпадает с контейнером — нужен человек"
fi
[ "$ACTIVE_SHA" = "$SHA" ] && die "SHA $SHA уже активен"
TARGET="$(other_slot "${ACTIVE:-b}")"
PORT="$(slot_port "$TARGET")"; NAME="$(slot_name "$TARGET")"
log "предусловия выполнены; активный: ${ACTIVE:-нет} ${ACTIVE_SHA:-}; новый slot $TARGET ($PORT) <- $SHA"

# --- далее действия ---
# Целевой slot занят прежним предыдущим выпуском: после замены откат на него невозможен.
if [ "$(state_get previous_slot)" = "$TARGET" ]; then
  rm -f "$STATE_DIR/previous_slot" "$STATE_DIR/previous_sha"
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p "$BIND_IP:$PORT:3000" --env-file "$SECRETS_ENV" \
  --label "mw-shop.sha=$SHA" --label "mw-shop.slot=$TARGET" \
  "$IMAGE_REPO:$SHA" >/dev/null

if ! wait_healthy "http://$BIND_IP:$PORT" || ! smoke "http://$BIND_IP:$PORT"; then
  docker stop "$NAME" >/dev/null 2>&1 || true
  die "новый slot $TARGET не прошёл проверки — трафик не переключён"
fi

switch_gateway "$TARGET"
if smoke "http://$BIND_IP:$GATEWAY_PORT"; then
  [ -n "$ACTIVE" ] && { state_set previous_slot "$ACTIVE"; state_set previous_sha "$ACTIVE_SHA"; }
  state_set active_slot "$TARGET"; state_set active_sha "$SHA"
  approved_append "$TARGET" "$SHA"
  log "ГОТОВО: активен slot $TARGET, SHA $SHA; предыдущий контейнер сохранён"
  exit 0
fi

log "проверка после переключения не прошла — автооткат"
if [ -n "$ACTIVE" ]; then
  switch_gateway "$ACTIVE"
  docker stop "$NAME" >/dev/null 2>&1 || true
  smoke "http://$BIND_IP:$GATEWAY_PORT" || die "автооткат на slot $ACTIVE тоже не прошёл проверку — нужен человек"
  log "автооткат выполнен: slot $ACTIVE, SHA $ACTIVE_SHA; состояние не изменено"
else
  gateway_maintenance
  docker stop "$NAME" >/dev/null 2>&1 || true
  log "прежнего выпуска нет: вход переведён в 503, выпуск НЕ выполнен"
fi
exit 2
