// RenRen Proxy クライアントスクリプト

class RenRenClient {
  constructor() {
    this.version = '1.0.0';
    this.prefix = window.__RENREN_PREFIX__ || '/service/';
    this.swRegistration = null;
    this.sessionId = null;

    this.init();
  }

  async init() {
    console.log('%cRenRen Proxy Client v' + this.version, 'color:#c084fc; font-size: 18px; font-weight: 700;');

    // Service Worker 登録
    if ('serviceWorker' in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        console.log('✓ Service Worker registered');
      } catch (error) {
        console.error('Service Worker registration failed:', error);
      }
    }

    // セッション作成
    await this.createSession();

    // UIイベント
    this.setupEventListeners();
  }

  async createSession() {
    try {
      const response = await fetch('/api/session/new', { method: 'POST' });
      const data = await response.json();
      this.sessionId = data.sessionId;
      console.log('✓ Session created:', this.sessionId);
      localStorage.setItem('renren_session', this.sessionId);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  }

  setupEventListeners() {
    const form = document.getElementById('proxy-form');
    const input = document.getElementById('url-input');

    if (form && input) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.go(input.value);
      });
    }

    // もし将来 go-btn を付けても動くように
    const goBtn = document.getElementById('go-btn');
    if (goBtn && input) {
      goBtn.addEventListener('click', () => this.go(input.value));
    }
  }

  normalize(input) {
    const raw = (input || '').trim();
    if (!raw) return null;

    // 検索ワード対応（雑実装）：スペースが入ってたりドットが無い場合は検索に回す、など
    // まずはURL優先で最低限
    if (/^https?:\/\//i.test(raw)) return raw;

    // example.com 形式を https:// に
    if (/^[a-z0-9.-]+\.[a-z]{2,}([\/?#].*)?$/i.test(raw)) {
      return 'https://' + raw;
    }

    // それ以外は Bing 検索へ（好みで変えてOK）
    return 'https://www.bing.com/search?q=' + encodeURIComponent(raw);
  }

  base64EncodeUtf8(str) {
    // btoa はUTF-8を直接扱えないので安全に
    return btoa(unescape(encodeURIComponent(str)));
  }

  go(input) {
    const url = this.normalize(input);
    if (!url) return;

    try {
      const encoded = this.base64EncodeUtf8(url);
      const proxyUrl = this.prefix + encoded;

      console.log('Target:', url);
      console.log('Proxy :', proxyUrl);

      window.location.href = proxyUrl;
    } catch (e) {
      console.error('Navigation error:', e);
      alert('URLが不正かも');
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.renrenClient = new RenRenClient();
  });
} else {
  window.renrenClient = new RenRenClient();
}
