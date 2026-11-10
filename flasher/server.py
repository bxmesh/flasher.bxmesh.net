"""The HTTP server: the page, its settings, the firmware list and packages, and /healthz.

Only GET and HEAD, and no cookies: the page never sends anything to the server, so nothing typed
into it can reach it. The admin password goes to the board over Web Serial, in the browser, and
nowhere else; the admin identities a person adds are kept in their own browser (localStorage)."""

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import config as config_mod
from .firmware import FirmwareError
from .ratelimit import RateLimiter

# Per client: the firmware list (cached here for 10 minutes, so this only limits load on the pod),
# and the packages (about 470 KB each; each is fetched from GitHub once, then served from the cache).
LIST_LIMIT = (60, 60)       # requests, seconds
PACKAGE_LIMIT = (12, 600)

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}
# serial=(self): Web Serial for this page only (its default too, stated so a proxy can't widen it).
HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                               "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Permissions-Policy": "serial=(self)",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}
TAG_PATH = re.compile(r"^/api/firmware/([A-Za-z0-9._-]{1,64})$")


def static_files(web_dir=WEB_DIR):
    """The page's files, read at start: only these are served, by exact name."""
    files = {}
    for name in sorted(os.listdir(web_dir)):
        ext = os.path.splitext(name)[1]
        if ext in TYPES and re.fullmatch(r"[a-z0-9-]+\.[a-z]+", name):
            with open(os.path.join(web_dir, name), "rb") as f:
                files["/" + name] = (f.read(), TYPES[ext])
    files["/"] = files["/index.html"]
    return files


def make_handler(cfg, firmware, files, client_ip_header=None, limits=None):
    """client_ip_header: the header the proxy in front puts the visitor's address in (behind
    Cloudflare, CF-Connecting-IP); without it, the connection's own address."""
    public_cfg = json.dumps(config_mod.public(cfg)).encode()
    limits = limits or {"list": RateLimiter(*LIST_LIMIT), "package": RateLimiter(*PACKAGE_LIMIT)}

    class Handler(BaseHTTPRequestHandler):
        server_version = "flasher.bxmesh.net"
        sys_version = ""

        def log_message(self, fmt, *args):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

        def _send(self, status, body, ctype, cache="no-store", extra=None):
            self.send_response(status)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            for k, v in HEADERS.items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status, obj, extra=None):
            self._send(status, json.dumps(obj).encode(), "application/json", extra=extra)

        def _client(self):
            if client_ip_header:
                value = self.headers.get(client_ip_header, "").strip()
                if value:
                    return value[:64]
            return self.client_address[0]

        def _limited(self, which):
            ok, wait = limits[which].allow(self._client())
            if ok:
                return False
            self._json(429, {"error": f"Too many requests from your address. Try again in {wait} seconds."},
                       extra={"Retry-After": str(wait)})
            return True

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/healthz":
                return self._send(200, b"ok\n", "text/plain; charset=utf-8")
            if path in files:
                body, ctype = files[path]
                return self._send(200, body, ctype, cache="no-cache")
            if path == "/api/config":
                return self._send(200, public_cfg, "application/json")
            try:
                if path == "/api/firmware":
                    if self._limited("list"):
                        return
                    return self._json(200, firmware.releases())
                m = TAG_PATH.match(path)
                if m:
                    if self._limited("package"):
                        return
                    return self._json(200, firmware.package(m.group(1)))
            except FirmwareError as e:
                return self._json(e.status, {"error": str(e)})
            return self._json(404, {"error": "not found"})

        def _refuse(self):
            self.send_response(405)
            self.send_header("Allow", "GET, HEAD")
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _refuse

    return Handler


def serve(cfg, firmware, host, port, web_dir=WEB_DIR, client_ip_header=None, limits=None):
    handler = make_handler(cfg, firmware, static_files(web_dir), client_ip_header, limits)
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return httpd
