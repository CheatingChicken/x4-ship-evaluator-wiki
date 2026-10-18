/* RATING PROFILES: every judgement the ranking makes, in one JSON object that players can save,
 * export, import and share. Measured game behaviour is not in here; only decisions are.
 *
 * A profile is stored SPARSE: only what differs from the built-in defaults. resolve() fills in
 * the rest, so a shared profile stays short and keeps working when a default changes.
 *
 *   { format: "x4-ship-evaluator/profile", version: 1, name, author, notes,
 *     roles: { trader|miner|combat: {
 *       weights: { metric: 0..5 },
 *       metrics: { metric: { curve: linear|sqrt|log|target, target, reference: list|size|fixed,
 *                            fixed, min, max } },          min/max: null = no limit
 *       slots:   { require: { shield, weapon, turret }, exclude: [use...], ban: [part id...] },
 *       purposes: [fight|trade|mine|other] } },            which ships the role ranks (combat)
 *     defence: { shield, regen, hull, pd, escape },           percentages, normalised to 100
 *     threats: { id: { defence, require: { shield, weapon, turret } } },
 *     trip:    { km, turn },
 *     maintenance: { empire } }                               SWI empire size, 0..5 (optimiser EMPIRE_LEVELS)
 *
 * Profiles come from strangers: normalise() keeps only known keys and clamps every number, and
 * nothing in a profile is ever executed. Text fields must still be escaped wherever they are
 * shown (app.js esc()).
 *
 * Loaded after optimiser.js in the page (window.X4Profile); require()-able in node. */
