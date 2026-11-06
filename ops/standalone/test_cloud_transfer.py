"""Offline transfer guards with synthetic data; never contact live systems."""
import copy
import csv
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "cloud_transfer", Path(__file__).with_name("prepare-cloud-transfer.py"))
transfer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transfer)


class CloudTransferTest(unittest.TestCase):
    def setUp(self):
        self.data = {table: [] for table in transfer.snapshot.TABLES}
        self.data["categories"] = [
            {"id": "parent", "slug": "parent", "parent_id": None},
            {"id": "child", "slug": "child", "parent_id": "parent"},
        ]
        self.data["products"] = [
            {"id": "one", "slug": "first", "category_id": "parent", "sku": "001",
             "title": "Первый", "status": "published"},
            {"id": "two", "slug": "second", "category_id": "child", "sku": " 001 ",
             "title": "Второй", "status": "draft"},
            {"id": "three", "slug": "third", "category_id": None, "sku": None,
             "title": "Третий", "status": "published"},
        ]
        self.data["product_photos"] = [{"id": "photo", "product_id": "one", "url": "https://example.com/1.jpg"}]
        self.data["staff"] = [{"telegram_id": 7540652678, "name": "Учебный владелец", "role": "admin",
                               "active": True, "elevated": True}]
        self.data["shop_orders"] = [{"id": "old-order", "items": [], "created_at": "2026-10-22", "total": 0}]

    def payloads(self):
        return {table: json.dumps(rows) for table, rows in self.data.items()}

    def test_identifiers_preserved_without_merging_skus(self):
        original = copy.deepcopy(self.data)
        data, products, counts = transfer.plan_rows(self.payloads())
        self.assertEqual(data, original)
        self.assertEqual([r[:3] for r in products],
                         [["one", "one", "first"], ["two", "two", "second"], ["three", "three", "third"]])
        self.assertEqual([r[4] for r in products], ["001", " 001 ", None])
        self.assertEqual([r[-1] for r in products], ["duplicate_sku", "duplicate_sku", "missing_sku"])
        self.assertEqual(counts["duplicateSkuGroups"], 1)
        self.assertEqual(counts["historicalOrders"], 1)
        self.assertEqual(counts["historicalStaff"], 1)
        self.assertTrue(all(r[7:9] == ["review", "UNDECIDED"] for r in products))
        self.assertEqual(products[0][3], "parent")  # Parent-category goods must survive.

    def test_duplicate_source_id_refused(self):
        self.data["products"][1]["id"] = "one"
        with self.assertRaisesRegex(RuntimeError, "DUPLICATE_PRODUCT_ID"):
            transfer.plan_rows(self.payloads())

    def test_duplicate_category_id_refused(self):
        self.data["categories"].append(self.data["categories"][0])
        with self.assertRaisesRegex(RuntimeError, "DUPLICATE_CATEGORY_ID"):
            transfer.plan_rows(self.payloads())

    def test_missing_parent_refused(self):
        self.data["categories"][1]["parent_id"] = "missing"
        with self.assertRaisesRegex(RuntimeError, "CATEGORY_PARENT_MISSING"):
            transfer.plan_rows(self.payloads())

    def test_cycle_refused(self):
        self.data["categories"][0]["parent_id"] = "child"
        with self.assertRaisesRegex(RuntimeError, "CATEGORY_CYCLE"):
            transfer.plan_rows(self.payloads())

    def test_orphan_product_refused(self):
        self.data["products"][0]["category_id"] = "missing"
        with self.assertRaisesRegex(RuntimeError, "PRODUCT_CATEGORY_MISSING"):
            transfer.plan_rows(self.payloads())

    def test_orphan_photo_and_cost_refused(self):
        for table in ("product_photos", "product_costs"):
            with self.subTest(table=table):
                original = copy.deepcopy(self.data)
                self.data[table] = [{"product_id": "missing"}]
                with self.assertRaisesRegex(RuntimeError, "ORPHAN_" + table.upper()):
                    transfer.plan_rows(self.payloads())
                self.data = original

    def test_review_csv_neutralizes_formulas_and_preserves_quotes(self):
        values = ["=1+1", "  @SUM(1)", "+5", "-5", "\t=1", "\r=1", "001", 'Сварка, "тест"', 123]
        raw = transfer.csv_bytes(["value"], [[v] for v in values])
        parsed = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline="")))
        self.assertEqual([r[0] for r in parsed[1:]],
                         ["'" + v for v in values[:6]] + ["001", 'Сварка, "тест"', "123"])

    def test_private_file_cannot_replace_existing_or_follow_link(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data"
            transfer.private_write(path, b"original")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                transfer.private_write(path, b"replacement")
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(FileExistsError):
                transfer.private_write(link, b"replacement")
            self.assertEqual(path.read_bytes(), b"original")

    def test_target_backup_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "rehearsals"
            base.mkdir(mode=0o700)
            folder = base / "synthetic"
            folder.mkdir(mode=0o700)
            report = {"sourceSchema": "0000-0013", "sourceUnchanged": True,
                      "productionMigrationsApplied": False,
                      "backupSha256": hashlib.sha256(b"dump").hexdigest(),
                      "rolesSha256": hashlib.sha256(b"roles").hexdigest()}
            for name, content in [("before.dump", b"dump"), ("roles.sql", b"roles"),
                                  ("report.json", json.dumps(report).encode())]:
                transfer.private_write(folder / name, content)
            path = folder / "report.json"
            with patch.object(transfer, "REHEARSALS", base):
                self.assertEqual(transfer.target_backup(path)[:2], (b"dump", b"roles"))
                with self.assertRaisesRegex(RuntimeError, "TARGET_BACKUP_PATH_REFUSED"):
                    transfer.target_backup(base / "report.json")
                link = base / "alias"
                link.symlink_to(folder)
                with self.assertRaisesRegex(RuntimeError, "TARGET_BACKUP_PATH_REFUSED"):
                    transfer.target_backup(link / "report.json")
                (folder / "before.dump").write_bytes(b"changed")
                with self.assertRaisesRegex(RuntimeError, "TARGET_BACKUP_HASH_MISMATCH"):
                    transfer.target_backup(path)
                (folder / "before.dump").write_bytes(b"dump")
                report["productionMigrationsApplied"] = True
                path.write_text(json.dumps(report))
                with self.assertRaisesRegex(RuntimeError, "TARGET_BACKUP_SCOPE_MISMATCH"):
                    transfer.target_backup(path)
                report["productionMigrationsApplied"] = False
                path.write_text(json.dumps(report))
                os.chmod(folder / "roles.sql", 0o644)
                with self.assertRaisesRegex(RuntimeError, "PRIVATE_PERMISSIONS_REQUIRED"):
                    transfer.target_backup(path)

    def test_only_catalog_and_replay_barrier_go_to_active_tables(self):
        metadata = {"columns": [{"table_name": table, "column_name": "id"}
                                for table in transfer.snapshot.TABLES]}
        query = transfer.copy_sql(metadata, self.payloads())
        for table in ("staff", "shop_orders", "audit_log"):
            self.assertNotIn("INSERT INTO public." + transfer.snapshot.identifier(table), query)
        for table in transfer.COPY_TABLES:
            self.assertIn("INSERT INTO public." + transfer.snapshot.identifier(table) + '("id")', query)
        self.assertEqual(query.count("INSERT INTO mw_transfer_review.source_payloads"), 8)

    def test_missing_source_columns_refused(self):
        with self.assertRaisesRegex(RuntimeError, "MISSING_SOURCE_COLUMNS"):
            transfer.copy_sql({"columns": []}, self.payloads())


if __name__ == "__main__":
    unittest.main()
