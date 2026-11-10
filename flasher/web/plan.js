// What the page asks of a repeater, and how it reads the answers: no browser or serial code here.
//
// Every command and reply below is from MeshCore's firmware at repeater-v1.18.0 (tag d95fd91):
//   CommonCLI.cpp      src/helpers/CommonCLI.cpp
//   RadioPrefs.cpp     src/helpers/CommonRadioPrefs.cpp
//   RegionMap.cpp      src/helpers/RegionMap.cpp
//   MyMesh.cpp         examples/simple_repeater/MyMesh.cpp
// README "What it sets" lists them with their lines.

export const NAME_BAD_CHARS = /[\[\]\\:,?*]/;          // CommonCLI.cpp isValidName
export const NAME_MAX_BYTES = 31;                       // NodePrefs.node_name[32]
export const PASSWORD_MAX = 15;                         // NodePrefs.password[16]
export const KEY_RE = /^[0-9a-f]{64}$/;                 // an Ed25519 public key, as hex
export const ACL_SAVE_WAIT_S = 7;                       // MyMesh.cpp LAZY_CONTACTS_WRITE_DELAY 5000 ms, and a margin

const utf8 = new TextEncoder();

export function crLabel(cr) {
  return `4/${cr}`;
}

export function radioText(r) {
  return `${r.freq} MHz · ${r.bw} kHz · SF${r.sf} · CR ${crLabel(r.cr)}`;
}

// "set radio" refuses anything outside these (RadioPrefs.cpp, CommonRadioPrefs::handleCommand).
export function radioProblem(r) {
  const n = (x) => typeof x === "number" && Number.isFinite(x);
  if (!n(r.freq) || r.freq < 150 || r.freq > 2500) return "Frequency must be between 150 and 2500 MHz.";
  if (!n(r.bw) || r.bw < 7 || r.bw > 500) return "Bandwidth must be between 7 and 500 kHz.";
  if (!Number.isInteger(r.sf) || r.sf < 5 || r.sf > 12) return "Spreading factor must be a whole number from 5 to 12.";
  if (!Number.isInteger(r.cr) || r.cr < 5 || r.cr > 8) return "Coding rate must be 4/5, 4/6, 4/7 or 4/8.";
  return null;
}

export function nameProblem(name) {
  if (!name) return "Give the repeater a name.";
  if (name !== name.trim()) return "The name can't start or end with a space.";
  if (/[\x00-\x1f\x7f]/.test(name)) return "The name can't contain control characters.";
  if (NAME_BAD_CHARS.test(name)) return "The name can't contain any of [ ] \\ : , ? *";
  if (utf8.encode(name).length > NAME_MAX_BYTES) return `The name is too long: ${NAME_MAX_BYTES} bytes at most.`;
  return null;
}

const DEGREES = /^-?\d{1,3}(\.\d{1,7})?$/;

export function coordProblem(text, max, what) {
  if (!text) return `Enter the ${what}.`;
  if (!DEGREES.test(text)) return `Enter the ${what} in decimal degrees, like ${what === "latitude" ? "-33.4194" : "149.5775"}.`;
  const v = Number(text);
  if (Math.abs(v) > max) return `The ${what} must be between -${max} and ${max}.`;
  return null;
}

export function passwordProblem(pw, again) {
  if (!pw) return "Choose an admin password.";
  if (!/^[\x20-\x7e]+$/.test(pw)) return "Use letters, numbers and ordinary symbols only.";
  if (pw !== pw.trim()) return "The password can't start or end with a space.";
  if (pw.length > PASSWORD_MAX) return `The firmware keeps ${PASSWORD_MAX} characters at most.`;
  if (pw !== again) return "The two passwords don't match.";
  return null;
}

// The ticked regions, parents before children (cfg.regions.list is in that order).
export function tickedRegions(cfg, ticked) {
  return cfg.regions.list.filter((r) => ticked.includes(r.name));
}

