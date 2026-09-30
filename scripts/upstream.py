"""Shared validation for the official release and build-tool pins."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.compile(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?")
SHA = re.compile(r"[a-f0-9]{40}")


def version_key(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError(f"Invalid stable version: {version!r}")
    parts = tuple(map(int, version.split(".")))
    return parts + (0,) * (3 - len(parts))


def load_pins(path=None):
    pins = json.loads((path or ROOT / "upstream.json").read_text())
    version_key(pins["version"])
    version_key(pins["emscripten"])
    for name in ("engine", "game"):
        if not isinstance(pins[name], str) or not SHA.fullmatch(pins[name]):
            raise ValueError(f"Invalid {name} commit pin")
    return pins
