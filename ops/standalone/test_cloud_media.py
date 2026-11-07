"""Private photo preservation: synthetic image bytes and fake HTTP, no external requests."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
from PIL import Image

SPEC = importlib.util.spec_from_file_location("cloud_media", Path(__file__).with_name("preserve-cloud-media.py"))
media = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media)
URL = "https://masterweld.ru/test.jpg"


def picture(kind="JPEG"):
    buffer = io.BytesIO()
    Image.new("RGB", (4, 3), "#c0ffee").save(buffer, format=kind)
    return buffer.getvalue()


class Response(io.BytesIO):
    def __init__(self, raw, url=URL, **headers):
        super().__init__(raw)
        self.headers = {"Content-Type": "image/jpeg", **headers}
        self.url = url
        self.status = 200

    def geturl(self):
        return self.url


class Opener:
    def __init__(self, *results):
        self.results = iter(results)
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request.full_url, timeout))
        result = next(self.results)
        if isinstance(result, Exception):
            raise result
        return result


class CloudMediaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        (self.folder / "objects").mkdir(mode=0o700)
        self.raw = picture()
        self.details = media.image_details(self.raw)
        self.plan = media.source_plan(
            {"source_snapshot": "synthetic"},
            {"products": json.dumps([{"id": "product-a"}, {"id": "product-b"}]),
             "product_photos": json.dumps([
                 {"id": "photo-a", "product_id": "product-a", "url": URL},
                 {"id": "photo-b", "product_id": "product-b", "url": URL}])},
            {"tables": {"product_photos": {"sha256": "source-hash"}}})

    def tearDown(self):
        self.temp.cleanup()

    def test_allowed_url_preserves_escaping_and_encodes_unicode(self):
        original = "https://masterweld.ru/сварка/a%20b.jpg"
        self.assertEqual(media.request_url(original), "https://masterweld.ru/%D1%81%D0%B2%D0%B0%D1%80%D0%BA%D0%B0/a%20b.jpg")

    def test_unapproved_destinations_and_malformed_urls_refused(self):
        for url in ("http://masterweld.ru/a", "https://evil.example/a", "https://masterweld.ru.evil/a",
                    "https://user@masterweld.ru/a", "https://masterweld.ru:443/a",
                    "https://masterweld.ru/a?token=x", "https://masterweld.ru/a#x",
                    "https://masterweld.ru/a%xx", "https://masterweld.ru/\nabc",
                    "https://masterweld.ru/\\evil"):
            with self.subTest(url=url), self.assertRaises(media.MediaError):
                media.request_url(url)

    def test_private_dns_address_refused(self):
        for ip in ("127.0.0.1", "10.0.0.1", "::1", "169.254.169.254"):
            with patch.object(media.socket, "getaddrinfo", return_value=[(0, 0, 0, "", (ip, 443))]):
                with self.assertRaisesRegex(media.MediaError, "SOURCE_ADDRESS_NOT_PUBLIC"):
                    media.check_dns()

    def test_full_decode_and_original_bytes(self):
        for kind, mime in (("JPEG", "image/jpeg"), ("PNG", "image/png")):
            raw = picture(kind)
            details = media.image_details(raw, mime)
            self.assertEqual((details["width"], details["height"]), (4, 3))
            self.assertEqual(details["sha256"], hashlib.sha256(raw).hexdigest())
            with self.assertRaises(media.MediaError):
                media.image_details(raw[:-12], mime)

    def test_html_wrong_mime_large_body_and_pixel_limit_refused(self):
        with self.assertRaisesRegex(media.MediaError, "IMAGE_DECODE_FAILED"):
            media.image_details(b"<html>not a photo</html>", "image/jpeg")
        with self.assertRaisesRegex(media.MediaError, "IMAGE_MIME_MISMATCH"):
            media.image_details(self.raw, "image/png")
        with patch.object(media, "MAX_BYTES", 4):
            with self.assertRaisesRegex(media.MediaError, "IMAGE_SIZE_INVALID"):
                media.image_details(self.raw)
        with patch.object(media, "MAX_PIXELS", 10):
            with self.assertRaises(media.MediaError):
                media.image_details(self.raw)

    def test_duplicate_url_has_two_photo_and_product_links(self):
        self.assertEqual(len(self.plan["assets"]), 1)
        entry = next(iter(self.plan["assets"].values()))
        self.assertEqual(entry["photoIds"], ["photo-a", "photo-b"])
        self.assertEqual(entry["productIds"], ["product-a", "product-b"])
        self.assertEqual(entry["sourceUrl"], URL)

    def test_fetch_checks_content_length_and_preserves_bytes(self):
        with patch.object(media, "check_dns"):
            raw, details, final = media.fetch(URL, Opener(Response(self.raw, **{"Content-Length": str(len(self.raw))})))
        self.assertEqual((raw, details, final), (self.raw, self.details, URL))
        for headers in ({"Content-Length": str(len(self.raw) + 1)}, {"Content-Length": "-1"},
                        {"Content-Length": str(media.MAX_BYTES + 1)}, {"Content-Type": "text/html"},
                        {"Content-Encoding": "gzip"}):
            with self.subTest(headers=headers), patch.object(media, "check_dns"):
                with self.assertRaises(media.MediaError):
                    media.fetch(URL, Opener(Response(self.raw, **headers)))

    def test_missing_length_does_not_bypass_size_limit(self):
        with patch.object(media, "check_dns"), patch.object(media, "MAX_BYTES", 10):
            with self.assertRaisesRegex(media.MediaError, "IMAGE_TOO_LARGE"):
                media.fetch(URL, Opener(Response(self.raw)))

    def test_redirect_remains_on_approved_https_host(self):
        moved = "https://masterweld.ru/moved.jpg"
        opener = Opener(urllib.error.HTTPError(URL, 302, "redirect", {"Location": "/moved.jpg"}, None),
                        Response(self.raw, url=moved))
        with patch.object(media, "check_dns"):
            self.assertEqual(media.fetch(URL, opener)[2], moved)
        self.assertEqual(len(opener.calls), 2)
        for location in ("http://masterweld.ru/a.jpg", "https://evil.example/a.jpg", "//127.0.0.1/a.jpg"):
            opener = Opener(urllib.error.HTTPError(URL, 302, "redirect", {"Location": location}, None))
            with patch.object(media, "check_dns"), self.assertRaises(media.MediaError):
                media.fetch(URL, opener)
            self.assertEqual(len(opener.calls), 1)

    def test_redirect_loop_bounded(self):
        opener = Opener(*(urllib.error.HTTPError(URL, 302, "redirect", {"Location": URL}, None) for _ in range(4)))
        with patch.object(media, "check_dns"), self.assertRaisesRegex(media.MediaError, "REDIRECT_LIMIT"):
            media.fetch(URL, opener)
        self.assertEqual(len(opener.calls), 4)

    def test_real_deadline_interrupts_stalled_operation(self):
        with self.assertRaisesRegex(media.MediaError, "FETCH_DEADLINE"):
            with media.deadline(.01):
                media.time.sleep(.1)

    def test_resume_does_not_fetch_saved_files_and_detects_corruption(self):
        state = copy.deepcopy(self.plan)
        fetcher = lambda _: (self.raw, self.details, URL)
        with patch.object(media.time, "sleep"):
            report = media.collect(self.folder, state, 5, fetcher=fetcher)
        self.assertEqual(report["savedThisRun"], 1)
        media.verify_state(self.folder, state, self.plan)
        with patch.object(media.time, "sleep"):
            report = media.collect(self.folder, state, 5, fetcher=lambda _: self.fail("refetched saved"))
        self.assertEqual(report["attempted"], 0)
        path = media.object_path(self.folder, self.details)
        self.assertEqual(path.read_bytes(), self.raw)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        path.write_bytes(self.raw[:-1])
        with self.assertRaisesRegex(media.MediaError, "STORED_IMAGE_CORRUPT"):
            media.verify_state(self.folder, state, self.plan)
        with self.assertRaisesRegex(media.MediaError, "EXISTING_OBJECT_CORRUPT"):
            media.store_object(self.folder, self.raw, self.details)

    def test_two_urls_same_bytes_store_one_object(self):
        state = copy.deepcopy(self.plan)
        state["assets"]["second"] = copy.deepcopy(next(iter(state["assets"].values())))
        state["assets"]["second"]["sourceUrl"] = "https://masterweld.ru/other.jpg"
        with patch.object(media.time, "sleep"):
            media.collect(self.folder, state, 10, fetcher=lambda url: (self.raw, self.details, url))
        self.assertEqual(len(list((self.folder / "objects").iterdir())), 1)
        self.assertTrue(all(e["status"] == "saved" for e in state["assets"].values()))

    def test_circuit_stops_after_three_failures_and_retry_is_explicit(self):
        state = copy.deepcopy(self.plan)
        first = next(iter(state["assets"].values()))
        state["assets"] = {str(i): copy.deepcopy(first) for i in range(5)}
        def failed(_):
            raise TimeoutError("provider details must not enter report")
        with patch.object(media.time, "sleep"):
            result = media.collect(self.folder, state, 10, fetcher=failed)
        self.assertEqual(result["stopped"], "consecutive_failures")
        self.assertEqual(result["attempted"], 3)
        self.assertEqual([e["status"] for e in state["assets"].values()], ["failed"] * 3 + ["pending"] * 2)
        self.assertTrue(all(e.get("error") in (None, "NETWORK_TIMEOUT") for e in state["assets"].values()))
        with patch.object(media.time, "sleep"):
            result = media.collect(self.folder, state, 10, fetcher=lambda u: (self.raw, self.details, u))
        self.assertEqual(result["attempted"], 2)
        with patch.object(media.time, "sleep"):
            result = media.collect(self.folder, state, 10, retry_failed=True, fetcher=lambda u: (self.raw, self.details, u))
        self.assertEqual(result["attempted"], 3)
        self.assertTrue(all(e["status"] == "saved" for e in state["assets"].values()))

    def test_manifest_mapping_cannot_be_retargeted(self):
        state = copy.deepcopy(self.plan)
        next(iter(state["assets"].values()))["sourceUrl"] = "https://evil.example/"
        with self.assertRaisesRegex(media.MediaError, "MEDIA_MAPPING_CHANGED"):
            media.verify_state(self.folder, state, self.plan)

    def test_disk_error_is_not_reported_as_network_failure(self):
        state = copy.deepcopy(self.plan)
        with patch.object(media, "store_object", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                media.collect(self.folder, state, 1, fetcher=lambda u: (self.raw, self.details, u))
        self.assertEqual(next(iter(state["assets"].values()))["status"], "pending")
        self.assertFalse((self.folder / "manifest.json").exists())

    def test_manifest_symlink_refused_and_atomic_write_private(self):
        path = self.folder / "manifest.json"
        media.atomic_json(path, self.plan)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        target = self.folder / "target"
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, "SYMLINK_REFUSED"):
            media.atomic_json(path, {})
        self.assertEqual(json.loads(target.read_bytes()), self.plan)


if __name__ == "__main__":
    unittest.main()
