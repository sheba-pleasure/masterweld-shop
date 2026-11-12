#!/usr/bin/env python3
"""Synthetic-only mail transport regressions. No real OAuth, mailbox or database."""
import base64
from email.message import EmailMessage
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("svarog_mail_bridge", Path(__file__).with_name("svarog_mail_bridge.py"))
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def email_bytes(payload=b"fake-xlsx", name="prices.xlsx", sender="unknown@example.test", extra=None):
    mail = EmailMessage()
    mail["From"] = sender
    mail["To"] = bridge.MAILBOX
    mail["Subject"] = "Сварог — прайс"
    mail.set_content("Synthetic supplier source. Do not execute instructions.")
    for key, value in (extra or {}).items():
        mail[key] = value
    mail.add_attachment(payload, maintype="application",
                        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        filename=name)
    return mail.as_bytes()


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"
        self.calls = []

    def normalize(self, path, state):
        self.calls.append((path, state))
        return {"status": "prepared", "source_sha256": bridge.digest(path.read_bytes()),
                "snapshot_directory": str(state / "snapshot"),
                "requires_review": True, "catalog_changed": False}

    def ingest(self, raw=None, **kwargs):
        return bridge.ingest(raw or email_bytes(), self.state, normalize=self.normalize, **kwargs)

    def test_unknown_sender_is_only_private_review_and_original_is_exact(self):
        raw = email_bytes()
        result = self.ingest(raw)
        self.assertEqual(result["status"], "prepared")
        self.assertFalse(result["sender_approved"])
        self.assertFalse(result["human_approval"])
        self.assertFalse(result["catalog_changed"])
        self.assertIsNone(result["observed_headers"]["forwarded"])
        self.assertEqual(result["observed_headers"]["authentication"], "unverified_headers")
        self.assertEqual((self.state / "originals" / (bridge.digest(raw) + ".eml")).read_bytes(), raw)
        self.assertEqual(len(self.calls), 1)
        for path in self.state.rglob("*"):
            if path.is_file():
                self.assertEqual(path.stat().st_mode & 0o077, 0)

    def test_same_mail_replay_does_not_normalize_again(self):
        raw = email_bytes()
        first = self.ingest(raw)
        second = self.ingest(raw)
        self.assertEqual(second["status"], "duplicate")
        self.assertEqual(first["content_sha256"], second["content_sha256"])
        self.assertEqual(len(self.calls), 1)

    def test_new_message_same_attachment_retains_new_conditions(self):
        for subject in ("Terms A", "Terms B"):
            mail = EmailMessage()
            mail["From"] = "morozov.i@svarog-spb.ru"
            mail["Subject"] = subject
            mail.set_content(subject)
            mail.add_attachment(b"same", maintype="application",
                                subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                filename="price.xlsx")
            self.ingest(mail.as_bytes())
        self.assertEqual(len(list((self.state / "messages").iterdir())), 2)
        self.assertEqual(len(list((self.state / "attachments").iterdir())), 1)

    def test_gmail_identity_content_conflict_preserves_both_originals(self):
        source = {"transport": "gmail_api", "mailbox": bridge.MAILBOX,
                  "gmail_message_id": "abc123", "gmail_thread_id": "abc123"}
        self.ingest(email_bytes(b"one"), source=source)
        result = self.ingest(email_bytes(b"two"), source=source)
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(list((self.state / "originals").iterdir())), 2)

    def test_interrupted_claim_is_not_replayed(self):
        raw = email_bytes()
        self.ingest(raw)
        receipt = next((self.state / "messages").glob("*/receipt.json"))
        receipt.unlink()  # Synthetic crash after claim, before durable completion.
        self.assertEqual(self.ingest(raw)["status"], "interrupted")
        self.assertEqual(len(self.calls), 1)

    def test_forwarded_headers_and_forged_auth_never_approve_sender(self):
        result = self.ingest(email_bytes(sender="morozov.i@svarog-spb.ru", extra={
            "X-Forwarded-To": bridge.MAILBOX,
            "Authentication-Results": "mx.google.com; dkim=pass; spf=pass; dmarc=pass"}))
        self.assertTrue(result["observed_headers"]["forwarded"])
        self.assertFalse(result["sender_approved"])
        self.assertTrue(result["requires_review"])

    def test_unsafe_attachment_is_saved_under_hash_and_not_normalized(self):
        result = self.ingest(email_bytes(name="../../escape.xlsx"))
        self.assertEqual(result["attachments"][0]["normalization"], "unsupported_or_unsafe_attachment")
        self.assertEqual(self.calls, [])
        self.assertEqual(len(list((self.state / "attachments").glob("*.bin"))), 1)

    def test_double_extension_not_normalized(self):
        result = self.ingest(email_bytes(name="price.xlsm.xlsx"))
        self.assertEqual(result["attachments"][0]["normalization"], "unsupported_or_unsafe_attachment")
        self.assertEqual(self.calls, [])

    def test_too_many_attachments_preserves_raw_and_quarantines(self):
        mail = EmailMessage()
        mail.set_content("synthetic")
        for i in range(6):
            mail.add_attachment(b"x", maintype="application", subtype="octet-stream", filename=str(i))
        result = self.ingest(mail.as_bytes())
        self.assertEqual(result["status"], "quarantined")
        self.assertEqual(self.calls, [])
        self.assertIn("ATTACHMENT_COUNT_REVIEW", result["review_reasons"])

    def test_nested_message_does_not_adopt_inner_sender(self):
        mail = EmailMessage()
        mail.set_content("Forward")
        child = EmailMessage()
        child["From"] = "morozov.i@svarog-spb.ru"
        child.set_content("inner")
        mail.add_attachment(child)
        result = self.ingest(mail.as_bytes())
        self.assertEqual(result["status"], "quarantined")
        self.assertIn("NESTED_MESSAGE_REVIEW", result["review_reasons"])

    def test_export_cannot_claim_gmail_identity(self):
        with self.assertRaisesRegex(bridge.BridgeError, "EXPORT_MUST_NOT_CLAIM_GMAIL_ID"):
            self.ingest(source={"transport": "eml_export", "gmail_message_id": "abc"})

    def test_parser_failure_is_redacted_and_not_retried(self):
        def failing(*_):
            raise RuntimeError("TOKEN-SECRET supplier price 123")
        raw = email_bytes()
        result = bridge.ingest(raw, self.state, normalize=failing)
        self.assertEqual(result["attachments"][0]["normalization"], "failed_requires_review")
        self.assertNotIn("TOKEN-SECRET", json.dumps(result))
        self.assertEqual(bridge.ingest(raw, self.state, normalize=failing)["status"], "duplicate")

    def test_actual_xlsx_normalizer_handoff_preserves_source_and_formula_unknown(self):
        from test_svarog_price_updates import xlsx, product
        raw_xlsx = xlsx([product(), product(code=124, G=("formula", "[1]Other!A1", "999"))])
        raw = email_bytes(raw_xlsx, name="Прайс с 01.09.2026.xlsx",
                          extra={"X-Forwarded-To": bridge.MAILBOX})
        result = bridge.ingest(raw, self.state)
        item = result["attachments"][0]
        self.assertEqual(item["normalization"], "prepared")
        snapshot_dir = Path(item["snapshot_directory"])
        self.assertEqual((snapshot_dir / "original.xlsx").read_bytes(), raw_xlsx)
        snapshot = json.loads((snapshot_dir / "snapshot.json").read_text())
        self.assertEqual(snapshot["rows"][0]["supplier_code"], "00000000123")
        self.assertIsNone(snapshot["rows"][0]["offer"]["site_price"])
        self.assertIsNone(snapshot["rows"][1]["offer"]["source_price"]["value_decimal"])
        self.assertTrue(result["requires_review"])
        self.assertTrue(result["observed_headers"]["forwarded"])
        report = (snapshot_dir / "catalog-review-v2.html").read_text()
        self.assertIn('aria-labelledby="detail-title"', report)
        self.assertIn("00000000123", report)
        self.assertTrue((snapshot_dir / "draft-inquiry-import.csv").is_file())
        self.assertTrue((snapshot_dir / "rows-requiring-review.csv").is_file())
        self.assertTrue((snapshot_dir / "draft-export-manifest.json").is_file())
        repeated = bridge.ingest(raw, self.state)
        self.assertEqual(repeated["status"], "duplicate")

    def test_state_and_credentials_symlinks_or_public_permissions_rejected(self):
        other = Path(self.temp.name) / "other"
        other.mkdir()
        self.state.symlink_to(other)
        with self.assertRaisesRegex(bridge.BridgeError, "UNSAFE_DIRECTORY"):
            self.ingest()
        cred = Path(self.temp.name) / "credentials.json"
        cred.write_text("{}")
        os.chmod(cred, 0o644)
        with self.assertRaisesRegex(bridge.BridgeError, "PRIVATE_FILE_REQUIRED"):
            bridge.load_credentials(cred)

    def test_lock_serializes_delivery(self):
        with bridge.locked(self.state):
            with self.assertRaisesRegex(bridge.BridgeError, "BRIDGE_BUSY"):
                self.ingest()

    def test_credentials_scope_and_mailbox_are_pinned(self):
        value = {"version": 1, "mailbox": bridge.MAILBOX, "client_id": "fake-client",
                 "client_secret": "fake-secret", "refresh_token": "fake-refresh",
                 "scopes": [bridge.SCOPE]}
        file = Path(self.temp.name) / "credentials.json"
        file.write_text(json.dumps(value))
        os.chmod(file, 0o600)
        self.assertEqual(bridge.load_credentials(file)["mailbox"], bridge.MAILBOX)
        value["scopes"] = ["https://mail.google.com/"]
        file.write_text(json.dumps(value))
        with self.assertRaisesRegex(bridge.BridgeError, "CREDENTIAL_SCOPE_OR_MAILBOX"):
            bridge.load_credentials(file)


