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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`${url}?ux=${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof switchMod === 'function');
    await page.waitForFunction(() => hydrated === true);

    const semantics = await page.evaluate(() => ({
      hasMain: !!document.querySelector('main.main'),
      description: document.querySelector('meta[name="description"]')?.content || '',
    }));
    assert.equal(semantics.hasMain, true, 'app shell must use a real <main> landmark');
    assert.ok(semantics.description.length > 10, 'meta description must exist');

    const bulkAdded = await page.evaluate(() => {
      for (let i = 0; i < 205; i += 1) {
        state.modules.todos.items.push({
          id: 'bulk-' + i,
          txt: 'bulk item ' + i,
          done: false,
          priority: 'normal',
          createdAt: new Date().toISOString().slice(0, 10),
        });
      }
      switchMod('todos');
      return state.modules.todos.items.length;
    });
    assert.ok(bulkAdded > 200, 'fixture must exceed the initial window');
    assert.equal(await page.locator('.card').count(), 200, 'first render should cap cards at 200');
    assert.ok((await page.locator('.load-more').innerText()).includes('剩余'), 'load-more button should show remaining count');
    await page.locator('.load-more').click();
    assert.equal(await page.locator('.card').count(), bulkAdded, 'load more should reveal the rest');

    await page.locator('#listSearch').fill('bulk item 204');
    await page.waitForFunction(() => searchQuery === 'bulk item 204' && document.querySelectorAll('.card').length === 1, null, { timeout: 5000 });
    assert.equal(await page.locator('.card').count(), 1, 'debounced search must filter to one card');
    await page.locator('#listSearch').fill('');

    await page.evaluate(() => switchMod('books'));
    const firstCover = await page.locator('.card [style*="linear-gradient"]').first().getAttribute('style');
    await page.evaluate(() => renderContent());
    const secondCover = await page.locator('.card [style*="linear-gradient"]').first().getAttribute('style');
    assert.equal(secondCover, firstCover, 'book cover color must be stable across re-renders');

    const contrast = await page.evaluate(() => {
      function lum(hex) {
        const c = hex.replace('#', '');
        const rgb = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255)
          .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      }
      function ratio(a, b) {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      const themes = ['default', 'light', 'dark', 'forest'];
      const results = {};
      for (const theme of themes) {
        setTheme(theme);
        const faint = getComputedStyle(document.documentElement).getPropertyValue('--ink-faint').trim();
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        results[theme] = { faint, bg, ratio: ratio(faint, bg) };
      }
      setTheme('default');
      return results;
    });
    for (const [theme, value] of Object.entries(contrast)) {
      assert.ok(value.ratio >= 4.5, `${theme} ink-faint contrast ${value.ratio.toFixed(2)} must be >= 4.5`);
    }

    const draftCleanup = await page.evaluate(() => {
      pendingAttachPreview = 'blob:fake-preview';
      resetAttachDraft();
      return { preview: pendingAttachPreview, attach: pendingAttach };
    });
    assert.equal(draftCleanup.preview, null, 'pending preview object URL must be revoked on cleanup');
    assert.equal(draftCleanup.attach, null, 'pending attach must reset with preview');

    if (errors.length) throw new Error('console/page errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ landmark: true, pagedList: true, stableCover: true, debouncedSearch: true, contrast, draftCleanup: true }));
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
