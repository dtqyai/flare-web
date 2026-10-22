#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run test:deploy
python3 scripts/fetch.py
emscripten_version=$(python3 -c 'import sys; sys.path.insert(0, "scripts"); from upstream import load_pins; print(load_pins()["emscripten"])')
if [[ ! -d work/emsdk/.git ]]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git work/emsdk
fi
work/emsdk/emsdk install "$emscripten_version"
work/emsdk/emsdk activate "$emscripten_version"
# Emsdk's shell initializer can reference unset variables.
set +u
source work/emsdk/emsdk_env.sh
set -u
python3 scripts/build.py
python3 scripts/check_assets.py
