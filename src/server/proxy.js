import fetch from 'node-fetch';
import { URL } from 'url';
import { HTMLRewriter } from './rewriter.js';
import config from '../config.js';

export class ProxyHandler {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.rewriter = new HTMLRewriter();
  }

  async handle(req, res, next) {
    try {
      const proxyPath = req.path.slice(1); // "/service/<encoded>" の "<encoded>"
      const targetUrl = this.decodeUrl(proxyPath);

      if (!targetUrl || !this.isValidUrl(targetUrl)) {
        return res.status(400).json({ error: 'invalid url' });
      }

      if (this.isBlocked(targetUrl)) {
        return res.status(403).json({ error: 'blocked' });
      }

      const sessionId = req.session.proxySessionId;
      const session = sessionId ? this.sessionManager.getSession(sessionId) : null;

      const upstreamRes = await this.fetchWithSession(targetUrl, req, session);

      // ★リダイレクト(Location)を書き換える
      if ([301, 302, 303, 307, 308].includes(upstreamRes.status)) {
        const loc = upstreamRes.headers.get('location');
        if (loc) {
          let abs;
          try {
            abs = new URL(loc, targetUrl).href;
          } catch {
            abs = loc;
          }

          const encoded = this.encodeUrl(abs);
          res.status(upstreamRes.status);
          res.setHeader('location', (config.prefix || '/service/') + encoded);
          return res.end();
        }
      }

      await this.processResponse(upstreamRes, res, targetUrl, session);
    } catch (err) {
      console.error('proxy error:', err);
      res.status(500).json({ error: 'proxy error' });
    }
  }

  async fetchWithSession(url, req, session) {
    const headers = this.buildHeaders(req, session);

    const options = {
      method: req.method,
      headers,
      redirect: 'manual',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // express.json() で object になってると fetch が困る場合がある
      // まずはJSONとして投げる（必要に応じて content-type 見て改良）
      if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
        options.body = req.body;
      } else if (req.body && Object.keys(req.body).length) {
        options.body = JSON.stringify(req.body);
        options.headers['content-type'] = options.headers['content-type'] || 'application/json';
      }
    }

    if (session?.proxy) {
      options.agent = session.proxy;
    }

    return await fetch(url, options);
  }

  buildHeaders(req, session) {
    const headers = {
      'User-Agent': req.headers['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      // node-fetch が自動でやるので基本は不要。入れると壊れることもある
      // 'Accept-Encoding': 'gzip, deflate, br',
      'Referer': req.headers['referer'] || undefined,
    };

    if (session?.cookies) {
      const cookieStr = Object.entries(session.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      if (cookieStr) headers['Cookie'] = cookieStr;
    }

    return headers;
  }

  async processResponse(upRes, res, targetUrl, session) {
    const contentType = upRes.headers.get('content-type') || '';

    const setCookie = upRes.headers.get('set-cookie');
    if (setCookie && session) {
      this.saveCookies(setCookie, session);
    }

    res.status(upRes.status);

    for (const [key, value] of upRes.headers.entries()) {
      const lower = key.toLowerCase();
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lower)) {
        res.setHeader(key, value);
      }
    }

    if (contentType.includes('text/html')) {
      const html = await upRes.text();
      const rewritten = this.rewriter.rewriteHtml(html, targetUrl);
      res.send(rewritten);
      return;
    }

    if (contentType.includes('text/css')) {
      const css = await upRes.text();
      const rewritten = this.rewriter.rewriteCss(css, targetUrl);
      res.send(rewritten);
      return;
    }

    if (contentType.includes('javascript') || contentType.includes('json')) {
      const text = await upRes.text();
      const rewritten = this.rewriter.rewriteJs(text, targetUrl);
      res.send(rewritten);
      return;
    }

    const buffer = await upRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  }

  saveCookies(setCookieHeader, session) {
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

    cookies.forEach(cookieStr => {
      const [nameValue] = cookieStr.split(';');
      const [name, value] = nameValue.split('=');
      if (name && value) {
        session.cookies[name.trim()] = value.trim();
      }
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
      result += String.fromCharCode(
        str.charCodeAt(i) ^ key.charCodeAt(i % key.length)
      );
    }
    return Buffer.from(result, 'binary').toString('base64');
  }

  xorDecode(str, key) {
    const binary = Buffer.from(str, 'base64').toString('binary');
    let result = '';
    for (let i = 0; i < binary.length; i++) {
      result += String.fromCharCode(
        binary.charCodeAt(i) ^ key.charCodeAt(i % key.length)
      );
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
