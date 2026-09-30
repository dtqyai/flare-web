# Flare Web

A playable browser port of **Flare: Empyrean Campaign**, using the official engine and game release pinned in [`upstream.json`](upstream.json). The original C++ game runs as WebAssembly; gameplay and assets are retained. Browser loading, fullscreen and save-backup UX take inspiration from [Miu2D](https://github.com/luckyyyyy/miu2d); this project does not use its engine.

## Playing

Use a recent desktop browser with WebAssembly, IndexedDB and Web Locks. Keyboard and mouse are required; the landing page adapts to phones, but touch controls are not implemented. Initial game resources are about **619 MiB**, downloaded in 26 chunks with SHA-256 validation. Allow enough memory for the full resource bundle and game. Browser HTTP caching may reduce subsequent downloads; offline play is not guaranteed.

Save from the in-game Esc menu before leaving, then export a backup. Saves live only in this browser and site origin, not in a cloud account. Clearing site data removes them. Export contains files already written by the engine, not unsaved in-memory progress. Import a web JSON backup **before starting** and only into a browser profile with no existing character saves; overwriting existing saves is deliberately blocked. Only one tab can run the game per origin.

## Rebuild

Prerequisites: Git, Python 3.10+, Node 22+ (tests), and [Emscripten SDK](https://github.com/emscripten-core/emsdk).

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/fetch.py
# Activate the Emscripten version declared in upstream.json first.
python3 scripts/build.py
python3 -m http.server 8087 --directory dist
```

Open `http://localhost:8087`. Production requires HTTPS. No npm dependencies are required.

`upstream.json` pins exact official release commits. The builder verifies them, creates fresh generated directories, applies narrowly scoped browser patches, compiles the engine, hashes the JS/WASM filenames, splits resources and emits corresponding patched source in `dist/source.tar.gz`. It deletes and recreates only its generated `work/web-engine`, `work/source-bundle` and `dist` directories. Do not put personal files there.

The archive contains the patched engine and builder sources. To rebuild from it, use `builder/` as the project root, run `scripts/fetch.py` to fetch the pinned public asset/source commits, activate Emscripten, then run `scripts/build.py`.

## GitHub Pages

The workflow tests and builds on pull requests, pushes to `main` and manual dispatch. Only runs on `main` deploy the `dist` artifact; upgrade branches only validate. Set the repository's Pages source to **GitHub Actions**. Generated game data is not committed to Git. The site is roughly 630 MiB; account for your hosting provider's size and bandwidth limits.

## Upstream updates

`Check official Flare releases` runs daily at approximately **09:23 Asia/Singapore** and supports manual dispatch. It checks the latest official `flare-game` stable release, waits for matching engine and game tags, resolves lightweight or annotated tags to exact commit SHAs, and opens one `codex/upstream-v<version>` PR. Drafts, prereleases, older versions and master commits are excluded. A closed upgrade PR is treated as declined and is not recreated; open PRs are reused.

The updater explicitly dispatches `Build Flare for the web` on the upgrade branch, so validation does not depend on automatic workflow triggering by a bot-created PR. It runs JavaScript/Python tests and compiles the full game; PR branches cannot deploy to Pages. Review upstream changes, browser patches, gameplay and previous-version save compatibility before merging. No automatic merge is configured. If the build fails, fix the upgrade branch and rerun validation before merging.

The version in `upstream.json` feeds the resource manifest, rendered page labels, exported save metadata and backup filename. Emscripten is also read from that file by CI. Browser patches fail the build if expected source anchors change. The persistent storage location and backup format version are kept independent of the game version; previous backups remain readable, but actual cross-version game-save compatibility must be tested.

For this automation, repository **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** must be enabled. The updater requests `contents: write`, `pull-requests: write` and `actions: write` for branch creation, PR creation and build dispatch. No personal access token is needed. Scheduled workflows become active after these workflow files reach the default branch; GitHub can delay or disable schedules on inactive repositories.

Read-only local check (does not edit pins or create a PR):

```sh
python3 scripts/check_upstream.py
```

To upgrade manually, review the official release and update `version`, `engine` and `game` in `upstream.json`, then run tests and rebuild. Keep exact commit pins for reproducibility.

## Browser patches

- Await initial IndexedDB hydration before game initialization; fail visibly if storage is unavailable.
- Serialize writes, retaining dirty state after persistence failure.
- Disable threaded image loading for the non-pthread WebAssembly build.
- Default to Chinese and a 1280×720 canvas; expose game-ready and storage callbacks.
- Preserve exclusive storage ownership across startup/runtime failure until page reload.

## Licensing and attribution

Original engine: [flareteam/flare-engine](https://github.com/flareteam/flare-engine), GPL-3.0-or-later. Builder/browser code in this repository uses the same license; see `COPYING`.

Game: [flareteam/flare-game](https://github.com/flareteam/flare-game). Asset licenses vary; the built site includes upstream `LICENSE.txt`, `CREDITS.txt` and `CREDITS.engine.txt`. Please retain those and asset-specific attribution. This is an unofficial port and is not affiliated with the upstream developers.
