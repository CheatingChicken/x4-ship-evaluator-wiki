/* Built-in rating profiles (sparse: only what differs from the defaults, see profile.js).
 * A script rather than JSON files, because a page opened from disk cannot fetch. Community
 * profiles are shared as .json files or share codes and imported on the page. */
window.X4PRESETS = [
  {
    id: "default",
    profile: { format: "x4-ship-evaluator/profile", version: 1, name: "Default", author: "x4-ship-evaluator",
      notes: "The evaluator's built-in judgement: traders by cargo throughput per trip, miners by yield, combat by sustained firepower and toughness, everything with an eye on price." },
  },
  {
    id: "safe-hauler",
    profile: { format: "x4-ship-evaluator/profile", version: 1, name: "Safe hauler", author: "x4-ship-evaluator",
      notes: "For long trade routes through contested space: longer legs, shields always fitted, defence weighs more, and no freighter below 5,000 m³.",
      roles: {
        trader: { weights: { throughput: 5, cargo: 3, efficiency: 2, price: 1 },
                  metrics: { cargo: { min: 5000 }, throughput: { reference: "size" } },
                  slots: { require: { shield: true } } },
      },
      threats: { contested: { defence: 4 }, dangerous: { defence: 6 } },
      trip: { km: 100 } },
  },
  {
    id: "pirate-hunter",
    profile: { format: "x4-ship-evaluator/profile", version: 1, name: "Pirate hunter", author: "x4-ship-evaluator",
      notes: "Dedicated warships only, every gun and shield slot filled, no repair or tractor beams. Firepower and toughness are measured against ships of the same size, so a good corvette is not buried under capital ships.",
      roles: {
        combat: { weights: { forwardDps: 5, burstDps: 2, shield: 4, hull: 3, turnRate: 3, maxSpeed: 2, boostSpeed: 2, price: 1, missiles: 0, hangar: 0 },
                  metrics: { forwardDps: { reference: "size" }, shield: { reference: "size" }, hull: { reference: "size" },
                             turretDps: { reference: "size" }, turnRate: { curve: "sqrt" } },
                  slots: { require: { shield: true, weapon: true }, exclude: ["repair", "utility"] },
                  purposes: ["fight"] },
      } },
  },
];
