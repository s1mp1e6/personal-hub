const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'site');
const DB_NAME = 'personal_hub_local_first';
const STORE_NAME = 'kv';
const STATE_KEY = 'personal_hub_v6';

function serveFile(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  let filePath = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': filePath.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(data);
  });
}

async function openSync(page) {
  await page.locator('.sidebar .foot button').last().click();
  await page.getByLabel('打开近距离设备同步').click();
  await page.locator('#syncLocal').waitFor();
  await page.getByRole('button', { name: '扫码填入对方码' }).waitFor();
  await page.locator('#qrScanBox').waitFor({ state: 'attached' });
}

async function readPersistedState(page) {
  return page.evaluate(({ dbName, storeName, key }) => new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const getReq = store.get(key);
        getReq.onsuccess = () => resolve(getReq.result ?? null);
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
  }), { dbName: DB_NAME, storeName: STORE_NAME, key: STATE_KEY });
}

async function main() {
  const server = http.createServer(serveFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  try {
    const senderContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const receiverContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    sender.on('dialog', d => d.accept());
    receiver.on('dialog', d => d.accept());
    const marker = `legacy-sync-${Date.now()}`;
    await sender.goto(`${url}?sync=sender-${Date.now()}`, { waitUntil: 'networkidle' });

    await sender.locator('.nav-item[data-mid="todos"]').click();
    await sender.locator('#fab').click();
    await sender.locator('#f_txt').fill(marker);
    await sender.locator('#modalSave').click();
    await sender.getByText(marker).waitFor();

    await receiver.goto(`${url}?sync=receiver-${Date.now()}`, { waitUntil: 'networkidle' });
    await receiver.locator('.nav-item[data-mid="todos"]').click();
    if (await receiver.getByText(marker).count()) {
      throw new Error('isolated receiver unexpectedly contained the legacy sync marker before transfer');
    }
    const receiverState = await readPersistedState(receiver);
    if (JSON.stringify(receiverState || null).includes(marker)) {
      throw new Error('isolated receiver IndexedDB unexpectedly contained the legacy sync marker before transfer');
    }

    await openSync(sender);
    await openSync(receiver);
    await sender.getByRole('button', { name: '创建发送码' }).click();
    await sender.locator('#syncLocal').evaluate(el => new Promise(resolve => {
      const check = () => el.value ? resolve() : setTimeout(check, 50);
      check();
    }));
    await sender.locator('#syncQr svg').waitFor({ timeout: 5000 });
    const offer = await sender.locator('#syncLocal').inputValue();
    if (!offer) throw new Error('sender did not generate offer');
    if (!offer.startsWith('ph1.')) throw new Error('sender offer is not compressed ph1 format');
    if (offer.length > 2500) throw new Error(`sender offer still too long: ${offer.length}`);

    await receiver.locator('#syncRemote').fill(offer);
    await receiver.getByRole('button', { name: '生成接收码' }).click();
    await receiver.locator('#syncLocal').evaluate(el => new Promise(resolve => {
      const check = () => el.value ? resolve() : setTimeout(check, 50);
      check();
    }));
    await receiver.locator('#syncQr svg').waitFor({ timeout: 5000 });
    const answer = await receiver.locator('#syncLocal').inputValue();
    if (!answer) throw new Error('receiver did not generate answer');
    if (!answer.startsWith('ph1.')) throw new Error('receiver answer is not compressed ph1 format');
    if (answer.length > 2500) throw new Error(`receiver answer still too long: ${answer.length}`);

    await sender.locator('#syncRemote').fill(answer);
    await sender.getByRole('button', { name: '连接接收码' }).click();
    await sender.getByText('已连接，可以发送备份').waitFor({ timeout: 10000 });
    await receiver.getByText('已连接，可以发送备份').waitFor({ timeout: 10000 });

    await sender.getByRole('button', { name: '发送当前备份' }).click();
    await receiver.getByText('已接收并导入备份').waitFor({ timeout: 15000 });
    await receiver.locator('.modal .x').click();
    await receiver.locator('.nav-item[data-mid="todos"]').click();
    await receiver.getByText(marker).waitFor();

    console.log(JSON.stringify({ connected: true, transferred: true }, null, 2));
    await senderContext.close();
    await receiverContext.close();
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
