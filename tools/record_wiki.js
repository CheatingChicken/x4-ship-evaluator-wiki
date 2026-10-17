// node tools/record_wiki.js
// Records the wiki JSON the adapter reads into tests/fixtures/wiki/ (gitignored: it is the wiki's
// data, kept local for tests and never published). Polite: at most 4 requests at a time, one retry,
// a User-Agent naming the project. Mods are an allowlist; nothing else is requested.
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "tests", "fixtures", "wiki");
const API = "https://swi-api.siifr.net";
const WIKI = "https://swi.siifr.net";
const SUBMODS = ["dabc", "rsp"];              // allowlist; base SWI comes from the API
const HULLS = ["s", "m", "l", "xl", "xxl"];
const FOLDERS = ["engines", "shields", "weapons", "turrets"];
const UA = "x4-ship-evaluator-wiki/0.1 (test fixture recorder; github.com/CheatingChicken)";

let done = 0, failed = [];

async function get(url, file) {
  const target = path.join(OUT, file);
  if (fs.existsSync(target)) { done++; return JSON.parse(fs.readFileSync(target, "utf-8")); }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 404) { done++; return null; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const text = await r.text();
      const json = JSON.parse(text);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
      done++;
      return json;
    } catch (e) {
      if (attempt === 1) { failed.push(url + " (" + e.message + ")"); done++; return null; }
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
}

// Runs fn over items with at most n in flight.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = [];
  // Lists first; they decide which item files exist.
  await get(API + "/wares", "api/wares.json");
  const lists = await pool(HULLS, 4, (h) => get(`${API}/ships/${h}/list/full`, `api/ships/${h}.json`));
  HULLS.forEach((h, i) => Object.keys(lists[i] || {}).forEach((id) =>
    jobs.push([`${API}/ships/${h}/${encodeURIComponent(id)}`, `api/ships/${h}/${id}.json`])));
  for (const sm of SUBMODS) {
    const sl = await pool(HULLS, 4, (h) => get(`${WIKI}/submods/${sm}/ships/${h}.json`, `submods/${sm}/ships/${h}.json`));
    HULLS.forEach((h, i) => Object.keys(sl[i] || {}).forEach((id) =>
      jobs.push([`${WIKI}/submods/${sm}/ships/${h}/${encodeURIComponent(id)}.json`, `submods/${sm}/ships/${h}/${id}.json`])));
  }
  for (const base of [["", WIKI + "/equipment"], ...SUBMODS.map((sm) => [`submods/${sm}/`, `${WIKI}/submods/${sm}/equipment`])]) {
    const [prefix, url] = base;
    const dicts = await pool(FOLDERS, 4, (f) => get(`${url}/${f}.json`, `${prefix}equipment/${f}.json`));
    FOLDERS.forEach((f, i) => Object.keys(dicts[i] || {}).forEach((name) =>
      jobs.push([`${url}/${f}/${encodeURIComponent(name)}.json`, `${prefix}equipment/${f}/${name}.json`])));
  }
  const total = jobs.length;
  let shown = 0;
  const tick = setInterval(() => { if (done !== shown) { shown = done; process.stdout.write(`\r${done} files`); } }, 1000);
  await pool(jobs, 4, ([u, f]) => get(u, f));
  clearInterval(tick);
  console.log(`\nrecorded ${total} item files (+ lists) into ${OUT}`);
  if (failed.length) console.log(failed.length + " failed:\n  " + failed.slice(0, 20).join("\n  "));
}

main();
