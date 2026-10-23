const IDLE_TIMEOUT_MS = 30_000;

function validateChunks(manifest) {
  const { totalBytes, chunks } = manifest;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > 900 * 1024 * 1024 || !Array.isArray(chunks)) {
    throw Error('资源清单无效');
  }
  let end = 0;
  for (const chunk of chunks) {
    if (!chunk || chunk.offset !== end || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 ||
        chunk.bytes > 24 * 1024 * 1024 || !/^assets\/\d+-[a-f0-9]+\.bin$/.test(chunk.url) ||
        !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw Error('资源清单无效');
    end += chunk.bytes;
  }
  if (end !== totalBytes) throw Error('资源大小不匹配');
}

export async function loadManifest() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('资源清单读取超时，请刷新重试')), IDLE_TIMEOUT_MS);
  try {
    const response = await fetch('manifest.json', { signal: controller.signal });
    if (!response.ok) throw Error('无法读取资源清单');
    const manifest = await response.json();
    if (!manifest || typeof manifest.version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) {
      throw Error('游戏版本清单无效');
    }
    if (!/^engine-[a-f0-9]{16}\.js$/.test(manifest.engineScript) || !/^engine-[a-f0-9]{16}\.wasm$/.test(manifest.wasm)) {
      throw Error('引擎清单无效');
    }
    validateChunks(manifest);
    return manifest;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function loadChunks(manifest, onProgress, signal, { idleTimeoutMs = IDLE_TIMEOUT_MS, retryBaseMs = 500 } = {}) {
  validateChunks(manifest);
  signal?.throwIfAborted();
  const { totalBytes, chunks } = manifest;
  const result = new Uint8Array(totalBytes);
  const progress = chunks.map(() => 0);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let next = 0;
  const update = () => onProgress(progress.reduce((a, b) => a + b, 0), totalBytes);

  async function download(chunk, index) {
    const request = new AbortController();
    const cancel = () => request.abort(controller.signal.reason);
    controller.signal.addEventListener('abort', cancel, { once: true });
    let timer, reader;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => request.abort(Error('资源下载超时，请检查网络后重试')), idleTimeoutMs);
    };
    try {
      controller.signal.throwIfAborted();
      resetTimer();
      const response = await fetch(chunk.url, { signal: request.signal });
      if (!response.ok) throw Error('资源下载失败：' + response.status);
      reader = response.body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes + value.length > chunk.bytes) throw Error('资源大小异常');
        result.set(value, chunk.offset + bytes);
        bytes += value.length;
        progress[index] = bytes;
        if (value.length) resetTimer();
        update();
      }
      clearTimeout(timer);
      if (bytes !== chunk.bytes) throw Error('资源下载不完整');
      const digest = await crypto.subtle.digest('SHA-256', result.subarray(chunk.offset, chunk.offset + chunk.bytes));
      controller.signal.throwIfAborted();
      if (Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('') !== chunk.sha256) {
        throw Error('资源校验失败');
      }
    } catch (error) {
      request.abort(error);
      throw request.signal.reason;
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
      controller.signal.removeEventListener('abort', cancel);
    }
  }

  async function worker() {
    while (next < chunks.length) {
      const index = next++;
      for (let attempt = 0; attempt < 3; attempt++) {
        controller.signal.throwIfAborted();
        progress[index] = 0;
        update();
        try {
          await download(chunks[index], index);
          break;
        } catch (error) {
          if (controller.signal.aborted || attempt === 2) throw error;
          await delay(retryBaseMs * 2 ** attempt, controller.signal);
        }
      }
    }
  }

  const workers = [worker(), worker(), worker()];
  try {
    await Promise.all(workers);
    return result.buffer;
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(workers);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
