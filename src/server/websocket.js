import { WebSocketServer } from 'ws';
import { URL } from 'url';
import WebSocket from 'ws';

export class WebSocketHandler {
  constructor(server, sessionManager) {
    this.sessionManager = sessionManager;
    this.wss = new WebSocketServer({
      server,
      path: '/ws'
    });

    this.setupWebSocket();
  }

  setupWebSocket() {
    this.wss.on('connection', (clientWs, req) => {
      try {
        const { sid, targetUrl } = this.extract(req.url);
        if (!targetUrl) {
          clientWs.close(1008, 'Invalid target URL');
          return;
        }

        // ws/wssに変換（最低限）
        const wsTarget = targetUrl.replace(/^https?:/i, 'wss:').replace(/^ws:/i, 'wss:');

        const session = sid ? this.sessionManager.getSession(sid) : null;
        const cookieHeader = session?.cookieJar?.getCookieHeader?.(targetUrl);

        const serverWs = new WebSocket(wsTarget, {
          headers: cookieHeader ? { 'Cookie': cookieHeader } : undefined
        });

        clientWs.on('message', (data) => {
          if (serverWs.readyState === WebSocket.OPEN) serverWs.send(data);
        });

        serverWs.on('message', (data) => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
        });

        serverWs.on('error', (error) => {
          console.error('Server WS error:', error?.message || error);
          try { clientWs.close(1011, 'Server error'); } catch {}
        });

        clientWs.on('error', (error) => {
          console.error('Client WS error:', error?.message || error);
          try { serverWs.close(1011, 'Client error'); } catch {}
        });

        serverWs.on('close', () => { try { clientWs.close(); } catch {} });
        clientWs.on('close', () => { try { serverWs.close(); } catch {} });

      } catch (e) {
        console.error('WS handler error:', e?.message || e);
        try { clientWs.close(1011, 'Proxy ws error'); } catch {}
      }
    });

    console.log('✓ WebSocket server initialized on /ws');
  }

  extract(reqUrl) {
    const url = new URL(reqUrl, 'http://localhost');
    const sid = url.searchParams.get('sid') || null;
    const enc = url.searchParams.get('url');
    if (!enc) return { sid, targetUrl: null };

    try {
      const decoded = Buffer.from(enc, 'base64').toString('utf-8');
      return { sid, targetUrl: decoded };
    } catch {
      return { sid, targetUrl: null };
    }
  }
}
