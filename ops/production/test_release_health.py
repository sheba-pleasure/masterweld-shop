"""Real loopback HTTP checks for release identity; no Docker, GitHub or shop data."""
import json
import os
from pathlib import Path
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40


class ReleaseHealthTest(unittest.TestCase):
    def setUp(self):
        self.responses = []
        self.requests = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                fixture.requests.append((self.path, self.headers.get("Cache-Control")))
                status, body = fixture.responses.pop(0) if len(fixture.responses) > 1 else fixture.responses[0]
                payload = body.encode() if isinstance(body, str) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def check_http(self, responses, wait=False):
        self.responses = responses
        return subprocess.run(
            ["bash", "-c", 'source "$1"; ' + ("wait_release" if wait else "release_matches") + ' "$2" "$3"',
             "mw-test", str(ROOT / "ops/lib.sh"), self.base, SHA],
            env={**os.environ, "HEALTH_TRIES": "2", "HEALTH_SLEEP": "0"},
            capture_output=True, text=True, timeout=15)

    def test_exact_production_response_and_uncached_request(self):
        result = self.check_http([(200, {"ready": True, "revision": SHA, "environment": "production"})])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests, [("/api/public/release-health?expected=" + SHA, "no-cache")])

    def test_successful_http_is_not_enough(self):
        for response in (
            {"ready": True, "revision": "b" * 40, "environment": "production"},
            {"ready": True, "revision": SHA, "environment": "dev"},
            {"ready": False, "revision": SHA, "environment": "production"},
            {"ready": 1, "revision": SHA, "environment": "production"},
            {"ready": True, "revision": SHA, "environment": "production", "unexpected": "private-value"},
            "not JSON",
            "x" * 4096,
        ):
            with self.subTest(response=str(response)[:80]):
                self.assertNotEqual(self.check_http([(200, response)]).returncode, 0)

    def test_unavailable_endpoint_refused(self):
        result = self.check_http([(503, {"ready": False})])
        self.assertNotEqual(result.returncode, 0)

    def test_reload_waits_for_exact_new_version(self):
        result = self.check_http([
            (200, {"ready": True, "revision": "b" * 40, "environment": "production"}),
            (200, {"ready": True, "revision": SHA, "environment": "production"}),
        ], wait=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.requests), 2)

    def test_wrong_upstream_cannot_eventually_pass_by_http_status(self):
        result = self.check_http([(200, {"ready": True, "revision": "b" * 40, "environment": "production"})], wait=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.requests), 2)


if __name__ == "__main__":
    unittest.main()
