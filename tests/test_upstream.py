import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build
import check_upstream as updater
from upstream import load_pins, version_key

PINS = dict(version="1.15", engine="a" * 40, game="b" * 40, emscripten="3.1.74")


def release_api(version="v1.16", draft=False, prerelease=False, missing=None, annotated=False):
    def request(path):
        if path.endswith("releases/latest"):
            return dict(tag_name=version, draft=draft, prerelease=prerelease)
        kind = "engine" if "flare-engine" in path else "game"
        if missing == kind:
            raise updater.MissingTag(path)
        if annotated and "/git/ref/" in path:
            return {"object": {"type": "tag", "sha": "c" * 40}}
        return {"object": {"type": "commit", "sha": "d" * 40 if kind == "engine" else "e" * 40}}
    return request


class Releases(unittest.TestCase):
    def test_version_order_is_numeric_and_patch_aware(self):
        self.assertGreater(version_key("1.16"), version_key("1.9"))
        self.assertEqual(version_key("1.15"), version_key("1.15.0"))
        self.assertGreater(version_key("1.15.1"), version_key("1.15"))
        for value in ("1.16-beta", "v1.16", "../1.16", "1.16\n", None):
            with self.assertRaises(ValueError):
                version_key(value)

    def test_new_release_pins_both_official_tags(self):
        updated, _ = updater.discover(PINS, release_api())
        self.assertEqual(updated, dict(PINS, version="1.16", engine="d" * 40, game="e" * 40))
        self.assertEqual(PINS["version"], "1.15")

    def test_annotated_tags_resolve_to_commits(self):
        updated, _ = updater.discover(PINS, release_api(annotated=True))
        self.assertEqual(updated["engine"], "d" * 40)
        self.assertEqual(updated["game"], "e" * 40)

    def test_same_older_draft_and_prerelease_do_not_upgrade(self):
        for request in (release_api("v1.15"), release_api("v1.14"),
                        release_api(draft=True), release_api(prerelease=True)):
            self.assertIsNone(updater.discover(PINS, request)[0])

    def test_missing_matching_tag_waits_without_partial_update(self):
        for kind in ("engine", "game"):
            updated, message = updater.discover(PINS, release_api(missing=kind))
            self.assertIsNone(updated)
            self.assertIn("waiting", message)

    def test_bad_sha_noncommit_and_tag_cycles_are_rejected(self):
        for obj in ({"type": "commit", "sha": "bad"},
                    {"type": "tree", "sha": "d" * 40},
                    {"type": "tag", "sha": "c" * 40}):
            with self.assertRaises(ValueError):
                updater.tag_commit("flare-engine", "v1.16", lambda _: {"object": obj})

    def test_config_validates_commits_and_tool_version(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pins.json"
            path.write_text(json.dumps(PINS))
            self.assertEqual(load_pins(path), PINS)
            for field, value in (("engine", "master"), ("version", "1.16-beta"), ("emscripten", "latest")):
                path.write_text(json.dumps(dict(PINS, **{field: value})))
                with self.assertRaises(ValueError):
                    load_pins(path)

    def test_existing_open_pr_reuses_branch_and_recovers_missing_dispatch(self):
        pr = dict(state="OPEN", url="https://example.test/pr/1", headRefOid="d" * 40)
        with patch.object(updater, "command", side_effect=[json.dumps([pr]), "[]", ""]) as run:
            self.assertIn("Existing open", updater.propose(dict(PINS, version="1.16")))
            self.assertEqual(run.call_count, 3)
            self.assertEqual(run.call_args.args, ("gh", "workflow", "run", "pages.yml", "--ref", "codex/upstream-v1.16"))

    def test_existing_closed_pr_is_not_recreated(self):
        for state in ("CLOSED", "MERGED"):
            with patch.object(updater, "command", return_value=json.dumps([dict(state=state, url="example")])) as run:
                updater.propose(PINS)
                self.assertEqual(run.call_count, 1)

    def test_existing_validation_does_not_dispatch_again(self):
        with patch.object(updater, "command", return_value='[{"databaseId":123}]') as run:
            updater.ensure_validation("codex/upstream-v1.16", "d" * 40)
            self.assertEqual(run.call_count, 1)

    def test_dirty_checkout_and_branch_collision_are_not_overwritten(self):
        with patch.object(updater, "command", side_effect=["[]", " M web/app.js"]):
            with self.assertRaisesRegex(RuntimeError, "dirty"):
                updater.propose(PINS)
        with patch.object(updater, "command", side_effect=["[]", "", "remote-sha", "", json.dumps(dict(PINS, version="1.14"))]) as run:
            with self.assertRaisesRegex(RuntimeError, "different pins"):
                updater.propose(PINS)
            self.assertFalse(any(call.args[1] == "push" for call in run.call_args_list))

    def test_new_pr_only_changes_pins_and_dispatches_its_exact_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pins = dict(PINS, version="1.16")
            calls = []
            body = []

            def run(*args):
                calls.append(args)
                if args[:3] == ("gh", "pr", "list"):
                    return "[]"
                if args[:3] == ("git", "status", "--porcelain"):
                    return ""
                if args[:2] == ("git", "ls-remote"):
                    return ""
                if args[:3] == ("git", "rev-parse", "HEAD"):
                    return "f" * 40
                if args[:3] == ("gh", "pr", "create"):
                    body.append(Path(args[args.index("--body-file") + 1]).read_text())
                    return "https://example.test/pr/2"
                if args[:3] == ("gh", "run", "list"):
                    self.assertEqual(args[args.index("--commit") + 1], "f" * 40)
                    return "[]"
                return ""

            with patch.object(updater, "ROOT", root), patch.object(updater, "command", side_effect=run):
                self.assertIn("Created upgrade PR", updater.propose(pins))
            self.assertEqual(json.loads((root / "upstream.json").read_text()), pins)
            self.assertIn(("git", "add", "upstream.json"), calls)
            self.assertIn(("git", "push", "origin", "HEAD:refs/heads/codex/upstream-v1.16"), calls)
            self.assertEqual(calls[-1], ("gh", "workflow", "run", "pages.yml", "--ref", "codex/upstream-v1.16"))
            self.assertIn("save compatibility", body[0])
            self.assertIn("never merged automatically", body[0])

    def test_interrupted_push_recovers_without_rewriting_branch(self):
        pins = dict(PINS, version="1.16")
        with patch.object(updater, "command", side_effect=["[]", "", "remote-sha", "", json.dumps(pins),
                                                           "f" * 40, "https://example.test/pr/2", "[]", ""]) as run:
            updater.propose(pins)
            commands = [call.args for call in run.call_args_list]
            self.assertFalse(any(args[:2] == ("git", "push") for args in commands))
            self.assertFalse(any(args[:2] == ("git", "switch") for args in commands))
            self.assertIn(("git", "rev-parse", "FETCH_HEAD"), commands)

    def test_tag_lookup_only_swallows_missing_tags(self):
        with patch.object(updater, "urlopen", side_effect=updater.HTTPError("url", 404, "missing", {}, None)):
            with self.assertRaises(updater.MissingTag):
                updater.api("repos/flareteam/flare-engine/git/ref/tags/v1.16")
            with self.assertRaises(updater.HTTPError):
                updater.api("repos/flareteam/flare-game/releases/latest")
        with patch.object(updater, "urlopen", side_effect=updater.HTTPError("url", 403, "rate limit", {}, None)):
            with self.assertRaises(updater.HTTPError):
                updater.api("repos/flareteam/flare-engine/git/ref/tags/v1.16")


class Builder(unittest.TestCase):
    def test_patch_anchor_changes_fail_visibly(self):
        self.assertEqual(build.patch_once("abc", "b", "d", "test"), "adc")
        for text in ("ac", "abbc"):
            with self.assertRaisesRegex(SystemExit, "no longer matches"):
                build.patch_once(text, "b", "d", "test")

    def test_build_assembles_versioned_manifest_page_and_source_bundle(self):
        # Exercise the real assembly pipeline with a tiny engine/game and stub compiler.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work, dist = root / "work", root / "dist"
            files = {
                "work/engine/src/PlatformEmscripten.cpp": "void Platform::FSInit() { }\nvoid Platform::setScreenSize() { }\nsettings->screen_w = 1920;\nsettings->screen_h = 1080;\nparentDocument.exitFullscreen();",
                "work/engine/src/main.cpp": "init_finished = true;",
                "work/engine/src/Settings.cpp": "\n\t// Force using the software renderer if safe mode is enabled",
                "work/engine/cmake/example.cmake": "",
                "work/engine/CMakeLists.txt": "",
                "work/engine/COPYING": "license",
                "work/engine/CREDITS.engine.txt": "credits",
                "work/game/mods/fantasycore/images/menus/backgrounds/dungeon.jpg": "cover",
                "work/game/mods/empyrean_campaign/images/menus/logo.png": "logo",
                "work/game/LICENSE.txt": "license",
                "work/game/CREDITS.txt": "credits",
                "web/index.html": "version={{FLARE_VERSION}}; footer={{FLARE_VERSION}}",
                "web/app.js": "",
                "scripts/build.py": "builder",
                "tests/test_upstream.py": "tests",
                "upstream.json": json.dumps(dict(PINS, version="1.16.2")),
                "README.md": "readme", "COPYING": "license", "package.json": "{}",
            }
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)

            def compile_stub(*args, **kwargs):
                for extension in ("js", "wasm", "data"):
                    (dist / ("flare." + extension)).write_bytes(b"test")

            def revision(args, **kwargs):
                return PINS[Path(args[2]).name] + "\n"

            with patch.multiple(build, ROOT=root, WORK=work, DIST=dist, PIN=dict(PINS, version="1.16.2")), \
                 patch.object(build.subprocess, "check_output", side_effect=revision), \
                 patch.object(build, "run", side_effect=compile_stub):
                build.main()
            manifest = json.loads((dist / "manifest.json").read_text())
            self.assertEqual(manifest["version"], "1.16.2")
            self.assertEqual(manifest["engine"], PINS["engine"])
            self.assertEqual((dist / "index.html").read_text(), "version=1.16.2; footer=1.16.2")
            self.assertEqual(manifest["totalBytes"], 4)
            self.assertTrue((dist / manifest["engineScript"]).exists())
            self.assertTrue((dist / manifest["wasm"]).exists())
            self.assertTrue((dist / "source.tar.gz").exists())
            self.assertIn("{{FLARE_VERSION}}", (work / "source-bundle/builder/web/index.html").read_text())
            self.assertIn("Module.onGameReady()", (work / "web-engine/src/main.cpp").read_text())


if __name__ == "__main__":
    unittest.main()
