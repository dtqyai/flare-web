import test from 'node:test';
import assert from 'node:assert/strict';
import {SaveBridge,validateBackup} from '../web/storage.js';
import {loadChunks} from '../web/loader.js';
const valid=()=>({format:'flare-web-save',version:1,files:[{path:'userdata/saves/1/avatar.txt',data:'YWJj'}]});
test('backup rejects traversal, duplicate paths, invalid content and empty saves',()=>{
  assert.equal(validateBackup(valid()).files.length,1);
  for(const path of ['userdata/saves/../x','/userdata/saves/1','userdata/saves//x','config/./x','userdata/mods/x']) {const v=valid();v.files[0].path=path;assert.throws(()=>validateBackup(v));}
  const duplicate=valid();duplicate.files.push({...duplicate.files[0]});assert.throws(()=>validateBackup(duplicate));
  const broken=valid();broken.files[0].data='!';assert.throws(()=>validateBackup(broken));
  assert.throws(()=>validateBackup({...valid(),files:[]}));
});
test('storage serializes writes and persists mutations made during a pending write',async()=>{
  const callbacks=[];let active=0,peak=0;const bridge=new SaveBridge(()=>{});bridge.ready=true;
  bridge.fs={syncfs(read,cb){active++;peak=Math.max(peak,active);callbacks.push(e=>{active--;cb(e);});}};
  const p=bridge.flush();bridge.commit();assert.equal(callbacks.length,1);callbacks.shift()();await Promise.resolve();assert.equal(callbacks.length,1);callbacks.shift()();await p;assert.equal(peak,1);assert.equal(bridge.dirty,false);
});
test('storage write errors stay dirty and allow explicit retry',async()=>{
  let fails=true;const bridge=new SaveBridge(()=>{});bridge.ready=true;bridge.fs={syncfs(read,cb){queueMicrotask(()=>cb(fails?Error('quota'):null));}};
  await assert.rejects(bridge.flush());assert.equal(bridge.dirty,true);fails=false;await bridge.flush();assert.equal(bridge.dirty,false);
});
test('failed storage read never unlocks game or writes data',async()=>{
  let error,writes=0;const module={syncdone:0,onStorageError:e=>error=e};const bridge=new SaveBridge(()=>{});
  await bridge.init({mkdirTree(){},mount(){},syncfs(read,cb){assert.equal(read,true);cb(Error('read failure'));},writeFile(){writes++;}}, {},module);
  assert.equal(module.syncdone,0);assert.equal(writes,0);assert.match(error.message,/read failure/);
});
test('chunk loader retries corrupt data then validates bytes',async()=>{
  const data=new Uint8Array([1,2,3]);const digest=Buffer.from(await crypto.subtle.digest('SHA-256',data)).toString('hex');
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(calls===1?new Uint8Array([9,9,9]):data);};
  try {const result=await loadChunks({totalBytes:3,chunks:[{url:'assets/00-ab.bin',bytes:3,offset:0,sha256:digest}]},()=>{},new AbortController().signal);assert.deepEqual(new Uint8Array(result),data);assert.equal(calls,2);}
  finally {globalThis.fetch=original;}
});
test('chunk loader rejects invalid manifest and aborted requests',async()=>{
  await assert.rejects(loadChunks({totalBytes:2,chunks:[]},()=>{}));
  const signal=AbortSignal.abort();await assert.rejects(loadChunks({totalBytes:1,chunks:[{url:'assets/00-ab.bin',bytes:1,offset:0,sha256:'0'.repeat(64)}]},()=>{},signal));
});
test('large valid backup avoids regex stack overflow; conflicting paths rejected before writes',()=>{
  const large=valid();large.files[0].data='A'.repeat(8_000_000);assert.equal(validateBackup(large),large);
  const conflict=valid();conflict.files.push({path:'config/a',data:''},{path:'config/a/b',data:''});assert.throws(()=>validateBackup(conflict),/冲突/);
});

