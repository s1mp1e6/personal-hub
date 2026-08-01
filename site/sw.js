const CACHE_NAME = 'personal-hub-v1-local-first-7';
const APP_VERSION = '2026-08-02.3';
const META_CACHE = 'personal-hub-meta-v1';
const ASSETS = [
  './', './index.html', './manifest.json', './sync-core.js', './recovery-core.js',
  './vendor/qrcode.js', './vendor/jsQR.js', './vendor/lz-string.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(ASSETS.map(url => cache.add(url)));
    const meta = await caches.open(META_CACHE);
    await meta.put('app-version', new Response(APP_VERSION, { headers: { 'content-type': 'text/plain' } }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME && key !== META_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const request = event.request;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request) || await cache.match('./index.html');
    return cached || new Response('网络不可用，请检查连接', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  if (cached) {
    network.then(fresh => { if (fresh && fresh.ok) cache.put(request, fresh.clone()); }).catch(() => {});
    return cached;
  }
  return network || new Response('Not found', { status: 404 });
}
