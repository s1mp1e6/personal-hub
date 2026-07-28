const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'site');

function serveFile(req, res) {
  const requested = new URL(req.url, 'http://127.0.0.1').pathname;
  const filePath = path.join(root, requested === '/' ? 'index.html' : decodeURIComponent(requested));
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function readDb(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('personal_hub_local_first');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const get = (store, key) => new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = store => new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = { state: await get('kv', 'personal_hub_v6'), recovery: await all('recovery'), files: await all('files') };
    db.close();
    return result;
  });
}

async function main() {
  const server = http.createServer(serveFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => hydrated);

    await page.evaluate(async () => {
      state.modules.todos.items.push({ id: 'safe-done', txt: 'done item', done: true });
      state.modules.todos.items.push({
        id: 'safe-done-file',
        txt: 'done file item',
        done: true,
        attachment: { fileId: 'safe-clean-file', name: 'clean.txt', type: 'text/plain', size: 5, kind: 'doc' }
      });
      state.modules.todos.items.push({ id: 'safe-open', txt: 'open item', done: false });
      await idbStorePut(FILE_STORE, {
        id: 'safe-clean-file',
        name: 'clean.txt',
        type: 'text/plain',
        size: 5,
        kind: 'doc',
        createdAt: '2026-07-28T00:00:00.000Z',
        blob: new Blob(['clean'], { type: 'text/plain' })
      });
      stateRevision++;
      await saveNow();
      renderNav();
      renderContent();
    });

    await page.evaluate(() => openSyncModal());
    await page.getByText('离线配对', { exact: true }).click();
    await page.getByRole('button', { name: '扫码填入对方码' }).click();
    await page.getByText('相机画面只用于本机识别二维码').waitFor();
    await page.getByRole('button', { name: '继续并请求权限' }).click();
    await page.getByText('可以改用相册识别二维码，或直接复制粘贴配对码。').waitFor();
    await page.getByRole('button', { name: '从相册识别二维码' }).waitFor();
    assert.equal(await page.evaluate(() => typeof decodeQrImageFile), 'function', 'gallery QR decoder must exist');
    assert.equal(await page.evaluate(() => {
      const original = navigator.mediaDevices;
      try {
        Object.defineProperty(navigator, 'mediaDevices', { value: null, configurable: true });
        startQrScan();
        return !!document.querySelector('#qrScanBox')?.textContent.includes('从相册识别二维码');
      } finally {
        Object.defineProperty(navigator, 'mediaDevices', { value: original, configurable: true });
      }
    }), true, 'unsupported camera branch must show gallery option');
    await page.locator('.modal .x').click();

    await page.getByLabel('打开模块导航').click();
    await page.getByRole('button', { name: '打开重置中心' }).click();
    await page.getByRole('tab', { name: '日常清理' }).click();
    await page.getByRole('button', { name: '全部选择' }).click();
    assert.equal(await page.locator('#resetCompleted').isChecked(), true, 'cleanup all-select must select completed');
    assert.equal(await page.locator('#resetArchived').isChecked(), true, 'cleanup all-select must select archived');
    await page.getByRole('button', { name: '全部不选' }).click();
    assert.equal(await page.locator('#resetCompleted').isChecked(), false, 'cleanup all-none must clear completed');
    await page.getByRole('checkbox', { name: '已完成任务' }).check();
    await page.getByText(/将处理/).waitFor();
    await page.getByRole('button', { name: '创建恢复点并清理' }).click();
    await page.getByText('清理完成').waitFor();

    const cleaned = await readDb(page);
    assert.equal(cleaned.state.modules.todos.items.some(item => item.id === 'safe-done'), false, 'completed todo should be cleaned');
    assert.equal(cleaned.state.modules.todos.items.some(item => item.id === 'safe-open'), true, 'open todo should remain');
    assert.equal(cleaned.files.some(file => file.id === 'safe-clean-file'), true, 'recovery point should protect cleaned attachment blob');
    assert.ok(cleaned.recovery.some(point => point.kind === 'daily-cleanup'), 'cleanup must create recovery point');

    await page.getByRole('button', { name: '撤销本次清理' }).click();
    await page.getByText('已撤销本次清理').waitFor();
    const restored = await readDb(page);
    assert.equal(restored.state.modules.todos.items.some(item => item.id === 'safe-done'), true, 'undo should restore cleaned todo');
    assert.equal(restored.files.some(file => file.id === 'safe-clean-file'), true, 'undo should keep restored attachment blob available');

    await page.getByRole('tab', { name: '数据重置' }).click();
    await page.getByRole('button', { name: '全部选择' }).click();
    assert.ok(await page.locator('[data-reset-module]:checked').count() >= 8, 'reset module all-select must select modules');
    await page.getByRole('button', { name: '全部不选' }).click();
    assert.equal(await page.locator('[data-reset-module]:checked').count(), 0, 'reset module all-none must clear modules');
    await page.getByRole('checkbox', { name: '外观设置' }).check();
    await page.getByText('将处理 外观设置').waitFor();
    await page.getByRole('checkbox', { name: '完整本机数据' }).check();
    let confirmed = false;
    page.once('dialog', async dialog => {
      confirmed = true;
      await dialog.accept();
    });
    await page.getByRole('button', { name: '创建恢复点并重置' }).click();
    await page.getByText('重置完成').waitFor();
    assert.equal(confirmed, true, 'full local reset must require confirmation');
    const resetDb = await readDb(page);
    assert.ok(resetDb.recovery.some(point => point.kind === 'selective-reset'), 'reset must create recovery point');
    await page.getByRole('button', { name: '撤销本次重置' }).click();
    await page.getByText('已撤销本次重置').waitFor();
    const resetUndone = await readDb(page);
    assert.equal(resetUndone.state.modules.todos.items.some(item => item.id === 'safe-done'), true, 'reset undo should restore previous data');

    await page.evaluate(async () => {
      for (let index = 0; index < 4; index++) {
        const fileId = 'retention-file-' + index;
        state.modules.todos.items.push({
          id: 'retention-done-' + index,
          txt: 'retention item ' + index,
          done: true,
          attachment: { fileId, name: fileId + '.txt', type: 'text/plain', size: 9, kind: 'doc' }
        });
        await idbStorePut(FILE_STORE, {
          id: fileId,
          name: fileId + '.txt',
          type: 'text/plain',
          size: 9,
          kind: 'doc',
          createdAt: '2026-07-28T00:00:00.000Z',
          blob: new Blob(['retained' + index], { type: 'text/plain' })
        });
        stateRevision++;
        await saveNow();
        document.getElementById('resetCompleted').checked = true;
        await applyDailyCleanup();
      }
    });
    const retained = await readDb(page);
    assert.ok(retained.recovery.length <= 3, 'reset recovery points should retain only the latest three');
    assert.equal(retained.files.some(file => file.id === 'safe-clean-file'), false, 'attachment unique to dropped recovery point should be reclaimed');
    assert.equal(retained.files.some(file => file.id === 'retention-file-0'), false, 'oldest recovery-only attachment should be reclaimed');
    assert.equal(retained.files.some(file => file.id === 'retention-file-3'), true, 'latest recovery-only attachment should remain protected');

    await context.close();
    console.log(JSON.stringify({ cameraGuide: true, resetCenter: true, resetUndo: true, recoveryUndo: true }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

