#!/usr/bin/env bash
# «Откати»: ops/rollback.sh [SHA]
# Возвращает трафик на сохранённый предыдущий утверждённый slot+SHA. Работает ПОЛНОСТЬЮ
# OFFLINE: без GitHub, загрузки и тега Docker-образа — по локальному журналу approved,
# неизменяемому образу существующего контейнера, схеме локальной БД и smoke. Если SHA указан, он обязан совпасть с previous_sha.
# БД не откатывает: необратимые миграции этим скриптом не отменяются.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ARG="${1:-}"
[ -z "$ARG" ] || require_sha "$ARG"
acquire_lock
require_state_file previous_slot; require_state_file previous_sha
PREV="$(state_get previous_slot)"; PREV_SHA="$(state_get previous_sha)"
case "$PREV" in a|b) ;; *) die "повреждённое previous_slot" ;; esac
require_sha "$PREV_SHA"
[ -z "$ARG" ] || [ "$ARG" = "$PREV_SHA" ] || die "запрошен $ARG, а сохранённый предыдущий — $PREV_SHA"
approved_contains "$PREV" "$PREV_SHA" || die "$PREV/$PREV_SHA нет в журнале утверждённых выпусков"
docker inspect "$GATEWAY_NAME" >/dev/null 2>&1 || die "gateway $GATEWAY_NAME не запущен"
NAME="$(slot_name "$PREV")"; PORT="$(slot_port "$PREV")"
CT_SHA="$(container_sha "$NAME")" || die "контейнер $NAME отсутствует — откат невозможен, восстановление не выполняется (нужен новый выпуск)"
[ "$CT_SHA" = "$PREV_SHA" ] || die "контейнер $NAME на $CT_SHA, а не на $PREV_SHA — отказ"

ACTIVE="$(state_get active_slot)"; ACTIVE_SHA="$(state_get active_sha)"
if [ -n "$ACTIVE" ]; then
  require_state_file active_slot; require_state_file active_sha
  require_sha "$ACTIVE_SHA"
  slot_port "$ACTIVE" >/dev/null
  [ "$(container_sha "$(slot_name "$ACTIVE")" || true)" = "$ACTIVE_SHA" ] \
    || die "активное состояние не соответствует контейнеру"
fi
workers_validate "$ACTIVE" "$ACTIVE_SHA"
compatible_slot "$PREV" "$PREV_SHA" || die "предыдущий образ несовместим с базой — откат запрещён"
workers_prepare

[ "$(docker inspect --format '{{.State.Running}}' "$NAME")" = true ] || docker start "$NAME" >/dev/null
{ wait_healthy "http://$BIND_IP:$PORT" && smoke "http://$BIND_IP:$PORT" "$PREV_SHA"; } || die "slot $PREV не проходит проверку — откат не выполнен"

workers_pause
if ! { compatible_slot "$PREV" "$PREV_SHA" && switch_gateway "$PREV" && \
       smoke "http://$BIND_IP:$GATEWAY_PORT" "$PREV_SHA" && compatible_slot "$PREV" "$PREV_SHA"; }; then
  if [ -n "$ACTIVE" ]; then
    if ! compatible_slot "$ACTIVE" "$ACTIVE_SHA"; then
      release_maintenance
      die "возврат после сбоя отката запрещён: несовместимый образ; вход 503, уведомления на паузе"
    fi
    switch_gateway "$ACTIVE"
    smoke "http://$BIND_IP:$GATEWAY_PORT" "$ACTIVE_SHA" || die "возврат после сбоя отката не прошёл проверку; уведомления на паузе"
    if ! compatible_slot "$ACTIVE" "$ACTIVE_SHA"; then
      release_maintenance
      die "совместимость активного образа изменилась; вход 503, уведомления на паузе"
    fi
    workers_activate "$ACTIVE" "$ACTIVE_SHA"
  else
    release_maintenance
  fi
  die "после отката проверка не прошла — возвращено прежнее состояние"
fi
state_set active_slot "$PREV"; state_set active_sha "$PREV_SHA"
state_set previous_slot "$ACTIVE"; state_set previous_sha "$ACTIVE_SHA"
workers_activate "$PREV" "$PREV_SHA"
log "ОТКАТ ГОТОВ: активен slot $PREV, SHA $PREV_SHA; БД не откатывалась"
