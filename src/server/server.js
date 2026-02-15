import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import config from '../config.js';
import { ProxyHandler } from './proxy.js';
import { SessionManager } from './session.js';
import { WebSocketHandler } from './websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class RenRenProxy {
  constructor() {
    this.app = express();
    this.sessionManager = new SessionManager();
    this.proxy = new ProxyHandler(this.sessionManager);

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(helmet({
      contentSecurityPolicy: config.security?.contentSecurityPolicy || false,
    }));

    this.app.use(cors());
    this.app.use(compression());

    // NOTE: バイナリ/フォーム等の完全対応は今後改善余地あり
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    this.app.use(cookieParser());

    this.app.use(session({
      ...config.sessionConfig,
      name: 'rr_sid',
      resave: false,
      saveUninitialized: false,
    }));

    if (config.logging?.enabled) {
      this.app.use((req, res, next) => {
        const time = new Date().toISOString().split('T')[1].split('.')[0];
        console.log(`${time} ${req.method} ${req.url}`);
        next();
      });
    }

    this.app.use(express.static(join(__dirname, '../public')));
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
    });

    // ★タブ用セッションを作る（タブ追加のたびに叩く）
    this.app.post('/api/tab/new', (req, res) => {
      const tabSessionId = this.sessionManager.createSession();
      res.json({ tabSessionId });
    });

    // 任意：セッション情報（デバッグ用）
    this.app.get('/api/tab/:sid', (req, res) => {
      const s = this.sessionManager.getSession(req.params.sid);
      if (!s) return res.status(404).json({ error: 'session not found' });
      res.json({ id: s.id, created: s.created, lastAccess: s.lastAccess });
    });

    this.app.delete('/api/tab/:sid', (req, res) => {
      this.sessionManager.deleteSession(req.params.sid);
      res.json({ ok: true });
    });

    // SW / client
    this.app.get('/sw.js', (req, res) => {
      res.type('application/javascript');
      res.set('Service-Worker-Allowed', '/');
      res.sendFile(join(__dirname, '../client/sw.js'));
    });

    this.app.get('/client.js', (req, res) => {
      res.type('application/javascript');
      res.sendFile(join(__dirname, '../client/client.js'));
    });

    this.app.get('/codec.js', (req, res) => {
      res.type('application/javascript');
      res.sendFile(join(__dirname, '../client/codec.js'));
    });

    // ★タブセッション対応プロキシ:
    // /service/:sid/<encoded...> を ProxyHandler に渡す
    const prefix = (config.prefix || '/service/').replace(/\/+$/, '/') ; // 末尾スラッシュ強制
    this.app.use(prefix + ':sid', this.proxy.handle.bind(this.proxy));

    this.app.use((req, res) => {
      res.status(404).json({ error: 'not found' });
    });
  }

  start() {
    // Render等では process.env.PORT が必須級
    const port = process.env.PORT || config.port || 8080;
    const host = config.host || '0.0.0.0';

    const server = this.app.listen(port, host, () => {
      const addr = server.address();
      const bindHost = addr.address === '::' ? 'localhost' : addr.address;
      const bindPort = addr.port;

      console.log(`
RenRenProxy 起動
──────────────────────────────
  http://${bindHost}:${bindPort}
  prefix → ${config.prefix || '/service/'}
  tabs  → /service/<tabSessionId>/<encoded>
──────────────────────────────
      `);
    });

    if (config.websocket?.enabled) {
      new WebSocketHandler(server, this.sessionManager);
      console.log('WebSocket handler started on /ws');
    }

    const shutdown = (signal) => {
      console.log(`\n${signal} received → shutting down`);
      server.close(() => process.exit(0));
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }
}

new RenRenProxy().start();
