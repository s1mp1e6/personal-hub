// HMAC helper shared by Worker entry and Durable Object.
// Tokens are signed locally, so the relay never needs to store sessions.
export async function signToken(secret, code, clientId) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret || 'dev-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(code + ':' + clientId));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function verifyToken(secret, code, clientId, token) {
  const expected = await signToken(secret, code, clientId);
  return typeof token === 'string' && token.length > 0 && expected === token;
}
