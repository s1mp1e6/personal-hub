const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'site');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

function serveFile(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === '/') filePath = path.join(root, 'index.html');
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function main() {
  const server = http.createServer(serveFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${url}?dash=${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => hydrated === true);

    const firstState = await page.evaluate(() => ({
      pinned: Array.isArray(state.pinnedModules) ? state.pinnedModules.slice() : null,
      quick: [...document.querySelectorAll('.quick-nav button')].map(b => b.getAttribute('aria-label')),
      recent: document.querySelectorAll('.recent-item').length,
      recentText: document.querySelector('.recent-title')?.textContent || '',
    }));
    assert.ok(Array.isArray(firstState.pinned) && firstState.pinned.length === 3, 'default pinned modules must exist');
    assert.equal(firstState.quick.slice(0, 3).join(','), '打开模块：近期任务,打开模块：待办事项,打开模块：文献总结', 'pinned modules should lead quick nav');
    assert.ok(firstState.recent > 0 && firstState.recent <= 6, 'recent updates should render 1-6 rows');
    assert.ok(firstState.recentText.length > 0, 'recent panel should show a title');

    await page.locator('.recent-item').first().click();
    assert.equal(await page.locator('.detail-header, .detail-card, .detail-body').count() > 0, true, 'recent item should open detail');
    await page.evaluate(() => switchMod('dashboard'));

    await page.evaluate(() => toggleModulePin('tasks'));
    const unpinned = await page.evaluate(() => ({
      pinned: state.pinnedModules.slice(),
      quick: [...document.querySelectorAll('.quick-nav button')].map(b => b.getAttribute('aria-label')),
    }));
    assert.equal(unpinned.pinned.includes('tasks'), false, 'tasks should be unpinned');
    assert.equal(unpinned.quick[0].includes('tasks'), false, 'unpinned module should leave lead position');
    await page.waitForFunction(() => persistedRevision === stateRevision);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => hydrated === true);
    const persisted = await page.evaluate(() => state.pinnedModules.slice());
    assert.equal(persisted.includes('tasks'), false, 'pin change should persist after reload');
    await page.evaluate(() => toggleModulePin('tasks'));

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      recent: document.querySelectorAll('.recent-item').length,
    }));
    assert.ok(mobile.overflow <= 2, `mobile overflow ${mobile.overflow}px`);
    assert.ok(mobile.recent > 0, 'mobile should keep recent updates');
    if (errors.length) throw new Error('console/page errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ defaultPinned: true, quickOrder: true, recentPanel: true, openDetail: true, pinPersist: true, mobileFit: true }));
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
