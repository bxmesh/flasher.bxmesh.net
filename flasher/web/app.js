// The page: the form, the board, and the run (flash, set up, restart, check), in plain words.
// Nothing typed here is sent to the server: the page only reads /api/config and the firmware.

import * as plan from "./plan.js";
import { SerialLink, LinkTimeout, LinkClosed, sleep } from "./serial-link.js";
import { RepeaterCli } from "./repeater-cli.js";
import { SerialDfu, DfuError, activateWaitMs } from "./dfu.js";
import * as adminStore from "./admins.js";

const $ = (id) => document.getElementById(id);
const serial = "serial" in navigator ? navigator.serial : null;

const state = {
  cfg: null,
  releases: [],
  releasesError: null,
  port: null,
  boardFound: false,
  busy: false,
  admins: [],
  adminTicked: new Set(),
  adminStored: true,
  ticked: [],
  touched: new Set(),
};

class StepError extends Error {}

// --- Small helpers ----------------------------------------------------------------------------

function log(line) {
  const pre = $("log-text");
  pre.textContent += line + "\n";
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) e.append(k);
  return e;
}

function secs(n) {
  if (n < 60) return `${n} s`;
  return `${Math.floor(n / 60)} min ${n % 60} s`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "omit", cache: "no-store" });
  } catch {
    throw new StepError("The server couldn't be reached. Check the connection and try again.");
  }
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) throw new StepError(body && body.error ? body.error : "The server couldn't answer just now. Try again in a minute.");
  return body;
}

function b64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function explain(e) {
  if (e instanceof StepError || e instanceof DfuError) {
    const m = e.message;
    return m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? "" : ".");
  }
  if (e instanceof LinkTimeout) return "The board stopped answering. Unplug it, plug it back in, choose it again and retry.";
  if (e instanceof LinkClosed) return "The board disconnected. Plug it back in, choose it again and retry.";
  if (e && e.name === "NetworkError") return "The browser couldn't open the board. Another program or tab (a serial monitor, the MeshCore app) may be using it: close it and retry.";
  if (e && e.name === "InvalidStateError") return "The board was still busy. Unplug it, plug it back in and retry.";
  if (e && e.name === "NotFoundError") return "No board was chosen.";
  return "Something unexpected went wrong. Unplug the board, plug it back in and retry.";
}

// --- The progress list ------------------------------------------------------------------------

const STEP_TITLES = [
  "Download the firmware",
  "Restart the board into its bootloader",
  "Write the firmware",
  "Connect to the repeater",
  "Set it up",
  "Save and restart the board",
  "Check the settings",
];

class Step {
  constructor(li) {
    this.li = li;
    this.detailEl = li.querySelector(".detail");
    this.bar = li.querySelector(".bar > span");
    this.timer = null;
  }
  set(cls, text) {
    this.stopCountdown();
    this.li.className = cls;
    if (text !== undefined) this.detailEl.textContent = text;
  }
  start(text) { this.set("running", text); }
  done(text) { this.set("done", text); }
  fail(text) { this.set("failed", text); }
  skip(text) { this.set("skipped", text); }
  detail(text) { this.detailEl.textContent = text; }
  progress(frac) { if (this.bar) this.bar.style.width = `${Math.round(frac * 100)}%`; }
  stopCountdown() {
    clearInterval(this.timer);
    this.timer = null;
  }
  // Shows fmt(seconds left) until stopped, counting down to 0 from now + ms.
  countdown(ms, fmt) {
    this.stopCountdown();
    const until = Date.now() + ms;
    const tick = () => this.detail(fmt(Math.max(0, Math.ceil((until - Date.now()) / 1000))));
    tick();
    this.timer = setInterval(tick, 250);
  }
}

function renderSteps() {
  const ol = $("steps");
  ol.textContent = "";
  const steps = STEP_TITLES.map((title, i) => {
    const li = el("li", { class: "waiting" }, el("span", { class: "mark", "aria-hidden": "true" }), el("span", { class: "title", text: title }), el("span", { class: "detail" }));
    if (i === 2) li.append(el("div", { class: "bar" }, el("span")));
    ol.append(li);
    return new Step(li);
  });
  return steps;
}

