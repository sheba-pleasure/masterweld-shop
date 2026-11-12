import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import documentary_transition as transition

spec = importlib.util.spec_from_file_location("documentary_apply", pathlib.Path(__file__).with_name("apply-documentary-conditions.py"))
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)

SHA = "a" * 40
IMAGE = "sha256:" + "b" * 64


def record():
    return {"version": 2, "phase": "prepared", "operation": "1" * 32,
            "sourceSha": SHA, "imageId": IMAGE, "oldId": "2" * 64,
            "oldImage": "sha256:" + "3" * 64, "oldRevision": "4" * 40,
            "workerId": "5" * 64, "workerImage": "sha256:" + "6" * 64}


class FakeIO:
    def __init__(self):
        self.committed = False
        self.paused = False
        self.ready = False
        self.worker = True
        self.writes = 0
        self.restores = 0
        self.fail = None
        self.commit_before_error = False
        self.saved = []

    def persist(self, rec, phase):
        rec["phase"] = phase
        self.saved.append(copy.deepcopy(rec))

    def pause_writers(self, rec):
        self.paused = True
        self.worker = False
        if self.fail == "drain":
            raise RuntimeError("drain failed")

    def restore_before_migration(self, rec):
        assert self.writes == 0 and not self.committed
        self.restores += 1
        self.paused = False
        self.worker = True

    def migrate(self, rec):
        assert self.paused and not self.worker and self.saved[-1]["phase"] == "migration_submitted"
        self.writes += 1
        self.committed = self.fail != "migration" or self.commit_before_error
        if self.fail == "migration":
            raise RuntimeError("transport result unavailable")

    def confirm_commit(self, rec):
        if not self.committed:
            raise RuntimeError("receipt unavailable")

    def activate(self, rec):
        assert self.committed
        if self.fail == "activation":
            raise RuntimeError("health failed")
        self.ready = True
        self.paused = False

    def resume_worker(self, rec):
        assert self.ready
        if self.fail == "worker":
            raise RuntimeError("start failed")
        self.worker = True


