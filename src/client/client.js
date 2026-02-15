class ProxyUI {
  constructor() {
    // サーバの config.prefix と一致させること（例: '/service/'）
    this.prefix = '/service/';

    this.tabs = [];
    this.activeTabId = null;

    this.homeUrl = 'https://bing.com';

    this.init();
  }

  async init() {
    // Service Worker（軽量・壊さない目的）
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
    await this.newTab(this.homeUrl);

    // ナビボタン状態を定期更新（同一オリジン制約で完全には取れないので控えめ）
    this.updateNavButtons();
    setInterval(() => this.updateNavButtons(), 800);
  }

  cacheDom() {
    this.tabsBar = document.getElementById('tabs-bar');
    this.view = document.getElementById('tabs-view');

    this.form = document.getElementById('proxy-form');
    this.urlInput = document.getElementById('url-input');

    this.btnBack = document.getElementById('btn-back');
    this.btnForward = document.getElementById('btn-forward');
    this.btnReload = document.getElementById('btn-reload');
    this.btnHome = document.getElementById('btn-home');
    this.btnNewTab = document.getElementById('btn-newtab');
  }

  bindEvents() {
    // URLバー Enter / Go
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.navigateCurrent(this.urlInput.value);
    });

    // 新規タブ
    this.btnNewTab.addEventListener('click', async () => {
      await this.newTab(this.homeUrl);
    });

    // ホーム
    this.btnHome.addEventListener('click', () => {
      this.navigateCurrent(this.homeUrl);
    });

    // 戻る/進む/更新
    this.btnReload.addEventListener('click', () => this.reloadActive());
    this.btnBack.addEventListener('click', () => this.backActive());
    this.btnForward.addEventListener('click', () => this.forwardActive());
  }

  normalize(input) {
    const raw = (input || '').trim();
    if (!raw) return null;

    if (/^https?:\/\//i.test(raw)) return raw;

    // example.com 形式は https:// を付与
    if (/^[a-z0-9.-]+\.[a-z]{2,}([\/?#].*)?$/i.test(raw)) {
      return 'https://' + raw;
    }

    // それ以外は検索（Bing）
    return 'https://www.bing.com/search?q=' + encodeURIComponent(raw);
  }

  b64encUtf8(u) {
    // UTF-8対応のbase64
    return btoa(unescape(encodeURIComponent(u)));
  }

  async apiNewTabSession() {
    const r = await fetch('/api/tab/new', { method: 'POST' });
    const j = await r.json();
    if (!j || !j.tabSessionId) throw new Error('tabSessionId not returned');
    return j.tabSessionId;
  }

  buildProxyUrl(sid, targetUrl) {
    const enc = this.b64encUtf8(targetUrl);
    return this.prefix + encodeURIComponent(sid) + '/' + enc;
  }

  short(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
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

  activate(tabId) {
    this.activeTabId = tabId;

    this.tabs.forEach(t => {
      const active = (t.tabId === tabId);
      t.tabEl.classList.toggle('active', active);
      t.iframe.style.display = active ? 'block' : 'none';
    });

    const t = this.activeTab;
    if (t?.url) this.urlInput.value = t.url;

    this.updateNavButtons();
  }

  async newTab(initialUrl) {
    const sid = await this.apiNewTabSession();

    const tabId =
      (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

    // タブ要素
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

    // iframe（タブ表示領域）
    const iframe = document.createElement('iframe');
    iframe.className = 'tab-frame';
    iframe.setAttribute('referrerpolicy', 'no-referrer');

    // 動作優先で緩め（必要なら後で調整）
    iframe.setAttribute(
      'sandbox',
      'allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-presentation'
    );

    this.view.appendChild(iframe);

    const tab = { tabId, sid, tabEl, titleEl, closeEl, iframe, url: '' };
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
      // 同一オリジン制約で title を取りにくいので、URLから表示
      if (tab.url) this.setTabTitle(tab, this.short(tab.url));
      this.updateNavButtons();
    });

    this.activate(tabId);
    this.navigateCurrent(initialUrl);
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

    // DOM削除
    t.tabEl.remove();
    t.iframe.remove();

    // サーバ側タブセッション削除（任意）
    try {
      await fetch('/api/tab/' + encodeURIComponent(t.sid), { method: 'DELETE' });
    } catch (e) {
      // 失敗してもUIは閉じる
    }

    this.tabs.splice(idx, 1);

    // タブが0なら新規作成
    if (this.tabs.length === 0) {
      await this.newTab(this.homeUrl);
      return;
    }

    // アクティブを閉じたなら隣へ
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.max(0, idx - 1)];
      this.activate(next.tabId);
    }
  }

  // ===== nav controls =====

  getActiveFrameWindow() {
    const t = this.activeTab;
    if (!t) return null;
    try { return t.iframe.contentWindow; } catch { return null; }
  }

  updateNavButtons() {
    const w = this.getActiveFrameWindow();

    let canBack = false;
    let canForward = false;

    try {
      // history.lengthは取れることが多いが完全ではない
      canBack = !!w && w.history && w.history.length > 1;
      // forwardは正確に判定しにくいのでオフ寄り（必要なら常にONにもできる）
      canForward = false;
    } catch {}

    this.btnBack.disabled = !canBack;
    this.btnForward.disabled = !canForward;
  }

  backActive() {
    const w = this.getActiveFrameWindow();
    try { w?.history.back(); } catch {}
  }

  forwardActive() {
    const w = this.getActiveFrameWindow();
    try { w?.history.forward(); } catch {}
  }

  reloadActive() {
    const t = this.activeTab;
    if (!t) return;
    const cur = t.iframe.src;
    t.iframe.src = cur;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.proxyUI = new ProxyUI();
});
