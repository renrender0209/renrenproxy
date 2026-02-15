import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import cors from 'cors';
import getRawBody from 'raw-body';
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

    // static
    this.app.use(express.static(join(__dirname, '../public')));
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
    });

    // タブ用セッション作成
    this.app.post('/api/tab/new', (req, res) => {
      const tabSessionId = this.sessionManager.createSession();
      res.json({ tabSessionId });
    });

    this.app.get('/api/tab/:sid', (req, res) => {
      const s = this.sessionManager.getSession(req.params.sid);
      if (!s) return res.status(404).json({ error: 'session not found' });
      res.json({ id: s.id, created: s.created, lastAccess: s.lastAccess });
    });

    this.app.delete('/api/tab/:sid', (req, res) => {
      this.sessionManager.deleteSession(req.params.sid);
      res.json({ ok: true });
    });

    // client assets
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

    // ★プロキシ本体：/service/:sid/<encoded...>
    // ここだけ raw-body で受ける（JSON/urlencodedを通さない）
    const prefix = (config.prefix || '/service/').replace(/\/+$/, '/');

    this.app.use(prefix + ':sid', async (req, res, next) => {
      try {
        // GET/HEADはbody無し
        if (req.method === 'GET' || req.method === 'HEAD') return next();

        // raw-body取得（Content-Lengthが無い場合もあるので try）
        const length = req.headers['content-length']
          ? parseInt(req.headers['content-length'], 10)
          : undefined;

        req.rawBody = await getRawBody(req, {
          length,
          limit: '25mb'
        });

        return next();
      } catch (e) {
        console.error('raw-body error:', e?.message || e);
        return res.status(413).send('Payload too large or invalid body');
      }
    }, this.proxy.handle.bind(this.proxy));

    this.app.use((req, res) => {
      res.status(404).json({ error: 'not found' });
    });
  }

  start() {
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
