const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const qrcode = require('qrcode-generator');

const root = path.resolve(__dirname, '..', 'site');
const outDir = path.resolve(__dirname, '..', 'verification');
fs.mkdirSync(outDir, { recursive: true });

const QR_PAYLOAD = 'ph1.qr-scanner-regression';

function qrPngBuffer(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const dataUrl = qr.createDataURL(8, 4);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

function serveFile(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === '/') filePath = path.join(root, 'index.html');
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml; charset=utf-8',
      '.css': 'text/css; charset=utf-8'
    };
    res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function main() {
  const server = http.createServer(serveFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const qrPath = path.join(os.tmpdir(), 'personal-hub-qr-scanner-test.png');
  fs.writeFileSync(qrPath, qrPngBuffer(QR_PAYLOAD));

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      permissions: ['camera']
    });
    const page = await context.newPage();
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(`${baseUrl}/index.html?qr=scan-${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => hydrated);

    await page.evaluate(() => openSyncModal());
    await page.locator('#qrImageInput').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#qrImageInput').count(), 1, 'main sync modal must contain a hidden file input');
    assert.equal(await page.locator('#qrImageInput').getAttribute('accept'), 'image/*', 'album input must accept images');

    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '相册识别' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(qrPath);
    await page.waitForFunction(payload => document.getElementById('syncRemote')?.value === payload, QR_PAYLOAD);

    await page.getByRole('button', { name: '扫码接收' }).click();
    await page.getByRole('button', { name: '继续并请求权限' }).click();
    await page.waitForFunction(() => {
      const video = document.getElementById('qrVideo');
      return video && video.videoWidth > 0 && video.readyState >= 2;
    }, null, { timeout: 15000 });

    const layout = await page.evaluate(() => {
      const stage = document.querySelector('.qr-scan-stage').getBoundingClientRect();
      const video = document.getElementById('qrVideo').getBoundingClientRect();
      return {
        stage: { width: stage.width, height: stage.height },
        video: { width: video.width, height: video.height },
        docWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        objectFit: getComputedStyle(document.getElementById('qrVideo')).objectFit,
        corners: document.querySelectorAll('.qr-scan-frame i').length,
        scanLine: !!document.querySelector('.qr-scan-line')
      };
    });
    assert.ok(layout.stage.width >= 300, `phone scan stage should be wide, got ${layout.stage.width}`);
    const ratio = layout.stage.width / layout.stage.height;
    assert.ok(Math.abs(ratio - 4 / 3) < 0.02, `scan stage should keep 4:3 aspect ratio, got ${ratio}`);
    assert.ok(layout.video.width >= layout.stage.width - 1, 'video should fill the scan stage width');
    assert.ok(layout.video.height >= layout.stage.height - 1, 'video should fill the scan stage height');
    assert.equal(layout.objectFit, 'cover', 'video should use object-fit: cover without letterbox bars');
    assert.equal(layout.corners, 4, 'scan stage should show four corner guides');
    assert.equal(layout.scanLine, true, 'scan stage should show a sweep line');
    assert.ok(layout.docWidth <= layout.viewport, `scan modal must not overflow phone viewport, got ${layout.docWidth}px`);
    const videoPixels = await page.evaluate(() => {
      const video = document.getElementById('qrVideo');
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(video.videoWidth, 320);
      canvas.height = Math.min(video.videoHeight, 240);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 1000) seen.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
      const center = Math.floor(data.length / 2);
      return { tones: seen.size, center: [data[center], data[center + 1], data[center + 2]] };
    });
    assert.ok(videoPixels.tones >= 2, 'camera preview should carry a live image, not a blank frame');
    assert.ok(videoPixels.center.some(channel => channel > 30), 'camera preview center should not be black');
    await page.screenshot({ path: path.join(outDir, 'qr-scan-phone.png') });

    await page.locator('.modal .x').click();
    await page.evaluate(() => openStorageInfo());
    await page.locator('#themePick').waitFor();
    const themeState = await page.evaluate(() => ({
      names: [...document.querySelectorAll('#themePick button span:last-child')].map(el => el.textContent.trim()),
      count: document.querySelectorAll('#themePick button').length,
      swatches: document.querySelectorAll('#themePick .theme-swatch').length,
      bodyText: document.getElementById('modalBody').textContent
    }));
    assert.deepEqual(themeState.names, ['默认', '清爽', '深色', '森绿'], 'theme picker should show four real themes without duplicate warm');
    assert.equal(themeState.count, 4, 'theme picker should have four options');
    assert.equal(themeState.swatches, 4, 'every theme option should include a color swatch');
    assert.ok(themeState.bodyText.includes('打开设备同步'), 'storage settings should link to the current sync flow');
    assert.ok(!themeState.bodyText.includes('二维码配对将在下一步接入'), 'storage settings should not contain stale roadmap copy');

    await page.getByRole('button', { name: '切换到深色主题' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'dark theme should apply');
    await page.getByRole('button', { name: '切换到默认主题' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? undefined), undefined, 'default theme should remove data-theme');

    if (errors.length) throw new Error(`console/page errors: ${errors.join(' | ')}`);
    await context.close();
    console.log(JSON.stringify({ albumPicker: true, cameraStage: true, themePicker: true, phoneLayout: true }));
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(qrPath, { force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
