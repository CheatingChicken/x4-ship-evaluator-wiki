// Regression guard for the ranking: the page's default scenarios, run on the local
// evaluator/data.js (+ player.js when present), reduced to the top 20 rows per role.
//
//   node tests/baseline.js --update   write tests/fixtures/baseline.json from the current code
//   require("./baseline.js").check()  compare the current code against it (test_profile.js)
//
// The fixture is derived from YOUR game data, so it is local (gitignored), like data.js.
"use strict";
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..", "evaluator");
const FIXTURE = path.join(__dirname, "fixtures", "baseline.json");

function load(name, key) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) return null;
  const g = {};
  new Function("window", fs.readFileSync(file, "utf-8"))(g);
  return g[key];
}

// The page's defaults (app.js defaults() + ctx()), without any user changes.
function scenarios(D, PL, O) {
  const hostile = (f) => !!(PL && PL.access && PL.access[f] && !PL.access[f].dock);
  const factions = PL && PL.galaxy
    ? Object.keys(D.factions).filter((f) => PL.galaxy[f] && (PL.galaxy[f].ships.length || PL.galaxy[f].equipment) && !hostile(f))
    : Object.keys(D.factions);
  const base = { factions: new Set(factions), useSave: !!PL, player: PL, playerBuild: new Set(PL ? PL.blueprints : []),
    sizes: new Set(), types: new Set(), priceMin: 0, priceMax: 0, priceBasis: "hull", focus: null,
    sourcing: new Set(["single", "mixed"]), tripDistance: 50000, combatPurposes: O.DEFAULT_COMBAT_PURPOSES.slice() };
  return [
    ["trader", { cargoType: "container", threats: ["safe", "contested", "dangerous"] }],
    ["miner", { cargoType: "solid", threats: ["safe", "contested", "dangerous"] }],
    ["combat", { cargoType: undefined, threats: [] }],
  ].map(([role, extra]) => ({ role, ctx: Object.assign({ role }, base, extra) }));
}

function snapshot(O, weightsFor) {
  const D = load("data.js", "X4DATA"), PL = load("player.js", "X4PLAYER");
  if (!D) return null;
  const out = {};
  for (const { role, ctx } of scenarios(D, PL, O)) {
    const w = weightsFor ? weightsFor(role) : O.ROLES[role].weights;
    const r = O.rank(D, O.shortlist(D, ctx), ctx, w, {});
    out[role] = r.results.slice(0, 20).map((x) => ({
      key: x.key, score: Math.round(x.score * 1e6) / 1e6,
      loadout: [x.loadout.engine, x.loadout.thruster, x.loadout.groups].map((v) => JSON.stringify(v)).join(" ") }));
  }
  return out;
}

// [] when equal; otherwise human-readable differences. null when there is no data or fixture.
function check(O, weightsFor) {
  if (!fs.existsSync(FIXTURE)) return null;
  const now = snapshot(O, weightsFor);
  if (!now) return null;
  const want = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
  const diffs = [];
  for (const role of Object.keys(want)) {
    want[role].forEach((w, i) => {
      const g = (now[role] || [])[i];
      if (!g) diffs.push(`${role} #${i + 1}: missing (was ${w.key})`);
      else if (g.key !== w.key || Math.abs(g.score - w.score) > 1e-6 || g.loadout !== w.loadout)
        diffs.push(`${role} #${i + 1}: ${g.key} ${g.score} vs ${w.key} ${w.score}${g.loadout !== w.loadout ? " (loadout differs)" : ""}`);
    });
  }
  return diffs;
}

module.exports = { scenarios, snapshot, check, load };

if (require.main === module && process.argv.includes("--update")) {
  const O = require("../evaluator/optimiser.js");
  const snap = snapshot(O);
  if (!snap) { console.error("no evaluator/data.js: nothing to snapshot"); process.exit(1); }
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify(snap, null, 1));
  console.log("wrote %s: %s", FIXTURE, Object.entries(snap).map(([k, v]) => k + " " + v.length).join(", "));
}
