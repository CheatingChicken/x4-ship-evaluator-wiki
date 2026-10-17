/* Evaluator page: filters, ranking table, loadout editor. All ranking logic is in optimiser.js. */
(function () {
  "use strict";
  /* BOOT. Some inputs arrive asynchronously, so the first run of this script only gathers them and
   * then runs the script again with them in place:
   *   - data: data.js (local edition); or, without it, a data source such as the wiki adapter
   *     (window.X4Source, wiki.js), loaded with a progress display; or else the first-run screen;
   *   - the player: player.js (imported by serve.py) or a save loaded in the browser (savereader.js,
   *     kept in IndexedDB), whichever save is newer. */
  if (!window.__x4ready) {
    const self = document.currentScript && document.currentScript.src;
    const runAgain = () => { window.__x4ready = true; const s = document.createElement("script"); s.src = self; document.body.appendChild(s); };
    (async () => {
      if (!window.X4DATA && window.X4Source) {
        const box = document.createElement("div");
        box.id = "boot";
        box.innerHTML = `<div class="boot-card"><b>Loading ship data from ${window.X4Source.label || (window.X4Source.name === "wiki" ? "the SWI wiki" : "the data source")}…</b>
          <div class="boot-bar"><span></span></div><p class="small muted" id="boot-line">Starting…</p></div>`;
        document.body.appendChild(box);
        const bar = box.querySelector(".boot-bar span"), line = box.querySelector("#boot-line");
        try {
          window.X4DATA = await window.X4Source.load((p) => {
            const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
            bar.style.width = pct + "%";
            line.textContent = `${p.phase}: ${p.done} of ${p.total} files`;
          });
          box.remove();
        } catch (e) {
          line.className = "small warn";
          line.textContent = "Could not load the data: " + e.message + ". Reload the page to try again.";
          return;
        }
      }
      if (!window.X4DATA) { window.X4Setup.firstRun(); return; }
      const stored = window.X4Save ? await window.X4Save.stored() : null;
      if (stored && (!window.X4PLAYER || String(stored.save.modified || "") >= String(window.X4PLAYER.save.modified || ""))) window.X4PLAYER = stored;
      runAgain();
    })();
    return;
  }
  const D = window.X4DATA, PL = window.X4PLAYER, O = window.X4Opt;
  const $ = (s) => document.querySelector(s);
  const STORE = "x4eval.v1";
  const SIZES = ["s", "m", "l", "xl"];

  /* SAVE EDITS. What the save import produced can be adjusted by hand (Settings → Save file →
   * Adjust): per faction its relation, licences, shipyard sizes and equipment dock. The edits are
   * kept apart from the import (st.saveEdits.factions[id], only the fields changed) and applied on
   * top of an untouched copy of it, in place on the X4PLAYER object, so a new import keeps them and
   * Reset brings the imported values back. Applied before anything reads the save. */
  const DOCK_MIN = -0.01;   // docks while the relation is above this (import_save.py)
  const PL_IMPORTED = PL ? JSON.parse(JSON.stringify(PL)) : null;
  function applySaveEdits(edits) {
    if (!PL) return;
    const base = JSON.parse(JSON.stringify(PL_IMPORTED));
    base.relations = base.relations || {}; base.access = base.access || {}; base.licences = base.licences || {}; base.galaxy = base.galaxy || {};
    for (const [f, e] of Object.entries((edits && edits.factions) || {})) {
      if (e.relation != null) {
        base.relations[f] = e.relation;
        base.access[f] = { relation: e.relation, dock: e.relation > DOCK_MIN };
      }
      if (Array.isArray(e.licences)) {
        for (const t of new Set([...Object.keys(base.licences), ...e.licences])) {
          base.licences[t] = (base.licences[t] || []).filter((x) => x !== f);
          if (e.licences.includes(t)) base.licences[t].push(f);
        }
      }
      if (Array.isArray(e.ships) || e.equipment != null) {
        const g = base.galaxy[f] = base.galaxy[f] || { stations: 0, ships: [], equipment: false };
        if (Array.isArray(e.ships)) g.ships = SIZES.filter((z) => e.ships.includes(z));
        if (e.equipment != null) g.equipment = !!e.equipment;
        if (g.ships.length || g.equipment) g.stations = Math.max(1, g.stations);
      }
    }
    for (const k of ["licences", "relations", "access", "galaxy"]) PL[k] = base[k];
  }
  let storedState = {};
  try { storedState = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (e) { /* private window */ }
  applySaveEdits(storedState.saveEdits);

  /* VANILLA FACTIONS. Under SW Interworlds the base game's factions still own wares but play no
   * part in the galaxy, so in SWI data they are hidden everywhere (switchable in Settings →
   * Display). A faction counts as vanilla when its id AND its name are the base game's: ids SWI
   * reused under a new name (khaak as the Yuuzhan Vong, xenon as "Unknown Threat") stay. The
   * player's own faction is never vanilla: it exists under every mod. */
  const VANILLA = { civilian: "Civilian", ownerless: "ownerless", alliance: "Alliance of the Word",
    antigone: "Antigone Republic", argon: "Argon Federation", boron: "Queendom of Boron", buccaneers: "Duke's Buccaneers",
    court: "Court of Curbs", fallensplit: "Fallen Families", freesplit: "Free Families", hatikvah: "Hatikvah Free League",
    holyorder: "Holy Order of the Pontifex", holyorderfanatic: "Holy Order Faithful", kaori: "Quettanauts",
    khaak: "Kha'ak", loanshark: "Vigor Syndicate", ministry: "Ministry of Finance", paranid: "Godrealm of the Paranid",
    pioneers: "Segaris Pioneers", scaleplate: "Scale Plate Pact", scavenger: "Riptide Rakers", split: "Zyarth Patriarchy",
    teladi: "Teladi Company", terran: "Terran Protectorate", trinity: "Realm of the Trinity", visitor: "Visitor",
    xenon: "Xenon", yaki: "Yaki" };
  const isSwi = (D.meta || {}).source === "wiki" || ((D.meta || {}).load_order || []).some((e) => /interworlds/i.test((e.name || "") + (e.id || "")));
  // The game's names for ship classes (types) and purposes, from the data (export.labels), with the
  // class's description from the game for tooltips; licence names from the shared table.
  const LABELS = D.labels || { types: {}, purposes: {} };
  const typeName = (t) => (t && LABELS.types[t] ? LABELS.types[t].name : t || "");
  const typeTip = (t) => (t && LABELS.types[t] && LABELS.types[t].description) || "";
  const licenceText = (l) => (l ? O.licenceName(l) + " licence" : "no licence");

  // Data from the wiki is always SWI: the base game's factions are always hidden there, no toggle.
  const wikiData = (D.meta || {}).source === "wiki";
  let hideVanilla = wikiData || !(storedState.display && storedState.display.hideVanilla === false);
  const vanilla = (f) => hideVanilla && isSwi && f in VANILLA && (D.factions[f] || f) === VANILLA[f];

  // ---------------------------------------------------------------- state
  const defaults = () => ({
    role: "trader", cargoType: { trader: "container", miner: "solid" }, sizes: [], types: [],
    threats: { trader: ["safe", "contested", "dangerous"], miner: ["safe", "contested", "dangerous"] },
    sourcing: ["single", "mixed"], bestOnly: false, focus: null, profiles: {}, profile: null,
    display: { showIds: false, shortFactions: true, hideVanilla: true }, compare: [], compareDiff: false,
    factions: defaultFactions(), useSave: !!PL, showAbsent: false, playerBuild: PL ? PL.blueprints.slice() : [],
    priceMin: 0, priceMax: 0, priceBasis: "hull", pins: {}, sort: [{ key: "score", asc: false }],
  });
  // With a save: the factions that own a shipyard or equipment dock in that galaxy AND will let
  // the player dock (import_save.py: relation above the 'enemy' range). Without one, every faction
  // the ware files name as a seller.
  const hostile = (f) => !!(PL && PL.access && PL.access[f] && !PL.access[f].dock);
  function defaultFactions() {
    if (PL && PL.galaxy) return Object.keys(D.factions).filter((f) => !vanilla(f) && PL.galaxy[f] && (PL.galaxy[f].ships.length || PL.galaxy[f].equipment) && !hostile(f));
    return Object.keys(D.factions).filter((f) => !vanilla(f));
  }
  const saveStamp = PL ? PL.save.file + "|" + PL.save.modified : null;
  let st = defaults();
  Object.assign(st, storedState);
  st.saveEdits = st.saveEdits && typeof st.saveEdits === "object" ? st.saveEdits : { factions: {} };
  st.saveEdits.factions = st.saveEdits.factions || {};
  // A newly imported save brings new reputations and shipyards: re-derive the faction defaults.
  if (saveStamp && st.saveStamp !== saveStamp) { st.factions = defaultFactions(); st.saveStamp = saveStamp; }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) { /* ignore */ } };
  st.display = Object.assign({ showIds: false, shortFactions: true, hideVanilla: true }, st.display);
  st.factions = (st.factions || []).filter((f) => !vanilla(f));
  st.compare = Array.isArray(st.compare) ? st.compare : [];
  // A picked ship the data no longer has (its submod switched off, a game update) would rank
  // nothing: drop the pick and go back to the role from before it.
  if (st.focus && !D.ships.some((x) => x.id === st.focus)) {
    st.focus = null;
    if (st.roleBeforeFocus) st.role = st.roleBeforeFocus;
  }
  if (!Array.isArray(st.sort)) st.sort = st.sort && st.sort.key ? [st.sort] : [{ key: "score", asc: false }];  // older single-key form
  delete st.threat;  // single-choice threat of an earlier version; now st.threats (several)
  // Ships without a type were once listed as the sub-role "null"; they are "" now.
  st.types = (Array.isArray(st.types) ? st.types : []).map((t) => (t === "null" || t == null ? "" : t));
  const hasThreats = () => !!O.ROLES[st.role].threats;
  // ---------------------------------------------------------------- rating profile
  /* Every rating decision lives in the active profile (profile.js): weights, curves, references,
   * limits, slot rules, combat purposes, defence split, threat rules, trip. st.profile holds the
   * working copy {source, data}: source is "preset:<id>" or "user:<id>" (st.profiles), data the
   * sparse profile in effect, edits included. PF is that profile resolved in full. */
  const P = window.X4Profile, PRESETS = (window.X4PRESETS || []).map((p) => ({ id: p.id, profile: P.normalise(p.profile).profile }));
  if (!PRESETS.some((p) => p.id === "default")) PRESETS.unshift({ id: "default", profile: P.diff(P.DEFAULTS) });
  const presetById = (id) => PRESETS.find((p) => p.id === id);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  st.profiles = st.profiles && typeof st.profiles === "object" && !Array.isArray(st.profiles) ? st.profiles : {};
  const migrating = !st.profile || !st.profile.data;
  if (migrating) migrateProfile();
  delete st.formula; delete st.weights; delete st.combatPurposes; delete st.tripKm;
  if (migrating) save();
  let PF = P.resolve(st.profile.data);

  // Settings from before profiles existed (weights, formulas, combat purposes, trip length)
  // become a saved profile "My settings", if they differ from the defaults at all.
  function migrateProfile() {
    const full = P.resolve({});
    for (const [r, w] of Object.entries(st.weights || {})) {
      if (full.roles[r] && w) for (const [k, v] of Object.entries(w)) if (k in O.METRICS) full.roles[r].weights[k] = v;
    }
    const f = st.formula || {};
    if (f.defence) Object.assign(full.defence, f.defence);
    for (const [t, c] of Object.entries(f.threats || {})) {
      if (full.threats[t] && c) full.threats[t] = { defence: c.defence, require: Object.assign({}, full.threats[t].require, c.require) };
    }
    if (f.turn != null) full.trip.turn = f.turn;
    if (Array.isArray(st.combatPurposes) && st.combatPurposes.length) full.roles.combat.purposes = st.combatPurposes.slice();
    if (st.tripKm) full.trip.km = st.tripKm;
    const data = P.normalise(Object.assign(P.diff(full), { name: "My settings", notes: "Your settings from before rating profiles." })).profile;
    if (!P.same(data, {})) {
      const id = newId();
      st.profiles[id] = data;
      st.profile = { source: "user:" + id, data: clone(data) };
    } else {
      st.profile = { source: "preset:default", data: clone(presetById("default").profile) };
    }
  }

  const sourceOf = () => { const [kind, id] = String(st.profile.source || "").split(":"); return { kind, id }; };
  const sourceProfile = () => { const s = sourceOf(); return s.kind === "user" ? st.profiles[s.id] : (presetById(s.id) || {}).profile; };
  const profileModified = () => { const src = sourceProfile(); return !src || !P.same(st.profile.data, src); };
  function applyProfile() { PF = P.resolve(st.profile.data); O.configure(PF); }
  // After an edit to PF: store it (sparse) as the working copy, rerank.
  function commitProfile() {
    st.profile.data = P.diff(PF);
    applyProfile();
    renderProfileState();
    changed(true);
  }
  function useProfile(source, data) {
    st.profile = { source, data: clone(data) };
    applyProfile();
    st.types = [];  // combat sub-role picks may refer to purposes the new profile excludes
    renderProfileState();
    changed(true);
  }
  // The active profile's weights for the role. Each threat profile sets its own defence weight
  // per row (optimiser.variants), so roles with threat profiles have no defence slider.
  const weights = () => PF.roles[st.role].weights;
  // selected: a result row's key. Kept in sessionStorage so an automatic reload (livereload.js)
  // reopens the same row; sessionStorage dies with the tab, so a new visit starts clean.
  const SEL = "x4eval.selected";
  let selected = null, last = { results: [] };
  try { selected = sessionStorage.getItem(SEL); } catch (e) { /* storage blocked */ }
  const select = (key) => { selected = key; try { key ? sessionStorage.setItem(SEL, key) : sessionStorage.removeItem(SEL); } catch (e) { /* ignore */ } };

  const fmt = (v, d) => (v == null || isNaN(v) ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d == null ? 0 : d }));
  const money = (v) => (v >= 1e6 ? fmt(v / 1e6, 2) + " M" : fmt(v / 1e3, 0) + " k");
  const shipLabel = (s) => s.name + (s.variation ? " " + s.variation : "");
  const factionName = (f) => D.factions[f] || f;
  // A faction as shown in the table and detail pane: the game's abbreviation when that setting is
  // on and one exists, with the full name (and any note) as tooltip; otherwise the full name.
  const factionShort = (f) => st.display.shortFactions && (D.faction_short || {})[f];
  const factionHtml = (f, note) => {
    const short = factionShort(f), tip = [short ? factionName(f) : "", note || ""].filter(Boolean).join(" · ");
    return `<span${tip ? ` title="${tip}"` : ""}${short ? ' class="abbr"' : ""}>${short || factionName(f)}</span>`;
  };

  function ctx() {
    return {
      role: st.role, cargoType: st.cargoType[st.role], sizes: new Set(st.sizes), types: new Set(st.types),
      factions: new Set(st.factions), useSave: st.useSave && !!PL, player: PL, playerBuild: new Set(st.playerBuild),
      // A picked ship sets the hull filters aside, the price range included.
      priceMin: st.focus ? 0 : st.priceMin * 1e6, priceMax: st.focus ? 0 : st.priceMax * 1e6, priceBasis: st.priceBasis,
      focus: st.focus,
      threats: hasThreats() ? st.threats[st.role] : [], sourcing: new Set(st.sourcing),
      tripDistance: PF.trip.km * 1000, combatPurposes: PF.roles.combat.purposes,
    };
  }

  // ---------------------------------------------------------------- header status
  function renderStatus() {
    const b = [];
    const m = D.meta || {};
    const from = m.source === "wiki" ? "SWI wiki" + ((m.mods || []).length > 1 ? " + " + m.mods.filter((x) => x !== "swi").join(", ").toUpperCase() : "") : "X4 " + (m.game_version || "?");
    b.push(`<span class="badge">${from} · ${D.ships.length} ships · ${D.parts.length} parts · data ${String(m.generated || "").slice(0, 10)}</span>`);
    b.push(PL ? `<span class="badge" title="${PL.save.file}${PL.save.loaded === "browser" ? " (loaded in this browser)" : ""}">save: ${PL.save.player || ""}, ${PL.save.modified ? PL.save.modified.slice(0, 16).replace("T", " ") : ""}</span>`
      : `<span class="badge warn" title="Settings → Save file: load a save so the ranking knows your licences, reputation and blueprints">no save loaded</span>`);
    $("#status").innerHTML = b.join("");
  }

  // ---------------------------------------------------------------- filters
  function seg(el, items, cur, onPick) {
    el.innerHTML = items.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? "on" : ""}">${l}</button>`).join("");
    el.onclick = (e) => { const v = e.target.dataset.v; if (v) onPick(v); };
  }

  // The sub-role multiselect is rebuilt on every change; this keeps it open, with its filter text,
  // across those rebuilds. A click anywhere else closes it.
  const typesUi = { open: false, q: "" };
  document.addEventListener("click", (e) => {
    const det = document.getElementById("types");
    if (det && det.open && !det.contains(e.target)) det.open = false;
  });

  function renderFilters() {
    seg($("#roles"), Object.entries(O.ROLES).map(([k, r]) => [k, r.label]), st.role, (v) => { st.role = v; select(null); changed(true); });
    const opts = $("#role-options");
    if (st.role === "trader" || st.role === "miner") {
      const types = st.role === "trader" ? [["container", "Container"], ["solid", "Solid"], ["liquid", "Liquid"]] : [["solid", "Ore (solid)"], ["liquid", "Gas (liquid)"]];
      const sel = st.threats[st.role];
      opts.innerHTML = `<div class="seg" id="cargo-type"></div><h2 class="sub">Threat profiles shown</h2>
        <div class="chips" id="threats">` + Object.entries(O.THREATS).map(([k, t]) =>
          `<button data-v="${k}" class="${sel.includes(k) ? "on" : ""}" title="${threatTip(t, k)}">${t.label}</button>`).join("") +
        `</div><p class="muted small">Each selected profile adds its own row for every ship. Hover over a profile to see its rules.</p>
        <h2 class="sub">Trip length</h2><div class="seg" id="trip"></div>
        <p class="muted small">Time for one leg from a standstill, including drive charge, turning onto course, acceleration, cruising and braking.
        On short legs, acceleration and turning matter most. On long legs, top speed matters most.</p>`;
      const kms = [...new Set([10, 25, 50, 100, 250, PF.trip.km])].sort((a, b) => a - b);
      seg($("#trip"), kms.map((k) => [String(k), k + " km"]), String(PF.trip.km), (v) => { PF.trip.km = +v; commitProfile(); });
      seg($("#cargo-type"), types, st.cargoType[st.role], (v) => { st.cargoType[st.role] = v; changed(true); });
      $("#threats").onclick = (e) => {
        const b = e.target.closest("button"); if (!b) return;
        toggle(sel, b.dataset.v);
        if (!sel.length) sel.push(b.dataset.v);  // never none: an empty list would show nothing
        changed(true);
      };
    } else {
      // Sub-roles: the classes (types) of the ships combat ranks, as a compact multiselect, by the
      // game's class names. Grouped by the size most of their ships have (S, M, L, XL), alphabetical
      // within a group; ships without a type are "(no class)", stored as "".
      const ORDER = ["xs", "s", "m", "l", "xl"];
      const counts = {}, bySize = {};
      D.ships.filter((s) => PF.roles.combat.purposes.includes(O.purposeGroup(s))).forEach((s) => {
        const t = s.type || "";
        counts[t] = (counts[t] || 0) + 1;
        (bySize[t] = bySize[t] || {})[s.size] = (bySize[t][s.size] || 0) + 1;
      });
      const home = (t) => Object.entries(bySize[t]).sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))[0][0];
      const label = (t) => (t ? typeName(t) : "(no class)");
      const groups = {};
      for (const t of Object.keys(counts)) (groups[home(t)] = groups[home(t)] || []).push(t);
      const sel = st.types.filter((t) => t in counts);
      const summary = sel.length ? sel.map(label).sort().join(", ") : "All combat ships";
      opts.innerHTML = `<details class="msel" id="types"${typesUi.open ? " open" : ""}>
          <summary title="${esc(summary)}"><span class="msel-label">${esc(summary)}</span>${sel.length ? `<span class="msel-count">${sel.length}/${Object.keys(counts).length}</span>` : ""}</summary>
          <div class="msel-panel">
            <div class="row nowrap"><input type="search" id="types-q" placeholder="Filter classes…" value="${esc(typesUi.q)}">
              <button type="button" id="types-clear"${sel.length ? "" : " disabled"}>Clear</button></div>
            ${ORDER.filter((z) => groups[z]).map((z) => `<div class="msel-group"><div class="msel-head">${z.toUpperCase()}</div>` +
              groups[z].sort((a, b) => label(a).localeCompare(label(b))).map((t) =>
                `<label class="check" data-name="${esc((label(t) + " " + t).toLowerCase())}" title="${esc(typeTip(t))}"><input type="checkbox" data-t="${esc(t)}"${sel.includes(t) ? " checked" : ""}> ${esc(label(t))}<span class="n">${counts[t]}</span></label>`).join("") +
              `</div>`).join("")}
          </div>
        </details>
        <p class="muted small">None selected = all combat ships.</p>`;
      const det = $("#types");
      const filterTypes = () => {
        const q = typesUi.q.trim().toLowerCase();
        det.querySelectorAll(".msel-group").forEach((g) => {
          let any = false;
          g.querySelectorAll("label").forEach((l) => { const hit = !q || l.dataset.name.includes(q); l.hidden = !hit; any = any || hit; });
          g.hidden = !any;
        });
      };
      filterTypes();
      det.ontoggle = () => { typesUi.open = det.open; if (det.open) $("#types-q").focus(); };
      det.onchange = (e) => { const t = e.target.dataset.t; if (t === undefined) return; toggle(st.types, t); changed(true); };
      $("#types-q").oninput = (e) => { typesUi.q = e.target.value; filterTypes(); };
      $("#types-clear").onclick = () => { st.types = []; changed(true); };
    }
    $("#sourcing").innerHTML = [["single", "Single shipyard"], ["mixed", "Mixed"]].map(([v, l]) =>
      `<button data-v="${v}" class="${st.sourcing.includes(v) ? "on" : ""}">${l}</button>`).join("");
    $("#sourcing").onclick = (e) => {
      const v = e.target.dataset.v; if (!v) return;
      toggle(st.sourcing, v);
      if (!st.sourcing.length) st.sourcing.push(v);
      changed(true);
    };
    $("#best-only").checked = st.bestOnly;
    $("#best-only").onchange = (e) => { st.bestOnly = e.target.checked; changed(); };
    $("#sizes").innerHTML = SIZES.map((s) => `<button data-v="${s}" class="${st.sizes.includes(s) ? "on" : ""}">${s.toUpperCase()}</button>`).join("");
    $("#sizes").onclick = (e) => { const v = e.target.dataset.v; if (v) { toggle(st.sizes, v); changed(true); } };
    renderPrice();
    seg($("#price-basis"), [["hull", "Hull price"], ["fitted", "Fitted price"]], st.priceBasis, (v) => { st.priceBasis = v; changed(true); });
    $("#use-save").checked = st.useSave && !!PL; $("#use-save").disabled = !PL;
    $("#use-save-wrap").hidden = !PL;
    $("#use-save").onchange = (e) => { st.useSave = e.target.checked; changed(true); };
    $("#licensed-btn").disabled = !PL;
    renderFactions(); renderWeights(); renderFocus(); renderProfileState();
    $("#build-count").textContent = `(${st.playerBuild.length})`;
  }

  // ---------------------------------------------------------------- price slider (log scale)
  // Hull prices span orders of magnitude, so the handles move on a log scale. The bounds are the
  // 1st and 99th percentile, not the extremes: one SWI superweapon hull costs 2 billion and would
  // spend half the track on nothing. Each end means "no limit" and is stored as 0, so anything
  // beyond the bounds is still reachable from the ends.
  const STEPS = 1000;
  const allPrices = D.ships.map((s) => s.price).filter((p) => p > 0).sort((a, b) => a - b);
  const pct = (q) => allPrices[Math.min(allPrices.length - 1, Math.floor(q * allPrices.length))];
  const P_LO = Math.pow(10, Math.floor(Math.log10(pct(0.01))));
  const P_HI = Math.pow(10, Math.ceil(Math.log10(pct(0.99))));
  const toPrice = (pos) => P_LO * Math.pow(P_HI / P_LO, pos / STEPS);
  const toPos = (price) => Math.round((STEPS * Math.log(price / P_LO)) / Math.log(P_HI / P_LO));
  const nice = (v) => { const e = Math.pow(10, Math.floor(Math.log10(v)) - 1); return Math.round(v / e) * e; }; // 2 significant digits

  function renderPrice() {
    const lo = $("#price-lo"), hi = $("#price-hi");
    lo.max = hi.max = STEPS;
    lo.value = st.priceMin > 0 ? toPos(st.priceMin * 1e6) : 0;
    hi.value = st.priceMax > 0 ? toPos(st.priceMax * 1e6) : STEPS;
    priceLabels();
  }
  function priceLabels() {
    $("#price-lo-label").textContent = st.priceMin > 0 ? money(st.priceMin * 1e6) : "any";
    $("#price-hi-label").textContent = st.priceMax > 0 ? money(st.priceMax * 1e6) : "no limit";
    const lo = +$("#price-lo").value, hi = +$("#price-hi").value;
    $("#price-fill").style.left = (100 * lo / STEPS) + "%";
    $("#price-fill").style.right = (100 - 100 * hi / STEPS) + "%";
  }
  function onPrice(e) {
    let lo = +$("#price-lo").value, hi = +$("#price-hi").value;
    if (lo > hi) { if (e.target.id === "price-lo") $("#price-lo").value = lo = hi; else $("#price-hi").value = hi = lo; }
    st.priceMin = lo <= 0 ? 0 : nice(toPrice(lo)) / 1e6;
    st.priceMax = hi >= STEPS ? 0 : nice(toPrice(hi)) / 1e6;
    priceLabels();
    changed();
  }

  // ---------------------------------------------------------------- single-ship mode
  const shipOption = (x) => `${shipLabel(x)} · ${[x.size.toUpperCase(), typeName(x.type)].filter(Boolean).join(" ")} (${x.id})`;

  function renderFocus() {
    $("#ship-list").innerHTML = D.ships.slice().sort((a, b) => shipLabel(a).localeCompare(shipLabel(b)))
      .map((x) => `<option value="${shipOption(x).replace(/"/g, "&quot;")}"></option>`).join("");
    const ship = st.focus && D.ships.find((x) => x.id === st.focus);
    $("#focus").value = ship ? shipOption(ship) : "";
    $("#focus-note").textContent = ship ? "Role, size and price filters are set aside; shipyards and licences still decide the parts." : "";
    document.body.classList.toggle("focus", !!ship);
  }

  // The role a ship is built for, and the cargo it carries, as the starting point for scoring it.
  function setFocus(id) {
    const ship = D.ships.find((x) => x.id === id);
    if (!ship) return;
    if (!st.focus) st.roleBeforeFocus = st.role;  // restored when the pick is cleared
    st.focus = id;
    st.role = ship.purpose === "trade" ? "trader" : ship.purpose === "mine" ? "miner" : "combat";
    if (st.role !== "combat") {
      const kinds = st.role === "trader" ? ["container", "solid", "liquid"] : ["solid", "liquid"];
      st.cargoType[st.role] = kinds.find((k) => ship.cargo[k] > 0) || kinds[0];
    }
    select(null);
    autoPick = true;   // the next ranking opens this ship's first row
    changed(true);
  }
  let autoPick = false;

  // Built from the live configuration, so an edited profile is described as it now is.
  // A threat profile's tooltip: its written description while the rating profile keeps the shipped
  // rules for it, else a sentence built from the rules the profile sets.
  function threatTip(t, k) {
    const d = O.DEFAULTS.threats[k], kinds = ["shield", "turret", "weapon"];
    if (t.tip && d && d.defence === t.defence && kinds.every((x) => !!(d.require || {})[x] === !!t.require[x])) return t.tip;
    const req = kinds.filter((x) => t.require[x]);
    const list = req.length > 1 ? req.slice(0, -1).join(", ") + " and " + req[req.length - 1] : req[0];
    return (req.length ? `Every ${list} slot is filled.` : "Slots may stay empty.") + ` Defence weight ${t.defence}.`;
  }

  // Table density: vertical padding of the result rows (style.css --row-pad).
  const DENSITIES = [["compact", "Compact"], ["normal", "Normal"], ["comfortable", "Comfortable"]];
  function applyDisplay() {
    document.body.classList.toggle("hide-ids", !st.display.showIds);
    for (const [d] of DENSITIES) document.body.classList.toggle("density-" + d, (st.display.density || "normal") === d);
  }

  // ---------------------------------------------------------------- settings dialog
  // Data actions go through serve.py; opened as a file, or behind another server, they are off.
  const api = async (path, body) => {
    const r = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.output || r.status + " " + r.statusText);
    return j;
  };
  let server = false;
  const serverControls = () => document.querySelectorAll("#settings .server-only button, #settings .server-only select, #settings .server-only input");

  async function renderSettings() {
    $("#opt-ids").checked = !!st.display.showIds;
    $("#opt-short").checked = !!st.display.shortFactions;
    $("#opt-vanilla").checked = hideVanilla;
    seg($("#opt-density"), DENSITIES, st.display.density || "normal", (v) => { st.display.density = v; applyDisplay(); save(); renderSettings(); });
    $("#opt-vanilla").closest("label").hidden = !isSwi || wikiData;
    renderSaveFile();
    renderWikiMods();
    // Game data (re-export from the game files) only works with the local server (serve.py), so
    // the section appears only when it answers, and never for data from a source such as the
    // wiki. Saves are read in the browser (Save file) in every edition.
    const hosted = (D.meta || {}).source === "wiki";
    let status = null;
    server = false;
    if (!hosted) { try { status = await api("/__status"); server = true; } catch (e) { server = false; } }
    document.querySelectorAll("#settings .server-only").forEach((x) => (x.hidden = !server));
    if (!server) return;
    serverControls().forEach((x) => (x.disabled = false));
    window.X4Setup.box($("#setup-box"), { after: "Re-export below to rebuild the data from it." });
    const meta = status.data || {};
    $("#data-current").textContent = `Built ${String(meta.generated || "?").replace("T", " ")} from X4 ${meta.game_version || "?"} with ${(meta.load_order || []).length} extensions.`;
    $("#load-order").innerHTML = (meta.load_order || []).map((e) => `<li>${e.name || e.id} <span class="muted">${e.version || ""}</span></li>`).join("");
    jobLine(status);
  }

  function jobLine(status) {
    const l = status.last;
    $("#job-status").textContent = status.job ? `Running: ${status.job}…`
      : l ? `Last: ${l.job} ${l.ok ? "succeeded" : "FAILED"} at ${String(l.at || "").replace("T", " ")}${l.ok ? "" : ": " + (l.output || []).slice(-1)[0]}` : "";
  }

  async function runAction(path, body, label) {
    $("#job-status").textContent = `Running: ${label}…`;
    serverControls().forEach((x) => (x.disabled = true));
    try {
      const r = await api(path, body);
      // The new file arrives through livereload.js, which reloads the page; this line shows
      // only if nothing changed on disk.
      $("#job-status").textContent = `${label}: done. ${r.output ? r.output.split("\n").slice(-1)[0] : ""}`;
    } catch (e) {
      $("#job-status").textContent = `${label} failed: ${e.message}`;
    } finally {
      serverControls().forEach((x) => (x.disabled = !server));
    }
  }


  // ---------------------------------------------------------------- save file (browser) and wiki mods
  // A save read in the browser (savereader.js): the file never leaves the computer; the result is
  // kept in IndexedDB and used from the next load on (app.js BOOT), so the page reloads after it.
  function renderSaveFile() {
    const sec = $("#savefile");
    if (!window.X4Save) { sec.hidden = true; return; }
    const edited = Object.keys(st.saveEdits.factions).length;
    $("#savefile-current").textContent = PL ? `In use: ${PL.save.file} · ${PL.save.player || "?"}, ${String(PL.save.modified || "").replace("T", " ")}${PL.save.loaded === "browser" ? " (loaded in this browser)" : " (imported by the local server)"}` +
      (edited ? ` · ${edited} faction${edited === 1 ? "" : "s"} adjusted by hand` : "") : "No save loaded.";
    $("#savefile-forget").hidden = !(PL && PL.save.loaded === "browser");
    $("#savefile-adjust").hidden = !PL;
  }
  // Reading a save: a bar with percent, MB read and time, from the compressed bytes consumed.
  async function loadSaveFile(file) {
    const msg = $("#savefile-msg"), bar = $("#savefile-progress");
    if (!file) return;
    if (!/\.xml(\.gz)?$/i.test(file.name)) { msg.className = "small warn"; msg.textContent = "Pick an X4 save: a .xml.gz (or .xml) file from your save folder."; return; }
    msg.className = "small";
    bar.hidden = false;
    const fill = bar.querySelector("span"), t0 = Date.now(), mb = (n) => (n / 1e6).toFixed(0);
    fill.style.width = "0%";
    try {
      const player = await window.X4Save.readFile(file, (p) => {
        const pct = Math.min(100, Math.round((100 * p.read) / p.total));
        fill.style.width = pct + "%";
        msg.textContent = `Reading ${file.name}: ${pct}% · ${mb(p.read)} of ${mb(p.total)} MB · ${Math.round((Date.now() - t0) / 1000)} s`;
      });
      fill.style.width = "100%";
      await window.X4Save.store(player);
      msg.textContent = `Read ${player.save.player || "the save"} in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${Object.keys(player.licences).length} licence types, ${player.blueprints.length} blueprints. Reloading…`;
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      bar.hidden = true;
      msg.className = "small warn";
      msg.textContent = "Could not read this save: " + e.message;
    }
  }

  // ---------------------------------------------------------------- save data editor
  // In-game relation scale: logarithmic, -30..+30 (-0.01 is -10, -1 is -30, 0.32 is +25).
  const relToUi = (r) => { const a = Math.abs(r || 0); return a < 0.001 ? 0 : Math.sign(r) * Math.round(10 * Math.log10(1000 * a)); };   // whole numbers, as the game shows
  const uiToRel = (u) => (u ? Math.sign(u) * Math.pow(10, Math.min(30, Math.abs(u)) / 10) / 1000 : 0);
  const LICENCE_LABEL = O.LICENCE_NAMES;   // the same names everywhere (optimiser.js)
  // The licences the data actually asks for, in a sensible order.
  const licenceTypes = () => {
    const used = new Set([...D.ships, ...D.parts].map((x) => x.licence).filter(Boolean));
    return Object.keys(LICENCE_LABEL).filter((t) => used.has(t)).concat([...used].filter((t) => !(t in LICENCE_LABEL)).sort());
  };
  const sdUi = { q: "", only: false };
  // A faction's values in the save in use (with edits), or in the untouched import.
  function factionNow(f, src) {
    src = src || PL;
    const a = (src.access || {})[f], g = (src.galaxy || {})[f];
    return { relation: a ? a.relation : (src.relations || {})[f] || 0, dock: a ? a.dock : true,
      licences: Object.keys(src.licences || {}).filter((t) => (src.licences[t] || []).includes(f)),
      ships: g ? g.ships.slice() : [], equipment: !!(g && g.equipment) };
  }
  function renderSaveData() {
    const lic = licenceTypes(), q = sdUi.q.trim().toLowerCase();
    const edits = st.saveEdits.factions;
    $("#sd-info").textContent = `${PL.save.file} · ${PL.save.player || "?"} · ${Object.keys(edits).length} faction(s) adjusted`;
    const ids = Object.keys(D.factions).filter((f) => !vanilla(f)).sort((a, b) => factionName(a).localeCompare(factionName(b)))
      .filter((f) => (!q || factionName(f).toLowerCase().includes(q) || f.includes(q)) && (!sdUi.only || edits[f]));
    $("#sd-table").innerHTML = `<thead><tr><th>Faction</th><th title="In-game scale -30 … +30">Relation</th><th>Docks</th>` +
      lic.map((t) => `<th class="sd-c" title="${esc(t)}">${esc(LICENCE_LABEL[t] || t)}</th>`).join("") +
      `<th class="sd-c sd-gap" title="Ship sizes its shipyards build">Shipyard</th><th class="sd-c" title="Has an equipment dock">Equip.</th><th></th></tr></thead><tbody>` +
      ids.map((f) => {
        const n = factionNow(f), e = edits[f] || {}, mark = (k) => (k in e ? " sd-edited" : "");
        return `<tr data-f="${esc(f)}" class="${edits[f] ? "edited" : ""}"><td>${esc(factionName(f))}</td>
          <td class="${mark("relation")}"><input type="number" data-k="relation" min="-30" max="30" step="any" value="${relToUi(n.relation)}"></td>
          <td>${n.dock ? `<span class="rel pos">✓</span>` : `<span class="rel neg" title="Hostile: will not dock you">✕</span>`}</td>` +
          lic.map((t) => `<td class="sd-c${mark("licences")}"><input type="checkbox" data-k="lic" data-t="${esc(t)}"${n.licences.includes(t) ? " checked" : ""}></td>`).join("") +
          `<td class="sd-c sd-gap${mark("ships")}"><span class="sd-sizes">${SIZES.map((z) => `<label title="${z.toUpperCase()} shipyard"><input type="checkbox" data-k="ship" data-z="${z}"${n.ships.includes(z) ? " checked" : ""}>${z.toUpperCase()}</label>`).join("")}</span></td>
          <td class="sd-c${mark("equipment")}"><input type="checkbox" data-k="equip"${n.equipment ? " checked" : ""}></td>
          <td>${edits[f] ? `<button type="button" data-reset="${esc(f)}" title="Back to the imported values">↺</button>` : ""}</td></tr>`;
      }).join("") + `</tbody>`;
  }
  // One field changed for one faction: store it as an edit (dropped again when it equals the import).
  function onSaveDataChange(e) {
    const tr = e.target.closest("tr[data-f]"), k = e.target.dataset.k;
    if (!tr || !k) return;
    const f = tr.dataset.f, n = factionNow(f), imported = factionNow(f, PL_IMPORTED);
    const ed = st.saveEdits.factions[f] = st.saveEdits.factions[f] || {};
    if (k === "relation") ed.relation = uiToRel(Math.max(-30, Math.min(30, Number(e.target.value) || 0)));
    else if (k === "lic") ed.licences = e.target.checked ? [...new Set(n.licences.concat(e.target.dataset.t))] : n.licences.filter((t) => t !== e.target.dataset.t);
    else if (k === "ship") ed.ships = e.target.checked ? SIZES.filter((z) => n.ships.includes(z) || z === e.target.dataset.z) : n.ships.filter((z) => z !== e.target.dataset.z);
    else if (k === "equip") ed.equipment = e.target.checked;
    // Drop fields that are back at the imported value, and the faction when nothing is left.
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if ("relation" in ed && Math.abs(relToUi(ed.relation) - relToUi(imported.relation)) < 0.05) delete ed.relation;
    if ("licences" in ed && same(ed.licences.slice().sort(), imported.licences.slice().sort())) delete ed.licences;
    if ("ships" in ed && same(ed.ships, imported.ships)) delete ed.ships;
    if ("equipment" in ed && ed.equipment === imported.equipment) delete ed.equipment;
    if (!Object.keys(ed).length) delete st.saveEdits.factions[f];
    applySaveEdits(st.saveEdits);
    renderSaveData();
    renderSaveFile();
    changed(true);
  }
  // Mods (data from a source such as the wiki or the published site): SWI always, submods by choice.
  // The data is loaded at start, so a change reloads the page.
  function renderWikiMods() {
    const sec = $("#wikimods"), src = window.X4Source;
    if (!src || (D.meta || {}).source !== "wiki") { sec.hidden = true; return; }
    sec.hidden = false;
    const on = src.enabledMods(), sizes = src.sizes || {};
    const what = (id) => { const z = sizes[id]; return z ? ` <span class="muted small">${z.ships} ships, ${z.parts} parts${z.bytes ? ", " + Math.round(z.bytes / 1024) + " KB" : ""}</span>` : ""; };
    $("#wikimods-list").innerHTML = Object.entries(src.mods).map(([id, label]) => id === "swi"
      ? `<label class="check"><input type="checkbox" checked disabled> ${esc(label)} <span class="muted small">(always)</span>${what(id)}</label>`
      : `<label class="check"><input type="checkbox" data-mod="${esc(id)}" ${on.includes(id) ? "checked" : ""}> ${esc(label)}${what(id)}</label>`).join("");
  }

  function wireSettings() {
    $("#settings-open").onclick = () => { renderSettings(); $("#settings").showModal(); };
    $("#savefile-input").onchange = (e) => { loadSaveFile(e.target.files[0]); e.target.value = ""; };
    const drop = $("#savefile");
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("drag"); };
    drop.ondragleave = () => drop.classList.remove("drag");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("drag"); loadSaveFile(e.dataTransfer.files[0]); };
    $("#savefile-forget").onclick = async () => { await window.X4Save.clear(); location.reload(); };
    $("#wikimods-list").onchange = (e) => {
      const list = [...document.querySelectorAll("#wikimods-list input[data-mod]:checked")].map((x) => x.dataset.mod);
      window.X4Source.setMods(list);
      $("#wikimods-msg").textContent = "Loading the data for this selection…";
      location.reload();
    };
    $("#opt-ids").onchange = (e) => { st.display.showIds = e.target.checked; applyDisplay(); save(); };
    $("#opt-short").onchange = (e) => { st.display.shortFactions = e.target.checked; save(); if (last) { renderTable(); renderDetail(); } };
    $("#opt-vanilla").onchange = (e) => {
      hideVanilla = st.display.hideVanilla = e.target.checked;
      if (hideVanilla) st.factions = st.factions.filter((f) => !vanilla(f));
      changed(true);
    };
    $("#savefile-adjust").onclick = () => { if (!PL) return; renderSaveData(); $("#savedata").showModal(); };
    $("#savedata").onchange = (e) => { if (e.target.id === "sd-only") { sdUi.only = e.target.checked; renderSaveData(); } else onSaveDataChange(e); };
    $("#sd-q").oninput = (e) => { sdUi.q = e.target.value; renderSaveData(); };
    $("#savedata").onclick = (e) => {
      const f = e.target.dataset && e.target.dataset.reset;
      if (f == null) return;
      delete st.saveEdits.factions[f];
      applySaveEdits(st.saveEdits); renderSaveData(); renderSaveFile(); changed(true);
    };
    $("#sd-reset-all").onclick = () => {
      st.saveEdits.factions = {};
      applySaveEdits(st.saveEdits); renderSaveData(); renderSaveFile(); changed(true);
    };
    // Server-only controls: the published site cuts their section from the page, so they may be absent.
    const exportBtn = $("#data-export");
    if (exportBtn) exportBtn.onclick = () => runAction("/__export", { all: $("#export-all").checked }, "Re-export");
    $("#pins-clear").onclick = () => { st.pins = {}; changed(); $("#job-status").textContent = "Pinned parts cleared."; };
    $("#all-reset").onclick = () => {
      if (!confirm("Reset every setting (factions, filters, pins, active profile) to defaults? Your saved rating profiles are kept.")) return;
      try { localStorage.setItem(STORE, JSON.stringify({ profiles: st.profiles })); sessionStorage.removeItem(SEL); } catch (e) { /* ignore */ }
      location.reload();
    };
  }

  function toggle(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

  function renderFactions() {
    const q = ($("#faction-search").value || "").toLowerCase();
    const sells = {};
    D.ships.forEach((s) => s.owners.forEach((f) => (sells[f] = (sells[f] || 0) + 1)));
    const G = PL && PL.galaxy;
    const ids = Object.keys(D.factions).filter((f) => !vanilla(f)).sort((a, b) => factionName(a).localeCompare(factionName(b)))
      .filter((f) => !q || factionName(f).toLowerCase().includes(q) || f.includes(q));
    const present = G ? ids.filter((f) => G[f]) : ids, absent = G ? ids.filter((f) => !G[f]) : [];
    const row = (f) => {
      const g = G && G[f];
      // Right column: the ship sizes its shipyards build (from the save), compact, with the meaning
      // in the tooltip; without a save, how many ships it sells.
      const [yard, yardTip] = g
        ? (g.ships.length ? [g.ships.join("/").toUpperCase(), "Shipyards build " + g.ships.join(", ").toUpperCase() + " ships" + (g.equipment ? "; sells equipment" : "")]
          : g.equipment ? ["equip.", "Equipment dock only, no shipyard"] : ["–", "No shipyard or equipment dock"])
        : [(sells[f] || 0) + " ships", "Ships this faction sells"];
      const a = PL && PL.access && PL.access[f];
      // The relation marker always takes its column (empty without a save) so names line up.
      const rel = a ? `<span class="rel ${a.dock ? (a.relation > 0.0099 ? "pos" : "") : "neg"}" title="relation ${a.relation >= 0 ? "+" : ""}${a.relation}${a.dock ? "" : ". Hostile: their stations will not dock you"}">${a.dock ? (a.relation > 0.0099 ? "▲" : "●") : "✕"}</span>` : `<span class="rel"></span>`;
      return `<label class="check frow ${hostile(f) ? "hostile" : ""}"><input type="checkbox" data-f="${f}" ${st.factions.includes(f) ? "checked" : ""}>${rel}<span class="fname">${factionName(f)}</span><span class="n" title="${yardTip}">${yard}</span></label>`;
    };
    $("#factions").innerHTML = present.map(row).join("") + (absent.length
      ? `<label class="check muted small"><input type="checkbox" id="show-absent" ${st.showAbsent ? "checked" : ""}> ${absent.length} not in your galaxy (no stations in the save)</label>` +
        (st.showAbsent ? absent.map(row).join("") : "")
      : "");
    const sa = $("#show-absent");
    if (sa) sa.onchange = (e) => { st.showAbsent = e.target.checked; save(); renderFactions(); };
    $("#faction-count").textContent = `(${st.factions.length} selected)`;
  }

  function renderWeights() {
    const w = weights();
    $("#weights").innerHTML = Object.keys(w).filter((k) => !(k === "defence" && hasThreats())).map((k) =>
      `<div class="weight"><span title="${O.METRICS[k].better > 0 ? "more is better" : "less is better"}">${O.METRICS[k].label}</span>
       <input type="range" min="0" max="5" step="1" value="${w[k]}" data-k="${k}"><output>${w[k]}</output></div>`).join("");
  }

  // ---------------------------------------------------------------- ranking
  let timer = null;
  function changed(rerenderFilters) {
    save();
    if (rerenderFilters) renderFilters();
    clearTimeout(timer);
    timer = setTimeout(run, 60);
  }

  function run() {
    const c = ctx();
    const list = O.shortlist(D, c);
    const r = O.rank(D, list, c, weights(), st.pins);
    r.results = O.applyFittedFloor(r.results, c);
    if (st.bestOnly && !st.focus) {
      const seen = new Set();
      r.results = r.results.filter((x) => !seen.has(x.ship.id) && seen.add(x.ship.id));  // already best-first
    }
    last = r;
    const ships = new Set(r.results.map((x) => x.ship.id)).size;
    if (st.focus) {
      const ship = D.ships.find((x) => x.id === st.focus);
      // Selected shipyards, with the focus lifted, decide whether the hull itself is on sale.
      const onSale = ship && O.sellerOk(ship, Object.assign({}, c, { focus: null }));
      $("#summary").textContent = ship ? `Fitting ${shipLabel(ship)}: ${r.results.length} distinct loadout${r.results.length === 1 ? "" : "s"}` +
        (onSale ? "" : ". None of the selected shipyards sells you this hull, but its parts can still be bought.") : "";
      // Picking a ship opens its first row once; a drawer the user closed stays closed after that.
      if (autoPick && r.results.length && !r.results.some((x) => x.key === selected)) select(r.results[0].key);
      autoPick = false;
    } else {
      $("#summary").textContent = `${r.results.length} loadouts of ${ships} ships` +
        (r.droppedByLimits ? ` · ${r.droppedByLimits} ship${r.droppedByLimits === 1 ? "" : "s"} could not meet the profile's limits` : "") +
        (list.length - ships - (r.droppedByLimits || 0) > 0 ? ` (${list.length - ships - (r.droppedByLimits || 0)} more could not be fitted from the selected shipyards or are outside the price range)` : "");
    }
    renderTable();
    renderDetail();
  }

  function columns() {
    // Metric columns sit together by group (Cargo & trade, Mobility, Offence, Defence, Capacity),
    // in the role's own order within a group.
    const order = (k) => O.METRIC_GROUPS.indexOf(O.METRICS[k].group);
    const metricCols = Object.keys(weights()).filter((k) => k !== "price")
      .map((k, i) => ({ k, i })).sort((a, b) => order(a.k) - order(b.k) || a.i - b.i)
      .map(({ k }) => ({ key: k, group: O.METRICS[k].group, label: O.METRICS[k].label,
                         get: (r) => O.METRICS[k].fn(r.metrics), fmt: (v) => fmt(v, v < 10 ? 2 : 0) }));
    return [
      { key: "rank", label: "#", group: "Ship", get: (r, i) => i + 1, fmt: (v) => v },
      { key: "cmp", label: "⇄", group: "Ship", cls: "cmp", get: (r) => (inCompare(r.ship, r.loadout) ? 1 : 0),
        fmt: (v) => `<button type="button" class="cmpbtn ${v ? "on" : ""}" data-cmp="1" title="${v ? "Remove from" : "Add to"} comparison">${v ? "✓" : "+"}</button>` },
      // The bar has a column of its own so every bar starts at the same edge; its length is
      // relative to the best score in the list.
      { key: "score", label: "", group: "Ship", cls: "barcol", get: (r) => r.score, fmt: (v) => `<span class="bar" style="width:${Math.max(2, 100 * v / topScore())}%"></span>` },
      { key: "score", label: "Score", group: "Ship", cls: "score", get: (r) => r.score,
        fmt: (v, r) => `<span title="Most points from: ${esc(topContrib(r))}">${fmt(v, 1)}</span>` },
      { key: "name", label: "Ship", group: "Ship", cls: "txt", get: (r) => shipLabel(r.ship), fmt: (v, r) => `${v} <span class="sub id">${r.ship.id}</span>` },
      { key: "size", label: "Size", group: "Ship", get: (r) => r.ship.size.toUpperCase(), fmt: (v) => v,
        sortv: (r) => ["xs", "s", "m", "l", "xl"].indexOf(r.ship.size) },  // by magnitude, not alphabet
      { key: "type", label: "Class", group: "Ship", cls: "txt", get: (r) => typeName(r.ship.type),
        fmt: (v, r) => `<span title="${esc(typeTip(r.ship.type))}">${esc(v)}</span>` },
    ].concat(hasThreats() ? [{ key: "threat", label: "Threat", group: "Ship", cls: "txt", get: (r) => threatLabel(r),
        fmt: (v, r) => `<span title="${memberScores(r)}">${v}</span>` }] : [], [
      { key: "source", label: "Equipment from", group: "Ship", cls: "txt", get: (r) => sourceLabel(r), fmt: (v, r) =>
        `${sourceCellHtml(r)}${r.mixedToo && v !== "Mixed" ? ` <span class="best" title="A search across all selected shipyards found this same loadout, so no other combination beats it.">★</span>` : ""}` },
      { key: "hull", label: "Hull price", group: "Price", get: (r) => r.ship.price, fmt: money },
      { key: "fitted", label: "Fitted", group: "Price", get: (r) => r.metrics.price, fmt: money },
    ]).concat(metricCols, [{ key: "sellers", label: "Sold by", group: "Market", cls: "txt sellers",
      get: (r) => sellers(r.ship).filter((x) => x.ok).map((x) => x.name).join(", "), fmt: (v, r) => sellersHtml(r.ship) }]);
  }

  // Every faction that owns the hull, those that will sell it to you first. "ok": the save says
  // they have a shipyard for its size, will dock you and have licensed you for it (without a save:
  // the faction is selected). Owners with no stations in the galaxy are only counted.
  function sellers(ship) {
    return ship.owners.filter((f) => !vanilla(f)).map((f) => {
      const why = O.buyBlockers(f, ship, PL);
      return { f, name: factionName(f), why: why || [], ok: why ? !why.length : st.factions.includes(f),
               absent: !!(PL && PL.galaxy && !PL.galaxy[f]) };
    }).sort((a, b) => b.ok - a.ok || a.name.localeCompare(b.name));
  }

  // One line per row (an ellipsis when it does not fit); the whole list is in the tooltip.
  function sellersHtml(ship) {
    const all = sellers(ship), shown = all.filter((x) => !x.absent), absent = all.length - shown.length;
    const yes = shown.filter((x) => x.ok).map((x) => x.name), no = shown.filter((x) => !x.ok).map((x) => x.name);
    const tip = [yes.length ? "Sells to you: " + yes.join(", ") : "", no.length ? "Won't: " + no.join(", ") : ""].filter(Boolean).join("\n");
    return `<div class="sellers-line" title="${esc(tip)}">` + sellersInner(all, shown, absent) + `</div>`;
  }
  function sellersInner(all, shown, absent) {
    return shown.map((x) => {
      const tip = x.ok ? "Will sell you this ship" + (st.factions.includes(x.f) ? "" : " (not among your selected factions)")
                       : x.why.length ? "Will not sell to you: " + x.why.join("; ") : "Not among your selected factions";
      const short = factionShort(x.f);
      return `<span class="seller ${x.ok ? "ok" : "no"}${x.ok && !st.factions.includes(x.f) ? " unsel" : ""}" title="${short ? x.name + ". " : ""}${tip}">${short || x.name}</span>`;
    }).join(", ") + (absent ? ` <span class="sub" title="${all.filter((x) => x.absent).map((x) => x.name).join(", ")}">+${absent} ${st.display.shortFactions ? "absent" : "without stations"}</span>` : "");
  }

  const topScore = () => Math.max(1, ...last.results.map((r) => r.score));
  // A merged row: the factions that sell every part (Mixed when only the mixed search found it),
  // and the threat profiles this one fit serves.
  const sourceLabel = (r) => { const f = r.sources.filter((x) => x !== "mixed"); return f.length ? f.map(factionName).join(" / ") : "Mixed"; };
  const sourceHtml = (r) => { const f = r.sources.filter((x) => x !== "mixed"); return f.length ? f.map((x) => factionHtml(x)).join(" / ") : "Mixed"; };
  // The table cell: up to three shipyards; beyond that the first two and a "+N more" chip whose
  // tooltip names the rest (the detail pane keeps the full list).
  const sourceCellHtml = (r) => {
    const f = r.sources.filter((x) => x !== "mixed");
    if (f.length <= 3) return sourceHtml(r);
    const rest = f.slice(2);
    return f.slice(0, 2).map((x) => factionHtml(x)).join(" / ") +
      ` <span class="more-chip" title="Also: ${esc(rest.map(factionName).join(", "))}">+${rest.length} more</span>`;
  };
  const threatLabel = (r) => r.threats.map((t) => O.THREATS[t].label).join(" · ");
  const memberScores = (r) => [...new Set(r.members.map((m) => m.threat))].map((t) =>
    `${O.THREATS[t] ? O.THREATS[t].label : ""} ${fmt(Math.max(...r.members.filter((m) => m.threat === t).map((m) => m.score)), 1)}`).join(", ");

  // SORTING: st.sort is a chain [{key, asc}, ...]; the first entry decides, later ones break ties,
  // and score breaks whatever ties remain. Click a header: sort by it alone (again: flip).
  // Shift+click: add it to the chain (again: flip it). The sort bar shows and edits the chain.
  const sortChain = () => (Array.isArray(st.sort) && st.sort.length ? st.sort : [{ key: "score", asc: false }]);

  function onHeaderClick(key, add) {
    let chain = sortChain().slice();
    const at = chain.findIndex((x) => x.key === key);
    if (!add) {
      chain = [{ key, asc: at === 0 && chain.length === 1 ? !chain[0].asc : false }];
    } else if (at >= 0) {
      chain[at] = { key, asc: !chain[at].asc };
    } else {
      chain.push({ key, asc: false });
    }
    st.sort = chain;
    save();
    renderTable();
  }

  function renderSortBar(cols) {
    const label = (k) => (cols.find((c) => c.key === k && c.cls !== "barcol") || { label: k }).label || k;
    $("#sortbar").innerHTML = "Sort: " + sortChain().map((x, i) =>
      `${i ? '<span class="muted">then</span> ' : ""}<span class="chip" data-i="${i}" title="Click to flip direction">${label(x.key)} ${x.asc ? "▴" : "▾"}` +
      `${sortChain().length > 1 ? ` <button type="button" data-rm="${i}" title="Remove">×</button>` : ""}</span>`).join(" ") +
      ` <span class="muted small">Shift+click a column header to add a tie-breaker.</span>`;
  }

  function renderTable() {
    const cols = columns();
    const chain = sortChain().map((x) => ({ x, i: cols.findIndex((c) => c.key === x.key && c.cls !== "barcol") }))
      .filter((s) => s.i >= 0 && cols[s.i].key !== "rank");
    const scoreAt = cols.findIndex((c) => c.cls === "score");
    const rows = last.results.map((r, i) => ({ r, v: cols.map((c) => c.get(r, i)), sv: cols.map((c) => (c.sortv ? c.sortv(r) : null)) }));
    const cmp = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
    rows.sort((a, b) => {
      for (const { x, i } of chain) {
        const d = (cols[i].sortv ? cmp(a.sv[i], b.sv[i]) : cmp(a.v[i], b.v[i])) * (x.asc ? 1 : -1);
        if (d) return d;
      }
      return cmp(b.v[scoreAt], a.v[scoreAt]);
    });
    const pos = Object.fromEntries(chain.map(({ x }, n) => [x.key, { n: n + 1, asc: x.asc }]));
    // Group row: one cell per run of adjacent columns with the same group.
    const runs = [];
    cols.forEach((c) => {
      const last = runs[runs.length - 1];
      if (last && last.group === c.group) last.span++;
      else runs.push({ group: c.group, span: 1 });
    });
    $("#table thead").innerHTML = "<tr class=\"groups\">" + runs.map((g) =>
      `<th colspan="${g.span}" class="grp">${g.group || ""}</th>`).join("") + "</tr><tr class=\"cols\">" + cols.map((c, i) => {
      const p = c.cls !== "barcol" && pos[c.key];
      const first = i === 0 || cols[i - 1].group !== c.group;  // a divider where a group starts
      return `<th data-k="${c.key}" class="${[c.cls || "", p ? "sorted" + (p.asc ? " asc" : "") : "", first ? "gstart" : ""].join(" ")}">${c.label}${p && chain.length > 1 ? `<sup>${p.n}</sup>` : ""}</th>`;
    }).join("") + "</tr>";
    $("#table tbody").innerHTML = rows.map(({ r, v }) => `<tr data-id="${r.key}" class="${r.key === selected ? "sel" : ""}">` +
      cols.map((c, i) => `<td class="${[c.cls || "", i && cols[i - 1].group !== c.group ? "gstart" : ""].join(" ")}">${c.fmt(v[i], r)}</td>`).join("") + "</tr>").join("");
    renderSortBar(cols);
    renderCompareBar();
  }

  // ---------------------------------------------------------------- detail / loadout editor
  // Some part names already carry their mark ("L All-round Thrusters Mk1"); do not add it twice.
  const partName = (p) => (p.mk && !/\bmk\s*\d/i.test(p.name) ? `${p.name} Mk${p.mk}` : p.name);

  function partLabel(p, ship, kind) {
    const s = p.stats;
    let stat = "";
    if (kind === "engine") { const e = ship.engines[D.parts.indexOf(p)]; stat = e ? `${fmt(e.ForwardSpeed)} m/s · travel ${fmt(e.TravelSpeed)}` : ""; }
    else if (kind === "thruster") { const t = ship.thrusters[D.parts.indexOf(p)]; stat = t ? `yaw ${fmt(t.YawSpeed * 180 / Math.PI, 1)}°/s` : ""; }
    else if (kind === "shield") stat = `${fmt(s.ShieldValue)} cap · ${fmt(s.ShieldRate)}/s`;
    else if (p.mining) stat = `mining ${fmt(s.MiningRate, 1)}`;
    else if (kind === "turret") stat = `${fmt(s.TurretSustainedDPS, 1)} dps`;
    else stat = `${fmt(s.SustainedDPS, 1)} dps`;
    return `${partName(p)} · ${stat} · ${money(p.price)}`;
  }

  // The drawer's figures, per table-header group (optimiser METRIC_GROUPS), most telling first.
  const DRAWER_ORDER = {
    "Cargo & trade": ["cargo", "throughput", "efficiency", "miningRate", "drones"],
    Mobility: ["maxSpeed", "boostSpeed", "travelSpeed", "acceleration", "chargeTime", "turnRate", "turnTime", "tripTime"],
    Offence: ["forwardDps", "burstDps", "turretDps", "missiles"],
    Defence: ["defence", "toughness", "shield", "shieldRegen", "hull"],
    Capacity: ["hangar", "crew"],
  };
  // Close the drawer: × in it, Escape, or a click on the selected row.
  function closeDetail() { select(null); renderTable(); renderDetail(); }

  function renderDetail() {
    const el = $("#detail");
    const r = last.results.find((x) => x.key === selected);
    // The drawer only takes room while a loadout is selected.
    document.body.classList.toggle("no-detail", !r);
    if (!r) { el.innerHTML = ""; return; }
    const s = r.ship, m = r.metrics, lo = r.loadout;
    const cand = O.candidates(D, s, r.ctx);  // this row's shipyard(s) and threat rules
    const pins = st.pins[r.key] || {};
    const metricRow = (k) => {
      const M = O.METRICS[k], v = M && M.fn(m);
      return v ? `<tr><td>${M.label}</td><td>${fmt(v, v < 10 ? 2 : 0)} ${M.unit}</td></tr>` : "";
    };
    // grouped as in the table header, in DRAWER_ORDER within each group (other metrics of a group last)
    const metricGroups = O.METRIC_GROUPS.map((g) => {
      const order = (DRAWER_ORDER[g] || []).filter((k) => O.METRICS[k]);
      const keys = order.concat(Object.keys(O.METRICS).filter((k) => O.METRICS[k].group === g && !order.includes(k)));
      const rows = keys.map(metricRow).join("");
      return rows ? `<tr class="grp"><th colspan="2">${g}</th></tr>${rows}` : "";
    }).join("");
    // Defence breakdown: each part against the best reachable in this size class.
    const refs = last.defenceRefs && last.defenceRefs[s.size];
    const parts = O.defenceParts(m);
    const defenceRows = refs ? O.DEFENCE_PARTS.map((d) => {
      const pct = refs[d.key] > 0 ? Math.min(100, (100 * parts[d.key]) / refs[d.key]) : 0;
      return `<tr><td>${d.label} <span class="sub">${Math.round(d.weight * 100)}%</span></td><td><span class="bar" style="width:${Math.max(1, pct * 0.6)}px"></span> ${fmt(pct)}% <span class="sub">of ${fmt(refs[d.key])}</span></td></tr>`;
    }).join("") : "";
    const select = (key, label, list, cur, kind, pinned, allowEmpty) => {
      const options = [`<option value="auto">Auto (optimiser)</option>`]
        .concat(allowEmpty ? [`<option value="none" ${pinned && cur === null ? "selected" : ""}>(empty)</option>`] : [])
        .concat(list.filter((i) => i !== null).map((i) => `<option value="${i}" ${pinned && cur === i ? "selected" : ""}>${partLabel(D.parts[i], s, kind)}</option>`));
      const shown = !pinned ? (cur === null ? "(empty)" : partLabel(D.parts[cur], s, kind)) : "";
      return `<div class="slot"><label>${label}</label><div><select data-key="${key}" class="${pinned ? "pinned" : ""}">${options.join("")}</select>
        ${!pinned ? `<div class="src">auto: ${shown}</div>` : ""}</div></div>`;
    };
    const eng = s.engines[lo.engine] || {};
    let slots = select("engine", `Engines ×${eng.engines || ""}`, cand.engines, lo.engine, "engine", pins.engine != null, false);
    if (cand.thrusters.length) slots += select("thruster", "Thrusters", cand.thrusters, lo.thruster, "thruster", pins.thruster != null, false);
    s.groups.forEach((g, i) => {
      if (g.kind === "engine") return;
      const pinned = pins.groups && i in pins.groups;
      slots += select("g" + i, `${g.kind} ${(g.size || "?").toUpperCase()} ×${g.count}${g.mining ? " ⛏" : ""}`, cand.groups[i], lo.groups[i], g.kind, pinned, true);
    });
    // Wiki data knows each ship's wiki page ([submods/<mod>/]ships/<hull>/<key>), which the site's
    // ship pages (and the wiki itself) serve beside this page.
    const page = s.page && s.page.key ? `${s.origin && s.origin !== "swi" ? `submods/${s.origin}/` : ""}ships/${s.page.hull}/${s.page.key}` : "";
    el.innerHTML = `<div class="dhead"><h3>${shipLabel(s)}</h3><button type="button" id="detail-close" title="Close (Esc)" aria-label="Close">×</button></div>
      ${page ? `<div class="small"><a href="./${esc(page)}" target="_blank" rel="noopener">Ship page ↗</a></div>` : ""}
      <div class="muted small">${[`<span class="id">${s.id}</span>`, (s.size.toUpperCase() + " " + typeName(s.type)).trim(), s.race, s.origin, licenceText(s.licence)].filter(Boolean).join(" · ")}</div>
      <div class="muted small">Sold by: ${s.owners.map((f) => factionHtml(f)).join(", ")}</div>
      <div class="small">${r.threats.length ? `<b>${threatLabel(r)}</b> · ` : ""}equipment from <b>${sourceHtml(r)}</b>${r.mixedToo && sourceLabel(r) !== "Mixed" ? " · ★ best across all shipyards" : ""}</div>
      ${r.threats.length > 1 ? `<div class="muted small">Score per profile: ${memberScores(r)}</div>` : ""}
      ${breakdownHtml(r)}
      <table class="figures"><tr class="grp"><th colspan="2">Overview</th></tr><tr><td>Score</td><td>${fmt(r.score, 1)}</td></tr>
        <tr><td>Hull price</td><td>${money(s.price)}</td></tr>${metricRow("price")}${metricGroups}</table>
      ${defenceRows ? `<h2>Defence <span class="muted">vs. best of ${refs.ships} ${s.size.toUpperCase()} ship${refs.ships === 1 ? " (itself)" : "s"} in this list</span></h2><table>${defenceRows}</table>` : ""}
      ${m.trip && isFinite(m.trip.total) ? `<h2>Trip <span class="muted">${PF.trip.km} km leg</span></h2><table>
        <tr><td>Travel drive charge</td><td>${fmt(m.trip.charge, 1)} s</td></tr>
        <tr><td>Turn 90° onto course</td><td>${fmt(m.trip.turn, 1)} s <span class="sub">${fmt(m.turnRate, 1)}°/s</span></td></tr>
        <tr><td>Travel</td><td>${fmt(m.trip.move, 1)} s <span class="sub">${m.trip.reachesTop ? "reaches" : "never reaches"} ${fmt(m.travelSpeed)} m/s</span></td></tr>
        <tr><td><b>Total</b></td><td><b>${fmt(m.trip.total, 1)} s</b> <span class="sub">${fmt((60 * m.cargo) / m.trip.total)} m³/min</span></td></tr>
      </table><p class="src">Turn acceleration and travel deceleration are formula values the game does not report; the rest is measured.</p>` : ""}
      <h2>Loadout</h2>${slots}
      <div class="row"><button id="unpin">Reset to auto</button><button id="copy">Copy loadout</button><button id="cmp-toggle">${inCompare(s, lo) ? "✓ In comparison" : "+ Add to comparison"}</button></div>
      <div class="src">Movement: ${eng.src === "game" ? "measured in game" : "formula"} · DPS/shields: per part, see tooltips in the list</div>`;
    el.querySelectorAll("select").forEach((sel) => (sel.onchange = () => {
      const key = sel.dataset.key, v = sel.value;
      const p = st.pins[r.key] = st.pins[r.key] || {};
      const val = v === "auto" ? undefined : v === "none" ? null : +v;
      if (key === "engine" || key === "thruster") { if (val === undefined) delete p[key]; else p[key] = val; }
      else { p.groups = p.groups || {}; const gi = +key.slice(1); if (val === undefined) delete p.groups[gi]; else p.groups[gi] = val; }
      changed();
    }));
    $("#detail-close").onclick = closeDetail;
    $("#unpin").onclick = () => { delete st.pins[r.key]; changed(); };
    $("#cmp-toggle").onclick = () => toggleCompare(r);
    $("#copy").onclick = () => {
      const lines = [shipLabel(s) + " (" + s.id + ")", "Engines: " + D.parts[lo.engine].name + " ×" + (eng.engines || "")];
      if (lo.thruster != null) lines.push("Thrusters: " + D.parts[lo.thruster].name);
      s.groups.forEach((g, i) => { if (g.kind !== "engine" && lo.groups[i] != null) lines.push(`${g.kind} ${g.size || ""} ×${g.count}: ${D.parts[lo.groups[i]].name}`); });
      lines.push("Fitted price: " + money(m.price));
      navigator.clipboard && navigator.clipboard.writeText(lines.join("\n"));
    };
  }

  // ---------------------------------------------------------------- comparison
  /* A DESIGN is a hull plus its exact loadout, stored by part id (not by index into D.parts), so it
   * survives filter changes, reloads and a re-export. The comparison re-evaluates every design
   * under the CURRENT trip length, cargo type and defence references, so the columns are measured
   * alike; the score is only shown where the same fit is in the current list. */
  const partIdx = () => (partIdx.map = partIdx.map || new Map(D.parts.map((p, i) => [p.id, i])));
  const pid = (i) => (i == null ? null : D.parts[i].id);
  const designOf = (ship, lo) => {
    const d = { ship: ship.id, engine: pid(lo.engine), thruster: pid(lo.thruster), groups: lo.groups.map((i) => pid(i)) };
    d.id = JSON.stringify([d.ship, d.engine, d.thruster, d.groups]);
    return d;
  };
  const inCompare = (ship, lo) => st.compare.some((d) => d.id === designOf(ship, lo).id);
  // "R-41 Starchaser #2" when the same hull is in the comparison more than once.
  const designName = (d) => {
    const s = D.ships.find((x) => x.id === d.ship), same = st.compare.filter((x) => x.ship === d.ship);
    return (s ? shipLabel(s) : d.ship) + (same.length > 1 ? " #" + (same.indexOf(d) + 1) : "");
  };

  function toggleCompare(r, lo) {
    const d = designOf(r.ship, lo || r.loadout);
    const at = st.compare.findIndex((x) => x.id === d.id);
    if (at >= 0) st.compare.splice(at, 1);
    else st.compare.push(Object.assign(d, { threats: r.threats.slice(), sources: r.sources.slice() }));
    save();
    renderTable();
    renderDetail();
  }

  // Where a design's parts come from and which threat profiles it served, as text (tooltips) or
  // HTML (abbreviated faction names when that setting is on). Designs saved before this kept a
  // ready-made "from" string instead.
  const designFromText = (d) => d.sources ? [(d.threats || []).map((t) => (O.THREATS[t] || {}).label).filter(Boolean).join(" · "),
    sourceLabel({ sources: d.sources })].filter(Boolean).join(" · ") : d.from || "";
  const designFromHtml = (d) => {
    if (!d.sources) return d.from || "";
    const threats = (d.threats || []).map((t) => (O.THREATS[t] || {}).label).filter(Boolean).join(" · ");
    const f = d.sources.filter((x) => x !== "mixed");
    // Full names: two, then "+N more" (all of them in the tooltip). Abbreviations are short enough
    // to list in full.
    const src = !st.display.shortFactions && f.length > 3
      ? f.slice(0, 2).map((x) => factionHtml(x)).join(" / ") + ` <span class="more" title="${f.map(factionName).join(", ")}">+${f.length - 2} more</span>`
      : sourceHtml({ sources: d.sources });
    return (threats ? `<div>${threats}</div>` : "") + `<div>${src}</div>`;
  };

  // The design back on today's data: {ship, lo, missing} or null when the hull is gone.
  function resolve(d) {
    const ship = D.ships.find((s) => s.id === d.ship);
    if (!ship) return null;
    const ix = partIdx(), missing = [];
    const at = (id) => { if (id == null) return null; if (!ix.has(id)) { missing.push(id); return null; } return ix.get(id); };
    const lo = { engine: at(d.engine), thruster: at(d.thruster), groups: ship.groups.map((g, i) => at(d.groups[i])) };
    return { ship, lo, missing };
  }

  function renderCompareBar() {
    const bar = $("#comparebar");
    if (!st.compare.length) { bar.innerHTML = ""; bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `Compare: ` + st.compare.map((d, i) => {
      return `<span class="chip" title="${designFromText(d)}">${designName(d)} <button type="button" data-cmp-rm="${i}" title="Remove">×</button></span>`;
    }).join(" ") + ` <button type="button" id="compare-open" ${st.compare.length < 2 ? "disabled title=\"Add at least two designs\"" : ""}>Compare ${st.compare.length} ▸</button>` +
      ` <button type="button" id="compare-clear">Clear</button>`;
  }

  // Parts of one kind in a design, as "2× M Shield Mk2, 4× S Shield Mk1".
  function partsOf(ship, lo, kind) {
    const n = new Map();
    const add = (i, c) => { if (i == null) return; const k = partName(D.parts[i]); n.set(k, (n.get(k) || 0) + c); };
    if (kind === "engine") add(lo.engine, (ship.engines[lo.engine] || {}).engines || 1);
    else if (kind === "thruster") add(lo.thruster, 1);
    else ship.groups.forEach((g, i) => { if (g.kind === kind) add(lo.groups[i], g.count); });
    const empty = kind !== "engine" && kind !== "thruster" ? ship.groups.filter((g, i) => g.kind === kind && lo.groups[i] == null).reduce((a, g) => a + g.count, 0) : 0;
    return [...n].map(([k, c]) => `${c}× ${k}`).concat(empty ? [`<span class="muted">${empty} empty</span>`] : []).join("<br>") || `<span class="muted">–</span>`;
  }

  function renderCompare() {
    const c = Object.assign(ctx(), { defenceRefs: last.defenceRefs });
    const cols = st.compare.map((d) => {
      const r = resolve(d);
      if (!r) return { d, gone: true };
      const m = O.evaluate(D, r.ship, r.lo, c);
      const row = last.results.find((x) => x.ship.id === d.ship && designOf(x.ship, x.loadout).id === d.id);
      return Object.assign(r, { d, m, score: row ? row.score : null });
    });
    const live = cols.filter((x) => !x.gone), base = live[0];
    const pct = (v, b) => (b ? (100 * (v - b)) / Math.abs(b) : null);
    // One metric row: best value marked, difference against the baseline (first) column.
    // abs: show the difference itself rather than a percentage (score points share one scale,
    // and a percentage of a near-zero baseline is meaningless).
    const metricRow = (label, get, better, f, unit, abs) => {
      const vals = cols.map((x) => (x.gone ? null : get(x)));
      const real = vals.filter((v) => v != null && isFinite(v) && v !== 0);
      if (!real.length) return "";
      if (st.compareDiff && real.length === vals.length && real.every((v) => Math.abs(v - real[0]) < 1e-9)) return "";  // identical everywhere
      const same = real.every((v) => Math.abs(v - real[0]) < 1e-9);
      const best = same ? null : better > 0 ? Math.max(...real) : Math.min(...real);
      const bv = base ? get(base) : null;
      return `<tr><th>${label}${unit ? ` <span class="sub">${unit}</span>` : ""}</th>` + cols.map((x, i) => {
        const v = vals[i];
        if (v == null || !isFinite(v)) return `<td class="muted">–</td>`;
        const p = x === base ? null : abs ? (bv != null ? v - bv : null) : bv ? pct(v, bv) : null;
        const good = p != null && Math.abs(p) >= (abs ? 0.05 : 0.5) ? (p * better > 0 ? "pos" : "neg") : "";
        const label = abs ? fmt(p, 1) : fmt(p, Math.abs(p) < 10 ? 1 : 0) + "%";
        return `<td class="${v === best ? "best-v" : ""}"><span class="v">${f(v)}</span><span class="delta ${good}">${good ? `${p > 0 ? "+" : ""}${label}` : ""}</span></td>`;
      }).join("") + "</tr>";
    };
    const groupRow = (g) => `<tr class="cgroup"><th colspan="${cols.length + 1}">${g}</th></tr>`;
    const num = (v) => fmt(v, v < 10 ? 2 : 0);
    let body = groupRow("Price") +
      metricRow("Score in current list", (x) => x.score, +1, (v) => fmt(v, 1), "") +
      metricRow("Hull price", (x) => x.ship.price, -1, money, "") +
      metricRow("Fitted price", (x) => x.m.price, -1, money, "");
    for (const g of O.METRIC_GROUPS) {
      const rows = Object.entries(O.METRICS).filter(([k, M]) => M.group === g && k !== "price")
        .map(([k, M]) => metricRow(M.label, (x) => M.fn(x.m), M.better, num, M.unit)).join("");
      if (rows) body += groupRow(g) + rows;
    }
    // Points per metric under the active profile and the current list's references.
    const pointsOf = (x) => Object.fromEntries(O.explain(x.m, weights(), last.scales || {}, { rules: O.rulesOf(st.role), size: x.ship.size }).map((e) => [e.key, e.points]));
    for (const x of live) x.pts = pointsOf(x);
    const ptsRows = Object.keys(weights()).filter((k) => weights()[k] > 0)
      .map((k) => metricRow(O.METRICS[k].label, (x) => x.pts[k] || 0, +1, (v) => fmt(v, 1), "pts", true)).join("");
    if (ptsRows) body += groupRow("Score points (" + esc(PF.name) + ")") + ptsRows;
    body += groupRow("Loadout") + ["engine", "thruster", "shield", "weapon", "turret"].map((k) => {
      if (!live.some((x) => k === "engine" || k === "thruster" || x.ship.groups.some((g) => g.kind === k))) return "";
      const cells = cols.map((x) => (x.gone ? `<td class="muted">–</td>` : `<td class="parts">${partsOf(x.ship, x.lo, k)}</td>`));
      return `<tr><th>${{ engine: "Engines", thruster: "Thrusters", shield: "Shields", weapon: "Weapons", turret: "Turrets" }[k]}</th>${cells.join("")}</tr>`;
    }).join("");
    const head = `<tr><th></th>` + cols.map((x, i) => `<th class="design">
        <div class="row nowrap between"><b>${x.gone ? x.d.ship + " (no longer in the data)" : designName(x.d)}</b>
          <span>${i ? `<button type="button" data-cmp-base="${i}" title="Make this the baseline the others are measured against">◀ base</button>` : `<span class="muted small">baseline</span>`}
          <button type="button" data-cmp-rm="${i}" title="Remove">×</button></span></div>
        ${x.gone ? "" : `<div class="muted small">${x.ship.size.toUpperCase()} ${esc(typeName(x.ship.type))} <span class="id">${x.ship.id}</span></div>`}
        <div class="muted small from">${designFromHtml(x.d)}</div>
        ${x.missing && x.missing.length ? `<div class="warn small" title="${x.missing.join(", ")}">${x.missing.length} part(s) no longer in the data: left empty</div>` : ""}
      </th>`).join("") + `</tr>`;
    $("#compare-table").innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
    $("#compare-note").textContent = `Measured now: ${PF.trip.km} km trip, profile “${PF.name}”` +
      (st.role !== "combat" ? `, ${st.cargoType[st.role] || "container"} cargo` : "") +
      `. Best value in bold; percentages are against the baseline (first) design.`;
    $("#compare-diff").checked = !!st.compareDiff;
  }

  function wireCompare() {
    const rm = (i) => { st.compare.splice(i, 1); save(); renderTable(); renderDetail(); };
    $("#comparebar").onclick = (e) => {
      if (e.target.dataset.cmpRm != null) rm(+e.target.dataset.cmpRm);
      else if (e.target.id === "compare-clear") { st.compare = []; save(); renderTable(); renderDetail(); }
      else if (e.target.id === "compare-open") { renderCompare(); $("#compare-dialog").showModal(); }
    };
    $("#compare-dialog").onclick = (e) => {
      const t = e.target;
      if (t.dataset.cmpRm != null) { rm(+t.dataset.cmpRm); if (st.compare.length) renderCompare(); else $("#compare-dialog").close(); }
      else if (t.dataset.cmpBase != null) { st.compare.unshift(...st.compare.splice(+t.dataset.cmpBase, 1)); save(); renderCompare(); renderCompareBar(); }
    };
    $("#compare-diff").onchange = (e) => { st.compareDiff = e.target.checked; save(); renderCompare(); };
  }

  // ---------------------------------------------------------------- rating profile: picker + dialog
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const profileOptions = () =>
    `<optgroup label="Built in">${PRESETS.map((p) => `<option value="preset:${p.id}">${esc(p.profile.name)}</option>`).join("")}</optgroup>` +
    (Object.keys(st.profiles).length ? `<optgroup label="Mine">${Object.entries(st.profiles).sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([id, p]) => `<option value="user:${id}">${esc(p.name)}</option>`).join("")}</optgroup>` : "");

  function renderProfileState() {
    const mod = profileModified();
    for (const sel of [$("#profile-pick"), $("#pd-pick")]) {
      if (!sel) continue;
      sel.innerHTML = profileOptions();
      sel.value = st.profile.source;
    }
    const line = mod ? `<span class="warn">modified</span>, not saved yet (Save under Edit…)` : "";
    $("#profile-state").innerHTML = line;
    if ($("#pd-state")) $("#pd-state").innerHTML = (mod ? `<span class="warn">modified (unsaved)</span>` : `<span class="muted">saved</span>`);
    const src = sourceOf();
    if ($("#pd-save")) {
      $("#pd-save").disabled = !(src.kind === "user" && mod);
      $("#pd-rename").disabled = $("#pd-delete").disabled = src.kind !== "user";
      $("#pd-revert").disabled = !mod;
    }
  }

  function pickProfile(value) {
    if (value === st.profile.source) return;
    if (profileModified() && !confirm("Discard the unsaved changes to “" + PF.name + "”?")) { renderProfileState(); return; }
    const [kind, id] = value.split(":");
    const data = kind === "user" ? st.profiles[id] : (presetById(id) || {}).profile;
    if (data) useProfile(value, data);
    if ($("#profile-dialog").open) renderProfileDialog();
  }

  let pdRole = null;
  const METRIC_ORDER = () => Object.keys(O.METRICS).sort((a, b) =>
    ((a in PF.roles[pdRole].weights) ? 0 : 1) - ((b in PF.roles[pdRole].weights) ? 0 : 1) ||
    O.METRIC_GROUPS.indexOf(O.METRICS[a].group) - O.METRIC_GROUPS.indexOf(O.METRICS[b].group));
  // null shows as blank (placeholder); zeroBlank also blanks 0, for target/fixed where 0 means unset.
  const numIn = (attrs, v, ph, zeroBlank) => `<input type="number" ${attrs} value="${v == null || (zeroBlank && v === 0) ? "" : v}" placeholder="${ph || ""}" step="any">`;

  function renderProfileDialog() {
    pdRole = pdRole || st.role;
    renderProfileState();
    $("#pd-author").value = PF.author || "";
    $("#pd-notes").value = PF.notes || "";
    seg($("#pd-roles"), Object.entries(O.ROLES).map(([k, r]) => [k, r.label]), pdRole, (v) => { pdRole = v; renderProfileDialog(); });
    const R = PF.roles[pdRole];
    const rows = METRIC_ORDER().map((k) => {
      const M = O.METRICS[k], rule = R.metrics[k] || P.DEFAULT_METRIC, on = k in R.weights;
      const d = `data-m="${k}"`;
      const refLocked = rule.curve === "target" || k === "defence";
      return `<tr class="${on ? "" : "off"}"><td title="${M.better > 0 ? "more is better" : "less is better"}">${M.label} <span class="sub">${M.unit}</span></td>
        <td>${numIn(`${d} data-f="weight" min="0" max="5"`, on ? R.weights[k] : null, "–")}</td>
        <td><select ${d} data-f="curve">${P.CURVES.map((c) => `<option ${c === rule.curve ? "selected" : ""}>${c}</option>`).join("")}</select></td>
        <td>${numIn(`${d} data-f="target" min="0" ${rule.curve === "target" ? "" : "disabled"}`, rule.target, "–", true)}</td>
        <td><select ${d} data-f="reference" ${refLocked ? "disabled" : ""}>${[["list", "best in list"], ["size", "best of same size"], ["fixed", "fixed value"]]
          .map(([v, l]) => `<option value="${v}" ${v === rule.reference ? "selected" : ""}>${l}</option>`).join("")}</select></td>
        <td>${numIn(`${d} data-f="fixed" min="0" ${rule.reference === "fixed" && !refLocked ? "" : "disabled"}`, rule.fixed, "–", true)}</td>
        <td>${numIn(`${d} data-f="min"`, rule.min, "none")}</td>
        <td>${numIn(`${d} data-f="max"`, rule.max, "none")}</td></tr>`;
    }).join("");
    const banned = R.slots.ban.map((id) => { const p = D.parts.find((x) => x.id === id);
      return `<span class="chip" title="${esc(id)}">${esc(p ? partName(p) : id + " (not in your data)")} <button type="button" data-unban="${esc(id)}">×</button></span>`; }).join(" ");
    $("#pd-role").innerHTML = `
      <h3>Metrics</h3>
      <div class="pd-scroll"><table class="compact pd-metrics"><tr><th>Metric</th><th>Weight</th><th>Curve</th><th>Target</th><th>Measured against</th><th>Fixed</th><th>Min</th><th>Max</th></tr>${rows}</table></div>
      <p class="muted small">Weight runs from 0 to 5; leave it blank to hide the column. <b>Curve</b> sets how a value turns into points. Linear counts every bit
        the same, sqrt and log give the most for the first gains, and target counts up to the target value only. <b>Measured against</b>
        sets what scores 100%: the best ship in the list, the best ship of the same size, or a fixed number. Same size keeps small ships
        from being outscored by big ones. Fits outside <b>Min</b> and <b>Max</b> are left out.</p>
      <h3>Slot rules</h3>
      <div class="row">Always fill: ${P.KINDS.map((k) => `<label class="check"><input type="checkbox" data-req="${k}" ${R.slots.require[k] ? "checked" : ""}> ${k}s</label>`).join("")}</div>
      <div class="row">Never fit: ${Object.entries(P.USES).map(([u, l]) => `<label class="check" title="${esc(l)}"><input type="checkbox" data-ex="${u}" ${R.slots.exclude.includes(u) ? "checked" : ""}> ${u}</label>`).join("")}</div>
      <div class="row nowrap"><input id="pd-ban-in" list="pd-parts" placeholder="Ban a part: type its name…"><button type="button" id="pd-ban-add">Ban</button></div>
      <div class="row">${banned || `<span class="muted small">No banned parts.</span>`}</div>
      ${pdRole === "combat" ? `<h3>Ships ranked for combat</h3><div class="row">${Object.entries(O.PURPOSE_GROUPS).map(([k, l]) =>
        `<label class="check"><input type="checkbox" data-purpose="${k}" ${R.purposes.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div>` : ""}`;
    if (!$("#pd-parts").options.length) {
      const seen = new Set();
      $("#pd-parts").innerHTML = D.parts.filter((p) => !seen.has(p.id) && seen.add(p.id))
        .map((p) => `<option value="${esc(partName(p) + " (" + p.id + ")")}">`).join("");
    }
    // Shared: defence split, threat profiles, trip.
    $("#pd-defence").innerHTML = O.DEFENCE_PARTS.map((x) =>
      `<label for="pdd-${x.key}">${x.label}</label><span><input type="number" id="pdd-${x.key}" data-def="${x.key}" min="0" max="100" step="any" value="${PF.defence[x.key]}"> %</span>`).join("")
      + `<span class="muted small">Shares are rescaled to total 100%.</span><span></span>`;
    $("#pd-threats").innerHTML = `<tr><th>Profile</th><th>Defence weight</th><th>Shields</th><th>Turrets</th><th>Guns</th></tr>` +
      Object.entries(PF.threats).map(([k, t]) => `<tr><td>${O.THREATS[k].label}</td>
        <td><input type="number" data-t="${k}" data-tf="defence" min="0" max="10" step="any" value="${t.defence}"></td>
        ${["shield", "turret", "weapon"].map((r) => `<td><input type="checkbox" data-t="${k}" data-tr="${r}" ${t.require[r] ? "checked" : ""}></td>`).join("")}</tr>`).join("");
    $("#pd-km").value = PF.trip.km;
    $("#pd-turn").value = PF.trip.turn;
  }

  function onProfileInput(e) {
    const t = e.target, R = PF.roles[pdRole];
    let rerender = false;
    if (t.dataset.m) {
      const k = t.dataset.m, f = t.dataset.f;
      const rule = R.metrics[k] = R.metrics[k] || clone(P.DEFAULT_METRIC);
      const v = t.value.trim();
      if (f === "weight") {
        if (v === "") { delete R.weights[k]; delete R.metrics[k]; }
        else R.weights[k] = Math.min(5, Math.max(0, +v || 0));
        rerender = true;
      } else if (f === "min" || f === "max") rule[f] = v === "" ? null : +v;
      else if (f === "target" || f === "fixed") rule[f] = Math.max(0, +v || 0);
      else { rule[f] = v; rerender = true; }
      if (!(k in R.weights) && R.metrics[k]) R.weights[k] = 0;  // a rule shows the metric's column
    } else if (t.dataset.req) R.slots.require[t.dataset.req] = t.checked;
    else if (t.dataset.ex) { toggle(R.slots.exclude, t.dataset.ex); }
    else if (t.dataset.purpose) {
      toggle(R.purposes, t.dataset.purpose);
      if (!R.purposes.length) { R.purposes.push(t.dataset.purpose); t.checked = true; }  // never none
      st.types = [];
    } else if (t.dataset.def) PF.defence[t.dataset.def] = Math.min(100, Math.max(0, +t.value || 0));
    else if (t.dataset.t) {
      const th = PF.threats[t.dataset.t];
      if (t.dataset.tf) th.defence = Math.min(10, Math.max(0, +t.value || 0)); else th.require[t.dataset.tr] = t.checked;
    } else if (t.id === "pd-km") PF.trip.km = Math.min(1000, Math.max(1, +t.value || 50));
    else if (t.id === "pd-turn") PF.trip.turn = Math.min(180, Math.max(0, +t.value || 0));
    else if (t.id === "pd-author") PF.author = t.value.slice(0, 80);
    else if (t.id === "pd-notes") PF.notes = t.value.slice(0, 2000);
    else return;
    commitProfile();
    if (rerender) renderProfileDialog();
  }

  function importProfile(textValue) {
    const msg = $("#pd-import-msg");
    try {
      const { profile, warnings } = P.normalise(textValue, new Set(D.parts.map((p) => p.id)));
      const id = newId();
      let name = profile.name, i = 2;
      while (Object.values(st.profiles).some((p) => p.name === name)) name = profile.name + " (" + i++ + ")";
      profile.name = name;
      st.profiles[id] = profile;
      useProfile("user:" + id, profile);
      renderProfileDialog();
      msg.className = "small";
      msg.innerHTML = `Imported "${esc(name)}"${profile.author ? " by " + esc(profile.author) : ""} and switched to it.` +
        (warnings.length ? `<br><span class="warn">${warnings.map(esc).join("<br>")}</span>` : "");
      $("#pd-import-text").value = "";
    } catch (e) {
      msg.className = "small warn";
      msg.textContent = "Could not import: " + e.message;
    }
  }

  function wireProfile() {
    $("#profile-pick").onchange = (e) => pickProfile(e.target.value);
    $("#profile-edit").onclick = () => { pdRole = st.role; renderProfileDialog(); $("#profile-dialog").showModal(); };
    // From Settings: one dialog at a time, so Settings closes as the profile editor opens.
    $("#settings-profile").onclick = () => { $("#settings").close(); $("#profile-edit").click(); };
    $("#pd-pick").onchange = (e) => pickProfile(e.target.value);
    $("#profile-dialog").onchange = (e) => { if (e.target.id !== "pd-pick" && e.target.id !== "pd-import-file" && e.target.id !== "pd-ban-in") onProfileInput(e); };
    // The role panel is rebuilt on every render, so its buttons are handled here, by delegation.
    $("#profile-dialog").onclick = (e) => {
      const id = e.target.dataset.unban;
      if (id != null) { const b = PF.roles[pdRole].slots.ban; b.splice(b.indexOf(id), 1); commitProfile(); renderProfileDialog(); }
      if (e.target.id === "pd-ban-add") banPart();
    };
    const banPart = () => {
      const v = $("#pd-ban-in").value, m = /\(([\w.-]+)\)$/.exec(v);
      const id = m ? m[1] : v.trim();
      if (!D.parts.some((p) => p.id === id)) { $("#pd-ban-in").setCustomValidity("Pick a part from the list"); $("#pd-ban-in").reportValidity(); return; }
      $("#pd-ban-in").setCustomValidity("");
      const b = PF.roles[pdRole].slots.ban;
      if (!b.includes(id)) b.push(id);
      $("#pd-ban-in").value = "";
      commitProfile(); renderProfileDialog();
    };
    $("#pd-save").onclick = () => { const s = sourceOf(); if (s.kind !== "user") return; st.profiles[s.id] = clone(st.profile.data); save(); renderProfileState(); };
    $("#pd-saveas").onclick = () => {
      const name = (prompt("Name for this profile:", PF.name + (sourceOf().kind === "preset" ? " (mine)" : " copy")) || "").trim().slice(0, 80);
      if (!name) return;
      PF.name = name;
      if (sourceOf().kind === "preset") PF.author = "";  // your copy, not the preset author's
      const id = newId();
      st.profile.data = P.diff(PF);
      st.profiles[id] = clone(st.profile.data);
      st.profile.source = "user:" + id;
      save(); renderProfileDialog();
    };
    $("#pd-rename").onclick = () => {
      const s = sourceOf(); if (s.kind !== "user") return;
      const name = (prompt("New name:", PF.name) || "").trim().slice(0, 80);
      if (!name) return;
      PF.name = name; st.profile.data = P.diff(PF);
      st.profiles[s.id] = Object.assign(clone(st.profiles[s.id]), { name });
      save(); renderProfileDialog();
    };
    $("#pd-delete").onclick = () => {
      const s = sourceOf(); if (s.kind !== "user") return;
      if (!confirm("Delete the profile \"" + PF.name + "\"? Export it first if you might need it again.")) return;
      delete st.profiles[s.id];
      useProfile("preset:default", presetById("default").profile);
      renderProfileDialog();
    };
    $("#pd-revert").onclick = () => { const src = sourceProfile(); if (src) { useProfile(st.profile.source, src); renderProfileDialog(); } };
    $("#pd-export").onclick = () => {
      const blob = new Blob([JSON.stringify(st.profile.data, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (PF.name || "profile").replace(/[^\w.-]+/g, "_").slice(0, 60) + ".x4profile.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $("#pd-copy").onclick = async () => {
      const code = P.encode(st.profile.data);
      const msg = $("#pd-import-msg");
      try { await navigator.clipboard.writeText(code); msg.className = "small"; msg.textContent = `Share code copied (${code.length} characters). Paste it anywhere; others import it here.`; }
      catch (e) { $("#pd-import").hidden = false; $("#pd-import-text").value = code; $("#pd-import-text").select(); msg.className = "small"; msg.textContent = "Copy the selected share code."; }
    };
    $("#pd-import-toggle").onclick = () => { $("#pd-import").hidden = !$("#pd-import").hidden; };
    $("#pd-import-go").onclick = () => importProfile($("#pd-import-text").value);
    $("#pd-import-file").onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 256 * 1024) { $("#pd-import-msg").className = "small warn"; $("#pd-import-msg").textContent = "Could not import: file larger than 256 KB"; return; }
      f.text().then(importProfile);
      e.target.value = "";
    };
  }

  // ---------------------------------------------------------------- score breakdown
  // The rules that shaped a row, in words: required slots, excluded uses, bans, limits.
  function rulesLine(r) {
    const R = PF.roles[st.role], out = [];
    const req = new Set(P.KINDS.filter((k) => R.slots.require[k]));
    const best = r.members[0];
    if (best && best.threat && PF.threats[best.threat]) P.KINDS.filter((k) => PF.threats[best.threat].require[k]).forEach((k) => req.add(k));
    if (req.size) out.push("required: " + [...req].map((k) => k + "s").join(", "));
    if (R.slots.exclude.length) out.push("never: " + R.slots.exclude.join(", "));
    if (R.slots.ban.length) out.push(R.slots.ban.length + " banned part" + (R.slots.ban.length === 1 ? "" : "s"));
    for (const [k, m] of Object.entries(R.metrics)) {
      if (m.min != null) out.push(`${O.METRICS[k].label} ≥ ${fmt(m.min)}`);
      if (m.max != null) out.push(`${O.METRICS[k].label} ≤ ${fmt(m.max)}`);
    }
    return out.join(" · ");
  }

  const explainRow = (r) => {
    const best = r.members[0] || {};
    return O.explain(r.metrics, best.weights || weights(), last.scales || {}, { rules: O.rulesOf(st.role), size: r.ship.size });
  };
  const topContrib = (r) => explainRow(r).sort((a, b) => b.points - a.points).slice(0, 3)
    .map((e) => `${O.METRICS[e.key].label} ${fmt(e.points, 1)}`).join(", ");

  function breakdownHtml(r) {
    const ex = explainRow(r);
    if (!ex.length) return "";
    const total = ex.reduce((a, e) => a + e.points, 0);
    const best = r.members[0] || {};
    const rows = ex.slice().sort((a, b) => b.points + b.lost - (a.points + a.lost)).map((e) => {
      const M = O.METRICS[e.key], max = e.points + e.lost;
      const ref = e.curve === "target" ? "target " + fmt(e.reference, e.reference < 10 ? 2 : 0)
        : e.key === "defence" ? "of 100" : "vs " + fmt(e.reference, e.reference < 10 ? 2 : 0);
      return `<tr title="${M.label}: ${fmt(e.value, e.value < 10 ? 2 : 0)} ${M.unit} ${ref}${e.curve !== "linear" ? ", " + e.curve + " curve" : ""} → ${fmt(e.n * 100)}% of weight ${e.weight}">
        <td>${M.label}</td><td><span class="pts"><span class="got" style="width:${(100 * e.points) / Math.max(total, 1)}%"></span><span class="lost" style="width:${(100 * e.lost) / Math.max(total, 1)}%"></span></span></td>
        <td>${fmt(e.points, 1)}<span class="sub"> / ${fmt(max, 1)}</span></td></tr>`;
    }).join("");
    const rules = rulesLine(r);
    return `<h2>Why this score <span class="muted">${best.threat && O.THREATS[best.threat] ? O.THREATS[best.threat].label + " weights · " : ""}${esc(PF.name)}</span></h2>
      <table class="why">${rows}<tr><td><b>Score</b></td><td></td><td><b>${fmt(total, 1)}</b></td></tr></table>
      ${rules ? `<p class="src">${esc(rules)}</p>` : ""}`;
  }

  // ---------------------------------------------------------------- player production dialog
  function renderBuildList() {
    const q = ($("#build-search").value || "").toLowerCase();
    const items = D.ships.map((s) => ({ ware: s.ware, label: shipLabel(s), kind: "ship " + s.size.toUpperCase() }))
      .concat(D.parts.map((p) => ({ ware: p.ware, label: partName(p), kind: p.kind + (p.size ? " " + p.size.toUpperCase() : "") })));
    const seen = new Set();
    $("#build-list").innerHTML = items.filter((i) => !seen.has(i.ware) && seen.add(i.ware))
      .filter((i) => !q || i.label.toLowerCase().includes(q) || i.ware.includes(q))
      .sort((a, b) => (st.playerBuild.includes(b.ware) - st.playerBuild.includes(a.ware)) || a.label.localeCompare(b.label))
      .map((i) => `<label class="check"><input type="checkbox" data-w="${i.ware}" ${st.playerBuild.includes(i.ware) ? "checked" : ""}> ${i.label}<span class="n">${i.kind}</span></label>`).join("");
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $("#focus").onchange = (e) => {
      const m = /\(([^()]+)\)$/.exec(e.target.value.trim());  // the id at the end of the option text
      if (m && D.ships.some((x) => x.id === m[1])) setFocus(m[1]);
    };
    $("#focus-clear").onclick = () => {
      st.focus = null;
      if (st.roleBeforeFocus) st.role = st.roleBeforeFocus;
      select(null);
      changed(true);
    };
    $("#faction-search").oninput = renderFactions;
    $("#factions").onchange = (e) => { const f = e.target.dataset.f; if (f) { toggle(st.factions, f); $("#faction-count").textContent = `(${st.factions.length} selected)`; changed(); } };
    document.querySelectorAll("[data-factions]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.factions;
      if (k === "all") st.factions = Object.keys(D.factions);
      if (k === "none") st.factions = [];
      if (k === "licensed" && PL) st.factions = defaultFactions();
      changed(true);
    }));
    $("#weights").oninput = (e) => {
      const k = e.target.dataset.k; if (!k) return;
      PF.roles[st.role].weights[k] = +e.target.value;
      e.target.nextElementSibling.textContent = e.target.value;
      st.profile.data = P.diff(PF); renderProfileState();
      changed();
    };
    $("#price-lo").oninput = onPrice;
    $("#price-hi").oninput = onPrice;
    // Back to the saved profile's weights for this role (the preset's, or your saved profile's).
    $("#weights-reset").onclick = () => {
      PF.roles[st.role].weights = clone(P.resolve(sourceProfile() || {}).roles[st.role].weights);
      commitProfile();
    };
    $("#table thead").onclick = (e) => { const th = e.target.closest("th"); if (th && th.dataset.k) onHeaderClick(th.dataset.k, e.shiftKey); };
    $("#sortbar").onclick = (e) => {
      const chain = sortChain().slice();
      if (e.target.dataset.rm != null) chain.splice(+e.target.dataset.rm, 1);
      else { const chip = e.target.closest(".chip"); if (!chip) return; const i = +chip.dataset.i; chain[i] = { key: chain[i].key, asc: !chain[i].asc }; }
      st.sort = chain; save(); renderTable();
    };
    $("#table tbody").onclick = (e) => {
      const tr = e.target.closest("tr"); if (!tr) return;
      if (e.target.dataset.cmp) { const r = last.results.find((x) => x.key === tr.dataset.id); if (r) toggleCompare(r); return; }
      if (tr.dataset.id === selected) return closeDetail();   // a second click deselects
      select(tr.dataset.id); renderTable(); renderDetail();
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && selected && !document.querySelector("dialog[open]")) closeDetail();
    });
    wireCompare();
    $("#build-edit").onclick = () => { renderBuildList(); $("#build-dialog").showModal(); };
    $("#build-search").oninput = renderBuildList;
    $("#build-list").onchange = (e) => { const w = e.target.dataset.w; if (w) { toggle(st.playerBuild, w); $("#build-count").textContent = `(${st.playerBuild.length})`; changed(); } };
    $("#build-seed").onclick = () => { if (PL) { st.playerBuild = Array.from(new Set(st.playerBuild.concat(PL.blueprints))); renderBuildList(); changed(true); } };
    $("#build-seed").disabled = !PL;
    $("#build-clear").onclick = () => { st.playerBuild = []; renderBuildList(); changed(true); };
  }

  applyProfile();
  applyDisplay();
  renderStatus();
  renderFilters();
  wire();
  wireSettings();
  wireProfile();
  // ?ship=<id> (the wiki edition's ship pages, "Open in the evaluator"): start with that ship picked.
  // The parameter then leaves the address, so a reload keeps whatever the user changes afterwards.
  const linked = new URLSearchParams(location.search).get("ship");
  if (linked) {
    const q = new URLSearchParams(location.search);
    q.delete("ship");
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
  }
  if (linked && D.ships.some((x) => x.id === linked)) setFocus(linked);   // runs the ranking itself
  else run();
})();
