import hashlib
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from preflight import (BOT_KEYS, DATABASE_KEYS, DEV_ID, DEV_BOT, REQUIRED_PROPOSALS, ROOT,
                       configuration_errors, expected_schema_files, inspect_schema,
                       inspect_bots, read_env, request_json, schema_errors, telegram_read)
from stage_config import compose, save_candidate


def valid():
    # Synthetic tokens and keys; never accepted by Telegram.
    return {
        "APP_ENV": "production", "MW_INSTANCE_ID": "7d71c476-186d-4da5-9d3d-8cc984b33bdf",
        "PUBLIC_ORIGIN": "https://shop.masterweld.ru", "SUPABASE_URL": "http://mw-prod-api:8080",
        "SUPABASE_PUBLISHABLE_KEY": "synthetic-anon", "SUPABASE_SERVICE_ROLE_KEY": "synthetic-service",
        "TELEGRAM_TRANSPORT": "direct", "TELEGRAM_ENABLED": "true",
        "TELEGRAM_BOT_ID": "8861999166", "TELEGRAM_BOT_USERNAME": "masterweldermanagerbot",
        "TELEGRAM_BOT_TOKEN": "8861999166:" + "S" * 32, "TELEGRAM_WEBHOOK_SECRET": "s" * 40,
        "CUSTOMER_TELEGRAM_ENABLED": "true", "CUSTOMER_TELEGRAM_BOT_ID": "9168738475",
        "CUSTOMER_TELEGRAM_BOT_USERNAME": "msvarbot", "CUSTOMER_TELEGRAM_BOT_TOKEN": "9168738475:" + "C" * 32,
        "CUSTOMER_TELEGRAM_WEBHOOK_SECRET": "c" * 40, "ORDER_NOTIFICATIONS_ENABLED": "false",
    }


