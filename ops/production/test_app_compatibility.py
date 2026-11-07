import copy
import json
import subprocess
import unittest
from unittest.mock import patch

import app_compatibility as guard

SHA = "1" * 40
IMAGE_ID = "sha256:" + "a" * 64
IDENTITY = {"environment": "production", "instanceId": "11111111-2222-4333-8444-555555555555"}
ENV = {"APP_ENV": "production", "MW_INSTANCE_ID": IDENTITY["instanceId"]}


def image(capable=True):
    labels = {"org.opencontainers.image.revision": SHA}
    if capable:
        labels[guard.CAPABILITY] = "1"
    return {"Id": IMAGE_ID, "Config": {"Labels": labels}}


def container():
    return {"Image": IMAGE_ID, "Config": {
        "Image": "mutable-tag:previous",
        "Labels": {"mw-shop.slot": "a", "mw-shop.sha": SHA},
        "Env": ["APP_ENV=production", "MW_INSTANCE_ID=" + IDENTITY["instanceId"]],
    }}


class ProductionCompatibilityTests(unittest.TestCase):
    def test_requires_exact_production_identity(self):
        self.assertEqual(guard.identity_from_env(ENV), IDENTITY)
        for env in [{}, {**ENV, "APP_ENV": "dev"}, {**ENV, "MW_INSTANCE_ID": guard.DEV_ID},
                    {**ENV, "MW_INSTANCE_ID": "wrong"}]:
            with self.subTest(env=env), self.assertRaises(ValueError):
                guard.identity_from_env(env)

    def test_no_schema_full_schema_and_every_partial_schema(self):
        for mask in range(64):
            flags = [bool(mask & (1 << n)) for n in range(6)]
            value = {"identity": IDENTITY, "sourceFacts": flags}
            if mask in (0, 63):
                self.assertEqual(guard.validate_schema(value, IDENTITY), mask == 63)
            else:
                with self.assertRaisesRegex(ValueError, "PROD_SOURCE_FACT_SCHEMA_INCOMPLETE"):
                    guard.validate_schema(value, IDENTITY)

    def test_schema_rejects_wrong_identity_and_malformed_flags(self):
        with self.assertRaisesRegex(ValueError, "PROD_DATABASE_IDENTITY_MISMATCH"):
            guard.validate_schema({"identity": {**IDENTITY, "environment": "dev"}}, IDENTITY)
        for flags in [None, [], [False] * 5, [1] * 6, "false"]:
            with self.assertRaisesRegex(ValueError, "PROD_SCHEMA_INVALID"):
                guard.validate_schema({"identity": IDENTITY, "sourceFacts": flags}, IDENTITY)

    def test_old_image_only_before_new_schema(self):
        self.assertEqual(guard.validate_image(image(False), SHA, False), IMAGE_ID)
        with self.assertRaisesRegex(ValueError, "PROD_IMAGE_SOURCE_FACTS_UNSUPPORTED"):
            guard.validate_image(image(False), SHA, True)
        self.assertEqual(guard.validate_image(image(), SHA, True), IMAGE_ID)

    def test_image_requires_exact_sha_id_and_non_dev(self):
        for target, sha in [
            (image(), "short"), (image(), "2" * 40),
            ({**image(), "Id": "mutable-tag"}, SHA),
            ({"Id": IMAGE_ID, "Config": {"Labels": {**image()["Config"]["Labels"], "mw.environment": "dev"}}}, SHA),
        ]:
            with self.subTest(target=target, sha=sha), self.assertRaises(ValueError):
                guard.validate_image(target, sha, True)

    def test_container_checks_slot_sha_and_database_without_starting(self):
        self.assertEqual(guard.validate_container(container(), SHA, IDENTITY, "a"), IMAGE_ID)
        for slot, sha, expected in [("b", SHA, IDENTITY), ("a", "2" * 40, IDENTITY),
                                    ("a", SHA, {**IDENTITY, "instanceId": "22222222-2222-4333-8444-555555555555"})]:
            with self.assertRaises(ValueError):
                guard.validate_container(container(), sha, expected, slot)
        for entries in [[], ["APP_ENV=dev"], ["APP_ENV=production", "APP_ENV=dev"], [7]]:
            bad = container()
            bad["Config"]["Env"] = entries
            with self.assertRaises(ValueError):
                guard.validate_container(bad, SHA, IDENTITY, "a")

    def test_container_reads_immutable_image_not_tag(self):
        with patch.object(guard, "schema_requirements", return_value=True), patch.object(guard, "inspect") as inspect:
            inspect.side_effect = [container(), image()]
            self.assertEqual(guard.check(ENV, SHA, container="isolated-slot", slot="a"), IMAGE_ID)
            self.assertEqual(inspect.call_args_list[-1].args, ("image", IMAGE_ID))

    def test_container_image_id_mismatch_is_rejected(self):
        with patch.object(guard, "schema_requirements", return_value=True), patch.object(guard, "inspect") as inspect:
            inspect.side_effect = [container(), {**image(), "Id": "sha256:" + "b" * 64}]
            with self.assertRaisesRegex(ValueError, "PROD_IMAGE_ID_MISMATCH"):
                guard.check(ENV, SHA, container="isolated-slot", slot="a")

    def test_docker_failure_and_missing_are_distinct(self):
        for stderr, expected in [("Cannot connect to Docker", "PROD_DOCKER_UNAVAILABLE"),
                                  ("Error: No such image: previous", "PROD_RESOURCE_MISSING")]:
            with patch.object(guard.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", stderr)):
                with self.assertRaisesRegex(ValueError, expected):
                    guard.inspect("image", "previous")

    def test_bad_docker_json_is_rejected(self):
        for raw in ["bad", "[]", "null", "[null]", "{}"]:
            with patch.object(guard.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, raw, "")):
                with self.assertRaisesRegex(ValueError, "PROD_DOCKER_METADATA_INVALID"):
                    guard.inspect("image", "previous")

    def test_database_ownership_running_and_read_only_query(self):
        db = {"Config": {"Labels": {"mw.environment": "production"}}, "State": {"Running": True}}
        result = json.dumps({"identity": IDENTITY, "sourceFacts": [True] * 6})
        with patch.object(guard, "inspect", return_value=db), patch.object(guard.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, result, "")
            self.assertTrue(guard.schema_requirements(IDENTITY, "isolated-db", "postgres"))
            self.assertIn("READ ONLY", run.call_args.kwargs["input"])
            self.assertIn("statement_timeout", run.call_args.kwargs["input"])
            self.assertEqual(run.call_args.args[0][:4], ["docker", "exec", "-i", "isolated-db"])
        for change in [{"Config": {"Labels": {"mw.environment": "dev"}}}, {"State": {"Running": False}}]:
            bad = {**copy.deepcopy(db), **change}
            with patch.object(guard, "inspect", return_value=bad), patch.object(guard.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    guard.schema_requirements(IDENTITY)
                run.assert_not_called()

    def test_failed_or_invalid_query_never_means_old_schema(self):
        db = {"Config": {"Labels": {"mw.environment": "production"}}, "State": {"Running": True}}
        for result in [subprocess.CompletedProcess([], 1, "", "unavailable"),
                       subprocess.CompletedProcess([], 0, "bad", "")]:
            with patch.object(guard, "inspect", return_value=db), patch.object(guard.subprocess, "run", return_value=result):
                with self.assertRaises(ValueError):
                    guard.schema_requirements(IDENTITY)


if __name__ == "__main__":
    unittest.main()