let steps = renderSteps();
let current = null;

function message(text, cls = "") {
  const m = $("message");
  m.textContent = text;
  m.className = "message " + cls;
}

// --- Ports ------------------------------------------------------------------------------------

function vendorOf(port) {
  try {
    return port.getInfo().usbVendorId;
  } catch {
    return undefined;
  }
}

async function boardPorts() {
  const vid = state.cfg.board.usbVendorId;
  return (await serial.getPorts()).filter((p) => vendorOf(p) === undefined || vendorOf(p) === vid);
}

async function present(port) {
  return (await serial.getPorts()).includes(port);
}

async function waitUntil(test, ms, step, fmt) {
  const until = Date.now() + ms;
  if (step && fmt) step.countdown(ms, fmt);
  try {
    while (Date.now() < until) {
      const r = await test();
      if (r) return r;
      await sleep(200);
    }
    return null;
  } finally {
    step?.stopCountdown();
  }
}

async function onlyOne() {
  const ps = await boardPorts();
  return ps.length === 1 ? ps[0] : null;
}

// The browser lets a page pick a port only from a click, so when it can't find the board by
// itself the person is asked to choose it again.
function askForPort(step, why) {
  step.detail(why);
  return new Promise((resolve, reject) => {
    const action = $("action");
    action.textContent = "";
    const choose = el("button", { type: "button", id: "choose-again", text: "Choose the board again" });
    const stop = el("button", { type: "button", class: "secondary", text: "Stop" });
    const finish = () => (action.textContent = "");
    choose.addEventListener("click", async () => {
      try {
        const port = await serial.requestPort({ filters: [{ usbVendorId: state.cfg.board.usbVendorId }] });
        finish();
        resolve(port);
      } catch {
        step.detail(why + " (Nothing was chosen.)");
      }
    });
    stop.addEventListener("click", () => {
      finish();
      reject(new StepError("Stopped"));
    });
    action.append(choose, stop);
  });
}

async function openCli(port, ms, step, fmt) {
  const link = await new SerialLink(port).open(115200);
  const cli = new RepeaterCli(link);
  if (step) step.countdown(ms, fmt);
  try {
    const version = await cli.sync(ms);
    return { link, cli, version };
  } catch (e) {
    await link.close();
    if (e instanceof LinkTimeout) throw new StepError("The repeater firmware didn't answer");
    throw e;
  } finally {
    step?.stopCountdown();
  }
}

// --- Choosing the board -----------------------------------------------------------------------

function showBoard(name, version) {
  state.boardFound = true;
  state.boardText = `${name}, MeshCore ${version.split(" ")[0]}`;
  const status = $("board-status");
  status.textContent = `Found a repeater called ${name}, running MeshCore ${version.split(" ")[0]}.`;
  status.className = "status ok";
}

async function chooseBoard() {
  const status = $("board-status");
  let port;
  try {
    port = await serial.requestPort({ filters: [{ usbVendorId: state.cfg.board.usbVendorId }] });
  } catch {
    if (!state.port) {
      status.textContent = "No board chosen. If it isn't in the list, try another USB cable (some only charge).";
      status.className = "status bad";
    }
    return;
  }
  state.port = port;
  state.boardFound = false;
  state.boardText = "";
  status.textContent = "Talking to the board…";
  status.className = "status";
  setBusy(true);
  let link = null;
  try {
    const c = await openCli(port, 4000);
    link = c.link;
    const name = plan.getValue((await c.cli.run("get name")).reply);
    showBoard(name, c.version);
  } catch (e) {
    if (e instanceof StepError) {
      status.textContent = "Board chosen. It didn't answer as a MeshCore repeater: it may be new, or already waiting for firmware. Flashing will still work.";
      status.className = "status";
    } else {
      status.textContent = explain(e);
      status.className = "status bad";
    }
  } finally {
    await link?.close();
    setBusy(false);
  }
}

// --- The run ----------------------------------------------------------------------------------