class TransitionTests(unittest.TestCase):
    def test_success_drains_before_single_write_and_resumes_after_readiness(self):
        io = FakeIO()
        result = transition.execute(io, record(), apply=True)
        self.assertEqual(result["phase"], "complete")
        self.assertEqual(io.writes, 1)
        self.assertTrue(io.ready and io.worker)
        self.assertEqual(io.restores, 0)

    def test_drain_failure_can_restore_only_before_any_migration(self):
        io = FakeIO()
        io.fail = "drain"
        with self.assertRaisesRegex(RuntimeError, "drain failed"):
            transition.execute(io, record(), apply=True)
        self.assertEqual((io.writes, io.restores), (0, 1))
        self.assertTrue(io.worker)
        self.assertEqual(io.saved[-1]["phase"], "drain_failed")

    def test_uncertain_committed_write_is_finished_without_replay(self):
        io = FakeIO()
        io.fail = "migration"
        io.commit_before_error = True
        rec = record()
        with self.assertRaisesRegex(RuntimeError, "COMMIT_REQUIRES_REVIEW"):
            transition.execute(io, rec, apply=True)
        self.assertTrue(io.paused)
        self.assertFalse(io.worker or io.ready)
        self.assertEqual(io.restores, 0)
        io.fail = None
        # A fresh process resumes from the persisted journal, not an in-memory stage.
        restored = copy.deepcopy(io.saved[-1])
        transition.execute(io, restored)
        self.assertEqual(io.writes, 1)
        self.assertEqual(restored["phase"], "complete")

    def test_uncommitted_or_unreadable_result_never_restores_old_app_or_replays(self):
        io = FakeIO()
        io.fail = "migration"
        rec = record()
        with self.assertRaisesRegex(RuntimeError, "COMMIT_REQUIRES_REVIEW"):
            transition.execute(io, rec, apply=True)
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "receipt unavailable"):
                transition.execute(io, copy.deepcopy(io.saved[-1]))
        self.assertEqual((io.writes, io.restores), (1, 0))
        self.assertFalse(io.worker or io.ready)
        self.assertTrue(io.paused)

    def test_activation_failure_never_restores_old_image_or_starts_worker(self):
        io = FakeIO()
        io.fail = "activation"
        rec = record()
        with self.assertRaisesRegex(RuntimeError, "ACTIVATION_REQUIRES_REVIEW"):
            transition.execute(io, rec, apply=True)
        self.assertFalse(io.worker or io.ready)
        self.assertEqual(io.restores, 0)
        io.fail = None
        transition.execute(io, rec)
        self.assertEqual(io.writes, 1)
        self.assertTrue(io.ready and io.worker)

    def test_worker_failure_keeps_new_app_and_finish_does_not_repeat_migration(self):
        io = FakeIO()
        io.fail = "worker"
        rec = record()
        with self.assertRaisesRegex(RuntimeError, "WORKER_REQUIRES_REVIEW"):
            transition.execute(io, rec, apply=True)
        self.assertTrue(io.ready)
        io.fail = None
        transition.execute(io, copy.deepcopy(io.saved[-1]))
        self.assertEqual(io.writes, 1)

    def test_apply_refuses_existing_transition_and_finish_does_not_trust_phase(self):
        for phase in operator.PHASES - {"prepared"}:
            io = FakeIO()
            rec = {**record(), "phase": phase}
            with self.assertRaisesRegex(RuntimeError, "ALREADY_STARTED"):
                transition.execute(io, rec, apply=True)
            self.assertEqual(io.writes, 0)
        for phase in operator.PHASES:
            io = FakeIO()
            rec = {**record(), "phase": phase}
            with self.assertRaisesRegex(RuntimeError, "receipt unavailable"):
                transition.execute(io, rec)
            self.assertEqual((io.writes, io.restores), (0, 0))

    def test_repeat_finish_is_idempotent_for_database(self):
        io = FakeIO()
        rec = transition.execute(io, record(), apply=True)
        transition.execute(io, copy.deepcopy(rec))
        self.assertEqual(io.writes, 1)


