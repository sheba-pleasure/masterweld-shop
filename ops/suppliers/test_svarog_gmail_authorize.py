"""Synthetic bootstrap tests: no real Google account, tokens, mail or browser."""
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import urllib.request

import svarog_gmail_authorize as auth

CLIENT = {"client_id": "synthetic.apps.googleusercontent.com", "client_secret": "synthetic-client-secret"}
CODE, VERIFIER = "synthetic-authorization-code", "synthetic-pkce-verifier"
TOKEN = {"access_token": "synthetic-access-token", "refresh_token": "synthetic-refresh-token",
         "token_type": "Bearer", "scope": auth.SCOPE}
CREDENTIALS = {"version": 1, "mailbox": auth.MAILBOX, **CLIENT,
               "refresh_token": TOKEN["refresh_token"], "scopes": [auth.SCOPE]}


class AuthorizeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.client_path = self.folder / "client.json"
        self.client_path.write_text(json.dumps({"installed": {
            **CLIENT, "project_id": auth.PROJECT, "auth_uri": auth.AUTH_URL,
            "token_uri": auth.TOKEN_URL, "redirect_uris": ["http://localhost"]}}))
        self.output = self.folder / "grant.json"

    def test_downloaded_desktop_client_only_and_pinned_project_endpoints(self):
        self.assertEqual(auth.load_client(self.client_path), CLIENT)
        original = json.loads(self.client_path.read_text())
        legacy = {"installed": {**original["installed"], "auth_uri": "https://accounts.google.com/o/oauth2/auth"}}
        self.client_path.write_text(json.dumps(legacy))
        self.assertEqual(auth.load_client(self.client_path), CLIENT)
        variants = [
            {"web": original["installed"]},
            {"installed": {**original["installed"], "token_uri": "https://attacker.invalid/token"}},
            {"installed": {**original["installed"], "auth_uri": "https://attacker.invalid/auth"}},
            {"installed": {**original["installed"], "project_id": "another-project"}},
        ]
        for value in variants:
            self.client_path.write_text(json.dumps(value))
            with self.assertRaises(auth.AuthorizeError):
                auth.load_client(self.client_path)

    def test_client_symlink_and_large_file_rejected(self):
        linked = self.folder / "linked.json"
        linked.symlink_to(self.client_path)
        with self.assertRaises(auth.AuthorizeError):
            auth.load_client(linked)
        self.client_path.write_bytes(b"x" * (auth.MAX_JSON + 1))
        with self.assertRaisesRegex(auth.AuthorizeError, "TOO_LARGE"):
            auth.load_client(self.client_path)

    def test_callback_binding_rejects_forgery_duplicate_state_and_absolute_target(self):
        good = "/?" + urllib.parse.urlencode({"state": "expected-state", "code": CODE})
        self.assertEqual(auth.parse_callback(good, "127.0.0.1:1", "127.0.0.1:1", "expected-state"), CODE)
        for target, host in [
            (good, "attacker.invalid"), (good.replace("expected-state", "wrong-state"), "127.0.0.1:1"),
            (good + "&state=expected-state", "127.0.0.1:1"),
            ("http://attacker.invalid" + good, "127.0.0.1:1"), ("/wrong" + good, "127.0.0.1:1"),
        ]:
            with self.assertRaises(auth.AuthorizeError):
                auth.parse_callback(target, host, "127.0.0.1:1", "expected-state")
        with self.assertRaisesRegex(auth.AuthorizeError, "CONSENT_NOT_GRANTED"):
            auth.parse_callback("/?state=expected-state&error=access_denied",
                                "127.0.0.1:1", "127.0.0.1:1", "expected-state")

    def test_real_loopback_pkce_and_invalid_request_do_not_consume_login(self):
        observed, errors, threads = {}, [], []
        def browser(url):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            observed.update(query)
            redirect = query["redirect_uri"][0]
            self.assertEqual(urllib.parse.urlsplit(redirect).hostname, "127.0.0.1")
            def submit():
                try:
                    bad = redirect + "?" + urllib.parse.urlencode({"state": "forged", "code": CODE})
                    with self.assertRaises(urllib.error.HTTPError) as failure:
                        urllib.request.urlopen(bad, timeout=3)
                    self.assertEqual(failure.exception.code, 400)
                    good = redirect + "?" + urllib.parse.urlencode({"state": query["state"][0], "code": CODE})
                    with urllib.request.urlopen(good, timeout=3) as response:
                        self.assertEqual(response.status, 200)
                        self.assertNotIn(CODE.encode(), response.read())
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=submit)
            threads.append(thread)
            thread.start()
            return True
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            code, verifier, redirect = auth.authorize_code(CLIENT, timeout=5, open_browser=browser)
        for thread in threads:
            thread.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(code, CODE)
        self.assertEqual(observed["scope"], [auth.SCOPE])
        self.assertEqual(observed["access_type"], ["offline"])
        self.assertEqual(observed["prompt"], ["consent"])
        self.assertEqual(observed["code_challenge_method"], ["S256"])
        expected = auth.base64.urlsafe_b64encode(auth.hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        self.assertEqual(observed["code_challenge"], [expected])
        self.assertGreaterEqual(len(verifier), 43)
        self.assertNotIn(CLIENT["client_secret"], str(observed))
        self.assertEqual(output.getvalue(), "")
        with self.assertRaises(urllib.error.URLError):
            urllib.request.urlopen(redirect, timeout=1)

    def test_browser_failure_and_timeout_close_without_grant(self):
        for callback, timeout, code in [(lambda _: False, 1, "BROWSER_OPEN_FAILED"),
                                         (lambda _: True, 0, "CONSENT_TIMEOUT")]:
            with self.assertRaisesRegex(auth.AuthorizeError, code):
                auth.authorize_code(CLIENT, timeout=timeout, open_browser=callback)

    def test_exchange_is_bound_to_pkce_redirect_and_actual_mailbox(self):
        requests = []
        def request(value):
            requests.append(value)
            return TOKEN if len(requests) == 1 else {"emailAddress": auth.MAILBOX}
        result = auth.obtain_credentials(CLIENT, CODE, VERIFIER, "http://127.0.0.1:1/", request)
        self.assertEqual(result, CREDENTIALS)
        self.assertEqual([item.full_url for item in requests], [auth.TOKEN_URL, auth.PROFILE_URL])
        form = urllib.parse.parse_qs(requests[0].data.decode())
        self.assertEqual(form["code_verifier"], [VERIFIER])
        self.assertEqual(form["redirect_uri"], ["http://127.0.0.1:1/"])
        self.assertEqual(form["grant_type"], ["authorization_code"])
        self.assertEqual(requests[1].get_method(), "GET")

    def test_missing_or_expanded_scope_and_missing_refresh_fail_before_profile(self):
        for token in [{**TOKEN, "scope": auth.SCOPE + " https://mail.google.com/"},
                      {key: value for key, value in TOKEN.items() if key != "scope"},
                      {key: value for key, value in TOKEN.items() if key != "refresh_token"}]:
            calls = []
            def request(value):
                calls.append(value)
                return token
            with self.assertRaises(auth.AuthorizeError):
                auth.obtain_credentials(CLIENT, CODE, VERIFIER, "http://127.0.0.1:1/", request)
            self.assertEqual(len(calls), 1)

    def test_wrong_mailbox_is_rejected(self):
        responses = iter([TOKEN, {"emailAddress": "different@gmail.com"}])
        with self.assertRaisesRegex(auth.AuthorizeError, "MAILBOX_MISMATCH"):
            auth.obtain_credentials(CLIENT, CODE, VERIFIER, "http://127.0.0.1:1/",
                                    lambda _: next(responses))
        self.assertFalse(self.output.exists())

    def test_http_is_pinned_bounded_and_redacted_and_redirects_refused(self):
        with self.assertRaisesRegex(auth.AuthorizeError, "ENDPOINT_REJECTED"):
            auth.request_json(urllib.request.Request("https://attacker.invalid/token"))
        self.assertIsNone(auth.NoRedirect().redirect_request(None))
        with patch.object(auth.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = RuntimeError("secret " + CODE)
            with self.assertRaises(auth.AuthorizeError) as failure:
                auth.request_json(urllib.request.Request(auth.TOKEN_URL))
            self.assertEqual(str(failure.exception), "GOOGLE_REQUEST_FAILED")
        with patch.object(auth.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value.read.return_value = b"x" * (auth.MAX_JSON + 1)
            with self.assertRaisesRegex(auth.AuthorizeError, "RESPONSE_TOO_LARGE"):
                auth.request_json(urllib.request.Request(auth.TOKEN_URL))

    def test_private_file_bridge_compatibility_and_no_overwrite(self):
        auth.save_credentials(auth.output_path(self.output), CREDENTIALS)
        import svarog_mail_bridge as bridge
        self.assertEqual(bridge.load_credentials(self.output), CREDENTIALS)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            auth.save_credentials(self.output, {**CREDENTIALS, "refresh_token": "changed-value"})
        self.assertEqual(json.loads(self.output.read_text()), CREDENTIALS)
        with self.assertRaisesRegex(auth.AuthorizeError, "OUTPUT_ALREADY_EXISTS"):
            auth.output_path(self.output)

    def test_posix_public_directory_rejected_before_secret_write(self):
        self.folder.chmod(0o755)
        with self.assertRaisesRegex(auth.AuthorizeError, "DIRECTORY_NOT_PRIVATE"):
            auth.save_credentials(self.output, CREDENTIALS)
        self.assertFalse(self.output.exists())

    def test_public_output_directory_fails_before_browser_or_consent(self):
        self.folder.chmod(0o755)
        with patch.object(auth, "authorize_code") as browser, redirect_stderr(io.StringIO()):
            result = auth.main(["--client-config", str(self.client_path), "--output", str(self.output)])
        self.assertEqual(result, 2)
        browser.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_windows_acl_requires_exact_owner_protected_allow_and_persistent_storage(self):
        good = [True, 0x1004, 1, 0, 0, 0x001F01FF, True, 0x8]
        auth.verify_windows_acl(*good)
        for index, bad_value in enumerate([False, 4, 2, 1, 16, 0x001F01FE, False, 0]):
            bad = good.copy()
            bad[index] = bad_value
            with self.assertRaisesRegex(auth.AuthorizeError, "PRIVATE_ACL_REQUIRED"):
                auth.verify_windows_acl(*bad)

    def test_windows_acl_failure_never_falls_back_to_chmod(self):
        with patch.object(auth.os, "name", "nt"), \
                patch.object(auth, "windows_private_fd", side_effect=auth.AuthorizeError("WINDOWS_PRIVATE_ACL_REQUIRED")), \
                patch.object(auth.os, "open") as ordinary_open:
            with self.assertRaises(auth.AuthorizeError):
                auth.save_credentials(self.output, CREDENTIALS)
            ordinary_open.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_main_redacts_unexpected_exception_and_creates_nothing(self):
        printed = io.StringIO()
        with patch.object(auth, "authorize_code", return_value=(CODE, VERIFIER, "http://127.0.0.1:1/")), \
                patch.object(auth, "obtain_credentials", side_effect=RuntimeError(CLIENT["client_secret"] + CODE)), \
                redirect_stdout(printed), redirect_stderr(printed):
            result = auth.main(["--client-config", str(self.client_path), "--output", str(self.output)])
        self.assertEqual(result, 2)
        self.assertNotIn(CODE, printed.getvalue())
        self.assertNotIn(CLIENT["client_secret"], printed.getvalue())
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
