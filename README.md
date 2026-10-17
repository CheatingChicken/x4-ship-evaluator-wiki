# X4 Ship Evaluator — wiki edition

The [X4 Ship Evaluator](https://github.com/CheatingChicken/x4-ship-evaluator) running entirely in
the browser on the Star Wars Interworlds wiki's data (swi.siifr.net), meant to be embedded on the
wiki. Nothing to install: plain JavaScript, no dependencies, no build step.

**Status:** in development. The local edition is the working reference.

## How it fits together

| Part | Where | Notes |
|---|---|---|
| Ranking, rating profiles, UI | `evaluator/` (shared) | **Edited in the local repo only**, copied here by `tools/sync_shared.py`; `evaluator/SHARED_FROM` records the source commit, and `tests/test_shared.js` fails on local edits. |
| Wiki adapter | `evaluator/wiki.js` | Builds the evaluator's data (`window.X4DATA`) from the wiki's JSON plus our supplement. |
| Published site | `tools/build_site.js`, `evaluator/site_loader.js` | The GitHub Action builds the data from the live wiki and splits it per mod (`data/swi.json`, `data/dabc.json`, …); visitors download SWI plus only the submods they tick under Settings → Mods. |
| Ship pages | `evaluator/ship.html`, `ship.js`, `ship.css` | Proof of concept for the wiki maintainers: the wiki's `/ships/<hull>/<ship>` pages rebuilt from our data, with every engine, thruster, shield, weapon and turret that fits, prices, sellers, build costs, the slot layout and the evaluator's best loadouts. Published as `404.html`, which GitHub Pages serves for every path without a file, so `/ships/s/ewing` renders live from the address, as on the wiki. The wiki's list pages too: `/ships` (catalogue), `/ships/full-list`, `/ships/<hull>`, `/ships/<faction short name>` (e.g. `imp`) and the same under `/submods/<mod>/ships`; `/en/...` works as well. Every table sorts by a click on its header; the lists have a search box (kept in `?q=`). Every section has a switch (`CONFIG.sections`, or `window.X4ShipConfig`). |
| Save reader | browser-side, shared | Reads a save file in the browser (it never leaves the player's computer) for licences, reputation, shipyards and blueprints. |
| Supplement | `supplement/supplement.json` | What the wiki does not serve yet (thrusters, cargo and hangar sizes, part wares, factions). Generated from a local game install by the local repo (`x4catalogue.py --supplement`). |
| Gap report | `docs/wiki-gaps.html` | What the wiki backend lacks and where it lives in the mod files. |

Supported mods: SW Interworlds (always), DABC and RSP (off by default). The list is an allowlist
(`MODS` in `evaluator/wiki.js`); no other source is read.

**Adding a submod** once the wiki serves it under `/submods/<id>/`: add it to `MODS` in
`evaluator/wiki.js` and to `ALLOWED` in the local repo's `x4cat/supplement.py`, regenerate
`supplement/supplement.json`, and push. The build then publishes its data file and the Mods
section offers it; nothing else changes.

## Working on it

```
python tools/sync_shared.py          copy the shared front end from the local repo (committed state only)
python tools/sync_shared.py --check  verify nothing shared was edited here
node tests/test_shared.js
node tests/test_optimiser.js
node tests/test_profile.js
```

```
node tools/record_wiki.js            record the wiki JSON once into tests/fixtures/wiki (gitignored, never published)
python tools/dev_server.py           the page on http://localhost:8766/ with the recorded data, same origin
node tests/test_wiki_adapter.js      the adapter's output against the local edition's data.js
node tests/test_site_split.js        every mod combination of the per-mod site data against a direct build
node tests/test_ship_page.js         the ship pages: routing, every ship rendering, section switches, loadouts
node tools/build_site.js --fixtures  the site in _site/ from the recorded copy (the Action builds from the live wiki)
node tools/serve_site.js             serve _site/ on http://localhost:8767/ like GitHub Pages (404.html for unknown paths)
```

The live wiki data is readable only from pages on swi.siifr.net (CORS), so local testing runs on
the recorded copy. The dev server maps it to the wiki's URL scheme and points `wiki.js` at it.

## Licence

MIT, © 2026 CheatingChicken. X4: Foundations is a trademark of Egosoft; Star Wars Interworlds is by
its own authors. Not affiliated with either.
