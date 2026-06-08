'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const ctl = require('./cmuxctl');

const DEFAULT_WAKE_TEXT = '[cmux-dashboard] New message from claude. Run agmsg inbox once for this project, implement, run tests, and reply to claude.\n';

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function summarizeError(err) {
  const raw = typeof err === 'string' ? err : (err && err.message) || String(err || 'unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown error';
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      env: opts.env || { ...process.env },
      timeout: opts.timeout || intEnv('CMUX_DASH_COLLAB_DELIVERY_SQLITE_TIMEOUT_MS', 1500),
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || stdout || err.message).toString().trim());
        e.code = err.code;
        e.signal = err.signal;
        return reject(e);
      }
      resolve((stdout || '').toString().trim());
    });
  });
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function boundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

async function resolveDbPath(opts = {}) {
  if (opts.dbPath) return typeof opts.dbPath === 'function' ? String(await opts.dbPath()) : String(opts.dbPath);
  const dbPath = opts.agmsgDbPath ? await opts.agmsgDbPath() : await ctl.agmsgDbPath();
  return String(dbPath || '').trim();
}

async function sqliteJson(sql, opts = {}) {
  const db = await resolveDbPath(opts);
  if (!db || !fs.existsSync(db)) return [];
  const sqlite3 = opts.sqlite3Bin || process.env.CMUX_DASH_SQLITE3 || 'sqlite3';
  const out = await run(sqlite3, ['-readonly', '-json', db, sql], opts);
  return out ? JSON.parse(out) : [];
}

async function readUnreadWakeMessages(team, opts = {}) {
  const normalizedTeam = (opts.teamName || ctl.teamName)(team);
  const limit = boundedInt(opts.limit, 20, { min: 1, max: 200 });
  const sql = [
    'SELECT id, created_at AS createdAt, team, from_agent AS "from", to_agent AS "to", read_at AS readAt',
    'FROM messages',
    `WHERE team = ${sqlString(normalizedTeam)}`,
    "AND to_agent = 'codex'",
    "AND from_agent = 'claude'",
    'AND read_at IS NULL',
    'ORDER BY id ASC',
    `LIMIT ${limit};`,
  ].join(' ');
  const rows = await sqliteJson(sql, opts);
  return rows.map((row) => ({
    id: Number(row.id) || 0,
    createdAt: row.createdAt || null,
    team: row.team || normalizedTeam,
    from: row.from || '',
    to: row.to || '',
    readAt: row.readAt || null,
  })).filter((row) => row.id > 0);
}

async function readDeliveryStatus(team, messageId, opts = {}) {
  const normalizedTeam = (opts.teamName || ctl.teamName)(team);
  const id = boundedInt(messageId, 0, { min: 1 });
  if (!id) return { delivered: false, readAt: null, replyId: null, missing: true };
  const sql = [
    'SELECT m.id, m.read_at AS readAt,',
    '(SELECT r.id FROM messages r',
    `WHERE r.team = ${sqlString(normalizedTeam)}`,
    "AND r.from_agent = 'codex'",
    "AND r.to_agent = 'claude'",
    'AND r.id > m.id',
    'ORDER BY r.id ASC LIMIT 1) AS replyId',
    'FROM messages m',
    `WHERE m.team = ${sqlString(normalizedTeam)} AND m.id = ${id}`,
    'LIMIT 1;',
  ].join(' ');
  const rows = await sqliteJson(sql, opts);
  const row = rows[0] || {};
  const replyId = Number(row.replyId) || null;
  const readAt = row.readAt || null;
  return { delivered: !!(readAt || replyId), readAt, replyId, missing: !rows.length };
}

function isPaneDeliveryActiveProject(row) {
  return !!(
    row &&
    row.open &&
    row.collab &&
    row.collab.enabled &&
    row.collab.active === true &&
    row.wsRef &&
    row.slotRefs &&
    row.slotRefs.cc &&
    row.slotRefs.cdx
  );
}

class CollabDelivery {
  constructor(opts = {}) {
    this.ctl = opts.ctl || ctl;
    this.intervalMs = opts.intervalMs != null ? opts.intervalMs : intEnv('CMUX_DASH_COLLAB_DELIVERY_INTERVAL_MS', 3000);
    this.retryMs = opts.retryMs != null ? opts.retryMs : intEnv('CMUX_DASH_COLLAB_DELIVERY_RETRY_MS', 60000);
    this.minWakeIntervalMs = opts.minWakeIntervalMs != null ? opts.minWakeIntervalMs : intEnv('CMUX_DASH_COLLAB_DELIVERY_MIN_WAKE_MS', 15000);
    this.wakeText = opts.wakeText || process.env.CMUX_DASH_COLLAB_WAKE_TEXT || DEFAULT_WAKE_TEXT;
    this.now = opts.now || (() => Date.now());
    this.logger = opts.logger || console;
    this.readUnread = opts.readUnreadWakeMessages || ((team) => readUnreadWakeMessages(team, opts));
    this.readStatus = opts.readDeliveryStatus || ((team, id) => readDeliveryStatus(team, id, opts));
    this.sendWake = opts.sendWake || ((row, text) => this.ctl.sendToSurface(row.wsRef, row.slotRefs.cdx, text));
    this.states = new Map();
    this.inFlight = false;
    this.timer = null;
  }

