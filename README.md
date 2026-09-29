# Flare Web — 1.15

A playable browser port of **Flare: Empyrean Campaign**, using the official engine and game **v1.15** releases. The original C++ game runs as WebAssembly; gameplay and assets are retained. Browser loading, fullscreen and save-backup UX take inspiration from [Miu2D](https://github.com/luckyyyyy/miu2d); this project does not use its engine.

## Playing

Use a recent desktop browser with WebAssembly, IndexedDB and Web Locks. Keyboard and mouse are required; the landing page adapts to phones, but touch controls are not implemented. Initial game resources are about **619 MiB**, downloaded in 26 chunks with SHA-256 validation. Allow enough memory for the full resource bundle and game. Browser HTTP caching may reduce subsequent downloads; offline play is not guaranteed.

Save from the in-game Esc menu before leaving, then export a backup. Saves live only in this browser and site origin, not in a cloud account. Clearing site data removes them. Export contains files already written by the engine, not unsaved in-memory progress. Import a web JSON backup **before starting** and only into a browser profile with no existing character saves; overwriting existing saves is deliberately blocked. Only one tab can run the game per origin.

## Rebuild

Prerequisites: Git, Python 3.10+, Node 22+ (tests), and [Emscripten SDK 3.1.74](https://github.com/emscripten-core/emsdk).

```sh
npm test
python3 scripts/fetch.py
# Activate Emscripten 3.1.74 in this shell first.
python3 scripts/build.py
python3 -m http.server 8087 --directory dist
```

Open `http://localhost:8087`. Production requires HTTPS. No npm dependencies are required.

`upstream.json` pins exact official release commits. The builder verifies them, creates fresh generated directories, applies narrowly scoped browser patches, compiles the engine, hashes the JS/WASM filenames, splits resources and emits corresponding patched source in `dist/source.tar.gz`. It deletes and recreates only its generated `work/web-engine`, `work/source-bundle` and `dist` directories. Do not put personal files there.

The archive contains the patched engine and builder sources. To rebuild from it, use `builder/` as the project root, run `scripts/fetch.py` to fetch the pinned public asset/source commits, activate Emscripten, then run `scripts/build.py`.

## GitHub Pages

The workflow builds on pushes to `main` or manual dispatch, then deploys the `dist` artifact. Set the repository's Pages source to **GitHub Actions**. Generated game data is not committed to Git. The site is roughly 630 MiB; account for your hosting provider's size and bandwidth limits.

No scheduled master tracking, synthetic patch versions or prerelease labels are used. To update the game, explicitly review a new official upstream release and update both commit pins and the visible version together.

## Browser patches

- Await initial IndexedDB hydration before game initialization; fail visibly if storage is unavailable.
- Serialize writes, retaining dirty state after persistence failure.
- Disable threaded image loading for the non-pthread WebAssembly build.
- Default to Chinese and a 1280×720 canvas; expose game-ready and storage callbacks.
- Preserve exclusive storage ownership across startup/runtime failure until page reload.

## Licensing and attribution

Original engine: [flareteam/flare-engine](https://github.com/flareteam/flare-engine), GPL-3.0-or-later. Builder/browser code in this repository uses the same license; see `COPYING`.

Game: [flareteam/flare-game](https://github.com/flareteam/flare-game). Asset licenses vary; the built site includes upstream `LICENSE.txt`, `CREDITS.txt` and `CREDITS.engine.txt`. Please retain those and asset-specific attribution. This is an unofficial port and is not affiliated with the upstream developers.
