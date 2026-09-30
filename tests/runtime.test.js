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
