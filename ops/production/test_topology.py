"""Release topology must fail before side effects on malformed configuration."""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
KEYS = ("GATEWAY_PORT", "SLOT_A_PORT", "SLOT_B_PORT", "BACKEND_PORT",
        "MW_CONTAINER_PREFIX", "APP_NETWORK")


class TopologyTest(unittest.TestCase):
    def source(self, values):
        env = {k: v for k, v in os.environ.items() if k not in KEYS}
        env.update(values)
        return subprocess.run(["bash", "-c",
            'source "$1"; printf "%s %s %s %s %s %s %s" "$BIND_IP" "$GATEWAY_NAME" '
            '"$(slot_name b)" "$(slot_port a)" "$(slot_port b)" "$BACKEND_PORT" "$APP_NETWORK"',
            "topology-test", str(ROOT / "ops/lib.sh")],
            env=env, capture_output=True, text=True, timeout=5)

    def test_production_defaults_unchanged(self):
        r = self.source({})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "127.0.0.1 mw-shop-gateway mw-shop-slot-b 18081 18082 18084 mw-prod-edge")

    def test_isolated_resources_and_immutable_loopback(self):
        r = self.source({"GATEWAY_PORT": "29000", "SLOT_A_PORT": "29001",
                         "SLOT_B_PORT": "29002", "BACKEND_PORT": "29003",
                         "MW_CONTAINER_PREFIX": "mw-rehearsal-a1", "APP_NETWORK": "mw-rehearsal-a1-net",
                         "BIND_IP": "0.0.0.0"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "127.0.0.1 mw-rehearsal-a1-gateway mw-rehearsal-a1-slot-b 29001 29002 29003 mw-rehearsal-a1-net")

    def test_invalid_ports_refused(self):
        for value in ("80", "0", "65536", "018080", "18080;echo fail", "1234\n", "-1234"):
            with self.subTest(value=value):
                self.assertNotEqual(self.source({"GATEWAY_PORT": value}).returncode, 0)

    def test_collision_refused(self):
        for key in ("SLOT_A_PORT", "SLOT_B_PORT", "BACKEND_PORT"):
            with self.subTest(key=key):
                self.assertNotEqual(self.source({key: "18080"}).returncode, 0)

    def test_names_reject_configuration_injection(self):
        for key in ("MW_CONTAINER_PREFIX", "APP_NETWORK"):
            for value in ("../production", "-name", "a b", "name;exit", "x" * 64):
                with self.subTest(key=key, value=value):
                    self.assertNotEqual(self.source({key: value}).returncode, 0)


if __name__ == "__main__":
    unittest.main()
