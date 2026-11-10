// The additional admin identities a person adds: kept in their own browser's localStorage, for
// this site only. Not a cookie: a cookie goes to the server with every request, and these are
// never to reach it. localStorage stays in the browser until the person removes them (or clears
// the site's data).

import { KEY_RE } from "./plan.js";

const STORE = "flasher.bxmesh.net/admin-identities/v1";

export function normaliseKey(text) {
  return (text || "").trim().toLowerCase();
}

export function keyProblem(key, list) {
  if (!key) return "Paste the identity's public key.";
  if (!KEY_RE.test(key)) return "A public key is 64 characters, each 0-9 or a-f.";
  if (list.some((x) => x.key === key)) return "That key is already in the list.";
  return null;
}

export function load() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE) || "[]");
    if (!Array.isArray(raw)) return { list: [], stored: true };
    const list = [];
    for (const x of raw) {
      const key = normaliseKey(x && x.key);
      if (KEY_RE.test(key) && !list.some((y) => y.key === key)) {
        list.push({ key, label: String((x && x.label) || "").slice(0, 60) });
      }
    }
    return { list, stored: true };
  } catch {
    return { list: [], stored: false };
  }
}

export function save(list) {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(list.map(({ key, label }) => ({ key, label }))));
    return true;
  } catch {
    return false; // storage blocked: the list lasts until the page is closed
  }
}
