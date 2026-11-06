#!/usr/bin/env python3
"""Verify a private Cloud application snapshot; optionally rehearse offline restore.

Never connects to Cloud, DEV or production. The optional Docker databases have no
network or published ports. Source application rows are not printed. This is not
a full provider backup, and the legacy schema is never suitable for public use.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
ARCHIVES = ROOT / "ops/.state/production/cloud-export"
PROJECT = "ab84e929-8a04-4ce0-a95a-8f14b6f9f3fe"
TABLES = ("categories", "products", "product_costs", "product_photos",
          "staff", "staff_audit_log", "telegram_updates", "shop_orders")
IMAGE = "postgres:17.6-alpine"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def private(path, directory=False):
    mode = path.lstat()
    require(not stat.S_ISLNK(mode.st_mode), "SYMLINK_REFUSED")
    require(mode.st_uid == os.getuid(), "OWNER_MISMATCH")
    require(stat.S_ISDIR(mode.st_mode) if directory else stat.S_ISREG(mode.st_mode),
            "WRONG_FILE_KIND")
    require(stat.S_IMODE(mode.st_mode) == (0o700 if directory else 0o600),
            "PRIVATE_PERMISSIONS_REQUIRED")


def read_json(path):
    private(path)
    return json.loads(path.read_bytes())


def verify(folder):
    require(folder.parent == ARCHIVES and folder.resolve() == folder, "ARCHIVE_PATH_REFUSED")
    private(ARCHIVES, True)
    private(folder, True)
    manifest = read_json(folder / "manifest.json")
    require(manifest["format"] == "masterweld-cloud-application-snapshot-v1", "FORMAT_MISMATCH")
    require(manifest["project_id"] == PROJECT, "PROJECT_MISMATCH")
    rows = manifest["tables"]
    require(len(rows) == len(TABLES) and {r["table_name"] for r in rows} == set(TABLES),
            "TABLE_SET_MISMATCH")
    payloads, checks = {}, {}
    for entry in rows:
        name = entry["table_name"]
        path = folder / (name + ".json")
        private(path)
        raw = path.read_bytes()
        require(len(raw) == entry["payload_bytes"], "SIZE_MISMATCH_" + name)
        require(hashlib.md5(raw).hexdigest() == entry["payload_md5"], "HASH_MISMATCH_" + name)
        values = json.loads(raw)
        require(isinstance(values, list) and len(values) == entry["row_count"], "COUNT_MISMATCH_" + name)
        require(all(isinstance(v, dict) for v in values), "ROW_SHAPE_MISMATCH_" + name)
        require(entry["captured_at"] == manifest["captured_at"]
                and entry["source_snapshot"] == manifest["source_snapshot"], "MIXED_SNAPSHOTS")
        payloads[name] = raw.decode("utf-8")
        checks[name] = {"rows": len(values), "sha256": hashlib.sha256(raw).hexdigest(),
                        "source_md5": entry["payload_md5"], "bytes": len(raw)}
    metadata_manifest = read_json(folder / "metadata-manifest.json")
    require(metadata_manifest["source_snapshot"] == manifest["source_snapshot"], "MIXED_METADATA_SNAPSHOT")
    private(folder / "metadata.json")
    raw = (folder / "metadata.json").read_bytes()
    require(len(raw) == metadata_manifest["payload_bytes"]
            and hashlib.md5(raw).hexdigest() == metadata_manifest["payload_md5"],
            "METADATA_HASH_MISMATCH")
    metadata = json.loads(raw)
    require({r["table_name"] for r in metadata["tables"]} == set(TABLES)
            and all(r["relkind"] == "r" for r in metadata["tables"]), "UNSUPPORTED_SOURCE_OBJECTS")
    for name in TABLES:
        fields = {c["column_name"] for c in metadata["columns"] if c["table_name"] == name}
        require(all(set(v) == fields for v in json.loads(payloads[name])), "COLUMN_SET_MISMATCH_" + name)
    report = {
        "scope": "Eight public application tables only. Not a full Cloud/provider backup or media/off-site backup.",
        "verified": True, "restored": False, "source_snapshot": manifest["source_snapshot"],
        "captured_at": manifest["captured_at"], "source_postgres": manifest["server_version"],
        "metadata_snapshot": metadata_manifest["source_snapshot"],
        "metadata_sha256": hashlib.sha256(raw).hexdigest(), "tables": checks,
        "excluded": ["auth rows and provider internals", "cluster roles/passwords", "WAL/PITR",
                     "media file bytes", "off-site copy"],
    }
    return manifest, metadata, payloads, report


def literal(value):
    # standard_conforming_strings is explicitly enabled for each psql connection.
    return "'" + value.replace("'", "''") + "'"


def migration_paths():
    """An explicit reviewed range; never silently pick up a future migration."""
    paths = [ROOT / "drizzle/migrations" / name for name in (
        "0003_order_status_and_events.sql", "0004_lock_shop_orders_insert.sql")]
    for number in range(5, 22):
        matches = list((ROOT / "docs/migrations").glob(f"{number:04d}_*.sql"))
        require(len(matches) == 1, "MIGRATION_RANGE_AMBIGUOUS")
        paths.append(matches[0])
    require(all(path.is_file() and not path.is_symlink() for path in paths), "MIGRATION_FILE_MISSING")
    return paths


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def restore(folder, manifest, metadata, payloads, report, upgrade=False):
    suffix = uuid.uuid4().hex[:12]
    name, volume = "mw-cloud-restore-" + suffix, "mw-cloud-restore-data-" + suffix
    label = "mw.cloud-restore=" + suffix
    evidence = folder / ("restore-" + suffix)
    evidence.mkdir(mode=0o700)
    steps = []

    def command(args, *, input=None, stdout=None, check=True):
        result = subprocess.run(args, input=input, stdout=stdout or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=180)
        if check and result.returncode:
            # SQL diagnostics can contain source rows. Keep them private, never print them.
            path = evidence / ("failure-" + str(len(steps)) + ".log")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(result.stderr)
            raise RuntimeError("OFFLINE_RESTORE_COMMAND_FAILED; private evidence: " + str(evidence))
        return result

    def sql(query, database="archive"):
        result = command(["docker", "exec", "-i", name, "psql", "-h", "127.0.0.1",
                          "-U", "postgres", "-d", database, "-X", "-Atq", "-v", "ON_ERROR_STOP=1"],
                         input=("SET standard_conforming_strings=on; SET TIME ZONE 'UTC'; " + query).encode())
        return result.stdout.decode().strip()

    def ready():
        for _ in range(100):
            result = command(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1",
                              "-U", "postgres", "-d", "archive"], check=False)
            if result.returncode == 0:
                return
            time.sleep(.2)
        raise RuntimeError("OFFLINE_POSTGRES_NOT_READY")

    def compare(database, original_columns_only=False):
        found = {}
        for table in TABLES:
            source = "public." + table
            if original_columns_only:
                columns = [c["column_name"] for c in metadata["columns"] if c["table_name"] == table]
                source = "(SELECT " + ",".join(identifier(c) for c in columns) + " FROM " + source + ")"
            value = json.loads(sql(
                "SELECT json_build_object('rows',count(*),'md5',"
                "md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'))) "
                "FROM " + source + " t", database))
            entry = next(r for r in manifest["tables"] if r["table_name"] == table)
            require(value == {"rows": entry["row_count"], "md5": entry["payload_md5"]},
                    "RESTORED_FINGERPRINT_MISMATCH_" + table)
            found[table] = value
        return found

    def upgrade_checks(database):
        compare(database, original_columns_only=True)
        facts = json.loads(sql("""
            SELECT json_build_object(
              'historical_notifications',(SELECT count(*) FROM order_notifications),
              'historical_submissions',(SELECT count(*) FROM order_submissions),
              'historical_order_events',(SELECT count(*) FROM order_events),
              'new_bot_receipts',(SELECT count(*) FROM telegram_bot_updates),
              'orders_with_default_new_status',(SELECT count(*) FROM shop_orders WHERE status='new'),
              'products_pending_assortment_review',(SELECT count(*) FROM products WHERE assortment_decision='review'),
              'published_products',(SELECT count(*) FROM products WHERE status='published'),
              'direct_order_insert_open',(
                has_table_privilege('anon','shop_orders','INSERT')
                OR has_table_privilege('authenticated','shop_orders','INSERT')
                OR has_table_privilege('service_role','shop_orders','INSERT')),
              'public_order_read_open',(
                has_table_privilege('anon','shop_orders','SELECT')
                OR has_table_privilege('authenticated','shop_orders','SELECT')),
              'service_can_recreate_notifications',(
                has_table_privilege('service_role','order_notifications','DELETE')
                OR has_table_privilege('service_role','order_notifications','TRUNCATE')
                OR has_table_privilege('service_role','order_notifications','INSERT')),
              'public_security_definer_execute',(
                SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.prosecdef
                AND p.oid<>'public.public_product_technical(uuid)'::regprocedure AND (
                  has_function_privilege('anon',p.oid,'EXECUTE')
                  OR has_function_privilege('authenticated',p.oid,'EXECUTE')))
            );
        """, database))
        for field in ("historical_notifications", "historical_submissions", "historical_order_events",
                      "new_bot_receipts", "public_security_definer_execute"):
            require(facts[field] == 0, "UPGRADE_UNEXPECTED_" + field.upper())
        for field in ("direct_order_insert_open", "public_order_read_open", "service_can_recreate_notifications"):
            require(facts[field] is False, "UPGRADE_" + field.upper())
        expected_orders = next(e["row_count"] for e in manifest["tables"] if e["table_name"] == "shop_orders")
        expected_products = next(e["row_count"] for e in manifest["tables"] if e["table_name"] == "products")
        require(facts["orders_with_default_new_status"] == expected_orders, "LEGACY_ORDER_STATUS_UNEXPECTED")
        require(facts["products_pending_assortment_review"] == expected_products, "ASSORTMENT_DECISION_CHANGED")
        published = sum(p["status"] == "published" for p in json.loads(payloads["products"]))
        require(facts["published_products"] == published, "PUBLIC_CATALOG_CHANGED")
        visible = sql("SET ROLE anon; SELECT count(*) FROM products;", database)
        require(visible == str(published), "PUBLIC_CATALOG_RLS_CHANGED")
        receipt_results = sql("""SET ROLE service_role;
            SELECT public.claim_telegram_bot_update(1,update_id,true) FROM telegram_updates;
        """, database).splitlines()
        require(len(receipt_results) == next(e["row_count"] for e in manifest["tables"]
                                            if e["table_name"] == "telegram_updates")
                and all(value == "f" for value in receipt_results), "LEGACY_RECEIPT_BARRIER_FAILED")
        require(sql("SET ROLE service_role; SELECT count(*) FROM claim_order_notification();", database) == "0",
                "HISTORICAL_NOTIFICATION_CLAIMED")
        technical = json.loads(sql((ROOT / "ops/standalone/check-technical-upgrade.sql").read_text(), database))
        facts["technical_upgrade"] = technical
        compare(database, original_columns_only=True)
        return facts

    volume_created = container_created = False
    try:
        # Use the same local major/minor image as the existing isolated tests; never pull implicitly.
        image = json.loads(command(["docker", "image", "inspect", IMAGE]).stdout)[0]
        command(["docker", "volume", "create", "--label", label, volume])
        volume_created = True
        command(["docker", "create", "--name", name, "--label", label, "--network", "none",
                 "--mount", "type=volume,src=" + volume + ",dst=/var/lib/postgresql/data",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=archive", IMAGE])
        container_created = True
        details = json.loads(command(["docker", "inspect", name]).stdout)[0]
        require(details["HostConfig"]["NetworkMode"] == "none"
                and not details["HostConfig"]["PortBindings"], "ISOLATION_MISMATCH")
        command(["docker", "start", name])
        ready()
        steps.append("isolated_postgres_ready")
        sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;")
        schema_files = [ROOT / "drizzle/migrations" / f for f in
                        ("0000_staff_roles.sql", "0001_catalog.sql", "0002_create_shop_orders.sql")]
        for path in schema_files:
            sql(path.read_text())
        steps.append("known_legacy_schema_created")
        actual = json.loads(sql("""SELECT json_agg(row_to_json(s)) FROM (
            SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS data_type
            FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
            ORDER BY c.relname,a.attnum) s"""))
        require(actual == metadata["exact_types"], "SOURCE_TYPES_DO_NOT_MATCH_KNOWN_SCHEMA")
        actual_constraints = json.loads(sql("""SELECT json_agg(row_to_json(s)) FROM (
            SELECT c.relname,con.conname,con.contype,con.convalidated,
                   pg_get_constraintdef(con.oid) AS definition
            FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
            ORDER BY c.relname,con.conname) s"""))
        require(actual_constraints == metadata["constraints"], "SOURCE_CONSTRAINTS_MISMATCH")
        statements = ["BEGIN;"]
        for table in TABLES:
            statements.append("INSERT INTO public." + table
                              + " SELECT * FROM jsonb_populate_recordset(NULL::public."
                              + table + ", " + literal(payloads[table]) + "::jsonb);")
        statements.append("COMMIT;")
        sql("\n".join(statements))
        initial = compare("archive")
        steps.append("all_source_rows_restored_and_fingerprints_matched")
        dump = evidence / "application.dump"
        fd = os.open(dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as out:
            command(["docker", "exec", name, "pg_dump", "-U", "postgres",
                     "-d", "archive", "-Fc"], stdout=out)
        command(["docker", "exec", name, "createdb", "-U", "postgres", "roundtrip"])
        command(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres",
                 "-d", "roundtrip", "--exit-on-error", "--single-transaction"], input=dump.read_bytes())
        compare("roundtrip")
        steps.append("custom_dump_restored_to_second_database")
        command(["docker", "restart", name])
        ready()
        compare("archive")
        compare("roundtrip")
        steps.append("both_databases_preserved_after_restart")
        if upgrade:
            command(["docker", "exec", name, "createdb", "-U", "postgres", "upgrade"])
            command(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres",
                     "-d", "upgrade", "--exit-on-error", "--single-transaction"], input=dump.read_bytes())
            # Match the independent target bootstrap. Never replay Cloud grants or provider roles.
            sql("""REVOKE CREATE ON SCHEMA public FROM PUBLIC;
                GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
                ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
            """, "upgrade")
            paths = migration_paths()
            sql("BEGIN;\n" + "\n".join(path.read_text() for path in paths) + "\nCOMMIT;", "upgrade")
            facts = upgrade_checks("upgrade")
            steps.append("0003_0021_applied_only_to_offline_copy")
            upgraded_dump = evidence / "upgraded-application.dump"
            fd = os.open(upgraded_dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as out:
                command(["docker", "exec", name, "pg_dump", "-U", "postgres", "-d", "upgrade", "-Fc"], stdout=out)
            command(["docker", "exec", name, "createdb", "-U", "postgres", "upgrade_roundtrip"])
            command(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres",
                     "-d", "upgrade_roundtrip", "--exit-on-error", "--single-transaction"],
                    input=upgraded_dump.read_bytes())
            upgrade_checks("upgrade_roundtrip")
            command(["docker", "restart", name])
            ready()
            require(upgrade_checks("upgrade") == facts and upgrade_checks("upgrade_roundtrip") == facts,
                    "UPGRADE_RESTART_FACTS_CHANGED")
            compare("archive")
            compare("roundtrip")
            steps.append("upgraded_dump_restore_restart_and_legacy_fields_verified")
            report["upgrade"] = {
                "rehearsed_schema": "0000-0021",
                "technical_checks_sha256": hashlib.sha256((ROOT / "ops/standalone/check-technical-upgrade.sql").read_bytes()).hexdigest(),
                "migration_sha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                     for p in paths},
                "source_fields_and_staff_preserved": True,
                "checks": facts, "legacy_receipt_barrier_preserved": True,
                "upgraded_dump": str(upgraded_dump.relative_to(folder)),
                "upgraded_dump_sha256": hashlib.sha256(upgraded_dump.read_bytes()).hexdigest(),
                "source_cloud_acl_replayed": False,
                "production_import_performed": False,
                "requires_review": "Legacy orders receive technical status new; this does not mean new "
                                   "customer demand. Staff identities/rights and assortment remain unapproved "
                                   "for the independent production shop.",
                "scope_limit": "Data-model upgrade on a private copy, not import into the prepared live "
                               "production database. No identity guard or Telegram worker was bypassed.",
            }
        report.update({
            "restored": True, "steps": steps, "target_postgres": sql("SHOW server_version"),
            "target_image_id": image["Id"], "target_network": "none", "published_ports": [],
            "application_dump": str(dump.relative_to(folder)),
            "application_dump_sha256": hashlib.sha256(dump.read_bytes()).hexdigest(),
            "legacy_schema_files": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in schema_files},
            "restored_fingerprints": initial,
            "verifier_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "schema_limit": "Known repository 0000-0002, matching source column types and constraints. "
                            "Cloud role grants/provider functions are not replicated. Legacy order INSERT "
                            "policy remains in this private dump: NEVER expose or deploy it.",
            "roles_for_dump_restore": ["anon NOLOGIN", "authenticated NOLOGIN", "service_role NOLOGIN BYPASSRLS"],
        })
    finally:
        # Only the resources created with this invocation's unpredictable names are removed.
        if container_created:
            command(["docker", "rm", "-f", name])
        if volume_created:
            command(["docker", "volume", "rm", volume])
    report["temporary_container_and_volume_removed"] = True
    path = evidence / "report.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(report, out, ensure_ascii=False, indent=2)
        out.write("\n")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", help="Private immediate subdirectory of ops/.state/production/cloud-export")
    parser.add_argument("--restore", action="store_true", help="Restore only into disposable no-network Docker databases")
    parser.add_argument("--upgrade", action="store_true", help="Also rehearse the reviewed 0003-0021 range on another offline copy; requires --restore")
    args = parser.parse_args()
    require(not args.upgrade or args.restore, "UPGRADE_REQUIRES_RESTORE")
    folder = Path(os.path.abspath(args.archive))
    manifest, metadata, payloads, report = verify(folder)
    if args.restore:
        result = restore(folder, manifest, metadata, payloads, report, upgrade=args.upgrade)
        print(json.dumps({"verified": True, "restored": True, "report": str(result),
                          "temporary_resources_removed": True}))
    else:
        print(json.dumps({"verified": True, "restored": False, "tables": {
            name: value["rows"] for name, value in report["tables"].items()}}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        # No raw database rows or subprocess arguments are exposed.
        if isinstance(error, RuntimeError):
            print(str(error), file=__import__("sys").stderr)
        else:
            print("SNAPSHOT_VERIFICATION_FAILED: " + type(error).__name__, file=__import__("sys").stderr)
        raise SystemExit(1)
