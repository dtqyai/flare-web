import {SaveBridge,validateBackup} from './storage.js';
import {loadChunks} from './loader.js';
const $=id=>document.getElementById(id);
let manifest,pending,bridge,started=false,releaseLock,importSequence=0;
const controller=new AbortController();
function fail(error) {
  console.error(error); controller.abort(); document.body.classList.remove('playing'); $('error').textContent=error.message||'游戏启动失败，请刷新后重试'; $('error').hidden=false;
  $('start').textContent='刷新重试'; $('start').disabled=false; $('start').onclick=()=>location.reload();
  // Hold the storage lock until reload: a failed engine may still own callbacks.
  $('progress').hidden=true;
}
async function acquireLock() {
  if(!navigator.locks) throw Error('此浏览器不支持安全存档锁，请使用新版 Chrome、Edge、Firefox 或 Safari。');
  return new Promise((resolve,reject)=>{
    navigator.locks.request('flare-web-save-v1',{ifAvailable:true},async lock=>{
      if(!lock) {reject(Error('另一个标签页正在运行游戏，请先关闭它。'));return;}
      await new Promise(done=>{releaseLock=done;resolve();});
    }).catch(reject);
  });
}
$('start').onclick=async()=>{
  if(started)return; started=true; $('start').disabled=true; $('import').disabled=true;
  try {
    await acquireLock();
    navigator.storage?.persist?.().catch(()=>{});
    $('start').textContent='正在下载资源…'; $('progress').hidden=false;
    let buffer=await loadChunks(manifest,(loaded,total)=>{
      $('progress').value=loaded/total*100;
      $('load-label').textContent=`${(loaded/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB · ${Math.floor(loaded/total*100)}%`;
    },controller.signal);
    $('start').textContent='正在启动游戏…'; $('load-label').textContent='资源已校验，正在连接本地存档…';
    bridge=new SaveBridge(text=>$('save-status').textContent=text,pending,manifest.version);
    window.Module={canvas:$('canvas'),webStorage:bridge,
      locateFile:path=>path.endsWith('.wasm')?manifest.wasm:path,
      getPreloadedPackage:()=>{const data=buffer;buffer=null;return data;},
      onGameReady:()=>{document.body.classList.add('playing');$('export').disabled=false;$('fullscreen').disabled=false;$('canvas').focus({preventScroll:true});},
      onStorageError:fail,onAbort:reason=>fail(Error('引擎启动失败：'+reason)),
      print:console.log,printErr:console.warn};
    const script=document.createElement('script');script.src=manifest.engineScript;script.onerror=()=>fail(Error('无法加载游戏引擎，请刷新重试'));document.body.append(script);
  } catch(e){fail(e);}
};
$('import').onclick=()=>$('import-file').click();
$('import-file').onchange=async event=>{
  const file=event.target.files[0]; if(!file)return;
  const sequence=++importSequence; pending=undefined; $('start').disabled=true;
  $('save-status').textContent='正在检查备份…';
  try {
    if(file.size>17*1024*1024)throw Error('备份过大');
    const backup=validateBackup(JSON.parse(await file.text()));
    if(sequence!==importSequence)return;
    pending=backup; $('save-status').textContent='备份已检查，将在启动时导入（仅限空存档）';
  } catch(e){if(sequence===importSequence)$('save-status').textContent='未选择备份：'+e.message;}
  finally {if(sequence===importSequence){event.target.value='';$('start').disabled=started||!manifest;}}
};
$('export').onclick=()=>{
  try {const backup=bridge.backup();const url=URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`flare-${manifest.version}-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);$('save-status').textContent='已导出当前已写入的存档；游戏进度请先按 Esc 保存';}
  catch(e){$('save-status').textContent=e.message;}
};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('stage').requestFullscreen();$('canvas').focus({preventScroll:true});}catch(e){$('save-status').textContent='此浏览器无法进入全屏';}};
$('canvas').oncontextmenu=e=>e.preventDefault();
$('canvas').addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key))e.preventDefault();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&bridge?.ready)bridge.flush().catch(()=>{});});
try {const response=await fetch('manifest.json');if(!response.ok)throw Error('无法读取资源清单');manifest=await response.json();if(typeof manifest.version!=='string'||!/^\d+\.\d+(?:\.\d+)?$/.test(manifest.version))throw Error('游戏版本清单无效');if(!/^engine-[a-f0-9]{16}\.js$/.test(manifest.engineScript)||!/^engine-[a-f0-9]{16}\.wasm$/.test(manifest.wasm))throw Error('引擎清单无效');$('start').disabled=false;$('start').innerHTML='开始游戏 <span>↗</span>';$('load-label').textContent=`首次启动需下载约 ${Math.ceil(manifest.totalBytes/1048576)} MB 资源，请保持页面打开。`;}
catch(e){fail(e);}
