"""Guards for private snapshot verification; no real Cloud data or Docker."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "cloud_snapshot", Path(__file__).with_name("verify-cloud-snapshot.py"))
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)


class CloudSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name) / "archives"
        self.base.mkdir(mode=0o700)
        self.folder = self.base / "synthetic"
        self.folder.mkdir(mode=0o700)
        self.original = snapshot.ARCHIVES
        snapshot.ARCHIVES = self.base
        self.manifest = {
            "format": "masterweld-cloud-application-snapshot-v1",
            "project_id": snapshot.PROJECT, "captured_at": "synthetic",
            "source_snapshot": "1:1:", "server_version": "17.test", "tables": [],
        }
        for table in snapshot.TABLES:
            raw = b'[{"id": 1}]'
            self.write(table + ".json", raw)
            self.manifest["tables"].append({
                "table_name": table, "payload_bytes": len(raw),
                "payload_md5": hashlib.md5(raw).hexdigest(), "row_count": 1,
                "captured_at": "synthetic", "source_snapshot": "1:1:",
            })
        self.metadata = {
            "tables": [{"table_name": table, "relkind": "r"} for table in snapshot.TABLES],
            "columns": [{"table_name": table, "column_name": "id"} for table in snapshot.TABLES],
        }
        self.save_manifest()
        self.save_metadata()

    def tearDown(self):
        snapshot.ARCHIVES = self.original
        self.temp.cleanup()

    def write(self, name, data):
        path = self.folder / name
        path.write_bytes(data)
        os.chmod(path, 0o600)

    def save_manifest(self):
        self.write("manifest.json", json.dumps(self.manifest).encode())

    def save_metadata(self):
        raw = json.dumps(self.metadata).encode()
        self.write("metadata.json", raw)
        self.write("metadata-manifest.json", json.dumps({
            "payload_bytes": len(raw), "payload_md5": hashlib.md5(raw).hexdigest(),
            "source_snapshot": "1:1:",
        }).encode())

    def test_verified_does_not_claim_restored(self):
        _, _, _, report = snapshot.verify(self.folder)
        self.assertTrue(report["verified"])
        self.assertFalse(report["restored"])
        self.assertEqual(len(report["tables"]), 8)

    def test_wrong_project(self):
        self.manifest["project_id"] = "unrelated-project"
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, "PROJECT_MISMATCH"):
            snapshot.verify(self.folder)

    def test_corrupt_payload_same_size(self):
        self.write("products.json", b'[{"id": 2}]')
        with self.assertRaisesRegex(RuntimeError, "HASH_MISMATCH_products"):
            snapshot.verify(self.folder)

    def test_wrong_count(self):
        self.manifest["tables"][0]["row_count"] = 2
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, "COUNT_MISMATCH_categories"):
            snapshot.verify(self.folder)

    def test_mixed_capture(self):
        self.manifest["tables"][0]["source_snapshot"] = "2:2:"
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, "MIXED_SNAPSHOTS"):
            snapshot.verify(self.folder)

    def test_metadata_from_different_snapshot_refused(self):
        path = self.folder / "metadata-manifest.json"
        metadata_manifest = json.loads(path.read_bytes())
        metadata_manifest["source_snapshot"] = "2:2:"
        self.write(path.name, json.dumps(metadata_manifest).encode())
        with self.assertRaisesRegex(RuntimeError, "MIXED_METADATA_SNAPSHOT"):
            snapshot.verify(self.folder)

    def test_duplicate_table_cannot_replace_missing_table(self):
        self.manifest["tables"][-1] = dict(self.manifest["tables"][0])
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, "TABLE_SET_MISMATCH"):
            snapshot.verify(self.folder)

    def test_world_readable_source_refused(self):
        os.chmod(self.folder / "staff.json", 0o644)
        with self.assertRaisesRegex(RuntimeError, "PRIVATE_PERMISSIONS_REQUIRED"):
            snapshot.verify(self.folder)

    def test_symlink_refused(self):
        path = self.folder / "shop_orders.json"
        path.unlink()
        path.symlink_to(self.folder / "products.json")
        with self.assertRaisesRegex(RuntimeError, "SYMLINK_REFUSED"):
            snapshot.verify(self.folder)

    def test_external_directory_refused(self):
        with self.assertRaisesRegex(RuntimeError, "ARCHIVE_PATH_REFUSED"):
            snapshot.verify(self.base)

    def test_additional_source_objects_refused(self):
        self.metadata["tables"].append({"table_name": "unknown", "relkind": "r"})
        self.save_metadata()
        with self.assertRaisesRegex(RuntimeError, "UNSUPPORTED_SOURCE_OBJECTS"):
            snapshot.verify(self.folder)

    def test_column_drift_refused(self):
        self.metadata["columns"].append({"table_name": "products", "column_name": "new_field"})
        self.save_metadata()
        with self.assertRaisesRegex(RuntimeError, "COLUMN_SET_MISMATCH_products"):
            snapshot.verify(self.folder)

    def fake_migration_tree(self):
        root = Path(self.temp.name) / "repository"
        (root / "drizzle/migrations").mkdir(parents=True)
        (root / "docs/migrations").mkdir(parents=True)
        for name in ("0003_order_status_and_events.sql", "0004_lock_shop_orders_insert.sql"):
            (root / "drizzle/migrations" / name).write_text("-- fixture")
        for number in range(5, 21):
            (root / "docs/migrations" / f"{number:04d}_fixture.sql").write_text("-- fixture")
        return root

    def test_future_migration_not_picked_up(self):
        root = self.fake_migration_tree()
        (root / "docs/migrations/0021_not_reviewed.sql").write_text("-- future")
        with patch.object(snapshot, "ROOT", root):
            paths = snapshot.migration_paths()
        self.assertEqual([int(p.name[:4]) for p in paths], list(range(3, 21)))

    def test_ambiguous_migration_rejected(self):
        root = self.fake_migration_tree()
        (root / "docs/migrations/0007_other.sql").write_text("-- ambiguous")
        with patch.object(snapshot, "ROOT", root):
            with self.assertRaisesRegex(RuntimeError, "MIGRATION_RANGE_AMBIGUOUS"):
                snapshot.migration_paths()

    def test_missing_technical_editor_migration_rejected(self):
        root = self.fake_migration_tree()
        (root / "docs/migrations/0020_fixture.sql").unlink()
        with patch.object(snapshot, "ROOT", root):
            with self.assertRaisesRegex(RuntimeError, "MIGRATION_RANGE_AMBIGUOUS"):
                snapshot.migration_paths()

    def test_missing_baseline_migration_rejected(self):
        root = self.fake_migration_tree()
        (root / "drizzle/migrations/0004_lock_shop_orders_insert.sql").unlink()
        with patch.object(snapshot, "ROOT", root):
            with self.assertRaisesRegex(RuntimeError, "MIGRATION_FILE_MISSING"):
                snapshot.migration_paths()

    def test_sql_identifier_quotes_untrusted_column(self):
        self.assertEqual(snapshot.identifier('name"; SELECT 1; --'), '"name""; SELECT 1; --"')

    def test_literal_preserves_quote_and_backslash(self):
        self.assertEqual(snapshot.literal("a'b\\c"), "'a''b\\c'")


if __name__ == "__main__":
    unittest.main()
