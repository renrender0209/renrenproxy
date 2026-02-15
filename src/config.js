export default {
  port: process.env.PORT || 8080,
  host: '0.0.0.0',
  
  prefix: process.env.PROXY_PREFIX || '/service/',
  
  sessionConfig: {
    secret: process.env.SESSION_SECRET || 'hyperproxy-secret-key-change-in-production',
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7日間
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production'
    }
  },
  
  codec: {
    encode: true,
    encryption: 'xor', // 'xor', 'base64', 'plain'
    salt: 'hyperproxy-salt-2026'
  },
  
  rewrite: {
    html: true,
    css: true,
    js: true,
    attrs: ['href', 'src', 'action', 'data', 'poster'],
    styles: true,
    scripts: true
  },
  
  websocket: {
    enabled: true,
    heartbeat: 30000
  },
  
  cache: {
    enabled: process.env.ENABLE_CACHE === 'true',
    ttl: 3600,
    maxSize: 100 * 1024 * 1024 // 100MB
  },
  
  
  security: {
    contentSecurityPolicy: false,
    xssProtection: true,
    noSniff: true,
    referrerPolicy: 'no-referrer'
  },
  
  blacklist: [],
  
  logging: {
    enabled: true,
    level: process.env.NODE_ENV === 'production' ? 'error' : 'debug'
  }
};