export function regionsProblem(cfg, ticked, def, home) {
  const list = tickedRegions(cfg, ticked);
  if (!list.length) return "Tick at least one region.";
  for (const r of list) {
    if (r.parent && !ticked.includes(r.parent)) return `${r.name} needs ${r.parent} ticked too.`;
  }
  if (!ticked.includes(def)) return "The default region must be one of the ticked regions.";
  if (!ticked.includes(home)) return "The home region must be one of the ticked regions.";
  return null;
}

// --- Reading the board's answers -------------------------------------------------------------

// A "get" reply: "> value" (CommonCLI.cpp handleGetCmd).
export function getValue(reply) {
  return reply && reply.startsWith("> ") ? reply.slice(2) : null;
}

// The region listing (RegionMap.cpp printChildRegions): one line per region, indented one space
// per level under the wildcard "*", "^" after the home region, " F" when flood is allowed.
export function parseRegions(reply) {
  const out = [];
  const stack = [];
  for (const line of (reply || "").split("\n")) {
    const m = /^( *)([^ ^]+)(\^?)( F)?$/.exec(line);
    if (!m) continue;
    const depth = m[1].length;
    stack.length = depth;
    const name = m[2];
    out.push({ name, depth, parent: depth > 0 ? stack[depth - 1] ?? null : null, home: m[3] === "^", flood: !!m[4] });
    stack[depth] = name;
  }
  return out;
}

// "get acl" (MyMesh.cpp, serial only): "ACL:", then "<perm hex> <public key hex>" per entry.
export function parseAcl(lines) {
  const out = [];
  for (const line of lines || []) {
    const m = /^([0-9A-Fa-f]{2}) ([0-9A-Fa-f]{64})$/.exec(line.trim());
    if (m) out.push({ perm: parseInt(m[1], 16), key: m[2].toLowerCase() });
  }
  return out;
}

// "get radio": "> freq,bw,sf,cr" (RadioPrefs.cpp).
export function parseRadio(reply) {
  const v = getValue(reply);
  if (!v) return null;
  const p = v.split(",").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) return null;
  return { freq: p[0], bw: p[1], sf: p[2], cr: p[3] };
}

// --- The commands -----------------------------------------------------------------------------

function exact(want, explain) {
  return (reply) => (reply === want ? null : explain(reply));
}

function trimmed(want, explain) {
  return (reply) => ((reply || "").trim() === want ? null : explain(reply));
}

function said(reply) {
  if (reply === null || reply === undefined) return "the board didn't answer";
  if (reply === "Unknown command" || reply.startsWith("unknown config") || reply.startsWith("??"))
    return "this firmware doesn't know that setting (flash a newer version)";
  return `the board said "${reply}"`;
}

