/* SAVE READER: what the player can buy and build, read from an X4 save in the browser. A port of
 * import_save.py; it gives the same object player.js holds (window.X4PLAYER):
 *   save        file, modified, name, game_version, start, player, money
 *   licences    {licence type: [faction ids]}       blueprints  [ware ids]
 *   relations   {faction: relation}                  access      {faction: {relation, dock}}
 *   galaxy      {faction: {stations, ships: [sizes], equipment}}
 *
 * The file is streamed (gzip decompressed on the fly) and scanned once; an 800 MB save is never
 * held in memory and never leaves the browser. Text is matched with regular expressions rather
 * than an XML parser, so the same code runs in node (tests/test_savereader.js compares it with
 * import_save.py on a real save).
 *
 *   X4Save.readFile(file, onProgress)  -> player       (browser: a File from an <input> or a drop)
 *   X4Save.parseChunks(asyncIterable)  -> player       (any source of text chunks)
 *   X4Save.store(player) / stored() / clear()          (IndexedDB, for the next visit) */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.X4Save = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // A faction docks the player only while the relation is ABOVE this (import_save.py DOCK_MIN).
  const DOCK_MIN = -0.01;
  const BLOCKS = { "<info>": "</info>", '<faction id="player"': "</faction>", "<factions>": "</factions>",
                   "<blueprints>": "</blueprints>" };
  const COMPONENT = /<component class="([a-z_]+)" macro="([^"]+)"[^>]*?>/g;
  const OWNER = /owner="([^"]+)"/;
  const SIZE_ORDER = ["s", "m", "l", "xl"];

  // Attributes of every <tag ...> element in a piece of XML.
  function elements(xml, tag) {
    const out = [], re = new RegExp("<" + tag + "\\b([^>]*)>", "g");
    let m;
    while ((m = re.exec(xml))) {
      const attrs = {}, are = /([\w:.-]+)="([^"]*)"/g;
      let a;
      while ((a = are.exec(m[1]))) attrs[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      out.push(attrs);
    }
    return out;
  }

  function buildSizes(macro) {
    const m = macro.toLowerCase();
    if (!m.includes("ships") || m.includes("carrier") || m.includes("resupplier")) return [];
    if (m.includes("_xl") || m.includes("ship_xxl")) return ["xl"];
    if (m.includes("_l_") || m.endsWith("_l_macro")) return ["l"];
    return ["s", "m"];
  }

  function factionAccess(xml) {
    const playerStart = xml.indexOf('<faction id="player"');
    const player = playerStart >= 0 ? xml.slice(playerStart, xml.indexOf("</faction>", playerStart) + 10) : "";
    const base = {}, boost = {};
    for (const r of elements(player, "relation")) if (r.faction) base[r.faction] = Number(r.relation);
    for (const b of elements(player, "booster")) if (b.faction) boost[b.faction] = (boost[b.faction] || 0) + Number(b.relation);
    const out = {};
    for (const f of elements(xml, "faction")) {
      if (!f.id || f.id === "player" || f.id in out) continue;
      const r = Math.max(-1, Math.min(1, (base[f.id] || 0) + (boost[f.id] || 0)));
      out[f.id] = { relation: Math.round(r * 1e4) / 1e4, dock: r > DOCK_MIN };
    }
    return out;
  }

  /* One pass over the text: the four blocks (first occurrence each, as import_save.blocks) and
   * the station/build-module scan over the whole save (import_save.galaxy). */
  async function parseChunks(chunks, meta) {
    const pending = Object.assign({}, BLOCKS), found = {};
    const galaxy = {};
    let stationOwner = null, buf = "", scanned = 0;   // scanned: offset in buf up to which components were read
    const scan = (final) => {
      let cut = buf.lastIndexOf("<component ");
      cut = !final && cut > buf.length - 2000 ? cut : buf.length;
      COMPONENT.lastIndex = scanned;
      let m;
      while ((m = COMPONENT.exec(buf)) && m.index < cut) {
        const cls = m[1], macro = m[2];
        if (cls === "station") {
          const o = OWNER.exec(m[0]);
          stationOwner = o ? o[1] : null;
          if (stationOwner) (galaxy[stationOwner] = galaxy[stationOwner] || { stations: 0, ships: new Set(), equipment: false }).stations++;
        } else if (cls === "buildmodule" && stationOwner) {
          const rec = galaxy[stationOwner] = galaxy[stationOwner] || { stations: 0, ships: new Set(), equipment: false };
          const sizes = buildSizes(macro);
          sizes.forEach((s) => rec.ships.add(s));
          if (sizes.length || macro.toLowerCase().includes("equip")) rec.equipment = true;
        }
      }
      scanned = cut;
    };
    const findBlocks = () => {
      for (const [open, close] of Object.entries(pending)) {
        const i = buf.indexOf(open);
        if (i < 0) continue;
        const j = buf.indexOf(close, i);
        if (j < 0) continue;
        found[open] = buf.slice(i, j + close.length);
        delete pending[open];
      }
    };
    // Keep what an unfinished block or a split component tag still needs.
    const trim = () => {
      let keep = scanned;
      for (const open of Object.keys(pending)) { const i = buf.indexOf(open); if (i >= 0 && i < keep) keep = i; }
      keep = Math.min(keep, Math.max(0, buf.length - 4096));
      if (keep > 0) { buf = buf.slice(keep); scanned -= keep; }
    };
    for await (const chunk of chunks) {
      buf += chunk;
      if (buf.length < (1 << 22)) continue;
      scan(false); findBlocks(); trim();
    }
    scan(true); findBlocks();
    if (!found['<faction id="player"']) throw new Error("not an X4 save: no player faction found");

    const faction = found['<faction id="player"'];
    const licences = {};
    for (const l of elements(faction, "licence")) (licences[l.type] = licences[l.type] || []).push(...String(l.factions || "").split(/\s+/).filter(Boolean));
    const relations = {};
    for (const r of elements(faction, "relation")) if (r.faction) relations[r.faction] = Number(r.relation);
    const blueprints = [...new Set(elements(found["<blueprints>"] || "", "blueprint").map((b) => b.ware).filter(Boolean)
      .concat((found["<blueprints>"] || "").match(/ware="([^"]+)"/g) ? [...(found["<blueprints>"] || "").matchAll(/ware="([^"]+)"/g)].map((m) => m[1]) : []))].sort();
    const save = Object.assign({}, meta || {});
    if (found["<info>"]) {
      const info = found["<info>"], one = (t) => elements(info, t)[0] || null;
      const s = one("save"), g = one("game"), p = one("player");
      Object.assign(save, { name: s ? s.name || null : null, game_version: g ? g.version || null : null,
        start: g ? g.start || null : null, player: p ? p.name || null : null,
        money: p && p.money ? Number(p.money) : null });
    }
    const sorted = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...new Set(v)].sort()]));
    return {
      save, licences: sorted(licences), blueprints, relations,
      galaxy: Object.fromEntries(Object.entries(galaxy).map(([f, r]) => [f, { stations: r.stations,
        ships: [...r.ships].sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b)), equipment: r.equipment }])),
      access: found["<factions>"] ? factionAccess(found["<factions>"]) : {},
    };
  }

  // Browser: a File -> text chunks (gzip decompressed when the file is gzip), with progress by bytes read.
  async function readFile(file, onProgress) {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const gz = head[0] === 0x1f && head[1] === 0x8b;
    let read = 0;
    const counter = new TransformStream({ transform(chunk, ctl) {
      read += chunk.byteLength;
      if (onProgress) onProgress({ read, total: file.size });
      ctl.enqueue(chunk);
    } });
    let stream = file.stream().pipeThrough(counter);
    if (gz) stream = stream.pipeThrough(new DecompressionStream("gzip"));
    stream = stream.pipeThrough(new TextDecoderStream());
    const reader = stream.getReader();
    const chunks = { [Symbol.asyncIterator]() { return { next: () => reader.read() }; } };
    const pad = (n) => String(n).padStart(2, "0"), d = new Date(file.lastModified || Date.now());
    const modified = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const player = await parseChunks(chunks, { file: file.name, modified });
    player.save.loaded = "browser";
    return player;
  }

  // ---------------------------------------------------------------- IndexedDB (one stored save)
  const DB = "x4eval-save", STORE = "player", KEY = "current";
  function idb(mode, fn) {
    return new Promise((res) => {
      try {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        open.onerror = () => res(null);
        open.onsuccess = () => {
          try {
            const req = fn(open.result.transaction(STORE, mode).objectStore(STORE));
            req.onsuccess = () => res(req.result === undefined ? null : req.result);
            req.onerror = () => res(null);
          } catch (e) { res(null); }
        };
      } catch (e) { res(null); }
    });
  }
  const store = (player) => idb("readwrite", (s) => s.put(player, KEY));
  const stored = () => idb("readonly", (s) => s.get(KEY));
  const clear = () => idb("readwrite", (s) => s.delete(KEY));

  return { parseChunks, readFile, store, stored, clear, buildSizes, factionAccess, DOCK_MIN };
});
