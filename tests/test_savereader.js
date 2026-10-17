// node tests/test_savereader.js [save file]
// The browser save reader (evaluator/savereader.js) must read a save exactly as import_save.py does.
// Default: the save out/player.json was made from, found in the profile's save folder. Skipped
// when there is no player.json or save.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const assert = require("assert");
const { execFileSync } = require("child_process");
const S = require("../evaluator/savereader.js");

const ROOT = path.join(__dirname, "..");
const refFile = path.join(ROOT, "out", "player.json");
if (!fs.existsSync(refFile) && !process.argv[2]) { console.log("skipped: no out/player.json (run import_save.py first)"); process.exit(0); }

let save = process.argv[2];
let ref = fs.existsSync(refFile) ? JSON.parse(fs.readFileSync(refFile, "utf-8")) : null;
if (!save) {
  // the save player.json came from, in the profile's save folder (found the way import_save.py does)
  const dir = execFileSync("python", ["-c",
    "import sys; sys.path.insert(0, r'" + ROOT + "'); from x4cat import config, vfs; " +
    "p = vfs.find_profile(game_dir=config.find_game(required=False, log=None)); print(p or '')"], { encoding: "utf-8" })
    .split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean).pop();  // detection logs come first; the path is the last line
  save = dir && path.join(dir, "save", ref.save.file);
}
if (!save || !fs.existsSync(save)) { console.log("skipped: save file not found:", save); process.exit(0); }
if (process.argv[2]) {
  // a save given on the command line: make the reference from it with import_save.py into a temp folder
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "x4save-"));
  execFileSync("python", [path.join(ROOT, "import_save.py"), "--save", save, "--out", tmp, "--evaluator", tmp]);
  ref = JSON.parse(fs.readFileSync(path.join(tmp, "player.json"), "utf-8"));
}

async function* textChunks(file) {
  let stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (file.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
  stream.setEncoding("utf8");
  for await (const chunk of stream) yield chunk;
}

(async () => {
  const t0 = Date.now();
  const got = await S.parseChunks(textChunks(save), { file: path.basename(save), modified: ref.save.modified });
  const ms = Date.now() - t0;
  const mb = fs.statSync(save).size / 1e6;
  for (const k of ["licences", "blueprints", "relations", "galaxy", "access"]) assert.deepStrictEqual(got[k], ref[k], k + " differs from import_save.py");
  for (const k of ["file", "name", "game_version", "start", "player", "money"]) assert.deepStrictEqual(got.save[k], ref.save[k], "save." + k + " differs");
  console.log("ok  %s (%s MB on disk) read in %d ms: %d licence types, %d blueprints, %d relations, %d factions with stations, %d access entries — identical to import_save.py",
    path.basename(save), mb.toFixed(0), ms, Object.keys(got.licences).length, got.blueprints.length,
    Object.keys(got.relations).length, Object.keys(got.galaxy).length, Object.keys(got.access).length);
})().catch((e) => { console.error(e.message); process.exit(1); });
