import copy
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import migration_plan as plan


def state():
    expected, _ = plan.inventory()
    return {
        "identity": {"environment": "production", "instanceId": "ba2eec4a-5166-45ec-8b5a-e71c2213c015"},
        "files": {p: h for p, h in expected.items() if pathlib.Path(p).name[:4] <= "0013"},
        "counts": {"categories": 0, "products": 0}, "receipts": None, "schemaFingerprint": "a" * 64,
        "privateTables": ["environment", "schema_files"],
    }


def build(value=None):
    return plan.build_plan(value or state(), "1" * 40, "45b37e3a-f202-47c6-a9ae-d4f68aaedbda")


class MigrationPlanTests(unittest.TestCase):
    def test_nonempty_wrong_environment_ledger_and_receipt_are_refused(self):
        changes = [
            lambda v: v["identity"].update(environment="dev"),
            lambda v: v["identity"].update(instanceId=plan.DEV_ID),
            lambda v: v["counts"].update(products=1),
            lambda v: v["counts"].update(products=False),
            lambda v: v["files"].pop(next(iter(v["files"]))),
            lambda v: v.update(receipts=[]),
            lambda v: v["privateTables"].append("unexpected"),
            lambda v: v.update(schemaFingerprint="invalid"),
        ]
        for change in changes:
            with self.subTest(change=change):
                value = state()
                change(value)
                with self.assertRaises(ValueError):
                    build(value)

    def test_plan_is_bound_to_source_and_entire_payload(self):
        original = build()
        self.assertEqual(plan.validate_plan(original), original["manifest"])
        changes = [
            lambda v: v.update(sql=v["sql"] + "\n-- changed"),
            lambda v: v.update(payloadHash="b" * 64),
            lambda v: v["manifest"].update(sourceSha="2" * 40),
            lambda v: v["manifest"]["sources"].update({"ops/production/migration_plan.py": "b" * 64}),
        ]
        for change in changes:
            value = copy.deepcopy(original)
            change(value)
            with self.assertRaises(ValueError):
                plan.validate_plan(value)

    def test_missing_receipt_never_implies_permission_to_retry(self):
        operation = build()
        self.assertEqual(plan.result_status(operation, state()), "baseline_unchanged")
        value = state()
        value["counts"]["products"] = 1
        self.assertEqual(plan.result_status(operation, value), "review_required")
        value = state()
        value["receipts"] = []
        self.assertEqual(plan.result_status(operation, value), "review_required")

    def test_receipt_requires_exact_operation_payload_identity_and_target(self):
        operation = build()
        manifest = operation["manifest"]
        value = state()
        value.update(files=manifest["targetFiles"], schemaFingerprint="c" * 64, receipts=[{
            "operation_id": manifest["operationId"], "source_sha": manifest["sourceSha"],
            "payload_hash": operation["payloadHash"], "baseline_fingerprint": "a" * 64,
            "target_fingerprint": "c" * 64, "committed_at": "2026-11-07T00:00:00Z",
        }])
        self.assertEqual(plan.result_status(operation, value), "committed")
        for key in ("operation_id", "source_sha", "payload_hash", "baseline_fingerprint", "target_fingerprint"):
            changed = copy.deepcopy(value)
            changed["receipts"][0][key] = "changed"
            self.assertEqual(plan.result_status(operation, changed), "review_required")
        changed = copy.deepcopy(value)
        changed["identity"]["instanceId"] = "11111111-2222-4333-8444-555555555555"
        self.assertEqual(plan.result_status(operation, changed), "review_required")
        changed = copy.deepcopy(value)
        changed["files"] = {}
        self.assertEqual(plan.result_status(operation, changed), "review_required")

    def test_private_files_are_exclusive_and_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "plan.json"
            plan.private_write(path, {"test": True})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(plan.private_read(path), {"test": True})
            with self.assertRaises(FileExistsError):
                plan.private_write(path, {})
            link = pathlib.Path(folder) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                plan.private_read(link)
            os.chmod(path, 0o644)
            with self.assertRaises(ValueError):
                plan.private_read(path)

    def test_inspector_has_only_fixed_read_only_calls(self):
        import subprocess
        responses = [
            subprocess.CompletedProcess([], 0, json.dumps([{
                "Config": {"Labels": {"mw.environment": "production"}}, "State": {"Running": True},
            }])),
            subprocess.CompletedProcess([], 0, json.dumps(state())),
        ]
        with patch("migration_plan.subprocess.run", side_effect=responses) as run:
            self.assertEqual(plan.inspect_production(), state())
            self.assertEqual(len(run.call_args_list), 2)
            call = run.call_args_list[1]
            self.assertIn("masterweld_production", call.args[0])
            self.assertEqual(call.kwargs["input"], plan.INSPECTION_SQL)
            self.assertIn("REPEATABLE READ READ ONLY", call.kwargs["input"])
            for mutation in ("INSERT INTO", "UPDATE ", "DELETE ", "CREATE TABLE", "ALTER TABLE"):
                self.assertNotIn(mutation, call.kwargs["input"])
