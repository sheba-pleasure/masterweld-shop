#!/usr/bin/env python3
"""Disposable PostgreSQL: shared browser IDs use one order/notification receipt. No live DB."""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-checkout-qa-" + uuid.uuid4().hex[:12]
parser = argparse.ArgumentParser()
parser.add_argument("--browser-report", type=pathlib.Path)
args = parser.parse_args()
first, repeated = str(uuid.uuid4()), str(uuid.uuid4())
if args.browser_report:
    report = json.loads(args.browser_report.read_text())
    assert report["passed"] is True and report["liveOrdersCreated"] is False
    assert report["syntheticServer"] is True and report["uniqueInitialIDs"] == 1
    assert len(report["initialIds"]) == 2 and len(set(report["initialIds"])) == 1
    first, repeated = str(uuid.UUID(report["initialIds"][0])), str(uuid.UUID(report["repeatId"]))
    assert first != repeated
    for field, file in [
        ("componentSha256", "src/components/SiteActions.tsx"),
        ("moduleSha256", "src/lib/orders/browser-attempt.ts"),
    ]:
        assert report[field] == hashlib.sha256((ROOT / file).read_bytes()).hexdigest()

def run(argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True)

def sql(query, check=True):
    result = subprocess.run(
        ["docker", "exec", "-i", NAME, "psql", "-h", "127.0.0.1", "-U", "postgres",
         "-X", "-At", "-v", "ON_ERROR_STOP=1"],
        input=query, capture_output=True, text=True,
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip() if check else result

def commit(request_id, fingerprint="a" * 64, rejection="NULL"):
    # IDs and fingerprints originate only from this fixture / a validated synthetic report.
    request_id = str(uuid.UUID(request_id))
    assert len(fingerprint) == 64 and set(fingerprint) <= set("0123456789abcdef")
    query = f"""SET ROLE service_role;
      SELECT public.commit_order_submission('{request_id}','{fingerprint}',
        'Учебный покупатель','+79990000001',NULL,'[]',900,false,{rejection});"""
    return sql(query).splitlines()[-1]

try:
    run(["docker", "run", "-d", "--name", NAME, "--network", "none",
         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    for _ in range(60):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True).returncode == 0:
            break
        time.sleep(.3)
    else:
        raise RuntimeError("PG_NOT_READY")
    sql("""
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.staff(telegram_id bigint PRIMARY KEY, active boolean NOT NULL);
      CREATE TABLE public.shop_orders(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, phone text,
        comment text, items jsonb, total numeric);
      INSERT INTO public.staff VALUES (42,true);
    """)
    for migration in ("0012_order_notifications.sql", "0013_order_submissions.sql"):
        sql((ROOT / "docs/migrations" / migration).read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        receipts = list(pool.map(lambda _: commit(first), range(16)))
    assert len(set(receipts)) == 1
    assert sql("SELECT count(*) FROM shop_orders") == "1"
    assert sql("SELECT count(*) FROM order_notifications") == "1"
    run(["docker", "restart", NAME])
    for _ in range(60):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True).returncode == 0:
            break
        time.sleep(.3)
    else:
        raise RuntimeError("PG_NOT_READY_AFTER_RESTART")
    assert commit(first) == receipts[0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        repeats = list(pool.map(lambda _: commit(repeated), range(16)))
    assert len(set(repeats)) == 1 and repeats[0] != receipts[0]
    assert sql("SELECT count(*) FROM shop_orders") == "2"
    assert sql("SELECT count(*) FROM order_notifications") == "2"
    rejected = str(uuid.uuid4())
    rejection = """'{"ok":false,"code":"PRICE_CHANGED","total":950}'"""
    refused = commit(rejected, rejection=rejection)
    assert commit(rejected) == refused
    assert sql("SELECT count(*) FROM shop_orders") == "2"
    conflict = sql(f"SELECT public.lookup_order_submission('{first}','{'b' * 64}')", False)
    assert conflict.returncode != 0 and "ORDER_ATTEMPT_CONFLICT" in conflict.stderr
    assert sql("SELECT has_function_privilege('anon','public.lookup_order_submission(uuid,text)','EXECUTE')") == "f"
    assert sql("SELECT has_table_privilege('service_role','public.shop_orders','INSERT')") == "f"
    print(json.dumps({
        "browserReportBound": bool(args.browser_report), "sameAttemptRequests": 16,
        "ordersBeforeExplicitRepeat": 1, "notificationsBeforeExplicitRepeat": 1,
        "ordersAfterExplicitRepeat": 2, "notificationsAfterExplicitRepeat": 2,
        "restartPreservesReceipt": True, "rejectionCannotBecomeOrder": True,
        "payloadConflictDenied": True, "liveDatabaseTouched": False,
    }))
finally:
    subprocess.run(["docker", "rm", "-fv", NAME], capture_output=True)
