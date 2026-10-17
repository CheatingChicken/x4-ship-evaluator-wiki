/* SHIP PAGES: the SWI wiki's ship pages (/ships/<hull>/<ship>, /submods/<mod>/ships/<hull>/<ship>)
 * rebuilt from the evaluator's data, with the equipment the wiki cannot show yet: every engine,
 * thruster, shield, weapon and turret that fits the hull, with prices, sellers and build costs.
 * A proof of concept for the wiki maintainers.
 *
 * Routing: like the wiki, one page renders whatever the address names. GitHub Pages answers every
 * path it has no file for with 404.html, which is this page (tools/build_site.js), so
 * /ships/s/ewing renders the E-wing live. The wiki's list pages work the same way:
 *   ships                     the catalogue: full list, by hull, by faction, submods
 *   ships/full-list           every ship, grouped by size
 *   ships/<hull>              one size
 *   ships/<faction>           the ships a faction sells, by its in-game short name (imp, nrl, ...),
 *                             as the wiki's swi-api /list/filter/<code> does (checked: same lists)
 *   submods/<mod>/ships[...]  the same for one submod's ships
 * The wiki's locale prefix (/en/...) is accepted too.
 *
 * Data: data.js (site_loader.js) for SWI plus the mods switched on (the same choice as the
 * evaluator's Settings -> Mods; the page's own mod is always loaded), and the per-mod details files.
 *
 * Every section can be switched off: CONFIG.sections below, or window.X4ShipConfig =
 * { sections: { loadouts: false } } set before this script.
 *
 * Node: module.exports = { CONFIG, route, shipPath, findShip, renderShip, renderIndex, loadouts },
 * for tests/test_ship_page.js. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.X4Ships = api;
    if (root.document) root.document.addEventListener("DOMContentLoaded", () => api.boot());
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------- configuration
  const CONFIG = {
    sections: {
      description: true,     // the ship's text from the game
      infobox: true,         // the wiki's sidebar: class, licence, hull, storage, crew, costs, sellers
      slotLayout: true,      // each slot group: kind, size, count, how many parts fit
      engines: true,         // engine options with the movement they give this hull
      thrusters: true,       // thruster options with turning and strafing on this hull
      shields: true,         // shield options per shield slot group
      weapons: true,         // weapon options per weapon slot group
      turrets: true,         // turret options per turret slot group
      loadouts: true,        // the evaluator's best fit per role (default rating profile)
      evaluatorLink: true,   // "Open in the evaluator"
      wikiLink: true,        // the same ship's page on the wiki, for comparison
      modToggles: true,      // switch submods' equipment on and off
      icons: true,           // ship class icons in the lists, from the wiki's own /ships/icons/
    },
    wiki: "https://swi.siifr.net",
    icons: "https://swi.siifr.net/ships/icons/",
    // Names for build-cost wares. Energy cells, hull parts, ship supplies and rhydonium as the wiki
    // shows them; the rest are the base game's names (SWI may name some differently).
    wareNames: {
      energycells: "Energy Cells", hullparts: "Durasteel Plates", shipsupplies: "Ship Supplies", rhydoniumcell: "Rhydonium Core",
      computronicsubstrate: "Computronic Substrate", metallicmicrolattice: "Metallic Microlattice", weaponcomponents: "Weapon Components",
      siliconcarbide: "Silicon Carbide", advancedelectronics: "Advanced Electronics", turretcomponents: "Turret Components", ore: "Ore",
      silicon: "Silicon", engineparts: "Engine Parts", antimatterconverters: "Antimatter Converters", fieldcoils: "Field Coils",
      shieldcomponents: "Shield Components", missilecomponents: "Missile Components", smartchips: "Smart Chips", claytronics: "Claytronics",
    },
    licences: {
      generaluseship: "General use", militaryship: "Military ship", capitalship: "Capital ship",
      generaluseequipment: "General use", militaryequipment: "Military equipment", capitalequipment: "Capital equipment",
    },
  };
  const HULLS = ["s", "m", "l", "xl", "xxl"];
  const DEG = 180 / Math.PI;

  // ---------------------------------------------------------------- small helpers
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (v, d) => (v == null || !isFinite(v) ? "—" : Number(v).toLocaleString("en", { maximumFractionDigits: d == null ? 1 : d }));
  const cr = (v) => (v ? num(Math.round(v), 0) + " cr" : "—");
  const pathOf = (mod, hull, key) => (mod === "swi" ? "" : `submods/${mod}/`) + "ships" + (hull ? "/" + hull : "") + (key ? "/" + key : "");

  /* path below the site root ->
   *   { kind: "ship", mod, hull, key }
   *   { kind: "index", mod, list: "hub" | "full" | "hull" | "faction", hull?, code? }
   *   { kind: "none" } */
  function route(path) {
    const p = String(path || "").split(/[?#]/)[0].split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
    if (p[0] === "en") p.shift();                          // the wiki's locale prefix
    let mod = "swi", i = 0;
    if (p[0] === "submods") { mod = p[1]; i = 2; if (!mod) return { kind: "none" }; }
    if (p[i] !== "ships" || p.length > i + 3) return { kind: "none" };
    const second = p[i + 1] ? p[i + 1].toLowerCase() : null, key = p[i + 2] || null;
    if (key) return HULLS.includes(second) ? { kind: "ship", mod, hull: second, key } : { kind: "none" };
    if (!second) return { kind: "index", mod, list: "hub" };
    if (second === "full-list") return { kind: "index", mod, list: "full" };
    if (HULLS.includes(second)) return { kind: "index", mod, list: "hull", hull: second };
    return /^[a-z0-9_]+$/.test(second) ? { kind: "index", mod, list: "faction", code: second } : { kind: "none" };
  }
  const listPath = (mod, rest) => (mod === "swi" ? "" : `submods/${mod}/`) + "ships" + (rest ? "/" + rest : "");
  const shipPath = (ship, det) => { const pg = (det.ships[ship.id] || {}).page || {}; return pathOf(ship.origin, pg.hull, pg.key); };
  function findShip(D, det, r) {
    return D.ships.find((s) => { const pg = (det.ships[s.id] || {}).page; return pg && s.origin === r.mod && pg.hull === r.hull && pg.key === r.key; }) || null;
  }

  // ---------------------------------------------------------------- rendering pieces
  function ctxHelpers(c) {
    const cfg = c.cfg, D = c.D, det = c.det;
    const fname = (f) => (D.factions[f] || f);
    // up to three sellers, then "+N more" with the rest on hover (long lists made rows very tall)
    const sellers = (owners) => {
      if (!owners || !owners.length) return `<span class="muted">no seller listed</span>`;
      const names = owners.map(fname).sort((a, b) => a.localeCompare(b));
      const shown = names.length > 3 ? names.slice(0, 2) : names;
      return esc(shown.join(", ")) + (names.length > shown.length
        ? ` <span class="more-chip" title="${esc(names.slice(shown.length).join(", "))}">+${names.length - shown.length} more</span>` : "");
    };
    const licence = (l) => (l ? esc(cfg.licences[l] || l) : "None");
    const build = (b) => (b && b.wares && b.wares.length
      ? b.wares.map((w) => `${num(w.amount, 0)} ${esc(cfg.wareNames[w.ware] || w.ware)}`).join(", ") : `<span class="muted">—</span>`);
    const modChip = (id) => (id && id !== "swi" && c.mods[id] ? ` <span class="modchip" title="${esc(c.mods[id])}">${esc(id.toUpperCase())}</span>` : "");
    const partMod = (p) => (p.kind === "thruster" ? "" : modChip((det.parts[p.id] || {}).mod));
    const partName = (p) => `${esc(p.name)}${p.mk && !/\bmk\s*\d/i.test(p.name) ? ` <span class="muted small">Mk${p.mk}</span>` : ""}${partMod(p)}`;
    return { fname, sellers, licence, build, modChip, partName };
  }

  // A table with a header row and one row per item. cols: [label, cell(item) -> html, { txt, name, title }]:
  // txt = left-aligned text, name = text that may wrap (only the name column, so rows stay one line high)
  const cellClass = (o) => (o && o.txt ? "txt" : "") + (o && o.name ? " name" : "");
  function table(cols, items, cls) {
    if (!items.length) return `<p class="muted">Nothing fits.</p>`;
    return `<div class="scroll"><table class="${cls || ""}"><thead><tr>${cols.map(([h, , o]) => `<th class="${cellClass(o)}"${o && o.title ? ` title="${esc(o.title)}"` : ""}>${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${items.map((it) => `<tr>${cols.map(([, f, o]) => `<td class="${cellClass(o)}">${f(it)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const buyCols = (h) => [
    ["Credit cost", (p) => cr(p.price)],
    ["Sold by", (p) => h.sellers(p.owners), { txt: true }],
    ["Licence", (p) => h.licence(p.licence), { txt: true }],
    ["Build cost", (p) => h.build(p.d.build), { txt: true }],
  ];
  const withDetail = (c, list) => list.map((p) => Object.assign({ d: c.det.parts[p.id] || {} }, p));

  function infobox(c, s, d, h) {
    const cargo = s.cargo || {}, hang = s.hangar || {};
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    const head = (t) => `<tr class="ib-head"><th colspan="2">${t}</th></tr>`;
    const price = d.price || {};
    return `<aside class="infobox"><table>
      ${head("Ship")}${row("Identifier", `<code>${esc(s.ware)}</code>`)}${row("Size", s.size.toUpperCase())}${row("Class", esc(s.type || "—"))}
      ${row("Purpose", esc(s.purpose || "—"))}${row("Licence", h.licence(s.licence))}
      ${d.supply != null ? row("Maintenance supply cost", num(d.supply, 0)) : ""}
      ${head("Base stats")}${row("Hull", num(s.hull, 0))}${d.radar != null ? row("Radar range", num(d.radar / 1000, 1) + " km") : ""}${row("Mass", num(s.mass, 1) + " t")}
      ${head("Storage")}${["container", "solid", "liquid", "condensate"].map((t) => row(t[0].toUpperCase() + t.slice(1), num(cargo[t] || 0, 0))).join("")}
      ${head("Hangar")}${row("S ships", num(hang.dock_s || 0, 0))}${row("M ships", num(hang.dock_m || 0, 0))}
      ${head("Capacity")}${row("Crew", num(s.crew, 0))}${row("Units (drones)", num(s.drones, 0))}${row("Missiles", num(s.missiles, 0))}
      ${row("Deployables", num(d.deployables || 0, 0))}${row("Countermeasures", num(d.countermeasures || 0, 0))}
      ${head("Build cost")}${(d.build && d.build.wares || []).map((w) => row(esc(c.cfg.wareNames[w.ware] || w.ware), num(w.amount, 0))).join("") || row("—", "")}
      ${d.build && d.build.time ? row("Build time", num(d.build.time, 0) + " s") : ""}
      ${head("Credit cost")}${row("Minimum", cr(price.min))}${row("Average", cr(price.avg || s.price))}${row("Maximum", cr(price.max))}
      ${head("Sold by")}<tr><td colspan="2" class="sellers">${h.sellers(s.owners)}</td></tr>
    </table></aside>`;
  }

  function slotLayout(c, s, d) {
    const tags = d.groupTags || [];
    const rows = s.groups.map((g, i) => ({ g, n: g.cands.length, tags: tags[i] || [] }));
    return section("slots", "Slot layout", table([
      ["Slot", (r) => esc(r.g.kind) + (r.g.mining ? ` <span class="muted small">(mining)</span>` : ""), { txt: true }],
      ["Size", (r) => esc((r.g.size || "—").toUpperCase())],
      ["Count", (r) => num(r.g.count, 0)],
      ["Fitting parts", (r) => num(r.n, 0)],
      ["Slot tags", (r) => r.tags.map((t) => `<code>${esc(t)}</code>`).join(" "), { txt: true, title: "A part fits when all of its own connection tags are among these" }],
    ], rows, "narrow"));
  }

  function engines(c, s, h) {
    const items = Object.entries(s.engines).map(([i, row]) => Object.assign({ row }, withDetail(c, [c.D.parts[+i]])[0]))
      .sort((a, b) => b.row.TravelSpeed - a.row.TravelSpeed);
    const n = items.length ? items[0].row.engines : 0;
    return section("engines", "Engine options", `<p class="muted small">Values for this hull with ${n} engine${n === 1 ? "" : "s"} of the kind fitted. Speeds and accelerations are the game's own figures (checked with an in-game probe); boost recharge is 100 ÷ the engine's recharge time, as on the wiki.</p>` + table([
      ["Name", (p) => h.partName(p), { txt: true, name: true }],
      ["Speed<br>m/s", (p) => num(p.row.ForwardSpeed)], ["Accel.<br>m/s²", (p) => num(p.row.ForwardAcceleration)],
      ["Boost<br>m/s", (p) => num(p.row.BoostSpeed)], ["Boost acc.<br>m/s²", (p) => num(p.row.BoostAcceleration)],
      ["Boost for<br>s", (p) => num(p.row.BoostMaxDuration)], ["Boost recharge<br>%/s", (p) => (p.d.boostRecharge ? num(100 / p.d.boostRecharge, 2) : "—")],
      ["Travel<br>m/s", (p) => num(p.row.TravelSpeed, 0)], ["Travel acc.<br>m/s²", (p) => num(p.row.TravelAcceleration)],
      ["Charge<br>s", (p) => num(p.row.TravelChargeTime)],
    ].concat(buyCols(h)), items));
  }

  function thrusters(c, s, h) {
    const items = Object.entries(s.thrusters).map(([i, row]) => Object.assign({ row }, withDetail(c, [c.D.parts[+i]])[0]))
      .sort((a, b) => b.row.YawSpeed - a.row.YawSpeed);
    return section("thrusters", "Thruster options", `<p class="muted small">Thrusters are the base game's (SWI uses the stock ones). Turn rates for this hull, in degrees per second.</p>` + table([
      ["Name", (p) => h.partName(p), { txt: true, name: true }],
      ["Yaw<br>°/s", (p) => num(p.row.YawSpeed * DEG)], ["Pitch<br>°/s", (p) => num(p.row.PitchSpeed * DEG)], ["Roll<br>°/s", (p) => num(p.row.RollSpeed * DEG)],
      ["Strafe<br>m/s", (p) => num(p.row.HorizontalStrafeSpeed)], ["Strafe acc.<br>m/s²", (p) => num(p.row.HorizontalStrafeAcceleration)],
    ].concat(buyCols(h)), items));
  }

  const groupTitle = (g) => `${g.count} × ${esc((g.size || "").toUpperCase())} ${esc(g.kind)} slot${g.count === 1 ? "" : "s"}${g.mining ? " (mining)" : ""}`;
  function perGroup(c, s, kind, cols, sortKey) {
    const groups = s.groups.filter((g) => g.kind === kind);
    if (!groups.length) return `<p class="muted">This hull has no ${kind} slots.</p>`;
    return groups.map((g) => `<h3>${groupTitle(g)}</h3>` +
      table(cols, withDetail(c, g.cands.map((i) => c.D.parts[i])).sort((a, b) => sortKey(b) - sortKey(a)))).join("");
  }
  function shields(c, s, h) {
    return section("shields", "Shield options", perGroup(c, s, "shield", [
      ["Name", (p) => h.partName(p), { txt: true, name: true }],
      ["Shielding<br>MJ", (p) => num(p.stats.ShieldValue, 0)], ["Recharge<br>MW", (p) => num(p.stats.ShieldRate, 1)],
      ["Delay<br>s", (p) => num(p.stats.ShieldDelay, 2)],
    ].concat(buyCols(h)), (p) => p.stats.ShieldValue || 0));
  }
  const dps = (p) => p.stats.BurstDPS || p.stats.TurretBurstDPS || p.stats.MiningRate || 0;
  const dpsCell = (p) => `${num(dps(p), 0)}${p.src === "game" ? "" : ` <span class="muted small" title="computed from the files, not measured in the game">≈</span>`}`;
  const shotCols = [
    ["DPS", dpsCell, { title: "Burst damage per second as the game measures it (≈: computed from the files)" }],
    ["Use", (p) => esc(p.use), { txt: true }],
    ["Shield dmg<br>/shot", (p) => num(p.d.shieldDamage, 0)], ["Pierce dmg<br>/shot", (p) => num(p.d.pierceDamage, 0)],
    ["Hull dmg<br>/shot", (p) => num(p.d.hullDamage, 0)], ["Shot speed<br>m/s", (p) => num(p.d.speed, 0)],
    ["Range<br>km", (p) => num(p.d.range != null ? p.d.range / 1000 : null, 2)], ["Fire rate<br>/s", (p) => num(p.d.rate, 2)],
  ];
  function weapons(c, s, h) {
    return section("weapons", "Weapon options", perGroup(c, s, "weapon", [["Name", (p) => h.partName(p), { txt: true, name: true }]].concat(shotCols, [
      ["Heat<br>MW/s", (p) => num(p.d.heatBuildup, 0)], ["Cooling<br>MW/s", (p) => num(p.d.coolRate, 0)],
    ], buyCols(h)), dps));
  }
  function turrets(c, s, h) {
    return section("turrets", "Turret options", perGroup(c, s, "turret", [["Name", (p) => h.partName(p), { txt: true, name: true }]].concat(shotCols, [
      ["Burst<br>s", (p) => num(p.d.burst, 1)], ["Cooldown<br>s", (p) => num(p.d.cooldown, 1)], ["Rotation<br>°/s", (p) => num(p.d.rotation, 0)],
    ], buyCols(h)), dps));
  }

  // ---------------------------------------------------------------- best loadouts (optimiser.js)
  // The evaluator's best fit for each role this hull can take, with the default rating profile and
  // every seller allowed (no save): the same as picking the ship in the evaluator without a save.
  function loadouts(D, ship, O) {
    const out = [];
    const base = { factions: new Set(Object.keys(D.factions)), useSave: false, player: null, playerBuild: new Set(),
      sizes: new Set(), types: new Set(), priceMin: 0, priceMax: 0, priceBasis: "hull", focus: ship.id,
      sourcing: new Set(["mixed"]), tripDistance: 50000, combatPurposes: O.DEFAULT_COMBAT_PURPOSES.slice() };
    const holds = ["container", "solid", "liquid"].filter((t) => (ship.cargo[t] || 0) > 0);
    const roles = [];
    // trading and mining only for hulls built for them, as in the evaluator; every hull can fight
    if (holds.length && ship.purpose === "trade") roles.push(["trader", { cargoType: holds[0], threats: ["safe", "contested", "dangerous"] }]);
    if (ship.purpose === "mine" && ["solid", "liquid"].some((t) => ship.cargo[t] > 0))
      roles.push(["miner", { cargoType: ship.cargo.solid > 0 ? "solid" : "liquid", threats: ["safe", "contested", "dangerous"] }]);
    roles.push(["combat", { cargoType: undefined, threats: [] }]);
    for (const [role, extra] of roles) {
      const ctx = Object.assign({ role }, base, extra);
      const r = O.rank(D, O.shortlist(D, ctx), ctx, O.ROLES[role].weights, {});
      if (r.results.length) out.push({ role, ctx, row: r.results[0] });
    }
    return out;
  }
  function loadoutHtml(c, s, list, h) {
    if (!list) return `<p class="muted">Working out the best fits…</p>`;
    if (!list.length) return `<p class="muted">No complete fit is buyable.</p>`;
    const P = c.D.parts;
    return list.map(({ role, ctx, row }) => {
      const lo = row.loadout, m = row.metrics;
      const parts = [];
      if (lo.engine != null) parts.push(`${s.engines[lo.engine] ? s.engines[lo.engine].engines : 1} × ${h.partName(P[lo.engine])}`);
      if (lo.thruster != null) parts.push(h.partName(P[lo.thruster]));
      s.groups.forEach((g, i) => { if (g.kind !== "engine" && lo.groups[i] != null) parts.push(`${g.count} × ${h.partName(P[lo.groups[i]])}`); });
      const facts = [["Speed", num(m.maxSpeed) + " m/s"], ["Travel", num(m.travelSpeed, 0) + " m/s"], ["Turn", num(m.turnRate) + " °/s"],
        ["Shield", num(m.shield, 0) + " MJ"], ["Weapon DPS", num(m.burstDps, 0)], ["Turret DPS", num(m.turretDps, 0)],
        ["Fitted price", cr(m.price)]].concat(role === "combat" ? [] : [["Cargo", num(m.cargo, 0) + " " + esc(ctx.cargoType)]]);
      return `<div class="loadout"><h3>${esc(role[0].toUpperCase() + role.slice(1))}${row.threats && row.threats.length ? ` <span class="muted small">(${esc(row.threats.join(", "))})</span>` : ""}</h3>
        <ul>${parts.map((x) => `<li>${x}</li>`).join("")}</ul>
        <p class="facts">${facts.map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join("")}</p></div>`;
    }).join("");
  }

  function section(id, title, body) { return `<section id="sec-${id}"><h2>${title}</h2>${body}</section>`; }

  /* c: { D, det, cfg, mods: {id: label}, enabled: [ids], loadouts: [...] | null | undefined }
   * Returns the page's main HTML for one ship. */
  function renderShip(c, s) {
    const on = c.cfg.sections, d = c.det.ships[s.id] || {}, h = ctxHelpers(c);
    const path = shipPath(s, c.det);
    const links = [];
    if (on.evaluatorLink) {
      const mods = s.origin !== "swi" && !(c.enabled || []).includes(s.origin) ? (c.enabled || []).concat(s.origin) : null;
      links.push(`<a class="button" href="./?ship=${encodeURIComponent(s.id)}${mods ? "&mods=" + encodeURIComponent(mods.join(",")) : ""}">Open in the evaluator</a>`);
    }
    if (on.wikiLink) links.push(`<a class="button" href="${esc(c.cfg.wiki + "/" + path)}" target="_blank" rel="noopener">This ship on the wiki ↗</a>`);
    const crumbs = `<nav class="crumbs"><a href="./ships">Ships</a> › ${s.origin !== "swi" ? `<a href="./${pathOf(s.origin)}">${esc((c.mods[s.origin] || s.origin))}</a> › ` : ""}` +
      `<a href="./${pathOf(s.origin, (d.page || {}).hull)}">${esc(((d.page || {}).hull || s.size).toUpperCase())}</a> › ${esc(s.name)}</nav>`;
    const main = [
      on.description && d.description ? section("description", "Description", d.description.split("\n").map((p) => `<p>${esc(p)}</p>`).join("")) : "",
      on.loadouts ? section("loadouts", "Best loadouts", `<p class="muted small">The evaluator's best fit per role with the default rating profile, any seller, no save.</p><div id="loadouts">${loadoutHtml(c, s, c.loadouts, h)}</div>`) : "",
      on.slotLayout ? slotLayout(c, s, d) : "",
      on.engines ? engines(c, s, h) : "",
      on.thrusters ? thrusters(c, s, h) : "",
      on.shields ? shields(c, s, h) : "",
      on.weapons ? weapons(c, s, h) : "",
      on.turrets ? turrets(c, s, h) : "",
    ].join("");
    return `${crumbs}<header class="shiphead"><h1>${esc(s.name)}${h.modChip(s.origin)}</h1>
        <p class="muted">${esc(s.size.toUpperCase())} ${esc(s.type || "")}${s.variation ? " · " + esc(s.variation) : ""}</p>
        ${links.length ? `<p class="links">${links.join(" ")}</p>` : ""}</header>
      <div class="shipgrid${on.infobox ? "" : " noinfo"}"><div class="shipmain">${main}</div>${on.infobox ? infobox(c, s, d, h) : ""}</div>`;
  }

  // ---------------------------------------------------------------- list pages
  const hullOf = (c, s) => ((c.det.ships[s.id] || {}).page || {}).hull || s.size;
  // The faction a list code names: its in-game short name (imp), or its id (galempire).
  function factionOf(c, code) {
    const short = c.D.faction_short || {};
    return Object.keys(c.D.factions).find((f) => (short[f] || "").toLowerCase() === code) || (code in c.D.factions ? code : null);
  }
  const factionCode = (c, f) => ((c.D.faction_short || {})[f] || f).toLowerCase();
  function shipTable(c, ships, h) {
    const icon = (s) => {
      const i = (c.det.ships[s.id] || {}).icon;
      return c.cfg.sections.icons && i ? `<img class="shipicon" src="${esc(c.cfg.icons + i + ".png")}" alt="" loading="lazy" onerror="this.remove()">` : "";
    };
    return table([
      ["Ship", (s) => `${icon(s)}<a href="./${shipPath(s, c.det)}">${esc(s.name)}</a>${h.modChip(s.origin)}`, { txt: true, name: true }],
      ["Class", (s) => esc(s.type || "—"), { txt: true }], ["Purpose", (s) => esc(s.purpose || "—"), { txt: true }],
      ["Hull", (s) => num(s.hull, 0)], ["Cargo", (s) => num(Math.max(0, ...Object.values(s.cargo || {})), 0)],
      ["Hangar", (s) => num(((s.hangar || {}).dock_s || 0) + ((s.hangar || {}).dock_m || 0), 0)],
      ["Price", (s) => cr(s.price)], ["Sold by", (s) => h.sellers(s.owners), { txt: true }],
    ], ships, "index");
  }
  // ships grouped by size: a heading and a table per size (the wiki's full list layout); the search
  // hides a group with no hits
  const bySize = (c, ships, h) => HULLS.map((z) => {
    const list = ships.filter((s) => hullOf(c, s) === z);
    return list.length ? `<div class="sizegroup"><h2 id="${z}">${z.toUpperCase()} <span class="muted">${list.length}</span></h2>` + shipTable(c, list, h) + `</div>` : "";
  }).join("");
  // the list pages' search box (wired up by wireSearch in the browser)
  const searchBox = `<p class="listsearch"><input type="search" id="list-q" placeholder="Filter by name, class, purpose or seller…" autocomplete="off">` +
    ` <span id="list-count" class="muted small"></span></p>`;
  const linkList = (items) => `<ul class="linklist">${items.map(([href, label, n]) =>
    `<li><a href="./${href}">${label}</a> <span class="muted small">${n}</span></li>`).join("")}</ul>`;

  /* The list pages. Returns { title, html }, or null when the address names no faction that sells
   * ships. /ships lists every loaded ship (SWI plus the mods switched on); /submods/<mod>/ships that mod's. */
  function renderIndex(c, r) {
    const h = ctxHelpers(c), modName = r.mod !== "swi" ? (c.mods[r.mod] || r.mod) : null;
    const pool = c.D.ships.filter((s) => r.mod === "swi" || s.origin === r.mod)
      .sort((a, b) => HULLS.indexOf(hullOf(c, a)) - HULLS.indexOf(hullOf(c, b)) || a.name.localeCompare(b.name));
    const crumbs = (here) => `<nav class="crumbs"><a href="./ships">Ships</a>` +
      (modName ? ` › <a href="./${listPath(r.mod)}">${esc(modName)}</a>` : "") + (here ? " › " + esc(here) : "") + `</nav>`;
    const wiki = (rest) => (c.cfg.sections.wikiLink ? `<p class="links"><a class="button" href="${esc(c.cfg.wiki + "/" + listPath(r.mod, rest))}" ` +
      `target="_blank" rel="noopener">This list on the wiki ↗</a></p>` : "");
    const head = (title, rest, note) => `<header class="shiphead"><h1>${esc(title)}</h1>${note ? `<p class="muted">${esc(note)}</p>` : ""}${wiki(rest)}</header>`;
    const prefix = modName ? modName + " ships" : "Ships";
    if (r.list === "hub") {
      const hulls = HULLS.map((z) => [listPath(r.mod, z), z.toUpperCase() + " ships", pool.filter((s) => hullOf(c, s) === z).length]).filter((x) => x[2]);
      let html = crumbs() + head(modName ? prefix : "Vessel Catalogue", "", modName ? "" : "Where the ships of your dreams in the SWI galaxy can be found") +
        `<section><h2>Ship lists</h2>${linkList([[listPath(r.mod, "full-list"), "Full list", pool.length]])}</section>` +
        `<section><h2>Ships by hull</h2>${linkList(hulls)}</section>`;
      if (r.mod === "swi") {
        const sellers = Object.keys(c.D.factions).map((f) => [f, pool.filter((s) => s.owners.includes(f)).length]).filter(([, n]) => n)
          .sort((a, b) => (c.D.factions[a[0]] || a[0]).localeCompare(c.D.factions[b[0]] || b[0]));
        const mods = Object.keys(c.mods).filter((m) => m !== "swi").map((m) => {
          const n = c.D.ships.filter((s) => s.origin === m).length;
          return [listPath(m), esc(c.mods[m]), n || "not switched on"];
        });
        html += `<section><h2>Ships by faction</h2>${linkList(sellers.map(([f, n]) => [listPath("swi", factionCode(c, f)), esc(c.D.factions[f] || f), n]))}</section>` +
          `<section><h2>Submods</h2>${linkList(mods)}</section>`;
      }
      return { title: modName ? prefix : "Vessel Catalogue", html };
    }
    if (r.list === "full") return { title: prefix + " – full list", html: crumbs("Full list") + head(prefix + " – full list", "full-list") + searchBox + bySize(c, pool, h) };
    if (r.list === "hull") {
      const sizes = `<p class="sizes">${HULLS.map((z) => `<a href="./${listPath(r.mod, z)}"${r.hull === z ? ` class="on"` : ""}>${z.toUpperCase()}</a>`).join("")}</p>`;
      const title = `${modName ? modName + " " : ""}${r.hull.toUpperCase()} ships`;
      return { title, html: crumbs(r.hull.toUpperCase()) + head(title, r.hull) + sizes + searchBox + shipTable(c, pool.filter((s) => hullOf(c, s) === r.hull), h) };
    }
    const f = factionOf(c, r.code);
    if (!f) return null;
    const title = `${prefix} – ${c.D.factions[f] || f}`;
    return { title, html: crumbs(c.D.factions[f] || f) + head(title, r.code, "Every ship this faction sells.") + searchBox + bySize(c, pool.filter((s) => s.owners.includes(f)), h) };
  }

  // ---------------------------------------------------------------- browser
  const G = typeof self !== "undefined" ? self : globalThis;

  // Zebra stripes on the rows still shown, in their current order (nth-child would count hidden rows).
  function stripe(table) {
    let i = 0;
    for (const tr of table.tBodies[0].rows) tr.classList.toggle("alt", !tr.hidden && i++ % 2 === 1);
  }
  // A click on a header sorts its table by that column, a second click reverses it. Text columns
  // (class "txt") sort A-Z first, number columns largest first; cells without a number ("—") go last.
  function sortable(table) {
    const ths = [...table.tHead.rows[0].cells];
    ths.forEach((th, col) => {
      th.classList.add("sortable");
      th.title = th.title || "Sort by this column";
      th.onclick = () => {
        const text = th.classList.contains("txt");
        const asc = th.classList.contains("sorted") ? !th.classList.contains("asc") : text;
        ths.forEach((x) => x.classList.remove("sorted", "asc"));
        th.classList.add("sorted");
        if (asc) th.classList.add("asc");
        const key = (tr) => {
          const t = tr.cells[col].textContent.trim();
          if (text) return t.toLowerCase();
          const n = parseFloat(t.replace(/[^0-9.\-]/g, ""));
          return isFinite(n) ? n : null;
        };
        const body = table.tBodies[0];
        [...body.rows].map((tr) => [key(tr), tr])
          .sort(([x], [y]) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1)))
          .forEach(([, tr]) => body.appendChild(tr));
        stripe(table);
      };
    });
  }
  // The list pages' search: every word must appear in the row's text, its sellers included (also
  // the ones behind "+N more"). Groups without a hit are hidden; the query is kept in ?q=.
  function wireSearch(root) {
    const q = root.querySelector("#list-q"), count = root.querySelector("#list-count");
    if (!q) return;
    const rows = [...root.querySelectorAll("tbody tr")];
    const hay = rows.map((tr) => (tr.textContent + " " + [...tr.querySelectorAll("[title]")].map((x) => x.title).join(" ")).toLowerCase());
    const apply = () => {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      let n = 0;
      rows.forEach((tr, i) => { tr.hidden = !words.every((w) => hay[i].includes(w)); if (!tr.hidden) n++; });
      root.querySelectorAll(".sizegroup").forEach((g) => {
        const hits = g.querySelectorAll("tbody tr:not([hidden])").length, all = g.querySelectorAll("tbody tr").length;
        g.hidden = !hits;
        const label = g.querySelector("h2 .muted");
        if (label) label.textContent = words.length ? `${hits} of ${all}` : String(all);
      });
      root.querySelectorAll("table").forEach(stripe);
      count.textContent = words.length ? `${n} of ${rows.length} ships` : `${rows.length} ships`;
      const url = new URL(location.href);
      if (q.value.trim()) url.searchParams.set("q", q.value.trim()); else url.searchParams.delete("q");
      history.replaceState(null, "", url);
    };
    q.value = new URLSearchParams(location.search).get("q") || "";
    q.oninput = apply;
    apply();
  }
  // after a render: sortable, striped tables (not the infobox) and the search box
  function enhance(root) {
    root.querySelectorAll("table").forEach((t) => { if (!t.closest(".infobox") && t.tHead && t.tBodies[0]) { sortable(t); stripe(t); } });
    wireSearch(root);
  }
  function boot() {
    const user = G.X4ShipConfig || {};
    const cfg = Object.assign({}, CONFIG, user, { sections: Object.assign({}, CONFIG.sections, user.sections) });
    const out = document.getElementById("page"), status = document.getElementById("page-status");
    const basePath = new URL(document.baseURI).pathname;
    const rel = location.pathname.startsWith(basePath) ? location.pathname.slice(basePath.length) : location.pathname;
    const r = route(rel);
    const src = G.X4Source;
    const notFound = (why) => {
      document.title = "Not found · X4 Ship Evaluator";
      out.innerHTML = `<header class="shiphead"><h1>Not found</h1><p>${esc(why)}</p><p><a href="./ships">All ships</a> · <a href="./">The evaluator</a></p></header>`;
    };
    if (r.kind === "none") return notFound("There is no page at this address.");
    if (!src || !src.mods) return notFound("The ship data did not load.");
    if (!(r.mod in src.mods)) return notFound(`"${r.mod}" is not a mod this site covers.`);
    async function show() {
      const enabled = src.enabledMods();
      const mods = r.mod === "swi" || enabled.includes(r.mod) ? enabled : enabled.concat(r.mod);
      status.textContent = "Loading ship data…";
      const [D, det] = await Promise.all([src.load(null, mods), src.details(mods)]);
      status.textContent = "";
      const c = { D, det, cfg, mods: src.mods, enabled };
      // the mod switches, first thing on every page
      const toggles = cfg.sections.modToggles ? `<p class="modtoggles small">${r.kind === "index" ? "Ships" : "Equipment"} from: ${Object.entries(src.mods).map(([id, label]) => id === "swi"
        ? `<label><input type="checkbox" checked disabled> ${esc(label)}</label>`
        : `<label title="Same choice as the evaluator's Settings → Mods"><input type="checkbox" data-mod="${esc(id)}"${mods.includes(id) ? " checked" : ""}${id === r.mod ? " disabled" : ""}> ${esc(label)}</label>`).join(" ")}</p>` : "";
      if (r.kind === "index") {
        const page = renderIndex(c, r);
        if (!page) return notFound(`No faction "${r.code}" sells ships here.`);
        document.title = page.title + " · X4 Ship Evaluator";
        out.innerHTML = toggles + page.html;
        enhance(out);
      } else {
        const s = findShip(D, det, r);
        if (!s) return notFound(`No ship "${r.key}" among the ${r.hull.toUpperCase()} ships${r.mod !== "swi" ? " of " + (src.mods[r.mod] || r.mod) : ""}.`);
        document.title = `${s.name} · X4 Ship Evaluator`;
        out.innerHTML = toggles + renderShip(c, s);
        enhance(out);
        if (cfg.sections.loadouts && G.X4Opt) {
          setTimeout(() => {
            let html;
            try { html = loadoutHtml(c, s, loadouts(D, s, G.X4Opt), ctxHelpers(c)); } catch (e) { html = `<p class="warn">Could not work out the loadouts: ${esc(e.message)}</p>`; }
            const box = document.getElementById("loadouts");
            if (box) box.innerHTML = html;
          }, 30);
        }
      }
      out.querySelectorAll("input[data-mod]").forEach((x) => (x.onchange = () => {
        src.setMods([...out.querySelectorAll("input[data-mod]:checked")].map((y) => y.dataset.mod).filter((m) => m !== r.mod || enabled.includes(m)));
        show().catch(fail);
      }));
    }
    const fail = (e) => { status.className = "warn"; status.textContent = "Could not load the data: " + e.message; };
    show().catch(fail);
  }

  return { CONFIG, route, shipPath, findShip, renderShip, renderIndex, loadouts, boot };
});