  start() {
    if (this.timer || this.intervalMs <= 0) return { started: false };
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        if (this.logger && this.logger.error) this.logger.error('collab delivery tick error', summarizeError(e));
      });
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return { started: true, intervalMs: this.intervalMs };
  }

  stop() {
    if (!this.timer) return { stopped: false };
    clearInterval(this.timer);
    this.timer = null;
    return { stopped: true };
  }

  forgetProject(id) {
    return this.states.delete(String(id));
  }

  stateFor(id) {
    const key = String(id);
    if (!this.states.has(key)) {
      this.states.set(key, {
        pending: new Map(),
        completed: new Set(),
        highWater: 0,
        sentHighWater: 0,
        lastWakeAt: 0,
        lastError: null,
      });
    }
    return this.states.get(key);
  }

  snapshot() {
    const projects = {};
    for (const [id, state] of this.states.entries()) {
      projects[id] = {
        pending: Array.from(state.pending.values()).map((p) => ({ ...p })),
        completed: Array.from(state.completed),
        highWater: state.highWater,
        sentHighWater: state.sentHighWater,
        lastWakeAt: state.lastWakeAt,
        lastError: state.lastError,
      };
    }
    return { inFlight: this.inFlight, projects };
  }

  async tick() {
    if (this.inFlight) return { skipped: 'in-flight' };
    this.inFlight = true;
    try {
      const state = await this.ctl.getState();
      const rows = [
        ...(Array.isArray(state.projects) ? state.projects : []),
        ...(Array.isArray(state.globalRows) ? state.globalRows : []),
      ];
      const results = [];
      for (const row of rows) {
        if (!isPaneDeliveryActiveProject(row)) {
          if (row && row.id) this.forgetProject(row.id);
          continue;
        }
        results.push(await this.processProject(row));
      }
      return { ok: true, results };
    } finally {
      this.inFlight = false;
    }
  }

  async processProject(row) {
    const projectState = this.stateFor(row.id);
    const team = row.team || this.ctl.teamName(row.id);
    try {
      const pending = Array.from(projectState.pending.values()).sort((a, b) => a.id - b.id);
      for (const item of pending) {
        const status = await this.readStatus(team, item.id);
        if (status.delivered) {
          this.markDelivered(projectState, item.id);
          continue;
        }
        if (this.now() >= item.nextRetryAt && this.canWake(projectState)) {
          return await this.deliver(row, item, 'retry');
        }
        return { id: row.id, pending: item.id, sent: false, reason: 'pending' };
      }

      const messages = await this.readUnread(team);
      for (const message of messages) {
        if (projectState.completed.has(message.id)) continue;
        const status = await this.readStatus(team, message.id);
        if (status.delivered) {
          this.markDelivered(projectState, message.id);
          continue;
        }
        if (!this.canWake(projectState)) {
          projectState.pending.set(message.id, this.pendingRecord(message, 0, projectState.lastWakeAt + this.minWakeIntervalMs));
          return { id: row.id, pending: message.id, sent: false, reason: 'rate-limited' };
        }
        return await this.deliver(row, message, 'new');
      }
      return { id: row.id, sent: false, reason: 'no-unread' };
    } catch (e) {
      projectState.lastError = summarizeError(e);
      return { id: row.id, sent: false, error: projectState.lastError };
    }
  }

  canWake(projectState) {
    return this.now() - (projectState.lastWakeAt || 0) >= this.minWakeIntervalMs;
  }

  pendingRecord(message, attempts, nextRetryAt) {
    return {
      id: Number(message.id) || 0,
      createdAt: message.createdAt || null,
      attempts,
      nextRetryAt,
      lastSentAt: attempts > 0 ? this.now() : null,
      lastError: null,
    };
  }

  async deliver(row, message, reason) {
    const projectState = this.stateFor(row.id);
    const current = projectState.pending.get(message.id) || this.pendingRecord(message, 0, this.now());
    const attempts = (Number(current.attempts) || 0) + 1;
    const pending = {
      ...current,
      attempts,
      nextRetryAt: this.now() + this.retryMs,
      lastSentAt: this.now(),
      lastError: null,
    };
    projectState.pending.set(message.id, pending);
    try {
      await this.sendWake(row, this.wakeText);
      projectState.lastWakeAt = this.now();
      projectState.sentHighWater = Math.max(projectState.sentHighWater || 0, message.id);
      projectState.lastError = null;
      return { id: row.id, messageId: message.id, sent: true, reason, attempts };
    } catch (e) {
      pending.lastError = summarizeError(e);
      projectState.lastError = pending.lastError;
      return { id: row.id, messageId: message.id, sent: false, reason, attempts, error: pending.lastError };
    }
  }

  markDelivered(projectState, messageId) {
    const id = Number(messageId) || 0;
    if (!id) return;
    projectState.pending.delete(id);
    projectState.completed.add(id);
    projectState.highWater = Math.max(projectState.highWater || 0, id);
  }
}

function createCollabDelivery(opts = {}) {
  return new CollabDelivery(opts);
}

module.exports = {
  DEFAULT_WAKE_TEXT,
  CollabDelivery,
  createCollabDelivery,
  isPaneDeliveryActiveProject,
  readDeliveryStatus,
  readUnreadWakeMessages,
  sqliteJson,
};