class AdapterTests(unittest.TestCase):
    def test_invalid_operation_label_is_rejected_before_docker(self):
        with patch.object(operator.restart, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "OPERATION_ID_REQUIRED"):
                operator.restart.launch("candidate", IMAGE, operation_id="../other")
            run.assert_not_called()

    def test_durable_journal_is_exclusive_and_checks_immutable_identities(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory)
            journal = state / "transition.json"
            with patch.object(operator, "STATE", state), patch.object(operator, "JOURNAL", journal):
                operator.persist(record(), "prepared", create=True)
                with self.assertRaises(FileExistsError):
                    operator.persist(record(), "prepared", create=True)
                operator.persist(record(), "migration_submitted")
                saved = operator.check_record(json.loads(journal.read_text()))
                self.assertEqual(saved["phase"], "migration_submitted")
                self.assertEqual(journal.stat().st_mode & 0o777, 0o600)
                self.assertFalse(journal.with_suffix(".next").exists())
        for key, value in [("imageId", "mutable:tag"), ("sourceSha", "short"),
                           ("oldId", "some-container"), ("phase", "unknown"),
                           ("operation", "../escape"), ("workerImage", IMAGE[:20]), ("version", 1)]:
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, "JOURNAL_INVALID"):
                operator.check_record({**record(), key: value})

    def test_finish_requires_both_schema_and_exact_receipt_before_activation(self):
        io = operator.Adapter()
        with patch.object(operator.compatibility, "schema_requirements", return_value=frozenset()), \
             patch.object(operator, "sql") as sql:
            with self.assertRaisesRegex(RuntimeError, "COMMITTED_SCHEMA"):
                io.confirm_commit(record())
            sql.assert_not_called()
        with patch.object(operator.compatibility, "schema_requirements", return_value=operator.compatibility.SCHEMA_0043_CAPABILITIES), \
             patch.object(operator, "sql", return_value="wrong") as sql, \
             patch.object(operator.compatibility, "inspect") as inspect:
            with self.assertRaisesRegex(RuntimeError, "REQUIRES_RECEIPT"):
                io.confirm_commit(record())
            self.assertIn("BEGIN READ ONLY", sql.call_args.args[0])
            inspect.assert_not_called()

    def test_finish_requires_each_receipt_and_accepts_only_the_exact_pair(self):
        expected = {operator.installation.PROPOSAL_PATH: operator.installation.PROPOSAL_SHA256,
                    operator.installation.ACCESSORY_PATH: operator.installation.ACCESSORY_SHA256}
        variants = [{}, {operator.installation.PROPOSAL_PATH: operator.installation.PROPOSAL_SHA256},
                    {**expected, operator.installation.ACCESSORY_PATH: "changed"},
                    {**expected, "other": "unreviewed"}]
        with patch.object(operator.compatibility, "schema_requirements", return_value=operator.compatibility.SCHEMA_0043_CAPABILITIES), \
             patch.object(operator.compatibility, "inspect", return_value={"Id": IMAGE}) as inspect, \
             patch.object(operator.compatibility, "validate_image", return_value=IMAGE) as validate:
            for receipt in variants:
                with patch.object(operator, "sql", return_value=json.dumps(receipt)):
                    with self.assertRaisesRegex(RuntimeError, "REQUIRES_RECEIPT"):
                        operator.Adapter().confirm_commit(record())
            inspect.assert_not_called()
            validate.assert_not_called()
            with patch.object(operator, "sql", return_value=json.dumps(expected)):
                operator.Adapter().confirm_commit(record())
            validate.assert_called_once_with({"Id": IMAGE}, SHA, operator.compatibility.SCHEMA_0043_CAPABILITIES)

    def test_foreign_container_name_cannot_be_stopped_during_finish(self):
        old = {"Id": record()["oldId"], "Image": record()["oldImage"], "Name": "/another-project",
               "State": {"Running": True}}
        with patch.object(operator, "checked_container", return_value=old), patch.object(operator, "stop") as stop:
            with self.assertRaisesRegex(RuntimeError, "OLD_NAME_CHANGED"):
                operator.Adapter().activate(record())
            stop.assert_not_called()

    def test_existing_app_must_match_operation_and_immutable_image(self):
        app = {"Config": {"Labels": {"mw.environment": "dev", "mw.dev-transition": "wrong"}}, "Image": IMAGE}
        with self.assertRaisesRegex(RuntimeError, "TARGET_REQUIRES_REVIEW"):
            operator.Adapter().check_target(app, record())
        app["Config"]["Labels"]["mw.dev-transition"] = record()["operation"]
        operator.Adapter().check_target(app, record())
        app["Image"] = record()["oldImage"]
        with self.assertRaisesRegex(RuntimeError, "TARGET_REQUIRES_REVIEW"):
            operator.Adapter().check_target(app, record())

    def test_worker_with_foreign_environment_or_command_is_rejected(self):
        rec = record()
        base = {"Name": "/" + operator.WORKER, "Config": {
            "Cmd": ["/usr/bin/python3", "/worker/worker.py"],
            "Env": ["APP_ENV=dev", "SUPABASE_URL=http://mw-dev-gateway:8080"]}}
        for change in [{"Name": "/other-worker"}, {"Config": {**base["Config"], "Cmd": ["other"]}},
                       {"Config": {**base["Config"], "Env": ["APP_ENV=production"]}}]:
            with patch.object(operator, "checked_container", return_value={**base, **change}):
                with self.assertRaisesRegex(RuntimeError, "WORKER_IDENTITY"):
                    operator.checked_worker(rec)


if __name__ == "__main__":
    unittest.main()
