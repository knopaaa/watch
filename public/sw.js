const CACHE = 'wt-v3.0.0';
const ASSETS = ['/', '/index.html', '/style.css?v=3.0.0', '/video-source.js?v=3.0.0', '/app.js?v=3.0.0', '/socket.io/socket.io.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('wt-') && key !== CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Транспорт Socket.IO и внешние плееры не кэшируем; клиентская библиотека — обычный JS.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      (url.pathname.startsWith('/socket.io') && url.pathname !== '/socket.io/socket.io.js')) return;
  const cacheKey = event.request.mode === 'navigate' ? '/index.html' : event.request;
  // Сначала сеть: исправления доступны уже при следующем открытии сайта.
  event.respondWith(fetch(event.request, { cache: 'no-cache' }).then(async (response) => {
    if (response.ok) {
      // Переполненный/недоступный кэш не должен мешать успешному сетевому ответу.
      try {
        const cache = await caches.open(CACHE);
        await cache.put(cacheKey, response.clone());
      } catch {}
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(cacheKey);
    return cached || Response.error();
  }));
});
