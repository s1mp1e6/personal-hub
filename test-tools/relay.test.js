// API-contract tests for the short-code relay. The local mock and the
// Cloudflare Worker in signaling/ implement the same endpoints.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMockRelay } = require('./mock-relay');
const { WebSocket } = require('ws');

function request(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: options.method || 'GET', headers: options.headers || {} }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

test('relay create/join/send/poll contract', async () => {
  const server = http.createServer(createMockRelay('unit-secret'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const created = await request(server, '/api/room', { method: 'POST', body: { clientId: 'creator-a' } });
    assert.equal(created.status, 200);
    assert.match(created.body.code, /^[0-9]{6}$/);
    const code = created.body.code;

    const joined = await request(server, '/api/room/' + code + '/join', { method: 'POST', body: { clientId: 'joiner-b' } });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.peer, 1);

    // Third client is rejected: room is full.
    const third = await request(server, '/api/room/' + code + '/join', { method: 'POST', body: { clientId: 'intruder-c' } });
    assert.equal(third.status, 409);

    const send = (clientId, token, message) => request(server, '/api/room/' + code + '/send', {
      method: 'POST',
      headers: { 'x-client-id': clientId, 'x-relay-token': token },
      body: { message }
    });
    const sendOffer = await send('joiner-b', joined.body.token, { action: 'offer', payload: '{"type":"offer"}', msgId: 'm1' });
    assert.equal(sendOffer.status, 200);
    assert.equal(sendOffer.body.relayed, true);

    const poll = await request(server, '/api/room/' + code + '/poll?token=' + encodeURIComponent(created.body.token) + '&clientId=creator-a&since=0');
    assert.equal(poll.status, 200);
    assert.equal(poll.body.events.length, 2);
    assert.deepEqual(poll.body.events.map(e => e.action).sort(), ['offer', 'peer-joined']);
    assert.equal(poll.body.last, 2);

    // Bad token is rejected.
    const badPoll = await request(server, '/api/room/' + code + '/poll?token=wrong&clientId=creator-a&since=0');
    assert.equal(badPoll.status, 401);

    // Wrong code is not found.
    const missing = await request(server, '/api/room/000000/join', { method: 'POST', body: { clientId: 'x' } });
    assert.equal(missing.status, 404);

    // Creator cleanup closes the room.
    const deleted = await request(server, '/api/room/' + code + '/delete', { method: 'POST', headers: { 'x-client-id': 'creator-a', 'x-relay-token': created.body.token } });
    assert.equal(deleted.status, 200);
    const afterDelete = await request(server, '/api/room/' + code + '/poll?token=' + encodeURIComponent(created.body.token) + '&clientId=creator-a&since=0');
    assert.equal(afterDelete.status, 404);
  } finally {
    server.close();
  }
});

function createWsReader(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', raw => {
    const parsed = JSON.parse(String(raw));
    if (waiters.length) waiters.shift()(parsed); else queue.push(parsed);
  });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
}

test('relay websocket signaling path', async () => {
  const handler = createMockRelay('unit-secret');
  const server = http.createServer(handler);
  handler.attachWebSocket(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let ws = null;
  try {
    const created = await request(server, '/api/room', { method: 'POST', body: { clientId: 'creator-a' } });
    assert.equal(created.status, 200);
    const code = created.body.code;
    const joined = await request(server, '/api/room/' + code + '/join', { method: 'POST', body: { clientId: 'joiner-b' } });
    assert.equal(joined.status, 200);

    const wsUrl = 'ws://127.0.0.1:' + server.address().port + '/api/room/' + code + '/ws?token=' + encodeURIComponent(created.body.token) + '&clientId=creator-a&since=0';
    ws = new WebSocket(wsUrl);
    const next = createWsReader(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const first = await next();
    assert.equal(first.action, 'peer-joined');

    const sendOffer = await request(server, '/api/room/' + code + '/send', {
      method: 'POST',
      headers: { 'x-client-id': 'joiner-b', 'x-relay-token': joined.body.token },
      body: { message: { action: 'offer', payload: '{"type":"offer"}', msgId: 'm1' } }
    });
    assert.equal(sendOffer.status, 200);
    const offer = await next();
    assert.equal(offer.action, 'offer');
    assert.equal(offer.payload, '{"type":"offer"}');
    ws.close();
  } finally {
    if (ws) { try { ws.terminate(); } catch (error) {} }
    server.close();
    server.closeAllConnections();
  }
});
