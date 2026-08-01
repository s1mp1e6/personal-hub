// One Durable Object per short code. Holds only transient WebRTC signaling
// (SDP offer/answer + ICE candidates); no user data is persisted.
import { verifyToken } from './hmac.js';

const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_EVENTS = 200;
const MAX_MESSAGE_BYTES = 96 * 1024;
const POLL_STEP_MS = 1500;
const POLL_MAX_MS = 15000;
const ALLOWED_PEER_ACTIONS = new Set(['offer', 'answer', 'ice', 'bye']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  });
}
function badRequest(message) { return json({ error: message }, 400); }
function notFound(message) { return json({ error: message }, 404); }
function conflict(message) { return json({ error: message }, 409); }

export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = { code: null, expiresAt: 0, peers: [null, null], events: [], seq: 0, leaving: false };
    this.sockets = new Map();
  }
  async ensureRoom() {
    const stored = await this.state.storage.get('room');
    if (stored && stored.expiresAt > Date.now()) {
      this.room = stored;
      return true;
    }
    if (!stored) return false;
    this.closeSockets();
    await this.state.storage.deleteAll();
    return false;
  }
  async saveRoom() {
    this.room.expiresAt = Date.now() + ROOM_TTL_MS;
    await this.state.storage.put('room', this.room);
  }
  async pushEvent(action, payload, from) {
    const event = { seq: ++this.room.seq, action, payload, from };
    this.room.events.push(event);
    if (this.room.events.length > MAX_EVENTS) this.room.events.splice(0, this.room.events.length - MAX_EVENTS);
    await this.saveRoom();
    this.sendToPeer(event);
    return event;
  }
  sendToPeer(event) {
    const peer = event.from === 0 ? 1 : 0;
    const peerId = this.room.peers[peer];
    if (!peerId) return;
    const ws = this.sockets.get(peerId);
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(event)); } catch (error) { this.removeSocket(ws); }
    }
  }
  findClientBySocket(ws) {
    for (const [clientId, socket] of this.sockets) if (socket === ws) return clientId;
    return null;
  }
  removeSocket(ws) {
    for (const [clientId, socket] of this.sockets) if (socket === ws) { this.sockets.delete(clientId); break; }
  }
  closeSockets() {
    for (const ws of this.sockets.values()) { try { ws.close(1000, 'room closed'); } catch (error) {} }
    this.sockets.clear();
  }
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const action = parts[parts.length - 1];
    const code = (parts[parts.length - 2] || '').toUpperCase();
    if (!/^[0-9]{6}$/.test(code)) return badRequest('房间码格式不正确');
    const method = request.method;
    if (method === 'OPTIONS') return new Response('', { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-relay-token,x-client-id' } });

    if (action === 'ws') {
      if (method !== 'GET') return badRequest('方法不支持');
      const token = url.searchParams.get('token') || '';
      const clientId = url.searchParams.get('clientId') || '';
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      if (!(await this.ensureRoom())) return notFound('房间不存在或已过期');
      if (!(await verifyToken(this.env.SIGNALING_SECRET || 'dev-secret', code, clientId, token))) return json({ error: '令牌无效' }, 401);
      const slot = this.room.peers[0] === clientId ? 0 : this.room.peers[1] === clientId ? 1 : -1;
      if (slot < 0) return badRequest('尚未加入房间');
      if (this.room.leaving) return notFound('房间已关闭');
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.sockets.set(clientId, server);
      this.state.acceptWebSocket(server);
      const pending = this.room.events.filter(event => event.seq > since);
      for (const event of pending) { try { server.send(JSON.stringify(event)); } catch (error) {} }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (action === 'create') {
      if (method !== 'POST') return badRequest('方法不支持');
      let body;
      try { body = await request.json(); } catch { return badRequest('请求体不是 JSON'); }
      if (typeof body.clientId !== 'string' || !body.clientId || body.clientId.length > 64) return badRequest('clientId 不正确');
      if (await this.ensureRoom()) return conflict('代码已被使用');
      if (this.room.leaving) return notFound('房间已关闭');
      this.room.code = code;
      this.room.peers[0] = body.clientId;
      await this.saveRoom();
      return json({ ok: true, peer: 0, ttlMs: ROOM_TTL_MS });
    }
    if (action === 'join') {
      if (method !== 'POST') return badRequest('方法不支持');
      let body;
      try { body = await request.json(); } catch { return badRequest('请求体不是 JSON'); }
      if (typeof body.clientId !== 'string' || !body.clientId || body.clientId.length > 64) return badRequest('clientId 不正确');
      if (!(await this.ensureRoom())) return notFound('房间不存在或已过期');
      if (!(await verifyToken(this.env.SIGNALING_SECRET || 'dev-secret', code, body.clientId, body.token))) return json({ error: '令牌无效' }, 401);
      if (this.room.leaving) return notFound('房间已关闭');
      const slot = body.peer === 0 ? 0 : 1;
      const occupied = this.room.peers[slot];
      if (occupied && occupied !== body.clientId) return conflict('房间已满');
      this.room.peers[slot] = body.clientId;
      await this.saveRoom();
      if (slot === 1) await this.pushEvent('peer-joined', { peer: 1 }, 1);
      return json({ ok: true, peer: slot, ttlMs: ROOM_TTL_MS });
    }
    if (action === 'send') {
      if (method !== 'POST') return badRequest('方法不支持');
      const token = request.headers.get('x-relay-token') || '';
      const clientId = request.headers.get('x-client-id') || '';
      let body;
      try { body = await request.json(); } catch { return badRequest('请求体不是 JSON'); }
      if (typeof body.message !== 'object' || body.message === null || Array.isArray(body.message)) return badRequest('消息格式不正确');
      const { action: msgAction, payload, msgId } = body.message;
      if (typeof msgId !== 'string' || !msgId || msgId.length > 64) return badRequest('msgId 不正确');
      if (!ALLOWED_PEER_ACTIONS.has(msgAction)) return badRequest('消息类型不支持');
      if (typeof payload !== 'string' || !payload || payload.length > MAX_MESSAGE_BYTES) return badRequest('消息内容超限');
      if (!(await this.ensureRoom())) return notFound('房间不存在或已过期');
      if (!(await verifyToken(this.env.SIGNALING_SECRET || 'dev-secret', code, clientId, token))) return json({ error: '令牌无效' }, 401);
      const slot = this.room.peers[0] === clientId ? 0 : this.room.peers[1] === clientId ? 1 : -1;
      if (slot < 0) return badRequest('尚未加入房间');
      const peer = slot === 0 ? 1 : 0;
      if (!this.room.peers[peer]) return json({ ok: true, relayed: false });
      await this.pushEvent(msgAction, payload, slot);
      return json({ ok: true, relayed: true, seq: this.room.seq });
    }
    if (action === 'poll') {
      if (method !== 'GET') return badRequest('方法不支持');
      const token = url.searchParams.get('token') || '';
      const clientId = url.searchParams.get('clientId') || '';
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      if (!(await this.ensureRoom())) return notFound('房间不存在或已过期');
      if (!(await verifyToken(this.env.SIGNALING_SECRET || 'dev-secret', code, clientId, token))) return json({ error: '令牌无效' }, 401);
      const start = Date.now();
      while (Date.now() - start < POLL_MAX_MS) {
        const lastSeq = this.room.events[this.room.events.length - 1]?.seq || 0;
        const newEvents = this.room.events.filter(event => event.seq > since);
        if (newEvents.length) return json({ events: newEvents, last: lastSeq, ttlMs: Math.max(0, this.room.expiresAt - Date.now()) });
        if (this.room.leaving || this.room.expiresAt <= Date.now() + 200) {
          if (this.room.leaving) await this.state.storage.deleteAll();
          return notFound('房间已关闭');
        }
        await new Promise(resolve => setTimeout(resolve, POLL_STEP_MS));
      }
      const lastSeq = this.room.events[this.room.events.length - 1]?.seq || 0;
      return json({ events: [], last: lastSeq, ttlMs: Math.max(0, this.room.expiresAt - Date.now()) });
    }
    if (action === 'delete') {
      if (method !== 'POST') return badRequest('方法不支持');
      if (!(await this.ensureRoom())) return notFound('房间不存在或已过期');
      const token = request.headers.get('x-relay-token') || '';
      const clientId = request.headers.get('x-client-id') || '';
      if (!(await verifyToken(this.env.SIGNALING_SECRET || 'dev-secret', code, clientId, token))) return json({ error: '令牌无效' }, 401);
      this.room.leaving = true;
      this.closeSockets();
      await this.state.storage.deleteAll();
      return json({ ok: true });
    }
    return badRequest('不支持的操作');
  }
  async webSocketMessage(ws, message) {
    const clientId = this.findClientBySocket(ws);
    if (!clientId) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const action = msg && msg.action;
    const payload = msg && msg.payload;
    const msgId = msg && msg.msgId;
    if (typeof msgId !== 'string' || !msgId || msgId.length > 64) return;
    if (!ALLOWED_PEER_ACTIONS.has(action)) return;
    if (typeof payload !== 'string' || !payload || payload.length > MAX_MESSAGE_BYTES) return;
    const slot = this.room.peers[0] === clientId ? 0 : this.room.peers[1] === clientId ? 1 : -1;
    if (slot < 0) return;
    const peer = slot === 0 ? 1 : 0;
    if (!this.room.peers[peer]) return;
    await this.pushEvent(action, payload, slot);
  }
  async webSocketClose(ws) {
    this.removeSocket(ws);
  }
  async webSocketError(ws) {
    this.removeSocket(ws);
  }
}