async function enterBootloader(port, step) {
  step.start("Asking the board to restart into its bootloader…");
  // The 1200-baud "touch": the Adafruit nRF52 core restarts into the serial bootloader when a
  // port opened at 1200 baud is closed (adafruit-nrfutil's touch; MeshCore boards/
  // promicro_nrf52840.json upload.use_1200bps_touch).
  await port.open({ baudRate: 1200 });
  await sleep(100);
  await port.close();
  const gone = await waitUntil(async () => !(await present(port)), 6000, step, (s) => `Waiting for the board to restart… ${s} s`);
  if (!gone) {
    step.done("The board didn't restart, so it's probably already waiting for firmware. Carrying on with it.");
    return port;
  }
  let boot = await waitUntil(onlyOne, 12000, step, (s) => `Waiting for the bootloader to appear… ${s} s`);
  if (!boot) {
    boot = await askForPort(step, "Your browser needs you to choose the board again, now that it's waiting for firmware. It may show a different name.");
  }
  step.done("The board is waiting for firmware.");
  return boot;
}

async function writeFirmware(port, pkg, step) {
  step.start("Opening the bootloader…");
  step.progress(0);
  const link = await new SerialLink(port).open(115200);
  try {
    step.detail("Erasing the old firmware… (a few seconds)");
    await new SerialDfu(link).flash(pkg.init, pkg.image, (p) => {
      step.progress(p.sent / p.total);
      step.detail(`Writing… ${Math.floor((p.sent / p.total) * 100)}% · about ${secs(p.secondsLeft)} left`);
    });
    step.progress(1);
    step.done(`Written: ${Math.round(pkg.image.length / 1024)} kB.`);
  } finally {
    await link.close();
  }
}

async function waitForRepeater(oldPort, step, maxGoneMs, label) {
  if (oldPort) {
    const gone = await waitUntil(async () => !(await present(oldPort)), maxGoneMs, step, (s) => `${label}… up to ${secs(s)}`);
    if (!gone) throw new StepError("The board didn't restart. Unplug it, plug it back in and use Set up only");
  }
  let port = await waitUntil(onlyOne, 45000, step, (s) => `Waiting for the board to come back… up to ${secs(s)}`);
  if (!port) port = await askForPort(step, "Your browser needs you to choose the board again now that it has restarted.");
  return port;
}

async function configure(cli, input, step) {
  step.start("Reading the board's regions and admin list…");
  const regions = await cli.run("region");
  const acl = await cli.run("get acl");
  log("→ region");
  log("← " + (regions.reply ?? "").replace(/\n/g, "\n  "));
  log("→ get acl");
  log("← " + acl.lines.join("\n  "));
  const board = { regions: plan.parseRegions(regions.reply), acl: plan.parseAcl(acl.lines) };
  const cmds = plan.buildCommands(state.cfg, input, board);
  let confirmed = false;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    step.detail(`${i + 1} of ${cmds.length}: ${c.label}`);
    const res = await cli.run(c.cmd);
    if (c.secret) {
      log(`→ ${c.shown}`);
      log(res.reply && res.reply.startsWith("password now: ") ? "← password now: ••••••••" : "← (answer hidden)");
    } else {
      log(`→ ${c.cmd}`);
      log(`← ${res.reply ?? "(no answer)"}`);
    }
    const problem = c.expect(res.reply);
    if (problem) throw new StepError(`${c.label}: ${problem}`);
    if (c.secret) confirmed = true;
  }
  step.done(`${plural(cmds.length, "setting", "settings")} sent, each confirmed by the board.`);
  return confirmed;
}

async function saveAndRestart(c, step) {
  step.start();
  // setperm saves the admin list 5 seconds after the last change (MyMesh.cpp,
  // LAZY_CONTACTS_WRITE_DELAY): wait before restarting, or the change is lost.
  step.countdown(plan.ACL_SAVE_WAIT_S * 1000, (s) => `Letting the board save its admin list… ${s} s`);
  await sleep(plan.ACL_SAVE_WAIT_S * 1000);
  step.stopCountdown();
  step.detail("Restarting the board, so the radio settings take effect…");
  const port = state.port;
  await c.cli.reboot();
  const next = await waitForRepeater(port, step, 10000, "Restarting");
  await c.link.close();
  state.port = next;
  const again = await openCli(next, 20000, step, (s) => `Waiting for the repeater to start… up to ${secs(s)}`);
  step.done("The board restarted with its new settings.");
  return again;
}

