// node tests/test_optimiser.js
// 1. Coordinate ascent vs. brute force on a small fixture, with and without a price limit.
// 2. Smoke test on the real evaluator/data.js: every role ranks without throwing.
"use strict";
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const O = require("../evaluator/optimiser.js");

// ---------------------------------------------------------------- fixture
const part = (name, kind, price, stats, extra) => Object.assign({ id: name, ware: name, name, kind, price, stats,
  owners: ["f"], licence: null, mining: false }, extra || {});
const parts = [
  part("eng_fast", "engine", 900, {}), part("eng_cheap", "engine", 100, {}),
  part("thr", "thruster", 50, {}),
  part("sh_big", "shield", 600, { ShieldValue: 5000, ShieldRate: 50 }),
  part("sh_mid", "shield", 250, { ShieldValue: 3000, ShieldRate: 60 }),
  part("sh_small", "shield", 80, { ShieldValue: 1000, ShieldRate: 20 }),
  part("gun_a", "weapon", 400, { BurstDPS: 300, SustainedDPS: 200 }),
  part("gun_b", "weapon", 150, { BurstDPS: 150, SustainedDPS: 140 }),
  part("tur", "turret", 300, { TurretBurstDPS: 100, TurretSustainedDPS: 90 }),
];
const ship = {
  id: "s", ware: "s", owners: ["f"], licence: null, price: 1000, hull: 4000, drones: 0, missiles: 0, hangar: {},
  cargo: { container: 0 }, purpose: "fight", type: "fighter", size: "m",
  engines: { 0: { ForwardSpeed: 300, BoostSpeed: 600, TravelSpeed: 3000, ForwardAcceleration: 50, TravelChargeTime: 10, engines: 2 },
             1: { ForwardSpeed: 180, BoostSpeed: 360, TravelSpeed: 1800, ForwardAcceleration: 30, TravelChargeTime: 10, engines: 2 } },
  thrusters: { 2: { YawSpeed: 40 } },
  groups: [
    { kind: "engine", count: 2, cands: [0, 1] },
    { kind: "shield", count: 2, cands: [3, 4, 5] },
    { kind: "weapon", count: 2, cands: [6, 7] },
    { kind: "turret", count: 1, cands: [8] },
  ],
};
const data = { parts, ships: [ship] };
const ctx = { factions: new Set(["f"]), role: "combat", priceBasis: "fitted", priceMax: 0 };
const weights = { forwardDps: 4, turretDps: 2, shield: 3, shieldRegen: 1, maxSpeed: 2, price: 2 };
const scales = { forwardDps: 400, turretDps: 90, shield: 10000, shieldRegen: 120, maxSpeed: 300, price: 3000 };

function brute(limit) {
  let best = null;
  for (const e of [0, 1]) for (const sh of [null, 3, 4, 5]) for (const g of [null, 6, 7]) for (const t of [null, 8]) {
    const lo = { engine: e, thruster: 2, groups: [null, sh, g, t] };
    const m = O.evaluate(data, ship, lo, ctx);
    if (m.price > limit) continue;
    const s = O.score(m, weights, scales, false);  // the search's own objective
    if (!best || s > best.score) best = { lo, score: s, price: m.price };
  }
  return best;
}

const free = O.optimise(data, ship, ctx, weights, scales);
const freeBest = brute(Infinity);
assert.ok(Math.abs(free.score - freeBest.score) < 1e-9, "unconstrained: search " + free.score + " vs brute force " + freeBest.score);
console.log("unconstrained: search = brute force, score %s, price %d", free.score.toFixed(3), free.metrics.price);

for (const limit of [3500, 4500, 6000]) {
  const c = Object.assign({}, ctx, { priceMax: limit });
  const r = O.optimise(data, ship, c, weights, scales);
  const b = brute(limit);
  assert.ok(r.metrics.price <= limit, "over budget: " + r.metrics.price + " > " + limit);
  const gap = (b.score - r.score) / b.score;
  console.log("limit %d: search %s (price %d) vs brute force %s (price %d), gap %s%%",
    limit, r.score.toFixed(3), r.metrics.price, b.score.toFixed(3), b.price, (100 * gap).toFixed(2));
}

