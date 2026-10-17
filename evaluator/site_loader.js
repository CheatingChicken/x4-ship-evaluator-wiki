/* SITE DATA: the published site's data comes as one file per mod, so a visitor downloads SWI plus
 * only the submods they enable (⚙ Settings → Mods).
 *
 *   build (tools/build_site.js)  split(data, mods) -> { manifest, chunks }: data is X4DATA built by
 *                                wiki.js with every mod and `origins`; one chunk per mod, written as
 *                                data/<mod>.json
 *   page                         data.js is `window.X4SITE = <manifest>;` followed by this file, which
 *                                then sets window.X4Source; app.js awaits its load(), which fetches
 *                                the enabled mods' chunks and merge()s them into X4DATA
 *
 * Parts are numbered once, across every mod (the full build's order). Chunks keep those global
 * numbers; merge() renumbers the parts actually loaded and drops the fits and engine/thruster rows
 * that point at a mod left out. Mining slots: a group counts as mining when its slot tags say so
 * or a mining part of a loaded mod fits it (miningFrom), as a build of just those mods would.
 * tests/test_site_split.js checks merge() against wiki.js builds of the same mod sets.
 *
 * Adding a submod needs nothing here: it is an entry in wiki.js MODS, and the build adds its chunk. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (root.X4SITE) root.X4Source = api.source(root.X4SITE);
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const FORMAT = "x4-ship-evaluator/site", VERSION = 1;
  const CORE = "swi";                      // always loaded; also holds the base game's thrusters
  const STORE = "x4wiki.mods";             // the same choice as wiki.js's live mode
  const byId = (a, b) => (a.id < b.id ? -1 : 1);   // wiki.js's order

  // ---------------------------------------------------------------- build time
  // mods: { id: label } of the optional submods, in load order (wiki.js MODS)
  function split(data, mods) {
    const ids = [CORE].concat(Object.keys(mods));
    const chunks = Object.fromEntries(ids.map((id) => [id, { format: FORMAT + "/mod", version: VERSION, id, parts: [], ships: [] }]));
    const chunkOf = (origin, what) => {
      const c = chunks[origin === "base" ? CORE : origin];
      if (!c) throw new Error(`${what}: comes from "${origin}", which is not a known mod (data built without origins?)`);
      return c;
    };
    data.parts.forEach((p, i) => {
      const rec = Object.assign({ i }, p);
      delete rec.origin;
      chunkOf(p.origin, "part " + p.id).parts.push(rec);
    });
    for (const s of data.ships) chunkOf(s.origin, "ship " + s.id).ships.push(s);
    const meta = Object.assign({}, data.meta);
    delete meta.mods;
    const manifest = { format: FORMAT, version: VERSION, parts: data.parts.length,
      factions: data.factions, faction_short: data.faction_short, calibration: data.calibration,
      calibration_default: data.calibration_default, meta,
      mods: ids.map((id) => ({ id, label: id === CORE ? "SW Interworlds" : mods[id],
        ships: chunks[id].ships.length, parts: chunks[id].parts.length })) };
    return { manifest, chunks };
  }

  // ---------------------------------------------------------------- page
  // chunks: the loaded mods' chunks, CORE among them, in load order
  function merge(manifest, chunks) {
    if (!manifest || manifest.format !== FORMAT || manifest.version !== VERSION) throw new Error("data.js is not site data this page understands");
    for (const c of chunks) if (!c || c.format !== FORMAT + "/mod" || c.version !== VERSION) throw new Error("a mod data file is damaged or from another version");
    if (!chunks.some((c) => c.id === CORE)) throw new Error("the SW Interworlds data is missing");
    const loaded = new Set(chunks.map((c) => c.id));
    const renum = new Map();
    const parts = chunks.flatMap((c) => c.parts).sort((a, b) => a.i - b.i).map((p, n) => {
      renum.set(p.i, n);
      const rec = Object.assign({}, p);
      delete rec.i;
      return rec;
    });
    const keep = (list) => list.filter((i) => renum.has(i)).map((i) => renum.get(i));
    const rows = (o) => Object.fromEntries(Object.entries(o).filter(([i]) => renum.has(+i)).map(([i, r]) => [renum.get(+i), r]));
    const ships = chunks.flatMap((c) => c.ships).sort(byId).map((s) => Object.assign({}, s, {
      groups: s.groups.map((g) => ({ kind: g.kind, size: g.size, count: g.count,
        mining: g.mining || (g.miningFrom || []).some((o) => loaded.has(o)), cands: keep(g.cands) })),
      engines: rows(s.engines), thrusters: rows(s.thrusters) }));
    // Factions: those selling something loaded (wiki.js does the same over its own build)
    const sellers = new Set([...ships, ...parts].flatMap((x) => x.owners));
    const factions = Object.fromEntries([...sellers].sort().map((f) => [f, manifest.factions[f] || f]));
    const short = Object.fromEntries([...sellers].filter((f) => f in manifest.faction_short).map((f) => [f, manifest.faction_short[f]]));
    const order = manifest.mods.map((m) => m.id).filter((id) => loaded.has(id));
    return { parts, ships, factions, faction_short: short, calibration: manifest.calibration,
      calibration_default: manifest.calibration_default,
      meta: Object.assign({}, manifest.meta, { mods: order,
        load_order: (manifest.meta.load_order || []).filter((e) => loaded.has(e.id)) }) };
  }

  // window.X4Source for app.js (see its BOOT block)
  function source(manifest) {
    const optional = manifest.mods.filter((m) => m.id !== CORE).map((m) => m.id);
    function enabledMods() {
      try {
        const q = new URLSearchParams(location.search).get("mods");
        const list = q != null ? q.split(",") : JSON.parse(localStorage.getItem(STORE) || "null");
        if (Array.isArray(list)) return optional.filter((id) => list.includes(id));
      } catch (e) { /* storage blocked */ }
      return [];                           // default: SWI alone
    }
    return {
      name: "wiki", label: "this site",
      mods: Object.fromEntries(manifest.mods.map((m) => [m.id, m.label])),
      sizes: Object.fromEntries(manifest.mods.map((m) => [m.id, { ships: m.ships, parts: m.parts, bytes: m.bytes }])),
      enabledMods,
      setMods(list) { try { localStorage.setItem(STORE, JSON.stringify(optional.filter((id) => list.includes(id)))); } catch (e) { /* ignore */ } },
      async load(onProgress) {
        const on = enabledMods();
        const want = manifest.mods.filter((m) => m.id === CORE || on.includes(m.id));
        let done = 0;
        const tell = () => onProgress && onProgress({ phase: "ship data", done, total: want.length });
        tell();
        const chunks = await Promise.all(want.map(async (m) => {
          const r = await fetch(m.file);
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${m.file}`);
          const c = await r.json();
          done++; tell();
          return c;
        }));
        return merge(manifest, chunks);
      },
    };
  }

  return { FORMAT, VERSION, CORE, split, merge, source };
});
