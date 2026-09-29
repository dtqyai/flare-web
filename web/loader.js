export async function loadChunks(manifest,onProgress,signal) {
  const {totalBytes,chunks}=manifest;
  if(!Number.isSafeInteger(totalBytes)||totalBytes<=0||totalBytes>900*1024*1024||!Array.isArray(chunks)) throw Error('资源清单无效');
  let end=0;
  for(const c of chunks) {
    if(c.offset!==end||!Number.isSafeInteger(c.bytes)||c.bytes<=0||c.bytes>24*1024*1024||!/^assets\/\d+-[a-f0-9]+\.bin$/.test(c.url)||!/^[a-f0-9]{64}$/.test(c.sha256)) throw Error('资源清单无效');
    end+=c.bytes;
  }
  if(end!==totalBytes) throw Error('资源大小不匹配');
  const result=new Uint8Array(totalBytes), progress=chunks.map(()=>0); let next=0;
  const update=()=>onProgress(progress.reduce((a,b)=>a+b,0),totalBytes);
  async function worker() {
    while(next<chunks.length) {
      const i=next++, c=chunks[i];
      for(let attempt=0;attempt<3;attempt++) {
        try {
          signal?.throwIfAborted(); progress[i]=0; update();
          const response=await fetch(c.url,{signal}); if(!response.ok) throw Error('资源下载失败：'+response.status);
          const reader=response.body.getReader(); let bytes=0;
          try { for(;;) { const {done,value}=await reader.read(); if(done) break; if(bytes+value.length>c.bytes) throw Error('资源大小异常'); result.set(value,c.offset+bytes); bytes+=value.length; progress[i]=bytes; update(); } }
          catch(e) { await reader.cancel(); throw e; }
          if(bytes!==c.bytes) throw Error('资源下载不完整');
          const digest=await crypto.subtle.digest('SHA-256',result.subarray(c.offset,c.offset+c.bytes));
          if(Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')!==c.sha256) throw Error('资源校验失败');
          break;
        } catch(e) { if(signal?.aborted||attempt===2) throw e; }
      }
    }
  }
  await Promise.all([worker(),worker(),worker()]); return result.buffer;
}
