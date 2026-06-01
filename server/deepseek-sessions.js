import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Disk-backed session store for the DeepSeek provider.
 *
 * DeepSeek talks to a stateless HTTP API (no CLI session files like Claude /
 * Gemini / Codex), so without this store its conversations vanish on refresh
 * and can't be continued. This mirrors the Gemini sessionManager: it persists
 * each turn to JSON on disk, reloads on startup, lists sessions per project,
 * and provides prior turns for multi-turn context.
 *
 * Stored under ~/.cloudcli/ (a bind-mounted, persistent volume) so DeepSeek
 * sessions survive container rebuilds.
 */
class DeepseekSessionStore {
  constructor() {
    this.sessions = new Map();
    this.maxSessions = 200;
    this.sessionsDir = path.join(os.homedir(), '.cloudcli', 'deepseek-sessions');
    this.ready = this.init();
  }

  async init() {
    await this.initSessionsDir();
    await this.loadSessions();
  }

  async initSessionsDir() {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
    } catch (error) {
      // best-effort
    }
  }

  createSession(sessionId, projectPath) {
    const session = {
      id: sessionId,
      projectPath: projectPath || '',
      messages: [],
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    if (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) this.sessions.delete(oldestKey);
    }
    this.sessions.set(sessionId, session);
    this.saveSession(sessionId);
    return session;
  }

  addMessage(sessionId, role, content, projectPath) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession(sessionId, projectPath || '');
    }
    if (projectPath && !session.projectPath) {
      session.projectPath = projectPath;
    }
    session.messages.push({ role, content, timestamp: new Date() });
    session.lastActivity = new Date();
    this.saveSession(sessionId);
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /** Prior turns as [{role, content}] for sending to the API (multi-turn context). */
  getConversation(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages
      .filter((m) => typeof m.content === 'string' && m.content.length > 0)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
  }

  getProjectSessions(projectPath) {
    const sessions = [];
    for (const [, session] of this.sessions) {
      if (session.projectPath === projectPath) {
        sessions.push({
          id: session.id,
          summary: this.getSessionSummary(session),
          messageCount: session.messages.length,
          lastActivity: session.lastActivity,
        });
      }
    }
    return sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  }

  getSessionSummary(session) {
    if (!session.messages.length) return 'New Session';
    const firstUser = session.messages.find((m) => m.role === 'user');
    if (firstUser && typeof firstUser.content === 'string') {
      const c = firstUser.content;
      return c.length > 50 ? c.substring(0, 50) + '...' : c;
    }
    return 'New Session';
  }

  _safeFilePath(sessionId) {
    const safeId = String(sessionId).replace(/[/\\]|\.\./g, '');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  async saveSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      await fs.writeFile(this._safeFilePath(sessionId), JSON.stringify(session, null, 2));
    } catch (error) {
      // best-effort
    }
  }

  async loadSessions() {
    try {
      const files = await fs.readdir(this.sessionsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await fs.readFile(path.join(this.sessionsDir, file), 'utf8');
          const session = JSON.parse(data);
          session.createdAt = new Date(session.createdAt);
          session.lastActivity = new Date(session.lastActivity);
          (session.messages || []).forEach((m) => { m.timestamp = new Date(m.timestamp); });
          this.sessions.set(session.id, session);
        } catch (error) {
          // skip unreadable session file
        }
      }
      while (this.sessions.size > this.maxSessions) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey) this.sessions.delete(oldestKey);
      }
    } catch (error) {
      // best-effort
    }
  }

  async deleteSession(sessionId) {
    this.sessions.delete(sessionId);
    try {
      await fs.unlink(this._safeFilePath(sessionId));
    } catch (error) {
      // best-effort
    }
  }

  /** Display format consumed by the adapter's fetchHistory (mirrors sessionManager). */
  getSessionMessages(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages.map((m) => ({
      type: 'message',
      message: { role: m.role, content: m.content },
      timestamp: (m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp)).toISOString(),
    }));
  }
}

const deepseekSessionStore = new DeepseekSessionStore();

export const ready = deepseekSessionStore.ready;
export default deepseekSessionStore;
