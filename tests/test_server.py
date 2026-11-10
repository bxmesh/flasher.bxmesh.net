"""The server against a fake GitHub (fake_github.py): the release list, the checked and cached
packages, the settings, the page's files and /healthz. No network beyond 127.0.0.1."""

import base64
import copy
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

from fake_github import FakeGitHub, make_package  # noqa: E402
from flasher import config as config_mod  # noqa: E402
from flasher import dfu_package  # noqa: E402
from flasher.firmware import Firmware  # noqa: E402
from flasher.ratelimit import RateLimiter  # noqa: E402
from flasher.server import serve  # noqa: E402

CONFIG = os.path.join(ROOT, "config", "flasher.json")


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub().start()
        self.cache = tempfile.mkdtemp()
        self.cfg = config_mod.load(CONFIG)
        self.clock = Clock()
        self.fw = Firmware(self.cfg, self.cache, api_base=self.gh.base, download_base=self.gh.base, clock=self.clock)
        self.limits = {"list": RateLimiter(5, 60, clock=self.clock), "package": RateLimiter(3, 600, clock=self.clock)}
        self.httpd = serve(self.cfg, self.fw, "127.0.0.1", 0, client_ip_header="CF-Connecting-IP", limits=self.limits)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.gh.stop()
        shutil.rmtree(self.cache)

    def get(self, path, method="GET", headers=None):
        req = urllib.request.Request(self.base + path, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def get_json(self, path):
        status, _, body = self.get(path)
        return status, json.loads(body)

    # --- the list -----------------------------------------------------------------------------

    def test_lists_only_published_repeater_packages_newest_first(self):
        status, body = self.get_json("/api/firmware")
        self.assertEqual(status, 200)
        self.assertFalse(body["stale"])
        tags = [r["tag"] for r in body["releases"]]
        # Not the prerelease (1.19.0), the one without a digest (1.16.0), the one hosted elsewhere
        # (1.14.0), the old LLCC68 name (1.7.3), companions or room servers.
        self.assertEqual(tags, ["repeater-v1.18.0", "repeater-v1.17.1", "repeater-v1.15.0"])
        latest = body["releases"][0]
        self.assertTrue(latest["latest"])
        self.assertEqual(latest["version"], "v1.18.0")
        self.assertEqual(latest["asset"], "ProMicro_repeater-v1.18.0-81dbae5.zip")
        self.assertTrue(latest["digest"].startswith("sha256:"))
        self.assertNotIn("_url", latest)
        self.assertEqual([r["latest"] for r in body["releases"]], [True, False, False])

    def test_list_is_reused_then_refreshed(self):
        self.get_json("/api/firmware")
        self.get_json("/api/firmware")
        self.assertEqual(self.gh.requests.count("/repos/meshcore-dev/MeshCore/releases"), 1)
        self.clock.t += 601
        self.get_json("/api/firmware")
        self.assertEqual(self.gh.requests.count("/repos/meshcore-dev/MeshCore/releases"), 2)

    def test_github_down_serves_the_last_list_marked_stale(self):
        self.get_json("/api/firmware")
        self.gh.fail = True
        self.clock.t += 601
        status, body = self.get_json("/api/firmware")
        self.assertEqual(status, 200)
        self.assertTrue(body["stale"])
        self.assertEqual(body["releases"][0]["tag"], "repeater-v1.18.0")

    def test_github_down_with_no_list_is_503(self):
        self.gh.fail = True
        status, body = self.get_json("/api/firmware")
        self.assertEqual(status, 503)
        self.assertIn("release list", body["error"])

    # --- the packages -------------------------------------------------------------------------

    def test_package_is_checked_unpacked_and_cached(self):
        status, body = self.get_json("/api/firmware/repeater-v1.18.0")
        self.assertEqual(status, 200)
        image, init = self.gh.images["repeater-v1.18.0"]
        self.assertEqual(base64.b64decode(body["image"]), image)
        self.assertEqual(base64.b64decode(body["init"]), init)
        self.assertEqual(body["imageSize"], len(image))
        self.assertEqual(body["version"], "v1.18.0")
        self.assertEqual(body["initPacket"]["firmware_crc16"], dfu_package.crc16(image))
        self.assertEqual(body["initPacket"]["softdevice_req"], [0xB6])
        downloads = [p for p in self.gh.requests if "/releases/download/" in p]
        self.assertEqual(len(downloads), 1)
        self.assertEqual(len(os.listdir(self.cache)), 1)
        # Again, from the cache, even with GitHub away (the list is still fresh).
        self.gh.fail = True
        status, again = self.get_json("/api/firmware/repeater-v1.18.0")
        self.assertEqual(status, 200)
        self.assertEqual(again["image"], body["image"])
        self.assertEqual(len([p for p in self.gh.requests if "/releases/download/" in p]), 1)

    def test_older_release_can_be_had(self):
        status, body = self.get_json("/api/firmware/repeater-v1.17.1")
        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(body["image"]), self.gh.images["repeater-v1.17.1"][0])

    def test_digest_mismatch_is_refused_and_not_cached(self):
        status, body = self.get_json("/api/firmware/repeater-v1.15.0")
        self.assertEqual(status, 502)
        self.assertIn("not used", body["error"])
        self.assertEqual(os.listdir(self.cache), [])

    def test_damaged_cache_file_is_fetched_again(self):
        self.get_json("/api/firmware/repeater-v1.18.0")
        (name,) = os.listdir(self.cache)
        with open(os.path.join(self.cache, name), "r+b") as f:
            f.write(b"XX")
        status, body = self.get_json("/api/firmware/repeater-v1.18.0")
        self.assertEqual(status, 200)
        self.assertEqual(len([p for p in self.gh.requests if "/releases/download/" in p]), 2)

    def test_unknown_or_unoffered_tags_are_404(self):
        for i, tag in enumerate(("repeater-v9.9.9", "repeater-v1.19.0", "repeater-v1.16.0", "companion-v1.18.0")):
            status, _, _ = self.get("/api/firmware/" + tag, headers={"CF-Connecting-IP": f"192.0.2.{i}"})
            self.assertEqual(status, 404, tag)
        for path in ("/api/firmware/..%2f..%2fetc", "/api/firmware/a/b", "/../config/flasher.json", "/flasher.json"):
            status, _, _ = self.get(path)
            self.assertEqual(status, 404, path)

    def test_package_requests_are_limited_per_visitor(self):
        visitor = {"CF-Connecting-IP": "203.0.113.7"}
        for _ in range(3):
            status, _, _ = self.get("/api/firmware/repeater-v1.18.0", headers=visitor)
            self.assertEqual(status, 200)
        status, headers, body = self.get("/api/firmware/repeater-v1.18.0", headers=visitor)
        self.assertEqual(status, 429)
        self.assertIn("Try again in", json.loads(body)["error"])
        self.assertGreater(int(headers["Retry-After"]), 0)
        # Someone else isn't held up; and the first may go on once the window has passed.
        status, _, _ = self.get("/api/firmware/repeater-v1.18.0", headers={"CF-Connecting-IP": "198.51.100.2"})
        self.assertEqual(status, 200)
        self.clock.t += 601
        status, _, _ = self.get("/api/firmware/repeater-v1.18.0", headers=visitor)
        self.assertEqual(status, 200)

    def test_list_requests_are_limited_per_visitor(self):
        for _ in range(5):
            self.assertEqual(self.get("/api/firmware")[0], 200)
        self.assertEqual(self.get("/api/firmware")[0], 429)
        # The page and its settings aren't limited.
        self.assertEqual(self.get("/api/config")[0], 200)
        self.assertEqual(self.get("/")[0], 200)

    # --- the rest -----------------------------------------------------------------------------

    def test_healthz(self):
        status, _, body = self.get("/healthz")
        self.assertEqual((status, body), (200, b"ok\n"))

    def test_config_is_served_without_the_source_patterns(self):
        status, body = self.get_json("/api/config")
        self.assertEqual(status, 200)
        self.assertEqual(body["regions"]["default"], "au-nsw")
        self.assertEqual(body["regions"]["home"], "au-nsw")
        self.assertEqual([r["name"] for r in body["regions"]["list"] if r["ticked"]], ["au", "au-nsw"])
        self.assertEqual([r["name"] for r in body["regions"]["list"]], ["au", "au-nsw", "au-nsw-bhs", "au-nsw-dge"])
        self.assertEqual(body["guestPassword"], "guest")
        self.assertEqual(body["pathHashMode"], 1)
        # No admin identities: each person keeps their own in their browser.
        self.assertNotIn("adminKeys", body)
        self.assertNotIn("admins", json.dumps(body))
        self.assertEqual(body["radioPresets"][0], {"label": "Australia (BxMesh)", "freq": 915.075, "bw": 125, "sf": 9, "cr": 5})
        self.assertNotIn("firmware", body)

    def test_page_and_headers(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertIn("serial=(self)", headers["Permissions-Policy"])
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        status, headers, _ = self.get("/api/config")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_only_get_and_head(self):
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            status, headers, _ = self.get("/api/config", method=method)
            self.assertEqual(status, 405, method)
        status, _, body = self.get("/healthz", method="HEAD")
        self.assertEqual((status, body), (200, b""))


class PackageTest(unittest.TestCase):
    def test_real_release_init_packet_layout(self):
        # firmware.dat of ProMicro_repeater-v1.18.0-81dbae5.zip, byte for byte.
        dat = bytes.fromhex("5200ffffffffffff0100b6009f3a")
        self.assertEqual(dfu_package.parse_init_packet(dat), {
            "device_type": 82, "device_revision": 65535, "application_version": 4294967295,
            "softdevice_req": [182], "firmware_crc16": 15007})

    def test_crc16_check_value(self):
        # CRC-16/CCITT-FALSE's check value.
        self.assertEqual(dfu_package.crc16(b"123456789"), 0x29B1)

    def test_bad_packages(self):
        zip_bytes, _, _ = make_package("v1.18.0", 100, 1)
        dfu_package.parse(zip_bytes)
        with self.assertRaises(dfu_package.PackageError):
            dfu_package.parse(b"not a zip")
        import io
        import zipfile

        def repack(**changes):
            src = zipfile.ZipFile(io.BytesIO(zip_bytes))
            out = io.BytesIO()
            with zipfile.ZipFile(out, "w") as zf:
                for name in src.namelist():
                    data = changes.get(name, src.read(name))
                    if data is not None:
                        zf.writestr(name, data)
            return out.getvalue()

        manifest = json.loads(zipfile.ZipFile(io.BytesIO(zip_bytes)).read("manifest.json"))
        with_bl = copy.deepcopy(manifest)
        with_bl["manifest"]["bootloader"] = {"bin_file": "bl.bin", "dat_file": "bl.dat"}
        cases = {
            "bootloader": repack(**{"manifest.json": json.dumps(with_bl)}),
            "no image": repack(**{"firmware.bin": None}),
            "crc": repack(**{"firmware.bin": b"\x00" * 100}),
            "dat length": repack(**{"firmware.dat": b"\x00" * 13}),
            "too big": repack(**{"firmware.bin": b"\x00" * (dfu_package.MAX_APP_SIZE + 1)}),
        }
        for what, data in cases.items():
            with self.assertRaises(dfu_package.PackageError, msg=what):
                dfu_package.parse(data)


class ConfigTest(unittest.TestCase):
    def setUp(self):
        with open(CONFIG) as f:
            self.raw = json.load(f)

    def bad(self, change):
        raw = copy.deepcopy(self.raw)
        change(raw)
        with self.assertRaises(config_mod.ConfigError):
            config_mod.check(raw)

    def test_shipped_config_is_good(self):
        cfg = config_mod.check(self.raw)
        self.assertNotIn("adminKeys", cfg)
        self.assertEqual(cfg["radioPresets"][0]["label"], "Australia (BxMesh)")

    def test_mistakes_are_refused(self):
        self.bad(lambda r: r.update(admins={"publicKeys": ["00" * 32]}))
        self.bad(lambda r: r["radio"]["presets"].append({"label": "x", "freq": 100, "bw": 125, "sf": 9, "cr": 5}))
        self.bad(lambda r: r["radio"]["presets"].append({"label": "y", "freq": 915, "bw": 125, "sf": 9, "cr": 9}))
        self.bad(lambda r: r["radio"]["presets"].append(dict(r["radio"]["presets"][0])))
        self.bad(lambda r: r["regions"]["list"].append({"name": "bad name", "parent": None, "label": "x", "ticked": False}))
        self.bad(lambda r: r["regions"]["list"].insert(0, {"name": "x", "parent": "au", "label": "x", "ticked": False}))
        self.bad(lambda r: r["regions"].update(default="nowhere"))
        self.bad(lambda r: r["pathHashMode"].update(value=3))
        self.bad(lambda r: r.update(guestPassword="sixteen-chars-xx"))
        self.bad(lambda r: r["firmware"].update(assetPattern="^x$"))


if __name__ == "__main__":
    unittest.main()
