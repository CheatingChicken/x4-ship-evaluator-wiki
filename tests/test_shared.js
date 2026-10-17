// node tests/test_shared.js
// The shared front end must be exactly what tools/sync_shared.py copied from the local repo.
// Edits belong in CheatingChicken/x4-ship-evaluator; a file changed here would be lost on the
// next sync.
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");

try {
  const out = execFileSync("python", [path.join(__dirname, "..", "tools", "sync_shared.py"), "--check"], { encoding: "utf-8" });
  process.stdout.write(out);
} catch (e) {
  process.stdout.write(e.stdout || "");
  console.error("shared files out of sync (see above)");
  process.exit(1);
}
