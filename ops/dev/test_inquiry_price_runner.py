"""Fail-closed inquiry-price runner checks; no database or runtime operations."""
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("inquiry_runner", Path(__file__).with_name("apply-inquiry-prices.py"))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
SHA = "a" * 40
IMAGE = "sha256:" + "b" * 64
RECORD = {"sourceSha": SHA, "imageId": IMAGE}


class InquiryRunnerTests(unittest.TestCase):
    def test_runtime_state_and_secrets_stay_canonical_for_worktree_source(self):
        canonical = Path("/home/codex/projects/masterweld.ru")
        self.assertEqual(runner.STATE, canonical / "ops/.state/dev")
        self.assertEqual(runner.transition.STATE, runner.STATE)
        self.assertEqual(runner.restart.ROOT, canonical)
        self.assertEqual(runner.transition.ROOT, runner.ROOT)
        self.assertEqual(runner.transition.JOURNAL.name, "inquiry-price-transition.json")

    def test_migration_source_change_is_rejected_before_sql(self):
        with patch.object(runner.transition, "revision", return_value="c" * 40), \
                patch.object(runner.transition, "sql") as sql:
            with self.assertRaisesRegex(RuntimeError, "INQUIRY_SOURCE_CHANGED"):
                runner.Adapter().migrate(RECORD)
            sql.assert_not_called()

    def test_finish_requires_complete_inquiry_schema_before_reading_receipt(self):
        with patch.object(runner.guard, "schema_requirements", return_value=runner.guard.SCHEMA_0043_CAPABILITIES), \
                patch.object(runner.transition, "sql") as sql:
            with self.assertRaisesRegex(RuntimeError, "INQUIRY_COMMITTED_SCHEMA_REQUIRED"):
                runner.Adapter().confirm_commit(RECORD)
            sql.assert_not_called()

    def test_finish_rejects_same_migration_from_different_source_or_image(self):
        wrong = {runner.MIGRATION: runner.MIGRATION_SHA,
                 runner.binding_path("c" * 40): "d" * 64}
        with patch.object(runner.guard, "schema_requirements", return_value=runner.guard.SCHEMA_0045_CAPABILITIES), \
                patch.object(runner.transition, "sql", return_value=json.dumps(wrong)), \
                patch.object(runner.guard, "validate_image") as validate:
            with self.assertRaisesRegex(RuntimeError, "INQUIRY_RECEIPT_REQUIRES_REVIEW"):
                runner.Adapter().confirm_commit(RECORD)
            validate.assert_not_called()

    def test_finish_validates_immutable_image_after_exact_atomic_receipts(self):
        receipt = {runner.MIGRATION: runner.MIGRATION_SHA, runner.binding_path(SHA):
                   runner.hashlib.sha256(IMAGE.encode()).hexdigest()}
        image = {"Id": IMAGE}
        with patch.object(runner.guard, "schema_requirements", return_value=runner.guard.SCHEMA_0045_CAPABILITIES), \
                patch.object(runner.transition, "sql", return_value=json.dumps(receipt)), \
                patch.object(runner.guard, "inspect", return_value=image) as inspect, \
                patch.object(runner.guard, "validate_image") as validate:
            runner.Adapter().confirm_commit(RECORD)
            inspect.assert_called_once_with("image", IMAGE)
            validate.assert_called_once_with(image, SHA, runner.guard.SCHEMA_0045_CAPABILITIES)

    def test_unprobed_candidate_cannot_activate(self):
        with patch.object(runner.restart, "preflight_image", side_effect=RuntimeError("candidate failed")), \
                patch.object(runner.transition.Adapter, "activate") as activate:
            with self.assertRaisesRegex(RuntimeError, "candidate failed"):
                runner.Adapter().activate(RECORD)
            activate.assert_not_called()

    def prepare_context(self, rehearsal=None, revision=SHA, candidate_error=None):
        stack = ExitStack()
        self.addCleanup(stack.close)
        old = {"Id": "c" * 64, "Image": "sha256:" + "d" * 64,
               "State": {"Running": True}, "NetworkSettings": {"Networks": {
                   runner.restart.EDGE_NETWORK: {}, runner.restart.PRIVATE_NETWORK: {}}}}
        worker = {"Id": "e" * 64, "Image": "sha256:" + "f" * 64, "State": {"Running": True}}
        evidence = rehearsal if rehearsal is not None else {
            "ok": True, "proposal_sha256": runner.MIGRATION_SHA,
            "installation_wrapper": True, "baseline_functions": runner.BASELINE_FUNCTIONS}
        stack.enter_context(patch.object(runner, "baseline"))
        stack.enter_context(patch.object(runner.guard, "inspect", side_effect=[{}, old, worker]))
        stack.enter_context(patch.object(runner.guard, "owned"))
        stack.enter_context(patch.object(runner.guard, "validate_image", return_value=IMAGE))
        stack.enter_context(patch.object(runner.guard, "validate_previous", return_value="b" * 40))
        stack.enter_context(patch.object(runner.transition, "checked_worker", return_value=worker))
        stack.enter_context(patch.object(runner.transition, "run",
                                        return_value=SimpleNamespace(stdout=json.dumps(evidence))))
        stack.enter_context(patch.object(runner.transition, "revision", return_value=revision))
        candidate = stack.enter_context(patch.object(runner.restart, "preflight_image",
                                                     side_effect=candidate_error))
        persist = stack.enter_context(patch.object(runner.transition, "persist"))
        return candidate, persist

    def test_prepare_requires_exact_successful_wrapper_rehearsal(self):
        candidate, persist = self.prepare_context({"ok": True, "proposal_sha256": runner.MIGRATION_SHA})
        with self.assertRaisesRegex(RuntimeError, "INQUIRY_ISOLATED_REHEARSAL_REQUIRED"):
            runner.prepare(SHA)
        candidate.assert_not_called()
        persist.assert_not_called()

    def test_prepare_source_drift_creates_no_journal_or_candidate(self):
        candidate, persist = self.prepare_context(revision="c" * 40)
        with self.assertRaisesRegex(RuntimeError, "INQUIRY_SOURCE_CHANGED"):
            runner.prepare(SHA)
        candidate.assert_not_called()
        persist.assert_not_called()

    def test_prepare_candidate_failure_creates_no_journal(self):
        candidate, persist = self.prepare_context(candidate_error=RuntimeError("candidate failed"))
        with self.assertRaisesRegex(RuntimeError, "candidate failed"):
            runner.prepare(SHA)
        candidate.assert_called_once_with(IMAGE, SHA)
        persist.assert_not_called()

    def test_unreviewed_migration_and_nonexact_revision_rejected(self):
        for sha, image, payload in (("main", IMAGE, None), (SHA, "tag", None),
                                     (SHA, IMAGE, runner.load_migration() + "\nSELECT 1;")):
            with self.assertRaises(RuntimeError):
                runner.transaction(sha, image, payload)


if __name__ == "__main__":
    unittest.main()
