import fetch from 'node-fetch';
import { URL } from 'url';
import { HTMLRewriter } from './rewriter.js';
import config from '../config.js';

export class ProxyHandler {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.rewriter = new HTMLRewriter();
  }

  // req.baseUrl: "/service/<sid>"（expressの mount 仕様）
  // req.path: "/<encoded...>"
  async handle(req, res) {
    try {
      const sid = this.extractSid(req);
      if (!sid) return res.status(400).json({ error: 'missing sid' });

      const session = this.sessionManager.getSession(sid);
      if (!session) return res.status(404).json({ error: 'tab session not found' });

      const encodedPart = (req.path || '/').slice(1); // remove leading '/'
      const targetUrl = this.decodeUrl(encodedPart);

      if (!targetUrl || !this.isValidUrl(targetUrl)) {
        return res.status(400).json({ error: 'invalid url' });
      }

      if (this.isBlocked(targetUrl)) {
        return res.status(403).json({ error: 'blocked' });
      }

      const upstreamRes = await this.fetchWithSession(targetUrl, req, session);

      // ★リダイレクト書き換え（タブsid維持）
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
    // baseUrl: "/service/<sid>" or "/service/<sid>/..."
    const base = req.baseUrl || '';
    const prefix = (config.prefix || '/service/').replace(/\/+$/, '');
    if (!base.startsWith(prefix)) return null;
    const sid = base.slice(prefix.length).replace(/^\/+/, '');
    return sid || null;
  }

  buildProxyUrl(sid, encoded) {
    const prefix = (config.prefix || '/service/').replace(/\/+$/, '/');
    return prefix + encodeURIComponent(sid) + '/' + encoded;
  }

  async fetchWithSession(url, req, session) {
    const headers = this.buildHeaders(req, session);

    const options = {
      method: req.method,
      headers,
      redirect: 'manual',
    };

    // NOTE: ここは本格化するなら raw-body で完全に流すべき
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
        options.body = req.body;
      } else if (req.body && Object.keys(req.body).length) {
        options.body = JSON.stringify(req.body);
        options.headers['content-type'] = options.headers['content-type'] || 'application/json';
      }
    }

    return await fetch(url, options);
  }

  buildHeaders(req, session) {
    const headers = {
      'User-Agent': req.headers['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9,en;q=0.8',
      'Referer': req.headers['referer'] || undefined,
      // Hostヘッダ等は node-fetch が処理するので基本入れない
    };

    // ★タブごとのCookie
    if (session?.cookies) {
      const cookieStr = Object.entries(session.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      if (cookieStr) headers['Cookie'] = cookieStr;
    }

    return headers;
  }

  async processResponse(upRes, res, targetUrl, session, sid) {
    const contentType = upRes.headers.get('content-type') || '';

    // ★Set-Cookie保存（タブごと）
    const setCookie = upRes.headers.raw?.()['set-cookie'] || upRes.headers.get('set-cookie');
    if (setCookie && session) {
      this.saveCookies(setCookie, session);
    }

    res.status(upRes.status);

    // ヘッダコピー（危険なもの除外）
    for (const [key, value] of upRes.headers.entries()) {
      const lower = key.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lower)) continue;

      // ★CSP等で注入が死ぬことが多いので緩和（高性能志向）
      if (lower === 'content-security-policy') continue;
      if (lower === 'content-security-policy-report-only') continue;

      // ★クロス分離系で壊れる場合が多い
      if (lower === 'cross-origin-embedder-policy') continue;
      if (lower === 'cross-origin-opener-policy') continue;
      if (lower === 'cross-origin-resource-policy') continue;

      res.setHeader(key, value);
    }

    // ★HTML/CSS/JS書き換え（sidを渡してURL生成に反映）
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

    // バイナリはそのまま
    const buffer = await upRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  }

  saveCookies(setCookieHeader, session) {
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

    cookies.forEach(cookieStr => {
      const [nameValue] = cookieStr.split(';');
      const idx = nameValue.indexOf('=');
      if (idx === -1) return;
      const name = nameValue.slice(0, idx).trim();
      const value = nameValue.slice(idx + 1).trim();
      if (name) session.cookies[name] = value;
    });

    this.sessionManager.updateSession(session.id, { cookies: session.cookies });
  }

  decodeUrl(encoded) {
    if (!config.codec?.encode) return encoded;

    try {
      switch (config.codec.encryption) {
        case 'base64':
          return Buffer.from(encoded, 'base64').toString('utf-8');
        case 'xor':
          return this.xorDecode(encoded, config.codec.salt);
        default:
          return encoded;
      }
    } catch {
      return null;
    }
  }

  encodeUrl(url) {
    if (!config.codec?.encode) return url;

    try {
      switch (config.codec.encryption) {
        case 'base64':
          return Buffer.from(url, 'utf-8').toString('base64');
        case 'xor':
          return this.xorEncode(url, config.codec.salt);
        default:
          return url;
      }
    } catch {
      return url;
    }
  }

  xorEncode(str, key) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
      result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return Buffer.from(result, 'binary').toString('base64');
  }

  xorDecode(str, key) {
    const binary = Buffer.from(str, 'base64').toString('binary');
    let result = '';
    for (let i = 0; i < binary.length; i++) {
      result += String.fromCharCode(binary.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
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
