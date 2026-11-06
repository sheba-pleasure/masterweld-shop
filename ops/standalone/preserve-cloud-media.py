#!/usr/bin/env python3
"""Preserve original catalog image bytes privately; never publish or rewrite database URLs."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("media_snapshot", Path(__file__).with_name("verify-cloud-snapshot.py"))
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 25_000_000
HOST = "masterweld.ru"
FORMAT = "masterweld-private-media-v1"
PILLOW_VERSION = "12.3.0"


class MediaError(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise MediaError(code)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def request_url(original):
    require(isinstance(original, str) and len(original) <= 4096 and
            not any(ord(c) < 32 or ord(c) == 127 for c in original), "URL_INVALID")
    try:
        p = urllib.parse.urlsplit(original)
        require(p.scheme == "https" and p.netloc == HOST and p.hostname == HOST
                and not p.username and not p.password and not p.query and not p.fragment, "URL_NOT_ALLOWED")
        require(p.path.startswith("/") and "\\" not in p.path, "URL_PATH_INVALID")
        require(not re.search(r"%(?![0-9a-fA-F]{2})", p.path), "URL_ESCAPE_INVALID")
        return urllib.parse.urlunsplit(("https", HOST, urllib.parse.quote(p.path, safe="/%:@!$&'()*+,;=-._~"), "", ""))
    except ValueError:
        raise MediaError("URL_INVALID") from None


def check_dns():
    addresses = socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM)
    require(addresses and all(ipaddress.ip_address(a[4][0]).is_global for a in addresses), "SOURCE_ADDRESS_NOT_PUBLIC")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


@contextmanager
def deadline(seconds):
    # This CLI is single-threaded on Linux. Limit whole requests, including slow bodies/DNS.
    def expired(_signum, _frame):
        raise MediaError("FETCH_DEADLINE")
    previous = signal.signal(signal.SIGALRM, expired)
    old_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, *old_timer)
        signal.signal(signal.SIGALRM, previous)


def decoder():
    try:
        import PIL
        from PIL import Image, ImageFile
    except ImportError:
        raise MediaError("MEDIA_DECODER_MISSING") from None
    require(PIL.__version__ == PILLOW_VERSION, "MEDIA_DECODER_VERSION_MISMATCH")
    return Image, ImageFile


def image_details(raw, content_type=None):
    Image, ImageFile = decoder()
    require(0 < len(raw) <= MAX_BYTES, "IMAGE_SIZE_INVALID")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw), formats=["JPEG", "PNG"]) as picture:
                kind = picture.format
                width, height = picture.size
                require(0 < width * height <= MAX_PIXELS, "IMAGE_PIXELS_INVALID")
                require(getattr(picture, "n_frames", 1) == 1, "ANIMATED_IMAGE_REQUIRES_REVIEW")
                picture.verify()
            with Image.open(io.BytesIO(raw), formats=["JPEG", "PNG"]) as picture:
                picture.load()  # Header/magic alone does not prove that the file decodes.
    except MediaError:
        raise
    except Exception:
        raise MediaError("IMAGE_DECODE_FAILED") from None
    mime = {"JPEG": "image/jpeg", "PNG": "image/png"}[kind]
    require(content_type is None or content_type.split(";")[0].strip().lower() == mime, "IMAGE_MIME_MISMATCH")
    return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "mime": mime,
            "width": width, "height": height, "extension": "jpg" if kind == "JPEG" else "png"}


def fetch(original, opener=None):
    current = request_url(original)
    opener = opener or urllib.request.build_opener(NoRedirect)
    with deadline(25):
        check_dns()
        for hop in range(4):
            try:
                response = opener.open(urllib.request.Request(current, headers={
                    "User-Agent": "MasterWeld-Archive/1.0", "Accept": "image/jpeg,image/png",
                    "Accept-Encoding": "identity"}), timeout=8)
            except urllib.error.HTTPError as error:
                code, location = error.code, error.headers.get("Location")
                error.close()
                if code in (301, 302, 303, 307, 308) and location:
                    require(hop < 3, "REDIRECT_LIMIT")
                    current = request_url(urllib.parse.urljoin(current, location))
                    continue
                raise MediaError("HTTP_" + str(code)) from None
            with response:
                require(response.status == 200, "HTTP_STATUS_INVALID")
                require(response.geturl() == current, "UNEXPECTED_REDIRECT")
                require(response.headers.get("Content-Encoding", "identity") == "identity", "ENCODING_NOT_ALLOWED")
                mime = response.headers.get("Content-Type", "")
                require(mime.split(";")[0].strip().lower() in ("image/jpeg", "image/png"), "IMAGE_MIME_NOT_ALLOWED")
                length = response.headers.get("Content-Length")
                require(length is None or length.isdecimal(), "CONTENT_LENGTH_INVALID")
                require(length is None or 0 < int(length) <= MAX_BYTES, "IMAGE_SIZE_INVALID")
                body = bytearray()
                while True:
                    part = response.read(min(65536, MAX_BYTES + 1 - len(body)))
                    if not part:
                        break
                    body.extend(part)
                    require(len(body) <= MAX_BYTES, "IMAGE_TOO_LARGE")
                require(length is None or len(body) == int(length), "CONTENT_LENGTH_MISMATCH")
                raw = bytes(body)
                return raw, image_details(raw, mime), current
    raise MediaError("FETCH_FAILED")


def error_code(error):
    if isinstance(error, MediaError):
        return str(error)
    reason = getattr(error, "reason", error)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return "TLS_CERTIFICATE_FAILED"
    if isinstance(reason, TimeoutError):
        return "NETWORK_TIMEOUT"
    return "NETWORK_FAILED"


def atomic_json(path, value):
    if path.exists() or path.is_symlink():
        snapshot.private(path)
    temporary = path.parent / ("." + path.name + "." + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def source_plan(manifest, payloads, verified):
    rows = json.loads(payloads["product_photos"])
    product_ids = {r["id"] for r in json.loads(payloads["products"])}
    require(len({r["id"] for r in rows}) == len(rows), "DUPLICATE_PHOTO_ID")
    assets = {}
    for row in rows:
        require(row["product_id"] in product_ids, "ORPHAN_PHOTO")
        url = row["url"]
        request_url(url)
        key = hashlib.sha256(url.encode()).hexdigest()
        entry = assets.setdefault(key, {"sourceUrl": url, "requestUrl": request_url(url), "photoIds": [],
                                       "productIds": [], "status": "pending", "attempts": 0})
        entry["photoIds"].append(row["id"])
        entry["productIds"].append(row["product_id"])
    return {"format": FORMAT, "sourceSnapshot": manifest["source_snapshot"],
            "sourcePhotosSha256": verified["tables"]["product_photos"]["sha256"],
            "assets": dict(sorted(assets.items()))}


def object_path(folder, details):
    require(re.fullmatch(r"[0-9a-f]{64}", details["sha256"]) and
            details["extension"] in ("jpg", "png"), "OBJECT_PATH_INVALID")
    return folder / "objects" / (details["sha256"] + "." + details["extension"])


def store_object(folder, raw, details):
    path = object_path(folder, details)
    if path.exists() or path.is_symlink():
        snapshot.private(path)
        require(path.read_bytes() == raw, "EXISTING_OBJECT_CORRUPT")
        return
    temporary = path.parent / (".part-" + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.link(temporary, path)  # No replacement of existing original bytes.
        directory_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def verify_state(folder, state, expected):
    for key in ("format", "sourceSnapshot", "sourcePhotosSha256"):
        require(state[key] == expected[key], "MEDIA_SOURCE_CHANGED")
    require(set(state["assets"]) == set(expected["assets"]), "MEDIA_SOURCE_CHANGED")
    for key, entry in state["assets"].items():
        for field in ("sourceUrl", "requestUrl", "photoIds", "productIds"):
            require(entry[field] == expected["assets"][key][field], "MEDIA_MAPPING_CHANGED")
        require(entry["status"] in ("pending", "failed", "saved") and
                type(entry["attempts"]) is int and entry["attempts"] >= 0, "MEDIA_STATE_INVALID")
        if entry["status"] == "saved":
            details = entry["image"]
            path = object_path(folder, details)
            snapshot.private(path)
            require(path.stat().st_size <= MAX_BYTES, "STORED_IMAGE_TOO_LARGE")
            raw = path.read_bytes()
            require(hashlib.sha256(raw).hexdigest() == details["sha256"] and
                    image_details(raw) == details, "STORED_IMAGE_CORRUPT")
            require(request_url(entry["finalUrl"]) == entry["finalUrl"], "MEDIA_FINAL_URL_INVALID")


def collect(folder, state, limit, retry_failed=False, fetcher=fetch):
    attempted = saved = failures = consecutive = 0
    stopped = "eligible_exhausted"
    for entry in state["assets"].values():
        if entry["status"] == "saved" or (entry["status"] == "failed" and not retry_failed):
            continue
        if attempted >= limit:
            stopped = "limit"
            break
        attempted += 1
        entry["attempts"] += 1
        entry["attemptedAt"] = stamp()
        try:
            raw, details, final_url = fetcher(entry["sourceUrl"])
        except (MediaError, urllib.error.URLError, OSError) as error:
            entry.update({"status": "failed", "error": error_code(error)})
            failures += 1
            consecutive += 1
        else:
            # Disk/integrity errors must stop the run, not be disguised as an unavailable URL.
            store_object(folder, raw, details)
            entry.update({"status": "saved", "image": details, "finalUrl": final_url})
            entry.pop("error", None)
            saved += 1
            consecutive = 0
        atomic_json(folder / "manifest.json", state)
        if consecutive == 3:
            stopped = "consecutive_failures"
            break
        time.sleep(.2)
    return {"attempted": attempted, "savedThisRun": saved, "failedThisRun": failures, "stopped": stopped}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("--fetch", action="store_true", help="Fetch pending URLs; default only prepares/verifies local inventory")
    parser.add_argument("--limit", type=int, default=10, help="Maximum URLs attempted this run (1..1015)")
    parser.add_argument("--retry-failed", action="store_true", help="Explicitly include previously failed URLs")
    args = parser.parse_args()
    decoder()
    require(1 <= args.limit <= 1015, "LIMIT_INVALID")
    require(not args.retry_failed or args.fetch, "RETRY_REQUIRES_FETCH")
    archive = Path(os.path.abspath(args.archive))
    manifest, _, payloads, verified = snapshot.verify(archive)
    expected = source_plan(manifest, payloads, verified)
    folder = archive / "media"
    folder.mkdir(mode=0o700, exist_ok=True)
    snapshot.private(folder, True)
    objects = folder / "objects"
    objects.mkdir(mode=0o700, exist_ok=True)
    snapshot.private(objects, True)
    fd = os.open(folder / "operation.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        snapshot.private(folder / "operation.lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise MediaError("MEDIA_OPERATION_BUSY") from None
        path = folder / "manifest.json"
        state = snapshot.read_json(path) if path.exists() or path.is_symlink() else expected
        verify_state(folder, state, expected)
        atomic_json(path, state)
        result = collect(folder, state, args.limit, args.retry_failed) if args.fetch else {"stopped": "local_verification_only"}
        verify_state(folder, state, expected)
        entries = list(state["assets"].values())
        counts = {status: sum(e["status"] == status for e in entries) for status in ("pending", "failed", "saved")}
        report = {"format": FORMAT, "createdAt": stamp(), "sourceSnapshot": manifest["source_snapshot"],
                  "sourcePhotosSha256": expected["sourcePhotosSha256"], "counts": counts,
                  "photoRows": sum(len(e["photoIds"]) for e in entries), "uniqueUrls": len(entries),
                  "objects": len({e["image"]["sha256"] for e in entries if e["status"] == "saved"}),
                  "allSourceFilesSaved": counts["saved"] == len(entries), "offsiteBackup": False,
                  "publishedOrDatabaseChanged": False, "releaseReady": False, "run": result,
                  "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                  "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "manifestSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "decoderVersion": PILLOW_VERSION}
        report_path = folder / ("report-" + uuid.uuid4().hex[:12] + ".json")
        atomic_json(report_path, report)
        print(json.dumps({"report": str(report_path), "counts": counts, "run": result,
                          "allSourceFilesSaved": report["allSourceFilesSaved"], "releaseReady": False}))
        return 0 if not args.fetch or report["allSourceFilesSaved"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[A-Z_0-9]+", str(error)) else "MEDIA_OPERATION_FAILED"
        print(json.dumps({"ok": False, "error": code}))
        raise SystemExit(1)
