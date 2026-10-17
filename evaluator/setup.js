/* Setup: which game, profile and language the data is built from (serve.py /__setup, /__config),
 * and the first-run screen shown while evaluator/data.js does not exist yet.
 *   X4Setup.box(el, opts)  game / profile / language pickers; opts.after: text after a save
 *   X4Setup.firstRun()     replaces the page with "Build from my game"
 * Paths come from the local server and are escaped like everything else shown. */
(function () {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const api = async (path, body) => {
    const r = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.output || r.status + " " + r.statusText);
    return j;
  };
  const when = (iso) => (iso ? String(iso).replace("T", " ").slice(0, 16) : "");

  async function box(el, opts) {
    opts = opts || {};
    let s;
    try { s = await api("/__setup"); } catch (e) {
      el.innerHTML = `<p class="warn small">Choosing the game and profile needs the local server: run <code>python serve.py --open</code>.</p>`;
      return null;
    }
    const game = s.game
      ? `${esc(s.game.path)} <span class="muted small">(${esc(s.game.source)}${s.game.version ? ", X4 " + esc(s.game.version) : ""})</span>`
      : `<span class="warn">not found</span>${s.game_note ? ` <span class="small">— ${esc(s.game_note)}</span>` : ""}`;
    const profiles = s.profiles || [];
    const profile = profiles.length
      ? `<select id="su-profile">${profiles.map((p) => `<option value="${esc(p.path)}" ${s.profile && s.profile.path === p.path ? "selected" : ""}>` +
          `${esc(p.path)} — ${p.saves} save${p.saves === 1 ? "" : "s"}${p.newest_save ? ", newest " + esc(when(p.newest_save)) : ""}</option>`).join("")}</select>` +
        (s.profile ? ` <span class="muted small">(${esc(s.profile.source)})</span>` : "")
      : `<span class="warn">none found</span> <span class="muted small">looked in ${esc((s.profile_roots || []).join("; "))}</span>`;
    el.innerHTML = `<div class="setup">
        <span>Game</span><div>${game}
          <div class="row nowrap"><input id="su-game" list="su-games" placeholder="X4 Foundations folder (the one with 01.cat)" value="${esc(s.game ? s.game.path : "")}">
          <datalist id="su-games">${(s.games || []).map((g) => `<option value="${esc(g)}">`).join("")}</datalist>
          <button type="button" id="su-game-set">Use this folder</button></div></div>
        <span>Profile</span><div>${profile}</div>
        <span>Language</span><div><select id="su-lang">${(s.languages || []).map((l) =>
          `<option value="${l.id}" ${s.lang && s.lang.id === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
      </div><p class="small" id="su-msg"></p>`;
    const msg = el.querySelector("#su-msg");
    const set = async (body) => {
      try {
        await api("/__config", body);
        await box(el, opts);
        const m = el.querySelector("#su-msg");
        m.className = "small"; m.textContent = "Saved." + (opts.after ? " " + opts.after : "");
        if (opts.onSaved) opts.onSaved();
      } catch (e) { msg.className = "small warn"; msg.textContent = "Not saved: " + e.message; }
    };
    el.querySelector("#su-game-set").onclick = () => set({ game: el.querySelector("#su-game").value.trim() || null });
    if (el.querySelector("#su-profile")) el.querySelector("#su-profile").onchange = (e) => set({ profile: e.target.value });
    el.querySelector("#su-lang").onchange = (e) => set({ lang: +e.target.value });
    return s;
  }

  async function firstRun() {
    const settings = document.querySelector("#settings-open");
    if (settings) settings.hidden = true;
    const main = document.querySelector("main");
    main.className = "firstrun-main";
    if (location.protocol === "file:") {
      main.innerHTML = `<section class="firstrun"><h2 class="title">No game data yet</h2>
        <p>The evaluator reads your X4 installation and enabled mods. Either run this in the tool's folder, then reload this page:</p>
        <pre>python x4catalogue.py --evaluator</pre>
        <p>or start the local server, which can do it from here and import saves too:</p><pre>python serve.py --open</pre></section>`;
      return;
    }
    main.innerHTML = `<section class="firstrun"><h2 class="title">Welcome — let's read your game</h2>
      <p>The evaluator builds its data from your own X4 installation and the mods enabled in your profile.
        Nothing is changed in the game. Check what was found, then build.</p>
      <div id="fr-setup"></div>
      <div class="row"><button type="button" id="fr-build" class="primary">Build from my game</button>
        <label class="check small"><input type="checkbox" id="fr-all"> include disabled mods</label></div>
      <p class="small" id="fr-status"></p>
      <p class="muted small">Afterwards, import a save under ⚙ Settings → Save game so the ranking knows your licences and reputation.</p></section>`;
    const build = document.querySelector("#fr-build"), status = document.querySelector("#fr-status");
    const refresh = async () => {
      const s = await box(document.querySelector("#fr-setup"), { onSaved: () => refresh() });
      build.disabled = !(s && s.game);
      if (s && !s.game) status.innerHTML = `<span class="warn">Enter your X4 Foundations folder above (the one containing 01.cat).</span>`;
      else if (s) status.textContent = "";
    };
    await refresh();
    build.onclick = async () => {
      build.disabled = true;
      status.className = "small";
      status.textContent = "Reading the game and your mods… this takes about 30 seconds.";
      try {
        await api("/__export", { all: document.querySelector("#fr-all").checked });
        status.textContent = "Done. Loading…";
        setTimeout(() => location.reload(), 1500);  // livereload.js usually gets there first
      } catch (e) {
        status.className = "small warn";
        status.textContent = "Build failed: " + e.message;
        build.disabled = false;
      }
    };
  }

  window.X4Setup = { box, firstRun };
})();
