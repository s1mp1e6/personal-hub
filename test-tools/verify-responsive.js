const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'site');
const outDir = path.resolve(__dirname, '..', 'verification');
fs.mkdirSync(outDir, { recursive: true });

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
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch();
  const viewports = [
    { name: 'desktop', width: 1365, height: 768 },
    { name: 'tablet', width: 834, height: 1112 },
    { name: 'phone', width: 390, height: 844 },
    { name: 'small-phone', width: 360, height: 740 },
  ];
  const results = [];

  try {
    for (const vp of viewports) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', err => consoleErrors.push(err.message));

      await page.goto(`${url}?v=${Date.now()}-${vp.name}`, { waitUntil: 'networkidle' });
      await page.locator('.quote-card').click();
      const clockText = await page.locator('#dashClock').innerText();
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      await page.screenshot({ path: path.join(outDir, `${vp.name}.png`), fullPage: true });
      await page.close();

      const overflow = Math.max(metrics.scrollWidth, metrics.bodyScrollWidth) - metrics.innerWidth;
      results.push({ viewport: vp, clockText, overflow, consoleErrors });
      if (clockText.includes('--')) throw new Error(`${vp.name}: clock still shows placeholder after quote click: ${clockText}`);
      if (overflow > 2) throw new Error(`${vp.name}: horizontal overflow ${overflow}px`);
      if (consoleErrors.length) throw new Error(`${vp.name}: console errors: ${consoleErrors.join(' | ')}`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
