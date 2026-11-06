#!/usr/bin/env bash
# Синтетические тесты release/rollback/build: подменённые docker, curl и GitHub; без сети и сервера.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OPS="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/gh" "$T/secrets"
S1=1111111111111111111111111111111111111111
S2=2222222222222222222222222222222222222222
S3=3333333333333333333333333333333333333333   # не одобрен
echo X=1 > "$T/secrets/shop.env"; chmod 600 "$T/secrets/shop.env"

approve() {
  mkdir -p "$T/gh/compare/main...$1" "$T/gh/commits/$1/pulls" "$T/gh/commits/$1/check-runs"
  echo '{"status":"behind"}' > "$T/gh/compare/main...$1/r"
  echo '[{"merged_at":"2026-10-26","base":{"ref":"main"}}]' > "$T/gh/commits/$1/pulls/r"
  echo '{"check_runs":[{"name":"verify","conclusion":"success"}]}' > "$T/gh/commits/$1/check-runs/r"
}
approve $S1; approve $S2
mkdir -p "$T/gh/compare/main...$S3"; echo '{"status":"ahead"}' > "$T/gh/compare/main...$S3/r"

cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
url="${@: -1}"; out=""
for ((i=1;i<=$#;i++)); do [ "${!i}" = -o ] && { j=$((i+1)); out="${!j}"; }; done
if [[ "$url" == fake-gh/* ]]; then f="$FAKE_GH/${url#fake-gh/repos/sheba-pleasure/masterweld-shop/}/r"; [ -f "$f" ] && cat "$f" && exit 0; exit 22; fi
[[ "$url" == http://127.0.0.1:* ]] || exit 6
port="${url#http://127.0.0.1:}"; port="${port%%/*}"
is_gateway=no; [ "$port" = 18080 ] && is_gateway=yes
if [ "$port" = 18080 ]; then
  printf "gateway %s\\n" "$(cat "$STATE_DIR/workers/active.json")" >> "$FAKE_CONTROL_LOG"
  grep -q 'return 503' "$STATE_DIR/gateway/default.conf" && exit 22
  port="$(grep -o '127.0.0.1:1808[12]' "$STATE_DIR/gateway/default.conf" | tail -1 | cut -d: -f2)"
  [ -f "$FAKE_MODE/gw-$port" ] && exit 22
fi
slot=a; [ "$port" = 18082 ] && slot=b
{ [ -f "$FAKE_CT/mw-shop-slot-$slot" ] && [ ! -f "$FAKE_CT/mw-shop-slot-$slot.stopped" ]; } || exit 7
mode="$(cat "$FAKE_MODE/$port" 2>/dev/null || echo ok)"
[ "$mode" = down ] && exit 22
if [[ "$url" == *"/api/public/release-health?"* ]]; then
  sha="$(cat "$FAKE_CT/mw-shop-slot-$slot")"; environment=production
  [ "$mode" = wrongrevision ] && sha=0000000000000000000000000000000000000000
  [ "$mode" = devhealth ] && environment=dev
  [ "$mode" = badhealth ] && { echo 'not-json'; exit 0; }
  if [ "$is_gateway" = yes ]; then
    [ -f "$FAKE_MODE/gw-revision-$port" ] && sha=0000000000000000000000000000000000000000
    if [ -f "$FAKE_MODE/gw-stale-once-$port" ]; then
      sha=0000000000000000000000000000000000000000
      rm "$FAKE_MODE/gw-stale-once-$port"
    fi
  fi
  printf '{"ready":true,"revision":"%s","environment":"%s"}\n' "$sha" "$environment"
  exit 0
fi
html='<meta name="robots" content="noindex, nofollow"/>'; [ "$mode" = indexable ] && html='<meta name="robots" content="index"/>'
[ -n "$out" ] && exit 0; echo "$html"
EOF
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
[ -n "${FAKE_DOCKER_SLEEP:-}" ] && [ "$1" = run ] && sleep "$FAKE_DOCKER_SLEEP"
case "$1" in
  exec) if [[ "$*" == *"nginx -s reload"* ]]; then
      port="$(grep -o '127.0.0.1:1808[12]' "$STATE_DIR/gateway/default.conf" | tail -1 | cut -d: -f2)"
      [ -f "$FAKE_MODE/reload-$port" ] && exit 1
    fi; exit 0 ;;
  network) [ -f "$FAKE_MODE/no-prod-network" ] && exit 1; echo production ;;
  image) img="${@: -1}"; sha="${img#masterweld-shop:}"; [ -f "$FAKE_IMAGES/$sha" ] && echo "$sha" || exit 1 ;;
  inspect) name="${@: -1}"; [ "$name" = mw-shop-gateway ] && exit 0; [ -f "$FAKE_CT/$name" ] || exit 1
    if [[ "$*" == *State.Running* ]]; then [ -f "$FAKE_CT/$name.stopped" ] && echo false || echo true; else cat "$FAKE_CT/$name"; fi ;;
  run) printf "candidate %s\\n" "$(cat "$STATE_DIR/workers/active.json")" >> "$FAKE_CONTROL_LOG"; prev=""; name=""; for a in "$@"; do [ "$prev" = --name ] && name="$a"; prev="$a"; done; sha="${@: -1}"
    echo "${sha#masterweld-shop:}" > "$FAKE_CT/$name"; rm -f "$FAKE_CT/$name.stopped"; echo id ;;
  rm) rm -f "$FAKE_CT/${@: -1}" "$FAKE_CT/${@: -1}.stopped" ;;
  stop) [ -f "$FAKE_CT/${@: -1}" ] && touch "$FAKE_CT/${@: -1}.stopped"; exit 0 ;;
  start) [ -f "$FAKE_CT/${@: -1}" ] && rm -f "$FAKE_CT/${@: -1}.stopped" || exit 1 ;;
  build) ctx="${@: -1}"; echo "$*" > "$FAKE_BUILD"; ls -A "$ctx" > "$FAKE_BUILD.ctx"
    for a in "$@"; do [[ "$a" == masterweld-shop:* ]] && touch "$FAKE_IMAGES/${a#masterweld-shop:}"; done; true ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$T/bin/"*

export PATH="$T/bin:$PATH" GITHUB_API=fake-gh FAKE_GH="$T/gh" STATE_DIR="$T/state" SECRETS_ENV="$T/secrets/shop.env" \
  FAKE_CONTROL_LOG="$T/control.log" FAKE_LOG="$T/docker.log" FAKE_IMAGES="$T/img" FAKE_CT="$T/ct" FAKE_MODE="$T/mode" FAKE_BUILD="$T/build" HEALTH_TRIES=2 HEALTH_SLEEP=0
mkdir -p "$FAKE_IMAGES" "$FAKE_CT" "$FAKE_MODE"
touch "$FAKE_IMAGES/$S1" "$FAKE_IMAGES/$S2" "$FAKE_IMAGES/$S3"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok  - $1"; else fail=$((fail+1)); echo "FAIL- $1 (ожидалось '$3', получено '$2')"; head -12 "$T/last-run.log" 2>/dev/null; fi; }
run() { "$OPS/$1" "${@:2}" >"$T/last-run.log" 2>&1; echo $?; }
st() { cat "$STATE_DIR/$1" 2>/dev/null; }
gw() { grep -c "$1" "$STATE_DIR/gateway/default.conf" 2>/dev/null || echo 0; }
dlog() { : > "$FAKE_LOG"; }
nactions() { grep -Ec '^(run|rm|stop|start|exec)' "$FAKE_LOG" 2>/dev/null || true; }

# --- предусловия до любых действий ---
check "короткий SHA отклонён" "$(run release.sh abc)" 1
dlog; check "SHA вне main отклонён" "$(run release.sh $S3)" 1
check "  … без действий docker" "$(nactions)" 0
rm "$FAKE_IMAGES/$S1"; dlog; check "нет образа — отказ" "$(run release.sh $S1)" 1; touch "$FAKE_IMAGES/$S1"
check "  … без действий docker" "$(nactions)" 0
chmod 644 "$SECRETS_ENV"; dlog; check "env не 600 — отказ" "$(run release.sh $S1)" 1; chmod 600 "$SECRETS_ENV"
check "  … без действий docker" "$(nactions)" 0
dlog; check "GitHub недоступен — выпуск отклонён" "$(GITHUB_API=fake-off run release.sh $S1)" 1
check "  … без действий docker" "$(nactions)" 0

touch "$FAKE_MODE/no-prod-network"; dlog
check "нет production-сети — отказ до изменения контейнеров" "$(run release.sh $S1)" 1
check "  … без действий docker" "$(nactions)" 0
rm "$FAKE_MODE/no-prod-network"

# --- небезопасный управляющий файл/каталог: отказ до действий ---
mkdir -p "$STATE_DIR"
ln -s "$T/secrets" "$STATE_DIR/workers"; dlog
check "workers symlink — отказ" "$(run release.sh $S1)" 1
check "  … без действий docker" "$(nactions)" 0
rm "$STATE_DIR/workers"
mkdir -m 755 "$STATE_DIR/workers"
echo '{}' > "$STATE_DIR/workers/active.json"; chmod 666 "$STATE_DIR/workers/active.json"; dlog
check "workers writable — отказ" "$(run release.sh $S1)" 1
check "  … без действий docker" "$(nactions)" 0
rm "$STATE_DIR/workers/active.json"
ln -s "$SECRETS_ENV" "$STATE_DIR/workers/active.json"; dlog
check "control symlink — отказ" "$(run release.sh $S1)" 1
check "  … без действий docker" "$(nactions)" 0
rm "$STATE_DIR/workers/active.json"

# --- первый выпуск: сбой после переключения → 503, не успех ---
mkdir -p "$STATE_DIR"; touch "$FAKE_MODE/gw-18081"
check "первый выпуск: сбой после switch → код 2" "$(run release.sh $S1)" 2
check "  … вход переведён в 503" "$(gw 'return 503')" 1
check "  … состояние active не записано" "$(st active_slot)" ""
check "  … в журнале approved пусто" "$(st approved)" ""
check "  … worker остаётся на паузе" "$(st workers/active.json)" "{}"
rm "$FAKE_MODE/gw-18081"

check "первый выпуск S1" "$(run release.sh $S1)" 0
check "активен slot a" "$(st active_slot)" a
check "worker активен только a/S1" "$(st workers/active.json)" "{\"slot\":\"a\",\"sha\":\"$S1\"}"
check "candidate первого выпуска ждал проверки" "$(head -1 "$FAKE_CONTROL_LOG")" "candidate {}"
check "перед переключением mount read-only" "$(grep -c 'target=/run/mw-workers,readonly' "$FAKE_LOG")" 2
check "повтор активного SHA отклонён" "$(run release.sh $S1)" 1
echo indexable > "$FAKE_MODE/18082"
check "без noindex — не переключать" "$(run release.sh $S2)" 1
check "трафик остался на a" "$(gw 'proxy_pass http://127.0.0.1:18081')" 1
check "неуспешный candidate не сменил worker" "$(st workers/active.json)" "{\"slot\":\"a\",\"sha\":\"$S1\"}"
rm "$FAKE_MODE/18082"
for identity_mode in wrongrevision devhealth badhealth; do
  echo "$identity_mode" > "$FAKE_MODE/18082"
  check "candidate $identity_mode — отказ без переключения" "$(run release.sh $S2)" 1
  check "  … активен прежний a/S1" "$(st active_slot)/$(st active_sha)" "a/$S1"
done
rm "$FAKE_MODE/18082"
touch "$FAKE_MODE/gw-revision-18082"
check "gateway ответил чужим SHA — автооткат" "$(run release.sh $S2)" 2
check "  … активен a/S1 и его worker" "$(st workers/active.json)" "{\"slot\":\"a\",\"sha\":\"$S1\"}"
rm "$FAKE_MODE/gw-revision-18082"
touch "$FAKE_MODE/gw-stale-once-18082"
check "выпуск S2" "$(run release.sh $S2)" 0
check "активен b/S2" "$(st active_slot)/$(st active_sha)" "b/$S2"
check "старый ответ gateway дождался правильного SHA" "$(test -e "$FAKE_MODE/gw-stale-once-18082"; echo $?)" 1
check "предыдущий a/S1 сохранён" "$(st previous_slot)/$(st previous_sha)" "a/$S1"
check "контейнер a не удалён" "$(cat "$FAKE_CT/mw-shop-slot-a")" "$S1"
check "старый контейнер работает, но очередь у b/S2" "$(st workers/active.json)" "{\"slot\":\"b\",\"sha\":\"$S2\"}"

# --- «Откати» ---
check "откат на чужой SHA отклонён" "$(run rollback.sh $S2)" 1
check "откат на неутверждённый SHA отклонён" "$(run rollback.sh $S3)" 1
cp "$STATE_DIR/approved" "$T/approved.bak"; chmod 666 "$STATE_DIR/approved"
check "журнал approved с правами 666 — отказ" "$(run rollback.sh)" 1
cp "$T/approved.bak" "$STATE_DIR/approved"; chmod 644 "$STATE_DIR/approved"
grep -v "a $S1" "$T/approved.bak" > "$STATE_DIR/approved"
check "previous нет в журнале — отказ" "$(run rollback.sh)" 1
cp "$T/approved.bak" "$STATE_DIR/approved"
# офлайн: GitHub недоступен, образ S1 удалён, контейнер a остановлен
rm "$FAKE_IMAGES/$S1"; touch "$FAKE_CT/mw-shop-slot-a.stopped"; dlog
check "«Откати» без аргумента — OFFLINE, без образа" "$(GITHUB_API=fake-off run rollback.sh)" 0
check "активен a/S1" "$(st active_slot)/$(st active_sha)" "a/$S1"
check "previous стал b/S2" "$(st previous_slot)/$(st previous_sha)" "b/$S2"
check "офлайн откат передал очередь a/S1" "$(st workers/active.json)" "{\"slot\":\"a\",\"sha\":\"$S1\"}"
check "откат не обращался к образам" "$(grep -c '^image' "$FAKE_LOG")" 0
touch "$FAKE_IMAGES/$S1"
# возврат вперёд через откат с явным SHA
check "откат с явным SHA = previous" "$(run rollback.sh $S2)" 0
check "активен b/S2" "$(st active_slot)/$(st active_sha)" "b/$S2"
# контейнер предыдущего выпуска удалён → понятный отказ без восстановления
mv "$FAKE_CT/mw-shop-slot-a" "$T/ct-a.bak"; dlog
check "контейнер previous отсутствует — отказ" "$(run rollback.sh)" 1
check "  … без попыток run/start" "$(nactions)" 0
mv "$T/ct-a.bak" "$FAKE_CT/mw-shop-slot-a"
# метка контейнера не совпадает
echo "$S3" > "$FAKE_CT/mw-shop-slot-a"
check "чужая метка контейнера — отказ" "$(run rollback.sh)" 1
echo "$S1" > "$FAKE_CT/mw-shop-slot-a"

# --- неуспешный откат восстанавливает управление worker ---
touch "$FAKE_MODE/gw-18081"
check "неуспешный rollback — отказ" "$(run rollback.sh)" 1
check "rollback вернул worker b/S2" "$(st workers/active.json)" "{\"slot\":\"b\",\"sha\":\"$S2\"}"
rm "$FAKE_MODE/gw-18081"
cp "$STATE_DIR/workers/active.json" "$T/control.bak"
echo '{"slot":"a","sha":"wrong"}' > "$STATE_DIR/workers/active.json"; dlog
check "несогласованный control — отказ" "$(run rollback.sh)" 1
check "  … без действий docker" "$(nactions)" 0
cp "$T/control.bak" "$STATE_DIR/workers/active.json"

# --- автооткат при сбое после переключения ---
check "откат на a/S1" "$(run rollback.sh)" 0
touch "$FAKE_MODE/gw-18082"
check "сбой после переключения → код 2" "$(run release.sh $S2)" 2
check "автооткат вернул gateway на a" "$(gw 'proxy_pass http://127.0.0.1:18081')" 1
check "состояние осталось a/S1" "$(st active_slot)/$(st active_sha)" "a/$S1"
check "автооткат восстановил очередь a/S1" "$(st workers/active.json)" "{\"slot\":\"a\",\"sha\":\"$S1\"}"
rm "$FAKE_MODE/gw-18082"

# --- ошибка reload: возврат к проверенному старому выпуску ---
touch "$FAKE_MODE/reload-18082"
check "ошибка reload — автооткат" "$(run release.sh $S2)" 2
check "reload failure оставил worker a/S1" "$(st workers/active.json)" "{\"slot\":\"a\",\"sha\":\"$S1\"}"
rm "$FAKE_MODE/reload-18082"

# --- взаимное исключение (общий release.lock) ---
flock "$STATE_DIR/release.lock" sleep 3 & LOCKPID=$!; sleep 0.3
check "release при занятом lock — отказ" "$(run release.sh $S2)" 1
check "rollback при занятом lock — отказ" "$(run rollback.sh)" 1
check "build при занятом lock — отказ" "$(CONFIRM_BUILD=yes run build-approved.sh $S2)" 1
wait $LOCKPID
FAKE_DOCKER_SLEEP=2 "$OPS/release.sh" $S2 >/dev/null 2>&1 & RPID=$!; sleep 0.5
check "rollback во время release — отказ" "$(run rollback.sh)" 1
wait $RPID; check "параллельный release завершился" "$?" 0

# --- build-approved: git archive точного SHA, только публичные VITE_* ---
# Временный репозиторий через plumbing (без изменения чьих-либо веток).
R="$T/repo"; mkdir -p "$R"; git -C "$R" init -q; echo hi > "$R/a.txt"; git -C "$R" update-index --add a.txt
B="$(echo c | GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t git -C "$R" commit-tree "$(git -C "$R" write-tree)")"; echo "SECRET=1" > "$R/.env"; echo dirty > "$R/a.txt"
approve "$B"; PUB="$T/secrets/build-public.env"
printf 'VITE_SUPABASE_URL=https://x\nVITE_SUPABASE_PROJECT_ID=p\n' > "$PUB"; chmod 600 "$PUB"
export REPO_DIR="$R" PUBLIC_BUILD_ENV="$PUB"
check "build без CONFIRM_BUILD — отказ" "$(run build-approved.sh $B)" 1
check "build неутверждённого SHA — отказ" "$(CONFIRM_BUILD=yes run build-approved.sh $S3)" 1
printf 'SUPABASE_SERVICE_ROLE_KEY=x\n' >> "$PUB"
check "build с серверным ключом в env — отказ" "$(CONFIRM_BUILD=yes run build-approved.sh $B)" 1
printf 'VITE_SUPABASE_URL=https://x\nVITE_SUPABASE_PROJECT_ID=p\n' > "$PUB"
CONFIRM_BUILD=yes "$OPS/build-approved.sh" $B 2>"$T/b.err"; check "build утверждённого SHA" "$?" 0
check "  … контекст = git archive (без .env)" "$(tr '\n' ' ' < "$FAKE_BUILD.ctx")" "a.txt "
check "  … GIT_SHA передан" "$(grep -c "GIT_SHA=$B" "$FAKE_BUILD")" 1
check "  … рабочие файлы не тронуты" "$(cat "$R/a.txt")" dirty
check "повторная сборка — отказ" "$(CONFIRM_BUILD=yes run build-approved.sh $B)" 1

check "ни один скрипт не вызывает psql/миграции" "$(grep -El 'psql|supabase db|migrat' "$OPS"/*.sh | wc -l | tr -d ' ')" 0
check "на всех проверках gateway очередь на паузе" "$(grep '^gateway ' "$FAKE_CONTROL_LOG" | grep -vc '^gateway {}$' || true)" 0
echo "итог: $pass ok, $fail fail"; [ "$fail" = 0 ]
