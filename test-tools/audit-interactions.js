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

async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      overflow: Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth,
      title: document.title,
      visibleModal: !!document.querySelector('.mask.show'),
      activeNav: document.querySelector('.nav-item.active .ni-name')?.textContent?.trim(),
    };
  });
}

async function assertNoErrors(label, errors) {
  if (errors.length) throw new Error(`${label}: console/page errors: ${errors.join(' | ')}`);
}

async function testDesktop(baseUrl, browser) {
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 }, acceptDownloads: true });
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  page.on('dialog', dialog => dialog.accept());

  await page.goto(`${baseUrl}?audit=desktop-${Date.now()}`, { waitUntil: 'networkidle' });
  await page.locator('.quote-card').click();
  const clockText = await page.locator('#dashClock').innerText();
  if (clockText.includes('--')) throw new Error(`desktop: quote click left clock placeholder: ${clockText}`);

  await page.locator('button[onclick="openStorageInfo()"]').click();
  await page.locator('#themePick').waitFor();
  await page.evaluate(() => setTheme('dark'));
  const themeAfterDark = await page.evaluate(() => document.documentElement.dataset.theme);
  if (themeAfterDark !== 'dark') throw new Error(`desktop: theme did not switch to dark, got ${themeAfterDark}`);
  await page.locator('button[onclick="openSyncModal()"]').click();
  await page.locator('#syncQr').waitFor();
  await page.locator('button[onclick="syncCreateOffer()"]').click();
  await page.locator('#syncQr svg').waitFor();
  await page.locator('button[onclick="startQrScan()"]').waitFor();
  await page.locator('.modal .x').click();
  await page.locator('button[onclick="openStorageInfo()"]').click();
  await page.evaluate(() => setTheme('default'));
  const themeAfterWarm = await page.evaluate(() => document.documentElement.dataset.theme);
  if (themeAfterWarm !== undefined) throw new Error(`desktop: default theme should remove data-theme, got ${themeAfterWarm}`);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#modalSave').click();
  const download = await downloadPromise;
  if (!download.suggestedFilename().startsWith('personal_hub_backup_')) {
    throw new Error(`desktop: unexpected export filename ${download.suggestedFilename()}`);
  }
  await page.locator('.modal .x').click();

  await page.getByText('管理').first().click();
  await page.getByText('管理激励语').waitFor();
  const deleteCount = await page.locator('#quoteList button', { hasText: '删除' }).count();
  for (let i = 0; i < deleteCount + 1; i += 1) {
    const firstDelete = page.locator('#quoteList button', { hasText: '删除' }).first();
    if (await firstDelete.count()) await firstDelete.click();
  }
  await page.getByText('至少保留一句激励语').waitFor();
  await page.locator('.modal .x').click();

  await page.locator('.nav-item[data-mid="todos"]').click();
  await page.locator('#listSearch').fill('Transformer');
  await page.getByText('阅读 Transformer 论文并做笔记').waitFor();
  await page.locator('#listSearch').fill('');
  await page.locator('#fab').click();
  await page.locator('#f_txt').fill('自动化体检新增待办');
  await page.locator('#modalSave').click();
  await page.getByText('自动化体检新增待办').waitFor();
  await page.locator('.card', { hasText: '自动化体检新增待办' }).locator('.check').click();
  await page.locator('.card', { hasText: '自动化体检新增待办' }).locator('.check.done').waitFor();
  await page.getByLabel('归档已完成项目').click();
  await page.getByLabel('显示或隐藏归档内容').click();
  await page.getByText('自动化体检新增待办').waitFor();

  await page.locator('.nav-item[data-mid="papers"]').click();
  await page.locator('#fab').click();
  await page.locator('#f_title').fill('自动化体检附件文献');
  await page.locator('#attFile').setInputFiles({
    name: 'tiny.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
  });
  await page.getByText('附件已保存到本机 Blob 存储').waitFor();
  await page.locator('#modalSave').click();
  await page.getByText('自动化体检附件文献').waitFor();
  const blobDownloadPromise = page.waitForEvent('download');
  await page.locator('.sidebar .foot button').first().click();
  const blobDownload = await blobDownloadPromise;
  const blobDownloadPath = await blobDownload.path();
  const backupJson = JSON.parse(fs.readFileSync(blobDownloadPath, 'utf8'));
  if (!backupJson.files || backupJson.files.length < 1) throw new Error('desktop: exported backup did not include Blob files');

  const metrics = await measure(page);
  if (metrics.overflow > 2) throw new Error(`desktop: horizontal overflow ${metrics.overflow}px`);
  await assertNoErrors('desktop', errors);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'audit-desktop.png'), fullPage: true });
  await page.close();
  return { clockText, metrics, exportFilename: download.suggestedFilename() };
}