class PreflightTest(unittest.TestCase):
    def test_complete_candidate_validates(self):
        self.assertEqual(configuration_errors(valid(), {}), [])

    def test_explicit_alert_mode_still_requires_manual_release_review(self):
        self.assertEqual(configuration_errors({**valid(), "ORDER_NOTIFICATIONS_ENABLED": "true"}, {}), [])
        from preflight import MANUAL_BLOCKERS
        self.assertIn("PRODUCTION_ALERTS_REVIEW_REQUIRED", MANUAL_BLOCKERS)

    def test_empty_fails(self):
        errors = configuration_errors({}, {})
        self.assertIn("MISSING:SUPABASE_SERVICE_ROLE_KEY", errors)
        self.assertIn("MISSING:CUSTOMER_TELEGRAM_BOT_TOKEN", errors)

    def test_dev_identity_cannot_be_reused(self):
        env = {**valid(), "MW_INSTANCE_ID": DEV_ID, "TELEGRAM_BOT_ID": DEV_BOT,
               "ORDER_NOTIFICATIONS_ENABLED": "yes"}
        errors = configuration_errors(env, {})
        self.assertIn("DEV_INSTANCE_FORBIDDEN", errors)
        self.assertIn("DEV_BOT_FORBIDDEN", errors)
        self.assertIn("NOTIFICATION_MODE_INVALID", errors)

    def test_hosted_backend_cannot_be_promoted(self):
        self.assertIn("INDEPENDENT_DATABASE_ENDPOINT_REQUIRED",
                      configuration_errors({**valid(), "SUPABASE_URL": "https://example.supabase.co"}, {}))

    def test_shared_key_denied_across_roles(self):
        env = valid()
        self.assertIn("SHARED_DEV_SECRET:CUSTOMER_TELEGRAM_BOT_TOKEN",
                      configuration_errors(env, {"TELEGRAM_BOT_TOKEN": env["CUSTOMER_TELEGRAM_BOT_TOKEN"]}))

    def test_role_swap_and_shared_webhook_secret_denied(self):
        env = valid()
        env["CUSTOMER_TELEGRAM_BOT_ID"] = env["TELEGRAM_BOT_ID"]
        env["CUSTOMER_TELEGRAM_WEBHOOK_SECRET"] = env["TELEGRAM_WEBHOOK_SECRET"]
        errors = configuration_errors(env, {})
        self.assertIn("BOT_IDENTITY_REVIEW_REQUIRED:customer", errors)
        self.assertIn("BOT_ROLES_MUST_BE_SEPARATE:WEBHOOK_SECRET", errors)

    def test_schema_detects_missing_unexpected_and_modified_migrations(self):
        errors = schema_errors([{"path": "old", "sha256": "a"}, {"path": "unexpected", "sha256": "x"}],
                               {"old": "b", "new": "n"})
        self.assertEqual(errors, ["MIGRATION_CHECKSUM_MISMATCH:old", "MIGRATION_MISSING:new",
                                  "MIGRATION_UNEXPECTED:unexpected"])

    def test_current_application_proposals_cannot_disappear_from_inventory(self):
        expected = expected_schema_files(ROOT)
        self.assertTrue(set(REQUIRED_PROPOSALS) <= set(expected))
        before_proposals = [{"path": path, "sha256": checksum}
                            for path, checksum in expected.items() if path not in REQUIRED_PROPOSALS]
        self.assertEqual(schema_errors(before_proposals, expected),
                         sorted("MIGRATION_MISSING:" + path for path in REQUIRED_PROPOSALS))
        complete = [{"path": path, "sha256": checksum} for path, checksum in expected.items()]
        self.assertEqual(schema_errors(complete, expected), [])
        complete[-1]["sha256"] = "changed"
        self.assertEqual(schema_errors(complete, expected),
                         ["MIGRATION_CHECKSUM_MISMATCH:" + complete[-1]["path"]])

    def test_required_proposal_files_are_exact_and_unrelated_drafts_are_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            directory = root / "docs/proposals"
            directory.mkdir(parents=True)
            required = directory / "0042_reviewed.sql"
            required.write_bytes(b"-- reviewed fixture")
            expected = {"docs/proposals/0042_reviewed.sql":
                        hashlib.sha256(required.read_bytes()).hexdigest()}
            (directory / "9999_unreviewed.sql").write_bytes(b"-- unrelated fixture")
            with patch("preflight.REQUIRED_PROPOSALS", expected):
                self.assertEqual(expected_schema_files(root), expected)
                required.write_bytes(b"-- changed fixture")
                with self.assertRaisesRegex(ValueError, "REQUIRED_PROPOSAL_CHECKSUM_MISMATCH"):
                    expected_schema_files(root)
                required.unlink()
                with self.assertRaises(FileNotFoundError):
                    expected_schema_files(root)

    def test_schema_probe_reads_only_and_reports_the_two_uninstalled_proposals(self):
        import subprocess
        expected = expected_schema_files(ROOT)
        files = [{"path": path, "sha256": checksum}
                 for path, checksum in expected.items() if path not in REQUIRED_PROPOSALS]
        state = {"identity": {"environment": "production", "instanceId": valid()["MW_INSTANCE_ID"]},
                 "files": files}
        responses = [
            subprocess.CompletedProcess([], 0, json.dumps([{"Config": {"Labels": {"mw.environment": "production"}}}])),
            subprocess.CompletedProcess([], 0, json.dumps(state)),
        ]
        with patch("preflight.subprocess.run", side_effect=responses) as run:
            self.assertEqual(inspect_schema(valid()),
                             sorted("MIGRATION_MISSING:" + path for path in REQUIRED_PROPOSALS))
            self.assertEqual(len(run.call_args_list), 2)
            sql = run.call_args_list[1].args[0][-1]
            self.assertTrue(sql.strip().startswith("SELECT json_build_object("))
            for mutation in ("INSERT", "UPDATE", "DELETE", "CREATE", "ALTER"):
                self.assertNotIn(mutation, sql)

    def test_schema_probe_fails_closed_when_required_source_is_unavailable(self):
        import subprocess
        state = {"identity": {"environment": "production", "instanceId": valid()["MW_INSTANCE_ID"]},
                 "files": []}
        responses = [
            subprocess.CompletedProcess([], 0, json.dumps([{"Config": {"Labels": {"mw.environment": "production"}}}])),
            subprocess.CompletedProcess([], 0, json.dumps(state)),
        ]
        with (
            patch("preflight.subprocess.run", side_effect=responses),
            patch("preflight.expected_schema_files", side_effect=FileNotFoundError),
        ):
            self.assertEqual(inspect_schema(valid()), ["SCHEMA_INVENTORY_UNAVAILABLE"])

    def test_webhook_inventory_never_exposes_legacy_url_or_errors(self):
        calls = []
        def read(token, method):
            role = "staff" if token.startswith("886") else "customer"
            calls.append((role, method))
            if method == "getMe":
                return {"id": 8861999166 if role == "staff" else 9168738475, "is_bot": True,
                        "username": "masterweldermanagerbot" if role == "staff" else "msvarbot"}
            return {"url": "https://old.example/private-secret?token=secret" if role == "staff" else "",
                    "pending_update_count": 2 if role == "staff" else 0,
                    "last_error_date": 123 if role == "staff" else 0,
                    "last_error_message": "provider-secret"}
        result = inspect_bots(valid(), read)
        self.assertIn("WEBHOOK_CUTOVER_REQUIRED:staff", result[2])
        self.assertIn("WEBHOOK_NOT_CONNECTED:customer", result[2])
        self.assertIn("PENDING_UPDATES_REVIEW_REQUIRED:staff", result[2])
        self.assertNotIn("secret", json.dumps(result))
        self.assertEqual(len(calls), 4)
        self.assertEqual({method for _, method in calls}, {"getMe", "getWebhookInfo"})

    def test_wrong_bot_does_not_trigger_further_read(self):
        calls = []
        def read(token, method):
            calls.append(method)
            return {"id": 1, "username": "wrong", "is_bot": True}
        result = inspect_bots(valid(), read)
        self.assertEqual(calls, ["getMe", "getMe"])
        self.assertIn("BOT_IDENTITY_MISMATCH:staff", result[2])

    def test_provider_errors_and_mutation_methods_are_blocked(self):
        with patch("preflight.urllib.request.build_opener") as opener:
            opener.return_value.open.side_effect = URLError("private-token")
            with self.assertRaisesRegex(ValueError, "^REMOTE_CHECK_FAILED$"):
                request_json("request")
            with self.assertRaisesRegex(ValueError, "^READ_ONLY_METHOD_REQUIRED$"):
                telegram_read("private-token", "setWebhook")


