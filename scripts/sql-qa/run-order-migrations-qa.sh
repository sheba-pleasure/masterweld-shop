#!/usr/bin/env bash
# Isolated SQL QA for order migrations 0000, 0002, 0003, 0004, 0010, 0011.
# Starts a THROWAWAY local PostgreSQL in /tmp (unix socket only, no TCP),
# never touches the cloud database. All PG* env vars are unset first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for v in $(compgen -e | grep -E '^PG|DATABASE_URL|SUPABASE_DB'); do unset "$v"; done
WORK="$(mktemp -d /tmp/mw-sqlqa.XXXXXX)"
SOCK="$WORK/sock"; DATA="$WORK/data"; PORT=54329
# No system files are modified. As root, postgres must run under an EXISTING non-root
# account (QA_PG_UID, default 65534); if absent we abort instead of creating users.
if [ "$(id -u)" = 0 ]; then
  QA_PG_UID="${QA_PG_UID:-65534}"
  if [ "$QA_PG_UID" = 0 ] || ! getent passwd "$QA_PG_UID" >/dev/null; then
    echo "ABORT: running as root, but UID $QA_PG_UID does not exist (or is root)."
    echo "Re-run as a non-root user, or set QA_PG_UID to an existing non-root account. No system files are changed."
    rm -rf "$WORK"; exit 4
  fi
  QA_PG_GID="$(getent passwd "$QA_PG_UID" | cut -d: -f4)"
  AS="setpriv --reuid=$QA_PG_UID --regid=$QA_PG_GID --clear-groups"
else
  AS=""
fi
mkdir -p "$SOCK" "$DATA"; [ -z "$AS" ] || chown -R "$QA_PG_UID:$QA_PG_GID" "$WORK"
cleanup() { $AS pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
$AS initdb -D "$DATA" -U qa --auth=trust >/dev/null
$AS pg_ctl -D "$DATA" -l "$WORK/pg.log" -o "-k $SOCK -p $PORT -c listen_addresses=''" -w start >/dev/null
export PGHOST="$SOCK" PGPORT="$PORT" PGUSER=qa PGDATABASE=postgres
case "$PGHOST" in /tmp/mw-sqlqa.*) ;; *) echo "REFUSING: not local"; exit 3;; esac
P() { $AS env PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER=qa PGDATABASE=postgres psql -X -q -v ON_ERROR_STOP=1 "$@"; }
PF() { P -o /dev/null "$@"; }
# Preflight runs in a read-only session; drop pg_version (first field) and compare.
PRE() { $AS env PGOPTIONS="-c default_transaction_read_only=on" PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER=qa PGDATABASE=postgres \
  psql -X -q -v ON_ERROR_STOP=1 -tA -F, -f "$ROOT/scripts/sql-qa/preflight-order-migrations.sql" | cut -d, -f2-; }
pre_check() { local got; got="$(PRE)"; PF -c "select qa.check('preflight $1 = $2', '$got'='$2')"; [ "$got" = "$2" ] || echo "preflight $1 got: $got"; }
psql_ver=$(P -tAc "select version()"); echo "Local server: $psql_ver"
P -tAc "select inet_server_addr() is null" | grep -qx t || { echo "REFUSING: TCP"; exit 3; }

M="$ROOT/drizzle/migrations"; D="$ROOT/docs/migrations"; Q="$ROOT/scripts/sql-qa"
PF -f "$Q/00_supabase_roles.sql"
# Regression: preflight must not error when shop_orders does not exist yet.
pre_check no_shop_orders f,f,f,f,f,f,f,f,f,f,,f,f,f,f,f,f
PF -f "$M/0000_staff_roles.sql"
PF -f "$M/0002_create_shop_orders.sql"
pre_check before f,f,f,f,f,t,t,t,t,t,t,f,f,f,f,f,f
PF -f "$Q/10_before_0004.sql"
PF -f "$M/0003_order_status_and_events.sql"
PF -f "$M/0004_lock_shop_orders_insert.sql"
PF -f "$Q/20_after_0004.sql"
pre_check after_0004_before_0011 t,t,t,t,t,t,f,t,f,f,t,f,f,f,f,t,t
PF -f "$D/0011_order_privileges_hardening.sql"
PF -f "$D/0010_bot_security.sql"
# idempotency of re-runnable files
PF -f "$M/0004_lock_shop_orders_insert.sql"; PF -f "$D/0011_order_privileges_hardening.sql"; PF -f "$D/0010_bot_security.sql"
PF -f "$Q/30_functions.sql"
pre_check after_all t,t,t,t,f,f,f,f,f,f,t,t,t,f,t,t,t
# 0003 re-run is NOT idempotent (CREATE TYPE/TABLE without guards): record the fact.
if P -f "$M/0003_order_status_and_events.sql" >/dev/null 2>&1; then r=t; else r=f; fi
PF -c "select qa.check('0003 re-run fails (not idempotent, documented)', '$r'='f')"

# Concurrency: A holds row locks via FOR UPDATE, B with the same expected status must wait then conflict.
OID=$(P -tAc "insert into public.shop_orders(name,phone,items,total) values('Конк','+70000000000','[1]',1) returning id")
( P -c "begin; select public.bot_change_order_status('$OID',1,'new','processing'); select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.7
t0=$(date +%s.%N)
B=$(P -tAc "select public.bot_change_order_status('$OID',3,'new','canceled')" 2>&1 || true)
t1=$(date +%s.%N); wait
waited=$(python3 -c "print(1 if $t1-$t0>1.0 else 0)")
PF -c "select qa.check('concurrency: B waited on FOR UPDATE lock', $waited=1)"
PF -c "select qa.check('concurrency: B got BOT_ORDER_CONFLICT', $( [[ "$B" == *BOT_ORDER_CONFLICT* ]] && echo true || echo false ))"
PF -c "select qa.check('concurrency: final status processing, one event', (select status::text from public.shop_orders where id='$OID')='processing' and (select count(*) from public.order_events where order_id='$OID')=1)"

P -tAc "select (case when ok then 'PASS ' else 'FAIL ' end)||name from qa.results order by id"
TOTAL=$(P -tAc "select count(*) from qa.results"); FAILED=$(P -tAc "select count(*) from qa.results where not ok")
echo "SQL checks: $TOTAL total, $FAILED failed"
[ "$FAILED" = 0 ]