async function testMobile(baseUrl, browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await page.goto(`${baseUrl}?audit=mobile-${Date.now()}`, { waitUntil: 'networkidle' });
  await page.locator('#menuToggle').click();
  await page.locator('.nav-item[data-mid="papers"]').click();
  await page.getByText('Attention Is All You Need').waitFor();
  const sidebarOpen = await page.locator('#sidebar').evaluate(el => el.classList.contains('open'));
  if (sidebarOpen) throw new Error('mobile: sidebar did not close after navigation');

  await page.locator('#fab').click();
  await page.getByText('新增 - 文献总结').waitFor();
  await page.getByText('上传图片后可联网 OCR').waitFor();
  await page.getByLabel('联网识别论文截图中的文字').click();
  await page.getByText('请先在“图片”附件里上传论文截图').waitFor();
  await page.locator('.input-mode button', { hasText: '触屏手写' }).click();
  await page.locator('#handwriteArea').waitFor({ state: 'visible' });
  await page.locator('.modal .x').click();

  await page.locator('#menuToggle').click();
  await page.locator('.nav-item[data-mid="dashboard"]').click();
  await page.locator('.quote-card').click();
  const clockText = await page.locator('#dashClock').innerText();
  if (clockText.includes('--')) throw new Error(`mobile: quote click left clock placeholder: ${clockText}`);

  await page.evaluate(() => openStorageInfo());
  await page.locator('button[onclick="openSyncModal()"]').click();
  await page.locator('button[onclick="syncCreateOffer()"]').click();
  await page.locator('#syncQr svg').waitFor();
  const syncLayout = await page.evaluate(() => {
    const modal = document.querySelector('.modal').getBoundingClientRect();
    const pairing = getComputedStyle(document.querySelector('.sync-pairing'));
    return { modalWidth: modal.width, viewport: window.innerWidth, pairingColumns: pairing.gridTemplateColumns.split(' ').length };
  });
  if (syncLayout.modalWidth > syncLayout.viewport) throw new Error(`mobile: sync modal wider than viewport: ${syncLayout.modalWidth}`);
  if (syncLayout.pairingColumns !== 1) throw new Error(`mobile: sync pairing should stack, got ${syncLayout.pairingColumns} columns`);
  await page.locator('.modal .x').click();
  const metrics = await measure(page);
  if (metrics.overflow > 2) throw new Error(`mobile: horizontal overflow ${metrics.overflow}px`);
  await assertNoErrors('mobile', errors);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'audit-mobile.png'), fullPage: true });
  await page.close();
  return { clockText, metrics };
}

async function testAccessibilityBasics(baseUrl, browser) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(`${baseUrl}?audit=a11y-${Date.now()}`, { waitUntil: 'networkidle' });
  const report = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const unnamed = buttons
      .map((button, index) => ({
        index,
        text: button.textContent.trim(),
        aria: button.getAttribute('aria-label') || '',
        title: button.getAttribute('title') || '',
        className: button.className || '',
      }))
      .filter(button => !button.text && !button.aria && !button.title);
    return { buttonCount: buttons.length, unnamed };
  });
  if (report.unnamed.length) throw new Error(`a11y: unnamed buttons: ${JSON.stringify(report.unnamed)}`);
  await page.close();
  return report;
}

async function main() {
  const server = http.createServer(serveFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch();
  try {
    const result = {
      desktop: await testDesktop(baseUrl, browser),
      mobile: await testMobile(baseUrl, browser),
      accessibility: await testAccessibilityBasics(baseUrl, browser),
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
