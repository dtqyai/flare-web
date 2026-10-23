import { encodeFile, makeBackup } from './storage.js';

export const SAVE_LOCK = 'flare-web-save-v1';

export async function acquireSaveLock(locks = navigator.locks) {
  if (!locks) throw Error('此浏览器不支持安全存档锁，请使用新版 Chrome、Edge、Firefox 或 Safari。');
  return new Promise((resolve, reject) => {
    locks.request(SAVE_LOCK, { ifAvailable: true }, async lock => {
      if (!lock) throw Error('另一个标签页正在使用存档，请先关闭它。');
      await new Promise(release => resolve(release));
    }).catch(reject);
  });
}

// Read Emscripten IDBFS without a version or upgrade. This recovery path must
// never create, migrate or write a database. Browser tests use actual IDBFS.
export async function readPersistedBackup(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) throw Error('此浏览器无法读取本地存档');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('/flare_data');
    let settled = false;
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => reject(Error('没有可导出的本地存档，或浏览器无法读取存档'));
    request.onblocked = () => { settled = true; reject(Error('存档正在更新，请关闭其他游戏页面后重试')); };
    request.onsuccess = () => {
      if (settled) request.result.close();
      else resolve(request.result);
    };
  });
  db.onversionchange = () => db.close();
  try {
    if (!db.objectStoreNames.contains('FILE_DATA')) throw Error('无法识别本地存档格式');
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('FILE_DATA', 'readonly');
      const request = transaction.objectStore('FILE_DATA').openCursor();
      const files = [];
      let size = 0, failure;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const path = String(cursor.key);
          const entry = cursor.value;
          if (/^\/flare_data\/(config\/|userdata\/saves\/)/.test(path) && (entry.mode & 0xf000) === 0x8000) {
            if (!(entry.contents instanceof Uint8Array)) throw Error('本地存档内容损坏');
            size += Math.ceil(entry.contents.byteLength / 3) * 4;
            if (size > 16 * 1024 * 1024 || files.length >= 4096) throw Error('备份过大');
            files.push(encodeFile(path.slice('/flare_data/'.length), entry.contents));
          }
          cursor.continue();
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        try { resolve(makeBackup(files)); } catch (error) { reject(error); }
      };
      transaction.onabort = () => reject(failure || transaction.error || Error('无法读取本地存档'));
      transaction.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
