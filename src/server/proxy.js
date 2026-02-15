import fetch from 'node-fetch';
import { URL } from 'url';
import mime from 'mime-types';
import { HTMLRewriter } from './rewriter.js';
import config from '../config.js';

export class ProxyHandler {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.rewriter = new HTMLRewriter();
  }

  async handle(req, res, next) {
    try {
      const proxyPath = req.path.slice(1);
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

      await this.processResponse(upstreamRes, res, targetUrl, session);

    } catch (err) {
      console.error('proxy error:', err.message);
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
      options.body = req.body;
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
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': req.headers['referer'] || undefined,
    };

    if (session?.cookies) {
      const cookieStr = Object.entries(session.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      if (cookieStr) {
        headers['Cookie'] = cookieStr;
      }
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

    // その他（画像・バイナリなど）
    const buffer = await upRes.buffer();
    res.send(buffer);
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
    if (!config.codec?.encode) {
      return encoded;
    }

    try {
      switch (config.codec.encryption) {
        case 'xor':
          return this.xorDecode(encoded, config.codec.salt);
        case 'base64':
          return Buffer.from(encoded, 'base64').toString('utf-8');
        default:
          return encoded;
      }
    } catch {
      return null;
    }
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
      const url = new URL(urlString);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  isBlocked(url) {
    return config.blacklist?.some(blocked => url.includes(blocked)) || false;
  }
}