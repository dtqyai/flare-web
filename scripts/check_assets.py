#!/usr/bin/env python3
"""Refuse incomplete or oversized Workers static asset uploads."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    required = ["index.html", "app.js", "storage.js", "persisted-saves.js", "loader.js", "style.css", "cover.jpg", "logo.png",
                "source.tar.gz", "LICENSE.txt", "CREDITS.txt", "COPYING", "CREDITS.engine.txt",
                manifest["engineScript"], manifest["wasm"], *[chunk["url"] for chunk in manifest["chunks"]]]
    for name in required:
        if not (directory / name).is_file():
            raise SystemExit(f"Missing website asset: {name}")
    files = [path for path in directory.rglob("*") if path.is_file()]
    if len(files) > 20000:
        raise SystemExit("Too many static assets for the Workers Free plan")
    for path in files:
        if path.stat().st_size > 25 * 1024 * 1024:
            raise SystemExit(f"Asset exceeds 25 MiB: {path.relative_to(directory)}")
    print(f"Workers assets validated: {len(files)} files, maximum 25 MiB each")


if __name__ == "__main__":
    check(ROOT / "dist")
