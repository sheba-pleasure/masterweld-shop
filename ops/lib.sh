#!/usr/bin/env bash
# Общие функции blue/green выпуска интернет-магазина «Мастер Сварщик».
# Никогда не трогают БД, Caddy, DNS, firewall и чужие контейнеры.
set -euo pipefail

OPS_DIR="${OPS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
STATE_DIR="${STATE_DIR:-$OPS_DIR/.state}"
SECRETS_ENV="${SECRETS_ENV:-$OPS_DIR/.secrets/shop.env}"
GITHUB_API="${GITHUB_API:-https://api.github.com}"
GITHUB_REPO="${GITHUB_REPO:-sheba-pleasure/masterweld-shop}"
IMAGE_REPO="${IMAGE_REPO:-masterweld-shop}"
BIND_IP="127.0.0.1"
GATEWAY_PORT=18080
GATEWAY_NAME="mw-shop-gateway"
HEALTH_TRIES="${HEALTH_TRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"

log() { printf '[mw-release] %s\n' "$*" >&2; }
die() { log "ОШИБКА: $*"; exit 1; }

slot_port() { case "$1" in a) echo 18081 ;; b) echo 18082 ;; *) die "неизвестный slot $1" ;; esac; }
other_slot() { [ "$1" = a ] && echo b || echo a; }
slot_name() { echo "mw-shop-slot-$1"; }

state_get() { [ -f "$STATE_DIR/$1" ] && cat "$STATE_DIR/$1" || true; }
state_set() { mkdir -p "$STATE_DIR"; ( umask 077; printf '%s\n' "$2" > "$STATE_DIR/$1.tmp" ); mv "$STATE_DIR/$1.tmp" "$STATE_DIR/$1"; }

require_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || die "нужен полный 40-символьный SHA, получено '${1:-}'"
}

gh_get() {
  local auth=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi
  curl -fsS "${auth[@]}" -H "Accept: application/vnd.github+json" "$GITHUB_API/repos/$GITHUB_REPO/$1"
}

json_field() { python3 -c 'import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d=d[int(k)] if isinstance(d,list) else d.get(k)
print("" if d is None else d)' "$1"; }

# Одобрение = SHA входит в main через смерженный PR в main, и проверка verify успешна.
require_github_approval() {
  local sha="$1" status pulls ok checks
  status="$(gh_get "compare/main...$sha" | json_field status)" || die "GitHub недоступен — выпуск остановлен"
  case "$status" in identical|behind) ;; *) die "SHA $sha не входит в main (status=$status): нет одобренного merge" ;; esac
  pulls="$(gh_get "commits/$sha/pulls")" || die "не удалось получить PR для $sha"
  ok="$(printf '%s' "$pulls" | python3 -c 'import json,sys
print(any(p.get("merged_at") and p.get("base",{}).get("ref")=="main" for p in json.load(sys.stdin)))')"
  [ "$ok" = True ] || die "для $sha нет смерженного PR в main (нужны «обнови main», проверка и merge)"
  checks="$(gh_get "commits/$sha/check-runs" | python3 -c 'import json,sys
r=json.load(sys.stdin).get("check_runs",[])
v=[c for c in r if c.get("name","").startswith("verify")]
print("ok" if v and all(c.get("conclusion")=="success" for c in v) else "fail")')"
  [ "$checks" = ok ] || die "обязательные проверки verify для $sha не успешны"
  log "GitHub: $sha в main, PR смержен, verify успешен"
}

require_image() {
  local sha="$1" rev
  rev="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE_REPO:$sha" 2>/dev/null)" \
    || die "Docker-образ $IMAGE_REPO:$sha не найден"
  [ "$rev" = "$sha" ] || die "метка revision образа ($rev) не совпадает с $sha"
}

# Проверка: HTTP 200, meta robots noindex, nofollow. Ничего не пишет.
smoke() {
  local base="$1" html
  html="$(curl -fsS --max-time 10 "$base/")" || { log "smoke: $base/ не отвечает 200"; return 1; }
  printf '%s' "$html" | grep -Eqi '<meta name="robots" content="noindex, ?nofollow"' \
    || { log "smoke: на $base/ нет noindex,nofollow"; return 1; }
  return 0
}

