"""The settings file (config/flasher.json): read once at start and checked, so a mistake in it
stops the server instead of reaching a repeater."""

import json
import re

# MeshCore's limits, at repeater-v1.18.0:
# - region names: RegionMap::is_name_char (src/helpers/RegionMap.cpp) and RegionEntry.name[31];
# - passwords: NodePrefs.password[16] and guest_password[16] (src/helpers/CommonCLI.h);
# - path.hash.mode: 0 to 2 (src/helpers/CommonRadioPrefs.cpp, "set path.hash.mode");
# - the radio: below (radio_ok).
REGION_NAME = re.compile(r"^[A-Za-z0-9$#\-À-￿]{1,30}$")
PASSWORD = re.compile(r"^[\x21-\x7e](?:[\x20-\x7e]{0,13}[\x21-\x7e])?$")


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def radio_ok(freq, bw, sf, cr):
    """The ranges "set radio" accepts (src/helpers/CommonRadioPrefs.cpp, CommonRadioPrefs::handleCommand)."""
    return (_num(freq) and 150 <= freq <= 2500 and _num(bw) and 7 <= bw <= 500
            and isinstance(sf, int) and 5 <= sf <= 12 and isinstance(cr, int) and 5 <= cr <= 8)


class ConfigError(ValueError):
    pass


def _need(cond, message):
    if not cond:
        raise ConfigError(message)


def load(path):
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return check(raw)


def check(raw):
    """Returns the settings the page and the server use, or raises ConfigError."""
    fw = raw.get("firmware", {})
    for key in ("repo", "tagPattern", "assetPattern"):
        _need(isinstance(fw.get(key), str) and fw[key], f"firmware.{key} is missing")
    _need(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", fw["repo"]), "firmware.repo must be owner/name")
    for key in ("tagPattern", "assetPattern"):
        pattern = re.compile(fw[key])
        _need("version" in pattern.groupindex, f"firmware.{key} needs a (?P<version>...) group")

    board = raw.get("board", {})
    _need(isinstance(board.get("name"), str), "board.name is missing")
    _need(isinstance(board.get("usbVendorId"), int) and 0 < board["usbVendorId"] < 0x10000,
          "board.usbVendorId must be a USB vendor id")

    regions = raw.get("regions", {})
    entries = regions.get("list")
    _need(isinstance(entries, list) and entries, "regions.list is empty")
    seen = []
    for r in entries:
        name = r.get("name")
        _need(isinstance(name, str) and REGION_NAME.match(name), f"region name {name!r} isn't one MeshCore accepts")
        _need(name not in seen, f"region {name} is listed twice")
        parent = r.get("parent")
        _need(parent is None or parent in seen, f"region {name}'s parent {parent!r} must be listed before it")
        _need(isinstance(r.get("label"), str), f"region {name} needs a label")
        _need(isinstance(r.get("ticked"), bool), f"region {name}: ticked must be true or false")
        seen.append(name)
    for key in ("default", "home"):
        _need(regions.get(key) in seen, f"regions.{key} must be one of the listed regions")

    guest = raw.get("guestPassword")
    _need(isinstance(guest, str) and PASSWORD.match(guest), "guestPassword must be 1-15 printable ASCII characters")

    mode = raw.get("pathHashMode", {}).get("value")
    _need(mode in (0, 1, 2), "pathHashMode.value must be 0, 1 or 2")

    _need("admins" not in raw, "admin identities belong in each person's browser, not in this file")

    presets = raw.get("radio", {}).get("presets")
    _need(isinstance(presets, list) and presets, "radio.presets is empty")
    for p in presets:
        _need(isinstance(p.get("label"), str) and p["label"], "a radio preset needs a label")
        _need(radio_ok(p.get("freq"), p.get("bw"), p.get("sf"), p.get("cr")),
              f"radio preset {p.get('label')!r} is outside what the firmware accepts")
    _need(len({p["label"] for p in presets}) == len(presets), "two radio presets share a label")

    return {
        "firmware": {"repo": fw["repo"], "tagPattern": fw["tagPattern"], "assetPattern": fw["assetPattern"]},
        "board": {"name": board["name"], "usbVendorId": board["usbVendorId"]},
        "regions": {
            "list": [{"name": r["name"], "parent": r["parent"], "label": r["label"], "ticked": r["ticked"]}
                     for r in entries],
            "default": regions["default"],
            "home": regions["home"],
        },
        "guestPassword": guest,
        "pathHashMode": mode,
        "radioPresets": [{k: p[k] for k in ("label", "freq", "bw", "sf", "cr")} for p in presets],
    }


def public(cfg):
    """What the page gets from /api/config: everything but the firmware source's patterns."""
    return {
        "board": cfg["board"],
        "regions": cfg["regions"],
        "guestPassword": cfg["guestPassword"],
        "pathHashMode": cfg["pathHashMode"],
        "radioPresets": cfg["radioPresets"],
    }
