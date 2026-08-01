// Local mock of signaling/relay Worker API. Used by Playwright tests and
// manual two-device verification; keeps the exact HTTP + WebSocket contract
// as the Cloudflare Worker so the browser client needs no changes.
'use strict';
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_EVENTS = 200;
const ALLOWED_ACTIONS = new Set(['offer', 'answer', 'ice', 'bye']);

function token(secret, code, clientId) {
  return crypto.createHmac('sha256', secret || 'dev-secret').update(code + ':' + clientId).digest('base64url');
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function createMockRelay(secret) {
  const rooms = new Map();
  const socketsByRoom = new Map();

  function pushEvent(room, action, payload, from) {
    const event = { seq: ++room.seq, action, payload, from };
    room.events.push(event);
    if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
    const peer = from === 0 ? 1 : 0;
    const peerId = room.peers[peer];
    const sockets = socketsByRoom.get(room.code) || new Map();
    const ws = peerId && sockets.get(peerId);
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(event)); } catch (error) {}
    }
    return event;
  }

  function closeRoomSockets(code) {
    const sockets = socketsByRoom.get(code);
    if (sockets) {
      for (const ws of sockets.values()) { try { ws.close(); } catch (error) {} }
      socketsByRoom.delete(code);
    }
  }

  function verifyUpgrade(request) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'room' || parts[3] !== 'ws' || !/^[0-9]{6}$/.test(parts[2])) {
      return { error: '接口路径不正确' };
    }
    const code = parts[2];
    const clientId = url.searchParams.get('clientId') || '';
    const relayToken = url.searchParams.get('token') || '';
    const room = rooms.get(code);
    if (!room || room.leaving || Date.now() - room.createdAt > ROOM_TTL_MS) return { error: '房间不存在或已过期' };
    if (token(secret, code, clientId) !== relayToken) return { error: '令牌无效' };
    const slot = room.peers[0] === clientId ? 0 : room.peers[1] === clientId ? 1 : -1;
    if (slot < 0) return { error: '尚未加入房间' };
    return { code, clientId, room };
  }

  function relayHandler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-relay-token,x-client-id' });
      res.end();
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'room' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.clientId) return json(res, { error: 'clientId 不正确' }, 400);
          let code = null;
          for (let i = 0; i < 10; i++) {
            const candidate = String(Math.floor(100000 + Math.random() * 900000));
            if (!rooms.has(candidate)) { code = candidate; break; }
          }
          if (!code) return json(res, { error: '房间码生成失败' }, 500);
          rooms.set(code, { code, createdAt: Date.now(), peers: [parsed.clientId, null], events: [], seq: 0, leaving: false });
          json(res, { ok: true, code, token: token(secret, code, parsed.clientId), peer: 0, ttlMs: ROOM_TTL_MS });
        } catch { json(res, { error: '请求体不是 JSON' }, 400); }
      });
      return;
    }
    if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'room' || !/^[0-9]{6}$/.test(parts[2])) {
      return json(res, { error: '接口路径不正确' }, 400);
    }
    const code = parts[2];
    const action = parts[3];
    const room = rooms.get(code);
    const expired = room && (room.leaving || Date.now() - room.createdAt > ROOM_TTL_MS);
    if (expired) { rooms.delete(code); closeRoomSockets(code); }
    if (action === 'join') {
      if (req.method !== 'POST') return json(res, { error: '方法不支持' }, 400);
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const room2 = rooms.get(code);
          if (!room2 || expired) return json(res, { error: '房间不存在或已过期' }, 404);
          const signedToken = token(secret, code, parsed.clientId);
          const slot = parsed.peer === 0 ? 0 : 1;
          if (room2.peers[slot] && room2.peers[slot] !== parsed.clientId) return json(res, { error: '房间已满' }, 409);
          room2.peers[slot] = parsed.clientId;
          if (slot === 1) pushEvent(room2, 'peer-joined', { peer: 1 }, 1);
          json(res, { ok: true, peer: slot, token: signedToken, ttlMs: ROOM_TTL_MS });
        } catch { json(res, { error: '请求体不是 JSON' }, 400); }
      });
      return;
    }
    if (action === 'send') {
      if (req.method !== 'POST') return json(res, { error: '方法不支持' }, 400);
      const clientId = req.headers['x-client-id'] || '';
      const relayToken = req.headers['x-relay-token'] || '';
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const msg = parsed.message || {};
          if (!ALLOWED_ACTIONS.has(msg.action)) return json(res, { error: '消息类型不支持' }, 400);
          if (typeof msg.payload !== 'string' || !msg.payload || msg.payload.length > 96 * 1024) return json(res, { error: '消息内容超限' }, 400);
          const room2 = rooms.get(code);
          if (!room2 || expired) return json(res, { error: '房间不存在或已过期' }, 404);
          if (token(secret, code, clientId) !== relayToken) return json(res, { error: '令牌无效' }, 401);
          const slot = room2.peers[0] === clientId ? 0 : room2.peers[1] === clientId ? 1 : -1;
          if (slot < 0) return json(res, { error: '尚未加入房间' }, 400);
          const peer = slot === 0 ? 1 : 0;
          if (!room2.peers[peer]) return json(res, { ok: true, relayed: false });
          pushEvent(room2, msg.action, msg.payload, slot);
          json(res, { ok: true, relayed: true, seq: room2.seq });
        } catch { json(res, { error: '请求体不是 JSON' }, 400); }
      });
      return;
    }
    if (action === 'poll') {
      if (req.method !== 'GET') return json(res, { error: '方法不支持' }, 400);
      const clientId = url.searchParams.get('clientId') || '';
      const relayToken = url.searchParams.get('token') || '';
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const room2 = rooms.get(code);
      if (!room2 || expired) return json(res, { error: '房间不存在或已过期' }, 404);
      if (token(secret, code, clientId) !== relayToken) return json(res, { error: '令牌无效' }, 401);
      const newEvents = room2.events.filter(e => e.seq > since);
      const lastSeq = room2.events[room2.events.length - 1]?.seq || 0;
      return json(res, { events: newEvents, last: lastSeq, ttlMs: Math.max(0, room2.createdAt + ROOM_TTL_MS - Date.now()) });
    }
    if (action === 'delete') {
      if (req.method !== 'POST') return json(res, { error: '方法不支持' }, 400);
      const clientId = req.headers['x-client-id'] || '';
      const relayToken = req.headers['x-relay-token'] || '';
      const room2 = rooms.get(code);
      if (!room2 || expired) return json(res, { error: '房间不存在或已过期' }, 404);
      if (token(secret, code, clientId) !== relayToken) return json(res, { error: '令牌无效' }, 401);
      rooms.delete(code);
      closeRoomSockets(code);
      return json(res, { ok: true });
    }
    return json(res, { error: '不支持的操作' }, 400);
  }

  relayHandler.attachWebSocket = function attachWebSocket(server) {
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, request) => {
      const info = verifyUpgrade(request);
      if (!info || info.error) {
        try { ws.close(4401, info ? info.error : 'unauthorized'); } catch (error) {}
        return;
      }
      const { code, clientId, room } = info;
      let sockets = socketsByRoom.get(code);
      if (!sockets) { sockets = new Map(); socketsByRoom.set(code, sockets); }
      sockets.set(clientId, ws);
      const since = Math.max(0, Number(new URL(request.url, 'http://127.0.0.1').searchParams.get('since')) || 0);
      for (const event of room.events) {
        if (event.seq > since) { try { ws.send(JSON.stringify(event)); } catch (error) {} }
      }
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        const action = msg && msg.action;
        const payload = msg && msg.payload;
        const msgId = msg && msg.msgId;
        if (typeof msgId !== 'string' || !msgId || msgId.length > 64) return;
        if (!ALLOWED_ACTIONS.has(action)) return;
        if (typeof payload !== 'string' || !payload || payload.length > 96 * 1024) return;
        const current = rooms.get(code);
        if (!current) return;
        const slot = current.peers[0] === clientId ? 0 : current.peers[1] === clientId ? 1 : -1;
        if (slot < 0) return;
        pushEvent(current, action, payload, slot);
      });
      ws.on('close', () => {
        const sockets2 = socketsByRoom.get(code);
        if (sockets2 && sockets2.get(clientId) === ws) sockets2.delete(clientId);
      });
    });
    return wss;
  };

  return relayHandler;
}

module.exports = { createMockRelay, ROOM_TTL_MS };
