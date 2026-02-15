import { v4 as uuidv4 } from 'uuid';

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // 1分ごと
  }

  createSession() {
    const sessionId = uuidv4();
    const session = {
      id: sessionId,
      created: Date.now(),
      lastAccess: Date.now(),
      cookies: {},
      localStorage: {},
      history: [],
      proxy: null // カスタムプロキシ設定
    };
    
    this.sessions.set(sessionId, session);
    console.log(`✓ Session created: ${sessionId}`);
    return sessionId;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccess = Date.now();
      return session;
    }
    return null;
  }

  updateSession(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, data);
      session.lastAccess = Date.now();
    }
  }

  deleteSession(sessionId) {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      console.log(`✓ Session deleted: ${sessionId}`);
    }
    return deleted;
  }

  cleanup() {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7日

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastAccess > maxAge) {
        this.deleteSession(sessionId);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.sessions.clear();
  }
}