test('save exports record the running game version and retain the backup format',()=>{
 const bridge=new SaveBridge(()=>{},undefined,'1.16.2');
 bridge.files=()=>['/flare_data/userdata/saves/1/avatar.txt'];bridge.fs={readFile:()=>new Uint8Array([97,98,99])};
 const backup=bridge.backup();assert.equal(backup.gameVersion,'1.16.2');assert.equal(backup.version,1);
 assert.equal(backup.files[0].data,'YWJj');
});

test('stalled response bodies time out, retry three times, and release their streams', async () => {
  const original = globalThis.fetch; let calls = 0, aborted = 0;
  globalThis.fetch = async (url, { signal }) => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => { aborted++; controller.error(signal.reason); }, { once: true });
      }
    }));
  };
  try {
    await assert.rejects(loadChunks({ totalBytes: 1, chunks: [{ url: 'assets/00-ab.bin', bytes: 1, offset: 0, sha256: '0'.repeat(64) }] },
      () => {}, undefined, { idleTimeoutMs: 20, retryBaseMs: 1 }), /超时/);
    assert.equal(calls, 3); assert.equal(aborted, 3);
  } finally { globalThis.fetch = original; }
});

test('requests waiting for headers also time out and retry', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  try {
    await assert.rejects(loadChunks({ totalBytes: 1, chunks: [{ url: 'assets/00-ab.bin', bytes: 1, offset: 0, sha256: '0'.repeat(64) }] },
      () => {}, undefined, { idleTimeoutMs: 20, retryBaseMs: 1 }), /超时/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('cancellation stops all download workers without retrying', async () => {
  const original = globalThis.fetch, controller = new AbortController();
  let calls = 0, aborted = 0, started;
  const ready = new Promise(resolve => started = resolve);
  globalThis.fetch = (url, { signal }) => {
    if (++calls === 3) started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  };
  try {
    const pending = loadChunks({ totalBytes: 3, chunks: [0, 1, 2].map(i => ({ url: `assets/0${i}-ab.bin`, bytes: 1, offset: i, sha256: '0'.repeat(64) })) }, () => {}, controller.signal);
    await ready; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls, 3); assert.equal(aborted, 3);
  } finally { globalThis.fetch = original; }
});

test('a permanently failed chunk aborts its stalled siblings before returning', async () => {
  const original = globalThis.fetch; let aborted = 0;
  globalThis.fetch = (url, { signal }) => url.includes('00-') ? Promise.resolve(new Response('', { status: 503 })) :
    new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  try {
    await assert.rejects(loadChunks({ totalBytes: 3, chunks: [0, 1, 2].map(i => ({ url: `assets/0${i}-ab.bin`, bytes: 1, offset: i, sha256: '0'.repeat(64) })) },
      () => {}, undefined, { retryBaseMs: 1 }), /503/);
    assert.equal(aborted, 2);
  } finally { globalThis.fetch = original; }
});

test('manifest validation rejects bad versions and incomplete chunk maps before enabling start', async () => {
  const { loadManifest } = await import('../web/loader.js');
  const original = globalThis.fetch;
  const good = { version: '1.15', engineScript: 'engine-0000000000000000.js', wasm: 'engine-1111111111111111.wasm', totalBytes: 1,
    chunks: [{ url: 'assets/00-ab.bin', bytes: 1, offset: 0, sha256: '0'.repeat(64) }] };
  try {
    for (const version of [undefined, null, '1.16-beta', '1.16/evil']) {
      globalThis.fetch = async () => Response.json({ ...good, version });
      await assert.rejects(loadManifest(), /版本清单无效/);
    }
    globalThis.fetch = async () => Response.json({ ...good, chunks: [] });
    await assert.rejects(loadManifest(), /资源大小不匹配/);
    globalThis.fetch = async () => Response.json(good);
    assert.deepEqual(await loadManifest(), good);
  } finally { globalThis.fetch = original; }
});
