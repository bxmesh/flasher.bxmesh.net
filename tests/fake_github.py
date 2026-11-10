"""A fake of the two GitHub endpoints the server uses: the release list
(GET /repos/<owner>/<repo>/releases) and the release downloads
(GET /<owner>/<repo>/releases/download/<tag>/<asset>), with packages made here in MeshCore's
format. Run alone (python3 tests/fake_github.py PORT) for the page tests' server in a container."""

import hashlib
import io
import json
import random
import struct
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, __file__.rsplit("/tests/", 1)[0])
from flasher.dfu_package import crc16  # noqa: E402

REPO = "meshcore-dev/MeshCore"


def make_package(version, size, seed):
    """A DFU package like MeshCore's: a random image (so it holds 0xC0 and 0xDB, which SLIP
    escapes), its legacy init packet and manifest.json, as ProMicro_repeater-v1.18.0-*.zip has."""
    rnd = random.Random(seed)
    image = bytes(rnd.randrange(256) for _ in range(size))
    crc = crc16(image)
    init = struct.pack("<HHIHHH", 0x52, 0xFFFF, 0xFFFFFFFF, 1, 0xB6, crc)
    manifest = {"manifest": {"application": {
        "bin_file": "firmware.bin", "dat_file": "firmware.dat",
        "init_packet_data": {"application_version": 4294967295, "device_revision": 65535,
                             "device_type": 82, "firmware_crc16": crc, "softdevice_req": [182]}},
        "dfu_version": 0.5}}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=4))
        zf.writestr("firmware.dat", init)
        zf.writestr("firmware.bin", image)
    return buf.getvalue(), image, init


class FakeGitHub:
    def __init__(self, port=0):
        self.requests = []
        self.fail = False
        self.files = {}      # path -> bytes
        self.images = {}     # tag -> (image, init)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), self._handler())
        self.port = self.httpd.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.releases = self._releases()

    def _asset(self, tag, name, data, digest=True, url_base=None):
        path = f"/{REPO}/releases/download/{tag}/{name}"
        self.files[path] = data
        return {
            "name": name,
            "size": len(data),
            "digest": "sha256:" + hashlib.sha256(data).hexdigest() if digest else None,
            "browser_download_url": (url_base or self.base) + path,
        }

    def _releases(self):
        rels = []

        def rel(tag, assets, **kw):
            rels.append({"tag_name": tag, "draft": False, "prerelease": False,
                         "published_at": kw.pop("published", "2026-10-15T10:03:13Z"), "assets": assets, **kw})

        def pkg(tag, version, size, seed, **kw):
            data, image, init = make_package(version, size, seed)
            self.images[tag] = (image, init)
            return self._asset(tag, f"ProMicro_repeater-{version}-81dbae5.zip", data, **kw)

        rel("room-server-v1.18.0", [])
        rel("repeater-v1.18.0", [
            pkg("repeater-v1.18.0", "v1.18.0", 20000, 18),
            self._asset("repeater-v1.18.0", "ProMicro_repeater-v1.18.0-81dbae5.uf2", b"uf2"),
            self._asset("repeater-v1.18.0", "ProMicro_repeater_bridge_rs232-v1.18.0-81dbae5.zip", b"x"),
        ])
        rel("companion-v1.18.0", [self._asset("companion-v1.18.0", "ProMicro_companion-v1.18.0-81dbae5.zip", b"c")])
        rel("repeater-v1.19.0", [pkg("repeater-v1.19.0", "v1.19.0", 1000, 19)], prerelease=True)
        rel("repeater-v1.17.1", [pkg("repeater-v1.17.1", "v1.17.1", 12000, 17)], published="2026-08-14T13:32:04Z")
        # No digest: left out.
        rel("repeater-v1.16.0", [pkg("repeater-v1.16.0", "v1.16.0", 1000, 16, digest=False)])
        # A digest that the download doesn't match: listed, never served.
        bad = pkg("repeater-v1.15.0", "v1.15.0", 1000, 15)
        bad["digest"] = "sha256:" + "0" * 64
        rel("repeater-v1.15.0", [bad])
        # From somewhere other than the repo's release downloads: left out.
        rel("repeater-v1.14.0", [pkg("repeater-v1.14.0", "v1.14.0", 1000, 14, url_base="http://127.0.0.2:1")])
        # Before the ProMicro packages had this name: left out.
        rel("repeater-v1.7.3", [self._asset("repeater-v1.7.3", "ProMicroLLCC68_Repeater-v1.7.3-c6b469f.zip", b"o")])
        return rels

    def _handler(self):
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                u = urlparse(self.path)
                fake.requests.append(u.path)
                if fake.fail:
                    self.send_response(503)
                    self.end_headers()
                    return
                if u.path == f"/repos/{REPO}/releases":
                    q = parse_qs(u.query)
                    if self.headers.get("User-Agent", "") == "" or "per_page" not in q:
                        self.send_response(400)
                        self.end_headers()
                        return
                    page = int(q.get("page", ["1"])[0])
                    body = json.dumps(fake.releases if page == 1 else []).encode()
                    ctype = "application/json"
                elif u.path in fake.files:
                    body = fake.files[u.path]
                    ctype = "application/octet-stream"
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return H

    def start(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


if __name__ == "__main__":
    fake = FakeGitHub(int(sys.argv[1]) if len(sys.argv) > 1 else 0)
    print(fake.base, flush=True)
    fake.httpd.serve_forever()
