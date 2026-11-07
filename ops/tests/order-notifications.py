#!/usr/bin/env python3
"""Real isolated PostgreSQL: recipient snapshot, competing claims, receipts and crash recovery. No Telegram."""
import concurrent.futures
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-alerts-qa-" + uuid.uuid4().hex[:12]
ORDER = "10000000-0000-4000-8000-000000000001"
SECOND = "10000000-0000-4000-8000-000000000002"


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def sql(query, check=True):
    result = subprocess.run(
        ["docker", "exec", "-i", NAME, "psql", "-h", "127.0.0.1", "-U", "postgres", "-X", "-At",
         "-v", "ON_ERROR_STOP=1"],
        input=query, capture_output=True, text=True,
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip() if check else result.returncode


def ready():
    for _ in range(60):
        # The image starts a temporary Unix-socket server during initdb. Wait for final TCP startup.
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True).returncode == 0:
            return
        time.sleep(.3)
    raise RuntimeError("PG_NOT_READY")


def claim():
    raw = sql("SET ROLE service_role; SELECT row_to_json(j) FROM claim_order_notification() j;")
    lines = raw.splitlines()
    return json.loads(lines[-1]) if lines and lines[-1].startswith("{") else None


try:
    run(["docker", "run", "-d", "--name", NAME, "--network", "none",
         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    ready()
    sql("""
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.staff(telegram_id bigint PRIMARY KEY, active boolean NOT NULL);
      CREATE TABLE public.shop_orders(id uuid PRIMARY KEY);
      INSERT INTO public.staff VALUES (42,true),(43,false);
    """)
    sql((ROOT / "docs/migrations/0012_order_notifications.sql").read_text())
    sql(f"INSERT INTO shop_orders VALUES ('{ORDER}');")
    assert sql("SELECT count(*) FROM order_notifications;") == "1"
    assert sql("SELECT staff_telegram_id FROM order_notifications;") == "42"
    # No delayed backfill for a staff member activated after order creation.
    sql("UPDATE staff SET active=true WHERE telegram_id=43;")
    assert sql("SELECT count(*) FROM order_notifications;") == "1"

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = [job for job in pool.map(lambda _: claim(), range(8)) if job]
    assert len(jobs) == 1
    job = jobs[0]
    assert job["state"] == "sending" and job["attempts"] == 1 and job["claim_token"]
    # Old/stale acknowledgements cannot finish a different claim.
    assert sql(f"""SET ROLE service_role;
      WITH changed AS (UPDATE order_notifications SET state='sent',telegram_message_id=12
        WHERE order_id='{ORDER}' AND staff_telegram_id=42
          AND claim_token='00000000-0000-4000-8000-000000000000' AND state='sending' RETURNING *)
      SELECT count(*) FROM changed;""").splitlines()[-1] == "0"
    token = str(uuid.UUID(job["claim_token"]))
    sql(f"""SET ROLE service_role;
      UPDATE order_notifications SET state='sent',telegram_message_id=12
        WHERE order_id='{ORDER}' AND staff_telegram_id=42 AND claim_token='{token}' AND state='sending';""")
    assert claim() is None
    run(["docker", "restart", NAME])
    ready()
    assert claim() is None
    assert sql(f"SELECT state||'/'||attempts FROM order_notifications WHERE order_id='{ORDER}';") == "sent/1"

    # A later order snapshots both staff; two parallel workers get different durable jobs.
    sql(f"INSERT INTO shop_orders VALUES ('{SECOND}');")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = [job for job in pool.map(lambda _: claim(), range(8)) if job]
    assert len(jobs) == 2 and {j["staff_telegram_id"] for j in jobs} == {42, 43}
    assert len({j["claim_token"] for j in jobs}) == 2
    # Simulate elapsed lease time only in this disposable no-network test database.
    sql(f"UPDATE order_notifications SET claimed_at=now()-interval '6 minutes' WHERE order_id='{SECOND}';")
    run(["docker", "restart", NAME])
    ready()
    assert claim() is None
    assert sql(f"SELECT count(*) FROM order_notifications WHERE order_id='{SECOND}' AND state='uncertain' AND reason='worker_interrupted' AND attempts=1;") == "2"
    assert claim() is None
    for role in ("anon", "authenticated"):
        assert sql(f"SET ROLE {role}; SELECT * FROM claim_order_notification();", False) != 0
        assert sql(f"SET ROLE {role}; SELECT * FROM order_notifications;", False) != 0
    assert sql("SET ROLE service_role; DELETE FROM order_notifications;", False) != 0
    print(json.dumps({"singleClaim": True, "recipientSnapshot": True,
                      "staleAckRejected": True, "restartPreservesSent": True,
                      "abandonedNotRetried": True, "publicAccessDenied": True}))
finally:
    subprocess.run(["docker", "rm", "-fv", NAME], capture_output=True)