wait_healthy() {
  local base="$1" i
  for i in $(seq "$HEALTH_TRIES"); do
    if curl -fsS --max-time 5 -o /dev/null "$base/"; then return 0; fi
    sleep "$HEALTH_SLEEP"
  done
  log "health: $base не поднялся"; return 1
}

write_gateway_conf() {
  local port="$1"
  mkdir -p "$STATE_DIR/gateway"
  cat > "$STATE_DIR/gateway/default.conf.tmp" <<EOF
# Генерируется ops/lib.sh. Активный upstream: $port
server {
  listen $BIND_IP:$GATEWAY_PORT;
  location /backend/rest/v1/ {
    proxy_pass http://127.0.0.1:18084/rest/v1/;
    proxy_set_header Authorization \$http_authorization;
    add_header Cache-Control "no-store" always;
  }
  location / {
    proxy_pass http://$BIND_IP:$port;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF
  mv "$STATE_DIR/gateway/default.conf.tmp" "$STATE_DIR/gateway/default.conf"
}

switch_gateway() {
  write_gateway_conf "$(slot_port "$1")"
  docker exec "$GATEWAY_NAME" nginx -t >/dev/null && docker exec "$GATEWAY_NAME" nginx -s reload >/dev/null
}

# Локальные файлы состояния: обычный файл (не symlink), владелец — текущий пользователь,
# без записи для группы/других. Иначе — отказ (fail closed).
require_state_file() {
  local f="$STATE_DIR/$1" owner mode
  { [ -f "$f" ] && [ ! -L "$f" ]; } || die "файл состояния $1 отсутствует или не обычный файл"
  owner="$(stat -c %u "$f")"; mode="$(stat -c %a "$f")"
  [ "$owner" = "$(id -u)" ] || die "файл состояния $1 принадлежит чужому пользователю"
  (( (8#$mode & 8#022) == 0 )) || die "файл состояния $1 доступен на запись группе/другим ($mode)"
}

# Журнал утверждённых выпусков: только дописывается release.sh после успешного выпуска.
approved_contains() { require_state_file approved; grep -qx "$1 $2" "$STATE_DIR/approved"; }
approved_append() {
  mkdir -p "$STATE_DIR"
  [ -e "$STATE_DIR/approved" ] || ( umask 022; : > "$STATE_DIR/approved" )
  require_state_file approved
  printf '%s %s\n' "$1" "$2" >> "$STATE_DIR/approved"
}

# Взаимное исключение release/rollback/build: один lock, без ожидания (fail closed).
acquire_lock() {
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/release.lock"
  flock -n 9 || die "другая операция выпуска/отката уже выполняется (release.lock) — отказ"
}

# SHA контейнера по меткам: mw-shop.sha и revision образа должны совпасть.
container_sha() {
  local name="$1" a b
  a="$(docker inspect --format '{{ index .Config.Labels "mw-shop.sha" }}' "$name" 2>/dev/null)" || return 1
  b="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$name" 2>/dev/null)" || return 1
  [ -n "$a" ] && [ "$a" = "$b" ] || return 1
  printf '%s' "$a"
}

# Вход без рабочего slot отвечает 503 (первый запуск, неудачный первый выпуск).
write_gateway_maintenance() {
  mkdir -p "$STATE_DIR/gateway"
  printf '%s\n' "# Генерируется ops/lib.sh. Нет рабочего slot: 503." "server {" \
    "  listen $BIND_IP:$GATEWAY_PORT;" "  location / { return 503; }" "}" > "$STATE_DIR/gateway/default.conf.tmp"
  mv "$STATE_DIR/gateway/default.conf.tmp" "$STATE_DIR/gateway/default.conf"
}
gateway_maintenance() {
  write_gateway_maintenance
  docker exec "$GATEWAY_NAME" nginx -t >/dev/null && docker exec "$GATEWAY_NAME" nginx -s reload >/dev/null
}
