/* Reload the page when its files change. Works only when served by serve.py, which answers
 * /__version with the newest file time; opened as a plain file, or served by anything else, the
 * first poll fails and polling stops. Settings survive the reload (app.js keeps them in
 * localStorage), and so does the selected row (sessionStorage). */
(function () {
  "use strict";
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  let known = null;
  async function poll() {
    try {
      const r = await fetch("/__version", { cache: "no-store" });
      if (!r.ok) return;  // not serve.py: stop quietly
      const v = (await r.json()).version;
      if (known !== null && v !== known) { location.reload(); return; }
      known = v;
    } catch (e) {
      // Server briefly away (restarting): keep polling, it will be back.
    }
    setTimeout(poll, 1000);
  }
  poll();
})();
