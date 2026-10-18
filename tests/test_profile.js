// node tests/test_profile.js
// Rating profiles: round trips, share codes, hostile input, and that the default profile
// reproduces the baseline ranking (tests/baseline.js; skipped without local game data).
"use strict";
const assert = require("assert");
const O = require("../evaluator/optimiser.js");
const P = require("../evaluator/profile.js");
const B = require("./baseline.js");

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  " + name); };
const throws = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

// ---------------------------------------------------------------- round trips
ok("defaults diff to an empty profile", () => {
  const d = P.diff(P.DEFAULTS);
  assert.deepStrictEqual(Object.keys(d).sort(), ["author", "format", "name", "notes", "version"]);
});

const sample = {
  format: P.FORMAT, version: 1, name: "Pirate hunter", author: "someone", notes: "guns first",
  roles: { combat: { weights: { forwardDps: 5, price: 1 },
                     metrics: { forwardDps: { curve: "sqrt", reference: "size", min: 3000 }, maxSpeed: { curve: "target", target: 400 } },
                     slots: { require: { shield: true, weapon: true }, exclude: ["repair", "utility"], ban: ["weapon_gen_s_repair_01_mk1_macro"] },
                     purposes: ["fight"] } },
  defence: { shield: 50 }, threats: { safe: { defence: 2 } }, trip: { km: 80 },
};

ok("normalise keeps a valid profile and nothing else", () => {
  const { profile, warnings } = P.normalise(sample);
  assert.deepStrictEqual(warnings, []);
  const full = P.resolve(profile);
  assert.strictEqual(full.roles.combat.weights.forwardDps, 5);
  assert.strictEqual(full.roles.combat.weights.turretDps, O.ROLES.combat.weights.turretDps);  // untouched default
  assert.strictEqual(full.roles.combat.metrics.forwardDps.reference, "size");
  assert.strictEqual(full.roles.combat.metrics.forwardDps.min, 3000);
  assert.strictEqual(full.roles.combat.metrics.forwardDps.max, null);
  assert.deepStrictEqual(full.roles.combat.purposes, ["fight"]);
  assert.strictEqual(full.trip.km, 80);
  assert.strictEqual(full.trip.turn, P.DEFAULTS.trip.turn);
});

ok("resolve -> diff -> resolve is stable", () => {
  const sparse = P.normalise(sample).profile;
  assert.deepStrictEqual(P.diff(P.resolve(sparse)), sparse);
  assert.ok(P.same(sparse, P.diff(P.resolve(sparse))));
  assert.ok(!P.same(sparse, {}));
});

ok("share code round trip", () => {
  const sparse = P.normalise(sample).profile;
  const code = P.encode(sparse);
  assert.ok(code.startsWith("X4EP1:") && /^[\w:-]+$/.test(code), "code is URL/Discord safe");
  assert.deepStrictEqual(P.normalise(code).profile, sparse);
  assert.deepStrictEqual(P.normalise("  " + code.replace(/(.{40})/g, "$1\n") + " ").profile, sparse, "line breaks from chat");
  assert.deepStrictEqual(P.normalise(JSON.stringify(sparse)).profile, sparse, "plain JSON too");
});

ok("unicode names survive the share code", () => {
  const p = P.normalise(Object.assign({}, sample, { name: "Jägerstaffel ☆ 星" })).profile;
  assert.strictEqual(P.normalise(P.encode(p)).profile.name, "Jägerstaffel ☆ 星");
});

// ---------------------------------------------------------------- hostile input
ok("rejects what is not a profile", () => {
  throws(() => P.normalise("hello"), /neither a share code nor profile JSON/);
  throws(() => P.normalise({ format: "something-else" }), /not an X4 ship evaluator profile/);
  throws(() => P.normalise("X4EP1:!!!"), /damaged share code/);
  throws(() => P.normalise(null), /not a profile/);
  throws(() => P.normalise([1, 2]), /not a profile/);
});

ok("rejects oversized input", () => {
  throws(() => P.normalise(Object.assign({}, sample, { notes: "x".repeat(1024 * 1024) })), /64 KB/);
  throws(() => P.normalise("x".repeat(1024 * 1024)), /64 KB/);
});

