// RenRen Proxy クライアントスクリプト

class RenRenClient {
  constructor() {
    this.version = '1.0.0';
    this.prefix = '/service/';
    this.swRegistration = null;
    this.sessionId = null;
    
    this.init();
  }

  async init() {
    console.log('%c🎭 RenRen Proxy Client v' + this.version, 'color: #ff6b6b; font-size: 20px; font-weight: bold;');
    
    // Service Worker 登録
    if ('serviceWorker' in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/'
        });
        console.log('✓ Service Worker registered');
        
        // 更新チェック
        this.swRegistration.addEventListener('updatefound', () => {
          console.log('Service Worker update found');
        });
      } catch (error) {
        console.error('Service Worker registration failed:', error);
      }
    }

    // セッション作成
    await this.createSession();
    
    // UI イベント
    this.setupEventListeners();
  }

  async createSession() {
    try {
      const response = await fetch('/api/session/new', {
        method: 'POST'
      });
      const data = await response.json();
      this.sessionId = data.sessionId;
      console.log('✓ Session created:', this.sessionId);
      
      // sessionIdを保存
      localStorage.setItem('renren_session', this.sessionId);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  }

  setupEventListeners() {
    const form = document.getElementById('proxy-form');
    const input = document.getElementById('url-input');
    const goBtn = document.getElementById('go-btn');

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.navigate(input.value);
      });
    }

    if (goBtn) {
      goBtn.addEventListener('click', () => {
        this.navigate(input.value);
      });
    }
  }

  navigate(url) {
    if (!url) return;
    
    // URLの正規化
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      const encoded = this.encodeUrl(url);
      const proxyUrl = this.prefix + encoded;
      
      console.log('Navigating to:', url);
      console.log('Proxy URL:', proxyUrl);
      
      window.location.href = proxyUrl;
    } catch (error) {
      console.error('Navigation error:', error);
      alert('Invalid URL');
    }
  }

  encodeUrl(url) {
    return btoa(url);
  }

  decodeUrl(encoded) {
    try {
      return atob(encoded);
    } catch {
      return null;
    }
  }

  // セッション情報取得
  async getSessionInfo() {
    try {
      const response = await fetch('/api/session/info');
      return await response.json();
    } catch (error) {
      console.error('Failed to get session info:', error);
      return null;
    }
  }
}

// クライアント初期化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.renrenClient = new RenRenClient();
  });
} else {
  window.renrenClient = new RenRenClient();
}
