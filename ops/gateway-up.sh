#!/usr/bin/env bash
# Слушает только 127.0.0.1 (network host, listen 127.0.0.1:18080).
# Однократный запуск отдельного gateway только на 127.0.0.1:18080.
# Не трогает существующий Caddy: внешний доступ подключается отдельно и вручную после решения владельца.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
[ "${CONFIRM_SERVER_CHANGE:-}" = yes ] || die "запуск на сервере требует CONFIRM_SERVER_CHANGE=yes"
docker inspect "$GATEWAY_NAME" >/dev/null 2>&1 && die "$GATEWAY_NAME уже существует"
[ -f "$STATE_DIR/gateway/default.conf" ] || write_gateway_maintenance
docker run -d --name "$GATEWAY_NAME" --restart unless-stopped \
  --network host \
  -v "$STATE_DIR/gateway:/etc/nginx/conf.d:ro" \
  nginx:1.27-alpine >/dev/null
log "gateway запущен на $BIND_IP:$GATEWAY_PORT"
