const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'site');
const DB_NAME = 'personal_hub_local_first';
const STATE_KEY = 'personal_hub_v6';

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

async function openSync(page) {
  await page.locator('.sidebar .foot button').last().click();
  await page.getByLabel('打开近距离设备同步').click();
  await page.getByRole('heading', { name: '近距离设备同步' }).waitFor();
}

async function seed(page, side) {
  await page.evaluate(async sideName => {
    const shared = {
      id: 'v2-shared-diary', date: '2026-07-28', mood: '平静', title: '共同日记',
      content: 'base', img: null, attachment: null, attType: null, createdAt: '2026-07-28'
    };
    state.modules.diary.items = [shared];
    stateRevision++;
    await saveNow();
    state.modules.diary.items[0].content = sideName + ' diary edit';
    if (sideName === 'sender') {
      state.modules.todos.items.push({ id: 'v2-sender-only', txt: 'sender only todo', done: false });
    } else {
      state.modules.papers.items.push({ id: 'v2-receiver-only', title: 'receiver only paper', summary: '' });
    }
    stateRevision++;
    await saveNow();
    renderNav();
    renderContent();
  }, side);
}

async function pair(sender, receiver) {
  for (const page of [sender, receiver]) {
    const fallback = page.getByText('离线配对', { exact: true });
    if (await page.locator('details[open] summary').filter({ hasText: '离线配对' }).count() === 0) await fallback.click();
  }
  await sender.getByRole('button', { name: '创建发送码' }).click();
  await sender.waitForFunction(() => document.querySelector('#syncLocal')?.value.startsWith('ph1.'));
  const offer = await sender.locator('#syncLocal').inputValue();
  await receiver.locator('#syncRemote').fill(offer);
  await receiver.getByRole('button', { name: '生成接收码' }).click();
  await receiver.waitForFunction(() => document.querySelector('#syncLocal')?.value.startsWith('ph1.'));
  const answer = await receiver.locator('#syncLocal').inputValue();
  await sender.locator('#syncRemote').fill(answer);
  await sender.getByRole('button', { name: '连接接收码' }).click();
  await Promise.all([
    sender.getByText('比较数据', { exact: true }).waitFor(),
    receiver.getByText('比较数据', { exact: true }).waitFor()
  ]);
}

async function readDb(page) {
  return page.evaluate(async ({ dbName, stateKey }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
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
    const result = { state: await get('kv', stateKey), recovery: await all('recovery'), files: await all('files') };
    db.close();
    return result;
  }, { dbName: DB_NAME, stateKey: STATE_KEY });
}

