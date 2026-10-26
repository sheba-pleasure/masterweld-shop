#!/usr/bin/env bash
# Сборка образа точного утверждённого SHA: CONFIRM_BUILD=yes ops/build-approved.sh <40-hex SHA>
# Только после merge PR в main + успешного verify (проверка через GitHub API, read-only токен).
# Источник — `git archive SHA` из локального checkout во временный каталог: ветки,
# main/dev и рабочие файлы не меняются. В образ передаются только публичные VITE_SUPABASE_*
# из защищённого файла (600); серверные ключи в образ не попадают.
# Production не меняет. Выпуск — отдельно ops/release.sh <SHA> после «Выпускай».
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

SHA="${1:-}"
require_sha "$SHA"
REPO_DIR="${REPO_DIR:-$(cd "$OPS_DIR/.." && pwd)}"
PUBLIC_BUILD_ENV="${PUBLIC_BUILD_ENV:-$OPS_DIR/.secrets/build-public.env}"
[ "${CONFIRM_BUILD:-}" = yes ] || die "сборка требует CONFIRM_BUILD=yes"
acquire_lock
{ [ -f "$PUBLIC_BUILD_ENV" ] && [ ! -L "$PUBLIC_BUILD_ENV" ]; } || die "нет $PUBLIC_BUILD_ENV"
(( (8#$(stat -c %a "$PUBLIC_BUILD_ENV") & 8#077) == 0 )) || die "$PUBLIC_BUILD_ENV должен иметь права 600"

ARGS=(--build-arg "GIT_SHA=$SHA")
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"
  case "$key" in
    VITE_SUPABASE_URL|VITE_SUPABASE_PUBLISHABLE_KEY|VITE_SUPABASE_PROJECT_ID) ARGS+=(--build-arg "$line") ;;
    *) die "в $(basename "$PUBLIC_BUILD_ENV") недопустимый ключ '$key' (разрешены только публичные VITE_SUPABASE_*)" ;;
  esac
done < "$PUBLIC_BUILD_ENV"

git -C "$REPO_DIR" cat-file -e "$SHA^{commit}" 2>/dev/null || die "коммит $SHA отсутствует в локальном checkout"
require_github_approval "$SHA"
docker image inspect "$IMAGE_REPO:$SHA" >/dev/null 2>&1 && die "образ $IMAGE_REPO:$SHA уже существует"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git -C "$REPO_DIR" archive --format=tar "$SHA" | tar -x -C "$TMP"
if find "$TMP" \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' | grep -q .; then
  die "в коммите $SHA найден .env — отказ"
fi
log "сборка $IMAGE_REPO:$SHA из git archive"
docker build "${ARGS[@]}" -t "$IMAGE_REPO:$SHA" "$TMP" >&2
require_image "$SHA"
log "ГОТОВО: образ $IMAGE_REPO:$SHA собран. Выпуск — только ops/release.sh $SHA после «Выпускай»."
