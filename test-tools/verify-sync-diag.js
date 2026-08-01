const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'site');

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

async function diagState(page) {
  return page.evaluate(() => ({
    hasPanel: !!document.getElementById('syncDiagStage'),
    stage: document.getElementById('syncDiagStage')?.textContent || '',
    elapsed: document.getElementById('syncDiagElapsed')?.textContent || '',
    log: document.getElementById('syncDiagLog')?.textContent || '',
    count: syncDiag ? syncDiag.logs.length : 0
  }));
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
    for (const page of [sender, receiver]) page.on('pageerror', error => errors.push(error.message));

    await Promise.all([sender.goto(url), receiver.goto(url)]);
    await Promise.all([sender.waitForFunction(() => hydrated), receiver.waitForFunction(() => hydrated)]);

    await Promise.all([openSync(sender), openSync(receiver)]);
    const initial = await diagState(sender);
    assert.equal(initial.hasPanel, true, 'diagnostics panel must exist in sync modal');
    assert.ok(initial.stage.length > 0, 'diagnostics stage must not be empty');
    assert.ok(initial.elapsed.length > 0, 'diagnostics elapsed must not be empty');
    assert.equal(initial.count, 0, 'diagnostics log starts empty');

    await pair(sender, receiver);
    const senderDiag = await diagState(sender);
    const receiverDiag = await diagState(receiver);
    for (const side of [senderDiag, receiverDiag]) {
      assert.ok(side.count >= 5, 'diagnostics log must record connection stages');
      assert.match(side.log, /初始化连接|收集网络候选|数据通道|ICE 状态/, 'log must include network connection stages');
      assert.ok(side.stage.length > 0 && side.stage !== '等待操作', 'stage must reflect current connection state');
    }

    await sender.locator('.sync-diag summary').click();
    await sender.getByRole('button', { name: '复制日志' }).click();
    const dumped = await sender.evaluate(() => syncDiagDump().join(String.fromCharCode(10)));
    assert.match(String(dumped), /创建发送码|收集网络候选|数据通道/, 'copy logs must export diagnostic content');

    const downloadPromise = sender.waitForEvent('download');
    await sender.getByRole('button', { name: '下载日志' }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^sync-diag-/, 'download log must use sync-diag prefix');
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const downloaded = Buffer.concat(chunks).toString('utf8');
    assert.match(downloaded, /创建发送码|数据通道/, 'downloaded log must contain diagnostic content');

    assert.deepEqual(errors, [], 'unexpected page errors');
    console.log(JSON.stringify({ diagPanel: true, stageVisible: true, logsRecorded: true, copyWorks: true, downloadWorks: true }));
    await Promise.all([senderContext.close(), receiverContext.close()]);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});