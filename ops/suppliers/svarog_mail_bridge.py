#!/usr/bin/env python3
"""Private Svarog mail intake. No mailbox writes, catalog writes or message delivery."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import urllib.parse
import urllib.request

MAILBOX = "bkush7430@gmail.com"
SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
API = "https://gmail.googleapis.com/gmail/v1/users/me/"
TOKEN_URL = "https://oauth2.googleapis.com/token"
MAX_RAW = 35 * 1024 * 1024
MAX_ATTACHMENT = 5 * 1024 * 1024
MAX_ATTACHMENTS = 5
MAX_PAGES = 5
ID = re.compile(r"[0-9a-f]{1,32}\Z")
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STATE = ROOT / "ops/.state/suppliers/svarog-mail-bridge"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class BridgeError(ValueError):
    """Fixed codes only; never include email content, URLs or credentials."""


def require(condition, code):
    if not condition:
        raise BridgeError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"


def private_dir(path):
    path = Path(path).absolute()
    require(path.resolve() == path, "UNSAFE_DIRECTORY")
    if not path.exists():
        path.mkdir(mode=0o700, parents=True)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o077, "PRIVATE_DIRECTORY_REQUIRED")
    return path


def read_file(path, limit, private=False):
    path = Path(path).absolute()
    require(path.resolve() == path, "UNSAFE_FILE")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode), "REGULAR_FILE_REQUIRED")
        if private:
            require(info.st_uid == os.getuid() and not info.st_mode & 0o077,
                    "PRIVATE_FILE_REQUIRED")
        data = stream.read(limit + 1)
    require(len(data) <= limit, "FILE_LIMIT")
    return data


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def immutable(path, data):
    """Publish complete bytes once; a crash never creates a partial target."""
    private_dir(path.parent)
    if path.exists() or path.is_symlink():
        require(read_file(path, len(data), private=True) == data, "IMMUTABLE_CONFLICT")
        return
    fd, name = tempfile.mkstemp(prefix=".writing-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(name, path, follow_symlinks=False)
        except FileExistsError:
            require(read_file(path, len(data), private=True) == data, "IMMUTABLE_CONFLICT")
        fsync_dir(path.parent)
    finally:
        os.unlink(name)


@contextmanager
def locked(state):
    state = private_dir(state)
    fd = os.open(state / "bridge.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and not info.st_mode & 0o077, "PRIVATE_LOCK_REQUIRED")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BridgeError("BRIDGE_BUSY") from None
        yield state
    finally:
        os.close(fd)


def observed_headers(message):
    # Header claims remain unverified even when raw bytes came from Gmail API.
    # Forwarding can preserve From; absence of a marker is not evidence of no forwarding.
    addresses = getaddresses([str(x) for x in message.get_all("From", [])])
    senders = [address.lower() for _, address in addresses if address]
    forwarded = any(message.get(name) for name in
                    ("X-Forwarded-To", "X-Forwarded-For", "Resent-From", "Resent-To"))
    subject = str(message.get("Subject", ""))
    forwarded = forwarded or bool(re.match(r"\s*(fw|fwd|пересл)\s*:", subject, re.I))
    return {
        "from_addresses": senders[:10],
        "reply_to": [str(x)[:2048] for x in message.get_all("Reply-To", [])[:10]],
        "subject": subject[:2048],
        "date": str(message.get("Date", ""))[:256],
        "rfc_message_id": str(message.get("Message-ID", ""))[:512],
        "forwarded": True if forwarded else None,
        "authentication": "unverified_headers",
        "sender_approved": False,
    }


def attachment_parts(message):
    stack = [(message, 0)]
    result = []
    count = 0
    while stack:
        part, depth = stack.pop()
        count += 1
        require(count <= 100 and depth <= 20, "MIME_STRUCTURE_LIMIT")
        require(not part.defects, "MIME_DEFECT_REVIEW")
        # Never descend into an attached email and mistake its sender for the envelope.
        if part.get_content_type() == "message/rfc822":
            raise BridgeError("NESTED_MESSAGE_REVIEW")
        if part.is_multipart():
            stack.extend((child, depth + 1) for child in reversed(part.get_payload()))
        elif part.get_filename() is not None or part.get_content_disposition() == "attachment":
            result.append(part)
            require(len(result) <= MAX_ATTACHMENTS, "ATTACHMENT_COUNT_REVIEW")
    return result


def normalize_xlsx(path, state):
    # This module is an offline, bounded parser; it does not read credentials or use HTTP.
    from svarog_price_updates import intake, read_committed, write_review_export
    from svarog_report import build_report
    receipt = intake(path, state)
    directory = Path(receipt["snapshot_directory"])
    _, snapshot = read_committed(directory, receipt["source_sha256"])
    return receipt | {"review_report": build_report(state, receipt["source_sha256"]),
                      "draft_export": write_review_export(snapshot, directory)}


def valid_xlsx_name(name):
    if not isinstance(name, str) or not 0 < len(name) <= 255 or name != name.strip():
        return False
    if name.startswith(".") or ".." in name or any(c in name for c in "/\\:%"):
        return False
    import unicodedata
    if any(unicodedata.category(c).startswith("C") for c in name):
        return False
    pieces = name.lower().split(".")
    unsafe = {"exe", "com", "dll", "msi", "bat", "cmd", "ps1", "sh", "js", "vbs",
              "jar", "lnk", "html", "htm", "svg", "xlsm", "xlsb", "xlam", "zip",
              "rar", "7z", "eml", "msg"}
    return len(pieces) >= 2 and pieces[-1] == "xlsx" and not unsafe.intersection(pieces[1:-1])


def _ingest_locked(raw, state, source, normalize):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_RAW, "MESSAGE_SIZE_LIMIT")
    require(source.get("transport") in ("eml_export", "gmail_api"), "SOURCE_INVALID")
    content_hash = digest(raw)
    if source["transport"] == "gmail_api":
        require(source.get("mailbox") == MAILBOX
                and ID.fullmatch(source.get("gmail_message_id", "")) is not None
                and ID.fullmatch(source.get("gmail_thread_id", "")) is not None,
                "GMAIL_SOURCE_INVALID")
        identity = "gmail:" + MAILBOX + ":" + source["gmail_message_id"]
    else:
        require(set(source) == {"transport"}, "EXPORT_MUST_NOT_CLAIM_GMAIL_ID")
        identity = "eml:" + content_hash
    key = digest(identity.encode())
    originals = private_dir(state / "originals")
    immutable(originals / (content_hash + ".eml"), raw)
    directory = private_dir(state / "messages" / key)
    claim_path = directory / "claim.json"
    receipt_path = directory / "receipt.json"
    if claim_path.exists():
        claim = json.loads(read_file(claim_path, 8192, private=True))
        if claim.get("content_sha256") != content_hash:
            return {"status": "conflict", "requires_review": True, "catalog_changed": False,
                    "reason": "MESSAGE_ID_CONTENT_CONFLICT"}
        if receipt_path.exists():
            receipt = json.loads(read_file(receipt_path, 65536, private=True))
            return {**receipt, "status": "duplicate", "original_status": receipt["status"]}
        return {"status": "interrupted", "requires_review": True, "catalog_changed": False,
                "reason": "INCOMPLETE_CLAIM_NO_AUTOMATIC_REPLAY"}
    require(not receipt_path.exists(), "ORPHAN_RECEIPT_REVIEW")
    immutable(claim_path, encoded({"version": 1, "content_sha256": content_hash, **source}))
    receipt = {"version": 1, "status": "prepared", "content_sha256": content_hash,
               "source": source, "requires_review": True, "catalog_changed": False,
               "human_approval": False, "sender_approved": False,
               "attachments": [], "review_reasons": []}
    try:
        message = BytesParser(policy=policy.default).parsebytes(raw)
        receipt["observed_headers"] = observed_headers(message)
        parts = attachment_parts(message)
        immutable(directory / "source.json", encoded({
            "version": 1, **source, "content_sha256": content_hash,
            "observed_headers": receipt["observed_headers"],
            "requires_review": True, "human_approval": False}))
        for index, part in enumerate(parts):
            name = part.get_filename()
            data = part.get_payload(decode=True)
            require(type(data) is bytes and 0 < len(data) <= MAX_ATTACHMENT,
                    "ATTACHMENT_SIZE_REVIEW")
            require(not part.defects, "ATTACHMENT_ENCODING_REVIEW")
            sha = digest(data)
            usable = valid_xlsx_name(name) and part.get_content_type() == XLSX_MIME
            suffix = ".xlsx" if usable else ".bin"
            path = private_dir(state / "attachments") / (sha + suffix)
            immutable(path, data)
            item = {"index": index, "filename": str(name)[:512], "sha256": sha,
                    "size_bytes": len(data), "mime": part.get_content_type(),
                    "file": str(path), "needs_review": True, "normalization": "not_requested"}
            # Persist provenance BEFORE the normalizer's separate durable transaction.
            immutable(directory / ("attachment-" + str(index) + ".json"), encoded(item))
            if not usable:
                item["normalization"] = "unsupported_or_unsafe_attachment"
            elif normalize is not None:
                try:
                    # The workbook name can contain an asserted effective date. Preserve
                    # it for analysis without treating that date as confirmed. The common
                    # attachment store remains addressed by content hash.
                    named_path = private_dir(directory / "files" / str(index)) / name
                    immutable(named_path, data)
                    result = normalize(named_path, private_dir(state / "price-updates"))
                    require(result.get("requires_review") is True
                            and result.get("catalog_changed") is False,
                            "NORMALIZER_CONTRACT_FAILED")
                    item["normalization"] = result["status"]
                    item["normalized_source_sha256"] = result["source_sha256"]
                    item["snapshot_directory"] = result["snapshot_directory"]
                except Exception:
                    # Never persist arbitrary parser errors: they can contain supplier data.
                    item["normalization"] = "failed_requires_review"
                    receipt["review_reasons"].append("NORMALIZATION_REQUIRES_REVIEW")
            receipt["attachments"].append(item)
        if not parts:
            receipt["review_reasons"].append("NO_ATTACHMENTS_REVIEW_MESSAGE")
        receipt["review_reasons"].extend(["SENDER_NOT_APPROVED", "AUTHENTICATION_NOT_VERIFIED"])
    except Exception as error:
        receipt["status"] = "quarantined"
        code = str(error) if isinstance(error, BridgeError) else "MESSAGE_PARSE_REVIEW"
        receipt["review_reasons"].append(code)
    immutable(receipt_path, encoded(receipt))
    return receipt


def ingest(raw, state, source=None, normalize=normalize_xlsx):
    with locked(state) as state:
        return _ingest_locked(raw, state, source or {"transport": "eml_export"}, normalize)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def request_json(request, limit=1024 * 1024):
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            raw = response.read(limit + 1)
        require(len(raw) <= limit, "HTTP_RESPONSE_LIMIT")
        value = json.loads(raw)
        require(type(value) is dict, "HTTP_JSON_INVALID")
        return value
    except BridgeError:
        raise
    except Exception:
        # HTTP error bodies, URLs and tokens must never enter logs.
        raise BridgeError("GMAIL_REQUEST_FAILED") from None


def load_credentials(path):
    require(path is not None, "CREDENTIALS_REQUIRED")
    value = json.loads(read_file(path, 16384, private=True))
    require(type(value) is dict and set(value) ==
            {"version", "mailbox", "client_id", "client_secret", "refresh_token", "scopes"},
            "CREDENTIAL_SCHEMA")
    require(type(value["version"]) is int and value["version"] == 1
            and value["mailbox"] == MAILBOX and value["scopes"] == [SCOPE],
            "CREDENTIAL_SCOPE_OR_MAILBOX")
    for key in ("client_id", "client_secret", "refresh_token"):
        require(type(value[key]) is str and 8 <= len(value[key]) <= 8192
                and not any(ord(c) < 33 for c in value[key]), "CREDENTIAL_VALUE")
    return value


class GmailClient:
    def __init__(self, credentials, request=request_json):
        self.request = request
        form = urllib.parse.urlencode({
            "client_id": credentials["client_id"],
            "client_secret": credentials["client_secret"],
            "refresh_token": credentials["refresh_token"],
            "grant_type": "refresh_token",
        }).encode()
        token = request(urllib.request.Request(TOKEN_URL, data=form, headers={
            "Content-Type": "application/x-www-form-urlencoded"}))
        require(isinstance(token.get("access_token"), str)
                and 8 <= len(token["access_token"]) <= 8192
                and not any(ord(c) < 33 for c in token["access_token"])
                and token.get("token_type", "").lower() == "bearer", "OAUTH_RESPONSE_INVALID")
        # The grant is requested separately as readonly. Reject wider scopes if returned.
        if "scope" in token:
            require(set(token["scope"].split()) == {SCOPE}, "OAUTH_SCOPE_MISMATCH")
        self.token = token["access_token"]
        require(self.get("profile").get("emailAddress", "").lower() == MAILBOX,
                "GMAIL_MAILBOX_MISMATCH")

    def get(self, path, params=None, limit=1024 * 1024):
        require(path in ("profile", "messages") or
                re.fullmatch(r"messages/[0-9a-f]{1,32}", path), "GMAIL_PATH_INVALID")
        url = API + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return self.request(urllib.request.Request(url, headers={
            "Authorization": "Bearer " + self.token}), limit=limit)


def search_query(since):
    try:
        date = datetime.strptime(since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        require(date.strftime("%Y-%m-%d") == since, "SINCE_DATE_INVALID")
    except ValueError:
        raise BridgeError("SINCE_DATE_INVALID") from None
    return ("after:" + str(int(date.timestamp())) +
            " -in:spam -in:trash {from:svarog-spb.ru from:svarog-rf.ru "
            "{from:info@masterweld.ru {svarog Сварог}}}")


def _poll_locked(client, state, since, normalize):
    token = None
    messages = {}
    for _ in range(MAX_PAGES):
        params = {"q": search_query(since), "maxResults": 100}
        if token:
            params["pageToken"] = token
        page = client.get("messages", params)
        rows = page.get("messages", [])
        require(type(rows) is list and len(rows) <= 100, "GMAIL_LIST_INVALID")
        for row in rows:
            require(type(row) is dict and ID.fullmatch(row.get("id", "")) is not None,
                    "GMAIL_ID_INVALID")
            messages[row["id"]] = row
        token = page.get("nextPageToken")
        if not token:
            break
        require(type(token) is str and len(token) <= 2048, "GMAIL_PAGE_TOKEN_INVALID")
    require(not token, "POLL_LIMIT_REVIEW")
    # Gmail returns newest first. Sort by delivery time so the comparison baseline
    # advances in delivery order, never by whichever API page happened to arrive first.
    ordered = []
    for message_id in messages:
        meta = client.get("messages/" + message_id,
                          {"format": "metadata", "fields": "id,threadId,internalDate,sizeEstimate"})
        require(meta.get("id") == message_id
                and ID.fullmatch(meta.get("threadId", "")) is not None
                and re.fullmatch(r"[0-9]{1,16}", str(meta.get("internalDate", ""))) is not None,
                "GMAIL_METADATA_INVALID")
        require(type(meta.get("sizeEstimate")) is int and 0 < meta["sizeEstimate"] <= MAX_RAW,
                "MESSAGE_SIZE_LIMIT")
        ordered.append((int(meta["internalDate"]), message_id, meta["threadId"]))
    counts = {}
    normalization_failures = 0
    for received, message_id, thread_id in sorted(ordered):
        value = client.get("messages/" + message_id, {"format": "raw"},
                           limit=(MAX_RAW * 4 // 3) + 65536)
        require(value.get("id") == message_id and value.get("threadId") == thread_id
                and isinstance(value.get("raw"), str), "GMAIL_RAW_INVALID")
        try:
            text = value["raw"].encode("ascii")
            raw = base64.b64decode(text + b"=" * (-len(text) % 4),
                                   altchars=b"-_", validate=True)
        except Exception:
            raise BridgeError("GMAIL_RAW_INVALID") from None
        result = _ingest_locked(raw, state, {
            "transport": "gmail_api", "mailbox": MAILBOX,
            "gmail_message_id": message_id, "gmail_thread_id": thread_id,
            "received_unix_ms": received}, normalize)
        counts[result["status"]] = counts.get(result["status"], 0) + 1
        normalization_failures += sum(item.get("normalization") == "failed_requires_review"
                                      for item in result.get("attachments", []))
    errors = normalization_failures or any(counts.get(key) for key in
                                          ("conflict", "interrupted", "quarantined"))
    return {"status": "polled_with_review_errors" if errors else "polled",
            "messages": len(ordered), "results": counts,
            "normalization_failures": normalization_failures,
            "requires_review": True, "catalog_changed": False}


def poll(client, state, since="2026-11-11", normalize=normalize_xlsx):
    with locked(state) as state:
        return _poll_locked(client, state, since, normalize)


def public_result(result):
    allowed = ("status", "original_status", "requires_review", "catalog_changed",
               "reason", "messages", "results", "normalization_failures")
    output = {key: result[key] for key in allowed if key in result}
    if "attachments" in result:
        output["attachments"] = len(result["attachments"])
        output["normalization"] = [item["normalization"] for item in result["attachments"]]
    return output


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    commands = parser.add_subparsers(dest="command", required=True)
    local = commands.add_parser("ingest-eml")
    local.add_argument("--eml", type=Path, required=True)
    local.add_argument("--save-only", action="store_true")
    remote = commands.add_parser("poll")
    remote.add_argument("--credentials", type=Path,
                        default=os.environ.get("MW_SVAROG_GMAIL_CREDENTIALS"))
    remote.add_argument("--since", default="2026-11-11")
    remote.add_argument("--opt-in", action="store_true")
    args = parser.parse_args()
    if args.command == "ingest-eml":
        result = ingest(read_file(args.eml, MAX_RAW), args.state,
                        normalize=None if args.save_only else normalize_xlsx)
    else:
        require(args.opt_in, "POLL_DISABLED")
        credentials = load_credentials(args.credentials)
        with locked(args.state) as state:
            result = _poll_locked(GmailClient(credentials), state, args.since, normalize_xlsx)
    print(json.dumps(public_result(result), ensure_ascii=False))
    return 0 if result["status"] in ("prepared", "duplicate", "polled") else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error) if isinstance(error, BridgeError) else "MAIL_BRIDGE_FAILED"
        print(json.dumps({"status": "failed", "code": code,
                          "requires_review": True, "catalog_changed": False}))
        raise SystemExit(2)
