import { WebSocketServer } from 'ws';
import { URL } from 'url';
import fetch from 'node-fetch';
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
      console.log('WebSocket connection established');
      
      // ターゲットURL取得
      const targetUrl = this.extractTargetUrl(req.url);
      
      if (!targetUrl) {
        clientWs.close(1008, 'Invalid target URL');
        return;
      }

      // ターゲットサーバーに接続
      const serverWs = new WebSocket(targetUrl);

      // クライアント → サーバー
      clientWs.on('message', (data) => {
        if (serverWs.readyState === WebSocket.OPEN) {
          serverWs.send(data);
        }
      });

      // サーバー → クライアント
      serverWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data);
        }
      });

      // エラーハンドリング
      serverWs.on('error', (error) => {
        console.error('Server WebSocket error:', error);
        clientWs.close(1011, 'Server error');
      });

      clientWs.on('error', (error) => {
        console.error('Client WebSocket error:', error);
        serverWs.close(1011, 'Client error');
      });

      // 接続終了
      serverWs.on('close', () => {
        clientWs.close();
      });

      clientWs.on('close', () => {
        serverWs.close();
      });

      // ハートビート
      const heartbeat = setInterval(() => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.ping();
        } else {
          clearInterval(heartbeat);
        }
      }, 30000);
    });

    console.log('✓ WebSocket server initialized on /ws');
  }

  extractTargetUrl(reqUrl) {
    try {
      const url = new URL(reqUrl, 'http://localhost');
      const target = url.searchParams.get('url');
      
      if (!target) return null;
      
      // Base64デコード
      const decoded = Buffer.from(target, 'base64').toString('utf-8');
      
      // wss:// → ws://, https:// → ws://
      return decoded.replace(/^https?:/, 'ws:').replace(/^wss?:/, 'ws:');
    } catch (error) {
      console.error('WebSocket URL extraction error:', error);
      return null;
    }
  }
}
