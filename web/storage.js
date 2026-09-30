const ROOT='/flare_data';
export function validateBackup(value) {
  if(!value || value.format!=='flare-web-save' || value.version!==1 || !Array.isArray(value.files) || value.files.length>4096) throw Error('备份格式不正确');
  const seen=new Set(); let size=0;
  for(const f of value.files) {
    if(!f || typeof f.path!=='string' || !/^(config\/|userdata\/saves\/)[A-Za-z0-9_./-]+$/.test(f.path) || f.path.split('/').some(p=>!p || p==='.' || p==='..') || seen.has(f.path)) throw Error('备份路径不正确');
    if(typeof f.data!=='string' || (f.data.length%4!==0 || /[^A-Za-z0-9+/=]/.test(f.data) || !/^[^=]*={0,2}$/.test(f.data))) throw Error('备份内容损坏');
    size+=f.data.length; if(size>16*1024*1024) throw Error('备份过大'); seen.add(f.path);
  }
  for(const path of seen) { const parts=path.split('/'); while(parts.length>1) {parts.pop(); if(seen.has(parts.join('/'))) throw Error('备份路径相互冲突');} }
  if(!value.files.some(f=>f.path.startsWith('userdata/saves/'))) throw Error('备份中没有角色存档');
  return value;
}
export class SaveBridge {
  constructor(status, pending, gameVersion) { this.gameVersion=gameVersion; this.status=status; this.pending=pending; this.dirty=false; this.running=false; this.waiters=[]; }
  sync(read) { return new Promise((resolve,reject)=>this.fs.syncfs(read,e=>e?reject(e):resolve())); }
  files(dir=ROOT) {
    if(!this.fs.analyzePath(dir).exists) return [];
    return this.fs.readdir(dir).filter(n=>n!=='.'&&n!=='..').flatMap(n=>{
      const path=dir+'/'+n; return this.fs.isDir(this.fs.stat(path).mode)?this.files(path):[path];
    });
  }
  async init(fs,idbfs,module) {
    this.fs=fs;
    try {
      fs.mkdirTree(ROOT); fs.mount(idbfs,{},ROOT); await this.sync(true);
      if(this.pending) {
        validateBackup(this.pending);
        if(this.files(ROOT+'/userdata/saves').length) throw Error('此浏览器已有存档，不能覆盖。请在新的浏览器配置中导入。');
        for(const f of this.pending.files) { const path=ROOT+'/'+f.path; fs.mkdirTree(path.slice(0,path.lastIndexOf('/'))); fs.writeFile(path,Uint8Array.from(atob(f.data),c=>c.charCodeAt(0))); }
      }
      fs.mkdirTree(ROOT+'/config');
      const config=ROOT+'/config/settings.txt';
      if(!fs.analyzePath(config).exists) fs.writeFile(config,'language=zh\nfullscreen=0\nresolution_w=1280\nresolution_h=720\nenable_threaded_image_load=0\nsetup_language=1\nsetup_mousemove=1\n');
      await this.sync(false); this.ready=true; module.syncdone=1; this.status('本地存档已连接');
    } catch(e) { module.onStorageError(e); }
  }
  commit() { this.dirty=true; if(this.ready) void this.drain(); }
  async drain() {
    if(this.running) return; this.running=true;
    try {
      while(this.dirty) { this.dirty=false; this.status('正在保存…'); await this.sync(false); }
      this.status('已保存到此浏览器'); this.waiters.splice(0).forEach(w=>w.resolve());
    } catch(e) { this.dirty=true; this.status('保存失败，请导出备份'); this.waiters.splice(0).forEach(w=>w.reject(e)); }
    finally { this.running=false; }
  }
  flush() { return new Promise((resolve,reject)=>{this.waiters.push({resolve,reject}); this.commit();}); }
  backup() {
    const files=this.files().filter(p=>/^(config\/|userdata\/saves\/)/.test(p.slice(ROOT.length+1))).map(path=>{
      const bytes=this.fs.readFile(path); let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      return {path:path.slice(ROOT.length+1),data:btoa(binary)};
    });
    return validateBackup({format:'flare-web-save',version:1,gameVersion:this.gameVersion,exportedAt:new Date().toISOString(),files});
  }
}
