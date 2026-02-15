import fetch from 'node-fetch';
import { URL } from 'url';
import setCookie from 'set-cookie-parser';
import cookie from 'cookie';
import { HTMLRewriter } from './rewriter.js';
import config from '../config.js';

class CookieJar {
  constructor() {
    // key: name|domain|path  => cookie object
    this.store = new Map();
  }

  _key(c) {
    return `${c.name}|${c.domain}|${c.path}`;
  }

  setFromSetCookieHeader(setCookieHeaders, requestUrl) {
    const url = new URL(requestUrl);
    const parsed = setCookie.parse(setCookieHeaders, { map: false });

    for (const c of parsed) {
      if (!c.name) continue;

      // domain normalize
      let domain = c.domain ? c.domain.toLowerCase() : url.hostname.toLowerCase();
      if (domain.startsWith('.')) domain = domain.slice(1);

      const path = c.path || '/';

      // expires handling
      let expiresAt = null;
      if (c.expires) {
        const t = new Date(c.expires).getTime();
        if (!Number.isNaN(t)) expiresAt = t;
      } else if (typeof c.maxAge === 'number') {
        expiresAt = Date.now() + c.maxAge * 1000;
      }

      // deletion
      if (c.value === '' || c.maxAge === 0) {
        this.store.delete(this._key({ name: c.name, domain, path }));
        continue;
      }

      const obj = {
        name: c.name,
        value: c.value ?? '',
        domain,
        path,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || null,
        expiresAt
      };
      this.store.set(this._key(obj), obj);
    }
  }

  getCookieHeader(targetUrl) {
    const url = new URL(targetUrl);
    const host = url.hostname.toLowerCase();
    const path = url.pathname || '/';
    const isHttps = url.protocol === 'https:';
    const now = Date.now();

    const out = [];

    for (const c of this.store.values()) {
      // expiry
      if (c.expiresAt && c.expiresAt <= now) continue;

      // domain match
      if (c.domain === host || host.endsWith('.' + c.domain)) {
        // path match
        if (path.startsWith(c.path)) {
          // secure
          if (c.secure && !isHttps) continue;
          out.push(`${c.name}=${c.value}`);
        }
      }
    }

    return out.join('; ');
  }
}

