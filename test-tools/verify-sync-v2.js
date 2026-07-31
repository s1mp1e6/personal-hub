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
  await page.locator('button[onclick="openSyncModal()"]').click();
  await page.getByRole('heading', { name: '近距离设备同步' }).waitFor();
}

async function seed(page, side) {
  await page.evaluate(async sideName => {
    const shared = {
      id: 'v2-shared-diary', date: '2026-07-28', mood: '平静', title: '共同日记',
      content: 'base', img: null, attachment: null, attType: null, createdAt: '2026-07-28'
    };
    state.modules.diary.items = [shared];
    state.modules.todos.items = [
      { id: 'v2-same-record', txt: 'same on both', done: false },
      { id: 'v2-delete-candidate', txt: 'delete safety', done: false }
    ];
    stateRevision++;
    await saveNow();
    state.modules.diary.items[0].content = sideName + ' diary edit';
    if (sideName === 'sender') {
      state.modules.diary.items[0].attachment = { fileId: 'v2-sync-attachment', name: 'sync.txt', type: 'text/plain', size: 4096, kind: 'doc' };
      state.modules.diary.items[0].attType = 'doc';
      state.modules.todos.items.push({ id: 'v2-sender-only', txt: 'sender only todo', done: false });
      await idbStorePut(FILE_STORE, {
        id: 'v2-sync-attachment',
        name: 'sync.txt',
        type: 'text/plain',
        size: 4096,
        kind: 'doc',
        createdAt: '2026-07-28T00:00:00.000Z',
        blob: new Blob(['x'.repeat(4096)], { type: 'text/plain' })
      });
      state.modules.todos.items = state.modules.todos.items.filter(item => item.id !== 'v2-delete-candidate');
      state.modules.papers.items.push({ id: 'v2-cancelled-paper', title: 'receiver must cancel this paper', summary: '' });
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
  await sender.locator('button[onclick="syncCreateOffer()"]').click();
  await sender.waitForFunction(() => document.querySelector('#syncLocal')?.value.startsWith('ph1.'));
  const offer = await sender.locator('#syncLocal').inputValue();
  await receiver.locator('#syncRemote').fill(offer);
  await receiver.locator('button[onclick="syncCreateAnswer()"]').click();
  await receiver.waitForFunction(() => document.querySelector('#syncLocal')?.value.startsWith('ph1.'));
  const answer = await receiver.locator('#syncLocal').inputValue();
  await sender.locator('#syncRemote').fill(answer);
  await sender.locator('button[onclick="syncAcceptAnswer()"]').click();
  await Promise.all([
    sender.waitForFunction(() => syncDc && syncDc.readyState === 'open'),
    receiver.waitForFunction(() => syncDc && syncDc.readyState === 'open')
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
    assert.equal(await sender.getByRole('checkbox', { name: '同步设置' }).isChecked(), false, 'settings scope must be explicit');
    assert.equal(await sender.getByRole('checkbox', { name: '同步附件' }).isChecked(), true, 'attachment scope must be explicit');
    await receiver.getByRole('checkbox', { name: '文献总结' }).uncheck();
    assert.match(await receiver.locator('#syncScopeSummary').textContent(), /条.*(?:B|KB)/, 'scope summary needs records and bytes');

    await pair(sender, receiver);
    for (const page of [sender, receiver]) {
      await page.getByRole('button', { name: '安全同步' }).click();
      const conflict = page.locator('[data-sync-category="conflictCopy"] input[type="checkbox"]');
      assert.ok(await conflict.count(), 'concurrent diary must appear in comparison');
      assert.equal(await conflict.isChecked(), true, 'safe mode must preserve both sides through a conflict copy');
      assert.equal(await page.locator('[data-sync-category="pendingDelete"] input:checked').count(), 0, 'safe mode must not select deletes');
      assert.equal(await page.locator('[data-sync-category="deleteConflict"] input:checked').count(), 0, 'safe mode must not select delete conflicts');
    }

    await receiver.getByRole('button', { name: '全部取消' }).click();
    assert.equal(await receiver.locator('[data-sync-operation]:checked').count(), 0, 'receiver all-none must clear selectable records');
    await receiver.getByRole('button', { name: '全部选择' }).click();
    assert.equal(await receiver.locator('[data-sync-category="deleteConflict"] input:checked').count(), 0, 'safe all-select must not enable deletes');
    const withAttachments = await receiver.locator('#syncPlanSummary').textContent();
    await receiver.getByRole('checkbox', { name: '接收附件' }).uncheck();
    const withoutAttachments = await receiver.locator('#syncPlanSummary').textContent();
    assert.notEqual(withAttachments, withoutAttachments, 'attachment toggle must update receive byte summary');
    await receiver.getByRole('checkbox', { name: '接收附件' }).check();
    const cancelledPaper = receiver.locator('[data-sync-record-id="v2-cancelled-paper"] input[type="checkbox"]');
    await cancelledPaper.uncheck();
    await receiver.getByRole('button', { name: '自定义', exact: true }).click();
    assert.equal(await receiver.locator('[data-sync-category="deleteConflict"] input:checked').count(), 0, 'custom mode still requires explicit delete choice');
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
    assert.equal(receiverDb.state.modules.papers.items.some(item => item.id === 'v2-cancelled-paper'), false,
      'receiver record cancellation must be honored');
    const sameRecord = receiverDb.state.modules.todos.items.find(item => item.id === 'v2-same-record');
    const deviceIds = await Promise.all([sender.evaluate(() => deviceId), receiver.evaluate(() => deviceId)]);
    assert.ok(deviceIds.every(id => sameRecord._sync.vector[id] >= 1), 'same records must merge both device vectors internally');
    assert.ok(receiverDb.recovery.some(point => point?.kind === 'device-sync'), 'transaction must create an undo recovery point');
    assert.equal(await receiver.getByText('已创建 1 条同步副本').count(), 1, 'result must summarize conflict copies');
    for (const stat of ['新增', '更新', '冲突副本', '删除', '跳过', '失败']) {
      assert.ok(await receiver.locator(`[data-sync-result="${stat}"]`).count(), `result summary missing ${stat}`);
    }
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
    const fallbackDetails = sender.locator('details', { has: sender.locator('button[onclick="syncSendBackup()"]') });
    assert.equal(await fallbackDetails.count(), 1, 'long-code fallback must remain');
    assert.equal(await fallbackDetails.getAttribute('open'), null, 'long-code fallback details must be collapsed by default');
    assert.deepEqual(errors, [], 'unexpected page errors');
    await Promise.all([senderContext.close(), receiverContext.close()]);

    const ownerContext = await browser.newContext();
    const attackerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const attacker = await attackerContext.newPage();
    await Promise.all([owner.goto(url), attacker.goto(url)]);
    await Promise.all([owner.waitForFunction(() => hydrated), attacker.waitForFunction(() => hydrated)]);
    await owner.evaluate(async () => {
      state.modules.diary.items.push({ id: 'v2-secret', title: 'SECRET', content: 'SECRET', attachment: { fileId: 'secret-file', size: 6 } });
      stateRevision++;
      await saveNow();
    });
    await Promise.all([openSync(owner), openSync(attacker)]);
    for (const page of [owner, attacker]) {
      await page.getByRole('button', { name: '选择同步内容' }).click();
      await page.getByRole('button', { name: '全部不选' }).click();
      await page.getByRole('checkbox', { name: '待办事项' }).check();
    }
    await pair(owner, attacker);
    await owner.waitForFunction(() =>
      syncDc?.readyState === 'open' &&
      syncOfferedScope?.modules?.includes('todos') &&
      syncFrozenManifest?.scope?.modules?.includes('todos')
    );
    await owner.evaluate(() => {
      window.__unauthorizedManifestReads = 0;
      window.__ownerSent = [];
      const originalBuildManifest = SyncCore.buildManifest;
      SyncCore.buildManifest = async (source, scope) => {
        if (scope.modules.includes('diary')) window.__unauthorizedManifestReads++;
        return originalBuildManifest(source, scope);
      };
      const originalSend = syncDc.send.bind(syncDc);
      syncDc.send = raw => { window.__ownerSent.push(raw); return originalSend(raw); };
    });
    await attacker.evaluate(() => sendSyncV2({
      protocol: 2,
      type: 'manifest-request',
      scope: { modules: ['diary'], includeSettings: false, includeAttachments: true }
    }));
    await owner.waitForFunction(() => window.__ownerSent.some(raw => JSON.parse(raw).type === 'abort'));
    const authorization = await owner.evaluate(() => ({
      reads: window.__unauthorizedManifestReads,
      types: window.__ownerSent.map(raw => JSON.parse(raw).type),
      leaked: window.__ownerSent.some(raw => raw.includes('SECRET')),
      reset: (() => { setupSyncPc(); return { scope: syncOfferedScope, identities: syncOfferedIdentityIds.size }; })()
    }));
    assert.equal(authorization.reads, 0, 'forged manifest request must not read an unoffered module');
    assert.deepEqual(authorization.types, ['abort'], 'forged request must abort as one whole envelope');
    assert.equal(authorization.leaked, false, 'forged request must not serialize secret data');
    assert.deepEqual(authorization.reset, { scope: null, identities: 0 }, 'new session must clear frozen authorization');
    await Promise.all([ownerContext.close(), attackerContext.close()]);

    const payloadContext = await browser.newContext();
    const payloadPage = await payloadContext.newPage();
    await payloadPage.goto(url);
    await payloadPage.waitForFunction(() => hydrated);
    const attachmentGuard = await payloadPage.evaluate(async () => {
      openSyncModal();
      const payload = {
        scope: { modules: ['todos'], includeSettings: false, includeAttachments: true },
        state: {
          modules: {
            todos: {
              items: [
                { id: 'v2-rogue-file', txt: 'rogue', attachment: { fileId: 'rogue-file', size: 1 } }
              ]
            }
          },
          _sync: { tombstones: [] }
        },
        files: [
          {
            id: 'rogue-file',
            name: 'rogue.txt',
            type: 'text/plain',
            size: 1,
            kind: 'doc',
            createdAt: '2026-07-28T00:00:00.000Z',
            dataUrl: 'data:text/plain;base64,eA==',
            hash: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'
          }
        ]
      };
      const stage = {
        modules: ['todos'],
        requestedIds: ['[["modules","todos","items"],null,"v2-rogue-file"]'],
        attachmentCount: 1,
        attachmentBytes: 1
      };
      try {
        await validateIncomingSyncPayload(payload, stage);
        return 'accepted';
      } catch (error) {
        return error.message;
      }
    });
    assert.match(attachmentGuard, /附件范围不一致|未选择的附件/, 'unselected attachment payload must be rejected');
    await payloadContext.close();

    console.log(JSON.stringify({ selectiveSync: true, transactionalCommit: true, conflictCopy: true, sameVectorUnion: true, authorizationBoundary: true, undo: true, abortSafe: true }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
