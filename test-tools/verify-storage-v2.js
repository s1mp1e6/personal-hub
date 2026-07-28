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
const MARKER = 'legacy-storage-marker';
const FILE_BYTES = 'legacy attachment bytes';

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
  await page.evaluate(async ({ dbName, stateKey, fixture, fileId, fileBytes }) => {
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
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { dbName: DB_NAME, stateKey: STATE_KEY, fixture: legacyFixture, fileId: FILE_ID, fileBytes: FILE_BYTES });
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

    await page.evaluate(() => saveNow());
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

    await page.evaluate(() => saveNow());
    const afterRepeatedSave = await inspectDatabase(page);
    assert.deepEqual(afterRepeatedSave.state, afterUpgrade.state, 'unchanged save incremented sync metadata');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(marker => JSON.stringify(state).includes(marker), MARKER);
    const afterReload = await inspectDatabase(page);
    assert.deepEqual(visible(afterReload.state), visible(legacyFixture));
    assert.equal(afterReload.deviceId, afterUpgrade.deviceId, 'deviceId changed after reload');
    assert.deepEqual(afterReload.file, afterUpgrade.file);
    assert.deepEqual(consoleErrors, []);

    console.log(JSON.stringify({
      migrated: true,
      stores: afterReload.stores,
      attachmentPreserved: true,
      stableDeviceId: true,
      repeatedSaveStable: true
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
