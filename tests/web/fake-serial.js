// A fake ProMicro for the page tests, put in place of navigator.serial before the page loads.
// No real port or USB device is touched.
//
// The board is modelled on MeshCore's firmware at repeater-v1.18.0 (d95fd91):
//   the serial loop       examples/simple_repeater/main.cpp loop(): echo, "\r", "  -> reply"
//   the commands          src/helpers/CommonCLI.cpp, src/helpers/CommonRadioPrefs.cpp,
//                         examples/simple_repeater/MyMesh.cpp handleCommand (setperm, get acl)
//   regions               src/helpers/RegionMap.cpp (putRegion, findByNamePrefix, the listing)
//   the access list       src/helpers/ClientACL.cpp applyPermissions; written 5 s after a change
//   numbers read back     src/helpers/TxtDataHelpers.cpp StrHelper::ftoa, ftoa3
// and on the Adafruit nRF52 bootloader's serial DFU (the legacy HCI transport that
// adafruit-nrfutil's dfu_transport_serial.py speaks): SLIP frames, header checksum, CRC-16,
// sequence numbers, an acknowledgement per packet, start / init / data / stop.
//
// window.__fakeOptions (set before this runs) changes the board; window.__fake exposes it.

(() => {
  const opt = Object.assign(
    {
      samePermission: true, // after the board re-appears, the browser still has permission
      firmware: { version: "v1.17.1", build: "14 Aug 2026" }, // what it runs at first, or null: bootloader only
      firmwareByCrc: {}, // image CRC-16 -> { version, build }
      prefs: {},
      regions: null, // [{ name, parent, flood }] saved before the test
      acl: [], // [{ key, perm }] saved before the test
      replies: {}, // command -> a reply to give instead
      aclDelayMs: 5000,
      bootMs: 400,
      startMs: 300,
    },
    window.__fakeOptions || {},
  );

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const VID = 0x239a;
  const PID = 0x00b3;
  const PUBKEY = "A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00";

  function crc16(data, crc = 0xffff) {
    for (const b of data) {
      crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
      crc ^= b;
      crc ^= (crc & 0x00ff) >> 4;
      crc ^= (crc << 8) << 4;
      crc ^= ((crc & 0x00ff) << 4) << 1;
      crc &= 0xffff;
    }
    return crc;
  }

  // StrHelper::ftoa: the float's bits, 7 decimal digits, trailing zeros dropped.
  function ftoa(d) {
    const f = Math.fround(d);
    if (f === 0) return "0.0";
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, f);
    const L = dv.getInt32(0);
    const exp2 = ((L >> 23) & 0xff) - 127;
    const mantissa = (L & 0xffffff) | 0x800000;
    let intPart = 0;
    let frac = 0;
    if (exp2 >= 31 || exp2 < -23) return "0";
    if (exp2 >= 23) intPart = mantissa << (exp2 - 23);
    else if (exp2 >= 0) {
      intPart = mantissa >> (23 - exp2);
      frac = (mantissa << (exp2 + 1)) & 0xffffff;
    } else frac = (mantissa & 0xffffff) >> -(exp2 + 1);
    let s = (L < 0 ? "-" : "") + String(intPart) + ".";
    if (frac === 0) return s + "0";
    let digits = "";
    for (let m = 0; m < 7; m++) {
      frac = frac * 10;
      digits += String(frac >> 24);
      frac &= 0xffffff;
    }
    digits = digits.replace(/0+$/, "");
    return s + (digits || "0");
  }

  function ftoa3(f) {
    f = Math.fround(f);
    const v = Math.trunc(f * 1000 + (f >= 0 ? 0.5 : -0.5));
    let s = `${Math.trunc(v / 1000)}.${String(Math.abs(v % 1000)).padStart(3, "0")}`;
    s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }

  const atoi = (s) => {
    const m = /^\s*[-+]?\d+/.exec(s);
    return m ? parseInt(m[0], 10) : 0;
  };
  const atof = (s) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  };

  // --- The board's stored state (its flash) and what's running ------------------------------

  const stored = {
    prefs: Object.assign(
      {
        node_name: "ProMicro Repeater", node_lat: 0, node_lon: 0, password: "password", guest_password: "",
        freq: 869.618, bw: 62.5, sf: 8, cr: 5, disable_fwd: 0, path_hash_mode: 0,
      },
      opt.prefs,
    ),
    regions: { next_id: 1, default_id: 0, home_id: 0, wildcard_flags: 0, list: [] },
    acl: opt.acl.map((e) => ({ key: e.key.toLowerCase(), perm: e.perm })),
  };
  for (const r of opt.regions || []) {
    const parent = r.parent ? stored.regions.list.find((x) => x.name === r.parent).id : 0;
    stored.regions.list.push({ id: stored.regions.next_id++, parent, flags: r.flood === false ? 1 : 0, name: r.name });
  }

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const fake = {
    mode: opt.firmware ? "app" : "bootloader",
    firmware: opt.firmware,
    stored,
    live: null,
    commands: [], // every command the CLI received, in order
    dfu: null, // the last transfer: { init, image, sizes, done, error }
    portRequests: 0,
    reboots: 0,
    errors: [],
  };
  window.__fake = fake;

  // --- RegionMap.cpp ------------------------------------------------------------------------

  const isNameChar = (c) => c === "-" || c === "$" || c === "#" || (c >= "0" && c <= "9") || c.charCodeAt(0) >= 65;
  const skipHash = (n) => (n[0] === "#" ? n.slice(1) : n);
  const WILDCARD = { id: 0, parent: 0, name: "*" };

  function rmFindByName(rm, name) {
    if (name === "*") return { ...WILDCARD, flags: rm.wildcard_flags };
    if (name[0] === "#") name = name.slice(1);
    return rm.list.find((r) => skipHash(r.name) === name) || null;
  }
  function rmFindByNamePrefix(rm, prefix) {
    if (prefix === "*") return { ...WILDCARD, flags: rm.wildcard_flags };
    if (prefix[0] === "#") prefix = prefix.slice(1);
    let partial = null;
    for (const r of rm.list) {
      if (skipHash(r.name) === prefix) return r;
      if (skipHash(r.name).startsWith(prefix)) partial = r;
    }
    return partial;
  }
  const rmFindById = (rm, id) => (id === 0 ? { ...WILDCARD, flags: rm.wildcard_flags } : rm.list.find((r) => r.id === id) || null);
  function rmPut(rm, name, parentId) {
    for (const c of name) if (!isNameChar(c)) return null;
    let r = rmFindByName(rm, name);
    if (r && r.id !== 0) {
      if (r.id === parentId) return null;
      r.parent = parentId;
      return r;
    }
    if (rm.list.length >= 32) return null;
    r = { id: rm.next_id++, parent: parentId, flags: 1, name: name.slice(0, 30) };
    rm.list.push(r);
    return r;
  }
  function rmRemove(rm, r) {
    if (r.id === 0) return false;
    if (rm.list.some((x) => x.parent === r.id)) return false;
    rm.list = rm.list.filter((x) => x.id !== r.id);
    return true;
  }
  function rmExport(rm) {
    let out = "";
    const print = (indent, r) => {
      out += " ".repeat(indent) + skipHash(r.name) + (r.id === rm.home_id ? "^" : "") + (r.flags & 1 ? "" : " F") + "\n";
      for (const c of rm.list) if (c.parent === r.id) print(indent + 1, c);
    };
    print(0, { ...WILDCARD, flags: rm.wildcard_flags });
    return out.slice(0, 159);
  }

  // --- The command line ---------------------------------------------------------------------

  let aclTimer = null;

  function isValidName(n) {
    return !/[\[\]\\:,?*]/.test(n);
  }

  function handle(command, out) {
    const p = fake.live.prefs;
    const rm = fake.live.regions;
    command = command.replace(/^ +/, "");
    fake.commands.push(command);
    if (command in opt.replies) return opt.replies[command];

    // MyMesh::handleCommand first: setperm, get acl.
    if (command.startsWith("setperm ")) {
      const rest = command.slice(8);
      const sp = rest.indexOf(" ");
      if (sp < 0) return "Err - bad params";
      const hex = rest.slice(0, Math.min(sp, 64));
      if (!/^([0-9A-Fa-f]{2})*$/.test(hex.slice(0, (hex.length >> 1) * 2))) return "Err - bad pubkey";
      const key = hex.slice(0, (hex.length >> 1) * 2).toLowerCase();
      const perms = atoi(rest.slice(sp + 1)) & 0xff;
      const acl = fake.live.acl;
      if ((perms & 3) === 0) {
        const i = acl.findIndex((e) => e.key.startsWith(key));
        if (i < 0) return "Err - invalid params";
        acl.splice(i, 1);
      } else {
        if (key.length < 64) return "Err - invalid params";
        let e = acl.find((x) => x.key === key);
        if (!e) {
          e = { key, perm: 0 };
          acl.push(e);
        }
        e.perm = perms;
      }
      clearTimeout(aclTimer);
      aclTimer = setTimeout(() => (fake.stored.acl = clone(fake.live.acl)), opt.aclDelayMs);
      return "OK";
    }
    if (command === "get acl") {
      out("ACL:\r\n");
      for (const e of fake.live.acl) {
        if (e.perm === 0) continue;
        out(`${e.perm.toString(16).toUpperCase().padStart(2, "0")} ${e.key.toUpperCase()}\n`);
      }
      return "";
    }

    // CommonRadioPrefs::handleCommand, before the rest of CommonCLI.
    if (command === "get radio") return `> ${ftoa(p.freq)},${ftoa3(p.bw)},${p.sf},${p.cr}`;
    if (command.startsWith("set radio ")) {
      const parts = command.slice(10).split(",").slice(0, 4);
      const freq = Math.fround(atof(parts[0] || ""));
      const bw = Math.fround(atof(parts[1] || ""));
      const sf = atoi(parts[2] || "") & 0xff;
      const cr = atoi(parts[3] || "") & 0xff;
      if (freq >= 150 && freq <= 2500 && sf >= 5 && sf <= 12 && cr >= 5 && cr <= 8 && bw >= 7 && bw <= 500) {
        Object.assign(p, { freq, bw, sf, cr });
        save();
        return "OK - reboot to apply";
      }
      return "Error, invalid radio params";
    }
    if (command === "get path.hash.mode") return `> ${p.path_hash_mode}`;
    if (command.startsWith("set path.hash.mode ")) {
      const m = atoi(command.slice(19)) & 0xff;
      if (m < 3) {
        p.path_hash_mode = m;
        save();
        return "OK";
      }
      return "Error, must be 0,1, or 2";
    }

    if (command.startsWith("reboot")) return reboot();
    if (command.startsWith("ver")) return `${fake.firmware.version} (Build: ${fake.firmware.build})`;
    if (command.startsWith("password ")) {
      p.password = command.slice(9).slice(0, 15);
      save();
      return "password now: " + p.password;
    }
    if (command.startsWith("get ")) {
      const c = command.slice(4);
      if (c.startsWith("guest.password")) return `> ${p.guest_password}`;
      if (c.startsWith("name")) return `> ${p.node_name}`;
      if (c.startsWith("repeat")) return `> ${p.disable_fwd ? "off" : "on"}`;
      if (c.startsWith("lat")) return `> ${ftoa(p.node_lat)}`;
      if (c.startsWith("lon")) return `> ${ftoa(p.node_lon)}`;
      if (c.startsWith("public.key")) return `> ${PUBKEY}`;
      if (c.startsWith("role")) return "> repeater";
      return `??: ${c}`;
    }
    if (command.startsWith("set ")) {
      const c = command.slice(4);
      if (c.startsWith("guest.password ")) {
        p.guest_password = c.slice(15).slice(0, 15);
        save();
        return "OK";
      }
      if (c.startsWith("name ")) {
        if (!isValidName(c.slice(5))) return "Error, bad chars";
        p.node_name = c.slice(5).slice(0, 31);
        save();
        return "OK";
      }
      if (c.startsWith("repeat ")) {
        p.disable_fwd = c.slice(7).startsWith("off") ? 1 : 0;
        save();
        return p.disable_fwd ? "OK - repeat is now OFF" : "OK - repeat is now ON";
      }
      if (c.startsWith("lat ")) {
        p.node_lat = atof(c.slice(4));
        save();
        return "OK";
      }
      if (c.startsWith("lon ")) {
        p.node_lon = atof(c.slice(4));
        save();
        return "OK";
      }
      return "unknown config: " + c;
    }
    if (command.startsWith("region")) return region(command, rm);
    return "Unknown command";
  }

  function region(command, rm) {
    const saveRegions = () => (fake.stored.regions = clone(rm));
    const def = /^region def( |$)/.exec(command);
    if (def) return "Err - not modelled";
    const parts = command.split(" ").slice(0, 4);
    const n = parts.length;
    if (n === 1) return rmExport(rm);
    const [, sub, a, b] = parts;
    if (sub === "save") {
      saveRegions();
      save();
      return "OK";
    }
    if (n >= 3 && sub === "allowf") {
      const r = rmFindByNamePrefix(rm, a);
      if (!r) return "Err - unknown region";
      r.flags &= ~1;
      return "OK";
    }
    if (n >= 3 && sub === "get") {
      const r = rmFindByNamePrefix(rm, a);
      if (!r) return "Err - unknown region";
      const parent = rmFindById(rm, r.parent);
      return parent && parent.id !== 0 ? ` ${r.name} (${parent.name}) ${r.flags & 1 ? "" : "F"}` : ` ${r.name} ${r.flags & 1 ? "" : "F"}`;
    }
    if (n >= 3 && sub === "home") {
      const r = rmFindByNamePrefix(rm, a);
      if (!r) return "Err - unknown region";
      rm.home_id = r.id;
      return ` home is now ${r.name}`;
    }
    if (n === 2 && sub === "home") {
      const r = rmFindById(rm, rm.home_id);
      return ` home is ${r ? r.name : "*"}`;
    }
    if (n >= 3 && sub === "default") {
      let r = rmFindByNamePrefix(rm, a);
      if (!r) r = rmPut(rm, a, 0);
      if (!r) return "Err - region table full";
      r.flags = 0;
      rm.default_id = r.id;
      saveRegions();
      return ` default scope is now ${r.name}`;
    }
    if (n === 2 && sub === "default") {
      const r = rm.default_id ? rmFindById(rm, rm.default_id) : null;
      return ` default scope is ${r ? r.name : "<null>"}`;
    }
    if (n >= 3 && sub === "put") {
      const parent = n >= 4 ? rmFindByNamePrefix(rm, b) : { id: 0 };
      if (!parent) return "Err - unknown parent";
      const r = rmPut(rm, a, parent.id);
      if (!r) return "Err - unable to put";
      r.flags = 0;
      return "OK - (flood allowed)";
    }
    if (n >= 3 && sub === "remove") {
      const r = rmFindByName(rm, a);
      if (!r) return "Err - not found";
      return rmRemove(rm, r) ? "OK" : "Err - not empty";
    }
    return "Err - ??";
  }

  function save() {
    fake.stored.prefs = clone(fake.live.prefs);
  }

  // --- Ports and the browser's serial API ---------------------------------------------------

  class FakePort extends EventTarget {
    constructor(kind) {
      super();
      this.kind = kind;
      this.connected = true;
      this.isOpen = false;
      this.readable = null;
      this.writable = null;
    }
    getInfo() {
      return { usbVendorId: VID, usbProductId: PID };
    }
    async open({ baudRate }) {
      if (!this.connected) throw new DOMException("The device has been lost.", "NetworkError");
      if (this.isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
      this.isOpen = true;
      this.baud = baudRate;
      this.readable = new ReadableStream({ start: (c) => (this.rc = c) });
      this.writable = new WritableStream({
        write: (chunk) => {
          if (!this.connected) throw new DOMException("The device has been lost.", "NetworkError");
          receive(this, new Uint8Array(chunk));
        },
      });
    }
    async setSignals() {
      if (!this.isOpen) throw new DOMException("The port is closed.", "InvalidStateError");
    }
    async close() {
      if (!this.isOpen) throw new DOMException("The port is already closed.", "InvalidStateError");
      if (this.readable && this.readable.locked) throw new TypeError("Cannot close a port with a locked readable stream.");
      if (this.writable && this.writable.locked) throw new TypeError("Cannot close a port with a locked writable stream.");
      try {
        this.rc.close();
      } catch {}
      this.isOpen = false;
      this.readable = this.writable = null;
      // The 1200-baud touch: the Adafruit core restarts into the serial bootloader.
      if (this.kind === "app" && this.baud === 1200 && this.connected) setTimeout(() => restartInto("bootloader"), 50);
    }
    push(bytes) {
      if (this.isOpen && this.connected) {
        try {
          this.rc.enqueue(bytes);
        } catch {}
      }
    }
    lose() {
      this.connected = false;
      if (this.isOpen) {
        try {
          this.rc.error(new DOMException("The device has been lost.", "NetworkError"));
        } catch {}
      }
      const ev = new Event("disconnect");
      Object.defineProperty(ev, "target", { value: this });
      serialApi.dispatchEvent(ev);
    }
  }

  class FakeSerial extends EventTarget {
    constructor() {
      super();
      this.permitted = new Set();
    }
    async requestPort(options = {}) {
      fake.portRequests++;
      const p = fake.port;
      if (!p || !p.connected) throw new DOMException("No port selected by the user.", "NotFoundError");
      const filters = options.filters || [];
      if (filters.length && !filters.some((f) => f.usbVendorId === undefined || f.usbVendorId === VID)) {
        throw new DOMException("No port selected by the user.", "NotFoundError");
      }
      this.permitted.add(p);
      return p;
    }
    async getPorts() {
      return [...this.permitted].filter((p) => p.connected);
    }
  }

  const serialApi = new FakeSerial();
  Object.defineProperty(Navigator.prototype, "serial", { get: () => serialApi, configurable: true });

  function attach(kind) {
    const p = new FakePort(kind);
    fake.port = p;
    fake.mode = kind;
    if (kind === "app") {
      fake.live = { prefs: clone(fake.stored.prefs), regions: clone(fake.stored.regions), acl: clone(fake.stored.acl) };
      fake.ready = false;
      line = [];
      queue = [];
      setTimeout(() => (fake.ready = true), opt.startMs); // setup(): delay(1000), radio, filesystem
    } else {
      fake.dfu = { state: "idle", seq: 0, rx: [], init: null, image: [], sizes: null, done: false, error: null };
    }
    if (opt.samePermission && fake.everPermitted) serialApi.permitted.add(p);
    const ev = new Event("connect");
    Object.defineProperty(ev, "target", { value: p });
    serialApi.dispatchEvent(ev);
  }

  function restartInto(kind) {
    const old = fake.port;
    fake.everPermitted = serialApi.permitted.size > 0;
    clearTimeout(aclTimer); // anything not yet written is lost
    old.lose();
    fake.port = null;
    setTimeout(() => attach(kind), opt.bootMs);
  }

  function reboot() {
    fake.reboots++;
    setTimeout(() => restartInto("app"), 20);
    return null; // NVIC_SystemReset(): nothing is printed
  }

  // --- The serial loop (main.cpp) -------------------------------------------------------------

  function receive(port, bytes) {
    if (port !== fake.port) return;
    if (fake.mode === "app") return appReceive(port, bytes);
    return dfuReceive(port, bytes);
  }

  // Bytes are taken one at a time, as loop() does: a command's echo, its "\n" and its reply all
  // come out before the next command's echo.
  let line = [];
  let queue = [];
  let pumping = false;
  function appReceive(port, bytes) {
    if (!fake.ready) return; // still starting: lost, as on the board
    queue.push(...bytes);
    if (!pumping) {
      pumping = true;
      setTimeout(() => pump(port), 1);
    }
  }
  function pump(port) {
    pumping = false;
    while (queue.length && port === fake.port) {
      const b = queue.shift();
      if (b !== 0x0a) {
        line.push(b);
        port.push(Uint8Array.of(b));
      }
      if (b === 0x0d) {
        const cmd = dec.decode(Uint8Array.from(line.slice(0, -1)));
        line = [];
        port.push(enc.encode("\n"));
        const reply = handle(cmd, (s) => port.push(enc.encode(s)));
        if (reply) port.push(enc.encode(`  -> ${reply}\r\n`));
        if (cmd.startsWith("reboot")) {
          queue = [];
          return;
        }
      }
    }
    queue = [];
  }

  // --- The bootloader (serial DFU) -----------------------------------------------------------

  function dfuFail(why) {
    fake.dfu.error = why;
    fake.errors.push(why);
  }

  function dfuReceive(port, bytes) {
    const d = fake.dfu;
    for (const b of bytes) {
      if (b === 0xc0) {
        if (d.rx.length) frame(port, d.rx);
        d.rx = [];
      } else d.rx.push(b);
    }
  }

  function unslip(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xdb) {
        const n = bytes[++i];
        if (n === 0xdc) out.push(0xc0);
        else if (n === 0xdd) out.push(0xdb);
        else return null;
      } else out.push(bytes[i]);
    }
    return out;
  }

  function frame(port, raw) {
    const d = fake.dfu;
    if (d.error) return; // a stuck bootloader answers nothing more
    const f = unslip(raw);
    if (!f || f.length < 6) return dfuFail("bad SLIP frame");
    const [h0, h1, h2, h3] = f;
    if (((h0 + h1 + h2 + h3) & 0xff) !== 0) return dfuFail("bad header checksum");
    const seq = h0 & 7;
    const dip = (h0 >> 6) & 1;
    const rp = (h0 >> 7) & 1;
    const type = h1 & 0x0f;
    const len = ((h1 >> 4) & 0x0f) | (h2 << 4);
    if (!dip || !rp || type !== 14) return dfuFail("not a reliable HCI packet with a CRC");
    if (f.length !== 4 + len + 2) return dfuFail("length doesn't match the header");
    const crc = crc16(Uint8Array.from(f.slice(0, 4 + len)));
    if (crc !== (f[4 + len] | (f[5 + len] << 8))) return dfuFail("bad CRC");
    if (seq !== (d.seq + 1) % 8) return dfuFail(`sequence ${seq} after ${d.seq}`);
    d.seq = seq;
    const payload = f.slice(4, 4 + len);
    const ack = (seq + 1) % 8;
    const hdr = [ack << 3, 0, 0];
    hdr.push((~(hdr[0] + hdr[1] + hdr[2]) + 1) & 0xff);
    setTimeout(() => port.push(Uint8Array.from([0xc0, ...hdr, 0xc0])), 1);

    const u32 = (o) => (payload[o] | (payload[o + 1] << 8) | (payload[o + 2] << 16) | (payload[o + 3] << 24)) >>> 0;
    const op = u32(0);
    if (op === 3) {
      if (d.state !== "idle") return dfuFail("start out of order");
      if (u32(4) !== 4) return dfuFail("not an application update");
      d.sizes = { sd: u32(8), bl: u32(12), app: u32(16) };
      d.state = "started";
    } else if (op === 1) {
      if (d.state !== "started") return dfuFail("init out of order");
      d.init = payload.slice(4, -2);
      if (payload.slice(-2).some((x) => x !== 0)) return dfuFail("init packet padding");
      d.state = "data";
    } else if (op === 4) {
      if (d.state !== "data") return dfuFail("data out of order");
      for (const b of payload.slice(4)) d.image.push(b);
      if (d.image.length > d.sizes.app) return dfuFail("more data than the start packet said");
    } else if (op === 5) {
      if (d.state !== "data") return dfuFail("stop out of order");
      if (d.image.length !== d.sizes.app) return dfuFail("image shorter than the start packet said");
      const want = d.init[d.init.length - 2] | (d.init[d.init.length - 1] << 8);
      const got = crc16(Uint8Array.from(d.image));
      if (want !== got) return dfuFail("image CRC doesn't match the init packet");
      d.done = true;
      d.state = "done";
      const fw = opt.firmwareByCrc[String(got)] || { version: "v0.0.0-unknown", build: "?" };
      setTimeout(() => {
        fake.firmware = fw;
        restartInto("app");
      }, 200);
    } else return dfuFail(`unknown packet ${op}`);
  }

  // The board as plugged in.
  fake.everPermitted = false;
  attach(fake.mode);
  fake.everPermitted = true;
})();
