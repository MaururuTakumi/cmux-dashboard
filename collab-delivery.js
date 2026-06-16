'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const ctl = require('./cmuxctl');

// Wake text injected into the codex TUI pane. Delivery uses ctl.submitToSurface,
// which sends the text as a paste and then a SEPARATE lone carriage return to
// actually submit it (codex has bracketed paste enabled, so a trailing \r in
// the same send is swallowed into the input box rather than submitting). Do NOT
// append \n / \r here — submitToSurface adds the submitting Enter itself.
const DEFAULT_WAKE_TEXT = '[cmux-dashboard] New message from claude in this project. In this same turn, do not stop after only reading: (1) run `agmsg inbox` to read it, (2) follow the collab protocol in CLAUDE.md — if it is a plan-agreed task, implement it and run the tests; if anything is ambiguous, unapproved, or irreversible, do NOT guess, (3) ALWAYS reply to claude with `agmsg send` — either a success report with the test evidence, or a concrete blocker/question.';
const DEFAULT_FRONT_DESK_TEAM = 'front-desk';
const DEFAULT_FRONT_DESK_AGENT = 'concierge';

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

function offValue(value) {
  return /^(0|false|no|off|disabled)$/i.test(String(value || '').trim());
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

async function readUnreadFrontDeskMessages(team, agent, opts = {}) {
  const normalizedTeam = (opts.teamName || ctl.teamName)(team || DEFAULT_FRONT_DESK_TEAM);
  const normalizedAgent = String(agent || DEFAULT_FRONT_DESK_AGENT).trim();
  const limit = boundedInt(opts.limit, 20, { min: 1, max: 200 });
  const sql = [
    'SELECT id, created_at AS createdAt, team, from_agent AS "from", to_agent AS "to", body, read_at AS readAt',
    'FROM messages',
    `WHERE team = ${sqlString(normalizedTeam)}`,
    `AND to_agent = ${sqlString(normalizedAgent)}`,
    `AND from_agent <> ${sqlString(normalizedAgent)}`,
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
    to: row.to || normalizedAgent,
    body: row.body == null ? '' : String(row.body),
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

async function readFrontDeskDeliveryStatus(team, agent, messageId, fromAgent, opts = {}) {
  const normalizedTeam = (opts.teamName || ctl.teamName)(team || DEFAULT_FRONT_DESK_TEAM);
  const normalizedAgent = String(agent || DEFAULT_FRONT_DESK_AGENT).trim();
  const from = String(fromAgent || '').trim();
  const id = boundedInt(messageId, 0, { min: 1 });
  if (!id) return { delivered: false, readAt: null, replyId: null, missing: true };
  const fromClause = from ? `AND m.from_agent = ${sqlString(from)}` : '';
  const sql = [
    'SELECT m.id, m.read_at AS readAt,',
    '(SELECT r.id FROM messages r',
    `WHERE r.team = ${sqlString(normalizedTeam)}`,
    `AND r.from_agent = ${sqlString(normalizedAgent)}`,
    'AND r.to_agent = m.from_agent',
    'AND r.id > m.id',
    'ORDER BY r.id ASC LIMIT 1) AS replyId',
    'FROM messages m',
    `WHERE m.team = ${sqlString(normalizedTeam)}`,
    `AND m.to_agent = ${sqlString(normalizedAgent)}`,
    `AND m.id = ${id}`,
    fromClause,
    'LIMIT 1;',
  ].filter(Boolean).join(' ');
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

function targetSurfaceRef(target) {
  return target && (
    target.surfaceRef ||
    target.ref ||
    (target.slotRefs && target.slotRefs.cdx) ||
    (target.cdx && target.cdx.surfaceRef) ||
    null
  );
}

function normalizedTeamName(ctlRef, id) {
  const fn = ctlRef && ctlRef.teamName ? ctlRef.teamName : ctl.teamName;
  return fn(id);
}

function projectDeliveryTarget(row, ctlRef = ctl) {
  if (!isPaneDeliveryActiveProject(row)) return null;
  return {
    key: String(row.id),
    id: row.id,
    projectId: row.id,
    type: 'project',
    team: row.team || normalizedTeamName(ctlRef, row.id),
    wsRef: row.wsRef,
    surfaceRef: row.slotRefs.cdx,
    slotRefs: row.slotRefs,
  };
}

function gridProjectDeliveryEnabled(row) {
  return !(row && row.collab && row.collab.enabled === false);
}

function gridColumnDeliveryTarget(column, grid, rowsById, ctlRef = ctl) {
  if (!column) return null;
  const projectId = String(column.projectId || column.id || '').trim();
  const wsRef = column.wsRef || (grid && grid.wsRef) || null;
  const cdxRef = (column.cdx && column.cdx.surfaceRef) || column.bottomSurfaceRef || null;
  if (!projectId) return null;
  const row = rowsById && rowsById.get(projectId) || null;
  if (!gridProjectDeliveryEnabled(row)) return null;
  const ccRef = (column.cc && column.cc.surfaceRef) || column.topSurfaceRef || null;
  return {
    key: projectId,
    id: projectId,
    projectId,
    columnId: column.columnId || projectId,
    type: 'grid-column',
    team: normalizedTeamName(ctlRef, projectId),
    wsRef,
    surfaceRef: cdxRef,
    process: column.cdx && column.cdx.process || null,
    cdxReady: column.cdx && column.cdx.cdxReady === true,
    slotRefs: { cc: ccRef, cdx: cdxRef },
  };
}

function pushTarget(targets, seen, target) {
  if (!target || !target.key || seen.has(target.key)) return;
  seen.add(target.key);
  targets.push(target);
}

function deliveryTargetsFromState(state, ctlRef = ctl) {
  const targets = [];
  const seen = new Set();
  const rows = [
    ...(Array.isArray(state && state.projects) ? state.projects : []),
    ...(Array.isArray(state && state.globalRows) ? state.globalRows : []),
  ];
  const rowsById = new Map();
  for (const row of rows) {
    if (row && row.id) rowsById.set(String(row.id), row);
  }

  const grid = state && state.grid || {};
  const columns = Array.isArray(grid.columns) ? grid.columns : [];
  const gridProjectIds = new Set(columns.map((column) => String(column && (column.projectId || column.id) || '').trim()).filter(Boolean));
  for (const row of rows) {
    if (row && row.id && gridProjectIds.has(String(row.id))) continue;
    pushTarget(targets, seen, projectDeliveryTarget(row, ctlRef));
  }
  for (const column of columns) {
    pushTarget(targets, seen, gridColumnDeliveryTarget(column, grid, rowsById, ctlRef));
  }
  return targets;
}

function frontDeskDeliveryTargetFromEnv(env = process.env, opts = {}) {
  if (opts.frontDeskEnabled === false) return null;
  const teamValue = opts.frontDeskTeam != null ? opts.frontDeskTeam : env.CMUX_DASH_FRONT_DESK_TEAM;
  // Opt-in: front-desk/concierge delivery only runs when a team is explicitly
  // configured. Defaulting it ON made the delivery loop ensure/await the concierge
  // surface every tick, which clogged the serial cmux chain (cmuxChain) and hung
  // /api/state (getState) for 30s+. With no explicit team, skip front-desk entirely.
  if (teamValue == null || String(teamValue).trim() === '') return null;
  const agentValue = opts.frontDeskAgent != null ? opts.frontDeskAgent : env.CMUX_DASH_FRONT_DESK_AGENT;
  const team = String(teamValue).trim();
  const agent = String(agentValue || DEFAULT_FRONT_DESK_AGENT).trim();
  if (!team || !agent || offValue(team) || offValue(agent)) return null;
  return {
    key: `front-desk:${team}:${agent}`,
    id: `${team}/${agent}`,
    type: 'front-desk',
    team,
    agent,
  };
}

function frontDeskWakeText(message, target = {}) {
  const team = target.team || message.team || DEFAULT_FRONT_DESK_TEAM;
  const agent = target.agent || message.to || DEFAULT_FRONT_DESK_AGENT;
  const from = String(message.from || '<from>').trim() || '<from>';
  const body = message.body == null ? '' : String(message.body);
  return [
    '[cmux-dashboard] front-desk message for concierge.',
    `team=${team} to=${agent} from=${from} message_id=${message.id}`,
    '',
    '本文全文:',
    body,
    '',
    `返信は agmsg send ${team} ${agent} ${from} "<返信本文>" を実行してください。`,
  ].join('\n');
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
    this.readFrontDesk = opts.readUnreadFrontDeskMessages || ((team, agent) => readUnreadFrontDeskMessages(team, agent, opts));
    this.readFrontDeskStatus = opts.readFrontDeskDeliveryStatus || ((team, agent, id, from) => readFrontDeskDeliveryStatus(team, agent, id, from, opts));
    this.sendWake = opts.sendWake || ((target, text) => this.ctl.submitToSurface(target.wsRef, targetSurfaceRef(target), text));
    this.sendFrontDeskWake = opts.sendFrontDeskWake || ((target, text) => this.defaultSendFrontDeskWake(target, text));
    this.frontDeskWakeText = opts.frontDeskWakeText || ((message, target) => frontDeskWakeText(message, target));
    this.frontDeskTargetFactory = opts.frontDeskTargetFactory || (() => frontDeskDeliveryTargetFromEnv(opts.env || process.env, opts));
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
    const projectId = String(id);
    let deleted = this.states.delete(projectId);
    for (const [key, state] of Array.from(this.states.entries())) {
      if (
        state &&
        (String(state.projectId || '') === projectId || String(state.id || '') === projectId)
      ) {
        this.states.delete(key);
        deleted = true;
      }
    }
    return deleted;
  }

  stateKeyFor(target) {
    if (target && typeof target === 'object' && target.type !== 'front-desk') {
      return String(target.projectId || target.id || target.key || '');
    }
    if (target && typeof target === 'object') return String(target.key || target.id || '');
    return String(target || '');
  }

  stateFor(target) {
    const key = this.stateKeyFor(target);
    if (!this.states.has(key)) {
      const meta = target && typeof target === 'object' ? target : { id: key, projectId: key, type: 'project' };
      this.states.set(key, {
        id: meta.id || key,
        projectId: meta.projectId || meta.id || key,
        type: meta.type || 'project',
        targetKey: key,
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

  pruneMissingTargets(seenKeys) {
    for (const key of Array.from(this.states.keys())) {
      if (!seenKeys.has(key)) this.states.delete(key);
    }
  }

  stateSnapshot(state) {
    return {
      pending: Array.from(state.pending.values()).map((p) => ({ ...p })),
      completed: Array.from(state.completed),
      highWater: state.highWater,
      sentHighWater: state.sentHighWater,
      lastWakeAt: state.lastWakeAt,
      lastError: state.lastError,
      targetKey: state.targetKey,
      targetType: state.type,
    };
  }

  snapshot() {
    const projects = {};
    const gridColumns = {};
    const frontDesk = {};
    const targets = {};
    for (const [id, state] of this.states.entries()) {
      const snap = this.stateSnapshot(state);
      targets[id] = snap;
      if (state.type === 'grid-column') gridColumns[id] = snap;
      else if (state.type === 'front-desk') frontDesk[state.id || id] = snap;
      else projects[state.projectId || state.id || id] = snap;
    }
    return { inFlight: this.inFlight, projects, gridColumns, frontDesk, targets };
  }

  async tick() {
    if (this.inFlight) return { skipped: 'in-flight' };
    this.inFlight = true;
    try {
      const state = await this.ctl.getState();
      const targets = deliveryTargetsFromState(state, this.ctl);
      const seen = new Set(targets.map((target) => target.key));
      pushTarget(targets, seen, this.frontDeskTarget());
      this.pruneMissingTargets(new Set(targets.map((target) => target.key)));
      const results = [];
      for (const target of targets) {
        results.push(await this.processTarget(target));
      }
      return { ok: true, results };
    } finally {
      this.inFlight = false;
    }
  }

  frontDeskTarget() {
    return this.frontDeskTargetFactory ? this.frontDeskTargetFactory() : null;
  }

  async processTarget(target) {
    const projectState = this.stateFor(target);
    const team = target.team || this.ctl.teamName(target.projectId || target.id);
    try {
      const targetError = this.targetReadinessError(target);
      if (targetError) {
        projectState.lastError = targetError;
        return { id: target.id, targetKey: target.key, targetType: target.type, sent: false, warning: targetError };
      }
      const pending = Array.from(projectState.pending.values()).sort((a, b) => a.id - b.id);
      for (const item of pending) {
        const status = await this.readStatusForTarget(target, item);
        if (status.delivered) {
          this.markDelivered(projectState, item.id);
          continue;
        }
        if (this.now() >= item.nextRetryAt && this.canWake(projectState)) {
          return await this.deliver(target, item, 'retry');
        }
        return { id: target.id, targetKey: target.key, targetType: target.type, pending: item.id, sent: false, reason: 'pending' };
      }

      const messages = await this.readUnreadForTarget(target, team);
      for (const message of messages) {
        if (projectState.completed.has(message.id)) continue;
        const status = await this.readStatusForTarget(target, message);
        if (status.delivered) {
          this.markDelivered(projectState, message.id);
          continue;
        }
        if (!this.canWake(projectState)) {
          projectState.pending.set(message.id, this.pendingRecord(message, 0, projectState.lastWakeAt + this.minWakeIntervalMs));
          return { id: target.id, targetKey: target.key, targetType: target.type, pending: message.id, sent: false, reason: 'rate-limited' };
        }
        return await this.deliver(target, message, 'new');
      }
      return { id: target.id, targetKey: target.key, targetType: target.type, sent: false, reason: 'no-unread' };
    } catch (e) {
      projectState.lastError = summarizeError(e);
      return { id: target.id, targetKey: target.key, targetType: target.type, sent: false, error: projectState.lastError };
    }
  }

  async readUnreadForTarget(target, team) {
    if (target && target.type === 'front-desk') return this.readFrontDesk(target.team, target.agent);
    return this.readUnread(team);
  }

  async readStatusForTarget(target, message) {
    const team = target.team || this.ctl.teamName(target.projectId || target.id);
    if (target && target.type === 'front-desk') {
      return this.readFrontDeskStatus(target.team, target.agent, message.id, message.from);
    }
    return this.readStatus(team, message.id);
  }

  wakeTextForTarget(target, message) {
    if (target && target.type === 'front-desk') return this.frontDeskWakeText(message, target);
    return this.wakeText;
  }

  async sendWakeForTarget(target, text) {
    if (target && target.type === 'front-desk') return this.sendFrontDeskWake(target, text);
    return this.sendWake(target, text);
  }

  async defaultSendFrontDeskWake(target, text) {
    if (!this.ctl.ensureGridWorkspace || !this.ctl.submitToSurface) {
      throw new Error('front-desk delivery requires ensureGridWorkspace and submitToSurface');
    }
    const wsRef = await this.ctl.ensureGridWorkspace();
    let ready = null;
    if (this.ctl.ensureConciergeReadySurface) {
      ready = await this.ctl.ensureConciergeReadySurface(wsRef);
    } else {
      if (!this.ctl.ensureConciergeSurface) throw new Error('front-desk delivery requires ensureConciergeSurface');
      const concierge = await this.ctl.ensureConciergeSurface(wsRef);
      if (this.ctl.waitForConciergeReady) ready = await this.ctl.waitForConciergeReady(wsRef, concierge);
      else ready = { ready: true, wsRef, surfaceRef: targetSurfaceRef(concierge), paneRef: concierge && concierge.paneRef || null };
    }
    const surfaceRef = targetSurfaceRef(ready);
    if (!ready || !ready.ready || !surfaceRef) {
      const suffix = ready && ready.timeoutMs ? ` after ${ready.timeoutMs}ms` : '';
      throw new Error(`concierge not ready${suffix}`);
    }
    await this.ctl.submitToSurface(ready.wsRef || wsRef, surfaceRef, text);
    return { ...ready, wsRef: ready.wsRef || wsRef, surfaceRef };
  }

  canWake(projectState) {
    return this.now() - (projectState.lastWakeAt || 0) >= this.minWakeIntervalMs;
  }

  targetReadinessError(target) {
    if (!target || target.type !== 'grid-column') return null;
    if (!target.wsRef || !targetSurfaceRef(target)) {
      return `grid-column delivery target missing canonical cdx surfaceRef/wsRef for project ${target.projectId || target.id || '<unknown>'}`;
    }
    if (target.process !== 'codex') {
      return `grid-column cdx surface is not a codex TUI for project ${target.projectId || target.id || '<unknown>'}: process=${target.process || 'unknown'}`;
    }
    return null;
  }

  pendingRecord(message, attempts, nextRetryAt) {
    return {
      id: Number(message.id) || 0,
      createdAt: message.createdAt || null,
      attempts,
      nextRetryAt,
      lastSentAt: attempts > 0 ? this.now() : null,
      lastError: null,
      from: message.from || null,
      to: message.to || null,
    };
  }

  async deliver(target, message, reason) {
    const projectState = this.stateFor(target);
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
      const deliveryInfo = await this.sendWakeForTarget(target, this.wakeTextForTarget(target, message));
      projectState.lastWakeAt = this.now();
      projectState.sentHighWater = Math.max(projectState.sentHighWater || 0, message.id);
      projectState.lastError = null;
      const result = { id: target.id, targetKey: target.key, targetType: target.type, messageId: message.id, sent: true, reason, attempts };
      if (deliveryInfo && deliveryInfo.repaired) result.repaired = true;
      return result;
    } catch (e) {
      pending.lastError = summarizeError(e);
      projectState.lastError = pending.lastError;
      return { id: target.id, targetKey: target.key, targetType: target.type, messageId: message.id, sent: false, reason, attempts, error: pending.lastError };
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
  DEFAULT_FRONT_DESK_AGENT,
  DEFAULT_FRONT_DESK_TEAM,
  createCollabDelivery,
  deliveryTargetsFromState,
  frontDeskDeliveryTargetFromEnv,
  frontDeskWakeText,
  gridColumnDeliveryTarget,
  isPaneDeliveryActiveProject,
  projectDeliveryTarget,
  readFrontDeskDeliveryStatus,
  readUnreadFrontDeskMessages,
  readDeliveryStatus,
  readUnreadWakeMessages,
  sqliteJson,
};
