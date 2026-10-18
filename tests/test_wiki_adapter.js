// node tests/test_wiki_adapter.js [--verbose]
// Builds X4DATA with evaluator/wiki.js from the recorded wiki JSON (tests/fixtures/wiki, see
// tools/record_wiki.js) plus supplement.json, and compares it with the local edition's data.js
// built from the game files. Skipped when the fixtures or the local data are missing.
"use strict";
const fs = require("fs");
const path = require("path");
const W = require("../evaluator/wiki.js");
const { FIX, fixtureFetch } = require("../tools/fixtures.js");

const LOCAL = process.env.X4EVAL_LOCAL || "G:/SteamLibrary/steamapps/common/X4 Foundations/extensions/_x4catalogue";
const SUPPLEMENT = [path.join(__dirname, "..", "supplement", "supplement.json"), path.join(LOCAL, "out", "supplement.json")].find((p) => fs.existsSync(p));
const verbose = process.argv.includes("--verbose");

if (!fs.existsSync(FIX) || !SUPPLEMENT || !fs.existsSync(path.join(LOCAL, "evaluator", "data.js"))) {
  console.log("skipped: needs tests/fixtures/wiki (node tools/record_wiki.js), a supplement.json and the local data.js");
  process.exit(0);
}

function loadLocal() {
  const g = {};
  new Function("window", fs.readFileSync(path.join(LOCAL, "evaluator", "data.js"), "utf-8"))(g);
  return g.X4DATA;
}

