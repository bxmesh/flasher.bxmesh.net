"""The page, end to end, in headless Chromium against the local server, with a fake board
(fake-serial.js: the repeater's command line and the bootloader's serial DFU, modelled on the
firmware) and a fake GitHub (../fake_github.py). No real port or USB device is touched.

Run in Microsoft's Playwright image (README: Tests), or anywhere with Playwright for Python:
    python3 -m unittest discover -s tests/web -v
SCREENSHOTS=<dir> saves a screenshot of each step of the first test."""

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

from playwright.sync_api import expect, sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

from fake_github import FakeGitHub  # noqa: E402
from flasher import config as config_mod  # noqa: E402
from flasher.dfu_package import crc16  # noqa: E402
from flasher.firmware import Firmware  # noqa: E402
from flasher.server import serve  # noqa: E402

FAKE_JS = open(os.path.join(HERE, "fake-serial.js"), encoding="utf-8").read()
PASSWORD = "Tr0ub4dor&3x"
KEY_A = "e8b5ea3521ff849b3862621fa23bd789fee4655db5ff6d9148ec4380cc2a6f6e"
KEY_B = "bfd9707bf8065c593c89fd123b03835e582e5c8983dc58a8776a1b157d095f2c"
KEY_C = "98700772ae767a4fbfbb55e0c9e087077891a0b57c453af756e68285c1716bb6"
STRANGER = "ab" * 32
RUN_TIMEOUT = 120_000


def f32(x):
    import struct
    return struct.unpack("<f", struct.pack("<f", x))[0]


class PageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gh = FakeGitHub().start()
        cls.cache = tempfile.mkdtemp()
        cls.cfg = config_mod.load(os.path.join(ROOT, "config", "flasher.json"))
        fw = Firmware(cls.cfg, cls.cache, api_base=cls.gh.base, download_base=cls.gh.base)
        cls.httpd = serve(cls.cfg, fw, "127.0.0.1", 0)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = f"http://localhost:{cls.httpd.server_address[1]}/"
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.by_crc = {}
        for tag, (image, _init) in cls.gh.images.items():
            cls.by_crc[str(crc16(image))] = {"version": "v" + tag.split("-v")[1], "build": "15 Oct 2026"}
        cls.shots = os.environ.get("SCREENSHOTS")
        if cls.shots:
            os.makedirs(cls.shots, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.gh.stop()
        shutil.rmtree(cls.cache)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 900, "height": 1000})
        self.console = []
        self.requests = []

    def tearDown(self):
        self.context.close()

    # --- helpers ------------------------------------------------------------------------------

    def open(self, **options):
        opts = {"firmwareByCrc": self.by_crc, **options}
        page = self.context.new_page()
        page.on("console", lambda m: self.console.append(m.text))
        page.on("pageerror", lambda e: self.console.append("PAGEERROR " + str(e)))
        page.on("request", lambda r: self.requests.append((r.method, r.url, r.post_data)))
        page.add_init_script(script=f"window.__fakeOptions = {json.dumps(opts)};\n{FAKE_JS}")
        page.goto(self.url)
        expect(page.locator("#fw")).to_be_enabled()
        return page

    def shot(self, page, name):
        if self.shots:
            page.screenshot(path=os.path.join(self.shots, name + ".png"), full_page=True)

    def fake(self, page):
        return page.evaluate("JSON.parse(JSON.stringify({stored: __fake.stored, firmware: __fake.firmware,"
                             " commands: __fake.commands, reboots: __fake.reboots, errors: __fake.errors,"
                             " portRequests: __fake.portRequests,"
                             " image: __fake.dfu ? __fake.dfu.image : null, init: __fake.dfu ? __fake.dfu.init : null}))")

    def connect(self, page, expect_text="Found a repeater"):
        page.click("#connect")
        expect(page.locator("#board-status")).to_contain_text(expect_text)

    def fill(self, page, name="BHS Test 1", lat="-33.4194", lon="149.5775", password=PASSWORD):
        page.fill("#name", name)
        page.fill("#lat", lat)
        page.fill("#lon", lon)
        page.fill("#pw1", password)
        page.fill("#pw2", password)

    def add_admin(self, page, label, key):
        page.fill("#admin-label", label)
        page.fill("#admin-key", key)
        page.click("#admin-add")

    def finish(self, page, ok=True):
        expect(page.locator("#message")).to_have_class("message ok" if ok else "message bad", timeout=RUN_TIMEOUT)

    def assert_no_password_anywhere(self, page):
        body = page.evaluate("document.body.innerText")
        self.assertNotIn(PASSWORD, body)
        self.assertNotIn(PASSWORD, page.evaluate("document.getElementById('log-text').textContent"))
        self.assertEqual(page.input_value("#pw1"), "")
        storage = page.evaluate("JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage))")
        self.assertNotIn(PASSWORD, storage)
        self.assertEqual(self.context.cookies(), [])
        for line in self.console:
            self.assertNotIn(PASSWORD, line)
        for method, url, body in self.requests:
            self.assertEqual(method, "GET", url)
            self.assertNotIn(PASSWORD, url)
            self.assertIsNone(body)

    # --- the tests ----------------------------------------------------------------------------

    def test_flash_and_set_up_end_to_end(self):
        page = self.open(acl=[{"key": STRANGER, "perm": 3}])
        self.shot(page, "01-page")
        expect(page.locator("#fw")).to_have_value("repeater-v1.18.0")
        expect(page.locator("#preset option:checked")).to_contain_text("Australia (BxMesh): 915.075 MHz · 125 kHz · SF9 · CR 4/5")
        expect(page.locator("#go-why")).to_contain_text("choose the board first")
        self.connect(page)
        expect(page.locator("#board-status")).to_have_text("Found a repeater called ProMicro Repeater, running MeshCore v1.17.1.")
        self.fill(page)
        page.check("#region-au-nsw-bhs")
        self.add_admin(page, "Monitor 1", KEY_A)
        self.add_admin(page, "Monitor 2", KEY_B.upper())
        self.add_admin(page, "Not this one", KEY_C)
        page.locator("#admins li", has_text="Not this one").locator("input[type=checkbox]").uncheck()
        page.locator("#s-admins").scroll_into_view_if_needed()
        self.shot(page, "02-form")
        expect(page.locator("#go-flash")).to_be_enabled()
        page.locator("#s-go").scroll_into_view_if_needed()
        self.shot(page, "03-summary")

        page.click("#go-flash")
        expect(page.locator("#steps li").nth(2)).to_have_class("running", timeout=30_000)
        expect(page.locator("#steps li").nth(2).locator(".detail")).to_contain_text("Writing…", timeout=30_000)
        page.locator("#s-progress").scroll_into_view_if_needed()
        self.shot(page, "04-writing")
        expect(page.locator("#steps li").nth(5)).to_have_class("running", timeout=RUN_TIMEOUT)
        expect(page.locator("#steps li").nth(5).locator(".detail")).to_contain_text("Letting the board save its admin list")
        self.shot(page, "05-saving")
        self.finish(page)
        page.locator("#s-progress").scroll_into_view_if_needed()
        self.shot(page, "06-done")

        # The checklist: everything passes.
        checks = page.locator("#checks li")
        self.assertEqual(checks.count(), 12)
        self.assertEqual(page.locator("#checks li.pass").count(), 12, page.locator("#checks").inner_text())
        expect(page.locator("#checks")).to_contain_text("The board says 915.075 MHz · 125 kHz · SF9 · CR 4/5.")
        expect(page.locator("#checks")).to_contain_text("The board says -33.4194, 149.5775.")
        expect(page.locator("#steps li.done")).to_have_count(7)
        expect(page.locator("#board-status")).to_have_text("Found a repeater called BHS Test 1, running MeshCore v1.18.0.")

        b = self.fake(page)
        self.assertEqual(b["errors"], [])
        image, init = self.gh.images["repeater-v1.18.0"]
        self.assertEqual(bytes(b["image"]), image)
        self.assertEqual(bytes(b["init"]), init)
        self.assertEqual(b["firmware"]["version"], "v1.18.0")
        p = b["stored"]["prefs"]
        self.assertEqual(p["node_name"], "BHS Test 1")
        self.assertAlmostEqual(p["node_lat"], -33.4194)
        self.assertAlmostEqual(p["node_lon"], 149.5775)
        self.assertEqual((p["freq"], p["bw"], p["sf"], p["cr"]), (f32(915.075), 125, 9, 5))
        self.assertEqual(p["password"], PASSWORD)
        self.assertEqual(p["guest_password"], "guest")
        self.assertEqual(p["disable_fwd"], 1)
        self.assertEqual(p["path_hash_mode"], 1)
        rm = b["stored"]["regions"]
        ids = {r["name"]: r["id"] for r in rm["list"]}
        self.assertEqual({r["name"]: (r["parent"], r["flags"]) for r in rm["list"]}, {
            "au": (0, 0), "au-nsw": (ids["au"], 0), "au-nsw-bhs": (ids["au-nsw"], 0)})
        self.assertEqual((rm["default_id"], rm["home_id"]), (ids["au-nsw"], ids["au-nsw"]))
        self.assertEqual(sorted((e["key"], e["perm"]) for e in b["stored"]["acl"]), sorted([(KEY_A, 3), (KEY_B, 3)]))

        # The exact commands, in order (after the connect's "ver" and "get name").
        sent = [c for c in b["commands"] if c != "ver"]
        self.assertEqual(sent, [
            "get name",
            "region", "get acl",
            "set name BHS Test 1", "set lat -33.4194", "set lon 149.5775",
            "set radio 915.075,125,9,5", f"password {PASSWORD}", "set guest.password guest",
            "set repeat off", "set path.hash.mode 1",
            "region put au", "region put au-nsw au", "region put au-nsw-bhs au-nsw",
            "region default au-nsw", "region home au-nsw", "region save",
            f"setperm {KEY_A} 3", f"setperm {KEY_B} 3", f"setperm {STRANGER} 0",
            "reboot",
            "get public.key", "get name", "get lat", "get lon", "get radio", "get guest.password",
            "get repeat", "get path.hash.mode", "region", "region default", "region home", "get acl",
        ])
        self.assertEqual(b["reboots"], 1)
        self.assert_no_password_anywhere(page)
        # The identities stay in the browser: not in any request, nor in a cookie.
        for _, url, _ in self.requests:
            self.assertNotIn(KEY_A, url.lower())
        stored = json.loads(page.evaluate("localStorage.getItem('flasher.bxmesh.net/admin-identities/v1')"))
        self.assertEqual([x["key"] for x in stored], [KEY_A, KEY_B, KEY_C])
        expect(page.locator("#pubkey")).to_contain_text("A1B2C3D4")
        self.assertFalse([c for c in self.console if c.startswith("PAGEERROR")], self.console)

    def test_set_up_only_twice_gives_the_same_board(self):
        page = self.open(
            firmware={"version": "v1.18.0", "build": "15 Oct 2026"},
            regions=[{"name": "au"}, {"name": "au-nsw", "parent": "au"}, {"name": "au-nsw-dge", "parent": "au-nsw"},
                     {"name": "elsewhere", "flood": False}],
            acl=[{"key": STRANGER, "perm": 3}, {"key": KEY_A, "perm": 1}],
        )
        self.connect(page)
        self.add_admin(page, "Monitor 1", KEY_A)
        states = []
        for run in range(2):
            self.fill(page, name="Mudgee 2", lat="-32.5946", lon="149.5878")
            page.click("#go-config")
            self.finish(page)
            self.assertEqual(page.locator("#checks li.pass").count(), 11, page.locator("#checks").inner_text())
            expect(page.locator("#steps li.skipped")).to_have_count(3)
            b = self.fake(page)
            self.assertEqual(b["errors"], [])
            states.append(b["stored"])
            if run == 0:
                cmds = b["commands"]
                self.assertIn("region remove au-nsw-dge", cmds)
                self.assertIn(f"setperm {STRANGER} 0", cmds)
                self.assertNotIn("region remove elsewhere", cmds)
                first = len(cmds)
        self.assertEqual(states[0], states[1])
        second = b["commands"][first:]
        self.assertFalse([c for c in second if c.startswith("region remove") or c.endswith(" 0")], second)
        names = [r["name"] for r in states[1]["regions"]["list"]]
        self.assertEqual(sorted(names), ["au", "au-nsw", "elsewhere"])
        self.assertEqual(states[1]["acl"], [{"key": KEY_A, "perm": 3}])
        self.assertEqual(states[1]["prefs"]["node_name"], "Mudgee 2")
        self.assert_no_password_anywhere(page)

    def test_stops_at_the_first_refusal(self):
        page = self.open(replies={"set radio 915.075,125,9,5": "Error, invalid radio params"})
        self.connect(page)
        self.fill(page)
        page.click("#go-config")
        self.finish(page, ok=False)
        expect(page.locator("#steps li").nth(4)).to_have_class("failed")
        expect(page.locator("#message")).to_contain_text("the board refused those radio settings")
        cmds = self.fake(page)["commands"]
        self.assertEqual(cmds[-2:], ["set radio 915.075,125,9,5", "ver"])
        self.assertNotIn(f"password {PASSWORD}", cmds)
        self.shot(page, "07-refused")
        self.assert_no_password_anywhere(page)

    def test_board_chosen_again_when_the_browser_needs_it(self):
        # The browser doesn't recognise the board after it restarts: the page asks for it.
        page = self.open(samePermission=False)
        self.connect(page)
        page.select_option("#fw", "repeater-v1.17.1")
        self.fill(page)
        page.click("#go-flash")
        for i in range(3):  # the bootloader, the new firmware, and after the restart
            button = page.locator("#choose-again")
            expect(button).to_be_visible(timeout=RUN_TIMEOUT)
            if i == 0:
                page.locator("#s-progress").scroll_into_view_if_needed()
                self.shot(page, "08-choose-again")
            button.click()
        self.finish(page)
        b = self.fake(page)
        self.assertEqual(b["firmware"]["version"], "v1.17.1")
        self.assertEqual(bytes(b["image"]), self.gh.images["repeater-v1.17.1"][0])
        self.assertEqual(page.locator("#checks li.fail").count(), 0, page.locator("#checks").inner_text())

    def test_admin_identities_are_kept_in_this_browser(self):
        page = self.open()
        self.add_admin(page, "Bad", "1234")
        expect(page.locator("#admin-err")).to_have_text("A public key is 64 characters, each 0-9 or a-f.")
        self.add_admin(page, "Monitor 1", KEY_A)
        self.add_admin(page, "Again", KEY_A)
        expect(page.locator("#admin-err")).to_have_text("That key is already in the list.")
        expect(page.locator("#admins li")).to_have_count(1)
        expect(page.locator("#admin-storage")).to_contain_text("never sent to the server")
        page.reload()
        expect(page.locator("#admins li", has_text="Monitor 1")).to_contain_text(KEY_A)
        page.locator("#admins li", has_text="Monitor 1").get_by_role("button", name="Remove").click()
        page.reload()
        expect(page.locator("#admins li")).to_have_text("None added yet.")
        self.assertEqual(self.context.cookies(), [])
        for _, url, _ in self.requests:
            self.assertNotIn(KEY_A, url)

    def test_form_explains_what_is_missing(self):
        page = self.open()
        self.connect(page)
        page.fill("#name", "bad:name")
        page.locator("#name").blur()
        expect(page.locator("#name-err")).to_have_text("The name can't contain any of [ ] \\ : , ? *")
        page.fill("#name", "Good")
        page.fill("#lat", "-33.4")
        page.fill("#lon", "149.5")
        page.fill("#pw1", "one")
        page.fill("#pw2", "two")
        page.locator("#pw2").blur()
        expect(page.locator("#pw-err")).to_have_text("The two passwords don't match.")
        expect(page.locator("#go-flash")).to_be_disabled()
        page.fill("#pw2", "one")
        expect(page.locator("#go-flash")).to_be_enabled()
        page.fill("#freq", "915.8")
        expect(page.locator("#preset")).to_have_value("custom")
        page.fill("#bw", "250")
        page.select_option("#sf", "10")
        expect(page.locator("#preset option:checked")).to_have_text("Australia: 915.8 MHz · 250 kHz · SF10 · CR 4/5")
        page.uncheck("#region-au")
        expect(page.locator("#region-au-nsw")).not_to_be_checked()
        expect(page.locator("#regions-err")).to_have_text("Tick at least one region.")
        page.check("#region-au-nsw-dge")
        expect(page.locator("#region-au")).to_be_checked()
        expect(page.locator("#def-region")).to_have_value("au-nsw")

    def test_without_web_serial_the_page_says_why(self):
        page = self.context.new_page()
        page.add_init_script(script="Object.defineProperty(Navigator.prototype, 'serial', {get: () => undefined, configurable: true});")
        page.goto(self.url)
        expect(page.locator("#unsupported")).to_be_visible()
        expect(page.locator("#unsupported")).to_contain_text("Use Chrome or Edge on a computer")
        expect(page.locator("#connect")).to_be_disabled()
        self.shot(page, "09-unsupported")


if __name__ == "__main__":
    unittest.main()
