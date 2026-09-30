#!/usr/bin/env python3
"""Check official stable releases; optionally propose a pinned upgrade PR."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from upstream import ROOT, SHA, load_pins, version_key


class MissingTag(Exception):
    pass


def api(path):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "flare-web-updater",
               "X-GitHub-Api-Version": "2022-11-28"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request("https://api.github.com/" + path, headers=headers)
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404 and "/git/ref/tags/" in path:
            raise MissingTag(path) from error
        raise


def tag_commit(repo, tag, request=api):
    obj = request(f"repos/flareteam/{repo}/git/ref/tags/{quote(tag, safe='')}")["object"]
    # Lightweight tags point to commits; annotated tags need to be peeled.
    for _ in range(8):
        sha = obj.get("sha", "")
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ValueError(f"Invalid object SHA for {repo} {tag}")
        if obj.get("type") == "commit":
            return sha
        if obj.get("type") != "tag":
            raise ValueError(f"Tag does not resolve to a commit: {repo} {tag}")
        obj = request(f"repos/flareteam/{repo}/git/tags/{sha}")["object"]
    raise ValueError(f"Too many nested tags: {repo} {tag}")


def discover(pins, request=api):
    release = request("repos/flareteam/flare-game/releases/latest")
    if release.get("draft") or release.get("prerelease"):
        return None, "No new official stable release."
    tag = release["tag_name"]
    if not isinstance(tag, str):
        raise ValueError("Invalid release tag")
    version = tag.removeprefix("v")
    if version_key(version) <= version_key(pins["version"]):
        return None, f"Already pinned to Flare {pins['version']}; no newer stable release."
    updated = dict(pins, version=version)
    try:
        for kind in ("engine", "game"):
            updated[kind] = tag_commit("flare-" + kind, tag, request)
    except MissingTag:
        return None, f"Flare {version} is available; waiting for matching official engine/game tags."
    return updated, f"Official Flare {version} engine and game tags are ready."


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def ensure_validation(branch, sha):
    runs = json.loads(command("gh", "run", "list", "--workflow", "pages.yml",
                              "--branch", branch, "--commit", sha, "--event", "workflow_dispatch",
                              "--limit", "1", "--json", "databaseId"))
    if not runs:
        # Explicit dispatch works with GITHUB_TOKEN, including bot-created PRs.
        command("gh", "workflow", "run", "pages.yml", "--ref", branch)


def propose(pins):
    version = pins["version"]
    branch = "codex/upstream-v" + version
    prs = json.loads(command("gh", "pr", "list", "--head", branch, "--base", "main",
                             "--state", "all", "--json", "state,url,headRefOid"))
    if prs:
        pr = prs[0]
        if pr["state"] == "OPEN":
            ensure_validation(branch, pr["headRefOid"])
        return f"Existing {pr['state'].lower()} upgrade PR: {pr['url']}"
    if command("git", "status", "--porcelain"):
        raise RuntimeError("Refusing to create an upgrade in a dirty checkout")
    remote = command("git", "ls-remote", "--heads", "origin", "refs/heads/" + branch)
    if remote:
        # Recover after a push/PR-creation interruption without overwriting a branch.
        command("git", "fetch", "origin", branch)
        existing = json.loads(command("git", "show", "FETCH_HEAD:upstream.json"))
        if existing != pins:
            raise RuntimeError(f"Existing branch {branch} has different pins; review it manually")
        sha = command("git", "rev-parse", "FETCH_HEAD")
    else:
        command("git", "switch", "-c", branch)
        (ROOT / "upstream.json").write_text(json.dumps(pins, indent=2) + "\n")
        command("git", "add", "upstream.json")
        command("git", "-c", "user.name=github-actions[bot]", "-c",
                "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                "commit", "-m", f"Update official Flare pins to {version}")
        command("git", "push", "origin", "HEAD:refs/heads/" + branch)
        sha = command("git", "rev-parse", "HEAD")
    body = f"""Update the browser port to the official Flare {version} release. Version labels, backup metadata and the manifest are generated from these pins.

- [Official release](https://github.com/flareteam/flare-game/releases/tag/v{version})
- Engine commit: `{pins['engine']}`
- Game commit: `{pins['game']}`
- Emscripten remains pinned to `{pins['emscripten']}`.

The updater dispatches **Build Flare for the web** on this branch to run JavaScript/Python tests and compile the complete WebAssembly game. Check that run before merging. Only main deploys to Pages.

Before merging, review upstream changes and verify browser startup, gameplay, saving and loading an exported previous-version save. Compilation alone does not establish save compatibility. Back up existing saves before testing. This PR is never merged automatically.
"""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "body.md"
        path.write_text(body)
        url = command("gh", "pr", "create", "--base", "main", "--head", branch,
                      "--title", f"Update Flare to {version}", "--body-file", str(path))
    # If dispatch fails, the next check retries it for the existing PR.
    ensure_validation(branch, sha)
    return "Created upgrade PR: " + url


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--create-pr", action="store_true", help="push an upgrade branch, create a PR and dispatch validation")
    args = parser.parse_args()
    pins = load_pins()
    updated, message = discover(pins)
    if updated and args.create_pr:
        message = propose(updated)
    print(json.dumps({"currentVersion": pins["version"], "update": updated, "message": message}, indent=2))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as output:
            output.write(message + "\n")


if __name__ == "__main__":
    main()
