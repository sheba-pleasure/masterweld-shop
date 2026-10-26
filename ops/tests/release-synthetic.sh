#!/usr/bin/env bash
# Синтетические тесты release/rollback: подменённые docker и curl, без сети и сервера.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OPS="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/gh" "$T/secrets"
S1=1111111111111111111111111111111111111111
S2=2222222222222222222222222222222222222222
S3=3333333333333333333333333333333333333333   # не одобрен
echo X=1 > "$T/secrets/shop.env"

for s in $S1 $S2; do
  mkdir -p "$T/gh/compare/main...$s" "$T/gh/commits/$s/pulls" "$T/gh/commits/$s/check-runs"
  echo '{"status":"behind"}' > "$T/gh/compare/main...$s/r"
  echo '[{"merged_at":"2026-10-26","base":{"ref":"main"}}]' > "$T/gh/commits/$s/pulls/r"
  echo '{"check_runs":[{"name":"verify","conclusion":"success"}]}' > "$T/gh/commits/$s/check-runs/r"
done
mkdir -p "$T/gh/compare/main...$S3"; echo '{"status":"ahead"}' > "$T/gh/compare/main...$S3/r"

cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
url="${@: -1}"; out=""
for ((i=1;i<=$#;i++)); do [ "${!i}" = -o ] && { j=$((i+1)); out="${!j}"; }; done
if [[ "$url" == fake-gh/* ]]; then f="$FAKE_GH/${url#fake-gh/repos/sheba-pleasure/masterweld-shop/}/r"; [ -f "$f" ] && cat "$f" && exit 0; exit 22; fi
port="${url#http://127.0.0.1:}"; port="${port%%/*}"
if [ "$port" = 18080 ]; then port="$(grep -o '127.0.0.1:1808[12]' "$STATE_DIR/gateway/default.conf" | tail -1 | cut -d: -f2)"; [ -f "$FAKE_MODE/gw-$port" ] && exit 22; fi
[ -f "$FAKE_DOWN/$port" ] && exit 22
mode="$(cat "$FAKE_MODE/$port" 2>/dev/null || echo ok)"
[ "$mode" = down ] && exit 22
html='<meta name="robots" content="noindex, nofollow"/>'; [ "$mode" = indexable ] && html='<meta name="robots" content="index"/>'
[ -n "$out" ] && exit 0; echo "$html"
EOF
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  image) img="${@: -1}"; sha="${img#masterweld-shop:}"; [ -f "$FAKE_IMAGES/$sha" ] && echo "$sha" || exit 1 ;;
  inspect) name="${@: -1}"; [ "$name" = mw-shop-gateway ] && exit 0; [ -f "$FAKE_CT/$name" ] && cat "$FAKE_CT/$name" || exit 1 ;;
  run) name=""; sha=""; for a in "$@"; do [ "$prev" = --name ] && name="$a"; prev="$a"; done; sha="${@: -1}"; echo "${sha#masterweld-shop:}" > "$FAKE_CT/$name"; echo id ;;
  rm) rm -f "$FAKE_CT/${@: -1}" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$T/bin/"*

export PATH="$T/bin:$PATH" GITHUB_API=fake-gh FAKE_GH="$T/gh" STATE_DIR="$T/state" SECRETS_ENV="$T/secrets/shop.env" \
  FAKE_LOG="$T/docker.log" FAKE_IMAGES="$T/img" FAKE_CT="$T/ct" FAKE_MODE="$T/mode" FAKE_DOWN="$T/down" HEALTH_TRIES=2 HEALTH_SLEEP=0
mkdir -p "$FAKE_IMAGES" "$FAKE_CT" "$FAKE_MODE" "$FAKE_DOWN"
touch "$FAKE_IMAGES/$S1" "$FAKE_IMAGES/$S2" "$FAKE_IMAGES/$S3"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok  - $1"; else fail=$((fail+1)); echo "FAIL- $1 (ожидалось '$3', получено '$2')"; fi; }
run() { "$OPS/$1" "${@:2}" >/dev/null 2>&1; echo $?; }
st() { cat "$STATE_DIR/$1" 2>/dev/null; }

check "короткий SHA отклонён" "$(run release.sh abc)" 1
check "SHA вне main отклонён" "$(run release.sh $S3)" 1
rm "$FAKE_IMAGES/$S1"; check "нет образа — отказ" "$(run release.sh $S1)" 1; touch "$FAKE_IMAGES/$S1"
check "первый выпуск S1" "$(run release.sh $S1)" 0
check "активен slot a" "$(st active_slot)" a
check "повтор активного SHA отклонён" "$(run release.sh $S1)" 1
echo indexable > "$FAKE_MODE/18082"
check "без noindex — не переключать" "$(run release.sh $S2)" 1
check "трафик остался на a" "$(grep -c "proxy_pass http://127.0.0.1:18081" "$STATE_DIR/gateway/default.conf")" 1
rm "$FAKE_MODE/18082"
check "выпуск S2" "$(run release.sh $S2)" 0
check "активен b/S2" "$(st active_slot)/$(st active_sha)" "b/$S2"
check "предыдущий a/S1 сохранён" "$(st previous_slot)/$(st previous_sha)" "a/$S1"
check "контейнер a не удалён" "$(cat "$FAKE_CT/mw-shop-slot-a")" "$S1"
check "откат на чужой SHA отклонён" "$(run rollback.sh $S2)" 1
check "«Откати» на S1" "$(run rollback.sh $S1)" 0
check "активен a/S1" "$(st active_slot)/$(st active_sha)" "a/$S1"
# автооткат: новый slot проходит прямую проверку, но после переключения gateway ломается
touch "$FAKE_MODE/gw-18082"
check "сбой после переключения → код 2" "$(run release.sh $S2)" 2
check "автооткат вернул gateway на a" "$(grep -c "proxy_pass http://127.0.0.1:18081" "$STATE_DIR/gateway/default.conf")" 1
check "состояние осталось a/S1" "$(st active_slot)/$(st active_sha)" "a/$S1"
rm "$FAKE_MODE/gw-18082"
check "ни один скрипт не вызывает psql/миграции" "$(grep -El 'psql|supabase|migrat' "$OPS"/*.sh | wc -l | tr -d ' ')" 0
echo "итог: $pass ok, $fail fail"; [ "$fail" = 0 ]
