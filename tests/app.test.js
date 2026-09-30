import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {validateBackup} from '../web/storage.js';
const code=(await readFile(new URL('../web/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
async function harness(version="1.16.2") {
 const elements=new Map(),classes=new Set();let selected,gameVersion,download;
 const element=id=>{if(!elements.has(id))elements.set(id,{disabled:false,hidden:false,textContent:'',addEventListener(){},focus(){},click(){}});return elements.get(id);};
 const window={};
 const context=vm.createContext({window,console:{error(){},log(){},warn(){}},AbortController,Blob,URL,setTimeout,validateBackup,
 document:{getElementById:element,body:{classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},append(){}},createElement:()=>{download={click(){}};return download;},addEventListener(){}},
 navigator:{locks:{request:(name,opts,fn)=>{void fn({});return Promise.resolve();}}},
 fetch:async()=>({ok:true,json:async()=>({version,totalBytes:1,engineScript:'engine-0000000000000000.js',wasm:'engine-1111111111111111.wasm'})}),
 loadChunks:async()=>new ArrayBuffer(0),SaveBridge:class{constructor(status,pending,version){selected=pending;gameVersion=version;}backup(){return valid;}}});
 await vm.runInContext('(async()=>{'+code+'})()',context);
 return {element,classes,window,selected:()=>selected,version:()=>gameVersion,download:()=>download};
}
const valid={format:'flare-web-save',version:1,files:[{path:'userdata/saves/1/avatar.txt',data:'YWJj'}]};
const event=text=>({target:{files:[{size:100,text:async()=>text}],value:'a'}});
test('invalid replacement import clears the previously selected backup',async()=>{
 const h=await harness();await h.element('import-file').onchange(event(JSON.stringify(valid)));await h.element('import-file').onchange(event('{bad'));
 assert.match(h.element('save-status').textContent,/未选择备份/);await h.element('start').onclick();assert.equal(h.selected(),undefined);
});
test('late import reads cannot replace newer choices, and start is disabled during reads',async()=>{
 const h=await harness();let release;const slow={target:{files:[{size:100,text:()=>new Promise(r=>release=r)}]}};
 const first=h.element('import-file').onchange(slow);assert.equal(h.element('start').disabled,true);
 await h.element('import-file').onchange(event('{bad'));release(JSON.stringify(valid));await first;
 await h.element('start').onclick();assert.equal(h.selected(),undefined);
});
test('runtime abort reveals retry overlay after game ready and keeps export accessible',async()=>{
 const h=await harness();await h.element('start').onclick();h.window.Module.onGameReady();assert.equal(h.classes.has('playing'),true);
 h.window.Module.onAbort('test');assert.equal(h.classes.has('playing'),false);assert.equal(h.element('error').hidden,false);assert.equal(h.element('start').disabled,false);assert.equal(h.element('export').disabled,false);
});

test('manifest version reaches save metadata and backup filename',async()=>{
 const h=await harness();await h.element('start').onclick();assert.equal(h.version(),'1.16.2');
 h.element('export').onclick();assert.match(h.download().download,/^flare-1\.16\.2-\d{4}-\d{2}-\d{2}\.json$/);
});
test('invalid manifest version leaves startup on the retry path',async()=>{
 for(const version of [undefined,'1.16-beta','1.16/evil']) {
  const h=await harness(version===undefined?null:version);
  assert.match(h.element('error').textContent,/版本清单无效/);assert.equal(h.element('error').hidden,false);
 }
});
