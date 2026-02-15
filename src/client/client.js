class RenRenTabs {
  constructor() {
    this.prefix = '/service/'; // サーバの config.prefix と一致させる
    this.tabs = [];
    this.activeTabId = null;

    this.init();
  }

  async init() {
    // SW登録（オプション）
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      } catch (e) {
        console.warn('SW register failed:', e);
      }
    }

    this.cacheDom();
    this.bindEvents();

    // 初期タブ
    await this.newTab('https://bing.com');
  }

  cacheDom() {
    this.urlInput = document.getElementById('url-input');
    this.form = document.getElementById('proxy-form');
    this.tabsBar = document.getElementById('tabs-bar');
    this.view = document.getElementById('tabs-view');
    this.newTabBtn = document.getElementById('new-tab');
  }

  bindEvents() {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.navigateCurrent(this.urlInput.value);
    });

    this.newTabBtn.addEventListener('click', async () => {
      await this.newTab('https://bing.com');
    });

    document.querySelectorAll('[data-url]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const url = a.dataset.url;
        this.urlInput.value = url;
        this.navigateCurrent(url);
      });
    });
  }

  normalize(input) {
    const raw = (input || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^[a-z0-9.-]+\.[a-z]{2,}([\/?#].*)?$/i.test(raw)) return 'https://' + raw;
    return 'https://www.bing.com/search?q=' + encodeURIComponent(raw);
  }

  b64enc(u) {
    return btoa(unescape(encodeURIComponent(u)));
  }

  async apiNewTabSession() {
    const r = await fetch('/api/tab/new', { method: 'POST' });
    const j = await r.json();
    return j.tabSessionId;
  }

  buildProxyUrl(sid, targetUrl) {
    const enc = this.b64enc(targetUrl);
    return this.prefix + encodeURIComponent(sid) + '/' + enc;
  }

  async newTab(initialUrl) {
    const sid = await this.apiNewTabSession();
    const tabId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();

    // UI要素
    const tabEl = document.createElement('button');
    tabEl.className = 'tab';
    tabEl.textContent = 'new';
    tabEl.dataset.tabId = tabId;

    const closeEl = document.createElement('span');
    closeEl.className = 'tab-close';
    closeEl.textContent = '×';
    tabEl.appendChild(closeEl);

    this.tabsBar.appendChild(tabEl);

    const iframe = document.createElement('iframe');
    iframe.className = 'tab-frame';
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-presentation');
    this.view.appendChild(iframe);

    const tab = { tabId, sid, tabEl, iframe, title: 'new', url: '' };
    this.tabs.push(tab);

    tabEl.addEventListener('click', (e) => {
      if (e.target === closeEl) return;
      this.activate(tabId);
    });

    closeEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.closeTab(tabId);
    });

    iframe.addEventListener('load', () => {
      // タイトルは同一オリジン制約で取れないことが多いので、URLで代用
      tabEl.firstChild && (tabEl.firstChild.textContent = tab.url ? this.short(tab.url) : 'tab');
    });

    this.activate(tabId);
    this.navigateCurrent(initialUrl);
  }

  short(u) {
    try { return new URL(u).hostname; } catch { return (u || 'tab').slice(0, 20); }
  }

  get activeTab() {
    return this.tabs.find(t => t.tabId === this.activeTabId);
  }

  activate(tabId) {
    this.activeTabId = tabId;
    this.tabs.forEach(t => {
      t.tabEl.classList.toggle('active', t.tabId === tabId);
      t.iframe.style.display = (t.tabId === tabId) ? 'block' : 'none';
    });
  }

  navigateCurrent(input) {
    const url = this.normalize(input);
    if (!url) return;

    const t = this.activeTab;
    if (!t) return;

    t.url = url;
    this.urlInput.value = url;

    const proxyUrl = this.buildProxyUrl(t.sid, url);
    t.iframe.src = proxyUrl;

    // タブ名更新
    t.tabEl.childNodes[0].textContent = this.short(url);
  }

  async closeTab(tabId) {
    const idx = this.tabs.findIndex(t => t.tabId === tabId);
    if (idx === -1) return;

    const t = this.tabs[idx];
    t.tabEl.remove();
    t.iframe.remove();

    // サーバ側セッション削除
    try { await fetch('/api/tab/' + encodeURIComponent(t.sid), { method: 'DELETE' }); } catch {}

    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      await this.newTab('https://bing.com');
      return;
    }

    if (this.activeTabId === tabId) {
      this.activate(this.tabs[Math.max(0, idx - 1)].tabId);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.renrenTabs = new RenRenTabs();
});
