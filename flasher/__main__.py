"""python3 -m flasher: serve the page.

Locally it listens on 127.0.0.1:8080 by default; open http://localhost:8080 in Chrome or Edge
(localhost is a secure context, which Web Serial needs). The image sets FLASHER_HOST=0.0.0.0."""

import argparse
import os
import sys

from . import config as config_mod
from .firmware import Firmware
from .server import serve

HERE = os.path.dirname(os.path.abspath(__file__))


def main(argv=None):
    p = argparse.ArgumentParser(prog="flasher", description="MeshCore repeater flasher for the ProMicro nRF52840")
    p.add_argument("--host", default=os.environ.get("FLASHER_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("FLASHER_PORT", "8080")))
    p.add_argument("--config", default=os.environ.get("FLASHER_CONFIG", os.path.join(HERE, "..", "config", "flasher.json")))
    p.add_argument("--cache-dir", default=os.environ.get(
        "FLASHER_CACHE_DIR",
        os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "flasher.bxmesh.net")))
    # For the tests' fake GitHub; the defaults are GitHub's own.
    p.add_argument("--github-api", default=os.environ.get("FLASHER_GITHUB_API", "https://api.github.com"))
    p.add_argument("--github-download", default=os.environ.get("FLASHER_GITHUB_DOWNLOAD", "https://github.com"))
    # Behind a proxy (Cloudflare's tunnel): the header with the visitor's address, for the limits.
    p.add_argument("--client-ip-header", default=os.environ.get("FLASHER_CLIENT_IP_HEADER") or None)
    args = p.parse_args(argv)

    cfg = config_mod.load(args.config)
    fw = Firmware(cfg, args.cache_dir, api_base=args.github_api, download_base=args.github_download)
    httpd = serve(cfg, fw, args.host, args.port, client_ip_header=args.client_ip_header)
    shown = "localhost" if args.host in ("127.0.0.1", "::1", "localhost") else args.host
    print(f"flasher.bxmesh.net on http://{shown}:{httpd.server_address[1]}/", file=sys.stderr, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
