// node tests/test_ship_page.js
// The ship pages (evaluator/ship.js) on the recorded wiki copy: routing, every ship's address
// leading back to that ship, every ship rendering with every section, the section switches, the
// ships list and the loadouts. Skipped without tests/fixtures/wiki.
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const W = require("../evaluator/wiki.js");
const S = require("../evaluator/site_loader.js");
const P = require("../evaluator/ship.js");
const { FIX, fixtureFetch } = require("../tools/fixtures.js");
global.window = global.window || {};                     // optimiser.js registers itself on window
const O = require("../evaluator/optimiser.js");

if (!fs.existsSync(FIX)) { console.log("skipped: needs tests/fixtures/wiki (node tools/record_wiki.js)"); process.exit(0); }
const supplement = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "supplement", "supplement.json"), "utf-8"));
let n = 0;
const ok = (msg) => { n++; console.log("ok  " + msg); };

// ---- routing (no data needed)
assert.deepStrictEqual(P.route("ships/s/ewing"), { kind: "ship", mod: "swi", hull: "s", key: "ewing" });
assert.deepStrictEqual(P.route("/submods/dabc/ships/xxl/dabc_eclipse/"), { kind: "ship", mod: "dabc", hull: "xxl", key: "dabc_eclipse" });
assert.deepStrictEqual(P.route("en/ships/s/ewing"), { kind: "ship", mod: "swi", hull: "s", key: "ewing" });
assert.deepStrictEqual(P.route("ships"), { kind: "index", mod: "swi", list: "hub" });
assert.deepStrictEqual(P.route("/en/ships/"), { kind: "index", mod: "swi", list: "hub" });
assert.deepStrictEqual(P.route("ships/full-list"), { kind: "index", mod: "swi", list: "full" });
assert.deepStrictEqual(P.route("submods/rsp/ships/m"), { kind: "index", mod: "rsp", list: "hull", hull: "m" });
assert.deepStrictEqual(P.route("ships/imp"), { kind: "index", mod: "swi", list: "faction", code: "imp" });
for (const bad of ["", "equipment/engines", "ships/q/ewing", "ships/s/ewing/extra", "submods", "submods/dabc", "ships/a.b"])
  assert.strictEqual(P.route(bad).kind, "none", bad);
ok("routes");

(async () => {
  const { manifest, chunks, details } = S.split(await W.build({ fetchJson: fixtureFetch, supplement, mods: Object.keys(W.MODS), origins: true, details: true }), W.MODS);
  assert.ok(!manifest.mods.some((m) => /heroes/i.test(m.id)), "only allowlisted mods");
  const all = ["swi"].concat(Object.keys(W.MODS));
  const D = S.merge(manifest, all.map((id) => chunks[id]));
  const det = S.mergeDetails(all.map((id) => JSON.parse(JSON.stringify(details[id]))));
  const mods = Object.fromEntries(manifest.mods.map((m) => [m.id, m.label]));
  const c = { D, det, cfg: P.CONFIG, mods, enabled: Object.keys(W.MODS), labels: manifest.labels };

  // every ship: its address finds it again, and its page renders every section it should
  for (const s of D.ships) {
    const r = P.route(P.shipPath(s, det));
    assert.strictEqual(P.findShip(D, det, r), s, "address of " + s.id);
    const html = P.renderShip(c, s);
    for (const sec of ["slots", "engines", "thrusters", "shields", "weapons", "turrets"]) assert.ok(html.includes(`id="sec-${sec}"`), `${s.id}: ${sec}`);
  }
  ok(`${D.ships.length} ships: address round trip and full render`);

  // the E-wing against what its wiki page shows (2026-10-17)
  const ewing = P.findShip(D, det, P.route("ships/s/ewing"));
  const page = P.renderShip(c, ewing);
  for (const want of ["E-wing E-07", "201,852 cr", "252,315 cr", "328,009 cr", "Durasteel Plates", "FreiTek", "Military ship", "?ship=ewing_macro"])
    assert.ok(page.includes(want), "E-wing page shows " + want);
  ok("E-wing page content");

  // section switches
  const off = Object.fromEntries(Object.keys(P.CONFIG.sections).map((k) => [k, false]));
  const bare = P.renderShip(Object.assign({}, c, { cfg: Object.assign({}, P.CONFIG, { sections: off }) }), ewing);
  assert.ok(!/id="sec-|class="infobox"|Open in the evaluator|on the wiki/.test(bare), "all sections off");
  ok("every section can be switched off");

  // submod parts are marked with their mod; thrusters are not
  const eclipse = P.findShip(D, det, P.route("submods/dabc/ships/xxl/dabc_eclipse"));
  assert.ok(P.renderShip(c, eclipse).includes('class="modchip" title="Dreadnaughts'), "DABC chip");
  ok("mod chips");

  // list pages
  const rows = (page) => (page.html.match(/<tr>/g) || []).length - (page.html.match(/<thead>/g) || []).length;
  assert.strictEqual(rows(P.renderIndex(c, P.route("submods/rsp/ships/full-list"))), D.ships.filter((s) => s.origin === "rsp").length, "RSP full list");
  assert.strictEqual(rows(P.renderIndex(c, P.route("ships/full-list"))), D.ships.length, "full list: every loaded ship");
  assert.ok(P.renderIndex(c, P.route("ships/xl")).html.includes("Imperial Star Destroyer II"), "XL list");
  const hub = P.renderIndex(c, P.route("ships")).html;
  for (const want of ["Vessel Catalogue", "./ships/full-list", "./ships/xxl", "./ships/imp", "./submods/dabc/ships"]) assert.ok(hub.includes(want), "hub links " + want);
  assert.strictEqual(P.renderIndex(c, P.route("ships/nosuchfaction")), null, "unknown faction");
  // Faction lists match the wiki's own (swi-api /ships/<hull>/list/filter/<code>, recorded
  // 2026-10-17): the ships the faction sells, base SWI only.
  const swiOnly = Object.assign({}, c, { D: S.merge(manifest, [chunks.swi]) });
  const wikiImp = 41, wikiHap = 17;
  assert.strictEqual(rows(P.renderIndex(swiOnly, P.route("ships/imp"))), wikiImp, "Galactic Empire list");
  assert.strictEqual(rows(P.renderIndex(swiOnly, P.route("ships/hap"))), wikiHap, "Hapes list");
  // the game's display names for class and purpose (supplement labels), the ids on hover
  const sList = P.renderIndex(c, P.route("ships/s")).html;
  assert.ok(/title="[^"]*heavyfighter">Heavy Fighter</.test(sList) && sList.includes(">Fight</span>"), "class and purpose names");
  ok("list pages");

  // loadouts: a fighter gets a combat fit only, a freighter a trader fit too
  const lo = P.loadouts(D, ewing, O);
  assert.deepStrictEqual(lo.map((x) => x.role), ["combat"]);
  assert.ok(lo[0].row.loadout.groups.some((g) => g != null), "combat fit has parts");
  const trader = D.ships.find((s) => s.purpose === "trade" && s.cargo.container > 0);
  assert.ok(P.loadouts(D, trader, O).some((x) => x.role === "trader"), trader.id + " gets a trader fit");
  ok("loadouts");
  console.log(`${n} passed`);
})().catch((e) => { console.error(e.message); process.exit(1); });
