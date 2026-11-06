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
# Defaults remain the production topology. Isolated rehearsals must provide their own resources.
GATEWAY_PORT="${GATEWAY_PORT:-18080}"
SLOT_A_PORT="${SLOT_A_PORT:-18081}"
SLOT_B_PORT="${SLOT_B_PORT:-18082}"
BACKEND_PORT="${BACKEND_PORT:-18084}"
MW_CONTAINER_PREFIX="${MW_CONTAINER_PREFIX:-mw-shop}"
APP_NETWORK="${APP_NETWORK:-mw-prod-edge}"
GATEWAY_NAME="$MW_CONTAINER_PREFIX-gateway"
HEALTH_TRIES="${HEALTH_TRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"

log() { printf '[mw-release] %s\n' "$*" >&2; }
die() { log "ОШИБКА: $*"; exit 1; }

slot_port() { case "$1" in a) echo "$SLOT_A_PORT" ;; b) echo "$SLOT_B_PORT" ;; *) die "неизвестный slot $1" ;; esac; }
other_slot() { [ "$1" = a ] && echo b || echo a; }
slot_name() { echo "$MW_CONTAINER_PREFIX-slot-$1"; }

# Reject configuration mistakes before Docker, state writes, or generated nginx configuration.
validate_topology() {
  local port seen=" "
  for port in "$GATEWAY_PORT" "$SLOT_A_PORT" "$SLOT_B_PORT" "$BACKEND_PORT"; do
    [[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] && (( port >= 1024 && port <= 65535 )) \
      || die "порт должен быть числом 1024–65535"
    [[ "$seen" != *" $port "* ]] || die "порты gateway, slots и backend должны различаться"
    seen+="$port "
  done
  [[ "$MW_CONTAINER_PREFIX" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die "недопустимый префикс контейнеров"
  [[ "$APP_NETWORK" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || die "недопустимое имя сети"
}
validate_topology

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

# Compare the exact running build, not just a successful response from an old upstream.
release_matches() {
  local base="$1" sha="$2" payload
  payload="$(curl -fsS --max-time 5 --max-filesize 2048 -H 'Cache-Control: no-cache' \
    "$base/api/public/release-health?expected=$sha")" || return 1
  printf '%s' "$payload" | python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
    ok=isinstance(data,dict) and data.get("ready") is True and data=={"ready":True,"revision":sys.argv[1],"environment":"production"}
except (ValueError,TypeError):
    ok=False
raise SystemExit(0 if ok else 1)' "$sha"
}
wait_release() {
  local base="$1" sha="$2" i
  require_sha "$sha"
  for i in $(seq "$HEALTH_TRIES"); do
    if release_matches "$base" "$sha"; then return 0; fi
    sleep "$HEALTH_SLEEP"
  done
  log "health: $base не подтвердил production SHA $sha"; return 1
}

# Проверка: точный production SHA, HTTP 200, meta robots noindex, nofollow. Ничего не пишет.
smoke() {
  local base="$1" sha="$2" html
  wait_release "$base" "$sha" || return 1
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
  mkdir -p "$STATE_DIR/gateway" || return 1
  cat > "$STATE_DIR/gateway/default.conf.tmp" <<EOF || return 1
# Генерируется ops/lib.sh. Активный upstream: $port
server {
  listen $BIND_IP:$GATEWAY_PORT;
  location /backend/rest/v1/ {
    proxy_pass http://127.0.0.1:$BACKEND_PORT/rest/v1/;
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
  write_gateway_conf "$(slot_port "$1")" || return 1
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

# Только этот подкаталог (без ключей и разрешений выпуска) монтируется в приложение read-only.
# Пустой JSON означает паузу. Обновление атомарно; незавершённая отправка не переигрывается.
workers_validate() {
  local d="$STATE_DIR/workers" f="$STATE_DIR/workers/active.json"
  local active="${1:-}" sha="${2:-}" mode
  [ ! -L "$STATE_DIR" ] && [ "$(stat -c %u "$STATE_DIR")" = "$(id -u)" ] \
    || die "небезопасный каталог состояния"
  mode="$(stat -c %a "$STATE_DIR")"
  (( (8#$mode & 8#022) == 0 )) || die "каталог состояния доступен на запись другим"
  if [ -e "$d" ] || [ -L "$d" ]; then
    [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = "$(id -u)" ] \
      || die "небезопасный каталог workers"
    mode="$(stat -c %a "$d")"
    (( (8#$mode & 8#022) == 0 )) || die "каталог workers доступен на запись другим"
  fi
  if [ -e "$f" ] || [ -L "$f" ]; then
    require_state_file workers/active.json
    python3 - "$f" "$active" "$sha" <<'PY' || die "workers/active.json не соответствует активному выпуску"
import json, sys
with open(sys.argv[1], encoding="utf8") as stream:
    control = json.loads(stream.read(257))
if control != {} and control != {"slot": sys.argv[2], "sha": sys.argv[3]}:
    raise SystemExit(1)
PY
  fi
}
workers_write() {
  local tmp
  tmp="$(mktemp "$STATE_DIR/workers/.active.XXXXXX")"
  printf '%s\n' "$1" > "$tmp"
  chmod 644 "$tmp"
  mv -fT "$tmp" "$STATE_DIR/workers/active.json"
}
workers_prepare() {
  [ -d "$STATE_DIR/workers" ] || mkdir -m 755 "$STATE_DIR/workers"
  [ -f "$STATE_DIR/workers/active.json" ] || workers_pause
}
workers_pause() { workers_write '{}'; }
workers_activate() {
  case "$1" in a|b) ;; *) die "неизвестный worker slot" ;; esac
  require_sha "$2"
  workers_write "{\"slot\":\"$1\",\"sha\":\"$2\"}"
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
  mkdir -p -m 700 "$STATE_DIR"
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
  write_gateway_maintenance || return 1
  docker exec "$GATEWAY_NAME" nginx -t >/dev/null && docker exec "$GATEWAY_NAME" nginx -s reload >/dev/null
}
