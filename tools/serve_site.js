// node tools/serve_site.js [--port 8767] [--dir _site]
// Serves the built site (tools/build_site.js) the way GitHub Pages does: files as they are, and
// 404.html with status 404 for any path without a file, which is how the ship pages
// (/ships/s/ewing) work. Local only (127.0.0.1); build with the default --base "/".
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const PORT = +opt("--port", 8767);
const DIR = path.resolve(__dirname, "..", opt("--dir", "_site"));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch (e) { rel = "/"; }
  let file = path.join(DIR, rel);
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end(); }               // no ../ outside the site
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  const found = fs.existsSync(file) && fs.statSync(file).isFile();
  const send = found ? file : path.join(DIR, "404.html");
  res.writeHead(found ? 200 : 404, { "Content-Type": TYPES[path.extname(send)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(send).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`site ${DIR} on http://localhost:${PORT}/ (404.html for unknown paths, like GitHub Pages)`));
