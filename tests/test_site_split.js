// node tests/test_site_split.js
// The site's per-mod data (evaluator/site_loader.js): splitting the full build and merging any set
// of mods back must give exactly what wiki.js builds for that set directly. Uses the recorded wiki
// copy (tests/fixtures/wiki); skipped without it.
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const W = require("../evaluator/wiki.js");
const S = require("../evaluator/site_loader.js");
const { FIX, fixtureFetch } = require("../tools/fixtures.js");

if (!fs.existsSync(FIX)) { console.log("skipped: needs tests/fixtures/wiki (node tools/record_wiki.js)"); process.exit(0); }
const supplement = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "supplement", "supplement.json"), "utf-8"));
const build = (mods, origins) => W.build({ fetchJson: fixtureFetch, supplement, mods, origins });
// generated differs per build; notes are build diagnostics the merge passes through unchanged
const comparable = (d) => Object.assign({}, d, { meta: Object.assign({}, d.meta, { generated: null, notes: null }) });

// every subset of the optional mods, in load order
const ids = Object.keys(W.MODS);
const subsets = [...Array(1 << ids.length).keys()].map((bits) => ids.filter((_, i) => bits & (1 << i)));

(async () => {
  const { manifest, chunks } = S.split(await build(ids, true), W.MODS);
  assert.deepStrictEqual(manifest.mods.map((m) => m.id), ["swi"].concat(ids), "one chunk per mod, in load order");
  let n = 0;
  for (const mods of subsets) {
    const merged = S.merge(manifest, ["swi"].concat(mods).map((id) => chunks[id]));
    const direct = await build(mods, false);
    assert.deepStrictEqual(comparable(merged), comparable(direct), `merge of swi+${mods.join("+") || "nothing"} differs from a direct build`);
    console.log(`ok  swi${mods.map((m) => "+" + m).join("")}: ${merged.ships.length} ships, ${merged.parts.length} parts`);
    n++;
  }
  // the chunks round-trip through JSON (they are published as files)
  const again = S.merge(manifest, Object.values(JSON.parse(JSON.stringify(chunks))));
  assert.strictEqual(again.parts.length, manifest.parts);
  assert.throws(() => S.merge(manifest, [chunks.dabc]), /SW Interworlds/);
  assert.throws(() => S.merge(Object.assign({}, manifest, { version: 99 }), [chunks.swi]), /understands/);
  console.log(`${n + 1} passed`);
})().catch((e) => { console.error(e.message); process.exit(1); });