async function readBack(cli, step) {
  step.start("Reading the settings back…");
  const rb = {};
  for (const cmd of plan.READBACK) {
    rb[cmd] = await cli.run(cmd);
    log(`→ ${cmd}`);
    log(`← ${rb[cmd].reply ?? rb[cmd].lines.join("\n  ")}`);
  }
  return rb;
}

function renderChecks(checks) {
  const ul = $("checks");
  ul.textContent = "";
  for (const c of checks) {
    ul.append(el("li", { class: c.ok ? "pass" : "fail" }, c.label, el("span", { class: "d", text: c.detail })));
  }
}

async function run(mode) {
  if (state.busy) return;
  const { input, problem } = readForm(true);
  if (problem) {
    update();
    return;
  }
  setBusy(true);
  $("log-text").textContent = "";
  $("checks").textContent = "";
  $("checks").append(el("li", { class: "idle", text: "Checking happens at the end." }));
  $("pubkey").textContent = "";
  steps = renderSteps();
  message("Working… keep the board plugged in and this page open.");
  let c = null;
  try {
    let expectVersion = null;
    if (mode === "flash") {
      const rel = state.releases.find((r) => r.tag === $("fw").value);
      expectVersion = rel.version;
      current = steps[0];
      current.start(`Getting MeshCore ${rel.version} from the server…`);
      const pkg = await getJson(`/api/firmware/${encodeURIComponent(rel.tag)}`);
      const fw = { init: b64(pkg.init), image: b64(pkg.image) };
      current.done(`MeshCore ${pkg.version}, ${Math.round(fw.image.length / 1024)} kB, matches the digest GitHub publishes.`);
      current = steps[1];
      const boot = await enterBootloader(state.port, current);
      current = steps[2];
      await writeFirmware(boot, fw, current);
      current = steps[3];
      current.start();
      const port = await waitForRepeater(boot, current, activateWaitMs(fw.image.length) + 15000, "The board is checking and starting the new firmware");
      state.port = port;
      c = await openCli(port, 20000, current, (s) => `Waiting for the repeater to start… up to ${secs(s)}`);
      current.done(`The board runs MeshCore ${c.version.split(" ")[0]}.`);
    } else {
      for (const s of steps.slice(0, 3)) s.skip("Not flashing this time.");
      current = steps[3];
      current.start("Talking to the repeater…");
      c = await openCli(state.port, 8000);
      current.done(`The board runs MeshCore ${c.version.split(" ")[0]}.`);
    }
    current = steps[4];
    const confirmed = await configure(c.cli, input, current);
    current = steps[5];
    c = await saveAndRestart(c, current);
    current = steps[6];
    const rb = await readBack(c.cli, current);
    const checks = plan.checkReadback(state.cfg, { ...input, passwordConfirmed: confirmed }, rb, expectVersion);
    renderChecks(checks);
    showBoard(plan.getValue(rb["get name"]?.reply) ?? input.name, rb["ver"]?.reply || c.version);
    const key = plan.getValue(rb["get public.key"]?.reply);
    if (key) $("pubkey").textContent = `This repeater's public key: ${key}`;
    const failed = checks.filter((x) => !x.ok).length;
    if (failed) {
      current.fail(`${plural(failed, "setting doesn't", "settings don't")} match. See the result below.`);
      message("The board was set up, but not everything reads back as expected. See the result below.", "bad");
    } else {
      current.done(`All ${checks.length} checks pass.`);
      message("Done: the repeater is set up. Repeating is off; turn it on in the field with “set repeat on” from the app's remote admin.", "ok");
    }
  } catch (e) {
    current?.fail(explain(e));
    message(e instanceof StepError && e.message === "Stopped" ? "Stopped." : `Stopped: ${explain(e)}`, "bad");
  } finally {
    $("action").textContent = "";
    $("pw1").value = "";
    $("pw2").value = "";
    state.touched.delete("pw1");
    state.touched.delete("pw2");
    await c?.link.close();
    current = null;
    setBusy(false);
  }
}

