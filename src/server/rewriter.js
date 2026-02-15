import { JSDOM } from 'jsdom';
import config from '../config.js';

export class HTMLRewriter {
  constructor() {
    this.urlAttrs = config.rewrite?.attrs || [
      'href', 'src', 'action', 'formaction', 'srcset', 'poster', 'data-src'
    ];
  }

  rewriteHtml(html, baseUrl, sid) {
    try {
      const dom = new JSDOM(html);
      const doc = dom.window.document;

      this.urlAttrs.forEach(attr => {
        doc.querySelectorAll(`[${attr}]`).forEach(el => {
          const val = el.getAttribute(attr);
          if (val && this.shouldRewrite(val)) {
            el.setAttribute(attr, this.rewriteUrl(val, baseUrl, sid));
          }
        });
      });

      // style属性
      doc.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style');
        if (style) el.setAttribute('style', this.rewriteCssUrls(style, baseUrl, sid));
      });

      // <style>
      doc.querySelectorAll('style').forEach(style => {
        if (style.textContent) style.textContent = this.rewriteCssUrls(style.textContent, baseUrl, sid);
      });

      // inline script（雑だけど入れる）
      doc.querySelectorAll('script:not([src])').forEach(script => {
        if (script.textContent) script.textContent = this.rewriteJs(script.textContent, baseUrl, sid);
      });

      // baseタグ（相対解決のため）※ただしプロキシURLにすると挙動が変わるので注意
      if (!doc.querySelector('base') && doc.head) {
        const base = doc.createElement('base');
        base.href = baseUrl;
        doc.head.insertBefore(base, doc.head.firstChild);
      }

      // 注入ランタイム（fetch/xhr/locationの書き換え）
      const anti = doc.createElement('script');
      anti.textContent = this.getClientRuntimeScript(sid);
      doc.head && doc.head.appendChild(anti);

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
    // “置換で全部直す”のは限界があるが、最低限
    try {
      return js
        .replace(/window\.location/g, '__RenRen__.location')
        .replace(/document\.location/g, '__RenRen__.location')
        .replace(/fetch\(/g, '__RenRen__.fetch(')
        .replace(/new XMLHttpRequest\(/g, 'new __RenRen__.XMLHttpRequest(');
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

  encodeUrl(url) {
    if (!config.codec?.encode) return url;

    try {
      switch (config.codec.encryption) {
        case 'xor':
          return this.xorEncode(url, config.codec.salt);
        case 'base64':
          return Buffer.from(url, 'utf-8').toString('base64');
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

  shouldRewrite(url) {
    if (!url || typeof url !== 'string') return false;
    const skip = ['data:', 'blob:', 'javascript:', 'mailto:', 'tel:', '#', 'about:'];
    return !skip.some(p => url.startsWith(p));
  }

  getClientRuntimeScript(sid) {
    // 重要：ここも encodeUrl の方式と合わせる（base64推奨）
    const prefix = this.buildPrefix(sid);
    const codec = config.codec?.encryption || 'base64';

    return `
(function () {
  const SID = ${JSON.stringify(sid)};
  const PREFIX = ${JSON.stringify(prefix)};
  const CODEC = ${JSON.stringify(codec)};

  function b64enc(u) {
    try { return btoa(unescape(encodeURIComponent(u))); } catch { return btoa(u); }
  }
  function b64dec(s) {
    try { return decodeURIComponent(escape(atob(s))); } catch { return atob(s); }
  }

  // xorはサーバと完全一致が必要（ここではbase64運用推奨）
  function encodeUrl(u) {
    if (CODEC === 'base64') return b64enc(u);
    // fallback
    return b64enc(u);
  }

  function rewrite(u) {
    if (!u || typeof u !== 'string') return u;
    // すでにプロキシURLならそのまま
    if (u.startsWith(PREFIX)) return u;
    try {
      const abs = new URL(u, window.location.href).href;
      return PREFIX + encodeUrl(abs);
    } catch {
      return u;
    }
  }

  window.__RenRen__ = {
    sid: SID,
    prefix: PREFIX,
    rewriteUrl: rewrite,
    fetch: new Proxy(window.fetch, {
      apply(t, self, args) {
        args[0] = rewrite(args[0]);
        return Reflect.apply(t, self, args);
      }
    }),
    XMLHttpRequest: class extends XMLHttpRequest {
      open(m, u, ...a) { return super.open(m, rewrite(u), ...a); }
    },
    location: new Proxy(window.location, {
      set(t, p, v) {
        if (p === 'href') { window.location.href = rewrite(v); return true; }
        return false;
      }
    })
  };

  console.log('%cRenRen Tab Runtime loaded', 'color:#c084fc;font-weight:700');
})();
`;
  }
}
