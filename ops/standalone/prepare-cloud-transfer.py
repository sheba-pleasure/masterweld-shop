#!/usr/bin/env python3
"""Prepare a private transfer review; optional import ONLY into an offline target copy.
No live destination argument exists. Historical orders/staff remain source evidence,
not active shop rows. This rehearsal is not an approved production import.
"""
import argparse
import csv
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("transfer_snapshot", Path(__file__).with_name("verify-cloud-snapshot.py"))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)
CATALOG = ("categories", "products", "product_costs", "product_photos")
COPY_TABLES = (*CATALOG, "telegram_updates")
REHEARSALS = ROOT / "ops/.state/production/rehearsals"
TRANSFERS = ROOT / "ops/.state/production/transfers"
PENDING = ("0014_assortment.sql", "0015_catalog_import.sql", "0016_telegram_bot_receipts.sql",
           "0017_technical_catalog.sql", "0018_technical_read_alias.sql",
           "0019_technical_editor_version.sql", "0020_technical_editor_sessions.sql",
           "0021_editor_exclusivity.sql", "0022_catalog_draft_results.sql",
           "0023_catalog_editor_previews.sql", "0024_pending_result_recovery.sql")


def require(value, code):
    if not value:
        raise RuntimeError(code)


def private_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def csv_bytes(columns, rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(columns)
    for row in rows:
        # Review files must not execute formulas when opened in spreadsheet software.
        writer.writerow("'" + str(value) if isinstance(value, str) and (value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r")))
                        else value for value in row)
    return ("\ufeff" + stream.getvalue()).encode()


def plan_rows(payloads):
    data = {table: json.loads(raw) for table, raw in payloads.items()}
    groups = {}
    for product in data["products"]:
        key = (product.get("sku") or "").strip().lower()
        if key:
            groups.setdefault(key, []).append(product["id"])
    duplicates = {key: ids for key, ids in groups.items() if len(ids) > 1}
    category_ids = {r["id"] for r in data["categories"]}
    product_ids = {r["id"] for r in data["products"]}
    require(len(category_ids) == len(data["categories"]), "DUPLICATE_CATEGORY_ID")
    require(len(product_ids) == len(data["products"]), "DUPLICATE_PRODUCT_ID")
    for row in data["categories"]:
        require(row.get("parent_id") is None or row["parent_id"] in category_ids, "CATEGORY_PARENT_MISSING")
    parents = {r["id"]: r.get("parent_id") for r in data["categories"]}
    for category in parents:
        seen = set()
        while category is not None:
            require(category not in seen, "CATEGORY_CYCLE")
            seen.add(category)
            category = parents[category]
    for row in data["products"]:
        require(row.get("category_id") is None or row["category_id"] in category_ids, "PRODUCT_CATEGORY_MISSING")
    for table in ("product_photos", "product_costs"):
        require(all(r["product_id"] in product_ids for r in data[table]), "ORPHAN_" + table.upper())
    products = []
    for row in data["products"]:
        key = (row.get("sku") or "").strip().lower()
        products.append([row["id"], row["id"], row["slug"], row.get("category_id"), row.get("sku"),
                         row["title"], row["status"], "review", "UNDECIDED",
                         "missing_sku" if not key else "duplicate_sku" if key in duplicates else ""])
    return data, products, {
        "categories": len(data["categories"]), "products": len(data["products"]),
        "photoRows": len(data["product_photos"]),
        "uniquePhotoUrls": len({r["url"] for r in data["product_photos"]}),
        "duplicateSkuGroups": len(duplicates),
        "missingSkuProducts": sum(not (p.get("sku") or "").strip() for p in data["products"]),
        "historicalOrders": len(data["shop_orders"]), "historicalStaff": len(data["staff"]),
        "legacyReceipts": len(data["telegram_updates"]),
        "ownerPresentInSource": any(r["telegram_id"] == 7540652678 for r in data["staff"]),
    }


def target_backup(report_path):
    require(report_path.parent.parent == REHEARSALS and report_path.resolve() == report_path,
            "TARGET_BACKUP_PATH_REFUSED")
    snapshot.private(REHEARSALS, True)
    snapshot.private(report_path.parent, True)
    report = snapshot.read_json(report_path)
    require(report["sourceSchema"] == "0000-0013" and report["sourceUnchanged"] is True
            and report["productionMigrationsApplied"] is False, "TARGET_BACKUP_SCOPE_MISMATCH")
    dump, roles = report_path.parent / "before.dump", report_path.parent / "roles.sql"
    for path, key in [(dump, "backupSha256"), (roles, "rolesSha256")]:
        snapshot.private(path)
        require(hashlib.sha256(path.read_bytes()).hexdigest() == report[key], "TARGET_BACKUP_HASH_MISMATCH")
    return dump.read_bytes(), roles.read_bytes(), report


def copy_sql(metadata, payloads):
    statements = ["BEGIN; SET LOCAL statement_timeout='60s';"]
    statements.append("""DO $empty$ DECLARE t text; populated boolean; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public'
        AND tablename NOT IN ('technical_units','technical_families','technical_attributes','technical_family_attributes')
      LOOP
        EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',t) INTO populated;
        IF populated THEN RAISE EXCEPTION 'INITIAL_TARGET_NOT_EMPTY'; END IF;
      END LOOP;
    END $empty$;
    CREATE SCHEMA mw_transfer_review;
    REVOKE ALL ON SCHEMA mw_transfer_review FROM PUBLIC,anon,authenticated,service_role;
    CREATE TABLE mw_transfer_review.source_payloads(
      table_name text PRIMARY KEY, payload jsonb NOT NULL, source_sha256 text NOT NULL);
    REVOKE ALL ON mw_transfer_review.source_payloads FROM PUBLIC,anon,authenticated,service_role;
    """)
    for table in snapshot.TABLES:
        raw = payloads[table]
        statements.append("INSERT INTO mw_transfer_review.source_payloads VALUES (" +
                          ",".join([snapshot.literal(table), snapshot.literal(raw) + "::jsonb",
                                    snapshot.literal(hashlib.sha256(raw.encode()).hexdigest())]) + ");")
    for table in COPY_TABLES:
        columns = [c["column_name"] for c in metadata["columns"] if c["table_name"] == table]
        require(columns, "MISSING_SOURCE_COLUMNS")
        names = ",".join(snapshot.identifier(c) for c in columns)
        statements.append("INSERT INTO public." + snapshot.identifier(table) + "(" + names + ") SELECT " + names +
                          " FROM jsonb_populate_recordset(NULL::public." + snapshot.identifier(table) + "," +
                          snapshot.literal(payloads[table]) + "::jsonb);")
    statements.append("COMMIT;")
    return "\n".join(statements)


def rehearse(evidence, manifest, metadata, payloads, backup_report):
    backup, roles, target_report = target_backup(backup_report)
    name = "mw-transfer-qa-" + uuid.uuid4().hex[:12]
    created = False
    def command(args, *, input=None, stdout=None, check=True):
        r = subprocess.run(args, input=input, stdout=stdout or subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=180)
        if check and r.returncode:
            private_write(evidence / ("failure-" + uuid.uuid4().hex[:8] + ".log"), r.stderr)
            raise RuntimeError("OFFLINE_TRANSFER_FAILED_PRIVATE_EVIDENCE")
        return r
    def sql(query, db="candidate"):
        return command(["docker", "exec", "-i", name, "psql", "-U", "postgres", "-d", db,
                        "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], input=("SET standard_conforming_strings=on; SET TIME ZONE 'UTC'; " + query).encode()).stdout.decode().strip()
    def ready():
        for _ in range(100):
            if command(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode == 0:
                return
            time.sleep(.2)
        raise RuntimeError("OFFLINE_TRANSFER_NOT_READY")
    def fingerprints(db):
        tables = json.loads(sql("""SELECT json_agg(json_build_array(schemaname,tablename)
          ORDER BY schemaname,tablename) FROM pg_tables
          WHERE schemaname IN ('public','mw_private','mw_transfer_review');""", db))
        return {schema + "." + table: sql(
            "SELECT count(*)||':'||md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) FROM " +
            snapshot.identifier(schema) + "." + snapshot.identifier(table) + " r;", db)
                for schema, table in tables}
    def verify_import(db):
        for table in COPY_TABLES:
            columns = [c["column_name"] for c in metadata["columns"] if c["table_name"] == table]
            digest = sql("SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) FROM (SELECT " +
                         ",".join(snapshot.identifier(c) for c in columns) + " FROM public." + snapshot.identifier(table) + ") r;", db)
            expected = next(r["payload_md5"] for r in manifest["tables"] if r["table_name"] == table)
            require(digest == expected, "IMPORTED_SOURCE_FIELDS_MISMATCH_" + table)
        archived = json.loads(sql("SELECT json_object_agg(table_name,md5(payload::text)) FROM mw_transfer_review.source_payloads;", db))
        require(archived == {r["table_name"]: r["payload_md5"] for r in manifest["tables"]},
                "ARCHIVED_SOURCE_FIELDS_MISMATCH")
        sql("""DO $check$ BEGIN
          IF EXISTS(SELECT 1 FROM staff) OR EXISTS(SELECT 1 FROM shop_orders)
            OR EXISTS(SELECT 1 FROM order_notifications) OR EXISTS(SELECT 1 FROM order_events)
            OR EXISTS(SELECT 1 FROM order_submissions) OR EXISTS(SELECT 1 FROM technical_cards)
            OR EXISTS(SELECT 1 FROM technical_editor_sessions)
            THEN RAISE EXCEPTION 'UNAPPROVED_OPERATIONAL_ROWS'; END IF;
          IF has_schema_privilege('anon','mw_transfer_review','USAGE')
            OR has_schema_privilege('service_role','mw_transfer_review','USAGE')
            OR has_table_privilege('anon','product_costs','SELECT')
            OR has_table_privilege('anon','shop_orders','SELECT')
            THEN RAISE EXCEPTION 'PRIVATE_IMPORT_DATA_EXPOSED'; END IF;
          IF EXISTS(SELECT 1 FROM products WHERE assortment_decision<>'review')
            THEN RAISE EXCEPTION 'ASSORTMENT_DECISION_INVENTED'; END IF;
        END $check$;""", db)
        published = sum(r["status"] == "published" for r in json.loads(payloads["products"]))
        require(sql("SET ROLE anon; SELECT count(*) FROM products;", db) == str(published), "CATALOG_READ_CHANGED")
        claims = sql("SET ROLE service_role; SELECT claim_telegram_bot_update(1,update_id,true) FROM telegram_updates;", db).splitlines()
        require(len(claims) == len(json.loads(payloads["telegram_updates"])) and all(v == "f" for v in claims),
                "LEGACY_REPLAY_BARRIER_LOST")
    try:
        image = json.loads(command(["docker", "image", "inspect", snapshot.IMAGE]).stdout)[0]
        command(["docker", "run", "-d", "--name", name, "--network", "none", "--label", "mw.environment=qa",
                 "--label", "mw.purpose=private-transfer-rehearsal", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                 "-e", "POSTGRES_DB=candidate", snapshot.IMAGE])
        created = True
        info = json.loads(command(["docker", "inspect", name]).stdout)[0]
        require(info["HostConfig"]["NetworkMode"] == "none" and not info["HostConfig"]["PortBindings"],
                "OFFLINE_TRANSFER_ISOLATION_FAILED")
        ready()
        role_sql, count = re.subn(rb"(?m)^CREATE ROLE postgres;\r?$", b"", roles)
        require(count == 1, "TARGET_ROLE_EXPORT_MISMATCH")
        sql(role_sql.decode())
        command(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres", "-d", "candidate",
                 "--single-transaction", "--exit-on-error"], input=backup)
        baseline = fingerprints("candidate")
        identity = json.loads(sql("SELECT mw_environment_identity();"))
        require(identity.get("environment") == "production", "TARGET_COPY_IDENTITY_MISMATCH")
        ledger = json.loads(sql("SELECT json_object_agg(path,sha256) FROM mw_private.schema_files;"))
        expected_paths = [ROOT / "drizzle/migrations" / name for name in
                          ("0000_staff_roles.sql", "0001_catalog.sql", "0002_create_shop_orders.sql")]
        expected_paths += [p for p in snapshot.migration_paths() if int(p.name[:4]) <= 13]
        expected_ledger = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in expected_paths}
        require(ledger == expected_ledger, "TARGET_BASELINE_LEDGER_MISMATCH")
        # Only this offline copy is upgraded. The real production target is never contacted.
        steps = []
        for filename in PENDING:
            path = ROOT / "docs/migrations" / filename
            relative = str(path.relative_to(ROOT))
            steps += [path.read_text(), "INSERT INTO mw_private.schema_files VALUES (" +
                      snapshot.literal(relative) + "," + snapshot.literal(hashlib.sha256(path.read_bytes()).hexdigest()) + ");"]
        sql("BEGIN;\n" + "\n".join(steps) + "\nCOMMIT;")
        source_types = metadata["exact_types"]
        for item in source_types:
            actual = sql("SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a WHERE a.attrelid=" +
                         snapshot.literal("public." + item["relname"]) + "::regclass AND a.attname=" +
                         snapshot.literal(item["attname"]) + ";")
            require(actual == item["data_type"], "TARGET_SOURCE_TYPE_MISMATCH")
        load = copy_sql(metadata, payloads)
        sql(load)
        verify_import("candidate")
        after = fingerprints("candidate")
        technical_sql = (ROOT / "ops/standalone/check-technical-upgrade.sql").read_text()
        technical = json.loads(sql(technical_sql))
        require(fingerprints("candidate") == after, "TECHNICAL_FIXTURES_NOT_ROLLED_BACK")
        # Initial import must refuse a second pass; it cannot resurrect later exclusions.
        duplicate = command(["docker", "exec", "-i", name, "psql", "-U", "postgres", "-d", "candidate",
                             "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], input=load.encode(), check=False)
        require(duplicate.returncode != 0 and b"INITIAL_TARGET_NOT_EMPTY" in duplicate.stderr,
                "INITIAL_IMPORT_REPLAY_ACCEPTED")
        require(fingerprints("candidate") == after, "REJECTED_IMPORT_CHANGED_DATA")
        dump_path = evidence / "candidate.dump"
        fd = os.open(dump_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            command(["docker", "exec", name, "pg_dump", "-U", "postgres", "-d", "candidate", "-Fc"], stdout=stream)
        for database, dump in [("roundtrip", dump_path.read_bytes()), ("rollbackcheck", backup)]:
            command(["docker", "exec", name, "createdb", "-U", "postgres", database])
            command(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres", "-d", database,
                     "--single-transaction", "--exit-on-error"], input=dump)
        verify_import("roundtrip")
        require(fingerprints("roundtrip") == after, "ROUNDTRIP_TARGET_CHANGED")
        require(fingerprints("rollbackcheck") == baseline, "RESTORED_BASELINE_CHANGED")
        command(["docker", "restart", name]); ready()
        verify_import("candidate"); verify_import("roundtrip")
        require(json.loads(sql(technical_sql, "candidate")) == technical and
                json.loads(sql(technical_sql, "roundtrip")) == technical, "TECHNICAL_RESTORE_CHANGED")
        require(fingerprints("candidate") == after and fingerprints("roundtrip") == after
                and fingerprints("rollbackcheck") == baseline, "RESTART_TARGET_CHANGED")
        return {"rehearsed": True, "schema": "0024", "offlineNetwork": "none", "ports": [],
                "catalogOriginalFieldsPreserved": True, "allSourceTablesArchivedPrivately": True,
                "technicalChecks": technical,
                "technicalChecksSha256": hashlib.sha256(technical_sql.encode()).hexdigest(),
                "activeStaffAndOrdersImported": False, "historicalNotifications": 0,
                "repeatImportRejected": True, "dumpRestoreRestartVerified": True,
                "rollbackCopyMatchesOriginalBackup": True, "liveProductionContacted": False,
                "sourceBackupSha256": target_report["backupSha256"], "imageId": image["Id"],
                "candidateDumpSha256": hashlib.sha256(dump_path.read_bytes()).hexdigest(),
                "migrationSha256": {str((ROOT / "docs/migrations" / f).relative_to(ROOT)):
                    hashlib.sha256((ROOT / "docs/migrations" / f).read_bytes()).hexdigest() for f in PENDING},
                "releaseReady": False}
    finally:
        if created:
            command(["docker", "rm", "-fv", name])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("--rehearse-target-backup", type=Path,
                        help="Private report.json of the already verified empty production backup; offline copies only")
    args = parser.parse_args()
    archive = Path(os.path.abspath(args.archive))
    manifest, metadata, payloads, verified = snapshot.verify(archive)
    data, products, counts = plan_rows(payloads)
    TRANSFERS.mkdir(parents=True, exist_ok=True, mode=0o700)
    snapshot.private(TRANSFERS, True)
    evidence = TRANSFERS / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    evidence.mkdir(mode=0o700)
    private_write(evidence / "products-review.csv", csv_bytes(
        ["source_id","proposed_same_id","slug","category_id","sku","title","source_status","assortment","launch_decision","issue"], products))
    private_write(evidence / "categories-map.csv", csv_bytes(["id","slug","parent_id"],
        [[r["id"],r["slug"],r.get("parent_id")] for r in data["categories"]]))
    private_write(evidence / "staff-review.csv", csv_bytes(["source_id","name","source_role","source_active","source_elevated","launch_decision"],
        [[r["telegram_id"],r["name"],r["role"],r["active"],r["elevated"],"UNDECIDED"] for r in data["staff"]]))
    private_write(evidence / "orders-review.csv", csv_bytes(["source_id","created_at","positions","total","launch_decision"],
        [[r["id"],r["created_at"],len(r["items"]),r["total"],"UNDECIDED"] for r in data["shop_orders"]]))
    private_write(evidence / "photos-map.csv", csv_bytes(["id","product_id","source_url","bytes_verified","target_url"],
        [[r["id"],r["product_id"],r["url"],False,""] for r in data["product_photos"]]))
    report = {"format":"masterweld-transfer-review-v1","sourceSnapshot":manifest["source_snapshot"],
              "sourceFiles":verified["tables"],"metadataSha256":verified["metadata_sha256"],
              "scriptSha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "counts":counts,"releaseReady":False,
              "decisions":{"catalog":"unresolved","staff":"unresolved","historicalOrders":"unresolved","media":"not_saved"},
              "scope":"Review files and optional offline candidate, never live import. CSV decisions are not executed.",
              "sourceRevision":subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()}
    if args.rehearse_target_backup:
        report["rehearsal"] = rehearse(evidence,manifest,metadata,payloads,args.rehearse_target_backup.absolute())
        report["temporaryContainerRemoved"] = True
    private_write(evidence / "report.json", (json.dumps(report,ensure_ascii=False,indent=2)+"\n").encode())
    print(json.dumps({"report":str(evidence / "report.json"),"counts":counts,
                      "rehearsed":bool(args.rehearse_target_backup),"releaseReady":False},ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        # No customer rows, URLs, SQL or credentials in ordinary output.
        code = str(exc) if isinstance(exc, RuntimeError) and re.fullmatch(r"[A-Z_]+",str(exc)) else "TRANSFER_PREPARATION_FAILED"
        print(json.dumps({"ok":False,"error":code}))
        raise SystemExit(1)