// --- The form ---------------------------------------------------------------------------------

function radioFromFields() {
  return {
    freq: Number($("freq").value),
    bw: Number($("bw").value),
    sf: parseInt($("sf").value, 10),
    cr: parseInt($("cr").value, 10),
  };
}

function presetMatch(r) {
  return state.cfg.radioPresets.findIndex((p) => p.freq === r.freq && p.bw === r.bw && p.sf === r.sf && p.cr === r.cr);
}

function setRadioFields(p) {
  $("freq").value = p.freq;
  $("bw").value = p.bw;
  $("sf").value = String(p.sf);
  $("cr").value = String(p.cr);
}

// Reads and checks the form. Errors show under a field once it's been touched (or on Start).
function readForm(all = false) {
  const show = (id) => all || state.touched.has(id);
  const input = {
    name: $("name").value,
    lat: $("lat").value.trim(),
    lon: $("lon").value.trim(),
    radio: radioFromFields(),
    regions: [...state.ticked],
    defaultRegion: $("def-region").value,
    homeRegion: $("home-region").value,
    adminKeys: state.admins.filter((a) => state.adminTicked.has(a.key)).map((a) => a.key),
    adminPassword: $("pw1").value,
  };
  const problems = [
    ["name", "name-err", "Step 3", plan.nameProblem(input.name)],
    ["lat", "lat-err", "Step 3", plan.coordProblem(input.lat, 90, "latitude")],
    ["lon", "lon-err", "Step 3", plan.coordProblem(input.lon, 180, "longitude")],
    ["radio", "radio-err", "Step 4", plan.radioProblem(input.radio)],
    ["regions", "regions-err", "Step 5", plan.regionsProblem(state.cfg, input.regions, input.defaultRegion, input.homeRegion)],
    ["pw1", "pw-err", "Step 7", plan.passwordProblem(input.adminPassword, $("pw2").value)],
  ];
  let first = null;
  for (const [id, errId, where, p] of problems) {
    const visible = p && (show(id) || id === "radio" || id === "regions" || (id === "pw1" && show("pw2")));
    $(errId).textContent = visible ? p : "";
    const field = $(id);
    if (field && field.tagName === "INPUT") field.setAttribute("aria-invalid", visible ? "true" : "false");
    if (p && !first) first = `${where}: ${p}`;
  }
  return { input, problem: first };
}

function summaryRows(input) {
  const rel = state.releases.find((r) => r.tag === $("fw").value);
  const ticked = input.adminKeys.length;
  return [
    ["Board", state.port ? (state.boardFound ? state.boardText : "Chosen; not running repeater firmware yet") : "Not chosen yet"],
    ["Firmware", rel ? `MeshCore ${rel.version}${rel.latest ? " (latest)" : ""}` : "—"],
    ["Name", input.name || "—"],
    ["Location", input.lat && input.lon ? `${input.lat}, ${input.lon}` : "—"],
    ["Radio", plan.radioProblem(input.radio) ? "—" : `${$("preset").selectedOptions[0]?.textContent.split(":")[0] ?? ""}: ${plan.radioText(input.radio)}`],
    ["Regions", input.regions.length ? plan.regionTree(state.cfg, input.regions) : "—"],
    ["Default and home", `${input.defaultRegion || "—"}, ${input.homeRegion || "—"}`],
    ["Admin identities", ticked ? plural(ticked, "identity", "identities") + "; any others removed" : "None; any on the board removed"],
    ["Admin password", input.adminPassword ? "Set (hidden)" : "—"],
    ["Guest password", state.cfg.guestPassword],
    ["Repeating", "Off"],
    ["Paths", `${state.cfg.pathHashMode + 1}-byte hashes`],
  ];
}

