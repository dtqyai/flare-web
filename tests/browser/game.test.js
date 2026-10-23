import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('dist');
let browser, server, base;
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

before(async () => {
  // Fail clearly if the real compiled game is absent; never silently skip it.
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  await stat(path.join(root, manifest.wasm));
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) throw Error('Invalid path');
      const info = await stat(file);
      if (!info.isFile()) throw Error('Not a file');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
        '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}),
    args: ['--disable-dev-shm-usage']
  });
});

after(async () => {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function browserTest(name, run) {
  test(name, { timeout: 240_000 }, async () => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    try {
      await run(context);
      assert.deepEqual(errors, [], 'No uncaught browser errors');
    } catch (error) {
      await mkdir('test-results', { recursive: true });
      for (const [index, page] of context.pages().entries()) {
        await page.screenshot({ path: `test-results/${Date.now()}-${index}.png` }).catch(() => {});
      }
      throw error;
    } finally { await context.close(); }
  });
}

async function open(context) {
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  return page;
}

async function start(page) {
  await page.locator('#start').click();
  await page.waitForFunction(() => document.body.classList.contains('playing') || !document.querySelector('#error').hidden, null, { timeout: 120_000 });
  assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error').textContent());
  assert.equal(await page.evaluate(() => Module.webStorage.ready && Module.FS.analyzePath('/flare_data/config/settings.txt').exists), true);
}

async function exportBackup(page) {
  const downloaded = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloaded;
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}

browserTest('manifest completion never enables start while File.text is still pending', async context => {
  const manifest = deferred(), requested = deferred();
  const page = await context.newPage();
  await page.route('**/manifest.json', async route => { requested.resolve(); await manifest.promise; await route.continue(); });
  await page.addInitScript(() => {
    const original = File.prototype.text;
    File.prototype.text = async function () {
      await new Promise(resolve => window.finishBackupRead = resolve);
      return original.call(this);
    };
  });
  await page.goto(base, { waitUntil: 'commit' });
  await requested.promise;
  const backup = { format: 'flare-web-save', version: 1, files: [{ path: 'userdata/saves/1/avatar.txt', data: 'YWJj' }] };
  await page.locator('#import-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.waitForFunction(() => typeof window.finishBackupRead === 'function');
  manifest.resolve();
  await page.waitForFunction(() => document.querySelector('#load-label').textContent.includes('首次启动'));
  assert.equal(await page.locator('#start').isDisabled(), true);
  await page.evaluate(() => document.querySelector('#start').onclick());
  assert.equal(await page.evaluate(() => typeof window.Module), 'undefined');
  await page.evaluate(() => window.finishBackupRead());
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  assert.match(await page.locator('#save-status').textContent(), /备份已检查/);
});

browserTest('cancel stops loading and releases the real Web Lock', async context => {
  const requested = deferred(), finish = deferred();
  const page = await open(context);
  await page.route('**/assets/**', async route => { requested.resolve(); await finish.promise; await route.abort().catch(() => {}); });
  await page.locator('#start').click(); await requested.promise;
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#load-label').textContent.includes('下载已取消'));
  finish.resolve();
  assert.equal(await page.locator('#start').isDisabled(), false);
  const other = await open(context);
  assert.equal(await other.evaluate(() => navigator.locks.request('flare-web-save-v1', { ifAvailable: true }, lock => !!lock)), true);
  assert.equal(await page.evaluate(() => typeof window.Module), 'undefined');
});

browserTest('exporting an empty profile does not create or modify an IDBFS database', async context => {
  const page = await open(context);
  await page.locator('#export').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent.includes('导出失败'));
  assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === '/flare_data')), false);
  assert.equal(await page.evaluate(() => typeof window.Module), 'undefined');
});

browserTest('real WASM startup, IDBFS reload, locked export and recovery without game resources', async context => {
  let page = await open(context);
  await start(page);
  const savedPath = '/flare_data/userdata/saves/browser-regression/avatar.txt';
  const content = 'name=Browser Regression\nlevel=1\n';
  // Exercise the actual compiled filesystem and IDBFS, not an FS substitute.
  await page.evaluate(async ({ savedPath, content }) => {
    Module.FS.mkdirTree(savedPath.slice(0, savedPath.lastIndexOf('/')));
    Module.FS.writeFile(savedPath, content);
    await Module.webStorage.flush();
  }, { savedPath, content });
  const exported = await exportBackup(page);
  assert.equal(Buffer.from(exported.files.find(f => '/flare_data/' + f.path === savedPath).data, 'base64').toString(), content);

  const other = await open(context);
  await other.locator('#export').click();
  await other.waitForFunction(() => document.querySelector('#save-status').textContent.includes('另一个标签页'));
  await other.locator('#start').click();
  await other.waitForFunction(() => !document.querySelector('#error').hidden);
  assert.match(await other.locator('#error').textContent(), /另一个标签页/);
  await other.close();

  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  await start(page);
  assert.equal(await page.evaluate(savedPath => Module.FS.readFile(savedPath, { encoding: 'utf8' }), savedPath), content);
  await page.close();

  page = await context.newPage();
  let gameRequests = 0;
  await page.route('**/manifest.json', route => route.abort());
  await page.route(/\/(assets\/|engine-)/, route => { gameRequests++; return route.abort(); });
  await page.goto(base);
  await page.waitForFunction(() => !document.querySelector('#error').hidden);
  const recovered = await exportBackup(page);
  assert.equal(gameRequests, 0);
  assert.equal(await page.evaluate(() => typeof window.Module), 'undefined');
  assert.equal(Buffer.from(recovered.files.find(f => '/flare_data/' + f.path === savedPath).data, 'base64').toString(), content);

  const fresh = await browser.newContext({ acceptDownloads: true });
  try {
    const imported = await open(fresh);
    await imported.locator('#import-file').setInputFiles({ name: 'recovered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(recovered)) });
    await imported.waitForFunction(() => document.querySelector('#save-status').textContent.includes('备份已检查'));
    await start(imported);
    assert.equal(await imported.evaluate(savedPath => Module.FS.readFile(savedPath, { encoding: 'utf8' }), savedPath), content);
    const roundtrip = await exportBackup(imported);
    assert.equal(roundtrip.files.find(f => '/flare_data/' + f.path === savedPath).data, recovered.files.find(f => '/flare_data/' + f.path === savedPath).data);
  } finally { await fresh.close(); }
});
