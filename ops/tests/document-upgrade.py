#!/usr/bin/env python3
"""Exercise the shared document upgrade probe only in a disposable offline cluster."""
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-document-upgrade-qa-" + uuid.uuid4().hex[:12]


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs)


def sql(query):
    result = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-X", "-Atq", "-U", "postgres",
                             "-v", "ON_ERROR_STOP=1"], input=query, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def ready():
    for _ in range(100):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True).returncode == 0:
            return
        time.sleep(.2)
    raise RuntimeError("PG_NOT_READY")


def fingerprints():
    tables = json.loads(sql("""SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables
        WHERE schemaname='public';"""))
    return {table: sql("SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) FROM public."
                      + '"' + table.replace('"', '""') + '" t;') for table in tables}


created = False
try:
    command(["docker", "run", "-d", "--name", NAME, "--network", "none",
             "--label", "mw.environment=isolated-qa", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
             "postgres:17.6-alpine"])
    created = True
    ready()
    paths = [ROOT / "ops/dev/bootstrap.sql", *sorted((ROOT / "drizzle/migrations").glob("*.sql")),
             *[p for p in sorted((ROOT / "docs/migrations").glob("*.sql")) if p.name[:4] <= "0028"]]
    sql("BEGIN;\n" + "\n".join(p.read_text() for p in paths) + "\nCOMMIT;")
    before = fingerprints()
    probe = (ROOT / "ops/standalone/check-document-upgrade.sql").read_text()
    checks = json.loads(sql(probe))
    assert fingerprints() == before, "Probe did not roll back"
    command(["docker", "restart", NAME])
    ready()
    assert json.loads(sql(probe)) == checks
    assert fingerprints() == before, "Restart probe did not roll back"
    print(json.dumps({"ok": True, "checks": checks, "restart": True, "tablesUnchanged": True}))
finally:
    if created:
        subprocess.run(["docker", "rm", "-fv", NAME], capture_output=True)
