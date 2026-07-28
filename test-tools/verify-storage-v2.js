const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'site');
const DB_NAME = 'personal_hub_local_first';
const STATE_KEY = 'personal_hub_v6';
const DEVICE_ID_KEY = 'deviceId';
const FILE_ID = 'legacy-file-1';
const CONCURRENT_FILE_ID = 'concurrent-file-2';
const MARKER = 'legacy-storage-marker';
const FILE_BYTES = 'legacy attachment bytes';
const CONCURRENT_FILE_BYTES = 'concurrent attachment bytes';

const legacyFixture = {
  activeQuote: 0,
  settings: { theme: 'forest' },
  customQuotes: [{ text: 'legacy quote', author: 'fixture' }],
  dashWidgets: [{ id: 'widget-1', type: 'note', title: 'legacy widget', content: 'kept', size: 'small' }],
  moduleOrder: ['dashboard', 'todos', 'papers'],
  modules: {
    dashboard: { name: 'Dashboard', icon: 'D', color: 'c1', type: 'dashboard' },
    todos: {
      name: 'Todos', icon: 'T', color: 'c2', type: 'todo',
      items: [{
        id: 'todo-1', txt: MARKER, done: false, priority: 'normal', createdAt: '2026-07-28',
        attachment: { fileId: FILE_ID, name: 'legacy.txt', type: 'text/plain', size: FILE_BYTES.length, kind: 'doc' },
        attType: 'doc'
      }]
    },
    papers: {
      name: 'Papers', icon: 'P', color: 'c3', type: 'paper',
      items: [{ id: 'paper-1', title: 'Legacy paper', summary: 'must survive migration', tags: ['legacy'], createdAt: '2026-07-27' }]
    }
  }
};

function visible(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => key === '_sync' ? undefined : item));
}

function serveFile(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.join(root, requested);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const type = filePath.endsWith('.html') ? 'text/html; charset=utf-8'
      : filePath.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : filePath.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  });
}

