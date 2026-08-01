import { RelayRoom } from './relay-room.js';
import { signToken } from './hmac.js';

// Per-worker-process rate limits. Good enough for a small free relay; a shared
// limiter (or Turnstile) is the production hardening step.
const WINDOW_MS = 60_000;
const MAX_PER_IP = 120;
const ipHits = new Map();
function rateLimit(request) {
  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const entry = ipHits.get(ip);
  if (!entry || entry.resetAt <= now) {
    ipHits.set(ip, { hits: 1, resetAt: now + WINDOW_MS });
    return null;
  }
  entry.hits++;
  if (entry.hits > MAX_PER_IP) return new Response(JSON.stringify({ error: '请求过于频繁' }), { status: 429, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response(JSON.stringify({ ok: true, service: 'personal-hub-shortcode-relay', note: 'short-code WebRTC signaling relay', health: 'ok' }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }
    if (request.method === 'OPTIONS') {
      return new Response('', { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-relay-token,x-client-id' } });
    }
    const limited = rateLimit(request);
    if (limited) return limited;

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'room' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonError('请求体不是 JSON', 400); }
      const clientId = typeof body.clientId === 'string' ? body.clientId : '';
      if (!clientId || clientId.length > 64) return jsonError('clientId 不正确', 400);
      let code;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = String(Math.floor(100000 + Math.random() * 900000));
        const id = env.RELAY_ROOMS.idFromName(code);
        const stub = env.RELAY_ROOMS.get(id);
        const created = await stub.fetch('https://relay.local/room/' + code + '/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId })
        });
        const createdData = await created.json();
        if (created.ok) {
          return json({ ok: true, code, token: await signToken(env.SIGNALING_SECRET || 'dev-secret', code, clientId), peer: 0, ttlMs: createdData.ttlMs });
        }
        code = null;
      }
      return jsonError('房间码生成失败，请重试', 500);
    }

    const code = parts.length === 4 && parts[0] === 'api' && parts[1] === 'room' && /^[0-9]{6}$/.test(parts[2]) ? parts[2] : null;
    if (!code) return jsonError('接口路径不正确', 400);
    const id = env.RELAY_ROOMS.idFromName(code);
    const stub = env.RELAY_ROOMS.get(id);

    if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });
    if (parts[3] === 'join' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonError('请求体不是 JSON', 400); }
      const clientId = typeof body.clientId === 'string' ? body.clientId : '';
      if (!clientId || clientId.length > 64) return jsonError('clientId 不正确', 400);
      const join = await stub.fetch('https://relay.local/room/' + code + '/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, peer: 1, token: await signToken(env.SIGNALING_SECRET || 'dev-secret', code, clientId) })
      });
      const joined = await join.json();
      if (!joined.ok) return jsonError(joined.error || '加入失败', join.status);
      return json({ ok: true, token: await signToken(env.SIGNALING_SECRET || 'dev-secret', code, clientId), peer: 1, ttlMs: joined.ttlMs });
    }
    if (parts[3] === 'send' && request.method === 'POST') {
      const body = await request.text();
      if (body.length > 100 * 1024) return jsonError('消息过大', 413);
      const response = await stub.fetch('https://relay.local/room/' + code + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-relay-token': request.headers.get('x-relay-token') || '', 'x-client-id': request.headers.get('x-client-id') || '' },
        body
      });
      const data = await response.json();
      return json(data, response.status);
    }
    if (parts[3] === 'poll' && request.method === 'GET') {
      const poll = new URL('https://relay.local/room/' + code + '/poll');
      poll.search = url.search;
      const response = await stub.fetch(poll.toString(), { method: 'GET' });
      const data = await response.json();
      return json(data, response.status);
    }
    if (parts[3] === 'delete' && request.method === 'POST') {
      const response = await stub.fetch('https://relay.local/room/' + code + '/delete', {
        method: 'POST',
        headers: { 'x-relay-token': request.headers.get('x-relay-token') || '', 'x-client-id': request.headers.get('x-client-id') || '' }
      });
      const data = await response.json();
      return json(data, response.status);
    }
    return jsonError('不支持的操作', 400);
  }
};

export { RelayRoom };

function corsHeaders() {
  return { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
}
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: corsHeaders() });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}
