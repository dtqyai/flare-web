#!/usr/bin/env python3
"""Compile the pinned official Flare sources and assemble a static website."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

from upstream import load_pins

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / 'work'
DIST = ROOT / 'dist'
PIN = load_pins()


def run(*args, **kw):
    subprocess.run([str(x) for x in args], check=True, **kw)


def patch_once(text, before, after, label):
    if text.count(before) != 1:
        raise SystemExit(f"Browser patch no longer matches upstream: {label}")
    return text.replace(before, after, 1)


def render_page(text, version):
    if text.count('{{FLARE_VERSION}}') != 2:
        raise SystemExit('Expected exactly two version placeholders in index.html')
    return text.replace('{{FLARE_VERSION}}', version)


def main():
    for name in ('engine', 'game'):
        sha = subprocess.check_output(['git', '-C', str(WORK/name), 'rev-parse', 'HEAD'], text=True).strip()
        if sha != PIN[name]:
            raise SystemExit(f"{name}: expected official v{PIN['version']} commit {PIN[name]}, got {sha}")
    stage = WORK / 'web-engine'
    # These are generated directories owned exclusively by this builder.
    for generated in (stage, DIST, WORK/'source-bundle'):
        if generated.is_symlink():
            raise SystemExit(f'Refusing to clean symlink: {generated}')
        if generated.exists():
            shutil.rmtree(generated)
    shutil.copytree(WORK/'engine', stage, dirs_exist_ok=True, ignore=shutil.ignore_patterns('.git'))
    platform = stage/'src/PlatformEmscripten.cpp'
    text = platform.read_text()
    begin, end = text.index('void Platform::FSInit()'), text.index('void Platform::setScreenSize()')
    text = text[:begin] + '''void Platform::FSInit() {
    EM_ASM({ Module.syncdone = 0; Module.webStorage.init(FS, IDBFS, Module); });
}

bool Platform::FSCheckReady() {
    return emscripten_run_script_int("Module.syncdone") == 1;
}

void Platform::FSCommit() {
    EM_ASM({ Module.webStorage.commit(); });
}

''' + text[end:]
    text = patch_once(text, 'settings->screen_w = 1920;', 'settings->screen_w = 1280;', 'default width')
    text = patch_once(text, 'settings->screen_h = 1080;', 'settings->screen_h = 720;', 'default height')
    text = patch_once(text, 'parentDocument.exitFullscreen();', 'document.exitFullscreen();', 'exit fullscreen')
    platform.write_text(text)
    main_cpp = stage/'src/main.cpp'
    text = patch_once(main_cpp.read_text(), 'init_finished = true;', 'init_finished = true;\n            EM_ASM({ Module.onGameReady(); });', 'game ready callback')
    main_cpp.write_text(text)
    for mod in ('fantasycore', 'empyrean_campaign'):
        shutil.copytree(WORK/'game/mods'/mod, stage/'mods'/mod, dirs_exist_ok=True)
    # Web builds have no pthreads; a saved native preference must not re-enable them.
    settings = stage/'src/Settings.cpp'
    text = settings.read_text()
    marker = '\n\t// Force using the software renderer if safe mode is enabled'
    text = patch_once(text, marker, '\n#ifdef __EMSCRIPTEN__\n    enable_threaded_image_load = false;\n#endif\n' + marker, 'disable threaded image loading')
    settings.write_text(text)
    DIST.mkdir(exist_ok=True)
    cmd = [os.environ.get('EMXX', 'em++'), '-O2', '-std=c++11', '-fno-exceptions',
           '-sUSE_SDL=2', '-sUSE_SDL_IMAGE=2', '-sSDL2_IMAGE_FORMATS=["png","jpg"]',
           '-sUSE_SDL_TTF=2', '-sUSE_SDL_MIXER=2', '-sSDL2_MIXER_FORMATS=["ogg"]',
           '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=134217728', '-sMAXIMUM_MEMORY=2147483648',
           '-sEXPORTED_RUNTIME_METHODS=["FS","IDBFS"]', '-sENVIRONMENT=web',
           '-sASSERTIONS=1', '-lidbfs.js', '--preload-file', 'mods',
           '-o', str(DIST/'flare.js')]
    cmd[1:1] = [str(p.relative_to(stage)) for p in sorted((stage/'src').glob('*.cpp'))]
    run(*cmd, cwd=stage)
    chunks = []
    assets = DIST/'assets'
    assets.mkdir(exist_ok=True)
    with (DIST/'flare.data').open('rb') as f:
        offset = 0
        while data := f.read(24*1024*1024):
            sha = hashlib.sha256(data).hexdigest()
            filename = f'assets/{len(chunks):02d}-{sha[:16]}.bin'
            (DIST/filename).write_bytes(data)
            chunks.append(dict(url=filename, bytes=len(data), sha256=sha, offset=offset))
            offset += len(data)
    (DIST/'flare.data').unlink()
    runtime = {}
    for extension, key in [('js', 'engineScript'), ('wasm', 'wasm')]:
        original = DIST/f'flare.{extension}'
        digest = hashlib.sha256(original.read_bytes()).hexdigest()[:16]
        filename = f'engine-{digest}.{extension}'
        original.rename(DIST/filename)
        runtime[key] = filename
    manifest = dict(**runtime, version=PIN['version'], totalBytes=offset, chunks=chunks, engine=PIN['engine'], game=PIN['game'])
    (DIST/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    shutil.copytree(ROOT/'web', DIST, dirs_exist_ok=True)
    (DIST/'index.html').write_text(render_page((DIST/'index.html').read_text(), PIN['version']))
    shutil.copy2(stage/'mods/fantasycore/images/menus/backgrounds/dungeon.jpg', DIST/'cover.jpg')
    shutil.copy2(stage/'mods/empyrean_campaign/images/menus/logo.png', DIST/'logo.png')
    for repo, names in [('engine', ['COPYING', 'CREDITS.engine.txt']), ('game', ['LICENSE.txt', 'CREDITS.txt'])]:
        for name in names:
            shutil.copy2(WORK/repo/name, DIST/name)
    # Corresponding patched engine sources, including the exact build recipe.
    source = WORK/'source-bundle'
    shutil.copytree(stage/'src', source/'engine/src', dirs_exist_ok=True)
    shutil.copytree(stage/'cmake', source/'engine/cmake', dirs_exist_ok=True)
    shutil.copy2(stage/'CMakeLists.txt', source/'engine/CMakeLists.txt')
    shutil.copy2(WORK/'engine/COPYING', source/'engine/COPYING')
    shutil.copytree(ROOT/'scripts', source/'builder/scripts', dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(ROOT/'web', source/'builder/web', dirs_exist_ok=True)
    for name in ('upstream.json', 'README.md', 'COPYING', 'package.json'):
        shutil.copy2(ROOT/name, source/'builder'/name)
    shutil.copytree(ROOT/'tests', source/'builder/tests', dirs_exist_ok=True)
    shutil.make_archive(str(DIST/'source'), 'gztar', source)
    (DIST/'.nojekyll').touch()
    print(f'Built Flare {PIN["version"]}: {len(chunks)} data chunks, {offset/1024/1024:.1f} MiB')


if __name__ == '__main__':
    main()
