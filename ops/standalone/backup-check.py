#!/usr/bin/env python3
"""Back up only the identified standalone DB and restore into a disposable private DB."""
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import uuid
from datetime import datetime, timezone

MODULE = pathlib.Path(__file__).with_name("data-up.py")
spec = importlib.util.spec_from_file_location("standalone", MODULE)
data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data)


def main():
    data.owned("container", "mw-prod-db")
    path = data.PRIVATE / "credentials.json"
    data.private_file("credentials.json", path.read_text())
    conf = json.loads(path.read_text())
    identity = json.loads(data.sql("SELECT public.mw_environment_identity()"))
    if identity != {"environment": "production", "instanceId": conf["instance"]}:
        raise RuntimeError("DATABASE_IDENTITY_MISMATCH")
    folder = data.ROOT / "ops/.state/production/backups"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    dump = folder / (stamp + ".dump")
    fd = os.open(dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        result = subprocess.run(["docker", "exec", "mw-prod-db", "pg_dump", "-U", "postgres",
                                 "-d", data.DB, "-Fc"], stdout=stream, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError("BACKUP_FAILED")
    # pg_dump excludes global roles; preserve definitions without password hashes.
    roles = data.run(["docker", "exec", "mw-prod-db", "pg_dumpall", "-U", "postgres",
                      "--roles-only", "--no-role-passwords"])
    fd = os.open(folder / (stamp + ".roles.sql"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(roles)
    restore_db = "mw_restore_" + uuid.uuid4().hex
    data.run(["docker", "exec", "mw-prod-db", "createdb", "-U", "postgres", restore_db])
    try:
        with dump.open("rb") as stream:
            data.run(["docker", "exec", "-i", "mw-prod-db", "pg_restore", "-U", "postgres",
                      "-d", restore_db, "--exit-on-error", "--single-transaction"], stdin=stream)
        check = """DO $$ BEGIN
IF public.mw_environment_identity()->>'environment' <> 'production'
THEN RAISE EXCEPTION 'WRONG_ENVIRONMENT'; END IF;
IF has_table_privilege('anon','shop_orders','INSERT')
OR has_table_privilege('service_role','shop_orders','INSERT')
THEN RAISE EXCEPTION 'DIRECT_INSERT_OPEN'; END IF;
IF to_regprocedure('public.lookup_order_submission(uuid,text)') IS NULL
THEN RAISE EXCEPTION 'SUBMISSION_RPC_MISSING'; END IF;
END $$;
SELECT count(*) FROM public.products;
SELECT count(*) FROM public.shop_orders;
SELECT count(*) FROM public.staff;
SELECT count(*) FROM public.order_submissions;
SELECT count(*) FROM public.order_notifications;
"""
        result = data.run(["docker", "exec", "-i", "mw-prod-db", "psql", "-X", "-U", "postgres",
                           "-d", restore_db, "-v", "ON_ERROR_STOP=1", "-Atq"], input=check.encode()).decode().strip()
        counts = [int(value) for value in result.splitlines()]
        report = {"backup": dump.name, "sha256": hashlib.sha256(dump.read_bytes()).hexdigest(),
                  "restored": True, "counts": dict(zip(["products", "orders", "staff", "submissions", "notifications"], counts)),
                  "scope": "Standalone production DB only; not Cloud export or off-site recovery. No files/media copied."}
        fd = os.open(folder / (stamp + ".json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(report, stream, indent=2)
        print(json.dumps(report, indent=2))
    finally:
        data.run(["docker", "exec", "mw-prod-db", "dropdb", "-U", "postgres", restore_db])


if __name__ == "__main__":
    main()
