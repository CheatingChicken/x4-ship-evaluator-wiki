// fetchJson for evaluator/wiki.js that answers from the recorded wiki copy (tests/fixtures/wiki,
// the layout tools/record_wiki.js writes) instead of the network. null for anything not recorded,
// like a 404. The fixtures are never published (.gitignore).
"use strict";
const fs = require("fs");
const path = require("path");

const FIX = path.join(__dirname, "..", "tests", "fixtures", "wiki");

function fixtureFetch(url) {
  const u = new URL(url), p = decodeURIComponent(u.pathname);
  let rel = null;
  if (u.host === "swi-api.siifr.net") {
    const m = /^\/ships\/([a-z]+)\/(?:list\/full|(.+))$/.exec(p);
    if (p === "/wares") rel = "api/wares.json";
    else if (m) rel = m[2] ? `api/ships/${m[1]}/${m[2]}.json` : `api/ships/${m[1]}.json`;
  } else rel = p.replace(/^\//, "");
  const f = rel && path.join(FIX, rel);
  return Promise.resolve(f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : null);
}

module.exports = { FIX, fixtureFetch };