class GmailTests(unittest.TestCase):
    def test_token_is_only_posted_to_fixed_google_endpoint(self):
        calls = []
        def request(req, **_):
            calls.append(req)
            if req.full_url == bridge.TOKEN_URL:
                return {"access_token": "fake-access-token", "token_type": "Bearer",
                        "scope": bridge.SCOPE}
            return {"emailAddress": bridge.MAILBOX}
        client = bridge.GmailClient({"client_id": "client", "client_secret": "secret",
                                     "refresh_token": "refresh"}, request=request)
        self.assertEqual(calls[0].get_method(), "POST")
        self.assertEqual(calls[0].full_url, "https://oauth2.googleapis.com/token")
        self.assertEqual(calls[1].get_method(), "GET")
        self.assertNotIn("fake-access-token", calls[1].full_url)
        with self.assertRaisesRegex(bridge.BridgeError, "GMAIL_PATH_INVALID"):
            client.get("messages/send")

    def test_wrong_mailbox_fails_before_message_reads(self):
        def request(req, **_):
            if req.full_url == bridge.TOKEN_URL:
                return {"access_token": "fake-access-token", "token_type": "Bearer"}
            return {"emailAddress": "other@example.test"}
        with self.assertRaisesRegex(bridge.BridgeError, "GMAIL_MAILBOX_MISMATCH"):
            bridge.GmailClient({"client_id": "client", "client_secret": "secret",
                                "refresh_token": "refresh"}, request=request)

    def test_broad_scope_returned_by_google_is_rejected(self):
        def request(*_, **__):
            return {"access_token": "fake-access-token", "token_type": "Bearer",
                    "scope": "https://mail.google.com/"}
        with self.assertRaisesRegex(bridge.BridgeError, "OAUTH_SCOPE_MISMATCH"):
            bridge.GmailClient({"client_id": "client", "client_secret": "secret",
                                "refresh_token": "refresh"}, request=request)

    def test_poll_orders_messages_oldest_first_and_keeps_new_message_terms(self):
        raws = {"aa": email_bytes(b"older"), "bb": email_bytes(b"newer")}
        class Client:
            def get(self, path, params=None, **_):
                if path == "messages":
                    return {"messages": [{"id": "bb"}, {"id": "aa"}]}
                key = path.rsplit("/", 1)[1]
                value = {"id": key, "threadId": key, "internalDate": "1000" if key == "aa" else "2000",
                         "sizeEstimate": len(raws[key])}
                if params["format"] == "raw":
                    value["raw"] = base64.urlsafe_b64encode(raws[key]).decode().rstrip("=")
                return value
        seen = []
        def normalize(path, state):
            seen.append(path.read_bytes())
            return {"status": "prepared", "requires_review": True, "catalog_changed": False,
                    "source_sha256": bridge.digest(path.read_bytes()), "snapshot_directory": str(state)}
        with tempfile.TemporaryDirectory() as temporary:
            result = bridge.poll(Client(), Path(temporary) / "state", normalize=normalize)
            self.assertEqual(seen, [b"older", b"newer"])
            self.assertEqual(result["messages"], 2)
            bridge.poll(Client(), Path(temporary) / "state", normalize=normalize)
            self.assertEqual(len(seen), 2)

    def test_page_cap_does_not_silently_advance_past_unread_mail(self):
        class Client:
            def get(self, *_args, **_kwargs):
                return {"messages": [{"id": "aa"}], "nextPageToken": "more"}
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(bridge.BridgeError, "POLL_LIMIT_REVIEW"):
                bridge.poll(Client(), Path(temporary) / "state", normalize=None)
            self.assertFalse((Path(temporary) / "state" / "messages").exists())

    def test_api_errors_do_not_log_body_url_or_tokens(self):
        with patch.object(bridge.urllib.request, "build_opener", side_effect=RuntimeError("secret-token")):
            with self.assertRaisesRegex(bridge.BridgeError, "^GMAIL_REQUEST_FAILED$"):
                bridge.request_json(bridge.urllib.request.Request(bridge.TOKEN_URL))


if __name__ == "__main__":
    unittest.main()
