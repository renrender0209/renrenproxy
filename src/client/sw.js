const PREFIX = '/service/';
const VERSION = '2.0.0-tabs';

self.addEventListener('install', (event) => {
  console.log('[SW] install', VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(PREFIX)) return;
  // 基本はサーバに任せる（requestそのまま）
  event.respondWith(fetch(event.request));
});

console.log('[SW] loaded', VERSION);
