const VERSION = '3.0.0-stable';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  // サーバ側で全部処理する（SWで二重rewriteしない）
  event.respondWith(fetch(event.request));
});

console.log('[SW] loaded', VERSION);
