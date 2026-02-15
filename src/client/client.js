class RenRenTabs {
  constructor() {
    this.prefix = '/service/'; // serverのconfig.prefixと一致させる
    this.tabs = [];
    this.activeTabId = null;

    this.init();
  }

  async init() {
    // SWは軽量モードなら任意
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

  short(u) {
    try {
      const x = new URL(u);
      return x.hostname.replace(/^www\./, '');
    } catch {
      return (u || 'tab').slice(0, 18);
    }
  }

  get activeTab() {
    return this.tabs.find(t => t.tabId === this.activeTabId);
  }

  setTabTitle(tab, title) {
    tab.title = title;
    tab.titleEl.textContent = title;
  }

  async newTab(initialUrl) {
    const sid = await this.apiNewTabSession();
    const tabId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

    // ===== tab button (Chrome-like) =====
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.tabId = tabId;

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = 'new tab';

    const closeEl = document.createElement('span');
    closeEl.className = 'tab-close';
    closeEl.textContent = '×';

    tabEl.appendChild(titleEl);
    tabEl.appendChild(closeEl);
    this.tabsBar.appendChild(tabEl);

    // ===== iframe =====
    const iframe = document.createElement('iframe');
    iframe.className = 'tab-frame';
    iframe.setAttribute('referrerpolicy', 'no-referrer');

    // Chromeっぽくするならsandboxは緩めすぎない方が良いが、
    // プロキシは動作優先で最低限許可（必要に応じて調整）
    iframe.setAttribute(
      'sandbox',
      'allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-presentation'
    );

    this.view.appendChild(iframe);

    const tab = { tabId, sid, tabEl, titleEl, closeEl, iframe, title: 'new tab', url: '' };
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
      // 同一オリジン制約でtitle取得は難しいので、URLのhostで更新
      if (tab.url) this.setTabTitle(tab, this.short(tab.url));
    });

    this.activate(tabId);
    this.navigateCurrent(initialUrl);
  }

  activate(tabId) {
    this.activeTabId = tabId;
    this.tabs.forEach(t => {
      const active = (t.tabId === tabId);
      t.tabEl.classList.toggle('active', active);
      t.iframe.style.display = active ? 'block' : 'none';
    });

    const t = this.activeTab;
    if (t?.url) this.urlInput.value = t.url;
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

    this.setTabTitle(t, this.short(url));
  }

  async closeTab(tabId) {
    const idx = this.tabs.findIndex(t => t.tabId === tabId);
    if (idx === -1) return;

    const t = this.tabs[idx];
    t.tabEl.remove();
    t.iframe.remove();

    // サーバ側セッション削除（タブ分離の要）
    try {
      await fetch('/api/tab/' + encodeURIComponent(t.sid), { method: 'DELETE' });
    } catch {}

    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      await this.newTab('https://bing.com');
      return;
    }

    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.max(0, idx - 1)];
      this.activate(next.tabId);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.renrenTabs = new RenRenTabs();
});
