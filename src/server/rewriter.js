import { JSDOM } from 'jsdom';
import config from '../config.js';

export class HTMLRewriter {
  constructor() {
    this.urlAttrs = config.rewrite?.attrs || [
      'href', 'src', 'action', 'formaction', 'srcset', 'poster', 'data-src'
    ];
  }

  rewriteHtml(html, baseUrl) {
    try {
      const dom = new JSDOM(html);
      const doc = dom.window.document;

      this.urlAttrs.forEach(attr => {
        doc.querySelectorAll(`[${attr}]`).forEach(el => {
          const val = el.getAttribute(attr);
          if (val && this.shouldRewrite(val)) {
            el.setAttribute(attr, this.rewriteUrl(val, baseUrl));
          }
        });
      });

      doc.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style');
        if (style) {
          el.setAttribute('style', this.rewriteCssUrls(style, baseUrl));
        }
      });

      doc.querySelectorAll('style').forEach(style => {
        if (style.textContent) {
          style.textContent = this.rewriteCssUrls(style.textContent, baseUrl);
        }
      });

      doc.querySelectorAll('script:not([src])').forEach(script => {
        if (script.textContent) {
          script.textContent = this.rewriteJs(script.textContent, baseUrl);
        }
      });

      if (!doc.querySelector('base')) {
        const base = doc.createElement('base');
        base.href = this.rewriteUrl(baseUrl, baseUrl);
        doc.head.insertBefore(base, doc.head.firstChild);
      }

      const anti = doc.createElement('script');
      anti.textContent = this.getAntiDetectionScript();
      doc.head.appendChild(anti);

      return dom.serialize();
    } catch (err) {
      console.error('html rewrite failed:', err.message);
      return html;
    }
  }

  rewriteCss(css, baseUrl) {
    try {
      return this.rewriteCssUrls(css, baseUrl);
    } catch (err) {
      console.error('css rewrite failed:', err.message);
      return css;
    }
  }

  rewriteCssUrls(css, baseUrl) {
    return css.replace(
      /url\(['"]?([^'")]+)['"]?\)/gi,
      (match, url) => {
        if (this.shouldRewrite(url)) {
          return `url('${this.rewriteUrl(url, baseUrl)}')`;
        }
        return match;
      }
    );
  }

  rewriteJs(js, baseUrl) {
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

  rewriteUrl(url, baseUrl) {
    if (!url || !this.shouldRewrite(url)) return url;

    try {
      const abs = new URL(url, baseUrl).href;
      const encoded = this.encodeUrl(abs);
      return config.prefix + encoded;
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
          return Buffer.from(url).toString('base64');
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

  shouldRewrite(url) {
    if (!url || typeof url !== 'string') return false;

    const skip = ['data:', 'blob:', 'javascript:', 'mailto:', 'tel:', '#', 'about:'];
    return !skip.some(p => url.startsWith(p));
  }

  getAntiDetectionScript() {
    return `
      (function() {
        window.__RenRen__ = {
          version: '1.0',
          prefix: '${config.prefix}',

          location: new Proxy(window.location, {
            get(t, p) {
              if (p === 'href') return window.__RenRen__.getRealUrl(t.href);
              return t[p];
            },
            set(t, p, v) {
              if (p === 'href') {
                window.location.href = window.__RenRen__.rewriteUrl(v);
                return true;
              }
              return false;
            }
          }),

          fetch: new Proxy(window.fetch, {
            apply(t, self, args) {
              args[0] = window.__RenRen__.rewriteUrl(args[0]);
              return Reflect.apply(t, self, args);
            }
          }),

          XMLHttpRequest: class extends XMLHttpRequest {
            open(m, u, ...a) {
              return super.open(m, window.__RenRen__.rewriteUrl(u), ...a);
            }
          },

          rewriteUrl(u) {
            if (!u || typeof u !== 'string') return u;
            try {
              const abs = new URL(u, window.location.origin).href;
              return '${config.prefix}' + btoa(abs);
            } catch {
              return u;
            }
          },

          getRealUrl(pu) {
            try {
              const m = pu.match(new RegExp('${config.prefix}' + '([^?#]+)'));
              if (m) return atob(m[1]);
            } catch {}
            return pu;
          }
        };

        console.log('%cRenRen Proxy loaded', 'color:#0f0; font-weight:bold');
      })();
    `;
  }
}
