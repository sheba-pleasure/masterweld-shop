"""Backup archive boundaries and failure handling, without real customer data."""
import fcntl
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("database_backup", Path(__file__).with_name("database-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.content = backup.directory(self.root / "content")
        for name in backup.FILES - {"manifest.json"}:
            backup.write(self.content / name, name.encode())
        self.manifest = {"format": "masterweld-database-backup-v1", "files": {
            name: {"bytes": (self.content / name).stat().st_size, "sha256": backup.digest(self.content / name)}
            for name in backup.FILES - {"manifest.json"}}}

    def tearDown(self):
        self.temp.cleanup()

    def test_roundtrip_and_private_modes(self):
        archive = backup.make_archive(self.root, self.manifest)
        result = backup.unpack(archive, self.root / "restored")
        self.assertEqual(result, self.manifest)
        for file in (self.root / "restored").iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_changed_file_hash_rejected(self):
        self.manifest["files"]["database.dump"]["sha256"] = "0" * 64
        archive = backup.make_archive(self.root, self.manifest)
        with self.assertRaisesRegex(RuntimeError, "BACKUP_FILE_HASH_MISMATCH"):
            backup.unpack(archive, self.root / "restored")

    def test_symlink_input_rejected(self):
        archive = backup.make_archive(self.root, self.manifest)
        link = self.root / "linked.tar.gz"
        link.symlink_to(archive)
        with self.assertRaisesRegex(RuntimeError, "BACKUP_PRIVATE_PATH_REQUIRED"):
            backup.unpack(link, self.root / "restored")

    def test_public_input_rejected(self):
        archive = backup.make_archive(self.root, self.manifest)
        archive.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "BACKUP_PRIVATE_PATH_REQUIRED"):
            backup.unpack(archive, self.root / "restored")

    def test_traversal_links_duplicates_and_oversize_rejected(self):
        for index, kind in enumerate(["traversal", "symlink", "duplicate", "oversize"]):
            archive = self.root / (kind + ".tar.gz")
            with tarfile.open(archive, "w:gz") as tar:
                for name in sorted(backup.FILES):
                    item = tarfile.TarInfo("../escape" if kind == "traversal" and name == "database.dump" else name)
                    item.size = 1
                    if kind == "symlink" and name == "database.dump":
                        item.type = tarfile.SYMTYPE
                        item.linkname = "/etc/passwd"
                        item.size = 0
                    tar.addfile(item, io.BytesIO(b"x"))
                if kind == "duplicate":
                    item = tarfile.TarInfo("database.dump")
                    tar.addfile(item)
            archive.chmod(0o600)
            with patch.object(backup, "LIMIT", 4 if kind == "oversize" else backup.LIMIT):
                with self.assertRaisesRegex(RuntimeError, "BACKUP_ARCHIVE_(MEMBERS_INVALID|TOO_LARGE)"):
                    backup.unpack(archive, self.root / ("restored" + str(index)))
        self.assertFalse((self.root.parent / "escape").exists())

    def test_foreign_database_refused_before_snapshot(self):
        with patch.object(backup, "inspect", return_value={"State": {"Running": True},
             "Config": {"Labels": {"mw.environment": "production"}}}), patch.object(backup, "sql") as query:
            with self.assertRaisesRegex(RuntimeError, "BACKUP_SOURCE_LABEL_MISMATCH"):
                backup.validate_source("any", "any", backup.DEV_ID)
            query.assert_not_called()
        with patch.object(backup, "inspect", return_value={"State": {"Running": True},
             "Config": {"Labels": {"mw.environment": "dev"}}}), patch.object(backup, "sql", return_value='{}'):
            with self.assertRaisesRegex(RuntimeError, "BACKUP_SOURCE_IDENTITY_MISMATCH"):
                backup.validate_source("any", "any", backup.DEV_ID)

    def test_snapshot_identifier_cannot_be_sql(self):
        with self.assertRaisesRegex(RuntimeError, "BACKUP_SNAPSHOT_INVALID"):
            backup.sql("any", "any", "SELECT 1", "x'; DROP TABLE products;--")

    def test_offsite_bad_download_never_restored_or_marked_verified(self):
        archive = backup.make_archive(self.root, self.manifest)
        calls = []
        def fake_bridge(*args):
            calls.append(args)
            if args[0] == "download":
                backup.write(args[2], b"wrong archive")
            return {}
        with patch.object(backup, "bridge", side_effect=fake_bridge), patch.object(backup, "restore") as restore:
            with self.assertRaisesRegex(RuntimeError, "BACKUP_DOWNLOAD_HASH_MISMATCH"):
                backup.offsite(archive, self.root, "dev", "unique")
            restore.assert_not_called()
        self.assertFalse((self.root / "offsite-result.json").exists())
        self.assertEqual([c[0] for c in calls], ["mkdir", "upload", "download"])

    def test_error_never_contains_provider_stderr(self):
        class Failure:
            returncode = 1
            stdout = b""
            stderr = b"secret OAuth/signed URL"
        with patch.object(backup.subprocess, "run", return_value=Failure()):
            with self.assertRaisesRegex(RuntimeError, "^BACKUP_COMMAND_FAILED$"):
                backup.run(["fake"])

    def test_second_backup_cannot_interleave(self):
        state = self.root / "ops/.state"
        state.mkdir(parents=True, mode=0o700)
        base = backup.directory(backup.directory(state / "database-backups") / "dev")
        with (base / "backup.lock").open("w") as lock:
            os.chmod(base / "backup.lock", 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(backup, "PROJECT", self.root):
                with self.assertRaisesRegex(RuntimeError, "BACKUP_ALREADY_RUNNING"):
                    backup.backup(self.root, "dev")

    def test_status_requires_recent_completed_download_restore(self):
        base = self.root / "ops/.state/database-backups/dev"
        base.mkdir(parents=True, mode=0o700)
        report = {"environment": "dev", "run": "test", "complete": True,
                  "snapshotTime": datetime.now(timezone.utc).isoformat(),
                  "offsite": {"restore": {"restored": True}}}
        path = base / "latest.json"
        for change, expected in [({}, True), ({"complete": False}, False), ({"offsite": None}, False),
                                  ({"snapshotTime": (datetime.now(timezone.utc)-timedelta(hours=27)).isoformat()}, False),
                                  ({"snapshotTime": (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()}, False)]:
            if path.exists():
                path.unlink()
            backup.write(path, json.dumps({**report, **change}).encode())
            with patch.object(backup, "PROJECT", self.root):
                self.assertEqual(backup.status("dev")["healthy"], expected)

    def test_installer_units_only_dev_and_committed_runner(self):
        spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-dev-backup.py"))
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        service, timer = installer.units(Path("/private/committed-sha/database-backup.py"))
        self.assertIn(b"/private/committed-sha/database-backup.py backup dev --offsite", service)
        self.assertNotIn(b"production", service)
        self.assertIn(b"Persistent=true", timer)
        self.assertIn(b"02:00:00 UTC", timer)
        self.assertIn(b"Restart=no", service)
        destination = self.root / "existing.service"
        backup.write(destination, b"other service")
        with self.assertRaisesRegex(RuntimeError, "BACKUP_INSTALL_EXISTING_FILE_CONFLICT"):
            installer.identical_file(destination, b"new service")
        self.assertEqual(destination.read_bytes(), b"other service")

    def test_restore_failure_cleans_only_new_container(self):
        archive = backup.make_archive(self.root, self.manifest)
        commands = []
        def fake_run(args, **kwargs):
            commands.append(args)
            return b""
        with patch.object(backup, "run", side_effect=fake_run), patch.object(backup, "inspect",
              return_value={"HostConfig": {"NetworkMode": "bridge", "PortBindings": {}}}):
            with self.assertRaisesRegex(RuntimeError, "BACKUP_RESTORE_NOT_ISOLATED"):
                backup.restore(archive, self.root / "recovery")
        removed = [c for c in commands if c[:3] == ["docker", "rm", "-fv"]]
        self.assertEqual(len(removed), 1)
        self.assertTrue(removed[0][-1].startswith("mw-backup-restore-"))


if __name__ == "__main__":
    unittest.main()