function update() {
  if (!state.cfg) return;
  const { input, problem } = readForm();
  const dl = $("summary");
  dl.textContent = "";
  for (const [k, v] of summaryRows(input)) dl.append(el("dt", { text: k }), el("dd", { text: v }));

  let flashWhy = null;
  let configWhy = null;
  if (!serial) flashWhy = configWhy = "This browser can't reach the board (see the note at the top).";
  else if (state.busy) flashWhy = configWhy = "Working…";
  else if (!state.port) flashWhy = configWhy = "Step 1: choose the board first.";
  else if (problem) flashWhy = configWhy = problem;
  if (!flashWhy && !state.releases.length) flashWhy = "The firmware list hasn't loaded, so only Set up only is possible.";
  if (!configWhy && !state.boardFound) configWhy = "Set up only needs a board already running repeater firmware.";
  $("go-flash").disabled = !!flashWhy;
  $("go-config").disabled = !!configWhy;
  $("go-why").textContent = flashWhy || configWhy || "";
}

function setBusy(busy) {
  state.busy = busy;
  for (const e of document.querySelectorAll("main section:not(#s-progress) :is(input, select, button)")) {
    e.disabled = busy;
  }
  if (!busy) $("fw").disabled = !state.releases.length;
  if (!serial) $("connect").disabled = true;
  update();
}

// --- Sections ---------------------------------------------------------------------------------

function renderFirmware() {
  const sel = $("fw");
  sel.textContent = "";
  const note = $("fw-note");
  if (!state.releases.length) {
    sel.append(el("option", { text: "Not available" }));
    sel.disabled = true;
    note.textContent = state.releasesError || "";
    return;
  }
  for (const r of state.releases) {
    const date = r.published ? new Date(r.published).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
    sel.append(el("option", { value: r.tag, text: `MeshCore ${r.version}${r.latest ? " (latest)" : ""}${date ? ", " + date : ""}` }));
  }
  sel.disabled = state.busy;
  note.textContent = state.stale
    ? "GitHub couldn't be reached just now, so this list may be a little out of date."
    : "The repeater build for the ProMicro, from MeshCore's releases. Older versions may not know every setting this page sends.";
}

function renderRegions() {
  const box = $("regions");
  box.textContent = "";
  const list = state.cfg.regions.list;
  for (const r of list) {
    const cb = el("input", { type: "checkbox", id: `region-${r.name}`, value: r.name });
    cb.checked = state.ticked.includes(r.name);
    cb.addEventListener("change", () => {
      const set = new Set(state.ticked);
      if (cb.checked) {
        for (let x = r; x; x = list.find((y) => y.name === x.parent)) set.add(x.name);
      } else {
        const drop = (name) => {
          set.delete(name);
          for (const k of list.filter((y) => y.parent === name)) drop(k.name);
        };
        drop(r.name);
      }
      state.ticked = list.filter((x) => set.has(x.name)).map((x) => x.name);
      renderRegions();
      update();
    });
    box.append(el("label", { for: `region-${r.name}`, title: r.label }, cb, `${r.name} `, el("span", { class: "hint", text: `(${r.label})` })));
  }
  for (const [id, want] of [["def-region", state.cfg.regions.default], ["home-region", state.cfg.regions.home]]) {
    const sel = $(id);
    const keep = sel.value || want;
    sel.textContent = "";
    for (const name of state.ticked) sel.append(el("option", { value: name, text: name }));
    sel.value = state.ticked.includes(keep) ? keep : state.ticked.includes(want) ? want : state.ticked[state.ticked.length - 1] || "";
  }
}

function renderAdmins() {
  const ul = $("admins");
  ul.textContent = "";
  if (!state.admins.length) {
    ul.append(el("li", { class: "none", text: "None added yet." }));
  }
  for (const a of state.admins) {
    const cb = el("input", { type: "checkbox", "aria-label": `Give admin to ${a.label || a.key}` });
    cb.checked = state.adminTicked.has(a.key);
    cb.addEventListener("change", () => {
      if (cb.checked) state.adminTicked.add(a.key);
      else state.adminTicked.delete(a.key);
      update();
    });
    const remove = el("button", { type: "button", class: "secondary", text: "Remove" });
    remove.addEventListener("click", () => {
      state.admins = state.admins.filter((x) => x.key !== a.key);
      state.adminTicked.delete(a.key);
      state.adminStored = adminStore.save(state.admins);
      renderAdmins();
      update();
    });
    ul.append(el("li", {}, cb, el("div", { class: "who" }, el("div", { text: a.label || "Unlabelled" }), el("div", { class: "key", text: a.key })), remove));
  }
  $("admin-storage").textContent = state.adminStored
    ? "Saved in this browser (its local storage, not a cookie, so it's never sent to the server)."
    : "This browser isn't keeping them (its storage is blocked here): they'll last until this page is closed.";
}

