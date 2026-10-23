import { SaveBridge, validateBackup } from './storage.js';
import { loadChunks, loadManifest } from './loader.js';
import { acquireSaveLock, readPersistedBackup } from './persisted-saves.js';

const $ = id => document.getElementById(id);
let manifest, pending, bridge, releaseLock, controller;
let phase = 'preparing', importing = false, exporting = false, importSequence = 0;

function canStart() {
  return phase === 'idle' && !!manifest && !importing && !exporting;
}

function updateControls() {
  $('start').disabled = phase === 'failed' ? importing || exporting : !canStart();
  $('import').disabled = !['preparing', 'idle'].includes(phase) || exporting;
  $('export').disabled = importing || exporting || ['loading', 'booting'].includes(phase);
  $('cancel').hidden = phase !== 'loading';
}

function fail(error) {
  console.error(error);
  controller?.abort(error);
  phase = 'failed';
  document.body.classList.remove('playing');
  $('error').textContent = error.message || '游戏启动失败，请刷新后重试';
  $('error').hidden = false;
  $('start').textContent = '刷新重试';
  $('progress').hidden = true;
  // A failed engine may still own callbacks: keep its lock until reload.
  updateControls();
}

$('start').onclick = async () => {
  if (phase === 'failed') { location.reload(); return; }
  // Guard the handler as well as the button, including asynchronous imports.
  if (!canStart()) return;
  const backup = pending;
  phase = 'loading';
  controller = new AbortController();
  $('error').hidden = true;
  updateControls();
  try {
    releaseLock = await acquireSaveLock();
    controller.signal.throwIfAborted();
    navigator.storage?.persist?.().catch(() => {});
    $('start').textContent = '正在下载资源…';
    $('progress').hidden = false;
    let buffer = await loadChunks(manifest, (loaded, total) => {
      $('progress').value = loaded / total * 100;
      $('load-label').textContent = `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB · ${Math.floor(loaded / total * 100)}%`;
    }, controller.signal);
    controller.signal.throwIfAborted();
    phase = 'booting';
    updateControls();
    $('start').textContent = '正在启动游戏…';
    $('load-label').textContent = '资源已校验，正在连接本地存档…';
    bridge = new SaveBridge(text => $('save-status').textContent = text, backup, manifest.version);
    window.Module = {
      canvas: $('canvas'), webStorage: bridge,
      locateFile: path => path.endsWith('.wasm') ? manifest.wasm : path,
      getPreloadedPackage: () => { const data = buffer; buffer = null; return data; },
      onGameReady: () => {
        if (phase !== 'booting') return;
        phase = 'playing';
        document.body.classList.add('playing');
        $('fullscreen').disabled = false;
        $('canvas').focus({ preventScroll: true });
        updateControls();
      },
      onStorageError: fail,
      onAbort: reason => fail(Error('引擎启动失败：' + reason)),
      print: console.log, printErr: console.warn
    };
    const script = document.createElement('script');
    script.src = manifest.engineScript;
    script.onerror = () => fail(Error('无法加载游戏引擎，请刷新重试；仍可导出本地存档'));
    document.body.append(script);
  } catch (error) {
    if (phase === 'loading' && controller.signal.aborted && controller.signal.reason?.name === 'AbortError') {
      // No engine has been attached, and loadChunks has stopped all workers.
      releaseLock?.();
      releaseLock = undefined;
      phase = 'idle';
      $('start').textContent = '开始游戏 ↗';
      $('load-label').textContent = '下载已取消，可重新开始；已保存的存档不受影响。';
      $('progress').hidden = true;
      updateControls();
    } else fail(error);
  }
};

$('cancel').onclick = () => {
  if (phase === 'loading') controller.abort(new DOMException('下载已取消', 'AbortError'));
};
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file || !['preparing', 'idle'].includes(phase) || exporting) { input.value = ''; return; }
  const sequence = ++importSequence;
  pending = undefined;
  importing = true;
  updateControls();
  $('save-status').textContent = '正在检查备份…';
  try {
    if (file.size > 17 * 1024 * 1024) throw Error('备份过大');
    const backup = validateBackup(JSON.parse(await file.text()));
    if (sequence !== importSequence) return;
    pending = backup;
    $('save-status').textContent = '备份已检查，将在启动时导入（仅限空存档）';
  } catch (error) {
    if (sequence === importSequence) $('save-status').textContent = '未选择备份：' + error.message;
  } finally {
    if (sequence === importSequence) {
      importing = false;
      input.value = '';
      updateControls();
    }
  }
};

$('export').onclick = async () => {
  if (importing || exporting || ['loading', 'booting'].includes(phase)) return;
  exporting = true;
  updateControls();
  let releaseExport;
  try {
    if (!releaseLock) releaseExport = await acquireSaveLock();
    const fromEngine = bridge?.ready;
    const backup = fromEngine ? bridge.backup() : await readPersistedBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `flare-${backup.gameVersion || 'save'}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    $('save-status').textContent = fromEngine
      ? '已导出当前已写入的存档；游戏进度请先按 Esc 保存'
      : '已导出此浏览器中已保存的存档，无需启动游戏';
  } catch (error) {
    $('save-status').textContent = '导出失败：' + error.message;
  } finally {
    releaseExport?.();
    exporting = false;
    updateControls();
  }
};

$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('stage').requestFullscreen();
    $('canvas').focus({ preventScroll: true });
  } catch { $('save-status').textContent = '此浏览器无法进入全屏'; }
};
$('canvas').oncontextmenu = event => event.preventDefault();
$('canvas').addEventListener('keydown', event => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && bridge?.ready) bridge.flush().catch(() => {});
});

updateControls();
try {
  manifest = await loadManifest();
  phase = 'idle';
  $('start').textContent = '开始游戏 ↗';
  $('load-label').textContent = `首次启动需下载约 ${Math.ceil(manifest.totalBytes / 1048576)} MB 资源，请保持页面打开。`;
  updateControls();
} catch (error) { fail(error); }