// ---------------------------------------------------------------- rating-profile rules
// Curves, slot rules and limits: the search against an exhaustive enumeration of the same
// (rule-filtered) candidates, scored by the same objective.
function bruteRules(c) {
  const cand = O.candidates(data, ship, c);
  const opts = { rules: O.rulesOf(c.role), size: ship.size };
  let best = null;
  for (const e of cand.engines) for (const t of cand.thrusters)
    for (const sh of cand.groups[1]) for (const g of cand.groups[2]) for (const tu of cand.groups[3]) {
      const lo = { engine: e, thruster: t, groups: [null, sh, g, tu] };
      const m = O.evaluate(data, ship, lo, c);
      const s = O.objective(m, weights, scales, opts);
      if (!best || s > best.score) best = { lo, score: s, m };
    }
  return best;
}
const RULE_CASES = [
  ["curves", { shield: { curve: "sqrt" }, forwardDps: { curve: "log" }, maxSpeed: { curve: "target", target: 250 } }, {}],
  ["slot rules", {}, { require: { turret: true }, ban: ["gun_a"] }],
  ["exclude by use", {}, { exclude: ["launcher"] }],
  ["limits", { forwardDps: { min: 350 }, shield: { min: 6000 } }, {}],
  ["max limit", { price: { max: 4000 } }, {}],
];
parts.push(part("launcher", "missilelauncher", 120, { BurstDPS: 500, SustainedDPS: 500 }, { use: "launcher" }));
ship.groups[2].cands.push(parts.length - 1);
for (const [name, metrics, slots] of RULE_CASES) {
  O.configure({ roles: { combat: { metrics, slots } } });
  const r = O.optimise(data, ship, ctx, weights, scales);
  const b = bruteRules(ctx);
  assert.ok(Math.abs(r.score - b.score) < 1e-9, name + ": search " + r.score + " vs brute force " + b.score);
  if (metrics.forwardDps && metrics.forwardDps.min) assert.ok(r.violation < 1e-9 && r.metrics.forwardDps >= 350, name + ": limit missed");
  if (slots.ban) assert.ok(!r.loadout.groups.includes(6), name + ": banned part fitted");
  if (slots.require && slots.require.turret) assert.ok(r.loadout.groups[3] != null, name + ": required turret empty");
  if (slots.exclude) assert.ok(!r.loadout.groups.includes(parts.length - 1), name + ": excluded launcher fitted");
  console.log("%s: search = brute force, score %s", name, r.score.toFixed(3));
}
// score() is the sum of explain(); with a target curve the metric never passes 100% of its share.
{
  O.configure({ roles: { combat: { metrics: { maxSpeed: { curve: "target", target: 100 } } } } });
  const m = O.evaluate(data, ship, { engine: 0, thruster: 2, groups: [null, 3, 6, 8] }, ctx);
  const opts = { rules: O.rulesOf("combat"), size: "m" };
  const ex = O.explain(m, weights, scales, opts);
  const sum = ex.reduce((a, e) => a + e.points, 0);
  assert.ok(Math.abs(sum - O.score(m, weights, scales, true, opts)) < 1e-9, "score != sum of explain");
  assert.ok(ex.find((e) => e.key === "maxSpeed").n === 1, "target curve not capped");
  console.log("explain: points sum to the score (%s)", sum.toFixed(3));
}
O.configure({});
parts.pop(); ship.groups[2].cands.pop();

// ---------------------------------------------------------------- real data smoke test
const file = path.join(__dirname, "..", "evaluator", "data.js");
if (fs.existsSync(file)) {
  const g = {};
  new Function("window", fs.readFileSync(file, "utf-8"))(g);
  const D = g.X4DATA;
  const all = new Set(Object.keys(D.factions));
  for (const [role, extra] of [["trader", { cargoType: "container" }], ["miner", { cargoType: "solid" }], ["combat", {}]]) {
    const c = Object.assign({ factions: all, role, priceBasis: "hull", priceMin: 0, priceMax: 0 }, extra);
    const list = O.shortlist(D, c);
    const t0 = Date.now();
    const { results } = O.rank(D, list, c, O.ROLES[role].weights);
    console.log("%s: %d candidates, %d ranked in %d ms; top: %s", role, list.length, results.length, Date.now() - t0,
      results.slice(0, 3).map((r) => r.ship.name + " (" + r.score.toFixed(1) + ")").join(", "));
  }
}
