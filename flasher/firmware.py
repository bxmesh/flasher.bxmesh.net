"""The firmware list and the packages, from MeshCore's GitHub releases.

The page can't fetch release assets itself (GitHub's downloads don't allow cross-origin reads), so
the server does: it lists the releases, downloads a package when it's first asked for, checks it
against the SHA-256 digest GitHub publishes for the asset, and keeps it on disk by that digest.
Nothing here matters if lost: an empty cache is filled again on the next request."""

import base64
import hashlib
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request

from . import dfu_package

USER_AGENT = "flasher.bxmesh.net"
LIST_TTL = 600            # seconds a release list is reused
MAX_DOWNLOAD = 4 * 1024 * 1024
PAGES = 3                 # 100 releases a page; repeater, companion and room server alternate


class FirmwareError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _version_key(v):
    return tuple(int(x) for x in v.lstrip("v").split("."))


class Firmware:
    def __init__(self, cfg, cache_dir, api_base="https://api.github.com",
                 download_base="https://github.com", timeout=30, clock=time.monotonic):
        fw = cfg["firmware"]
        self.repo = fw["repo"]
        self.tag_re = re.compile(fw["tagPattern"])
        self.asset_re = re.compile(fw["assetPattern"])
        self.api_base = api_base.rstrip("/")
        # Assets are downloaded only from the repo's own release downloads.
        self.download_prefix = f"{download_base.rstrip('/')}/{self.repo}/releases/download/"
        self.cache_dir = cache_dir
        self.timeout = timeout
        self.clock = clock
        self._lock = threading.Lock()
        self._download_lock = threading.Lock()
        self._list = None          # (fetched_at, releases)
        os.makedirs(cache_dir, exist_ok=True)

    # --- the list -----------------------------------------------------------------------------

    def _get_json(self, url):
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
        })
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read(8 * 1024 * 1024))

    def _fetch_list(self):
        releases = []
        for page in range(1, PAGES + 1):
            batch = self._get_json(f"{self.api_base}/repos/{self.repo}/releases?per_page=100&page={page}")
            if not isinstance(batch, list):
                raise ValueError("GitHub's release list isn't a list")
            for rel in batch:
                entry = self._entry(rel)
                if entry:
                    releases.append(entry)
            if len(batch) < 100:
                break
        releases.sort(key=lambda r: _version_key(r["version"]), reverse=True)
        for i, r in enumerate(releases):
            r["latest"] = i == 0
        return releases

    def _entry(self, rel):
        """A release the flasher offers: a repeater tag, published, with the board's package and
        GitHub's digest for it. Anything else is left out."""
        if rel.get("draft") or rel.get("prerelease"):
            return None
        tag = rel.get("tag_name") or ""
        m = self.tag_re.match(tag)
        if not m:
            return None
        version = m.group("version")
        for asset in rel.get("assets") or []:
            name = asset.get("name") or ""
            am = self.asset_re.match(name)
            if not am or am.group("version") != version:
                continue
            digest = asset.get("digest") or ""
            url = asset.get("browser_download_url") or ""
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                return None
            if not url.startswith(self.download_prefix):
                return None
            return {
                "tag": tag,
                "version": "v" + version,
                "published": rel.get("published_at"),
                "asset": name,
                "size": asset.get("size"),
                "digest": digest,
                "_url": url,
            }
        return None

    def releases(self):
        """{"releases": [...], "stale": bool}: newest first. A list less than LIST_TTL old is
        reused; if GitHub can't be reached the last list is served, marked stale."""
        with self._lock:
            now = self.clock()
            if self._list and now - self._list[0] < LIST_TTL:
                return self._public(self._list[1], False)
            try:
                releases = self._fetch_list()
            except (urllib.error.URLError, OSError, ValueError) as e:
                if self._list:
                    return self._public(self._list[1], True)
                raise FirmwareError(503, f"GitHub's release list couldn't be read: {e}") from e
            self._list = (now, releases)
            return self._public(releases, False)

    @staticmethod
    def _public(releases, stale):
        return {
            "releases": [{k: v for k, v in r.items() if not k.startswith("_")} for r in releases],
            "stale": stale,
        }

    def _find(self, tag):
        self.releases()
        with self._lock:
            for r in self._list[1] if self._list else []:
                if r["tag"] == tag:
                    return r
        raise FirmwareError(404, f"{tag} isn't a release the flasher offers")

    # --- the packages -------------------------------------------------------------------------

    def _cache_path(self, digest):
        return os.path.join(self.cache_dir, digest.split(":", 1)[1] + ".zip")

    def _read_cached(self, digest):
        path = self._cache_path(digest)
        try:
            with open(path, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            return None
        if "sha256:" + hashlib.sha256(data).hexdigest() != digest:
            os.unlink(path)  # damaged: fetch it again
            return None
        return data

    def _download(self, rel):
        req = urllib.request.Request(rel["_url"], headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = resp.read(MAX_DOWNLOAD + 1)
        except (urllib.error.URLError, OSError) as e:
            raise FirmwareError(502, f"{rel['asset']} couldn't be downloaded: {e}") from e
        if len(data) > MAX_DOWNLOAD:
            raise FirmwareError(502, f"{rel['asset']} is larger than {MAX_DOWNLOAD} bytes")
        got = "sha256:" + hashlib.sha256(data).hexdigest()
        if got != rel["digest"]:
            raise FirmwareError(502, f"{rel['asset']}: downloaded {got}, GitHub lists {rel['digest']}; not used")
        fd, tmp = tempfile.mkstemp(dir=self.cache_dir, suffix=".part")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, self._cache_path(rel["digest"]))
        return data

    def package(self, tag):
        """The checked package for a release, ready for the page: the init packet and the
        application image (base64), and what they are."""
        rel = self._find(tag)
        with self._download_lock:
            data = self._read_cached(rel["digest"]) or self._download(rel)
        try:
            pkg = dfu_package.parse(data)
        except dfu_package.PackageError as e:
            raise FirmwareError(502, f"{rel['asset']}: {e}") from e
        return {
            "tag": rel["tag"],
            "version": rel["version"],
            "asset": rel["asset"],
            "digest": rel["digest"],
            "initPacket": pkg["initPacket"],
            "init": base64.b64encode(pkg["init"]).decode(),
            "image": base64.b64encode(pkg["image"]).decode(),
            "imageSize": len(pkg["image"]),
        }
