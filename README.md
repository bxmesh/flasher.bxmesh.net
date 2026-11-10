# MeshCore repeater flasher

A web page that puts [MeshCore](https://github.com/meshcore-dev/MeshCore)'s repeater firmware on a
ProMicro nRF52840 (a "faketec") over its USB cable, then sets it up and checks it, in one go. It
runs at **flasher.bxmesh.net**, or on your own computer (below).

It talks to the board from the browser with [Web Serial](https://wicg.github.io/serial/). The
server only serves the page, its settings and the firmware: nothing typed into the page reaches
it.

## Using it

Chrome or Edge on a computer (Web Serial isn't on phones, Safari or, before 151, Firefox). Plug in
one board, then on the page:

1. **The board**: choose it from the browser's list.
2. **Firmware**: the latest MeshCore repeater release is chosen; older ones are in the list.
3. **Name and location**: the repeater's name, latitude and longitude.
4. **Radio**: Australia (BxMesh), 915.075 MHz · 125 kHz · SF9 · CR 4/5, is the default; MeshCore's
   other community presets are in the list, or type your own values.
5. **Regions**: au and au-nsw are ticked; tick au-nsw-bhs in Bathurst, au-nsw-dge in Mudgee.
   Default and home are au-nsw.
6. **Additional admin identities**: public keys given admin on every repeater you flash, such as a
   monitoring system's or other admins'. They're kept in this browser only (below). Untick one to
   leave it off this repeater.
7. **Passwords**: the admin password, twice. The guest password is `guest`.
8. **Check and start**: **Flash and set up**, or **Set up only** for a board that already runs
   the repeater firmware. Running Set up only again gives the same result.

The page then shows each step as it goes, with a countdown where it's waiting. At the end it reads
everything back and shows a checklist.

### Turning repeating on in the field

The flasher always turns repeating off, so a bench full of charging repeaters doesn't repeat. Once
one is in place, log in to it as admin from the MeshCore app (its remote admin) and send
`set repeat on`. It answers `OK - repeat is now ON`.

## What it sets

Every command and reply below is from MeshCore's firmware at **repeater-v1.18.0** (tag `d95fd91`;
`src/` and `examples/simple_repeater/` are the same on `main` at `81dbae59`). The page sends them
over the serial command line, one at a time, and checks each reply before it sends the next. At
the first unexpected reply it stops and says what the board said.

How the serial command line works (`examples/simple_repeater/main.cpp` 149-166): each character
sent is echoed, `\r` ends a command, and a reply comes back as `  -> <reply>`. Nothing marks the
end of a reply that runs over several lines (`region`), or of one printed without the arrow
(`get acl`). So each command is followed by `ver`, and its echo and answer mark where the first
command's output stops.

| # | Command | Expected reply | Source |
| --- | --- | --- | --- |
| 1 | `region` | the region listing (read first, to see what's there) | `src/helpers/CommonCLI.cpp` 909; listing `src/helpers/RegionMap.cpp` 288 |
| 2 | `get acl` | `ACL:`, then `<perm> <key>` per admin (read first) | `examples/simple_repeater/MyMesh.cpp` 1264 |
| 3 | `set name <name>` | `OK` | `CommonCLI.cpp` 530 (no `[ ] \ : , ? *`; 31 bytes at most) |
| 4 | `set lat <degrees>` | `OK` | `CommonCLI.cpp` 542 |
| 5 | `set lon <degrees>` | `OK` | `CommonCLI.cpp` 546 |
| 6 | `set radio <MHz>,<kHz>,<SF>,<CR>`, e.g. `set radio 915.075,125,9,5` | `OK - reboot to apply` | `src/helpers/CommonRadioPrefs.cpp` 39, dispatched from `CommonCLI.cpp` 184. CR is 5-8 for 4/5-4/8. Saved at once, used from the next restart |
| 7 | `password <password>` | `password now: <password>` | `CommonCLI.cpp` 267. The reply repeats the password, so the page compares it and shows neither |
| 8 | `set guest.password guest` | `OK` | `CommonCLI.cpp` 513 |
| 9 | `set repeat off` | `OK - repeat is now OFF` | `CommonCLI.cpp` 538 |
| 10 | `set path.hash.mode 1` | `OK` | `CommonRadioPrefs.cpp` 179. A hop takes `mode + 1` bytes (`MyMesh.cpp` 1037), so 1 is 2-byte |
| 11 | `region remove <name>`, only for an unticked au, au-nsw, au-nsw-bhs or au-nsw-dge already on the board, children first | `OK` | `CommonCLI.cpp` 994 |
| 12 | `region put au`, `region put au-nsw au`, `region put au-nsw-bhs au-nsw`, … | `OK - (flood allowed)` | `CommonCLI.cpp` 981. A new region denies flood (`RegionMap.cpp` 165); `put` allows it. On a region that exists, it re-parents it |
| 13 | `region default au-nsw` | ` default scope is now au-nsw` | `CommonCLI.cpp` 957; saves the regions itself |
| 14 | `region home au-nsw` | ` home is now au-nsw` | `CommonCLI.cpp` 946; doesn't save |
| 15 | `region save` | `OK` | `CommonCLI.cpp` 913; needed after `put`, `remove` and `home` |
| 16 | `setperm <key> 3` per ticked identity | `OK` | `MyMesh.cpp` 1242; 3 is admin |
| 17 | `setperm <key> 0` per other admin on the board | `OK` | `MyMesh.cpp` 1242. 0 removes the entry (`src/helpers/ClientACL.cpp` 121), so the ticked identities are the only admins |
| 18 | (a 7-second wait) | | The admin list is written 5 s after the last change (`MyMesh.cpp` 61, `LAZY_CONTACTS_WRITE_DELAY`) |
| 19 | `reboot` | none: the board restarts | `CommonCLI.cpp` 196. Needed for the radio settings |

Then it reads back `ver`, `get public.key`, `get name`, `get lat`, `get lon`, `get radio`,
`get guest.password`, `get repeat`, `get path.hash.mode`, `region`, `region default`,
`region home` and `get acl` (`CommonCLI.cpp` 283, 709-750; `CommonRadioPrefs.cpp` 32, 175;
`MyMesh.cpp` 1264). It checks each against what was asked. Latitude, longitude and frequency come
back through a float (`StrHelper::ftoa`), so they're compared to within 0.0001° and 0.0005 MHz.
The admin password can't be read back; the reply to command 7 is its check.

Regions:
- **Names:** `region default` and `region home` take a region's name. `region default` would
  create a missing region at the top level, so the regions are put, each under its parent, first.
- **Flood:** there's no separate step to allow it; `put` does.
- **No restart:** nothing about the regions needs one.

The settings are in [`config/flasher.json`](config/flasher.json): the regions, the guest password,
the path hash mode and the radio presets. Change them there, not in the code.

### Radio presets

Australia (BxMesh) is the BxMesh mesh's settings, read from its companions: 915.075 MHz, 125 kHz,
SF9, CR 4/5, the same as MeshCore's "Australia (Mid)". The rest are MeshCore's community presets
from [api.meshcore.nz/api/v1/config](https://api.meshcore.nz/api/v1/config), read on 11 November
2026, without the deprecated ones. A freshly flashed ProMicro otherwise starts on 869.618 MHz ·
62.5 kHz · SF8 · CR 4/5 (EU; `platformio.ini` 29-31, `MyMesh.cpp` 15).

### Additional admin identities

They're stored in the browser's `localStorage`, for this site only, under
`flasher.bxmesh.net/admin-identities/v1`. Not a cookie: a browser sends a site's cookies
to its server with every request, and these must never reach the server. `localStorage` stays in
the browser until you remove them on the page or clear the site's data. Each person's list is
their own. The tool ships with none.

## Flashing

The `.zip` in each release (`ProMicro_repeater-vX.Y.Z-<commit>.zip`) is adafruit-nrfutil's legacy
DFU package. It holds `manifest.json`, the init packet (`firmware.dat`) and the application
(`firmware.bin`). The `.uf2` is for drag-and-drop instead.

1. **The server** downloads the package from GitHub once. It checks the package against the
   SHA-256 digest GitHub publishes for it, caches it by that digest, and checks the init packet's
   CRC-16 against the image. Releases without a digest aren't offered.
2. **The page** opens the board's port at 1200 baud and closes it (the "touch"). The Adafruit
   nRF52 core then restarts the board into its serial bootloader.
3. **It sends the image** with the bootloader's serial DFU, as adafruit-nrfutil does: SLIP
   frames, each with a header, CRC-16 and sequence number. The packets are start, init, the image
   in 512-byte packets, then stop, and it waits for the bootloader to acknowledge each one.
4. **It waits** for the board to come back with the new firmware and checks its version.

The DFU code (`flasher/web/dfu.js`) is written from adafruit-nrfutil's
`dfu_transport_serial.py` (BSD-3-Clause). It follows MeshCore's own web flasher
(`meshcore-dev/flasher.meshcore.io`, MIT) and Liam Cottle's RNode flasher (MIT). Their notices
are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

If the browser doesn't recognise the board once it has restarted, the page asks you to choose it
again. A board's bootloader can show up as a different device.

## HTTPS

Browsers allow Web Serial only in a secure context: a page over HTTPS, or from `localhost`. So:

- **flasher.bxmesh.net works**: Cloudflare serves it over HTTPS, in front of BxMesh's tunnel.
- **Locally**, `http://localhost:8080` works: localhost counts as secure.
- **Plain HTTP anywhere else doesn't**, such as a LAN name or an IP address. The page says so
  instead of offering to connect.

## Running it locally

You need Python 3.11 or later, with no packages to install.

```sh
git clone https://github.com/bxmesh/flasher.bxmesh.net
cd flasher.bxmesh.net
python3 -m flasher
```

Then open **http://localhost:8080** in Chrome or Edge. It listens on 127.0.0.1 only
(`--host`, `--port` to change). It caches firmware in `~/.cache/flasher.bxmesh.net`.

## Deploying it

The chart is in [`deploy/`](deploy/). CI (GitHub-hosted runners) writes the image tag into
`deploy/values.yaml` on each pull request that changes the image, staging the deployment; it never
deploys itself. On cluster-02 it needs:

- **Its line in cluster-platform's enrolment list**, in the dmz zone, released by hand like every
  BxMesh repo (O14): Argo makes its namespace. The image, `ghcr.io/bxmesh/flasher.bxmesh.net`,
  is public, so no pull secret.
- **BxMesh's gateway** (`bxmesh` in `platform-gateways`, listener `http`) and **BxMesh's
  Cloudflare tunnel** in front of it, which ends TLS for `flasher.bxmesh.net`.
- **external-dns-bxmesh**, to write `flasher.bxmesh.net` from the chart's HTTPRoute (its hostname
  is the value `hostname`).
- **Egress to GitHub**: `api.github.com` (the release list) and
  `github.com/meshcore-dev/MeshCore/releases/download/`, which redirects to
  `release-assets.githubusercontent.com` (the packages). Nothing else.
- **`CF-Connecting-IP` set by Cloudflare** (`clientIpHeader`), so the per-visitor limits see
  visitors, not the tunnel.

The pod holds nothing that matters. Its cache of packages is an `emptyDir`, refilled from GitHub
after a restart. It runs as nobody, read-only, with `/healthz` for its probes.

### Hardening

- **Content Security Policy:** a strict one, `'self'` only, with no third-party scripts, styles
  or fonts.
- **Headers:** `Permissions-Policy: serial=(self)`, `nosniff` and `no-referrer`.
- **No cookies, GET and HEAD only:** the page never sends anything to the server.
- **Per-visitor limits:** the firmware list allows 60 requests a minute and the packages 12 per
  10 minutes; past that it answers 429 with a time to wait.
- **GitHub is asked sparingly:** at most once per 10 minutes for the list, and once per package,
  since packages are cached by digest.

## Tests

- **Server** (`tests/test_server.py`), against a fake GitHub (`tests/fake_github.py`):
  `python3 -m unittest discover -s tests`. CI runs them inside the built image, with no network.
- **Page** (`tests/web/test_page.py`): headless Chromium against the local server.
  - The fake board (`tests/web/fake-serial.js`) stands in for Web Serial. It models the
    repeater's command line from the firmware source and the bootloader's serial DFU.
  - The tests flash, set up, set up again and check the result. They also check that the page
    stops at a refusal, that it asks for the board when the browser needs it, and that the admin
    password and identities never leave the browser.
  - Run them with `./run-page-tests`, which needs only Docker and uses Microsoft's Playwright
    image, the same as CI. `SCREENSHOTS=<dir> ./run-page-tests` saves a screenshot of each step.

The tests never touch a real serial port or USB device.

## Not checked without a board

The fakes follow the firmware and nrfutil's protocol, but these are only known on hardware:

- the 1200-baud touch on a real ProMicro;
- how a real bootloader times its acknowledgements;
- how long the board takes to come back after flashing;
- whether Chrome recognises the bootloader and the restarted board without asking again (the page
  copes either way).

## Licence

BSD 3-Clause, Copyright (c) 2026, Joshua Mesilane. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
