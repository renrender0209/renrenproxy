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
      res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
      });
    });

    this.app.post('/api/session/new', (req, res) => {
      const sessionId = this.sessionManager.createSession();
      req.session.proxySessionId = sessionId;
      res.json({ sessionId });
    });

    this.app.get('/api/session/info', (req, res) => {
      const sid = req.session?.proxySessionId;
      if (!sid) {
        return res.status(400).json({ error: 'no active session' });
      }
      const info = this.sessionManager.getSession(sid);
      if (!info) {
        return res.status(404).json({ error: 'session not found' });
      }
      res.json(info);
    });

    this.app.delete('/api/session/:id', (req, res) => {
      this.sessionManager.deleteSession(req.params.id);
      res.json({ ok: true });
    });

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

    this.app.use(config.prefix || '/~/', this.proxy.handle.bind(this.proxy));

    this.app.use((req, res) => {
      res.status(404).json({ error: 'not found' });
    });
  }

  start() {
    const server = this.app.listen(
      config.port,
      config.host || '0.0.0.0',
      () => {
        const addr = server.address();
        const host = addr.address === '::' ? 'localhost' : addr.address;
        const port = addr.port;

        console.log(`
RenRenProxy が起動しました
──────────────────────────────
  http://${host}:${port}
  prefix → ${config.prefix || '/~/'}
──────────────────────────────
  • セッション管理
  • SW経由のリクエスト傍受
  • URL暗号化
  • WebSocket対応
  • HTML/JS/CSS書き換え
──────────────────────────────
        `);
      }
    );

    if (config.websocket?.enabled) {
      new WebSocketHandler(server, this.sessionManager);
      console.log('WebSocket handler を開始しました');
    }

    const shutdown = (signal) => {
      console.log(`\n${signal} 受信 → シャットダウン開始`);
      server.close(() => {
        console.log('HTTPサーバーを閉じました');
        process.exit(0);
      });
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT',  () => shutdown('SIGINT'));
  }
}

const server = new RenRenProxy();
server.start();