(async () => {
  const sup = JSON.parse(fs.readFileSync(SUPPLEMENT, "utf-8"));
  const t0 = Date.now();
  const A = await W.build({ fetchJson: fixtureFetch, supplement: sup, mods: ["dabc", "rsp"] });
  const L = loadLocal();
  console.log("adapter: %d ships, %d parts in %d ms (supplement %s)", A.ships.length, A.parts.length, Date.now() - t0, path.relative(process.cwd(), SUPPLEMENT));

  const aShip = Object.fromEntries(A.ships.map((s) => [s.id, s])), lShip = Object.fromEntries(L.ships.map((s) => [s.id, s]));
  const aPart = Object.fromEntries(A.parts.map((p) => [p.id, p])), lPart = Object.fromEntries(L.parts.map((p) => [p.id, p]));
  const diffs = {};   // category -> [lines]
  const add = (cat, line) => (diffs[cat] = diffs[cat] || []).push(line);
  const close = (a, b) => Math.abs(a - b) <= Math.max(0.002, 0.0005 * Math.abs(b));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- parts
  for (const id of Object.keys(aPart)) {
    const a = aPart[id], l = lPart[id];
    if (!l) { add("part only on the wiki side", id); continue; }
    for (const f of ["kind", "size", "ware", "price", "licence", "use", "mining", "blueprintable", "race", "mk"])
      if (!same(a[f], l[f])) add("part field " + f, `${id}: wiki ${JSON.stringify(a[f])} local ${JSON.stringify(l[f])}`);
    if (!same(a.owners, l.owners)) add("part owners", `${id}: wiki ${a.owners} local ${l.owners}`);
    if (a.name !== l.name) add("part name", `${id}: "${a.name}" vs "${l.name}"`);
    for (const s of new Set([...Object.keys(a.stats), ...Object.keys(l.stats)]))
      if (!close(a.stats[s] || 0, l.stats[s] || 0)) add("part stat " + s, `${id}: wiki ${a.stats[s]} local ${l.stats[s]} (src ${a.src}/${l.src})`);
  }
  const wikiParts = new Set(Object.keys(aPart));

  // ---- ships
  for (const id of Object.keys(aShip)) {
    const a = aShip[id], l = lShip[id];
    if (!l) { add("ship only on the wiki side", id); continue; }
    for (const f of ["name", "size", "type", "purpose", "ware", "price", "licence", "blueprintable", "hull", "crew", "drones", "missiles", "threat"])
      if (!same(a[f], l[f])) add("ship field " + f, `${id}: wiki ${JSON.stringify(a[f])} local ${JSON.stringify(l[f])}`);
    if (!same(a.owners, l.owners)) add("ship owners", `${id}: wiki ${a.owners} local ${l.owners}`);
    if (!same(a.cargo, l.cargo)) add("ship cargo", `${id}: wiki ${JSON.stringify(a.cargo)} local ${JSON.stringify(l.cargo)}`);
    const hs = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => /\bdock_[sm]\b/.test(k)));
    if (!same(hs(a.hangar), hs(l.hangar))) add("ship hangar (S/M docks)", `${id}: wiki ${JSON.stringify(a.hangar)} local ${JSON.stringify(l.hangar)}`);
    // slot groups as kind/size/count with candidate part ids; local candidates the wiki does not
    // carry at all (other installed mods) are set aside and counted separately
    const g = (D, s, keep) => s.groups.map((x) => `${x.kind}/${x.size}/${x.count}: ` +
      x.cands.map((i) => D.parts[i].id).filter(keep).sort().join(",")).sort();
    const ga = g(A, a, () => true), gl = g(L, l, (pid) => wikiParts.has(pid));
    if (!same(ga, gl)) add("ship slot groups / fits", `${id}:\n      wiki  ${ga.join("\n            ")}\n      local ${gl.join("\n            ")}`);
    const extra = l.groups.flatMap((x) => x.cands.map((i) => L.parts[i].id)).filter((pid) => !wikiParts.has(pid));
    if (extra.length) add("local fits with parts the wiki does not have", `${id}: ${[...new Set(extra)].slice(0, 6).join(", ")}${extra.length > 6 ? " …" : ""}`);
    // movement rows by part id
    const rows = (D, s, key) => Object.fromEntries(Object.entries(s[key]).map(([i, r]) => [D.parts[i].id, r]));
    for (const key of ["engines", "thrusters"]) {
      const ra = rows(A, a, key), rl = rows(L, l, key);
      for (const pid of Object.keys(ra)) {
        if (!rl[pid]) { add(`ship ${key} row only on the wiki side`, `${id} ${pid}`); continue; }
        for (const st of Object.keys(ra[pid])) {
          if (st === "src") continue;
          if (typeof ra[pid][st] === "number" && !close(ra[pid][st], rl[pid][st] || 0))
            add(`ship ${key} ${st}`, `${id} ${pid}: wiki ${ra[pid][st]} local ${rl[pid][st]} (${rl[pid].src})`);
        }
      }
      for (const pid of Object.keys(rl)) if (!ra[pid] && wikiParts.has(pid)) add(`ship ${key} row only locally`, `${id} ${pid}`);
    }
  }
  const notCovered = L.ships.filter((s) => !aShip[s.id]).length;

  console.log("\ncompared %d ships and %d parts present on both sides; %d local ships are not on the wiki (other mods)",
    A.ships.filter((s) => lShip[s.id]).length, A.parts.filter((p) => lPart[p.id]).length, notCovered);
  const cats = Object.keys(diffs).sort();
  if (!cats.length) console.log("no differences");
  for (const c of cats) {
    console.log(`\n${c}: ${diffs[c].length}`);
    for (const line of diffs[c].slice(0, verbose ? 1e9 : 4)) console.log("  " + line);
  }
  if (A.meta.notes.unknown_storage.length) console.log("\nstorage macros not in the supplement (cargo read from the name):", A.meta.notes.unknown_storage.join(", "));
  if (A.meta.notes.ships_without_ware.length) console.log("ships without a ware (left out):", A.meta.notes.ships_without_ware.join(", "));
  // smoke: the shared optimiser ranks the adapter's data for every role
  const O = require("../evaluator/optimiser.js");
  for (const [role, extra] of [["trader", { cargoType: "container" }], ["miner", { cargoType: "solid" }], ["combat", {}]]) {
    const c = Object.assign({ factions: new Set(Object.keys(A.factions)), role, priceBasis: "hull", priceMin: 0, priceMax: 0 }, extra);
    const r = O.rank(A, O.shortlist(A, c), c, O.ROLES[role].weights);
    console.log("rank %s: %d rows; top %s", role, r.results.length, r.results.slice(0, 3).map((x) => x.ship.name + " (" + x.score.toFixed(1) + ")").join(", "));
  }
})().catch((e) => { console.error(e); process.exit(1); });
