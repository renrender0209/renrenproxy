// RenRen Proxy Service Worker

const PREFIX = '/service/';
const VERSION = '1.0.0';

self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker version', VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (!url.pathname.startsWith(PREFIX)) return;

  event.respondWith(handleProxyRequest(event.request));
});

async function handleProxyRequest(request) {
  try {
    const url = new URL(request.url);
    const proxyPath = url.pathname.slice(PREFIX.length);

    const targetUrl = decodeProxyUrl(proxyPath);
    if (!targetUrl) return new Response('Invalid proxy URL', { status: 400 });

    console.log('[SW] Proxying:', targetUrl);

    // 重要：ここはサーバが /service/<encoded> を処理するので request をそのまま投げる
    const response = await fetch(request);

    return await rewriteResponse(response, targetUrl);
  } catch (error) {
    console.error('[SW] Fetch error:', error);
    return new Response('Proxy error: ' + error.message, { status: 500 });
  }
}

function decodeProxyUrl(encoded) {
  try {
    return decodeURIComponent(escape(atob(encoded)));
  } catch {
    return null;
  }
}

async function rewriteResponse(response, baseUrl) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/html')) {
    const html = await response.text();
    const rewritten = rewriteHtml(html, baseUrl);

    return new Response(rewritten, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  return response;
}

function rewriteHtml(html, baseUrl) {
  return html
    .replace(/href="([^"]+)"/g, (match, url) => shouldRewrite(url) ? `href="${rewriteUrl(url, baseUrl)}"` : match)
    .replace(/src="([^"]+)"/g, (match, url) => shouldRewrite(url) ? `src="${rewriteUrl(url, baseUrl)}"` : match);
}

function rewriteUrl(url, baseUrl) {
  try {
    const absolute = new URL(url, baseUrl).href;
    const encoded = btoa(unescape(encodeURIComponent(absolute)));
    return PREFIX + encoded;
  } catch {
    return url;
  }
}

function shouldRewrite(url) {
  if (!url) return false;
  const skipPrefixes = ['data:', 'blob:', 'javascript:', 'mailto:', 'tel:', '#'];
  return !skipPrefixes.some(prefix => url.startsWith(prefix));
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

console.log('[SW] RenRen Proxy Service Worker loaded');
