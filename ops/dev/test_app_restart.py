import copy
import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

import app_compatibility as compatibility

spec = importlib.util.spec_from_file_location("dev_restart", pathlib.Path(__file__).with_name("restart.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

NEW_SHA = "a" * 40
OLD_SHA = "b" * 40
NEW_ID = "sha256:" + "1" * 64
OLD_ID = "sha256:" + "2" * 64
SOURCE_REQUIRED = frozenset({compatibility.CAPABILITY})
DOCUMENTARY_REQUIRED = SOURCE_REQUIRED | {compatibility.DOCUMENTARY_CAPABILITY}


def image(revision=NEW_SHA, image_id=NEW_ID, capable=True):
    labels = {"mw.environment": "dev", "org.opencontainers.image.revision": revision}
    if capable:
        labels[compatibility.CAPABILITY] = "1"
    return {"Id": image_id, "Config": {"Labels": labels}}


def container(name, image_id=OLD_ID, running=True):
    return {"Id": name + "-id", "Name": "/" + name, "Image": image_id,
            "Config": {"Labels": {"mw.environment": "dev"}},
            "State": {"Running": running},
            "NetworkSettings": {"Networks": {"mw-dev-edge": {}, "mw-dev-private": {}}}}


class CompatibilityTests(unittest.TestCase):
    def test_empty_old_schema_and_complete_new_schema(self):
        for needed in (False, True):
            self.assertEqual(compatibility.validate_schema(
                {"identity": compatibility.IDENTITY, "sourceFacts": [needed] * 6, "inquiryPrice": [False] * 6, "accessoryDictionary": [False] * 4, "documentaryConditions": [False] * 6}),
                SOURCE_REQUIRED if needed else frozenset())

    def test_partial_schema_bad_identity_and_unknown_values_fail_closed(self):
        values = [
            {"identity": {**compatibility.IDENTITY, "environment": "production"}, "sourceFacts": [False] * 6},
            {"identity": {**compatibility.IDENTITY, "instanceId": "another"}, "sourceFacts": [False] * 6},
            {"identity": compatibility.IDENTITY, "sourceFacts": [True, True, True, False, True, False]},
            {"identity": compatibility.IDENTITY, "sourceFacts": [1] * 6},
            {"identity": compatibility.IDENTITY, "sourceFacts": []},
            {},
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                compatibility.validate_schema(value)

    def test_documentary_schema_requires_all_markers_and_source_dependencies(self):
        for mask in range(64):
            value = {"identity": compatibility.IDENTITY, "sourceFacts": [True] * 6,
                     "inquiryPrice": [False] * 6, "accessoryDictionary": [False] * 4, "documentaryConditions": [bool(mask & (1 << n)) for n in range(6)]}
            if mask in (0, 63):
                self.assertEqual(compatibility.validate_schema(value),
                                 DOCUMENTARY_REQUIRED if mask == 63 else SOURCE_REQUIRED)
            else:
                with self.assertRaisesRegex(RuntimeError, "DEV_DOCUMENTARY_SCHEMA_INCOMPLETE"):
                    compatibility.validate_schema(value)
        value = {"identity": compatibility.IDENTITY, "sourceFacts": [False] * 6, "inquiryPrice": [False] * 6, "accessoryDictionary": [False] * 4, "documentaryConditions": [True] * 6}
        with self.assertRaisesRegex(RuntimeError, "DEV_DOCUMENTARY_SCHEMA_INCOMPLETE"):
            compatibility.validate_schema(value)
        for flags in [None, [], [False] * 5, [1] * 6, "false"]:
            value = {"identity": compatibility.IDENTITY, "sourceFacts": [True] * 6, "inquiryPrice": [False] * 6, "accessoryDictionary": [False] * 4, "documentaryConditions": flags}
            with self.assertRaisesRegex(RuntimeError, "DEV_SCHEMA_INVALID"):
                compatibility.validate_schema(value)


    def test_accessory_schema_requires_exact_dictionary_and_dependencies(self):
        for mask in range(16):
            value = {"identity": compatibility.IDENTITY, "sourceFacts": [True] * 6, "documentaryConditions": [True] * 6,
                     "inquiryPrice": [False] * 6, "accessoryDictionary": [bool(mask & (1 << n)) for n in range(4)]}
            if mask in (0, 15):
                self.assertEqual(compatibility.validate_schema(value),
                                 compatibility.SCHEMA_0043_CAPABILITIES if mask == 15 else DOCUMENTARY_REQUIRED)
            else:
                with self.assertRaisesRegex(RuntimeError, "DEV_ACCESSORY_SCHEMA_INCOMPLETE"):
                    compatibility.validate_schema(value)
        value = {"identity": compatibility.IDENTITY, "sourceFacts": [True] * 6, "documentaryConditions": [False] * 6,
                 "inquiryPrice": [False] * 6, "accessoryDictionary": [True] * 4}
        with self.assertRaisesRegex(RuntimeError, "DEV_ACCESSORY_SCHEMA_INCOMPLETE"):
            compatibility.validate_schema(value)
        for flags in [None, [], [False] * 3, [1] * 4, "false"]:
            value["accessoryDictionary"] = flags
            with self.assertRaisesRegex(RuntimeError, "DEV_SCHEMA_INVALID"):
                compatibility.validate_schema(value)

    def test_accessory_image_requires_capability_and_documentary_dependency(self):
        target = image()
        target["Config"]["Labels"][compatibility.DOCUMENTARY_CAPABILITY] = "1"
        for label in [None, "0", "2", "true", 1]:
            if label is not None:
                target["Config"]["Labels"][compatibility.ACCESSORY_CAPABILITY] = label
            with self.assertRaisesRegex(RuntimeError, "DEV_IMAGE_ACCESSORY_DICTIONARY_UNSUPPORTED"):
                compatibility.validate_image(target, NEW_SHA, compatibility.SCHEMA_0043_CAPABILITIES)
        target["Config"]["Labels"][compatibility.ACCESSORY_CAPABILITY] = "1"
        self.assertEqual(compatibility.validate_image(target, NEW_SHA, compatibility.SCHEMA_0043_CAPABILITIES), NEW_ID)
        with self.assertRaisesRegex(RuntimeError, "DEV_SCHEMA_REQUIREMENTS_INVALID"):
            compatibility.validate_image(target, NEW_SHA, SOURCE_REQUIRED | {compatibility.ACCESSORY_CAPABILITY})

    def test_documentary_image_requires_exact_capability_even_for_empty_schema(self):
        for label in [None, "0", "2", "true", 1]:
            target = image()
            if label is not None:
                target["Config"]["Labels"][compatibility.DOCUMENTARY_CAPABILITY] = label
            with self.assertRaisesRegex(RuntimeError, "DEV_IMAGE_DOCUMENTARY_CONDITIONS_UNSUPPORTED"):
                compatibility.validate_image(target, NEW_SHA, DOCUMENTARY_REQUIRED)
        target = image()
        target["Config"]["Labels"][compatibility.DOCUMENTARY_CAPABILITY] = "1"
        self.assertEqual(compatibility.validate_image(target, NEW_SHA, DOCUMENTARY_REQUIRED), NEW_ID)
        for required in [True, False, {}, {"source_facts": True}, frozenset({"unknown"}),
                         frozenset({compatibility.DOCUMENTARY_CAPABILITY})]:
            with self.assertRaisesRegex(RuntimeError, "DEV_SCHEMA_REQUIREMENTS_INVALID"):
                compatibility.validate_image(target, NEW_SHA, required)

    def test_image_environment_revision_and_capability(self):
        self.assertEqual(compatibility.validate_image(image(), NEW_SHA, SOURCE_REQUIRED), NEW_ID)
        self.assertEqual(compatibility.validate_image(image(capable=False), NEW_SHA, frozenset()), NEW_ID)
        wrong_environment = image()
        wrong_environment["Config"]["Labels"]["mw.environment"] = "production"
        for info, sha, required in [
            (image(capable=False), NEW_SHA, SOURCE_REQUIRED), (image(), OLD_SHA, SOURCE_REQUIRED),
            (wrong_environment, NEW_SHA, frozenset()), (None, NEW_SHA, frozenset()),
            (image(image_id="mutable-tag"), NEW_SHA, SOURCE_REQUIRED), (image(), "short", frozenset()),
        ]:
            with self.subTest(info=info), self.assertRaises(RuntimeError):
                compatibility.validate_image(info, sha, required)

    def test_database_query_failure_and_stopped_database(self):
        database = container("mw-dev-db")
        with patch.object(compatibility, "inspect", return_value=database), \
             patch.object(compatibility.subprocess, "run", return_value=types.SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(RuntimeError, "DEV_SCHEMA_UNAVAILABLE"):
                compatibility.schema_requirements()
        database["State"]["Running"] = False
        with patch.object(compatibility, "inspect", return_value=database), \
             patch.object(compatibility.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "DEV_DATABASE_NOT_RUNNING"):
                compatibility.schema_requirements()
            run.assert_not_called()

    def test_docker_connection_error_is_not_missing_container(self):
        for stderr, expected in [
            ("Error: No such container: missing", None),
            ("Cannot connect to the Docker daemon", "DEV_DOCKER_INSPECT_FAILED"),
        ]:
            with patch.object(compatibility.subprocess, "run", return_value=types.SimpleNamespace(
                returncode=1, stderr=stderr, stdout="",
            )):
                if expected:
                    with self.assertRaisesRegex(RuntimeError, expected):
                        compatibility.inspect("container", "missing")
                else:
                    self.assertIsNone(compatibility.inspect("container", "missing"))


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = pathlib.Path(self.directory.name)
        (self.state / "active-sha").write_text(OLD_SHA + "\n")
        self.images = {NEW_ID: image(), OLD_ID: image(OLD_SHA, OLD_ID)}
        self.containers = [container(app.APP), container(app.PREVIOUS, running=False)]
        self.events = []
        self.required = SOURCE_REQUIRED
        self.fail_probe = None
        self.fail_command = None
        for module, name, value in [
            (app, "inspect", self.inspect), (compatibility, "inspect", self.inspect),
            (app, "schema_requirements", lambda: self.required),
            (compatibility, "schema_requirements", lambda: self.required),
            (app, "run", self.docker_run), (app, "probe", self.probe),
        ]:
            patcher = patch.object(module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def inspect(self, kind, name):
        if kind == "image":
            key = NEW_ID if name == "masterweld-dev:" + NEW_SHA else name
            return copy.deepcopy(self.images.get(key))
        return copy.deepcopy(next((c for c in self.containers if name in (c["Id"], c["Name"][1:])), None))

    def get(self, name):
        return next(c for c in self.containers if name in (c["Id"], c["Name"][1:]))

    def docker_run(self, args, **kwargs):
        self.events.append(args)
        if self.fail_command and self.fail_command(args):
            raise RuntimeError("SIMULATED_COMMAND_FAILURE")
        command = args[1]
        if command == "create":
            name = args[args.index("--name") + 1]
            entry = container(name, args[-1], running=False)
            entry["Id"] = name + "-new-id"
            entry["NetworkSettings"]["Networks"] = {"mw-dev-edge": {}}
            self.containers.append(entry)
        elif command == "network":
            target = self.get(args[-1])
            if args[2] == "connect":
                target["NetworkSettings"]["Networks"][args[3]] = {}
            else:
                target["NetworkSettings"]["Networks"].pop(args[3])
        elif command == "rm":
            self.containers.remove(self.get(args[-1]))
        elif command in ("stop", "start"):
            self.get(args[-1])["State"]["Running"] = command == "start"
        elif command == "rename":
            self.get(args[-2])["Name"] = "/" + args[-1]
        else:
            raise AssertionError(args)
        return types.SimpleNamespace(stdout="")

    def probe(self, name, sha):
        self.events.append(["probe", name, sha])
        if self.fail_probe == (name, sha):
            raise RuntimeError("DEV_HEALTH_FAILED")

    def test_unsupported_target_refuses_before_any_container_mutation(self):
        self.images[NEW_ID] = image(capable=False)
        with self.assertRaisesRegex(RuntimeError, "SOURCE_FACTS_UNSUPPORTED"):
            app.replace(NEW_SHA, self.state)
        self.assertEqual(self.events, [])
        self.assertEqual(len(self.containers), 2)
        self.assertEqual((self.state / "active-sha").read_text().strip(), OLD_SHA)

    def test_documentary_target_refuses_before_any_mutation(self):
        self.required = DOCUMENTARY_REQUIRED
        with self.assertRaisesRegex(RuntimeError, "DOCUMENTARY_CONDITIONS_UNSUPPORTED"):
            app.replace(NEW_SHA, self.state)
        self.assertEqual(self.events, [])
        self.assertEqual((self.state / "active-sha").read_text().strip(), OLD_SHA)

    def test_documentary_fallback_does_not_start_source_only_predecessor(self):
        self.required = DOCUMENTARY_REQUIRED
        self.images[NEW_ID]["Config"]["Labels"][compatibility.DOCUMENTARY_CAPABILITY] = "1"
        self.fail_probe = (app.APP, NEW_SHA)
        with self.assertRaisesRegex(RuntimeError, "ROLLBACK_REQUIRES_REVIEW"):
            app.replace(NEW_SHA, self.state)
        self.assertIsNone(self.inspect("container", app.APP))
        self.assertFalse(self.get(app.PREVIOUS)["State"]["Running"])
        self.assertNotIn(["docker", "start", app.APP + "-id"], self.events)
        self.assertFalse((self.state / "active-sha").exists())

    def test_preflight_failure_preserves_both_old_containers_and_marker(self):
        self.fail_probe = (app.CANDIDATE, NEW_SHA)
        with self.assertRaisesRegex(RuntimeError, "DEV_HEALTH_FAILED"):
            app.replace(NEW_SHA, self.state)
        self.assertEqual({c["Name"] for c in self.containers}, {"/" + app.APP, "/" + app.PREVIOUS})
        self.assertTrue(self.get(app.APP)["State"]["Running"])
        self.assertFalse(any(e[1] in ("stop", "rename") for e in self.events if e[0] == "docker"))
        self.assertEqual((self.state / "active-sha").read_text().strip(), OLD_SHA)

    def test_success_probes_before_stop_pins_image_and_only_candidate_suppresses_worker(self):
        app.replace(NEW_SHA, self.state)
        before = self.events.index(["probe", app.CANDIDATE, NEW_SHA])
        stop = self.events.index(["docker", "stop", app.APP + "-id"])
        self.assertLess(before, stop)
        launches = [e for e in self.events if e[:2] == ["docker", "create"]]
        self.assertEqual(len(launches), 2)
        self.assertIn("ORDER_NOTIFICATIONS_ENABLED=false", launches[0])
        self.assertNotIn("ORDER_NOTIFICATIONS_ENABLED=false", launches[1])
        self.assertTrue(all(e[-1] == NEW_ID for e in launches))
        for name in (app.CANDIDATE, app.APP):
            self.assertLess(self.events.index(["docker", "network", "connect", "mw-dev-private", name]),
                            self.events.index(["docker", "start", name]))
        self.assertFalse(any("--publish" in e or "-p" in e or "--network-alias" in e for e in launches))
        self.assertEqual(self.get(app.PREVIOUS)["Image"], OLD_ID)
        self.assertFalse(self.get(app.PREVIOUS)["State"]["Running"])
        self.assertEqual((self.state / "active-sha").read_text().strip(), NEW_SHA)

    def test_failed_new_app_restores_compatible_previous_by_immutable_id(self):
        self.fail_probe = (app.APP, NEW_SHA)
        with self.assertRaisesRegex(RuntimeError, "PREVIOUS_RESTORED"):
            app.replace(NEW_SHA, self.state)
        self.assertEqual(self.get(app.APP)["Image"], OLD_ID)
        self.assertTrue(self.get(app.APP)["State"]["Running"])
        self.assertEqual(self.get(app.APP)["NetworkSettings"]["Networks"], {"mw-dev-edge": {}, "mw-dev-private": {}})
        self.assertEqual((self.state / "active-sha").read_text().strip(), OLD_SHA)
        self.assertIn(["probe", app.APP, OLD_SHA], self.events)

    def test_failed_new_app_never_starts_incompatible_previous(self):
        self.images[OLD_ID] = image(OLD_SHA, OLD_ID, capable=False)
        self.fail_probe = (app.APP, NEW_SHA)
        with self.assertRaisesRegex(RuntimeError, "ROLLBACK_REQUIRES_REVIEW"):
            app.replace(NEW_SHA, self.state)
        self.assertIsNone(self.inspect("container", app.APP))
        self.assertFalse(self.get(app.PREVIOUS)["State"]["Running"])
        self.assertNotIn(["docker", "start", app.APP + "-id"], self.events)
        self.assertFalse((self.state / "active-sha").exists())

    def test_database_unavailable_during_fallback_never_starts_previous(self):
        self.fail_probe = (app.APP, NEW_SHA)
        with patch.object(compatibility, "schema_requirements", side_effect=RuntimeError("DEV_SCHEMA_UNAVAILABLE")):
            with self.assertRaisesRegex(RuntimeError, "ROLLBACK_REQUIRES_REVIEW"):
                app.replace(NEW_SHA, self.state)
        self.assertFalse(self.get(app.PREVIOUS)["State"]["Running"])
        self.assertNotIn(["docker", "start", app.APP + "-id"], self.events)
        self.assertFalse((self.state / "active-sha").exists())

    def test_uncertain_failed_container_removal_does_not_start_previous_or_claim_old_revision(self):
        self.fail_probe = (app.APP, NEW_SHA)
        self.fail_command = lambda e: e[:2] == ["docker", "rm"] and e[-1] == app.APP + "-new-id"
        with self.assertRaisesRegex(RuntimeError, "ROLLBACK_REQUIRES_REVIEW"):
            app.replace(NEW_SHA, self.state)
        self.assertNotIn(["docker", "start", app.APP + "-id"], self.events)
        self.assertFalse((self.state / "active-sha").exists())

    def test_disconnect_failure_recovers_old_without_deleting_it(self):
        self.fail_command = lambda e: e[:4] == ["docker", "network", "disconnect", "mw-dev-private"]
        with self.assertRaisesRegex(RuntimeError, "PREVIOUS_RESTORED"):
            app.replace(NEW_SHA, self.state)
        self.assertEqual(self.get(app.APP)["Image"], OLD_ID)
        self.assertTrue(self.get(app.APP)["State"]["Running"])
        self.assertFalse(any(e[:2] == ["docker", "rm"] and e[-1] == app.APP + "-id" for e in self.events))

    def test_existing_candidate_or_foreign_active_refuses_without_cleanup(self):
        self.containers.append(container(app.CANDIDATE))
        with self.assertRaisesRegex(RuntimeError, "CANDIDATE_EXISTS"):
            app.replace(NEW_SHA, self.state)
        self.assertEqual(self.events, [])
        self.containers.pop()
        self.get(app.APP)["Config"]["Labels"]["mw.environment"] = "production"
        with self.assertRaisesRegex(RuntimeError, "DEV_CONTAINER_REQUIRED"):
            app.replace(NEW_SHA, self.state)
        self.assertEqual(self.events, [])


if __name__ == "__main__":
    unittest.main()