class StagingTest(unittest.TestCase):
    def test_composition_requires_matching_public_build_key(self):
        env = valid()
        database = {k: env[k] for k in DATABASE_KEYS}
        bots = {k: env[k] for k in BOT_KEYS}
        build = {"VITE_APP_ENV": "production", "VITE_SUPABASE_PROJECT_ID": "mw-production",
                 "VITE_SUPABASE_URL": "https://shop.masterweld.ru/backend",
                 "VITE_SUPABASE_PUBLISHABLE_KEY": env["SUPABASE_PUBLISHABLE_KEY"]}
        self.assertEqual(compose(database, bots, {}, build), env)
        with self.assertRaisesRegex(ValueError, "BUILD_CONFIGURATION_MISMATCH"):
            compose(database, bots, {}, {**build, "VITE_SUPABASE_PUBLISHABLE_KEY": "other"})
        with self.assertRaisesRegex(ValueError, "SOURCE_KEYS_REQUIRE_REVIEW"):
            compose({**database, "TELEGRAM_BOT_TOKEN": "unexpected"}, bots, {}, build)

    def test_private_idempotent_candidate_does_not_create_active_config(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "shop.env.candidate"
            self.assertTrue(save_candidate(path, valid()))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(save_candidate(path, valid()))
            self.assertFalse((path.parent / "shop.env").exists())
            previous = path.read_bytes()
            with self.assertRaisesRegex(ValueError, "EXISTING_CANDIDATE_CONFLICT"):
                save_candidate(path, {**valid(), "TELEGRAM_WEBHOOK_SECRET": "different"})
            self.assertEqual(path.read_bytes(), previous)

    def test_insecure_file_and_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "env"
            path.write_text("KEY=private\n")
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(ValueError, "PRIVATE_FILE_REQUIRED"):
                read_env(path)
            os.chmod(path, 0o600)
            alias = pathlib.Path(folder) / "alias"
            alias.symlink_to(path)
            with self.assertRaises(OSError):
                read_env(alias)
            with self.assertRaises(OSError):
                save_candidate(alias, valid())
            self.assertEqual(path.read_text(), "KEY=private\n")

    def test_duplicate_env_entries_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "env"
            path.write_text("KEY=first\nKEY=second\n")
            os.chmod(path, 0o600)
            with self.assertRaisesRegex(ValueError, "ENV_FORMAT_INVALID"):
                read_env(path)


if __name__ == "__main__":
    unittest.main()