// The configuration, in order, for a board whose current regions and access list are given
// (read with "region" and "get acl" just before). Each step: the command, what it's for in
// plain words, and a check of the reply. secret: never shown or logged as typed.
export function buildCommands(cfg, input, board) {
  const cmds = [];
  const add = (cmd, label, expect, extra = {}) => cmds.push({ cmd, label, expect, ...extra });

  // CommonCLI.cpp handleSetCmd: "set name", "set lat", "set lon"; each saves and answers "OK".
  add(`set name ${input.name}`, `Set the name to ${input.name}`,
    exact("OK", (r) => (r === "Error, bad chars" ? "the board refused the name's characters" : said(r))));
  add(`set lat ${input.lat}`, `Set the latitude to ${input.lat}`, exact("OK", said));
  add(`set lon ${input.lon}`, `Set the longitude to ${input.lon}`, exact("OK", said));

  // RadioPrefs.cpp "set radio <MHz>,<kHz>,<SF>,<CR>": saved now, used from the next restart.
  const r = input.radio;
  add(`set radio ${r.freq},${r.bw},${r.sf},${r.cr}`, `Set the radio to ${radioText(r)}`,
    exact("OK - reboot to apply", (x) => (x === "Error, invalid radio params" ? "the board refused those radio settings" : said(x))));

  // CommonCLI.cpp "password <pw>": answers "password now: <pw>", which is checked, never shown.
  add(`password ${input.adminPassword}`, "Set the admin password",
    exact(`password now: ${input.adminPassword}`, (x) => (x && x.startsWith("password now: ") ? "the board kept a different password" : said(x))),
    { secret: true, shown: "password ••••••••" });

  add(`set guest.password ${cfg.guestPassword}`, `Set the guest password to ${cfg.guestPassword}`, exact("OK", said));
  // "set repeat off": disable_fwd, so it doesn't repeat while it's on the bench.
  add("set repeat off", "Turn repeating off", exact("OK - repeat is now OFF", said));
  // RadioPrefs.cpp "set path.hash.mode": 0 to 2; a hop takes mode + 1 bytes.
  add(`set path.hash.mode ${cfg.pathHashMode}`, `Use ${cfg.pathHashMode + 1}-byte path hashes`, exact("OK", said));

  // Regions (CommonCLI.cpp handleRegionCmd). Managed regions that aren't ticked are removed,
  // children first ("region remove" refuses a region with children).
  const present = new Set(board.regions.map((x) => x.name));
  const unticked = cfg.regions.list.filter((x) => !input.regions.includes(x.name) && present.has(x.name)).reverse();
  for (const x of unticked) {
    add(`region remove ${x.name}`, `Remove the region ${x.name}`,
      exact("OK", (y) => (y === "Err - not empty" ? `${x.name} has other regions under it that this page doesn't manage` : said(y))));
  }
  // "region put <name> [<parent>]": adds or moves it, and allows flood on it (flags = 0).
  for (const x of tickedRegions(cfg, input.regions)) {
    const cmd = x.parent ? `region put ${x.name} ${x.parent}` : `region put ${x.name}`;
    add(cmd, x.parent ? `Add the region ${x.name} under ${x.parent}` : `Add the region ${x.name}`,
      exact("OK - (flood allowed)", said));
  }
  add(`region default ${input.defaultRegion}`, `Make ${input.defaultRegion} the default region`,
    trimmed(`default scope is now ${input.defaultRegion}`, said));
  add(`region home ${input.homeRegion}`, `Make ${input.homeRegion} the home region`,
    trimmed(`home is now ${input.homeRegion}`, said));
  // "region home" and "region put" change only memory: "region save" writes them.
  add("region save", "Save the regions", exact("OK", (y) => (y === "Err - save failed" ? "the board couldn't save its regions" : said(y))));

  // Admins (MyMesh.cpp "setperm <key> <perm>"): 3 is admin, 0 removes the entry. Anyone else
  // already on the list is removed, so the ticked identities are the only ones.
  for (const k of input.adminKeys) {
    add(`setperm ${k} 3`, `Give admin to ${k.slice(0, 8)}…`, exact("OK", said));
  }
  for (const e of board.acl) {
    if (e.perm !== 0 && !input.adminKeys.includes(e.key)) {
      add(`setperm ${e.key} 0`, `Remove ${e.key.slice(0, 8)}… from the admin list`, exact("OK", said));
    }
  }
  return cmds;
}

// What's read back after the restart, and what it should say.
export const READBACK = [
  "ver", "get public.key", "get name", "get lat", "get lon", "get radio", "get guest.password",
  "get repeat", "get path.hash.mode", "region", "region default", "region home", "get acl",
];

const near = (a, b, tol) => Math.abs(a - b) <= tol;

