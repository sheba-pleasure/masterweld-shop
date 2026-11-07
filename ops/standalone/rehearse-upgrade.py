#!/usr/bin/env python3
"""Restore the empty standalone production backup in an offline disposable PG, rehearse 0014-0031.
Never changes the source database, webhooks, app containers or release approvals.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/production"))
from preflight import read_env, schema_errors  # noqa: E402

SOURCE = "mw-prod-db"
DB = "masterweld_production"
PENDING = ("0014_assortment.sql", "0015_catalog_import.sql", "0016_telegram_bot_receipts.sql",
           "0017_technical_catalog.sql", "0018_technical_read_alias.sql",
           "0019_technical_editor_version.sql", "0020_technical_editor_sessions.sql",
           "0021_editor_exclusivity.sql", "0022_catalog_draft_results.sql",
           "0023_catalog_editor_previews.sql", "0024_pending_result_recovery.sql",
           "0025_pending_preview_requests.sql", "0026_document_intake.sql",
           "0027_document_review.sql", "0028_document_structure.sql",
           "0029_document_model_review.sql", "0030_document_model_import_links.sql",
           "0031_document_model_conflicts.sql")


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, timeout=120, **kwargs)
    if result.returncode:
        raise ValueError("REHEARSAL_COMMAND_FAILED:" + args[0])
    return result.stdout


def sql(container, query):
    return run(["docker", "exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", DB,
                "-Atq", "-v", "ON_ERROR_STOP=1"], input=query.encode()).decode().strip()


def identity(container):
    return json.loads(sql(container, "SELECT public.mw_environment_identity();"))


def fingerprint(container):
    tables = sql(container, """SELECT schemaname||'.'||tablename FROM pg_tables
        WHERE schemaname IN ('public','mw_private') ORDER BY schemaname,tablename;""").splitlines()
    result = {}
    for table in tables:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*", table):
            raise ValueError("UNEXPECTED_TABLE_NAME")
        result[table] = sql(container, "SELECT count(*)||':'||md5(coalesce(string_agg(row_to_json(t)::text,"
                          " E'\\n' ORDER BY row_to_json(t)::text),'')) FROM " + table + " t;")
    return result


def private_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def wait_ready(name):
    for _ in range(60):
        if subprocess.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                          capture_output=True).returncode == 0:
            return
        time.sleep(.3)
    raise ValueError("RESTORE_DATABASE_NOT_READY")


def main():
    env = read_env(ROOT / "ops/.secrets/production/database.env")
    expected_identity = {"environment": "production", "instanceId": env["MW_INSTANCE_ID"]}
    source = json.loads(run(["docker", "inspect", SOURCE]))[0]
    if source["Config"]["Labels"].get("mw.environment") != "production" or identity(SOURCE) != expected_identity:
        raise ValueError("SOURCE_IDENTITY_MISMATCH")
    before = fingerprint(SOURCE)
    # Explicit scope: prepared empty production, never an implicit export of real customer data.
    if any(not value.startswith("0:") for table, value in before.items() if table.startswith("public.")):
        raise ValueError("SOURCE_NOT_EMPTY_REQUIRES_SEPARATE_REVIEW")
    paths = sorted((ROOT / "drizzle/migrations").glob("*.sql")) + sorted((ROOT / "docs/migrations").glob("*.sql"))
    hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    ledger = json.loads(sql(SOURCE, "SELECT json_agg(s) FROM mw_private.schema_files s;"))
    if schema_errors(ledger, hashes) != sorted("MIGRATION_MISSING:docs/migrations/" + f for f in PENDING):
        raise ValueError("SOURCE_SCHEMA_REQUIRES_REVIEW")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    folder = ROOT / "ops/.state/production/rehearsals" / stamp
    folder.mkdir(parents=True, mode=0o700)
    # Parent is a local artifact directory, not a public website or Git path.
    if folder.is_symlink() or folder.stat().st_uid != os.getuid() or folder.stat().st_mode & 0o077:
        raise ValueError("PRIVATE_ARTIFACT_DIRECTORY_REQUIRED")
    backup = run(["docker", "exec", SOURCE, "pg_dump", "-U", "postgres", "-d", DB, "-Fc"])
    private_write(folder / "before.dump", backup)
    roles = run(["docker", "exec", SOURCE, "pg_dumpall", "-U", "postgres", "--roles-only", "--no-role-passwords"])
    private_write(folder / "roles.sql", roles)
    name = "mw-production-rehearsal-" + uuid.uuid4().hex[:12]
    created = False
    try:
        run(["docker", "run", "-d", "--name", name, "--network", "none",
             "--label", "mw.environment=qa", "--label", "mw.purpose=production-migration-rehearsal",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=" + DB, "postgres:17.6-alpine"])
        created = True
        wait_ready(name)
        # The fresh cluster already owns the postgres role. Restore all other role definitions
        # plus postgres attributes from the password-free export; no source passwords are copied.
        role_sql, replaced = re.subn(rb"(?m)^CREATE ROLE postgres;\r?$", b"", roles)
        if replaced != 1:
            raise ValueError("POSTGRES_ROLE_EXPORT_UNEXPECTED")
        sql(name, role_sql.decode())
        run(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres", "-d", DB,
             "--exit-on-error", "--single-transaction"], input=backup)
        if fingerprint(name) != before or identity(name) != expected_identity:
            raise ValueError("RESTORE_FINGERPRINT_MISMATCH")
        statements = []
        for filename in PENDING:
            path = ROOT / "docs/migrations" / filename
            relative = str(path.relative_to(ROOT))
            statements.append(path.read_text())
            statements.append("INSERT INTO mw_private.schema_files VALUES ('" + relative + "','" + hashes[relative] + "');")
        sql(name, "BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;")
        restored_ledger = json.loads(sql(name, "SELECT json_agg(s) FROM mw_private.schema_files s;"))
        if schema_errors(restored_ledger, hashes):
            raise ValueError("REHEARSED_SCHEMA_MISMATCH")
        after = fingerprint(name)
        for table, value in before.items():
            if table != "mw_private.schema_files" and after.get(table) != value:
                raise ValueError("RESTORED_DATA_CHANGED")
        technical_sql = (ROOT / "ops/standalone/check-technical-upgrade.sql").read_text()
        technical = json.loads(sql(name, technical_sql))
        document_sql = (ROOT / "ops/standalone/check-document-upgrade.sql").read_text()
        documents = json.loads(sql(name, document_sql))
        if fingerprint(name) != after:
            raise ValueError("REHEARSAL_FIXTURES_NOT_ROLLED_BACK")
        first_claim = sql(name, """DO $$ BEGIN
          IF has_table_privilege('anon','shop_orders','INSERT')
             OR has_table_privilege('service_role','shop_orders','INSERT')
          THEN RAISE EXCEPTION 'DIRECT_INSERT_OPEN'; END IF;
          IF has_function_privilege('anon','public.claim_telegram_bot_update(bigint,bigint,boolean)','EXECUTE')
          THEN RAISE EXCEPTION 'PUBLIC_CLAIM_OPEN'; END IF;
        END $$;
        SET ROLE service_role;
        SELECT public.claim_telegram_bot_update(1,42,true);""")
        if first_claim != "t":
            raise ValueError("INITIAL_RECEIPT_CLAIM_FAILED")
        if sql(name, "SET ROLE service_role; SELECT public.claim_telegram_bot_update(1,42,true);") != "f":
            raise ValueError("REPLAY_BARRIER_FAILED")
        before_restart = fingerprint(name)
        run(["docker", "restart", name])
        wait_ready(name)
        if identity(name) != expected_identity:
            raise ValueError("RESTART_IDENTITY_MISMATCH")
        if sql(name, "SET ROLE service_role; SELECT public.claim_telegram_bot_update(1,42,true);") != "f":
            raise ValueError("RESTART_REPLAY_BARRIER_FAILED")
        if json.loads(sql(name, technical_sql)) != technical:
            raise ValueError("TECHNICAL_RESTART_MISMATCH")
        if json.loads(sql(name, document_sql)) != documents:
            raise ValueError("DOCUMENT_RESTART_MISMATCH")
        if fingerprint(name) != before_restart:
            raise ValueError("RESTART_FIXTURES_NOT_ROLLED_BACK")
        if fingerprint(SOURCE) != before:
            raise ValueError("SOURCE_CHANGED_DURING_REHEARSAL")
        report = {
            "scope": "Empty standalone production only. Not Cloud export or off-site recovery.",
            "backup": str((folder / "before.dump").relative_to(ROOT)),
            "backupSha256": hashlib.sha256(backup).hexdigest(),
            "rolesSha256": hashlib.sha256(roles).hexdigest(),
            "sourceUnchanged": True, "restoredInSeparateOfflineCluster": True,
            "sourceSchema": "0000-0013", "rehearsedSchema": "0000-0031",
            "technicalChecks": technical,
            "documentChecks": documents,
            "documentChecksSha256": hashlib.sha256(document_sql.encode()).hexdigest(),
            "technicalChecksSha256": hashlib.sha256(technical_sql.encode()).hexdigest(),
            "migrations": {f: hashes["docs/migrations/" + f] for f in PENDING},
            "existingTableFingerprintsPreserved": True, "directOrderInsertClosed": True,
            "receiptSurvivesRestart": True, "productionMigrationsApplied": False,
            "sourceRevision": run(["git", "rev-parse", "HEAD"]).decode().strip(),
            "sourceTreeDirty": bool(run(["git", "status", "--porcelain"])),
            "scriptSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
        }
    finally:
        if created:
            run(["docker", "rm", "-fv", name])
    report["temporaryContainerRemoved"] = True
    private_write(folder / "report.json", json.dumps(report, indent=2).encode())
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired) as error:
        # Only our uppercase error codes may be shown; provider details stay private.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]+(?::docker)?", str(error)) else "REHEARSAL_FAILED_NO_APPROVAL"
        print(json.dumps({"ok": False, "error": code}))
        raise SystemExit(1)