export class ProxyHandler {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.rewriter = new HTMLRewriter();
  }

  async handle(req, res) {
    try {
      const sid = this.extractSid(req);
      if (!sid) return res.status(400).json({ error: 'missing sid' });

      const session = this.sessionManager.getSession(sid);
      if (!session) return res.status(404).json({ error: 'tab session not found' });

      if (!session.cookieJar) {
        session.cookieJar = new CookieJar();
        this.sessionManager.updateSession(session.id, { cookieJar: session.cookieJar });
      }

      const encodedPart = (req.path || '/').slice(1);
      const targetUrl = this.decodeUrl(encodedPart);

      if (!targetUrl || !this.isValidUrl(targetUrl)) {
        return res.status(400).json({ error: 'invalid url' });
      }
      if (this.isBlocked(targetUrl)) {
        return res.status(403).json({ error: 'blocked' });
      }

      const upstreamRes = await this.fetchWithSession(targetUrl, req, session);

      // redirect rewrite (keep sid)
      if ([301, 302, 303, 307, 308].includes(upstreamRes.status)) {
        const loc = upstreamRes.headers.get('location');
        if (loc) {
          let abs;
          try { abs = new URL(loc, targetUrl).href; } catch { abs = loc; }
          const encoded = this.encodeUrl(abs);
          res.status(upstreamRes.status);
          res.setHeader('location', this.buildProxyUrl(sid, encoded));
          return res.end();
        }
      }

      await this.processResponse(upstreamRes, res, targetUrl, session, sid);
    } catch (err) {
      console.error('proxy error:', err);
      res.status(500).json({ error: 'proxy error' });
    }
  }

  extractSid(req) {
    const base = req.baseUrl || '';
    const prefix = (config.prefix || '/service/').replace(/\/+$/, '');
    if (!base.startsWith(prefix)) return null;
    return base.slice(prefix.length).replace(/^\/+/, '') || null;
  }

  buildProxyUrl(sid, encoded) {
    const prefix = (config.prefix || '/service/').replace(/\/+$/, '/');
    return prefix + encodeURIComponent(sid) + '/' + encoded;
  }

  async fetchWithSession(url, req, session) {
    const headers = this.buildHeaders(req, session, url);

    const options = {
      method: req.method,
      headers,
      redirect: 'manual',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // ★raw-bodyがあればそのまま投げる（これがフォーム/ログイン対応の核）
      if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
        options.body = req.rawBody;
      } else if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
        options.body = req.body;
      }
      // content-type は元のを優先（buildHeadersでコピー済み）
    }

    return await fetch(url, options);
  }

  buildHeaders(req, session, targetUrl) {
    const headers = {};

    // pass-through
    const pass = [
      'accept',
      'accept-language',
      'content-type',
      'origin',
      'referer',
      'user-agent'
    ];
    for (const h of pass) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }

    // Some sites dislike br from node-fetch; keep simple
    headers['accept-encoding'] = 'gzip, deflate';

    // Cookie from jar (tab separated)
    const jarCookie = session.cookieJar?.getCookieHeader(targetUrl);
    if (jarCookie) headers['cookie'] = jarCookie;

    // Remove hop-by-hop
    delete headers['connection'];
    delete headers['host'];

    return headers;
  }

  async processResponse(upRes, res, targetUrl, session, sid) {
    const contentType = upRes.headers.get('content-type') || '';

    // Set-Cookie -> CookieJar
    const raw = upRes.headers.raw?.();
    const setCookies = raw?.['set-cookie'];
    if (setCookies && setCookies.length) {
      session.cookieJar.setFromSetCookieHeader(setCookies, targetUrl);
    }

    res.status(upRes.status);

    for (const [key, value] of upRes.headers.entries()) {
      const lower = key.toLowerCase();

      // hop-by-hop
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade'].includes(lower)) {
        continue;
      }

      // stability-first: strip policies that break injection / iframe
      if (lower === 'content-security-policy') continue;
      if (lower === 'content-security-policy-report-only') continue;
      if (lower === 'cross-origin-embedder-policy') continue;
      if (lower === 'cross-origin-opener-policy') continue;
      if (lower === 'cross-origin-resource-policy') continue;

      // don't forward set-cookie as-is (we manage jar)
      if (lower === 'set-cookie') continue;

      res.setHeader(key, value);
    }

    // rewrite
    if (contentType.includes('text/html')) {
      const html = await upRes.text();
      const rewritten = this.rewriter.rewriteHtml(html, targetUrl, sid);
      res.send(rewritten);
      return;
    }

    if (contentType.includes('text/css')) {
      const css = await upRes.text();
      const rewritten = this.rewriter.rewriteCss(css, targetUrl, sid);
      res.send(rewritten);
      return;
    }

    if (contentType.includes('javascript') || contentType.includes('json')) {
      const text = await upRes.text();
      const rewritten = this.rewriter.rewriteJs(text, targetUrl, sid);
      res.send(rewritten);
      return;
    }

    // binary
    const buf = await upRes.arrayBuffer();
    res.send(Buffer.from(buf));
  }

  decodeUrl(encoded) {
    if (!config.codec?.encode) return encoded;
    try {
      if (config.codec.encryption === 'base64') {
        return Buffer.from(encoded, 'base64').toString('utf-8');
      }
      return encoded;
    } catch {
      return null;
    }
  }

  encodeUrl(url) {
    if (!config.codec?.encode) return url;
    try {
      if (config.codec.encryption === 'base64') {
        return Buffer.from(url, 'utf-8').toString('base64');
      }
      return url;
    } catch {
      return url;
    }
  }

  isValidUrl(urlString) {
    try {
      const u = new URL(urlString);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  isBlocked(url) {
    return config.blacklist?.some(blocked => url.includes(blocked)) || false;
  }
}