async function seedLegacyDatabase(page) {
  await page.evaluate(async ({ dbName, stateKey, fixture, fileId, fileBytes, concurrentFileId, concurrentFileBytes }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('kv');
        db.createObjectStore('files', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['kv', 'files'], 'readwrite');
        tx.objectStore('kv').put(fixture, stateKey);
        tx.objectStore('files').put({
          id: fileId,
          name: 'legacy.txt',
          type: 'text/plain',
          size: fileBytes.length,
          kind: 'doc',
          createdAt: '2026-07-28T00:00:00.000Z',
          blob: new Blob([fileBytes], { type: 'text/plain' })
        });
        tx.objectStore('files').put({
          id: concurrentFileId,
          name: 'concurrent.txt',
          type: 'text/plain',
          size: concurrentFileBytes.length,
          kind: 'doc',
          createdAt: '2026-07-28T00:01:00.000Z',
          blob: new Blob([concurrentFileBytes], { type: 'text/plain' })
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, {
    dbName: DB_NAME,
    stateKey: STATE_KEY,
    fixture: legacyFixture,
    fileId: FILE_ID,
    fileBytes: FILE_BYTES,
    concurrentFileId: CONCURRENT_FILE_ID,
    concurrentFileBytes: CONCURRENT_FILE_BYTES
  });
}

async function inspectDatabase(page) {
  return page.evaluate(async ({ dbName, stateKey, deviceIdKey, fileId }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const stores = Array.from(db.objectStoreNames);
      const tx = db.transaction(['kv', 'files', 'sync-meta'], 'readonly');
      const stateRequest = tx.objectStore('kv').get(stateKey);
      const fileRequest = tx.objectStore('files').get(fileId);
      const deviceRequest = tx.objectStore('sync-meta').get(deviceIdKey);
      tx.oncomplete = async () => {
        try {
          const file = fileRequest.result;
          resolve({
            version: db.version,
            stores,
            state: stateRequest.result,
            deviceId: deviceRequest.result,
            file: file ? {
              id: file.id,
              name: file.name,
              type: file.type,
              size: file.size,
              kind: file.kind,
              createdAt: file.createdAt,
              text: await file.blob.text()
            } : null
          });
        } catch (error) {
          reject(error);
        } finally {
          db.close();
        }
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  }), { dbName: DB_NAME, stateKey: STATE_KEY, deviceIdKey: DEVICE_ID_KEY, fileId: FILE_ID });
}

async function main() {
  const server = http.createServer(serveFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const deviceRaceContext = await browser.newContext();
    const deviceRacePages = await Promise.all(Array.from({ length: 6 }, () => deviceRaceContext.newPage()));
    await Promise.all(deviceRacePages.map((racePage, index) =>
      racePage.goto(`${url}/index.html?device-race=${index}`, { waitUntil: 'networkidle' })
    ));
    await Promise.all(deviceRacePages.map(racePage =>
      racePage.waitForFunction(() => hydrated && typeof deviceId === 'string' && deviceId.length > 0)
    ));
    const parallelDeviceIds = await Promise.all(deviceRacePages.map(racePage =>
      racePage.evaluate(() => deviceId)
    ));
    const finalDeviceId = await deviceRacePages[0].evaluate(() => idbStoreGet(SYNC_META_STORE, DEVICE_ID_KEY));
    assert.deepEqual([...new Set(parallelDeviceIds)], [finalDeviceId],
      'parallel first pages did not converge on one stored deviceId');
    await deviceRaceContext.close();

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`${url}/manifest.json`);
    await seedLegacyDatabase(page);
    await page.goto(`${url}/index.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(marker => JSON.stringify(state).includes(marker), MARKER);
    const upgradedSchema = await page.evaluate(dbName => new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve({ version: request.result.version, stores: Array.from(request.result.objectStoreNames) });
        request.result.close();
      };
    }), DB_NAME);
    assert.equal(upgradedSchema.version, 3);
    assert.ok(upgradedSchema.stores.includes('recovery'), 'recovery store is missing');
    assert.ok(upgradedSchema.stores.includes('sync-meta'), 'sync-meta store is missing');
    assert.deepEqual(await page.evaluate(() => ({ sync: typeof SyncCore, recovery: typeof RecoveryCore })), {
      sync: 'object', recovery: 'object'
    });

    const savedSnapshot = await page.evaluate(() => saveNow());
    const afterUpgrade = await inspectDatabase(page);
    assert.equal(afterUpgrade.version, 3);
    assert.ok(afterUpgrade.stores.includes('recovery'), 'recovery store is missing');
    assert.ok(afterUpgrade.stores.includes('sync-meta'), 'sync-meta store is missing');
    assert.deepEqual(visible(afterUpgrade.state), visible(legacyFixture));
    assert.deepEqual(afterUpgrade.file, {
      id: FILE_ID,
      name: 'legacy.txt',
      type: 'text/plain',
      size: FILE_BYTES.length,
      kind: 'doc',
      createdAt: '2026-07-28T00:00:00.000Z',
      text: FILE_BYTES
    });
    assert.match(afterUpgrade.deviceId, /^[a-f0-9]{32}$/);
    assert.deepEqual(savedSnapshot, afterUpgrade.state, 'saveNow did not return the persisted stamped snapshot');

    await page.evaluate(() => saveNow());
    const afterRepeatedSave = await inspectDatabase(page);
    assert.deepEqual(afterRepeatedSave.state, afterUpgrade.state, 'unchanged save incremented sync metadata');

    const concurrentBackup = await page.evaluate(async ({ concurrentFileId, concurrentFileBytes }) => {
      const originalCompareAndSetState = compareAndSetState;
      let releaseWrite;
      let signalWriteStarted;
      const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
      let gated = false;
      compareAndSetState = async (...args) => {
        if(!gated){
          gated = true;
          signalWriteStarted();
          await new Promise(resolve => { releaseWrite = resolve; });
        }
        return originalCompareAndSetState(...args);
      };
      try {
        const backupPromise = buildBackup();
        await writeStarted;
        const todo = state.modules.todos.items[0];
        todo.txt = 'concurrent edit after snapshot';
        todo.attachment = {
          fileId: concurrentFileId,
          name: 'concurrent.txt',
          type: 'text/plain',
          size: concurrentFileBytes.length,
          kind: 'doc'
        };
        stateRevision++;
        releaseWrite();
        const backup = await backupPromise;
        const persisted = await idbGet(KEY);
        return {
          backupData: backup.data,
          backupFileIds: backup.files.map(file => file.id),
          persisted,
          currentText: state.modules.todos.items[0].txt,
          currentFileId: state.modules.todos.items[0].attachment.fileId
        };
      } finally {
        compareAndSetState = originalCompareAndSetState;
      }
    }, { concurrentFileId: CONCURRENT_FILE_ID, concurrentFileBytes: CONCURRENT_FILE_BYTES });
    assert.equal(concurrentBackup.currentText, 'concurrent edit after snapshot');
    assert.equal(concurrentBackup.currentFileId, CONCURRENT_FILE_ID);
    assert.deepEqual(concurrentBackup.backupData, concurrentBackup.persisted,
      'backup read global state changed after saveNow captured its snapshot');
    assert.deepEqual(concurrentBackup.backupFileIds, [FILE_ID],
      'backup attachments did not come from the persisted snapshot');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(marker => JSON.stringify(state).includes(marker), MARKER);
    const afterReload = await inspectDatabase(page);
    assert.deepEqual(visible(afterReload.state), visible(legacyFixture));
    assert.equal(afterReload.deviceId, afterUpgrade.deviceId, 'deviceId changed after reload');
    assert.deepEqual(afterReload.file, afterUpgrade.file);

    const stalePage = await context.newPage();
    await stalePage.goto(`${url}/index.html?stale-writer=1`, { waitUntil: 'networkidle' });
    await stalePage.waitForFunction(marker => hydrated && JSON.stringify(state).includes(marker), MARKER);
    await Promise.all([page, stalePage].map(candidate => candidate.evaluate(() => {
      try{Object.defineProperty(navigator,'locks',{value:undefined,configurable:true})}catch(error){}
    })));
    const firstWriterText = 'first tab committed state';
    await page.evaluate(async text => {
      state.modules.todos.items[0].txt=text;
      stateRevision++;
      await saveNow();
    }, firstWriterText);
    const staleWriterResult = await stalePage.evaluate(async () => {
      state.modules.todos.items[0].txt='stale tab must not overwrite';
      stateRevision++;
      let rejected=false,message='';
      try{await saveNow()}catch(error){rejected=true;message=error.message}
      return {rejected,message,toast:document.getElementById('toast').textContent};
    });
    assert.equal(staleWriterResult.rejected,true,'stale writer was allowed to overwrite newer state');
    assert.match(staleWriterResult.message,/conflict|stale|冲突|过期/i);
    assert.match(staleWriterResult.toast,/其他标签页|冲突|刷新/,
      'stale writer did not show an understandable conflict message');
    const afterStaleWriter = await inspectDatabase(page);
    assert.equal(afterStaleWriter.state.modules.todos.items[0].txt,firstWriterText,
      'database did not preserve the first committed writer');
    await stalePage.close();

    const failedWrite = await page.evaluate(async () => {
      const originalCompareAndSetState = compareAndSetState;
      const shadowBefore = JSON.stringify(persistedShadow);
      compareAndSetState = async () => {throw new Error('forced state write failure')};
      let returned = false;
      let message = '';
      try {
        await saveNow();
        returned = true;
      } catch (error) {
        message = error.message;
      } finally {
        compareAndSetState = originalCompareAndSetState;
      }
      return { returned, message, shadowBefore, shadowAfter: JSON.stringify(persistedShadow) };
    });
    assert.equal(failedWrite.returned, false, 'failed save returned a successful snapshot');
    assert.equal(failedWrite.message, 'forced state write failure');
    assert.equal(failedWrite.shadowAfter, failedWrite.shadowBefore, 'failed save updated persistedShadow');

    const boundaryFailures=await page.evaluate(async()=>{
      const originalStampChanges=SyncCore.stampChanges;
      const unhandled=[];
      const onUnhandled=event=>{unhandled.push(String(event.reason&&event.reason.message||event.reason));event.preventDefault()};
      window.addEventListener('unhandledrejection',onUnhandled);
      SyncCore.stampChanges=async()=>{throw new Error('forced backup boundary failure')};
      try{
        exportData();
        await new Promise(resolve=>setTimeout(resolve,80));
        const exportToast=document.getElementById('toast').textContent;
        syncDc={readyState:'open',send(){}};
        syncSendBackup();
        await new Promise(resolve=>setTimeout(resolve,80));
        return {
          exportToast,
          syncToast:document.getElementById('toast').textContent,
          unhandled
        };
      }finally{
        SyncCore.stampChanges=originalStampChanges;
        window.removeEventListener('unhandledrejection',onUnhandled);
      }
    });
    assert.match(boundaryFailures.exportToast,/备份|导出.*失败|失败.*备份/,
      'export failure did not show an understandable message');
    assert.match(boundaryFailures.syncToast,/同步|发送.*失败|失败.*发送/,
      'sync failure did not show an understandable message');
    assert.deepEqual(boundaryFailures.unhandled,[],
      'export or legacy sync produced an unhandled rejection');

    const rapidMarker='rapid mutation before navigation';
    const rapidPage=await context.newPage();
    const rapidPageErrors=[];
    rapidPage.on('pageerror',error=>rapidPageErrors.push(error.message));
    await rapidPage.goto(`${url}/index.html?rapid-save=1`,{waitUntil:'networkidle'});
    await rapidPage.waitForFunction(() => hydrated);
    await rapidPage.evaluate(marker=>{
      const originalCompareAndSetState=compareAndSetState;
      window.__rapidSaveStarted=false;
      compareAndSetState=async(...args)=>{
        window.__rapidSaveStarted=true;
        return originalCompareAndSetState(...args);
      };
      state.modules.todos.items[0].txt=marker;
      save();
    },rapidMarker);
    await rapidPage.waitForFunction(()=>window.__rapidSaveStarted===true,null,{timeout:120});
    await rapidPage.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await rapidPage.waitForTimeout(20);
    await rapidPage.goto('about:blank');
    let rapidPersisted=null;
    const rapidDeadline=Date.now()+3000;
    while(Date.now()<rapidDeadline){
      rapidPersisted=await inspectDatabase(page);
      if(rapidPersisted.state.modules.todos.items[0].txt===rapidMarker)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(rapidPersisted.state.modules.todos.items[0].txt,rapidMarker,
      'rapid mutation was lost during immediate navigation');
    assert.deepEqual(rapidPageErrors,[],'rapid navigation raised a page error');
    assert.deepEqual(consoleErrors, []);

    console.log(JSON.stringify({
      migrated: true,
      stores: afterReload.stores,
      attachmentPreserved: true,
      stableDeviceId: true,
      parallelDeviceIdStable: true,
      repeatedSaveStable: true,
      concurrentBackupStable: true,
      staleWriterRejected: true,
      failedWriteSafe: true,
      boundaryFailuresHandled: true,
      rapidNavigationSaved: true
    }, null, 2));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
