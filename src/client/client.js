class SingleProxyUI {
  constructor() {
    this.prefix = '/service/';
    this.sid = null;

    this.homeUrl = 'https://www.youtube.com/';

    this.init();
  }

  async init() {
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      } catch (e) {
        console.warn('SW register failed:', e);
      }
    }

    this.cacheDom();
    this.bindEvents();

    // 1つだけタブセッション作る（以後ずっと使う）
    this.sid = await this.apiNewSession();

    // 初期表示（好みでbingでもOK）
    this.navigate(this.homeUrl);
  }

  cacheDom() {
    this.form = document.getElementById('proxy-form');
    this.urlInput = document.getElementById('url-input');

    this.btnBack = document.getElementById('btn-back');
    this.btnForward = document.getElementById('btn-forward');
    this.btnReload = document.getElementById('btn-reload');
    this.btnHome = document.getElementById('btn-home');

    this.frame = document.getElementById('main-frame');
  }

  bindEvents() {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.navigate(this.urlInput.value);
    });

    this.btnHome.addEventListener('click', () => this.navigate(this.homeUrl));
    this.btnReload.addEventListener('click', () => this.reload());
    this.btnBack.addEventListener('click', () => this.back());
    this.btnForward.addEventListener('click', () => this.forward());

    // quick links
    document.querySelectorAll('[data-url]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const url = a.dataset.url;
        this.urlInput.value = url;
        this.navigate(url);
      });
    });
  }

  normalize(input) {
    const raw = (input || '').trim();
    if (!raw) return null;

    if (/^https?:\/\//i.test(raw)) return raw;

    if (/^[a-z0-9.-]+\.[a-z]{2,}([\/?#].*)?$/i.test(raw)) {
      return 'https://' + raw;
    }

    // 検索
    return 'https://www.google.com/search?q=' + encodeURIComponent(raw);
  }

  b64encUtf8(u) {
    return btoa(unescape(encodeURIComponent(u)));
  }

  async apiNewSession() {
    const r = await fetch('/api/tab/new', { method: 'POST' });
    const j = await r.json();
    if (!j || !j.tabSessionId) throw new Error('tabSessionId not returned');
    return j.tabSessionId;
  }

  buildProxyUrl(targetUrl) {
    const enc = this.b64encUtf8(targetUrl);
    return this.prefix + encodeURIComponent(this.sid) + '/' + enc;
  }

  navigate(input) {
    const url = this.normalize(input);
    if (!url) return;

    this.urlInput.value = url;
    this.frame.src = this.buildProxyUrl(url);
  }

  back() {
    try { this.frame.contentWindow.history.back(); } catch {}
  }

  forward() {
    try { this.frame.contentWindow.history.forward(); } catch {}
  }

  reload() {
    const cur = this.frame.src;
    this.frame.src = cur;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.singleProxyUI = new SingleProxyUI();
});
