#!/usr/bin/env python3
"""Real offline dump/restore under concurrent writes, preserving receipts and ACLs."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("backup", ROOT / "ops/standalone/database-backup.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
os.umask(0o077)
name = "mw-backup-source-qa-" + uuid.uuid4().hex[:12]
expected = {"environment": "dev", "instanceId": str(uuid.uuid4())}
created = False
try:
    b.run(["docker", "run", "-d", "--name", name, "--network", "none",
           "--label", "mw.environment=dev", "--label", "mw.purpose=backup-synthetic-source",
           "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=source", b.IMAGE])
    created = True
    b.ready(name)
    b.sql(name, "source", """
      CREATE ROLE anon;
      CREATE ROLE service_role;
      CREATE SCHEMA mw_private;
      REVOKE ALL ON SCHEMA mw_private FROM PUBLIC;
      CREATE TABLE mw_private.environment(identity jsonb NOT NULL);
      INSERT INTO mw_private.environment VALUES ('""" + json.dumps(expected) + """');
      CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
        SET search_path=mw_private,pg_temp AS $$ SELECT identity FROM mw_private.environment $$;
      REVOKE ALL ON FUNCTION public.mw_environment_identity() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.mw_environment_identity() TO service_role;
      CREATE TABLE products(id serial PRIMARY KEY,title text NOT NULL,excluded boolean NOT NULL);
      INSERT INTO products(title,excluded) VALUES ('[Учебный] Не возвращать',true);
      ALTER TABLE products ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON products TO anon;
      CREATE POLICY public_visible ON products FOR SELECT TO anon USING (NOT excluded);
      CREATE TABLE owner_only(id int PRIMARY KEY);
      GRANT SELECT ON owner_only TO service_role;
      REVOKE ALL ON owner_only FROM service_role;
      CREATE TABLE order_notifications(id int PRIMARY KEY,state text NOT NULL,attempts int NOT NULL);
      INSERT INTO order_notifications VALUES (1,'sent',1),(2,'uncertain',1),(3,'sending',1),(4,'pending',0);
      CREATE TABLE order_submissions(request uuid PRIMARY KEY,result jsonb NOT NULL);
      INSERT INTO order_submissions VALUES ('10000000-0000-4000-8000-000000000001','{"order":"saved"}');
      CREATE TABLE bot_pending_requests(request uuid PRIMARY KEY,result jsonb NOT NULL);
      INSERT INTO bot_pending_requests VALUES ('20000000-0000-4000-8000-000000000001','{"state":"canceled"}');
    """)
    b.validate_source(name, "source", expected)
    with tempfile.TemporaryDirectory(prefix="mw-backup-test-") as temporary:
        folder = Path(temporary)
        content = b.directory(folder / "content")
        with b.snapshot_session(name, "source", expected) as snap:
            tables = b.fingerprints(name, "source", snap["snapshot"])
            acl = b.security(name, "source", snap["snapshot"])
            sequence_acl = next(row[-1] for row in acl["tables"] if row[1] == "products_id_seq")
            assert {grant[2] for grant in sequence_acl} == {"SELECT", "UPDATE", "USAGE"}
            # Another connection commits after snapshot export, before pg_dump starts.
            b.sql(name, "source", "INSERT INTO products(title,excluded) VALUES ('[Учебный] Позднее',false);")
            assert b.fingerprints(name, "source")["public.products"]["rows"] == 2
            assert tables["public.products"]["rows"] == 1
            fd = os.open(content / "database.dump", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as out:
                b.run(["docker", "exec", name, "pg_dump", "-U", "postgres", "-d", "source", "-Fc",
                       "--snapshot=" + snap["snapshot"]], stdout=out)
        b.write(content / "roles.sql", b.run(["docker", "exec", name, "pg_dumpall", "-U", "postgres",
                                             "--roles-only", "--no-role-passwords"]))
        b.write(content / "restore.py", (ROOT / "ops/standalone/database-backup.py").read_bytes())
        b.write(content / "README.txt", b"Synthetic fixture only.")
        manifest = {"format": "masterweld-database-backup-v1", "identity": expected,
                    "snapshotTime": snap["time"], "tables": tables, "security": acl,
                    "files": {n: {"bytes": (content / n).stat().st_size, "sha256": b.digest(content / n)}
                              for n in b.FILES - {"manifest.json"}}}
        archive = b.make_archive(folder, manifest)
        # An extra grant must remain visible after ACL normalization.
        original_security = b.security(name, "source")
        b.sql(name, "source", "GRANT SELECT ON owner_only TO anon;")
        assert b.security(name, "source") != original_security
        b.sql(name, "source", "REVOKE SELECT ON owner_only FROM anon;")
        assert b.security(name, "source") == original_security
        baseline = b.fingerprints(name, "source")
        report = b.restore(archive, folder / "restored")
        assert report["restored"] and report["restartVerified"] and report["securityMatches"]
        assert report["allTableFingerprintsMatch"] and report["temporaryContainerRemoved"]
        assert baseline == b.fingerprints(name, "source")
        assert b.sql(name, "source", "SELECT count(*) FROM products") == "2"
        assert b.sql(name, "source", "SELECT count(*) FROM pg_stat_activity WHERE datname='source' AND state='idle in transaction'") == "0"
        # CLI restore also has no route to an existing DB. A second fresh restore must agree.
        output = b.run(["python3", str(ROOT / "ops/standalone/database-backup.py"), "restore",
                        str(archive), "--output", str(folder / "cli-restore")])
        assert json.loads(output)["archiveSha256"] == report["archiveSha256"]
        assert baseline == b.fingerprints(name, "source")
        print(json.dumps({"snapshotExcludesConcurrentCommit": True, "sourceUnchangedByRestore": True,
                          "notificationAndRequestStatesPreserved": True, "rowsAndSecurityMatch": True,
                          "restartVerified": True, "cliRestoreVerified": True,
                          "temporaryContainersRemoved": True}))
finally:
    if created:
        b.run(["docker", "rm", "-fv", name])
