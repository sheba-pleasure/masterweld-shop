#!/usr/bin/env bash
# Выпуск: ops/release.sh <40-hex SHA>
# Поднимает новый образ в неактивном slot, проверяет, переключает gateway,
# проверяет снова и при сбое откатывается. Предыдущий контейнер сохраняется.
# БД не трогает и миграции не запускает.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

SHA="${1:-}"
require_sha "$SHA"
[ -f "$SECRETS_ENV" ] || die "нет $SECRETS_ENV (серверные ключи)"
require_github_approval "$SHA"
require_image "$SHA"
docker inspect "$GATEWAY_NAME" >/dev/null 2>&1 || die "gateway $GATEWAY_NAME не запущен (ops/gateway-up.sh)"

ACTIVE="$(state_get active_slot)"; ACTIVE_SHA="$(state_get active_sha)"
[ "$ACTIVE_SHA" = "$SHA" ] && die "SHA $SHA уже активен"
TARGET="$(other_slot "${ACTIVE:-b}")"
PORT="$(slot_port "$TARGET")"; NAME="$(slot_name "$TARGET")"
log "активный: ${ACTIVE:-нет} ${ACTIVE_SHA:-}; новый slot $TARGET ($PORT) <- $SHA"

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
  echo "$TARGET $SHA" >> "$STATE_DIR/approved"
  log "ГОТОВО: активен slot $TARGET, SHA $SHA; предыдущий контейнер сохранён"
  exit 0
fi

log "проверка после переключения не прошла — автооткат"
if [ -n "$ACTIVE" ]; then
  switch_gateway "$ACTIVE"
  smoke "http://$BIND_IP:$GATEWAY_PORT" || die "автооткат на slot $ACTIVE тоже не прошёл проверку — нужен человек"
  log "автооткат выполнен: slot $ACTIVE, SHA $ACTIVE_SHA"
fi
docker stop "$NAME" >/dev/null 2>&1 || true
exit 2