async function main() {
  const server = http.createServer(serveFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const senderContext = await browser.newContext();
    const receiverContext = await browser.newContext();
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    for (const page of [sender, receiver]) {
      page.on('pageerror', error => errors.push(error.message));
    }
    await Promise.all([sender.goto(url), receiver.goto(url)]);
    await Promise.all([sender.waitForFunction(() => hydrated), receiver.waitForFunction(() => hydrated)]);
    await Promise.all([seed(sender, 'sender'), seed(receiver, 'receiver')]);
    await Promise.all([openSync(sender), openSync(receiver)]);

    for (const page of [sender, receiver]) {
      await page.getByRole('button', { name: '选择同步内容' }).click();
      await page.getByRole('button', { name: '全部不选' }).click();
      assert.equal(await page.locator('[data-sync-module]:checked').count(), 0, 'all-none must clear modules');
      await page.getByRole('button', { name: '全部选择' }).click();
      assert.ok(await page.locator('[data-sync-module]:checked').count() >= 8, 'all-select must select modules');
    }
    await receiver.getByRole('checkbox', { name: '文献总结' }).uncheck();
    assert.match(await receiver.locator('#syncScopeSummary').textContent(), /条.*(?:B|KB)/, 'scope summary needs records and bytes');

    await pair(sender, receiver);
    for (const page of [sender, receiver]) {
      await page.getByRole('button', { name: '安全同步' }).click();
      const conflict = page.locator('[data-sync-category="conflictCopy"] input[type="checkbox"]');
      assert.ok(await conflict.count(), 'concurrent diary must appear in comparison');
      assert.equal(await conflict.isChecked(), false, 'safe mode must not select conflicts');
      assert.equal(await page.locator('[data-sync-category="pendingDelete"] input:checked').count(), 0, 'safe mode must not select deletes');
    }

    await receiver.getByRole('button', { name: '自定义', exact: true }).click();
    await receiver.locator('[data-sync-category="conflictCopy"] input[type="checkbox"]').check();
    assert.match(await receiver.locator('#syncPlanSummary').textContent(), /条.*(?:B|KB)/, 'plan summary needs records and bytes');
    await Promise.all([
      sender.getByRole('button', { name: '确认同步' }).click(),
      receiver.getByRole('button', { name: '确认同步' }).click()
    ]);
    try {
      await Promise.all([
        sender.getByRole('strong').filter({ hasText: /^同步完成$/ }).waitFor(),
        receiver.getByRole('strong').filter({ hasText: /^同步完成$/ }).waitFor()
      ]);
    } catch (error) {
      console.error('sender status:', await sender.locator('#syncStatus').textContent(), await sender.evaluate(() => syncProtocolTrace));
      console.error('receiver status:', await receiver.locator('#syncStatus').textContent(), await receiver.evaluate(() => syncProtocolTrace));
      console.error('page errors:', errors);
      throw error;
    }

    const senderDb = await readDb(sender);
    const receiverDb = await readDb(receiver);
    assert.equal(receiverDb.state.modules.todos.items.some(item => item.id === 'v2-sender-only'), true,
      'selected sender todo must reach receiver IDB');
    assert.equal(senderDb.state.modules.papers.items.some(item => item.id === 'v2-receiver-only'), false,
      'receiver-cancelled paper must not reach sender');
    const receiverDiaries = receiverDb.state.modules.diary.items.filter(item => item.id === 'v2-shared-diary' || item._sync?.conflictOf === 'v2-shared-diary');
    assert.equal(receiverDiaries.length, 2, 'selected concurrent diary must create a conflict copy');
    assert.ok(receiverDb.recovery.some(point => point?.kind === 'device-sync'), 'transaction must create an undo recovery point');
    assert.equal(await receiver.getByText('已创建 1 条同步副本').count(), 1, 'result must summarize conflict copies');
    await receiver.getByRole('button', { name: '撤销本次同步' }).click();
    await receiver.getByText('已撤销本次同步', { exact: true }).first().waitFor();
    const undone = await readDb(receiver);
    assert.equal(undone.state.modules.todos.items.some(item => item.id === 'v2-sender-only'), false, 'undo must restore pre-sync state');

    const beforeAbort = JSON.stringify(undone.state);
    await receiver.evaluate(() => {
      syncIncoming = { protocol: 2, transferId: 'abort-probe', chunks: ['{"state":{"modules":{}}}'], received: 1, total: 1, totalBytes: 24 };
      receiveSyncMessage(JSON.stringify({ protocol: 2, type: 'abort', reason: 'test interruption' }));
    });
    assert.equal(JSON.stringify((await readDb(receiver)).state), beforeAbort, 'abort must not partially commit staged data');

    const beforeForged = await readDb(receiver);
    await receiver.evaluate(async () => {
      const payload = JSON.stringify({
        scope: { modules: [], includeSettings: false, includeAttachments: true },
        state: { modules: {}, _sync: { tombstones: [] } },
        files: [{ id: 'forged-unreferenced', name: 'forged.txt', type: 'text/plain', size: 1, kind: 'attachment', createdAt: '2026-07-28', dataUrl: 'data:text/plain;base64,QQ==' }]
      });
      const bytes = new Blob([payload]).size;
      await receiveSyncMessage(JSON.stringify({ protocol: 2, type: 'data-start', transferId: 'forged-transfer', modules: [], totalChunks: 1, totalBytes: bytes, attachmentCount: 1, attachmentBytes: 1 }));
      await receiveSyncMessage(JSON.stringify({ protocol: 2, type: 'data-chunk', chunk: { index: 0, total: 1, payload } }));
      await receiveSyncMessage(JSON.stringify({ protocol: 2, type: 'data-end', transferId: 'forged-transfer', totalChunks: 1, totalBytes: bytes }));
    });
    const afterForged = await readDb(receiver);
    assert.equal(afterForged.files.length, beforeForged.files.length, 'unreferenced attachment must not be committed');
    assert.equal(afterForged.recovery.length, beforeForged.recovery.length, 'rejected staged data must not create recovery points');

    const trace = new Set([...(await sender.evaluate(() => syncProtocolTrace)), ...(await receiver.evaluate(() => syncProtocolTrace))]);
    for (const type of ['scope-offer', 'manifest-request', 'manifest', 'plan-selection', 'data-start', 'data-chunk', 'data-end', 'commit-result', 'abort']) {
      assert.ok(trace.has(type), `protocol trace missing ${type}`);
    }
    assert.equal(await sender.getByText('离线配对').count(), 1, 'offline long-code fallback must remain');
    assert.deepEqual(errors, [], 'unexpected page errors');
    console.log(JSON.stringify({ selectiveSync: true, transactionalCommit: true, conflictCopy: true, undo: true, abortSafe: true }));
    await Promise.all([senderContext.close(), receiverContext.close()]);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
