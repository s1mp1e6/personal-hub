// Two-page short-code signaling regression: both pages talk to a local mock of
// the Cloudflare Worker relay, exchange SDP/ICE over HTTP, then complete a
// real WebRTC data channel and transfer a backup through it.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { createMockRelay } = require('./mock-relay');

const root = path.resolve(__dirname, '..', 'site');

function serveFile(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const filePath = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
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
  await page.evaluate(() => { const btn = document.querySelector('button[onclick="openSyncModal()"]'); if (btn) btn.click(); else openSyncModal(); });
  await page.locator('#shortCodeDisplay').waitFor();
  await page.locator('button[onclick="syncShortCreate()"]').waitFor();
}

async function waitConnected(page, timeoutMs = 30000) {
  await page.waitForFunction(() => syncDc && syncDc.readyState === 'open', null, { timeout: timeoutMs });
}

async function main() {
  const server = http.createServer(serveFile);
  const relay = createMockRelay('test-secret');
  const relayServer = http.createServer(relay);
  relay.attachWebSocket(relayServer);
  await Promise.all([
    new Promise(resolve => server.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => relayServer.listen(0, '127.0.0.1', resolve))
  ]);
  const relayPort = relayServer.address().port;
  const url = 'http://127.0.0.1:' + server.address().port + '/index.html?relay=' + encodeURIComponent('http://127.0.0.1:' + relayPort);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const creatorContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const joinerContext = await browser.newContext({ viewport: { width: 420, height: 820 } });
    const creator = await creatorContext.newPage();
    const joiner = await joinerContext.newPage();
    for (const page of [creator, joiner]) {
      page.on('dialog', d => d.accept());
      page.on('pageerror', error => errors.push('pageerror: ' + error.message));
      page.on('console', msg => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
    }
    await creator.goto(url, { waitUntil: 'networkidle' });
    await joiner.goto(url, { waitUntil: 'networkidle' });

    const marker = 'shortcode-' + Date.now();
    await creator.locator('.nav-item[data-mid="todos"]').click();
    await creator.locator('#fab').click();
    await creator.locator('#f_txt').fill(marker);
    await creator.locator('#modalSave').click();
    await creator.getByText(marker).waitFor();
    await creator.evaluate(() => saveNow());

    await openSync(creator);
    await openSync(joiner);

    // Creator creates room; joiner sees the 6-digit code.
    await creator.locator('button[onclick="syncShortCreate()"]').click();
    await creator.locator('#shortCodeDisplay').evaluate(el => new Promise(resolve => {
      const check = () => el.textContent.trim() !== '------' ? resolve() : setTimeout(check, 50);
      check();
    }));
    const code = (await creator.locator('#shortCodeDisplay').textContent()).trim();
    assert.match(code, /^[0-9]{6}$/, 'short code should be six digits');
    const stateText = await creator.locator('#shortRelayState').textContent();
    assert.match(stateText, /已创建/, 'creator state should show created');

    // Joiner enters code and both sides establish a WebRTC data channel.
    await joiner.locator('#shortJoinCode').fill(code);
    await joiner.locator('button[onclick="syncShortJoin()"]').click();
    await new Promise(r => setTimeout(r, 2500));
    await Promise.all([
      waitConnected(creator, 30000),
      waitConnected(joiner, 30000)
    ]);
    console.log('shortcode data channel open, code=' + code);

    // Transfer a backup through the established data channel.
    await creator.locator('.modal details summary').click();
    await creator.locator('button[onclick="syncSendBackup()"]').click();
    await joiner.waitForFunction((m) => {
      try {
        const raw = localStorage.getItem('personal_hub_pending_state') || '';
        if (raw.includes(m)) return true;
        return JSON.stringify(state || null).includes(m);
      } catch { return false; }
    }, marker, { timeout: 20000 });
    console.log('backup transferred over shortcode channel');

    // Closing the modal cleans the relay session and stops polling.
    await creator.locator('.modal .x').click();
    const stopped = await creator.evaluate(() => syncShort === null);
    assert.equal(stopped, true, 'creator short relay should be cleaned after close');

    const pageErrors = errors.filter(e => !e.includes('autoplay') && !e.includes('favicon'));
    assert.deepEqual(pageErrors, [], 'unexpected page errors: ' + pageErrors.join(' | '));
    console.log(JSON.stringify({ connected: true, transferred: true, relayPolled: true }, null, 2));
    await creatorContext.close();
    await joinerContext.close();
  } finally {
    await browser.close();
    server.close();
    server.closeAllConnections();
    relayServer.close();
    relayServer.closeAllConnections();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
