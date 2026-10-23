import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { validateBackup } from '../web/storage.js';
const code = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const valid = { format: 'flare-web-save', version: 1, files: [{ path: 'userdata/saves/1/avatar.txt', data: 'YWJj' }] };
const event = text => ({ target: { files: [{ size: 100, text: async () => text }], value: 'a' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const manifest = { version: '1.16.2', totalBytes: 1, engineScript: 'engine-0000000000000000.js', wasm: 'engine-1111111111111111.wasm' };

function harness(options = {}) {
  const elements = new Map(), classes = new Set();
  let selected, gameVersion, download, released = 0, acquired = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, hidden: false, textContent: '', addEventListener() {}, focus() {}, click() {} });
    return elements.get(id);
  };
  const window = {};
  const context = vm.createContext({ window, console: { error() {}, log() {}, warn() {} }, AbortController, DOMException, Blob, URL,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, validateBackup,
    location: { reload() {} },
    document: { getElementById: element, body: { classList: { add: x => classes.add(x), remove: x => classes.delete(x) }, append() {} },
      createElement: () => { download = { click() {}, remove() {} }; return download; }, addEventListener() {} },
    navigator: {},
    acquireSaveLock: async () => { acquired++; return () => released++; },
    readPersistedBackup: options.readPersistedBackup || (async () => valid),
    loadManifest: options.loadManifest || (async () => manifest),
    loadChunks: options.loadChunks || (async () => new ArrayBuffer(0)),
    SaveBridge: class {
      constructor(status, pending, version) { selected = pending; gameVersion = version; this.ready = true; }
      backup() { return { ...valid, gameVersion }; }
    }
  });
  const ready = vm.runInContext('(async()=>{' + code + '})()', context);
  return { ready, element, classes, window, selected: () => selected, version: () => gameVersion,
    download: () => download, acquired: () => acquired, released: () => released };
}

test('invalid replacement import clears the previously selected backup', async () => {
  const h = harness(); await h.ready;
  await h.element('import-file').onchange(event(JSON.stringify(valid)));
  await h.element('import-file').onchange(event('{bad'));
  assert.match(h.element('save-status').textContent, /未选择备份/);
  await h.element('start').onclick(); assert.equal(h.selected(), undefined);
});

test('late import reads cannot replace newer choices', async () => {
  const h = harness(); await h.ready;
  const read = deferred();
  const first = h.element('import-file').onchange({ target: { files: [{ size: 100, text: () => read.promise }] } });
  assert.equal(h.element('start').disabled, true);
  await h.element('start').onclick(); assert.equal(h.acquired(), 0);
  await h.element('import-file').onchange(event('{bad'));
  read.resolve(JSON.stringify(valid)); await first;
  await h.element('start').onclick(); assert.equal(h.selected(), undefined);
});

test('manifest completion cannot unlock startup during a pending backup read', async () => {
  const loading = deferred(), reading = deferred();
  const h = harness({ loadManifest: () => loading.promise });
  const imported = h.element('import-file').onchange({ target: { files: [{ size: 100, text: () => reading.promise }] } });
  loading.resolve(manifest); await h.ready;
  assert.equal(h.element('start').disabled, true);
  await h.element('start').onclick(); assert.equal(h.acquired(), 0);
  reading.resolve(JSON.stringify(valid)); await imported;
  assert.equal(h.element('start').disabled, false);
  await h.element('start').onclick(); assert.deepEqual(JSON.parse(JSON.stringify(h.selected())), valid);
});

test('runtime abort reveals retry overlay, keeps export accessible and retains lock', async () => {
  const h = harness(); await h.ready; await h.element('start').onclick(); h.window.Module.onGameReady();
  assert.equal(h.classes.has('playing'), true);
  h.window.Module.onAbort('test');
  assert.equal(h.classes.has('playing'), false); assert.equal(h.element('error').hidden, false);
  assert.equal(h.element('start').disabled, false); assert.equal(h.element('export').disabled, false);
  assert.equal(h.released(), 0);
});

test('manifest version reaches save metadata and backup filename', async () => {
  const h = harness(); await h.ready; await h.element('start').onclick(); h.window.Module.onGameReady();
  assert.equal(h.version(), '1.16.2');
  await h.element('export').onclick(); assert.match(h.download().download, /^flare-1\.16\.2-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(h.acquired(), 1); assert.equal(h.released(), 0);
});

test('persisted saves can be exported when the manifest fails, without an engine', async () => {
  const h = harness({ loadManifest: async () => { throw Error('manifest unavailable'); } }); await h.ready;
  assert.equal(h.element('export').disabled, false);
  await h.element('export').onclick();
  assert.match(h.download().download, /^flare-save-/); assert.equal(h.window.Module, undefined);
  assert.equal(h.acquired(), 1); assert.equal(h.released(), 1);
});

test('standalone export blocks startup and releases its lock after read failure', async () => {
  const reading = deferred();
  const h = harness({ readPersistedBackup: () => reading.promise }); await h.ready;
  const exporting = h.element('export').onclick();
  assert.equal(h.element('start').disabled, true); await h.element('start').onclick();
  assert.equal(h.window.Module, undefined);
  reading.reject(Error('read failure')); await exporting;
  assert.equal(h.element('start').disabled, false); assert.equal(h.released(), 1);
  assert.match(h.element('save-status').textContent, /read failure/);
});

test('cancelling downloads releases the lock and allows another start with the same backup', async () => {
  const entered = deferred(); let calls = 0;
  const h = harness({ loadChunks: async (m, p, signal) => {
    if (++calls > 1) return new ArrayBuffer(0);
    entered.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await h.ready; await h.element('import-file').onchange(event(JSON.stringify(valid)));
  const starting = h.element('start').onclick(); await entered.promise;
  h.element('cancel').onclick(); await starting;
  assert.equal(h.released(), 1); assert.equal(h.element('start').disabled, false); assert.equal(h.window.Module, undefined);
  await h.element('start').onclick(); assert.deepEqual(JSON.parse(JSON.stringify(h.selected())), valid);
});