ok("drops unknown keys and clamps numbers", () => {
  const { profile, warnings } = P.normalise({
    format: P.FORMAT, version: 1, name: "x", evil: "drop me",
    roles: { combat: { weights: { forwardDps: 1e9, nonsense: 3, price: -5, hull: "NaN" },
                       metrics: { shield: { curve: "exp", reference: "moon", min: "abc", target: -1 } },
                       slots: { exclude: ["launcher", "everything"], ban: ["ok_id", "<script>", 42] },
                       purposes: [] },
             pirate: { weights: {} } },
    trip: { km: 1e9, turn: -40 }, threats: { safe: { defence: 1e9 }, doom: { defence: 1 } },
  });
  const full = P.resolve(profile);
  assert.strictEqual(full.roles.combat.weights.forwardDps, 5);
  assert.strictEqual(full.roles.combat.weights.price, 0);
  assert.strictEqual(full.roles.combat.weights.hull, O.ROLES.combat.weights.hull);
  assert.ok(!("nonsense" in full.roles.combat.weights));
  assert.strictEqual(full.roles.combat.metrics.shield.curve, "linear");
  assert.strictEqual(full.roles.combat.metrics.shield.reference, "list");
  assert.strictEqual(full.roles.combat.metrics.shield.target, 0);
  assert.strictEqual(full.roles.combat.metrics.shield.min, null);
  assert.deepStrictEqual(full.roles.combat.slots.exclude, ["launcher"]);
  assert.deepStrictEqual(full.roles.combat.slots.ban, ["ok_id"]);
  assert.deepStrictEqual(full.roles.combat.purposes, O.DEFAULT_COMBAT_PURPOSES, "empty purposes keep the default");
  assert.strictEqual(full.trip.km, 1000);
  assert.strictEqual(full.trip.turn, 0);
  assert.strictEqual(full.threats.safe.defence, 10);
  assert.ok(!("doom" in full.threats) && !("pirate" in full.roles) && !("evil" in profile));
  assert.ok(warnings.some((w) => /nonsense/.test(w)) && warnings.some((w) => /pirate/.test(w)));
});

ok("cannot pollute Object.prototype", () => {
  const raw = '{"format":"' + P.FORMAT + '","version":1,"name":"x",' +
    '"roles":{"__proto__":{"weights":{"price":5}},"constructor":{"weights":{}}},' +
    '"threats":{"__proto__":{"defence":7,"require":{"shield":true}}},"defence":{"__proto__":{"polluted":1}}}';
  P.normalise(raw);
  P.resolve(JSON.parse(raw));
  assert.strictEqual({}.defence, undefined);
  assert.strictEqual({}.weights, undefined);
  assert.strictEqual({}.polluted, undefined);
});

ok("text fields are capped and stripped of control characters, not interpreted", () => {
  const { profile } = P.normalise(Object.assign({}, sample, { name: "<img src=x onerror=alert(1)>\u0000" + "n".repeat(500), author: 5 }));
  assert.ok(profile.name.startsWith("<img src=x onerror=alert(1)>"), "kept verbatim: the page escapes it");
  assert.ok(!profile.name.includes("\u0000") && profile.name.length === 80);
  assert.strictEqual(profile.author, "");
});

ok("unknown banned parts are kept but reported", () => {
  const { warnings } = P.normalise(sample, new Set(["something_else"]));
  assert.ok(warnings.some((w) => /not in your game data/.test(w)));
});

ok("a newer version is read, with a warning", () => {
  const { warnings } = P.normalise(Object.assign({}, sample, { version: 2 }));
  assert.ok(warnings.some((w) => /newer version/.test(w)));
});

// ---------------------------------------------------------------- SWI maintenance
ok("maintenance: threat x empire multiplier x 5,000 Cr, scaled by the game setting", () => {
  const ship = { threat: 90 }, EL = O.EMPIRE_LEVELS;
  O.configure(P.resolve({}));
  assert.strictEqual(O.maintenanceOf(ship), 90 * EL[3].mult * 5000);              // default: Corporation, x1
  O.configure(P.resolve({ maintenance: { empire: 5 } }));
  assert.strictEqual(O.maintenanceOf(ship), 90 * 2.0 * 5000);                     // Empire, x2
  O.configure(P.resolve({ maintenance: { empire: 0 } }));
  assert.strictEqual(O.maintenanceOf(ship), 0);                                   // Privateer pays nothing
  O.configure(P.resolve({}));
  O.setMaintenanceScale(0.5);
  assert.strictEqual(O.maintenanceOf(ship), 90 * 5000 * 0.5);                     // a mod halving it
  O.setMaintenanceScale(1);
  assert.strictEqual(O.maintenanceOf({}), 0);                                     // no threatscore, no cost
  O.configure({});
});

ok("maintenance: the empire size is kept sparse and clamped", () => {
  assert.strictEqual(P.diff(P.resolve({})).maintenance, undefined);
  const { profile } = P.normalise(Object.assign({}, sample, { maintenance: { empire: 99 } }));
  assert.deepStrictEqual(profile.maintenance, { empire: O.EMPIRE_LEVELS.length - 1 });
  assert.strictEqual(P.resolve(P.normalise(Object.assign({}, sample, { maintenance: { empire: "x" } })).profile).maintenance.empire, 3);
});

// ---------------------------------------------------------------- engine with the default profile
ok("configure(default profile) reproduces the baseline ranking", () => {
  const full = P.resolve({});
  O.configure(full);
  const diffs = B.check(O, (role) => full.roles[role].weights);
  O.configure({});
  if (diffs === null) { console.log("    (skipped: no local data.js or baseline fixture)"); return; }
  assert.deepStrictEqual(diffs, []);
});

console.log("%d passed", n);