export function checkReadback(cfg, input, rb, expectVersion) {
  const out = [];
  const add = (label, ok, detail) => out.push({ label, ok, detail });

  const ver = rb["ver"]?.reply || "";
  if (expectVersion) {
    add(`Firmware is ${expectVersion}`, ver.startsWith(expectVersion + " "), ver ? `The board says ${ver}.` : "The board didn't say.");
  }
  const name = getValue(rb["get name"]?.reply);
  add(`Name is ${input.name}`, name === input.name, name === null ? "No answer." : `The board says ${name}.`);
  // Kept as a double, read back through a float (TxtDataHelpers.cpp ftoa): about 7 digits.
  const lat = Number(getValue(rb["get lat"]?.reply));
  const lon = Number(getValue(rb["get lon"]?.reply));
  const deg = (x) => (Number.isFinite(x) ? String(Number(x.toFixed(5))) : "nothing");
  add(`Location is ${input.lat}, ${input.lon}`, near(lat, Number(input.lat), 1e-4) && near(lon, Number(input.lon), 1e-4),
    `The board says ${deg(lat)}, ${deg(lon)}.`);
  const radio = parseRadio(rb["get radio"]?.reply);
  const r = input.radio;
  add(`Radio is ${radioText(r)}`,
    !!radio && near(radio.freq, r.freq, 0.0005) && near(radio.bw, r.bw, 0.001) && radio.sf === r.sf && radio.cr === r.cr,
    radio ? `The board says ${radioText({ ...radio, freq: Number(radio.freq.toFixed(3)) })}.` : "No answer.");
  add("Admin password is set", input.passwordConfirmed === true,
    input.passwordConfirmed ? "The board repeated it back when it was set (not shown)." : "The board didn't confirm it.");
  const guest = getValue(rb["get guest.password"]?.reply);
  add(`Guest password is ${cfg.guestPassword}`, guest === cfg.guestPassword, `The board says ${guest ?? "nothing"}.`);
  const repeat = getValue(rb["get repeat"]?.reply);
  add("Repeating is off", repeat === "off", `The board says ${repeat ?? "nothing"}.`);
  const mode = getValue(rb["get path.hash.mode"]?.reply);
  add(`Paths use ${cfg.pathHashMode + 1}-byte hashes`, mode === String(cfg.pathHashMode), `The board says mode ${mode ?? "nothing"}.`);

  const regions = parseRegions(rb["region"]?.reply);
  const byName = new Map(regions.map((x) => [x.name, x]));
  const wanted = tickedRegions(cfg, input.regions);
  const problems = [];
  for (const x of wanted) {
    const got = byName.get(x.name);
    if (!got) problems.push(`${x.name} is missing`);
    else {
      const parent = got.parent === "*" ? null : got.parent;
      if (parent !== x.parent) problems.push(`${x.name} is under ${parent ?? "the top level"}`);
      if (!got.flood) problems.push(`${x.name} doesn't allow flood`);
    }
  }
  for (const x of cfg.regions.list) {
    if (!input.regions.includes(x.name) && byName.has(x.name)) problems.push(`${x.name} is still there`);
  }
  add(`Regions are ${regionTree(cfg, input.regions)}, each allowing flood`, problems.length === 0,
    problems.length ? problems.join("; ") + "." : `The board lists ${regions.filter((x) => x.name !== "*").map((x) => x.name).join(", ")}.`);
  const def = (rb["region default"]?.reply || "").trim();
  add(`Default region is ${input.defaultRegion}`, def === `default scope is ${input.defaultRegion}`, `The board says "${def}".`);
  const home = (rb["region home"]?.reply || "").trim();
  add(`Home region is ${input.homeRegion}`, home === `home is ${input.homeRegion}`, `The board says "${home}".`);

  const acl = parseAcl(rb["get acl"]?.lines);
  const admins = acl.filter((e) => e.perm !== 0);
  const wantKeys = [...input.adminKeys].sort();
  const gotKeys = admins.map((e) => e.key).sort();
  const aclOk = admins.every((e) => (e.perm & 3) === 3) && JSON.stringify(wantKeys) === JSON.stringify(gotKeys);
  add(input.adminKeys.length ? `Admin identities: only the ${input.adminKeys.length} ticked` : "Admin identities: none",
    aclOk, gotKeys.length ? `The board lists ${gotKeys.map((k) => k.slice(0, 8) + "…").join(", ")}.` : "The board lists none.");
  return out;
}

export function regionTree(cfg, ticked) {
  const list = tickedRegions(cfg, ticked);
  const kids = (p) => list.filter((x) => x.parent === p);
  const show = (x) => {
    const c = kids(x.name);
    return c.length ? `${x.name} › ${c.length > 1 ? "(" + c.map(show).join(", ") + ")" : show(c[0])}` : x.name;
  };
  return list.filter((x) => !x.parent || !ticked.includes(x.parent)).map(show).join(", ");
}
