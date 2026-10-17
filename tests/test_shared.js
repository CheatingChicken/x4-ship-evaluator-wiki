// node tests/test_shared.js
// The shared front end must be exactly what tools/sync_shared.py copied from the local repo.
// Edits belong in CheatingChicken/x4-ship-evaluator; a file changed here would be lost on the
// next sync.
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");

const script = path.join(__dirname, "..", "tools", "sync_shared.py");
const run = (py) => execFileSync(py, [script, "--check"], { encoding: "utf-8" });
try {
  let out;
  try { out = run("python"); } catch (e) { if (e.code !== "ENOENT") throw e; out = run("python3"); }  // Linux CI has python3
  process.stdout.write(out);
} catch (e) {
  process.stdout.write(e.stdout || "");
  console.error("shared files out of sync (see above)");
  process.exit(1);
}