function addAdmin() {
  const key = adminStore.normaliseKey($("admin-key").value);
  const problem = adminStore.keyProblem(key, state.admins);
  $("admin-err").textContent = problem || "";
  if (problem) return;
  state.admins.push({ key, label: $("admin-label").value.trim().slice(0, 60) });
  state.adminTicked.add(key);
  state.adminStored = adminStore.save(state.admins);
  $("admin-key").value = "";
  $("admin-label").value = "";
  renderAdmins();
  update();
}

function renderRadio() {
  const sel = $("preset");
  sel.textContent = "";
  state.cfg.radioPresets.forEach((p, i) => sel.append(el("option", { value: String(i), text: `${p.label}: ${plan.radioText(p)}` })));
  sel.append(el("option", { value: "custom", text: "Custom" }));
  sel.value = "0";
  setRadioFields(state.cfg.radioPresets[0]);
  sel.addEventListener("change", () => {
    if (sel.value !== "custom") setRadioFields(state.cfg.radioPresets[Number(sel.value)]);
    update();
  });
  for (const id of ["freq", "bw", "sf", "cr"]) {
    $(id).addEventListener("input", () => {
      const i = presetMatch(radioFromFields());
      sel.value = i >= 0 ? String(i) : "custom";
      update();
    });
  }
}

// --- Start ------------------------------------------------------------------------------------

async function init() {
  if (!serial) {
    const b = $("unsupported");
    b.hidden = false;
    b.textContent = window.isSecureContext
      ? "This browser can't talk to USB serial devices, so it can't reach the board. Use Chrome or Edge on a computer (not a phone or tablet)."
      : "This page has to be opened over HTTPS (or from localhost) before the browser will let it talk to the board.";
  }
  try {
    state.cfg = await getJson("/api/config");
  } catch (e) {
    message(`The page couldn't load its settings: ${explain(e)}`, "bad");
    return;
  }
  state.ticked = state.cfg.regions.list.filter((r) => r.ticked).map((r) => r.name);
  $("guest-pw").textContent = state.cfg.guestPassword;
  const stored = adminStore.load();
  state.admins = stored.list;
  state.adminStored = stored.stored;
  state.adminTicked = new Set(state.admins.map((a) => a.key));
  renderRegions();
  renderAdmins();
  renderRadio();

  for (const id of ["name", "lat", "lon", "pw1", "pw2", "def-region", "home-region", "fw"]) {
    $(id).addEventListener("input", update);
    $(id).addEventListener("change", update);
    $(id).addEventListener("blur", () => {
      state.touched.add(id);
      update();
    });
  }
  $("admin-add").addEventListener("click", addAdmin);
  $("admin-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addAdmin();
  });
  $("connect").addEventListener("click", chooseBoard);
  $("go-flash").addEventListener("click", () => run("flash"));
  $("go-config").addEventListener("click", () => run("config"));
  if (serial) {
    serial.addEventListener("disconnect", (e) => {
      if (!state.busy && e.target === state.port) {
        state.port = null;
        state.boardFound = false;
        $("board-status").textContent = "The board was unplugged. Plug it back in and choose it again.";
        $("board-status").className = "status bad";
        update();
      }
    });
  } else {
    $("connect").disabled = true;
  }
  update();

  try {
    const fw = await getJson("/api/firmware");
    state.releases = fw.releases;
    state.stale = fw.stale;
  } catch (e) {
    state.releasesError = `The firmware list couldn't be loaded: ${explain(e)} Set up only still works.`;
  }
  renderFirmware();
  update();
}

init();
