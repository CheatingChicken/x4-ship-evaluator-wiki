/* WIKI ADAPTER: builds the evaluator's data (window.X4DATA, the shape x4cat/export.py writes in the
 * local edition) from the Star Wars Interworlds wiki's JSON plus our supplement.json.
 *
 * Sources (all values in them are strings; empty {} component entries are skipped):
 *   base SWI ships   swi-api  /ships/<hull>/list/full, /ships/<hull>/<id>   (macro, components, ware)
 *   submod ships     wiki     /submods/<mod>/ships/<hull>.json, .../<hull>/<id>.json
 *   parts            wiki     [/submods/<mod>]/equipment/<folder>.json and .../<folder>/<name>.json
 *   base part wares  swi-api  /wares          (joined on ware.component._ref = part macro)
 *   the rest         supplement.json: thrusters, storage (cargo), shipstorage (hangars), part wares the
 *                    wiki lacks, faction names, calibration constants, probe-measured part stats
 *
 * Every rule is a one-for-one port of the local edition's Python (catalogue.py, metrics.py,
 * export.py); tests/test_wiki_adapter.js compares the result with the local data.js.
 *
 * Mods are an ALLOWLIST (MODS below). Nothing outside it is ever requested.
 *
 * Browser: sets window.X4Source = { name, mods, load(onProgress) }; app.js awaits load() when no
 * data.js is present. Node: module.exports = { build, ... }, with an injectable fetchJson. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.X4Wiki = api;
    root.X4Source = api.source();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------- configuration
  // Optional submods, in load order; SWI is always on. Adding one: an entry here plus its supplement
  // data (x4cat/supplement.py ALLOWED); the site build then publishes it as its own data file.
  const MODS = { dabc: "Dreadnaughts and Battlecruisers (DABC)", rsp: "Reaper's Ship Pack (RSP)" };
  const CONFIG = {
    api: "https://swi-api.siifr.net",
    wiki: "https://swi.siifr.net",
    supplement: "https://cheatingchicken.github.io/x4-ship-evaluator-wiki/supplement.json",
    concurrency: 6,
  };
  const HULLS = ["s", "m", "l", "xl", "xxl"];
  const FOLDERS = ["engines", "shields", "weapons", "turrets"];

  // ---------------------------------------------------------------- small helpers
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  // catalogue.number: a float for numeric text, else the text unchanged
  function number(v) {
    if (v == null) return null;
    if (typeof v === "number") return v;
    const s = String(v);
    if (s.trim() !== "" && isFinite(Number(s))) return Number(s);
    const m = /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*$/.exec(s);
    return m ? Number(m[1]) : s.trim();
  }
  const isNum = (v) => typeof v === "number" && isFinite(v);
  // Egosoft colour codes (\033U, \033#ffffba66#) and literal \n, as stored in the JSON
  const cleanText = (s) => (s == null ? null : String(s)
    .replace(/\\033(?:#[0-9a-fA-F]{6,8}#|[A-Za-z])/g, "").replace(/\\n/g, " ")
    .replace(/\\([()])/g, "$1")                       // X4 text escapes parentheses: "\(CE\)"
    .replace(/\s{2,}/g, " ").trim()) || null;
  const unresolved = (s) => /^\s*\{\s*\d+\s*,\s*\d+\s*\}\s*$/.test(s || "");

  // catalogue.flatten for the fast-xml-parser shape the wiki uses: attributes are "_name" keys,
  // child elements are objects, repeated children are arrays (skipped, as in the Python).
  const SKIP = new Set(["effects", "sounds", "steeringcurve", "decelerationcurve", "strafecurve", "software",
    "sound_library", "boostingcurve", "travelcurve"]);
  function flatten(el, prefix, out) {
    out = out || {};
    if (!isObj(el)) return out;
    for (const [tag, c] of Object.entries(el)) {
      if (tag.startsWith("_") || tag === "#text" || SKIP.has(tag) || Array.isArray(c)) continue;
      const key = prefix + tag;
      if (isObj(c)) {
        for (const [a, v] of Object.entries(c)) if (a.startsWith("_")) out[key + "." + a.slice(1)] = number(v);
        flatten(c, key + ".", out);
      }
    }
    return out;
  }
  const P = (rec, key, dflt) => { const v = rec && rec.props ? rec.props[key] : undefined; return isNum(v) ? v : (dflt === undefined ? 0 : dflt); };
  const div = (a, b) => (b ? a / b : 0);
  const round3 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, isNum(v) && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v]));

  // ---------------------------------------------------------------- catalogue.py ports
  const SIZES = ["extrasmall", "small", "medium", "large", "extralarge"];
  const SIZE_CODE = { extrasmall: "xs", small: "s", medium: "m", large: "l", extralarge: "xl" };
  const SIZE_PREFIXES = Object.keys(SIZE_CODE).sort((a, b) => b.length - a.length);
  function sizeOf(tags) {
    for (const s of SIZES) if (tags.has(s)) return SIZE_CODE[s];
    for (const t of [...tags].sort()) for (const p of SIZE_PREFIXES) if (t.startsWith(p)) return SIZE_CODE[p];
    return null;
  }
  const mines = (flat) => flat["bullet.weapon.system"] === "weapon_mining" || !!flat["bullet.damage.multiplier.mining"];
  const SLOT_KINDS = ["engine", "turret", "weapon", "shield"];        // first match wins
  const SLOT_ACCEPTS = { engine: ["engine"], weapon: ["weapon", "missilelauncher", "bomblauncher"],
    turret: ["turret", "missileturret"], shield: ["shield"] };
  const RACE_LOCKED = new Set(["xenon", "khaak"]);
  const CLASS_KIND = { engine: "engine", shieldgenerator: "shield", weapon: "weapon", missilelauncher: "missilelauncher",
    bomblauncher: "bomblauncher", turret: "turret", missileturret: "missileturret" };

  // ---------------------------------------------------------------- metrics.py ports
  let CAL = {};
  const k = (stat) => (stat in CAL ? CAL[stat] : 1);
  const ENGINE_STATS = ["ForwardSpeed", "BoostSpeed", "TravelSpeed", "ForwardAcceleration", "BoostAcceleration",
    "TravelAcceleration", "TravelChargeTime", "BoostMaxDuration", "TravelDeceleration"];
  const THRUSTER_STATS = ["YawSpeed", "PitchSpeed", "RollSpeed", "HorizontalStrafeSpeed", "VerticalStrafeSpeed",
    "HorizontalStrafeAcceleration", "YawAcceleration"];
  const PART_STATS = ["ShieldValue", "ShieldRate", "ShieldDelay", "BurstDPS", "SustainedDPS", "TurretBurstDPS",
    "TurretSustainedDPS", "MiningRate", "Range"];
  const CARGO_TYPES = ["container", "solid", "liquid", "condensate"];
  const RAD = Math.PI / 180;

  function movementRaw(ship, engine, thruster, engines) {
    const thrust = P(engine, "thrust.forward") * engines, mass = P(ship, "physics.mass");
    const acc = (axis) => P(ship, "physics.accfactors." + axis, 1.0);
    const o = { ForwardSpeed: div(thrust, P(ship, "physics.drag.forward")), ForwardAcceleration: div(thrust, mass) * acc("forward") };
    o.BoostSpeed = o.ForwardSpeed * P(engine, "boost.thrust", 1.0);
    o.BoostAcceleration = o.ForwardAcceleration * P(engine, "boost.acceleration", 1.0);
    o.TravelSpeed = o.ForwardSpeed * P(engine, "travel.thrust", 1.0);
    const attack = P(engine, "travel.attack");
    o.TravelAcceleration = attack > 0 ? o.TravelSpeed / attack : o.ForwardAcceleration;
    o.TravelChargeTime = P(engine, "travel.charge");
    o.BoostMaxDuration = P(engine, "boost.duration");
    for (const [axis, stat] of [["yaw", "YawSpeed"], ["pitch", "PitchSpeed"], ["roll", "RollSpeed"]])
      o[stat] = div(P(thruster, "thrust." + axis), P(ship, "physics.drag." + axis)) * RAD;
    const strafe = P(thruster, "thrust.strafe");
    o.HorizontalStrafeSpeed = div(strafe, P(ship, "physics.drag.horizontal"));
    o.VerticalStrafeSpeed = div(strafe, P(ship, "physics.drag.vertical"));
    o.YawAcceleration = div(P(thruster, "thrust.yaw"), P(ship, "physics.inertia.yaw")) * RAD;
    const release = P(engine, "travel.release");
    o.TravelDeceleration = release > 0 ? o.TravelSpeed / release : o.TravelAcceleration;
    o.HorizontalStrafeAcceleration = div(strafe, mass) * acc("horizontal");
    o.VerticalStrafeAcceleration = div(strafe, mass) * acc("vertical");
    return o;
  }
  const movement = (ship, engine, thruster, n) =>
    Object.fromEntries(Object.entries(movementRaw(ship, engine, thruster, n)).map(([s, v]) => [s, v * k(s)]));

  function shotsPerSecond(part) {
    let rate = P(part, "bullet.reload.rate") || P(part, "reload.rate");
    if (!rate) rate = div(1.0, P(part, "bullet.reload.time") || P(part, "reload.time"));
    const mag = P(part, "bullet.ammunition.value"), reload = P(part, "bullet.ammunition.reload");
    if (rate && mag && reload) rate = mag / (mag / rate + reload);
    return rate;
  }
  function partRaw(part) {
    if (part.kind === "shield")
      return { ShieldValue: P(part, "recharge.max"), ShieldRate: P(part, "recharge.rate"), ShieldDelay: P(part, "recharge.delay") };
    const perShot = (P(part, "bullet.damage.value") || Math.max(P(part, "bullet.damage.shield"), P(part, "bullet.damage.hull")))
      * (P(part, "bullet.bullet.amount", 1.0) || 1.0);
    const dps = perShot * shotsPerSecond(part);
    const o = part.mining ? { MiningRate: dps * P(part, "bullet.damage.multiplier.mining") } : {};
    o[part.kind === "turret" || part.kind === "missileturret" ? "TurretBurstDPS" : "BurstDPS"] = dps;
    o.Range = P(part, "bullet.bullet.range") || P(part, "bullet.bullet.speed") * P(part, "bullet.bullet.lifetime");
    return o;
  }
  const partStats = (part) => Object.fromEntries(Object.entries(partRaw(part)).map(([s, v]) => [s, v * k(s)]));

  // export.part_use
  const LAUNCHER_KINDS = ["missilelauncher", "bomblauncher", "missileturret"];
  const LAUNCHER_SYSTEMS = ["missile_guided", "missile_dumbfire", "torpedo", "bomb"];
  function partUse(p, stats) {
    const system = p.props["bullet.weapon.system"] || "";
    if (LAUNCHER_KINDS.includes(p.kind) || LAUNCHER_SYSTEMS.includes(system)) return "launcher";
    if (p.kind !== "weapon" && p.kind !== "turret") return p.kind;
    if (p.mining) return "mining";
    if (system === "weapon_repair") return "repair";
    return Math.max(stats.BurstDPS || 0, stats.TurretBurstDPS || 0) <= 1 ? "utility" : "combat";
  }

  // ---------------------------------------------------------------- wares
  // The primary production method: several methods (default, terran, closedloop, ...) make
  // `production` an array, and "default" is the primary one; one ingredient is an object, not an array.
  function buildOf(production) {
    const list = arr(production);
    const p = list.find((m) => m && m._method === "default") || list[0];
    if (!p || !p.primary) return null;
    return { time: number(p._time) || null,
      wares: arr(p.primary.ware).filter((r) => r && r._ware).map((r) => ({ ware: r._ware, amount: number(r._amount) || 0 })) };
  }
  function wareRecord(w) {
    if (!w) return null;
    const tags = new Set(String(w._tags || "").split(/\s+/).filter(Boolean));
    const price = w.price || {};
    return { ware: w._id || null, price: number(price._average) || 0, min: number(price._min) || null, max: number(price._max) || null,
      owners: [...new Set(arr(w.owner).map((o) => o && o._faction).filter(Boolean))].sort(),
      licence: (w.restriction && w.restriction._licence) || null,
      blueprintable: !(tags.has("noblueprint") || tags.has("noplayerblueprint")), build: buildOf(w.production) };
  }
  // supplement ware entries: {ware, price, min, max, owners, licence, blueprintable}; no build costs
  const supWare = (w) => (w ? { ware: w.ware || null, price: w.price || 0, min: w.min || null, max: w.max || null,
    owners: (w.owners || []).slice().sort(), licence: w.licence || null, blueprintable: w.blueprintable !== false, build: null } : null);

  // ---------------------------------------------------------------- details (the ship pages)
  // What the ship pages show beyond the evaluator's own data. Only built on request (`details`).
  const longText = (s) => (s == null || unresolved(s) ? null
    : String(s).split(/\\n/).map(cleanText).filter(Boolean).join("\n") || null);   // paragraphs kept
  const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
  const priceOf = (w) => compact({ min: w.min, avg: w.price || null, max: w.max });
  const LAUNCHERS = ["weapon", "turret", "missilelauncher", "bomblauncher", "missileturret"];
  // Weapon and turret columns follow the wiki's own reading of the macros (its ship page script):
  // shield = damage.shield, else damage.value; pierce = damage.hull (ignores shields); hull =
  // damage.noshield, else damage.value. Heat buildup = heat per shot x fire rate; a magazine
  // (ammunition) gives a burst of value / rate seconds and a cooldown of its reload time.
  function partDetail(e) {
    const f = e.props, v = (key) => (isNum(f[key]) ? f[key] : null);
    const o = { description: longText(f["identification.description"]), price: priceOf(e.w), build: e.w.build };
    if (e.kind === "engine") Object.assign(o, { thrust: v("thrust.forward"), boostDuration: v("boost.duration"), boostRecharge: v("boost.recharge") });
    if (LAUNCHERS.includes(e.kind)) {
      const time = v("bullet.reload.time") || v("reload.time");
      const rate = v("bullet.reload.rate") || v("reload.rate") || (time ? 1 / time : null);
      const speed = v("bullet.bullet.speed"), life = v("bullet.bullet.lifetime");
      const heat = v("bullet.heat.value"), mag = v("bullet.ammunition.value");
      Object.assign(o, { shieldDamage: v("bullet.damage.shield") ?? v("bullet.damage.value"), pierceDamage: v("bullet.damage.hull"),
        hullDamage: v("bullet.damage.noshield") ?? v("bullet.damage.value"), projectiles: v("bullet.bullet.amount"),
        speed, range: v("bullet.bullet.range") ?? (speed != null && life != null ? speed * life : null), rate,
        heatBuildup: heat != null && rate ? heat * rate : null, coolRate: v("heat.coolrate"), overheat: v("heat.overheat"),
        burst: mag && rate ? mag / rate : null, cooldown: v("bullet.ammunition.reload"), rotation: v("rotationspeed.max") });
    }
    return round3(compact(o));
  }
  // A ship's threatscore, its maintenance cost under SWI (md/sw_maintenance.xml): the macro's own
  // value, else SWI's default for its class and purpose (supplement threatdefaults, from
  // libraries/defaults.xml; export.ship_threat in the local edition). XS ships pay none.
  function threatOf(s, defaults) {
    if (s.size === "xs") return 0;
    const own = P(s, "threatscore.value", null);
    if (own != null) return own;
    const d = (defaults || {})["ship_" + s.size] || {};
    const v = (d.purposes || {})[s.purpose];
    return v != null ? v : d.default || 0;
  }
  function shipDetail(s) {
    const v = (key) => (isNum(s.props[key]) ? s.props[key] : null);
    return compact({ page: { hull: s.hull, key: s.key }, icon: s.icon, description: longText(s.description), price: priceOf(s.w), build: s.w.build,
      groupTags: s.groups.map((g) => g.tags),                         // in the order of the ship's groups
      deployables: v("storage.deployable"), countermeasures: v("storage.countermeasure"), radar: v("radar.range"),
      supply: s.threat });
  }

  // ---------------------------------------------------------------- fetching
  // A pool of at most n requests in flight; each failure retried once.
  function limiter(n) {
    let active = 0; const queue = [];
    const next = () => { if (active >= n || !queue.length) return; active++; const [fn, res, rej] = queue.shift();
      fn().then(res, rej).finally(() => { active--; next(); }); };
    return (fn) => new Promise((res, rej) => { queue.push([fn, res, rej]); next(); });
  }
  async function browserFetchJson(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
        return await r.json();
      } catch (e) {
        if (attempt >= 1) throw e;
        await new Promise((res) => setTimeout(res, 1200));
      }
    }
  }

  // ---------------------------------------------------------------- build
  /* build({ fetchJson, mods, supplement, config, onProgress, origins }) -> X4DATA
   *   fetchJson(url) -> parsed JSON or null (404). mods: subset of Object.keys(MODS).
   *   origins: also record which source each part and mining fit comes from (see assemble).
 *   details: also return `details` { ships, parts } by id, for the ship pages (shipDetail, partDetail). */
  async function build(opts) {
    const cfg = Object.assign({}, CONFIG, opts.config || {});
    const mods = (opts.mods || Object.keys(MODS)).filter((m) => m in MODS);   // allowlist
    const get = opts.fetchJson || browserFetchJson;
    const lim = limiter(cfg.concurrency);
    const progress = { done: 0, total: 0, phase: "lists" };
    const tell = () => opts.onProgress && opts.onProgress(Object.assign({}, progress));
    const fetchOne = (url) => { progress.total++; tell(); return lim(() => get(url)).then((j) => { progress.done++; tell(); return j; }); };

    // 1. lists, dictionaries, wares, supplement
    const sup = opts.supplement || await fetchOne(cfg.supplement);
    if (!sup || sup.format !== "x4-ship-evaluator/supplement") throw new Error("supplement.json missing or not a supplement");
    CAL = Object.assign({}, (sup.calibration && sup.calibration.constants) || {});
    const sources = [{ id: "swi", label: "SW Interworlds", shipList: (h) => `${cfg.api}/ships/${h}/list/full`,
      ship: (h, id) => `${cfg.api}/ships/${h}/${encodeURIComponent(id)}`, equip: `${cfg.wiki}/equipment` }]
      .concat(mods.map((m) => ({ id: m, label: MODS[m], shipList: (h) => `${cfg.wiki}/submods/${m}/ships/${h}.json`,
        ship: (h, id) => `${cfg.wiki}/submods/${m}/ships/${h}/${encodeURIComponent(id)}.json`, equip: `${cfg.wiki}/submods/${m}/equipment` })));
    const [wares, ...perSource] = await Promise.all([fetchOne(`${cfg.api}/wares`)].concat(sources.map(async (src) => {
      const lists = await Promise.all(HULLS.map((h) => fetchOne(src.shipList(h))));
      const dicts = await Promise.all(FOLDERS.map((f) => fetchOne(`${src.equip}/${f}.json`)));
      return { src, lists, dicts };
    })));

    // 2. every ship and part file
    progress.phase = "ships and parts";
    const shipJobs = [], partJobs = [];
    for (const { src, lists, dicts } of perSource) {
      HULLS.forEach((h, i) => Object.entries(lists[i] || {}).forEach(([id, entry]) =>
        shipJobs.push(fetchOne(src.ship(h, id)).then((j) => j && { src, hull: h, id, entry, j }))));
      FOLDERS.forEach((f, i) => Object.entries(dicts[i] || {}).forEach(([name, entry]) =>
        partJobs.push(fetchOne(`${src.equip}/${f}/${encodeURIComponent(name)}.json`).then((j) => j && { src, folder: f, name, entry, j }))));
    }
    const shipFiles = (await Promise.all(shipJobs)).filter(Boolean);
    const partFiles = (await Promise.all(partJobs)).filter(Boolean);
    progress.phase = "building";
    tell();
    return assemble({ sup, wares: arr(wares), shipFiles, partFiles, sources, mods, origins: !!opts.origins, details: !!opts.details });
  }

  // ---------------------------------------------------------------- assembly (pure)
  /* origins: for splitting the result per mod (site_loader.js). Parts then carry `origin` (the
   * source that defines them; "base" for thrusters) and each slot group carries `mining` from its
   * slot tags alone plus `miningFrom`, the sources of the mining parts that fit it. */
  function assemble({ sup, wares, shipFiles, partFiles, sources, mods, origins, details }) {
    CAL = Object.assign({}, (sup.calibration && sup.calibration.constants) || {});
    const waresByMacro = {};
    for (const w of wares) {
      const ref = w && w.component && w.component._ref;
      if (ref) waresByMacro[String(ref).toLowerCase()] = w;
    }

    // Parts: later sources override earlier ones (SWI, then the enabled submods), like a load order.
    const equipment = {}, overridden = new Set();
    for (const { src, entry, j } of partFiles) {
      const m = j.macro || {};
      const id = String(m._name || "").toLowerCase();
      const kind = CLASS_KIND[m._class];
      if (!id || !kind) continue;
      if (equipment[id] && equipment[id].origin !== src.id) overridden.add(id);
      const attach = new Set(arr(j.connection && j.connection._tags).map(String));
      const props = m.properties || {};
      const flat = flatten(props, "");
      if (j.bullet && isObj(j.bullet.properties)) flatten(j.bullet.properties, "bullet.", flat);
      const ident = props.identification || {};
      let name = cleanText(ident._name);
      if (!name || unresolved(name)) name = cleanText(entry && entry._fullname) || id;
      // hittable/unhittable: the wiki drops them, but they decide fits (see slotFlag below)
      const pf = (sup.partflags || {})[id];
      if (pf === "hittable" || pf === "unhittable") attach.add(pf);
      equipment[id] = { id, kind: kind === "shieldgenerator" ? "shield" : kind, size: sizeOf(attach), attach,
        race: ident._makerrace || null, mk: isNum(number(ident._mk)) ? number(ident._mk) : null,
        alias: m._alias ? String(m._alias).toLowerCase() : null, name, props: flat, mining: mines(flat), origin: src.id };
    }
    // Thrusters: not on the wiki, from the supplement.
    for (const [id0, t] of Object.entries(sup.thrusters || {})) {
      const id = id0.toLowerCase();
      const props = {};
      for (const [ax, v] of Object.entries(t.thrust || {})) props["thrust." + ax] = number(v);
      equipment[id] = { id, kind: "thruster", size: t.size || null, attach: new Set((t.tags || []).filter((x) => x !== "component")),
        race: t.race || null, mk: isNum(t.mk) ? t.mk : null, alias: null, name: t.name || id, props, mining: false, origin: "base" };
    }
    // Wares: the wiki's base wares first, then the supplement (submod parts, thrusters, unmatched base parts).
    for (const e of Object.values(equipment)) {
      let w = wareRecord(waresByMacro[e.id]) || supWare((sup.wares || {})[e.id]) || supWare((sup.thrusters || {})[e.id] && Object.assign({}, sup.thrusters[e.id]));
      if (!w && e.alias) w = wareRecord(waresByMacro[e.alias]) || supWare((sup.wares || {})[e.alias]);
      e.w = w && w.ware ? w : null;
    }

    // Ships
    const ships = {};
    for (const { src, hull, id: key, entry, j } of shipFiles) {
      const m = j.macro || {};
      const id = String(m._name || "").toLowerCase();
      const cls = String(m._class || "");
      if (!id || !cls.startsWith("ship_")) continue;
      if (ships[id] && ships[id].src !== src.id) overridden.add(id);
      const props = m.properties || {};
      const flat = flatten(props, "");
      const ident = props.identification || {};
      let name = cleanText(entry && entry._fullname) || cleanText(ident._name);
      if (!name || unresolved(name)) name = cleanText(ident._basename) || id;
      // Slots: the ship template's connections, first definition of a name kept (catalogue.py).
      // The supplement restores each slot's hittable/unhittable tag, which the wiki drops: a part
      // tagged hittable only fits a hittable slot (and likewise unhittable).
      const flags = (sup.slotflags || {})[id];
      const slotFlag = (name) => {
        if (!flags) return null;
        for (const f of ["hittable", "unhittable", "none"]) if ((flags[f] || []).includes(name)) return f === "none" ? null : f;
        return flags.default || null;
      };
      const slots = [], seen = new Set();
      for (const c of Object.values(j.components || {})) {
        if (!isObj(c) || !c._name) continue;
        const tags = new Set(arr(c._tags).map(String));
        const flag = slotFlag(c._name);
        if (flag) tags.add(flag);
        const kind = SLOT_KINDS.find((x) => tags.has(x));
        if (!kind) continue;
        const key = String(c._name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({ name: c._name, kind, size: sizeOf(tags), tags: [...tags].sort(), mining: tags.has("mining") });
      }
      // Cargo and hangars: the storage macros the ship connects, from the supplement; cargo falls back
      // to the macro name (storage_<type>_<volume>) only when the supplement does not know a storage.
      const cargo = {}, hangar = [], unknownStorage = [];
      for (const con of arr(m.connections && m.connections.connection)) {
        const ref = String((con && con.macro && con.macro._ref) || "").toLowerCase();
        if (!ref) continue;
        const st = (sup.storage || {})[ref], sh = (sup.shipstorage || {})[ref];
        if (st && st.cargo) {
          const key = (st.cargo.tags || []).slice().sort().join(" ");
          cargo[key] = (cargo[key] || 0) + (number(st.cargo.max) || 0);
        } else if (sh) {
          hangar.push({ macro: ref, capacity: sh.capacity == null ? null : number(sh.capacity), docksize: sh.docksize || null });
        } else if (/(?:^|_)storage_/.test(ref) && !/shipstorage/.test(ref)) {
          const mm = /(?:^|_)storage_([a-z]+)_([0-9]+)/.exec(ref);
          if (mm) { const t = mm[1] === "universal" ? "container liquid solid" : mm[1]; cargo[t] = (cargo[t] || 0) + Number(mm[2]); }
          unknownStorage.push(ref);
        }
      }
      ships[id] = { id, size: cls.slice(5), props: flat, src: src.id, hull,
        purpose: (props.purpose && props.purpose._primary) || null, type: (props.ship && props.ship._type) || null,
        race: ident._makerrace || null, name, variation: cleanText(ident._variation),
        thrusterTags: new Set(String((props.thruster && props.thruster._tags) || "").split(/\s+/).filter(Boolean)),
        slots, cargo, hangar, unknownStorage, w: wareRecord(j.ware), key, description: j.description,
        icon: entry && entry._icon ? String(entry._icon).toLowerCase() : null };
    }

    // Fits (catalogue._fits): a part fits a slot when every attach tag but `component` is on it.
    // A part with several mounting connections fits if ANY of them does; the wiki keeps only one,
    // the supplement lists all of them for the few parts that have more.
    const need = {};
    for (const e of Object.values(equipment)) {
      const options = ((sup.attachoptions || {})[e.id] || [[...e.attach]]).map((o) =>
        new Set(o.filter((x) => x !== "component" && !(e.kind === "thruster" && x === "thruster"))));
      need[e.id] = options;
    }
    const fits = (pid, tags) => need[pid].some((o) => { for (const t of o) if (!tags.has(t)) return false; return true; });
    const raceOk = (pid, s) => { const r = equipment[pid].race; return !RACE_LOCKED.has(r) || r === s.race; };
    const byKind = {};
    for (const e of Object.values(equipment)) (byKind[e.kind] = byKind[e.kind] || []).push(e.id);
    for (const s of Object.values(ships)) {
      const groups = new Map();
      for (const slot of s.slots) {
        const key = slot.kind + "|" + slot.tags.join(" ");
        if (!groups.has(key)) groups.set(key, { kind: slot.kind, size: slot.size, tags: slot.tags, mining: slot.mining, count: 0, names: [], fits: [] });
        const g = groups.get(key); g.count++; g.names.push(slot.name);
      }
      for (const g of groups.values()) {
        const tags = new Set(g.tags);
        const cands = SLOT_ACCEPTS[g.kind].flatMap((k2) => byKind[k2] || []);
        g.fits = cands.filter((n) => fits(n, tags) && raceOk(n, s)).sort();
        g.slotMining = g.mining;
        g.miningFrom = [...new Set(g.fits.filter((n) => equipment[n].mining).map((n) => equipment[n].origin))].sort();
        g.mining = g.mining || g.miningFrom.length > 0;
      }
      s.thrusters = s.thrusterTags.size ? (byKind.thruster || []).filter((n) => fits(n, s.thrusterTags) && raceOk(n, s)).sort() : [];
      s.groups = [...groups.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
        || String(a.size || "").localeCompare(String(b.size || "")) || a.tags.join(" ").localeCompare(b.tags.join(" ")));
    }

    // export.build: parts (buyable only), then ships with their rows.
    const measured = sup.measured || {};
    const parts = [], index = {}, det = details ? { ships: {}, parts: {} } : null;
    for (const e of Object.values(equipment).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!e.w) continue;
      let stats = partStats(e), src = "formula";
      const meas = measured[e.id] || (e.alias && measured[e.alias]);
      if (meas) { for (const s2 of PART_STATS) if (meas[s2]) stats[s2] = meas[s2]; src = "game"; }
      if ("BurstDPS" in stats && !("SustainedDPS" in stats)) stats.SustainedDPS = stats.BurstDPS;
      if ("TurretBurstDPS" in stats && !("TurretSustainedDPS" in stats)) stats.TurretSustainedDPS = stats.TurretBurstDPS;
      index[e.id] = parts.length;
      parts.push({ id: e.id, ware: e.w.ware, name: e.name, kind: e.kind, size: e.size, race: e.race, mk: e.mk, mining: e.mining,
        price: e.w.price || 0, owners: e.w.owners, licence: e.w.licence, blueprintable: e.w.blueprintable, src, use: partUse(e, stats),
        stats: round3(Object.fromEntries(Object.entries(stats).filter(([s2]) => PART_STATS.includes(s2)))) });
      if (origins) parts[parts.length - 1].origin = e.origin;
      if (det) det.parts[e.id] = partDetail(e);
    }
    const outShips = [], notes = { unknownStorage: new Set(), noWare: [] };
    for (const s of Object.values(ships).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!s.w || !s.w.ware) { notes.noWare.push(s.id); continue; }
      s.unknownStorage.forEach((r) => notes.unknownStorage.add(r));
      const groups = s.groups.map((g) => Object.assign({ kind: g.kind, size: g.size, count: g.count, mining: origins ? g.slotMining : g.mining,
        cands: [...new Set(g.fits.filter((n) => n in index).map((n) => index[n]))].sort((a, b) => a - b) },
        origins ? { miningFrom: g.miningFrom } : {}));
      const engGroups = s.groups.filter((g) => g.kind === "engine");
      const engines = [...new Set(engGroups.flatMap((g) => g.fits.filter((n) => n in index).map((n) => index[n])))].sort((a, b) => a - b);
      const thrusters = [...new Set(s.thrusters.filter((n) => n in index).map((n) => index[n]))].sort((a, b) => a - b);
      const thr0 = s.thrusters.length ? equipment[s.thrusters[0]] : null;
      const eng0 = engines.length ? equipment[parts[engines[0]].id] : null;
      const engineRows = {};
      for (const i of engines) {
        const e = equipment[parts[i].id];
        const n = engGroups.filter((g) => g.fits.includes(e.id)).reduce((a, g) => a + g.count, 0);
        const row = movement(s, e, thr0, n);
        engineRows[i] = Object.assign(round3(Object.fromEntries(ENGINE_STATS.map((st) => [st, row[st] || 0]))), { engines: n, src: "formula" });
      }
      const thrusterRows = {};
      for (const i of thrusters) {
        const row = movement(s, eng0, equipment[parts[i].id], 1);
        thrusterRows[i] = Object.assign(round3(Object.fromEntries(THRUSTER_STATS.map((st) => [st, row[st] || 0]))), { src: "formula" });
      }
      const cargo = Object.fromEntries(CARGO_TYPES.map((t) => [t, 0]));
      for (const [tags, amount] of Object.entries(s.cargo)) for (const t of CARGO_TYPES) if (tags.split(" ").includes(t)) cargo[t] += amount;
      const hangar = {};
      for (const h of s.hangar) { const key = h.docksize || "?"; hangar[key] = (hangar[key] || 0) + (h.capacity || 0); }
      outShips.push({ id: s.id, ware: s.w.ware, name: s.name || s.id, variation: s.variation, size: s.size, type: s.type,
        purpose: s.purpose, race: s.race, origin: s.src,
        page: { hull: s.hull, key: s.key },   // its wiki page: [submods/<mod>/]ships/<hull>/<key>
        threat: (s.threat = threatOf(s, sup.threatdefaults)),
        price: s.w.price || 0, owners: s.w.owners, licence: s.w.licence,
        blueprintable: s.w.blueprintable, hull: P(s, "hull.max"), crew: P(s, "people.capacity"), mass: P(s, "physics.mass"),
        cargo, drones: P(s, "storage.unit"), missiles: P(s, "storage.missile"), hangar,
        groups, engines: engineRows, thrusters: thrusterRows });
      if (det) det.ships[s.id] = shipDetail(s);
    }
    const sellers = new Set([...outShips, ...parts].flatMap((x) => x.owners));
    const facs = sup.factions || {};
    const factions = Object.fromEntries([...sellers].sort().map((f) => [f, (facs[f] && facs[f].name) || f]));
    const short = Object.fromEntries([...sellers].filter((f) => facs[f] && facs[f].short && facs[f].short !== factions[f]).map((f) => [f, facs[f].short]));
    const cal = sup.calibration || {};
    return {
      parts, ships: outShips, factions, faction_short: short,
      labels: sup.labels || { types: {}, purposes: {} },   // the game's names for ship types and purposes
      calibration: null,
      calibration_default: { probe: cal.probe || null, game_version: cal.game_version || null },
      meta: { generated: new Date().toISOString(), source: "wiki", game_version: cal.game_version ? String(cal.game_version) : null,
        mods: ["swi"].concat(mods), load_order: sources.map((s2) => ({ id: s2.id, name: s2.label, version: "" })),
        supplement: sup.generated || null, notes: { unknown_storage: [...notes.unknownStorage].sort(), ships_without_ware: notes.noWare,
          defined_twice: [...overridden].sort() } },
      // the ship pages also get the game's display names for ship types and purposes
      ...(det ? { details: det } : {}),
    };
  }

  // ---------------------------------------------------------------- browser source
  const CACHE_DB = "x4eval-wiki", CACHE_STORE = "data";
  function idb(mode, fn) {
    return new Promise((res) => {
      try {
        const open = indexedDB.open(CACHE_DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(CACHE_STORE);
        open.onerror = () => res(null);
        open.onsuccess = () => {
          try {
            const tx = open.result.transaction(CACHE_STORE, mode);
            const req = fn(tx.objectStore(CACHE_STORE));
            req.onsuccess = () => res(req.result || null);
            req.onerror = () => res(null);
          } catch (e) { res(null); }
        };
      } catch (e) { res(null); }
    });
  }
  function enabledMods() {
    try {
      const q = new URLSearchParams(location.search).get("mods");
      const list = q != null ? q.split(",") : JSON.parse(localStorage.getItem("x4wiki.mods") || "null");
      if (Array.isArray(list)) return list.filter((m) => m in MODS);
    } catch (e) { /* storage blocked */ }
    return [];                                        // default: SWI alone
  }
  function source() {
    return {
      name: "wiki",
      mods: Object.assign({ swi: "SW Interworlds" }, MODS),
      enabledMods,
      setMods(list) { try { localStorage.setItem("x4wiki.mods", JSON.stringify(list.filter((m) => m in MODS))); } catch (e) { /* ignore */ } },
      // Cached per mod set and supplement for a day; "fresh" skips the cache.
      async load(onProgress, fresh) {
        const mods = enabledMods();
        const day = new Date().toISOString().slice(0, 10);
        const key = mods.slice().sort().join(",") + "|" + day;
        if (!fresh) {
          const hit = await idb("readonly", (s) => s.get(key));
          if (hit && hit.parts) return hit;
        }
        const data = await build({ mods, onProgress, config: (typeof window !== "undefined" && window.X4WikiConfig) || {} });
        await idb("readwrite", (s) => s.put(data, key));
        return data;
      },
    };
  }

  return { MODS, CONFIG, build, assemble, flatten, sizeOf, cleanText, movementRaw, partRaw, source };
});
