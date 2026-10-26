#!/usr/bin/env bash
# «Откати»: ops/rollback.sh <40-hex SHA предыдущего утверждённого выпуска>
# Возвращает трафик на сохранённый предыдущий slot. БД не откатывает:
# необратимые миграции этим скриптом не отменяются.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

SHA="${1:-}"
require_sha "$SHA"
PREV="$(state_get previous_slot)"; PREV_SHA="$(state_get previous_sha)"
[ -n "$PREV" ] || die "нет сохранённого предыдущего выпуска"
[ "$PREV_SHA" = "$SHA" ] || die "запрошен $SHA, а сохранённый предыдущий — $PREV_SHA"
approved_contains "$PREV" "$SHA" || die "$PREV/$SHA нет в журнале утверждённых выпусков"
require_github_approval "$SHA"
require_image "$SHA"
NAME="$(slot_name "$PREV")"; PORT="$(slot_port "$PREV")"
[ "$(docker inspect --format '{{ index .Config.Labels "mw-shop.sha" }}' "$NAME" 2>/dev/null)" = "$SHA" ] \
  || die "контейнер $NAME отсутствует или не на $SHA"
docker start "$NAME" >/dev/null
wait_healthy "http://$BIND_IP:$PORT" && smoke "http://$BIND_IP:$PORT" || die "slot $PREV не проходит проверку — откат не выполнен"

ACTIVE="$(state_get active_slot)"; ACTIVE_SHA="$(state_get active_sha)"
switch_gateway "$PREV"
if ! smoke "http://$BIND_IP:$GATEWAY_PORT"; then
  switch_gateway "$ACTIVE"; die "после отката проверка не прошла — возвращён $ACTIVE"
fi
state_set active_slot "$PREV"; state_set active_sha "$SHA"
state_set previous_slot "$ACTIVE"; state_set previous_sha "$ACTIVE_SHA"
log "ОТКАТ ГОТОВ: активен slot $PREV, SHA $SHA (контейнер $ACTIVE сохранён)"
