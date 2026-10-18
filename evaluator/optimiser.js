/* Ship evaluation and loadout search over window.X4DATA (see x4cat/export.py).
 *
 * No DOM here: app.js drives it in the browser, tests/test_optimiser.js drives it in node.
 *
 * A LOADOUT is { engine: partIndex, thruster: partIndex, groups: [partIndex | null, ...] },
 * one entry per slot group of the ship; null leaves the group empty (weapons, turrets and
 * shields may be empty, engines may not). Every slot in a group carries the same part.
 *
 * SCORE = sum over the role's metrics of weight x normalised value. A metric is normalised by a
 * SCALE: its best value over the ships being compared, so 1.0 means "as good as the best one".
 * Metrics where less is better (price, charge time) score scale / value instead.
 *
 * SEARCH is coordinate ascent: from the cheapest valid loadout, each part choice in turn
 * (engine, thruster, every group) is set to the candidate that scores best with the others
 * held, until a full pass changes nothing. Additive metrics (DPS, shield) make that exact per
 * group; the pass loop handles the ones that are not (cargo x speed per credit). With a fitted
 * price limit, no choice may take the total over it.
 */
(function (root) {
  "use strict";

  const DEG = 180 / Math.PI;

  // ---------------------------------------------------------------- roles and metrics
  // fn(m) reads the metric from the evaluated stats object. better: +1 more is better, -1 less.
  const METRICS = {
    cargo:        { label: "Cargo",            unit: "m³",   better: +1, fn: (m) => m.cargo },
    travelSpeed:  { label: "Travel speed",     unit: "m/s",  better: +1, fn: (m) => m.travelSpeed },
    maxSpeed:     { label: "Max speed",        unit: "m/s",  better: +1, fn: (m) => m.maxSpeed },
    boostSpeed:   { label: "Boost speed",      unit: "m/s",  better: +1, fn: (m) => m.boostSpeed },
    acceleration: { label: "Acceleration",     unit: "m/s²", better: +1, fn: (m) => m.acceleration },
    chargeTime:   { label: "Travel charge",    unit: "s",    better: -1, fn: (m) => m.chargeTime },
    turnRate:     { label: "Turn rate",        unit: "°/s",  better: +1, fn: (m) => m.turnRate },
    toughness:    { label: "Hull + shield",    unit: "",     better: +1, fn: (m) => m.hull + m.shield },
    shield:       { label: "Shield",           unit: "",     better: +1, fn: (m) => m.shield },
    shieldRegen:  { label: "Shield regen",     unit: "/s",   better: +1, fn: (m) => m.shieldRegen },
    hull:         { label: "Hull",             unit: "",     better: +1, fn: (m) => m.hull },
    price:        { label: "Fitted price",     unit: "Cr",   better: -1, fn: (m) => m.price },
    maintenance:  { label: "Maintenance",      unit: "Cr/30 min", better: -1, fn: (m) => m.maintenance },
    tripTime:     { label: "Trip time",        unit: "s",    better: -1, fn: (m) => m.trip.total },
    throughput:   { label: "Throughput",       unit: "m³/min", better: +1, fn: (m) => (m.trip.total > 0 ? (60 * m.cargo) / m.trip.total : 0) },
    efficiency:   { label: "Throughput / M Cr", unit: "",    better: +1, fn: (m) => (m.trip.total > 0 ? (60 * m.cargo) / m.trip.total : 0) / Math.max(m.price / 1e6, 1e-6) },
    turnTime:     { label: "Turn 90°",         unit: "s",    better: -1, fn: (m) => m.trip.turn },
    miningRate:   { label: "Mining rate",      unit: "",     better: +1, fn: (m) => m.miningRate },
    drones:       { label: "Drones",           unit: "",     better: +1, fn: (m) => m.drones },
    forwardDps:   { label: "Forward DPS",      unit: "",     better: +1, fn: (m) => m.forwardDps },
    burstDps:     { label: "Burst DPS",        unit: "",     better: +1, fn: (m) => m.burstDps },
    turretDps:    { label: "Turret DPS",       unit: "",     better: +1, fn: (m) => m.turretDps },
    missiles:     { label: "Missiles",         unit: "",     better: +1, fn: (m) => m.missiles },
    hangar:       { label: "Hangar",           unit: "ships", better: +1, fn: (m) => m.hangar },
    defence:      { label: "Defence",          unit: "/100", better: +1, fn: (m) => m.defence || 0 },
    crew:         { label: "Crew",             unit: "",     better: +1, fn: (m) => m.crew },
  };

  /* METRIC GROUPS, for the table's group headers; columns are laid out in this order. */
  const METRIC_GROUPS = ["Cargo & trade", "Mobility", "Offence", "Defence", "Capacity"];
  const GROUP_OF = {
    cargo: "Cargo & trade", throughput: "Cargo & trade", efficiency: "Cargo & trade", miningRate: "Cargo & trade", drones: "Cargo & trade",
    tripTime: "Mobility", turnTime: "Mobility", acceleration: "Mobility", travelSpeed: "Mobility", maxSpeed: "Mobility",
    boostSpeed: "Mobility", chargeTime: "Mobility", turnRate: "Mobility",
    forwardDps: "Offence", burstDps: "Offence", turretDps: "Offence", missiles: "Offence",
    defence: "Defence", shield: "Defence", shieldRegen: "Defence", hull: "Defence", toughness: "Defence",
    hangar: "Capacity", crew: "Capacity",
    price: "Price", maintenance: "Price",
  };
  for (const [k, g] of Object.entries(GROUP_OF)) if (METRICS[k]) METRICS[k].group = g;

  /* PURPOSE GROUPS. A ship's <purpose primary> sorted into four groups; the combat role takes the
   * groups ctx.combatPurposes lists (default: all but mining), because a freighter or a shuttle
   * with guns is still a candidate for a fight. */
  const PURPOSE_GROUPS = { fight: "Fighting ships", trade: "Traders & transports", mine: "Miners", other: "Other (auxiliary, building, salvage…)" };
  const DEFAULT_COMBAT_PURPOSES = ["fight", "trade", "other"];
  const purposeGroup = (s) => (s.purpose === "fight" || s.purpose === "trade" || s.purpose === "mine" ? s.purpose : "other");

  /* DEFENCE RATING, 0..100, for ships whose job is not fighting. Each part is measured against
   * the best value reachable IN THE SAME SIZE CLASS among the ships being compared (see
   * defenceRefs), because against the toughest ship of the whole list a shield on an M freighter
   * moves nothing and the optimiser rightly drops it as dead weight. */
  // Shield and hull are NOT interchangeable hit points: a shield regenerates, so it absorbs every
  // stray hit for free, while each point of hull damage is permanent and paid for in repairs.
  // Shield capacity and regeneration together therefore weigh most; hull is the last line.
  const DEFENCE_PARTS = [
    { key: "shield", weight: 0.35, label: "shield capacity" },
    { key: "regen", weight: 0.20, label: "shield regen" },
    { key: "hull", weight: 0.15, label: "hull" },
    { key: "pd", weight: 0.15, label: "self-defence DPS (turrets + guns)" },
    { key: "escape", weight: 0.15, label: "boost speed" },
  ];

  /* THREAT PROFILES for traders and miners: loadout rules plus the weight defence gets.
   * require.<kind>: every slot group of that kind must carry a part (no empty option), where the
   * player can buy one that fits. */
  // Shields are required in every profile but the explicit opt-out: without them every stray hit
  // is permanent hull damage.
  const THREATS = {
    unprotected: { label: "Unprotected", require: {},                             defence: 0,
                   tip: "No requirements. Slots may stay empty and defence is ignored. Use this for expendable ships." },
    safe:        { label: "Safe",        require: { shield: true },               defence: 1,
                   tip: "For quiet space. Every shield slot gets at least the cheapest shield. Turrets are optional." },
    contested:   { label: "Contested",   require: { shield: true },               defence: 3,
                   tip: "For space with pirates. Every shield slot is filled and defence counts toward the score." },
    dangerous:   { label: "Dangerous",   require: { shield: true, turret: true, weapon: true }, defence: 5,
                   tip: "For war zones. Every shield, turret and weapon slot is filled and defence counts heavily." },
  };

  // Default weights per role. A metric at weight 0 still gets its table column and slider; it only
  // stops counting towards the score (combat's travel speed: shown for reference, not rated).
  const ROLES = {
    // Throughput (cargo per minute over the trip model below) is what top speed, acceleration,
    // charge time and turning add up to for a hauler; their own sliders start at 0 or 1.
    trader: { label: "Trader", threats: true, trip: true, weights: { throughput: 5, cargo: 2, tripTime: 1, turnTime: 1, acceleration: 1, travelSpeed: 0, maxSpeed: 0, chargeTime: 0, defence: 1, price: 2, efficiency: 3, crew: 0, maintenance: 0 } },
    miner:  { label: "Miner",  threats: true, trip: true, weights: { throughput: 3, miningRate: 4, drones: 4, cargo: 2, tripTime: 1, turnTime: 1, acceleration: 1, travelSpeed: 0, maxSpeed: 0, defence: 1, price: 2, efficiency: 2, crew: 0, maintenance: 0 } },
    combat: { label: "Combat", weights: { forwardDps: 4, turretDps: 3, burstDps: 1, shield: 3, shieldRegen: 1, hull: 3, maxSpeed: 2, boostSpeed: 1, acceleration: 2, turnRate: 2, turnTime: 2, missiles: 1, hangar: 1, price: 2, travelSpeed: 0, crew: 0, maintenance: 0 } },
  };

  // ---------------------------------------------------------------- availability
  /* ctx.factions: Set of faction ids whose shipyards are in reach.
   * ctx.useSave applies the imported save (ctx.player):
   *   - galaxy: a faction sells a ship only if it has a shipyard building that size, and parts
   *     only if it has an equipment dock. Under SW Interworlds the vanilla factions still own
   *     wares but have no stations, so without this they would sell everything.
   *   - licences: a faction sells only items whose licence it has granted the player.
   * ctx.playerBuild: Set of ware ids the player faction can build itself, available regardless. */
  const SHIPYARD_SIZE = { xs: "s", s: "s", m: "m", l: "l", xl: "xl" };

  function factionSells(f, item, ctx) {
    if (!ctx.factions.has(f)) return false;
    if (!ctx.useSave || !ctx.player) return true;
    const galaxy = ctx.player.galaxy;
    if (galaxy) {
      const g = galaxy[f];
      if (!g) return false;
      if (item.purpose !== undefined) {           // a ship
        if (!g.ships.includes(SHIPYARD_SIZE[item.size] || item.size)) return false;
      } else if (!g.equipment) {
        return false;
      }
    }
    if (!item.licence) return true;
    return ((ctx.player.licences || {})[item.licence] || []).includes(f);
  }

  /* What stops faction f from selling a ship to the player, per the save: [] means it will sell.
   * Unlike factionSells it ignores the faction filter and also checks docking, so the table can
   * show every owner and say why one is out of reach. Without a save nothing is known: null. */
  function buyBlockers(f, ship, player) {
    if (!player) return null;
    const out = [];
    const g = player.galaxy && player.galaxy[f];
    const size = SHIPYARD_SIZE[ship.size] || ship.size;
    if (player.galaxy && !g) out.push("no stations in your galaxy");
    else if (g && !g.ships.includes(size)) out.push("no shipyard for " + size.toUpperCase() + " ships");
    const a = player.access && player.access[f];
    if (a && !a.dock) out.push("hostile: will not dock you");
    if (ship.licence && !((player.licences || {})[ship.licence] || []).includes(f)) out.push("no " + ship.licence + " licence");
    return out;
  }

  /* Hangar: how many S and M ships it carries. Every ship also has an XS storage (dock_xs, ten
   * places, shipstorage_gen_xs_01) for XS craft such as spacesuits and mass-traffic drones;
   * that is not a hangar in any sense the player would rank by. */
  const HANGAR_SIZES = ["dock_s", "dock_m"];
  const hangarShips = (ship) => Object.entries(ship.hangar || {})
    .filter(([k]) => k.split(" ").some((t) => HANGAR_SIZES.includes(t)))
    .reduce((a, [, n]) => a + (n || 0), 0);

  function sellerOk(item, ctx) {
    if (ctx.playerBuild && ctx.playerBuild.has(item.ware)) return true;
    // Thrusters list no seller at all (vanilla and SW Interworlds alike; they are virtual parts),
    // yet a ship cannot be bought without them (the shipyard menu's thruster slot does not allow
    // empty). Read "no seller" as "comes with any hull, anywhere"; without this no ship had a
    // thruster and the trip model scored them as turning instantly.
    if (item.kind === "thruster" && !item.owners.length) return true;
    return item.owners.some((f) => factionSells(f, item, ctx));
  }

  // ---------------------------------------------------------------- evaluation
  function evaluate(data, ship, lo, ctx) {
    const P = data.parts;
    const eng = lo.engine != null ? ship.engines[lo.engine] : null;
    const thr = lo.thruster != null ? ship.thrusters[lo.thruster] : null;
    const m = {
      cargo: ship.cargo[ctx.cargoType || "container"] || 0,
      maxSpeed: eng ? eng.ForwardSpeed : 0, boostSpeed: eng ? eng.BoostSpeed : 0,
      travelSpeed: eng ? eng.TravelSpeed : 0, acceleration: eng ? eng.ForwardAcceleration : 0,
      chargeTime: eng ? eng.TravelChargeTime : 0, turnRate: thr ? thr.YawSpeed * DEG : 0, // game reports rad/s
      hull: ship.hull, shield: 0, shieldRegen: 0, miningRate: 0, drones: ship.drones, crew: ship.crew || 0,
      forwardDps: 0, burstDps: 0, turretDps: 0, missiles: ship.missiles,
      hangar: hangarShips(ship),
      price: ship.price,
      maintenance: maintenanceOf(ship),
    };
    if (lo.engine != null) m.price += P[lo.engine].price * (eng ? eng.engines : 1);
    if (lo.thruster != null) m.price += P[lo.thruster].price;
    ship.groups.forEach((g, i) => {
      const pi = lo.groups[i];
      if (g.kind === "engine" || pi == null) return;
      const p = P[pi], s = p.stats, n = g.count;
      m.price += p.price * n;
      if (g.kind === "shield") {
        m.shield += (s.ShieldValue || 0) * n;
        m.shieldRegen += (s.ShieldRate || 0) * n;
      } else if (p.mining) {
        m.miningRate += (s.MiningRate || 0) * n;
      } else if (g.kind === "weapon") {
        m.forwardDps += (s.SustainedDPS || 0) * n;
        m.burstDps += (s.BurstDPS || 0) * n;
      } else if (g.kind === "turret") {
        m.turretDps += (s.TurretSustainedDPS || 0) * n;
      }
    });
    m.trip = trip(eng, thr, ctx.tripDistance || DEFAULT_TRIP);
    if (ctx.defenceRefs) m.defence = defenceOf(m, ship, ctx.defenceRefs);
    return m;
  }

  /* TRIP MODEL: one leg of a haul from standstill, the time that speed, acceleration, charge and
   * turning actually cost.
   *   charge   travel-drive charge time
   *   turn     swinging 90 degrees onto course: yaw rate limited by yaw acceleration
   *   move     the distance under travel drive: accelerate, cruise, decelerate (a triangle profile
   *            when the leg is too short to reach travel speed)
   * Engines and thrusters give exact (probe-verified) travel speed, travel acceleration and yaw
   * rate; travel deceleration and yaw acceleration are formula values the game does not report. */
  const DEFAULT_TRIP = 50000;  // metres
  const TRIP = { turn: 90 };   // degrees turned onto course; configurable (configure())

  /* MAINTENANCE (SW Interworlds, md/sw_maintenance.xml and md/sw_reactivemain.xml). Every 30
   * minutes each player ship except XS costs its threatscore (ship.threat: its macro's own value,
   * else SWI's default for its class and purpose) times the empire-size multiplier, paid in ship
   * supplies (2 per point, at owned equipment docks) or else in credits, 5,000 Cr per point. Ships
   * docked at a suitable dock of the player's pay 75%. SWI sets the empire size from the value of the
   * player's assets. The metric is one ship's credit cost in open space; the empire size is a
   * rating-profile setting (configure()). */
  const EMPIRE_LEVELS = [
    { name: "Privateer", assets: "assets under 150 M Cr", mult: 0 },
    { name: "Private Company", assets: "150 to 300 M Cr", mult: 0.3 },
    { name: "Organisation", assets: "300 to 600 M Cr", mult: 0.6 },
    { name: "Corporation", assets: "600 M to 1 B Cr", mult: 1.0 },
    { name: "Major Faction", assets: "1 to 1.5 B Cr", mult: 1.5 },
    { name: "Empire", assets: "1.5 B Cr and more", mult: 2.0 },
  ];
  const MAINTENANCE_CREDITS = 5000;  // per threatscore point not covered by ship supplies
  // empire: index into EMPIRE_LEVELS (rating profile, configure()); scale: the player's own game,
  // 1 as SWI ships it, 0 where a mod turns maintenance off (page Settings, setMaintenanceScale()).
  const MAINTENANCE = { empire: 3, scale: 1 };
  const maintenanceOf = (ship) => (ship.threat || 0) * EMPIRE_LEVELS[MAINTENANCE.empire].mult * MAINTENANCE_CREDITS * MAINTENANCE.scale;
  function setMaintenanceScale(v) { MAINTENANCE.scale = isFinite(+v) ? Math.min(10, Math.max(0, +v)) : 1; }

  function ramp(dist, vmax, acc, dec) {
    if (!(vmax > 0) || !(acc > 0)) return Infinity;
    dec = dec > 0 ? dec : acc;
    const dRamp = (vmax * vmax) / (2 * acc) + (vmax * vmax) / (2 * dec);
    if (dRamp <= dist) return vmax / acc + vmax / dec + (dist - dRamp) / vmax;
    const v = Math.sqrt((2 * dist * acc * dec) / (acc + dec));  // peak speed of a triangle profile
    return v / acc + v / dec;
  }

  function trip(eng, thr, dist) {
    const out = { charge: 0, turn: 0, move: Infinity, total: Infinity, reachesTop: false };
    if (!eng) return out;
    out.charge = eng.TravelChargeTime || 0;
    if (thr && thr.YawSpeed > 0) {
      const w = thr.YawSpeed * DEG, a = (thr.YawAcceleration || 0) * DEG;
      out.turn = a > 0 ? ramp(TRIP.turn, w, a, a) : TRIP.turn / w;
    }
    out.move = ramp(dist, eng.TravelSpeed, eng.TravelAcceleration, eng.TravelDeceleration);
    const v = eng.TravelSpeed, acc = eng.TravelAcceleration, dec = eng.TravelDeceleration || acc;
    out.reachesTop = v > 0 && acc > 0 && (v * v) / (2 * acc) + (v * v) / (2 * dec) <= dist;
    out.total = out.charge + out.turn + out.move;
    return out;
  }

  function defenceParts(m) {
    // Self-defence counts forward guns as well as turrets: a trader's gun slots are not dead weight.
    return { shield: m.shield, regen: m.shieldRegen, hull: m.hull, pd: m.turretDps + m.forwardDps, escape: m.boostSpeed };
  }

  function defenceOf(m, ship, refs) {
    const ref = refs[ship.size];
    if (!ref) return 0;
    const v = defenceParts(m);
    let total = 0;
    for (const d of DEFENCE_PARTS) if (ref[d.key] > 0) total += d.weight * Math.min(1, v[d.key] / ref[d.key]);
    return 100 * total;
  }

  /* Best reachable value per defence part and size class: hull plus the strongest buyable shield
   * in every shield slot, the strongest non-mining turret in every turret slot, the fastest
   * buyable engine. Independent of weights, so the yardstick does not move with the sliders. */
  function defenceRefs(data, ships, ctx) {
    const refs = {};
    const best = (list, f) => list.reduce((b, i) => (i == null ? b : Math.max(b, f(data.parts[i]))), 0);
    for (const s of ships) {
      const c = candidates(data, s, Object.assign({}, ctx, { role: "trader" }));
      let shield = 0, regen = 0, pd = 0;
      s.groups.forEach((g, i) => {
        if (g.kind === "shield") {
          shield += g.count * best(c.groups[i], (p) => p.stats.ShieldValue || 0);
          regen += g.count * best(c.groups[i], (p) => p.stats.ShieldRate || 0);
        } else if (g.kind === "turret") {
          pd += g.count * best(c.groups[i], (p) => (p.mining ? 0 : p.stats.TurretSustainedDPS || 0));
        } else if (g.kind === "weapon") {
          pd += g.count * best(c.groups[i], (p) => (p.mining ? 0 : p.stats.SustainedDPS || 0));
        }
      });
      const escape = Math.max(0, ...c.engines.map((e) => (s.engines[e] || {}).BoostSpeed || 0));
      const r = refs[s.size] = refs[s.size] || { shield: 0, regen: 0, hull: 0, pd: 0, escape: 0, ships: 0 };
      r.ships += 1;  // how many ships the yardstick rests on: with one, a ship is measured against itself
      r.shield = Math.max(r.shield, shield); r.hull = Math.max(r.hull, s.hull); r.regen = Math.max(r.regen, regen);
      r.pd = Math.max(r.pd, pd); r.escape = Math.max(r.escape, escape);
    }
    return refs;
  }

  /* RULES per role, from the active rating profile (configure()): per metric a score curve, the
   * reference it is measured against and optional limits; slot rules; ship purposes. Empty means
   * the built-in behaviour: linear, against the best in the list, no limits, no slot rules. */
  const RULES = {};
  const DEFAULT_RULE = { curve: "linear", target: 0, reference: "list", fixed: 0, min: null, max: null };
  const rulesOf = (role) => (RULES[role] && RULES[role].metrics) || {};

  // The value a metric is measured against: a target, defence's own 0..100 scale, a fixed number,
  // or the scale rank() found (a number, or {s, m, l, xl} for "best of the same size").
  function refOf(k, rule, scales, size) {
    if (rule.curve === "target") return rule.target;
    if (k === "defence") return 100;
    if (rule.reference === "fixed") return rule.fixed;
    const sc = scales[k];
    return sc && typeof sc === "object" ? sc[size] || 0 : sc || 0;
  }
  const CURVE = { linear: (n) => n, sqrt: (n) => Math.sqrt(n), log: (n) => Math.log10(1 + 9 * n), target: (n) => n };

  /* EXPLAIN: what each weighted metric contributes. n = value against its reference (inverted for
   * "less is better"), through the curve; points = n's share of 100 by weight; lost = what a
   * perfect value would have added. score() is the sum of the points, so the two never disagree.
   * opts.cap: each metric counts at most 100% of its reference. The final scores are capped (and,
   * against the list's best final values, never exceed it anyway). The SEARCH is not: its scales
   * come from an earlier pass, and a ship already past one of them would see further gains there
   * as worth nothing while their price still counts, so it left slots empty (a Kihraxz with one of
   * five gun slots bare, because four guns already beat the pass-1 best). A "target" curve is
   * always capped: past the target is worth nothing by definition.
   * opts.rules: the role's metric rules; opts.size: the ship's size, for per-size references. */
  function explain(m, weights, scales, opts) {
    opts = opts || {};
    const rules = opts.rules || {}, cap = opts.cap !== false;
    const out = [];
    let wsum = 0;
    for (const [k, w] of Object.entries(weights)) {
      if (!w) continue;
      const M = METRICS[k], rule = rules[k] || DEFAULT_RULE, v = M.fn(m);
      const ref = refOf(k, rule, scales, opts.size);
      // Measured against "the best of the same size" where no ship of this size has any (turrets
      // on S fighters): not applicable, so it costs nothing and its weight goes to the others.
      if (rule.reference === "size" && rule.curve !== "target" && k !== "defence" && !(ref > 0)) continue;
      let n = 0;
      if (ref > 0) n = M.better > 0 ? v / ref : (v > 0 ? ref / v : 1);
      n = (CURVE[rule.curve] || CURVE.linear)(Math.max(0, n));
      if (cap || rule.curve === "target") n = Math.min(n, 1);
      out.push({ key: k, value: v, reference: ref, n, weight: w, curve: rule.curve });
      wsum += w;
    }
    for (const e of out) {
      e.points = (100 * e.weight * e.n) / wsum;
      e.lost = Math.max(0, (100 * e.weight * (1 - e.n)) / wsum);
    }
    return out;
  }

  function score(m, weights, scales, cap = true, opts) {
    let total = 0;
    for (const e of explain(m, weights, scales, Object.assign({}, opts, { cap }))) total += e.points;
    return total;
  }

  /* LIMITS: how far a fit misses the role's min/max rules, as a sum of relative shortfalls; 0 when
   * it meets them all. The search subtracts LIMIT_PENALTY per unit, so ascent walks towards a fit
   * that meets them before it optimises anything else. */
  const LIMIT_PENALTY = 1000;
  function violation(m, rules) {
    let v = 0;
    for (const [k, r] of Object.entries(rules)) {
      if (r.min == null && r.max == null) continue;
      const x = METRICS[k].fn(m);
      if (r.min != null && x < r.min) v += (r.min - x) / Math.max(Math.abs(r.min), 1e-9);
      if (r.max != null && x > r.max) v += (x - r.max) / Math.max(Math.abs(r.max), 1e-9);
    }
    return v;
  }
  // The search's objective: uncapped score, less the limit penalty. Exported for the brute-force test.
  const objective = (m, weights, scales, opts) =>
    score(m, weights, scales, false, opts) - LIMIT_PENALTY * violation(m, (opts && opts.rules) || {});

  // Metrics the hull alone decides: limits on these filter the shortlist before any fitting.
  const HULL_METRICS = ["cargo", "hull", "drones", "missiles", "hangar", "crew", "maintenance"];
  const hullValues = (s, ctx) => ({ cargo: s.cargo[ctx.cargoType || "container"] || 0, hull: s.hull, drones: s.drones,
                                    missiles: s.missiles, hangar: hangarShips(s), crew: s.crew || 0, maintenance: maintenanceOf(s) });

  // A part's use (x4cat/export.py part_use); data exported before that field existed falls back.
  const LAUNCHER_KINDS = ["missilelauncher", "bomblauncher", "missileturret"];
  const useOf = (p) => p.use || (LAUNCHER_KINDS.includes(p.kind) ? "launcher" : p.mining ? "mining" : p.kind);

  // ---------------------------------------------------------------- candidates
  function candidates(data, ship, ctx) {
    // Slot rules of the role (rating profile): required kinds join the threat profile's, and
    // excluded uses and banned parts never enter the search.
    const slots = (RULES[ctx.role] && RULES[ctx.role].slots) || {};
    const ban = new Set(slots.ban || []), exclude = new Set(slots.exclude || []);
    const ok = (i) => sellerOk(data.parts[i], ctx) && !ban.has(data.parts[i].id);
    const engines = Object.keys(ship.engines).map(Number).filter(ok);
    const thrusters = Object.keys(ship.thrusters).map(Number).filter(ok);
    const require = Object.assign({}, ctx.require || {});
    for (const [k, on] of Object.entries(slots.require || {})) if (on) require[k] = true;
    const groups = ship.groups.map((g) => {
      if (g.kind === "engine") return [null];
      let c = g.cands.filter((i) => ok(i) && !exclude.has(useOf(data.parts[i])));
      if (ctx.role !== "miner") c = c.filter((i) => !data.parts[i].mining);
      // A required kind loses its empty option, unless nothing buyable fits the group at all.
      // Mining groups on a miner stay free: they get mining parts, not guns.
      const mustFill = require[g.kind] && c.length && !(ctx.role === "miner" && g.mining);
      if (mustFill && (g.kind === "turret" || g.kind === "weapon")) c = c.filter((i) => !data.parts[i].mining);
      return mustFill && c.length ? c : [null].concat(c);
    });
    return { engines, thrusters, groups };
  }

  function cheapest(data, list) {
    let best = null;
    for (const i of list) if (best === null || (i !== null && data.parts[i].price < data.parts[best].price)) best = i;
    return best;
  }

  /* pins: { engine?, thruster?, groups?: {groupIndex: partIndex|null} } fix choices.
   * Returns { loadout, metrics, score } or null when the ship cannot be fitted (no engine).
   *
   * Two starts, best kept. From the cheapest loadout, ascent can spend a tight budget on an
   * early upgrade that blocks a better combination; from the unconstrained best, cut down to the
   * budget by shedding whatever loses least score per credit saved, it starts on the far side of
   * that trap. tests/test_optimiser.js measures the remaining gap against brute force. */
  function optimise(data, ship, ctx, weights, scales, pins) {
    pins = pins || {};
    const c = candidates(data, ship, ctx);
    if (pins.engine == null && !c.engines.length) return null;
    const limit = ctx.priceBasis === "fitted" && ctx.priceMax > 0 ? ctx.priceMax : Infinity;

    const choices = [];
    if (pins.engine == null) choices.push(["engine", null, c.engines]);
    if (pins.thruster == null && c.thrusters.length) choices.push(["thruster", null, c.thrusters]);
    ship.groups.forEach((g, i) => { if (g.kind !== "engine" && !(pins.groups && i in pins.groups)) choices.push(["group", i, c.groups[i]]); });
    const get = (lo, what, gi) => (what === "group" ? lo.groups[gi] : lo[what]);
    const set = (lo, what, gi, v) => { if (what === "group") lo.groups[gi] = v; else lo[what] = v; };
    const opts = { rules: rulesOf(ctx.role), size: ship.size };
    const evalAt = (lo, lim) => { const m = evaluate(data, ship, lo, ctx); return { m, s: m.price > lim ? -Infinity : objective(m, weights, scales, opts) }; };

    const cheapLoadout = () => ({
      engine: pins.engine != null ? pins.engine : cheapest(data, c.engines),
      thruster: pins.thruster != null ? pins.thruster : (c.thrusters.length ? cheapest(data, c.thrusters) : null),
      // Empty where allowed; where a group must be filled (no null among its candidates) the
      // cheapest part, since the search only moves to options that score better than where it
      // starts and an empty start would never leave a required group.
      groups: ship.groups.map((g, i) => (pins.groups && i in pins.groups) ? pins.groups[i]
        : (g.kind !== "engine" && !c.groups[i].includes(null) ? cheapest(data, c.groups[i]) : null)),
    });

    function ascend(lo, lim) {
      let cur = evalAt(lo, lim);
      for (let pass = 0; pass < 6; pass++) {
        let changed = false;
        for (const [what, gi, list] of choices) {
          const keep = get(lo, what, gi);
          let bestV = keep, bestS = cur.s;
          for (const cand of list) {
            if (cand === keep) continue;
            set(lo, what, gi, cand);
            const r = evalAt(lo, lim);
            if (r.s > bestS + 1e-9) { bestS = r.s; bestV = cand; }
          }
          set(lo, what, gi, bestV);
          if (bestV !== keep) { changed = true; cur = evalAt(lo, lim); }
        }
        if (!changed) break;
      }
      return { loadout: lo, metrics: cur.m, score: cur.s };
    }

    const done = (r) => Object.assign(r, { violation: violation(r.metrics, opts.rules) });
    let best = ascend(cheapLoadout(), limit);
    if (limit !== Infinity) {
      const lo = ascend(cheapLoadout(), Infinity).loadout;
      // Shed: the single change with the least score lost per credit saved, until within budget.
      for (let guard = 0; guard < 200; guard++) {
        const now = evalAt(lo, Infinity);
        if (now.m.price <= limit) break;
        let pick = null;
        for (const [what, gi, list] of choices) {
          const keep = get(lo, what, gi);
          for (const cand of list) {
            if (cand === keep) continue;
            set(lo, what, gi, cand);
            const r = evalAt(lo, Infinity);
            const saved = now.m.price - r.m.price;
            if (saved > 0) {
              const cost = (now.s - r.s) / saved;
              if (!pick || cost < pick.cost) pick = { what, gi, cand, cost };
            }
          }
          set(lo, what, gi, keep);
        }
        if (!pick) break;
        set(lo, pick.what, pick.gi, pick.cand);
      }
      const second = ascend(lo, limit);
      if (second.score > best.score) best = second;
    }
    return done(best);
  }

  /* VARIANTS. A ship can be fitted several ways, and each way is its own result row:
   *   threat   one per profile in ctx.threats (roles without threat profiles: just one). The
   *            profile sets the required slots and the defence weight.
   *   source   ctx.sourcing holds "mixed" and/or "single".
   *            mixed:  parts from every selected shipyard, plus player production.
   *            single: one variant per faction that sells this hull, fitted only from that
   *                    faction's own equipment, without player production: everything on one
   *                    visit to one shipyard. */
  function variants(data, ship, ctx, weights) {
    const out = [];
    const threats = ROLES[ctx.role] && ROLES[ctx.role].threats
      ? ((ctx.threats && ctx.threats.length) ? ctx.threats : ["safe"]) : [null];
    const sourcing = ctx.sourcing || new Set(["mixed"]);
    for (const t of threats) {
      const T = t ? THREATS[t] : null;
      const w = Object.assign({}, weights, T ? { defence: T.defence } : {});
      const base = Object.assign({}, ctx, { require: T ? T.require : {} });
      if (sourcing.has("mixed")) out.push({ threat: t, source: "mixed", ctx: base, weights: w });
      if (sourcing.has("single")) {
        for (const f of ship.owners) {
          if (factionSells(f, ship, ctx)) {
            out.push({ threat: t, source: f, weights: w,
                       ctx: Object.assign({}, base, { factions: new Set([f]), playerBuild: new Set() }) });
          }
        }
      }
    }
    return out;
  }

  const signature = (lo) => JSON.stringify([lo.engine, lo.thruster, lo.groups]);

  /* Ranks every variant of every ship (per ship: one variant per selling faction per threat
   * profile, plus one mixed variant per threat profile), then MERGES, per ship, all variants that
   * end up with the identical loadout into one row. A row therefore says: this fit, buyable at
   * these shipyards, serving these threat profiles.
   *   score    the best score among its members (profiles weigh defence differently, so the
   *            same fit scores differently per profile); members lists each.
   *   sources  the factions selling every part, plus "mixed" when the mixed search found the
   *            same fit: then no combination of shipyards does better.
   *   key/ctx  the representative member: the mixed one when present (its parts list is the
   *            widest, for the editor), else the best-scoring. Pins are stored under this key;
   *            a pin changes the loadout, so a pinned row splits off from the others.
   * Pass 1 fits each variant with unit scales to find what is reachable; the best value per
   * metric over ALL variants becomes its scale; pass 2 refits with those and scores. */
  function rank(data, ships, ctx, weights, pinsByKey) {
    pinsByKey = pinsByKey || {};
    const refs = "defence" in weights ? defenceRefs(data, ships, ctx) : undefined;
    const entries = [];
    for (const s of ships) {
      for (const v of variants(data, s, ctx, weights)) {
        v.ctx.defenceRefs = refs;
        entries.push({ ship: s, v, key: s.id + "|" + v.threat + "|" + v.source });
      }
    }
    const us = unitScales(data, ships, ctx);
    const first = entries.map((e) => optimise(data, e.ship, e.v.ctx, e.v.weights, us, pinsByKey[e.key]));
    const keys = new Set(entries.flatMap((e) => Object.keys(e.v.weights)));
    const rules = rulesOf(ctx.role);
    // The best value per metric over a set of fits: one number, or one per ship size where the
    // profile measures that metric against "the best of the same size".
    const scalesOf = (fits) => {
      const sc = {};
      const best = (k, list) => {
        const vals = list.map((f) => METRICS[k].fn(f.metrics)).filter((v) => v > 0 && isFinite(v));
        return vals.length ? (METRICS[k].better > 0 ? Math.max(...vals) : Math.min(...vals)) : 0;
      };
      for (const k of keys) {
        if ((rules[k] || DEFAULT_RULE).reference === "size") {
          sc[k] = {};
          for (const z of new Set(fits.map((f) => f.size))) sc[k][z] = best(k, fits.filter((f) => f.size === z));
        } else sc[k] = best(k, fits);
      }
      // Defence is already 0..100 against per-size references; rescaling it to the list's best ship
      // would bring back the size bias it exists to remove.
      if (keys.has("defence")) sc.defence = 100;
      return sc;
    };
    const scales = scalesOf(first.map((r, i) => r && { metrics: r.metrics, size: entries[i].ship.size }).filter(Boolean));

    const rows = new Map();  // ship|signature -> merged row
    const limited = new Set(), kept = new Set();
    for (const e of entries) {
      const r = optimise(data, e.ship, e.v.ctx, e.v.weights, scales, pinsByKey[e.key]);
      if (!r || r.score === -Infinity) continue;
      // A fit that cannot meet the profile's limits is dropped; a ship the player picked by hand
      // is kept and flagged instead.
      if (r.violation > 1e-9 && !ctx.focus) { limited.add(e.ship.id); continue; }
      kept.add(e.ship.id);
      const id = e.ship.id + "|" + signature(r.loadout);
      const member = { key: e.key, threat: e.v.threat, source: e.v.source, score: r.score, ctx: e.v.ctx, weights: e.v.weights };
      const row = rows.get(id);
      if (!row) {
        rows.set(id, Object.assign({ ship: e.ship, members: [member] }, r));
        continue;
      }
      row.members.push(member);
      if (r.score > row.score) Object.assign(row, { score: r.score, metrics: r.metrics });
    }
    const out = [...rows.values()];
    for (const row of out) {
      row.members.sort((a, b) => b.score - a.score);
      const rep = row.members.find((m) => m.source === "mixed") || row.members[0];
      row.key = rep.key;
      row.ctx = rep.ctx;
      row.threats = [...new Set(row.members.map((m) => m.threat))].filter((t) => t !== null)
        .sort((a, b) => Object.keys(THREATS).indexOf(a) - Object.keys(THREATS).indexOf(b));
      row.sources = [...new Set(row.members.map((m) => m.source))];
      row.mixedToo = row.sources.includes("mixed");
    }
    // Final scores against the best FINAL value per metric, so 100 means "as good as the best row
    // in this list" exactly. (Pass 2 can beat pass 1's best, which pushed scores past 100.)
    const finalScales = scalesOf(out.map((row) => ({ metrics: row.metrics, size: row.ship.size })));
    for (const row of out) {
      for (const m of row.members) m.score = score(row.metrics, m.weights, finalScales, true, { rules, size: row.ship.size });
      row.members.sort((a, b) => b.score - a.score);
      row.score = row.members[0].score;
    }
    out.sort((a, b) => b.score - a.score);
    // Ships every fit of which missed a limit: the page says how many.
    const droppedByLimits = [...limited].filter((id) => !kept.has(id)).length;
    return { results: out, scales: finalScales, defenceRefs: refs, droppedByLimits };
  }

  // Scales for pass 1: each metric's largest raw value on the ships' own data, so that before
  // any fitting a metric in thousands does not drown one in single digits.
  function unitScales(data, ships, ctx) {
    const sc = {};
    const bump = (k, v) => { if (v > (sc[k] || 0)) sc[k] = v; };
    for (const s of ships) {
      bump("cargo", s.cargo[ctx.cargoType || "container"] || 0);
      bump("hull", s.hull); bump("toughness", s.hull); bump("drones", s.drones); bump("missiles", s.missiles);
      bump("price", s.price);
      bump("maintenance", maintenanceOf(s));
      for (const e of Object.values(s.engines)) {
        bump("maxSpeed", e.ForwardSpeed); bump("travelSpeed", e.TravelSpeed); bump("boostSpeed", e.BoostSpeed);
        bump("acceleration", e.ForwardAcceleration); bump("chargeTime", e.TravelChargeTime);
      }
      for (const t of Object.values(s.thrusters)) bump("turnRate", t.YawSpeed);
    }
    // Equipment: per ship, every group filled with its best fitting part for each stat, summed;
    // the largest over the shortlist. An upper bound of what these ships can reach. (The best part
    // in the whole catalogue times a slot count put a capital gun's 60 M burst DPS against S
    // fighters, which made any fighter gun worth nothing in pass 1.)
    const STATS = [["shield", "shield", "ShieldValue"], ["shieldRegen", "shield", "ShieldRate"],
      ["forwardDps", "weapon", "SustainedDPS"], ["burstDps", "weapon", "BurstDPS"],
      ["turretDps", "turret", "TurretSustainedDPS"], ["miningRate", null, "MiningRate"]];
    for (const s of ships) {
      const sum = {};
      for (const g of s.groups) {
        if (g.kind === "engine") continue;
        for (const [k, kind, stat] of STATS) {
          let best = 0;
          for (const i of g.cands) {
            const p = data.parts[i];
            if (kind ? (g.kind === kind && !p.mining) : p.mining) best = Math.max(best, p.stats[stat] || 0);
          }
          sum[k] = (sum[k] || 0) + best * g.count;
        }
      }
      for (const [k] of STATS) bump(k, sum[k] || 0);
    }
    sc.efficiency = 0; // filled by pass 1 itself: scale 0 counts as "no reference yet"
    sc.hangar = 1;
    sc.defence = 100;  // already a 0..100 rating against per-size references
    sc.throughput = 0; sc.tripTime = 0; sc.turnTime = 0;  // set by pass 1 itself, like efficiency
    return sc;
  }

  // Shipyard filter: role, sizes, sub-types, reachable, price on the hull basis.
  function shortlist(data, ctx) {
    // One ship picked by the player: only that hull, whatever the role, size, price and seller
    // filters say, because it was chosen deliberately. Which PARTS it gets still follows the
    // shipyards and licences; if no selected shipyard sells the hull, only the mixed variant exists.
    if (ctx.focus) return data.ships.filter((s) => s.id === ctx.focus);
    return data.ships.filter((s) => {
      if (!sellerOk(s, ctx)) return false;
      if (ctx.sizes && ctx.sizes.size && !ctx.sizes.has(s.size)) return false;
      // Traders: trade ships holding the chosen cargo type; anyPurpose admits any ship that holds it.
      if (ctx.role === "trader" && !((s.cargo[ctx.cargoType] || 0) > 0 && (s.purpose === "trade" || ctx.anyPurpose))) return false;
      if (ctx.role === "miner" && !(s.purpose === "mine" && s.cargo[ctx.cargoType] > 0)) return false;
      if (ctx.role === "combat" && !(ctx.combatPurposes || DEFAULT_COMBAT_PURPOSES).includes(purposeGroup(s))) return false;
      // Ships without a type (some wiki records) are the sub-role "" ("(no type)" on the page).
      if (ctx.role === "combat" && ctx.types && ctx.types.size && !ctx.types.has(s.type || "")) return false;
      // Laser towers are deployable static defences, not ships to fly: only when asked for.
      if (ctx.role === "combat" && s.type === "lasertower" && !(ctx.types && ctx.types.has("lasertower"))) return false;
      if (ctx.priceBasis !== "fitted") {
        if (ctx.priceMin > 0 && s.price < ctx.priceMin) return false;
        if (ctx.priceMax > 0 && s.price > ctx.priceMax) return false;
      }
      // Profile limits on what the hull alone decides (cargo, hull, hangar, ...).
      const rules = rulesOf(ctx.role), hv = hullValues(s, ctx);
      for (const k of HULL_METRICS) {
        const r = rules[k];
        if (r && ((r.min != null && hv[k] < r.min) || (r.max != null && hv[k] > r.max))) return false;
      }
      return true;
    });
  }

  // After ranking: the fitted-price lower bound (the upper one is enforced during the search).
  function applyFittedFloor(results, ctx) {
    if (ctx.priceBasis !== "fitted" || !(ctx.priceMin > 0)) return results;
    return results.filter((r) => r.metrics.price >= ctx.priceMin);
  }

  /* CONFIGURATION: the parts of the rating that are judgement, not measured game behaviour, can
   * be changed from the page's settings. The verified physics cannot. configure() replaces the
   * current values in place (every function reads them live); DEFAULTS restores them. */
  const DEFAULTS = JSON.parse(JSON.stringify({
    defence: Object.fromEntries(DEFENCE_PARTS.map((d) => [d.key, d.weight])),
    threats: Object.fromEntries(Object.entries(THREATS).map(([k, t]) => [k, { defence: t.defence, require: t.require }])),
    turn: TRIP.turn,
    empire: MAINTENANCE.empire,
  }));

  /* configure(profile): a full rating profile (profile.js resolve()) sets everything below plus
   * the per-role RULES. The older formula-only object ({defence, threats, turn}) still works. */
  function configure(cfg) {
    cfg = cfg || {};
    for (const r of Object.keys(RULES)) delete RULES[r];
    if (cfg.roles) {
      for (const [r, role] of Object.entries(cfg.roles)) {
        RULES[r] = { metrics: role.metrics || {}, slots: role.slots || {}, purposes: role.purposes || [] };
      }
      cfg = { defence: cfg.defence, threats: cfg.threats, turn: cfg.trip && cfg.trip.turn, empire: cfg.maintenance && cfg.maintenance.empire };
    }
    const d = Object.assign({}, DEFAULTS.defence, cfg.defence);
    const total = Object.values(d).reduce((a, b) => a + Math.max(0, +b || 0), 0) || 1;
    for (const part of DEFENCE_PARTS) part.weight = Math.max(0, +d[part.key] || 0) / total;  // always sums to 1
    for (const [k, t] of Object.entries(THREATS)) {
      const c = Object.assign({}, DEFAULTS.threats[k], (cfg.threats || {})[k]);
      t.defence = Math.max(0, +c.defence || 0);
      t.require = { shield: !!(c.require && c.require.shield), turret: !!(c.require && c.require.turret),
                    weapon: !!(c.require && c.require.weapon) };
    }
    TRIP.turn = Math.min(180, Math.max(0, +(cfg.turn != null ? cfg.turn : DEFAULTS.turn) || 0));
    const empire = Math.round(+(cfg.empire != null ? cfg.empire : DEFAULTS.empire));
    MAINTENANCE.empire = isFinite(empire) ? Math.min(EMPIRE_LEVELS.length - 1, Math.max(0, empire)) : DEFAULTS.empire;
  }

  /* LICENCE NAMES for the pages. The game has no faction-independent name for a licence type:
   * every faction names its own ("Imperial Military Ships Access", "Ministry Military Ship
   * Licence"), so the pages use these. No licence at all reads "None". */
  const LICENCE_NAMES = {
    generaluseship: "General use ship", militaryship: "Military ship", capitalship: "Capital ship",
    generaluseequipment: "General use equipment", militaryequipment: "Military equipment", capitalequipment: "Capital equipment",
  };
  const licenceName = (l) => (l ? LICENCE_NAMES[l] || l : "None");

  const api = { LICENCE_NAMES, licenceName, EMPIRE_LEVELS, MAINTENANCE_CREDITS, maintenanceOf, setMaintenanceScale, METRIC_GROUPS, PURPOSE_GROUPS, DEFAULT_COMBAT_PURPOSES, purposeGroup, METRICS, ROLES, THREATS, DEFAULTS, configure, DEFAULT_TRIP, trip, DEFENCE_PARTS, defenceParts, sellerOk, factionSells, buyBlockers, evaluate, score, explain, objective, violation, rulesOf, useOf, HULL_METRICS, candidates, optimise, rank, variants, shortlist, applyFittedFloor };
  root.X4Opt = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
