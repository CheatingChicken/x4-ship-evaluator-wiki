/* Built-in rating profiles (sparse: only what differs from the defaults, see profile.js).
 * A script rather than JSON files, because a page opened from disk cannot fetch. Community
 * profiles are shared as .json files or share codes and imported on the page. */
window.X4PRESETS = [
  {
    id: "default",
    profile: { format: "x4-ship-evaluator/profile", version: 1, name: "Default", author: "x4-ship-evaluator",
      notes: "The standard weights. Traders are rated by cargo moved per trip, miners by yield, and warships by sustained firepower and toughness. Price counts for all of them." },
  },
  {
    id: "safe-hauler",
    profile: { format: "x4-ship-evaluator/profile", version: 1, name: "Safe hauler", author: "x4-ship-evaluator",
      notes: "For long trade routes through contested space. It assumes longer legs, always fits shields, gives defence more weight and leaves out freighters under 5,000 m³.",
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
      notes: "Rates dedicated warships only, with every gun and shield slot filled and no repair or tractor beams. Firepower and toughness are compared within each ship size, so a strong corvette still ranks high next to capital ships.",
      roles: {
        combat: { weights: { forwardDps: 5, burstDps: 2, shield: 4, hull: 3, turnRate: 3, maxSpeed: 2, boostSpeed: 2, price: 1, missiles: 0, hangar: 0 },
                  metrics: { forwardDps: { reference: "size" }, shield: { reference: "size" }, hull: { reference: "size" },
                             turretDps: { reference: "size" }, turnRate: { curve: "sqrt" } },
                  slots: { require: { shield: true, weapon: true }, exclude: ["repair", "utility"] },
                  purposes: ["fight"] },
      } },
  },
];