(function (root, factory) {
  const O = typeof module !== "undefined" && module.exports ? require("./optimiser.js") : root.X4Opt;
  const api = factory(O);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.X4Profile = api;
})(typeof self !== "undefined" ? self : this, function (O) {
  "use strict";

  const FORMAT = "x4-ship-evaluator/profile";
  const VERSION = 1;
  const MAX_BYTES = 64 * 1024;
  const CODE_PREFIX = "X4EP1:";
  const CURVES = ["linear", "sqrt", "log", "target"];
  const REFERENCES = ["list", "size", "fixed"];
  const KINDS = ["shield", "weapon", "turret"];
  // Part uses (x4cat/export.py part_use) a profile may exclude from loadouts.
  const USES = { launcher: "Missile, torpedo and bomb launchers", repair: "Repair lasers",
                 utility: "Tractor, scrap and other beams without real damage", mining: "Mining lasers and turrets" };
  const ROLE_IDS = Object.keys(O.ROLES);
  const PURPOSES = Object.keys(O.PURPOSE_GROUPS);
  const METRIC_KEYS = Object.keys(O.METRICS);

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  // Own keys only: a profile from a stranger may name a role or threat "__proto__", and a plain
  // lookup would then hand back Object.prototype to write into.
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const num = (v, lo, hi, dflt) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");

  // ---------------------------------------------------------------- defaults
  // Built from the optimiser's own tables, captured before any configure() call changes them.
  const DEFAULT_METRIC = { curve: "linear", target: 0, reference: "list", fixed: 0, min: null, max: null };
  function buildDefaults() {
    const roles = {};
    for (const r of ROLE_IDS) {
      const w = clone(O.ROLES[r].weights);
      roles[r] = {
        weights: w,
        metrics: Object.fromEntries(Object.keys(w).map((k) => [k, clone(DEFAULT_METRIC)])),
        slots: { require: { shield: false, weapon: false, turret: false }, exclude: [], ban: [] },
        purposes: r === "combat" ? O.DEFAULT_COMBAT_PURPOSES.slice() : [],
      };
    }
    const D = O.DEFAULTS;
    return {
      format: FORMAT, version: VERSION, name: "Default", author: "", notes: "",
      roles,
      defence: Object.fromEntries(Object.entries(D.defence).map(([k, v]) => [k, Math.round(v * 100)])),
      threats: clone(D.threats),
      trip: { km: (O.DEFAULT_TRIP || 50000) / 1000, turn: D.turn },
      maintenance: { empire: D.empire },
    };
  }
  const DEFAULTS = buildDefaults();

  // ---------------------------------------------------------------- normalise
  /* Any input (object, JSON text or share code) -> { profile: SPARSE and clean, warnings: [...] }.
   * Throws only for input that is not a profile at all. */
  function normalise(raw, knownParts) {
    const warnings = [];
    if (typeof raw === "string") raw = parseText(raw);
    if (!isObj(raw)) throw new Error("not a profile");
    if (JSON.stringify(raw).length > MAX_BYTES) throw new Error("profile larger than 64 KB");
    if (raw.format !== FORMAT) throw new Error("not an X4 ship evaluator profile (format \"" + text(String(raw.format || ""), 60) + "\")");
    if (num(raw.version, 0, 1e9, 0) > VERSION) warnings.push("made by a newer version of the evaluator; unknown settings were dropped");
    const full = resolveInto(clone(DEFAULTS), raw, warnings, knownParts);
    full.name = text(raw.name, 80) || "Imported profile";
    full.author = text(raw.author, 80);
    full.notes = text(raw.notes, 2000);
    return { profile: diff(full), warnings };
  }

  // Copies the valid parts of `src` (sparse or full) over `dst` (a full profile), in place.
  function resolveInto(dst, src, warnings, knownParts) {
    const warn = (m) => warnings && warnings.push(m);
    if (isObj(src.roles)) {
      for (const [r, sr] of Object.entries(src.roles)) {
        if (!own(dst.roles, r)) { warn("unknown role \"" + text(r, 30) + "\" ignored"); continue; }
        if (!isObj(sr)) continue;
        const dr = dst.roles[r];
        if (isObj(sr.weights)) {
          for (const [k, v] of Object.entries(sr.weights)) {
            if (!METRIC_KEYS.includes(k) || !own(O.METRICS, k)) { warn("unknown metric \"" + text(k, 30) + "\" ignored"); continue; }
            dr.weights[k] = num(v, 0, 5, dr.weights[k] || 0);
            if (!dr.metrics[k]) dr.metrics[k] = clone(DEFAULT_METRIC);
          }
        }
        if (isObj(sr.metrics)) {
          for (const [k, sm] of Object.entries(sr.metrics)) {
            if (!METRIC_KEYS.includes(k) || !isObj(sm)) continue;
            const dm = dr.metrics[k] = dr.metrics[k] || clone(DEFAULT_METRIC);
            if (!(k in dr.weights)) dr.weights[k] = 0;  // a rule on a metric the role did not list: show it
            if (CURVES.includes(sm.curve)) dm.curve = sm.curve;
            if (REFERENCES.includes(sm.reference)) dm.reference = sm.reference;
            if ("target" in sm) dm.target = num(sm.target, 0, 1e12, dm.target);
            if ("fixed" in sm) dm.fixed = num(sm.fixed, 0, 1e12, dm.fixed);
            for (const lim of ["min", "max"]) if (lim in sm) dm[lim] = sm[lim] === null ? null : num(sm[lim], -1e12, 1e12, dm[lim]);
          }
        }
        if (isObj(sr.slots)) {
          const ss = sr.slots, ds = dr.slots;
          if (isObj(ss.require)) for (const k of KINDS) if (k in ss.require) ds.require[k] = !!ss.require[k];
          // Sets, kept in a fixed order, so the same choice never reads as a difference.
          if (Array.isArray(ss.exclude)) ds.exclude = Object.keys(USES).filter((u) => ss.exclude.includes(u));
          if (Array.isArray(ss.ban)) {
            ds.ban = [...new Set(ss.ban.filter((id) => typeof id === "string" && /^[\w.-]{1,100}$/.test(id)))].slice(0, 1000);
            if (knownParts) {
              const missing = ds.ban.filter((id) => !knownParts.has(id));
              if (missing.length) warn(missing.length + " banned part(s) are not in your game data (kept, no effect): " + missing.slice(0, 5).join(", "));
            }
          }
        }
        if (Array.isArray(sr.purposes) && r === "combat") {
          const p = PURPOSES.filter((x) => sr.purposes.includes(x));
          if (p.length) dr.purposes = p; else warn("combat must include at least one ship purpose; default kept");
        }
      }
    }
    if (isObj(src.defence)) for (const k of Object.keys(dst.defence)) if (k in src.defence) dst.defence[k] = num(src.defence[k], 0, 100, dst.defence[k]);
    if (isObj(src.threats)) {
      for (const [t, st] of Object.entries(src.threats)) {
        if (!own(dst.threats, t) || !isObj(st)) continue;
        if ("defence" in st) dst.threats[t].defence = num(st.defence, 0, 10, dst.threats[t].defence);
        if (isObj(st.require)) for (const k of KINDS) if (k in st.require) dst.threats[t].require[k] = !!st.require[k];
      }
    }
    if (isObj(src.trip)) {
      if ("km" in src.trip) dst.trip.km = num(src.trip.km, 1, 1000, dst.trip.km);
      if ("turn" in src.trip) dst.trip.turn = num(src.trip.turn, 0, 180, dst.trip.turn);
    }
    if (isObj(src.maintenance) && "empire" in src.maintenance) {
      dst.maintenance.empire = Math.round(num(src.maintenance.empire, 0, O.EMPIRE_LEVELS.length - 1, dst.maintenance.empire));
    }
    return dst;
  }

  // ---------------------------------------------------------------- sparse <-> full
  // Sparse (trusted, already normalised) -> full.
  function resolve(sparse) {
    const full = resolveInto(clone(DEFAULTS), sparse || {});
    full.name = (sparse && sparse.name) || DEFAULTS.name;
    full.author = (sparse && sparse.author) || "";
    full.notes = (sparse && sparse.notes) || "";
    return full;
  }

  // Full -> sparse: only leaves that differ from the defaults; arrays whole.
  function diff(full) {
    const out = { format: FORMAT, version: VERSION, name: full.name || "", author: full.author || "", notes: full.notes || "" };
    const walk = (a, d) => {
      if (Array.isArray(a)) return JSON.stringify(a) === JSON.stringify(d) ? undefined : a.slice();
      if (isObj(a)) {
        const o = {};
        for (const k of Object.keys(a)) {
          const v = walk(a[k], isObj(d) ? d[k] : undefined);
          if (v !== undefined) o[k] = v;
        }
        return Object.keys(o).length ? o : undefined;
      }
      return a === d ? undefined : a;
    };
    for (const k of ["roles", "defence", "threats", "trip", "maintenance"]) {
      const v = walk(full[k], DEFAULTS[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  const same = (a, b) => JSON.stringify(diffBody(a)) === JSON.stringify(diffBody(b));
  const diffBody = (p) => { const d = diff(resolve(p)); delete d.name; delete d.author; delete d.notes; return d; };

  // ---------------------------------------------------------------- share code
  function toBase64Url(str) {
    const b64 = typeof Buffer !== "undefined" ? Buffer.from(str, "utf-8").toString("base64")
      : btoa(String.fromCharCode(...new TextEncoder().encode(str)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromBase64Url(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf-8");
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }
  const encode = (sparse) => CODE_PREFIX + toBase64Url(JSON.stringify(sparse));

  // Text a player pasted or a file's content: a share code or JSON.
  function parseText(s) {
    s = String(s).trim();
    if (s.length > MAX_BYTES * 2) throw new Error("profile larger than 64 KB");
    if (s.startsWith(CODE_PREFIX)) {
      const body = s.slice(CODE_PREFIX.length).replace(/\s+/g, "");
      if (!/^[A-Za-z0-9_-]*$/.test(body)) throw new Error("damaged share code");
      try { return JSON.parse(fromBase64Url(body)); } catch (e) { throw new Error("damaged share code"); }
    }
    try { return JSON.parse(s); } catch (e) { throw new Error("neither a share code nor profile JSON"); }
  }

  return { FORMAT, VERSION, CURVES, REFERENCES, USES, KINDS, DEFAULTS, DEFAULT_METRIC,
           normalise, resolve, diff, same, encode, parseText };
});
