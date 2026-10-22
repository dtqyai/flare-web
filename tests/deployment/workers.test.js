import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {unstable_startWorker} from 'wrangler';

const config=JSON.parse(await readFile(new URL('../../wrangler.jsonc',import.meta.url),'utf8'));
test('Workers serves dist assets, WASM and chunks; source and config stay private',{timeout:60000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'flare-workers-'));
 let worker;
 t.after(async()=>{if(worker)await worker.dispose();await rm(root,{recursive:true,force:true});});
 assert.equal(config.assets.directory,'./dist');assert.equal(config.assets.not_found_handling,'none');
 const files={'index.html':'<html>Flare</html>','manifest.json':'{"version":"1.15"}','engine-test.wasm':'wasm','assets/00-test.bin':'chunk','source.tar.gz':'source'};
 for(const [name,data] of Object.entries(files)){
  const target=path.join(root,'dist',name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data);
 }
 for(const name of ['package.json','wrangler.jsonc','scripts/build.py','.git/config','tests/private.txt','.env']){
  const target=path.join(root,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'private');
 }
 await writeFile(path.join(root,'wrangler.jsonc'),JSON.stringify(config));
 worker=await unstable_startWorker({config:path.join(root,'wrangler.jsonc'),dev:{remote:false,watch:false,persist:false,server:{hostname:'127.0.0.1',port:0}}});
 await worker.ready;const base=(await worker.url).origin;
 for(const [name,data] of Object.entries(files)){
  const response=await fetch(base+(name==='index.html'?'/':'/'+name));assert.equal(response.status,200,name);assert.equal(await response.text(),data);
  if(name.endsWith('.wasm'))assert.match(response.headers.get('content-type'),/application\/wasm/);
 }
 for(const name of ['package.json','package-lock.json','wrangler.jsonc','upstream.json','scripts/build.py','.git/config','tests/private.txt','.env','missing-game.bin']){
  const response=await fetch(base+'/'+name);assert.equal(response.status,404,name);await response.arrayBuffer();
 }
});
