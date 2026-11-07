import importlib.util
import pathlib
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("update_parser", pathlib.Path(__file__).with_name("update-document-parser.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class SwitchTests(unittest.TestCase):
    def test_failed_promoted_probe_drains_worker_and_restores_old_container(self):
        calls = []
        def inspect(name):
            return {"Id": {"candidate": "new-id", app.PARSER: "old-id"}.get(name, name),
                    "State": {"ExitCode": 0, "Running": True}}
        def run(args, **_):
            calls.append(args)
            return types.SimpleNamespace(stdout="")
        with patch.object(app, "inspect", inspect), patch.object(app, "run", run), \
             patch.object(app, "sql", return_value="0"), patch.object(app, "fingerprints", return_value={}), \
             patch.object(app, "validate_parser"), patch.object(app, "probe", side_effect=RuntimeError("PROBE")):
            with self.assertRaisesRegex(RuntimeError, "PROBE"):
                app.switch("candidate", "previous", "a" * 40)
        remove = calls.index(["docker", "rm", "-f", "new-id"])
        self.assertEqual(calls[remove - 1], ["docker", "stop", "--time", "240", app.WORKER])
        self.assertEqual(calls[remove + 1:], [
            ["docker", "rename", "old-id", app.PARSER],
            ["docker", "network", "connect", app.NETWORK, "old-id"],
            ["docker", "start", "old-id"],
            ["docker", "start", app.WORKER],
        ])
        self.assertNotIn(["docker", "rm", "-f", "old-id"], calls)

    def test_uncertain_drain_does_not_remove_active_parser_or_reset_lease(self):
        calls = []
        def inspect(name):
            return {"Id": {"candidate": "new-id", app.PARSER: "old-id"}.get(name, name),
                    "State": {"ExitCode": 0, "Running": True}}
        def run(args, **_):
            calls.append(args)
            return types.SimpleNamespace(stdout="")
        with patch.object(app, "inspect", inspect), patch.object(app, "run", run), \
             patch.object(app, "sql", side_effect=["0", "1"]), patch.object(app, "fingerprints", return_value={}), \
             patch.object(app, "validate_parser"), patch.object(app, "probe", side_effect=RuntimeError("PROBE")):
            with self.assertRaisesRegex(RuntimeError, "ROLLBACK_REQUIRES_REVIEW"):
                app.switch("candidate", "previous", "a" * 40)
        self.assertFalse(any(args[1] == "rm" for args in calls))
        self.assertNotIn(["docker", "start", app.WORKER], calls)

    def test_success_preserves_documents_and_keeps_old_parser_stopped(self):
        calls = []
        def inspect(name):
            return {"Id": {"candidate": "new-id", app.PARSER: "old-id"}.get(name, name),
                    "State": {"ExitCode": 0, "Running": True}}
        with patch.object(app, "inspect", inspect), \
             patch.object(app, "run", side_effect=lambda args: calls.append(args)), \
             patch.object(app, "sql", return_value="0"), \
             patch.object(app, "fingerprints", side_effect=[{"document": "digest"}, {"document": "digest", "new": "queued"}]), \
             patch.object(app, "validate_parser"), patch.object(app, "probe"):
            result = app.switch("candidate", "previous", "a" * 40)
        self.assertEqual(result["preservedDocuments"], 1)
        self.assertNotIn(["docker", "start", "old-id"], calls)
        self.assertFalse(any(args[1] == "rm" for args in calls))
        self.assertEqual(calls[-1], ["docker", "start", app.WORKER])


if __name__ == "__main__":
    unittest.main()
