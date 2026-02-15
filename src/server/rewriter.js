import { JSDOM } from 'jsdom';
import config from '../config.js';

export class HTMLRewriter {
  constructor() {
    this.urlAttrs = config.rewrite?.attrs || [
      'href', 'src', 'action', 'formaction', 'poster', 'data'
    ];
  }

  rewriteHtml(html, baseUrl, sid) {
    try {
      const dom = new JSDOM(html);
      const doc = dom.window.document;

      // remove meta CSP (very common injection killer)
      doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="content-security-policy"]').forEach(m => m.remove());

      // rewrite attrs
      for (const attr of this.urlAttrs) {
        doc.querySelectorAll(`[${attr}]`).forEach(el => {
          const val = el.getAttribute(attr);
          if (val && this.shouldRewrite(val)) {
            el.setAttribute(attr, this.rewriteUrl(val, baseUrl, sid));
          }
        });
      }

      // srcset special
      doc.querySelectorAll('[srcset]').forEach(el => {
        const v = el.getAttribute('srcset');
        if (!v) return;
        el.setAttribute('srcset', this.rewriteSrcset(v, baseUrl, sid));
      });

      // integrity breaks modified scripts/styles
      doc.querySelectorAll('[integrity]').forEach(el => el.removeAttribute('integrity'));

      // style attr url()
      doc.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style');
        if (style) el.setAttribute('style', this.rewriteCssUrls(style, baseUrl, sid));
      });

      // <style> blocks
      doc.querySelectorAll('style').forEach(style => {
        if (style.textContent) style.textContent = this.rewriteCssUrls(style.textContent, baseUrl, sid);
      });

      // meta refresh
      doc.querySelectorAll('meta[http-equiv="refresh"]').forEach(m => {
        const c = m.getAttribute('content');
        if (!c) return;
        // pattern: "0;url=..."
        const match = c.match(/^\s*\d+\s*;\s*url=(.+)\s*$/i);
        if (match) {
          const url = match[1].replace(/^['"]|['"]$/g, '');
          if (this.shouldRewrite(url)) {
            const nu = this.rewriteUrl(url, baseUrl, sid);
            m.setAttribute('content', c.replace(match[1], nu));
          }
        }
      });

      // base tag (keep real baseUrl)
      if (!doc.querySelector('base') && doc.head) {
        const base = doc.createElement('base');
        base.href = baseUrl;
        doc.head.insertBefore(base, doc.head.firstChild);
      }

      // inject runtime (fetch/xhr/location/ws)
      const runtime = doc.createElement('script');
      runtime.textContent = this.getClientRuntimeScript(sid);
      doc.head && doc.head.appendChild(runtime);

      return dom.serialize();
    } catch (err) {
      console.error('html rewrite failed:', err.message);
      return html;
    }
  }

  rewriteCss(css, baseUrl, sid) {
    try {
      return this.rewriteCssUrls(css, baseUrl, sid);
    } catch (err) {
      console.error('css rewrite failed:', err.message);
      return css;
    }
  }

  rewriteCssUrls(css, baseUrl, sid) {
    return css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, url) => {
      if (this.shouldRewrite(url)) return `url('${this.rewriteUrl(url, baseUrl, sid)}')`;
      return match;
    });
  }

  rewriteJs(js) {
    // 基本：雑な置換は最低限に留め、注入ランタイムで握る
    try {
      return js;
    } catch (err) {
      console.error('js rewrite failed:', err.message);
      return js;
    }
  }

  buildPrefix(sid) {
    const p = (config.prefix || '/service/').replace(/\/+$/, '/');
    return p + encodeURIComponent(sid) + '/';
  }

  rewriteUrl(url, baseUrl, sid) {
    if (!url || !this.shouldRewrite(url)) return url;
    try {
      const abs = new URL(url, baseUrl).href;
      const encoded = this.encodeUrl(abs);
      return this.buildPrefix(sid) + encoded;
    } catch {
      return url;
    }
  }

  rewriteSrcset(srcset, baseUrl, sid) {
    // "a.jpg 1x, b.jpg 2x" みたいな形式
    return srcset.split(',')
      .map(part => part.trim())
      .map(part => {
        const seg = part.split(/\s+/);
        const u = seg[0];
        if (u && this.shouldRewrite(u)) seg[0] = this.rewriteUrl(u, baseUrl, sid);
        return seg.join(' ');
      })
      .join(', ');
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

  shouldRewrite(url) {
    if (!url || typeof url !== 'string') return false;
    const skip = ['data:', 'blob:', 'javascript:', 'mailto:', 'tel:', '#', 'about:'];
    return !skip.some(p => url.startsWith(p));
  }

  getClientRuntimeScript(sid) {
    const prefix = this.buildPrefix(sid);

    return `
(function () {
  const SID = ${JSON.stringify(sid)};
  const PREFIX = ${JSON.stringify(prefix)};

  function b64enc(u) {
    try { return btoa(unescape(encodeURIComponent(u))); } catch { return btoa(u); }
  }

  function rewrite(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith(PREFIX)) return u;
    try {
      const abs = new URL(u, window.location.href).href;
      return PREFIX + b64enc(abs);
    } catch {
      return u;
    }
  }

  // fetch
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      if (typeof input === 'string') input = rewrite(input);
      else if (input && input.url) input = rewrite(input.url);
    } catch {}
    return _fetch.call(this, input, init);
  };

  // XHR
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u, ...a) {
    try { u = rewrite(u); } catch {}
    return _open.call(this, m, u, ...a);
  };

  // location.href set
  try {
    const loc = window.location;
    Object.defineProperty(window, 'location', {
      get() { return loc; },
      set(v) { loc.href = rewrite(v); }
    });
  } catch {}

  // WebSocket wrapper (best-effort)
  const _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    try {
      const abs = new URL(url, window.location.href).href;
      const enc = b64enc(abs);
      const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?sid=' + encodeURIComponent(SID) + '&url=' + encodeURIComponent(enc);
      return protocols ? new _WS(wsUrl, protocols) : new _WS(wsUrl);
    } catch (e) {
      return protocols ? new _WS(url, protocols) : new _WS(url);
    }
  };
  window.WebSocket.prototype = _WS.prototype;

  console.log('%cRenRen runtime loaded', 'color:#c084fc;font-weight:700');
})();
`;
  }
}
