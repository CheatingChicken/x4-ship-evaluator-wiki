"""Local test server for the wiki edition: the page plus the RECORDED wiki data, same origin.

    python tools/dev_server.py [--port 8766]

The live wiki data can only be read by pages on swi.siifr.net (CORS), so for testing this serves
the copy tools/record_wiki.js made (tests/fixtures/wiki) under the wiki's own URL scheme:
    /wiki-api/...      swi-api.siifr.net   (ships lists and records, wares)
    /wiki-static/...   swi.siifr.net       (submod ships, equipment)
    /supplement.json   supplement/supplement.json, else the local edition's out/supplement.json
and injects a config block into index.html pointing evaluator/wiki.js at them. Bound to
127.0.0.1; read-only; no caching.
"""
import argparse
import functools
import http.server
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(HERE, "evaluator")
FIX = os.path.join(HERE, "tests", "fixtures", "wiki")
LOCAL = os.environ.get("X4EVAL_LOCAL", r"G:\SteamLibrary\steamapps\common\X4 Foundations\extensions\_x4catalogue")
SUPPLEMENTS = [os.path.join(HERE, "supplement", "supplement.json"), os.path.join(LOCAL, "out", "supplement.json")]
CONFIG = ('<script>window.X4WikiConfig = { api: "/wiki-api", wiki: "/wiki-static", supplement: "/supplement.json" };'
          '</script>')


def fixture_path(path):
    """The recorded file for a wiki URL path, or None. Never leaves the fixture folder."""
    m = re.match(r"^/wiki-api/(wares|ships/([a-z]+)/list/full|ships/([a-z]+)/([\w.-]+))$", path)
    rel = None
    if m:
        if m.group(1) == "wares":
            rel = "api/wares.json"
        elif m.group(2):
            rel = "api/ships/%s.json" % m.group(2)
        else:
            rel = "api/ships/%s/%s.json" % (m.group(3), m.group(4))
    elif path.startswith("/wiki-static/") and re.match(r"^[\w./-]+\.json$", path[len("/wiki-static/"):]):
        rel = path[len("/wiki-static/"):]
    if not rel or ".." in rel:
        return None
    full = os.path.normpath(os.path.join(FIX, rel))
    return full if full.startswith(os.path.normpath(FIX) + os.sep) and os.path.isfile(full) else None


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/wiki-api/") or path.startswith("/wiki-static/"):
            f = fixture_path(path)
            if not f:
                return self._send(404, b'"not recorded"', "application/json")
            return self._send(200, open(f, "rb").read(), "application/json")
        if path == "/supplement.json":
            f = next((p for p in SUPPLEMENTS if os.path.isfile(p)), None)
            return self._send(200, open(f, "rb").read(), "application/json") if f else self._send(404, b"{}", "application/json")
        if path in ("/", "/index.html"):
            html = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()
            html = html.replace('<script src="wiki.js"', CONFIG + '\n<script src="wiki.js"', 1)
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        return super().do_GET()

    def log_message(self, fmt, *args):
        if not (args and (" /wiki-" in str(args[0]) or "__version" in str(args[0]))):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8766)
    a = ap.parse_args()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), functools.partial(Handler, directory=WEB))
    print("wiki edition (recorded data) on http://localhost:%d/" % a.port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
