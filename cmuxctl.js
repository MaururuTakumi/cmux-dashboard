'use strict';
// cmuxctl — cmux を CLI 経由で操作するコアライブラリ。
// 各プロジェクト = 1 workspace = 1 agmsg チーム。
// R1 rebuild: workspace 内の terminal surface を slot として扱う。
//   cc=claude, cdx=codex, yazi=yazi, term=shell
// workspace.description タグ "cmuxdash:<id>" で識別する。
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAG = 'cmuxdash:';
const GRID_ID = '__grid__';
const GRID_TAG = TAG + GRID_ID;
const GRID_MARK_PREFIX = `${TAG}grid:`;
const GRID_CONCIERGE_MARKER = `${GRID_MARK_PREFIX}${GRID_ID}:concierge`;
const GRID_RIGHT_ANCHOR_MARKER = `${GRID_MARK_PREFIX}${GRID_ID}:right-anchor`;
const DEFAULT_DASHBOARD_PORT = 7799;
const PROJECTS_FILE = process.env.CMUX_DASH_PROJECTS_FILE || path.join(__dirname, 'projects.json');
const PROJECTS_EXAMPLE_FILE = process.env.CMUX_DASH_PROJECTS_EXAMPLE_FILE || path.join(__dirname, 'projects.example.json');
const GRID_STATE_FILE = process.env.CMUX_DASH_GRID_STATE_FILE || path.join(__dirname, '.grid-state.json');
const AGMSG_DIR = path.join(os.homedir(), '.agents', 'skills', 'agmsg');
const AGMSG_SCRIPTS = path.join(AGMSG_DIR, 'scripts');
const COLLAB_SKILL_DIR = path.join(os.homedir(), '.claude', 'skills', 'claude-codex-collab');
const DEFAULT_COLLAB = true;
const CMUX_CONTEXT_ENV_KEYS = [
  'CMUX_WORKSPACE_ID',
  'CMUX_TAB_ID',
  'CMUX_PANEL_ID',
  'CMUX_SURFACE_ID',
  'CMUX_PORT',
  'CMUX_PORT_END',
  'CMUX_SOCKET',
  'CMUX_SOCKET_PATH',
  'CMUX_CLAUDE_PID',
];

// ---- バイナリ解決 ----
function firstExisting(cands, fallback) {
  for (const c of cands.filter(Boolean)) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return fallback;
}
// NOTE: app-bundle の bin を最優先。Homebrew の /opt/homebrew/bin/cmux は
// dist/main.js への symlink で、execFile 経由だと electron を要求して落ちる。
const CMUX = firstExisting([
  process.env.CMUX_BIN,
  '/Applications/cmux.app/Contents/Resources/bin/cmux',
  '/usr/local/bin/cmux', '/opt/homebrew/bin/cmux',
], 'cmux');

function buildCmuxEnv(base = process.env) {
  const env = { ...base };
  for (const key of CMUX_CONTEXT_ENV_KEYS) delete env[key];
  env.CMUX_QUIET = '1';
  return env;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const CMUX_DASH_PROJECTS_ROOT_INPUT = process.env.CMUX_DASH_PROJECTS_ROOT || '~/projects';
const CMUX_DASH_PROJECTS_ROOT = path.resolve(expandHome(CMUX_DASH_PROJECTS_ROOT_INPUT));

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function pathInsideOrEqual(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function accessOk(dir, mode = fs.constants.W_OK | fs.constants.X_OK) {
  try {
    fs.accessSync(dir, mode);
    return true;
  } catch (_) {
    return false;
  }
}

function safeStat(target) {
  try { return fs.statSync(target); } catch (_) { return null; }
}

function existingWritableDir(target) {
  const st = safeStat(target);
  return !!(st && st.isDirectory() && accessOk(target));
}

function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  while (true) {
    const st = safeStat(current);
    if (st) return { path: current, stat: st };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function canCreateProjectDir(target) {
  const ancestor = nearestExistingAncestor(path.dirname(path.resolve(target)));
  return !!(ancestor && ancestor.stat && ancestor.stat.isDirectory() && accessOk(ancestor.path));
}

function slugForProjectDir(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || ('proj-' + process.pid);
}

function defaultProjectPath(id) {
  return path.join(CMUX_DASH_PROJECTS_ROOT_INPUT, slugForProjectDir(id));
}

function safeProjectDir(id, originalPath) {
  const raw = id || path.basename(path.resolve(expandHome(originalPath || '') || 'project'));
  return path.join(CMUX_DASH_PROJECTS_ROOT, slugForProjectDir(raw));
}

function toHomeDisplayPath(resolved) {
  const home = path.resolve(os.homedir());
  const homeReal = realpathOrResolved(home);
  const target = path.resolve(resolved);
  const targetReal = realpathOrResolved(target);
  const base = pathInsideOrEqual(target, home) ? home : (pathInsideOrEqual(targetReal, homeReal) ? homeReal : null);
  const value = base === homeReal ? targetReal : target;
  if (base) {
    const rel = path.relative(base, value);
    return rel ? path.join('~', rel) : '~';
  }
  return targetReal;
}

function projectDirUsability(resolved) {
  const st = safeStat(resolved);
  if (st) {
    if (!st.isDirectory()) return { ok: false, reason: 'project path exists but is not a directory' };
    if (!accessOk(resolved)) return { ok: false, reason: 'project path is not writable' };
    return { ok: true };
  }

  const slashProjects = path.resolve('/projects');
  if (
    pathInsideOrEqual(resolved, slashProjects) &&
    !pathInsideOrEqual(CMUX_DASH_PROJECTS_ROOT, slashProjects)
  ) {
    return { ok: false, reason: '/projects is not a managed writable project root on this machine' };
  }

  if (pathInsideOrEqual(resolved, os.homedir()) || pathInsideOrEqual(resolved, CMUX_DASH_PROJECTS_ROOT)) {
    return { ok: true };
  }
  if (canCreateProjectDir(resolved)) return { ok: true };
  return { ok: false, reason: 'project path cannot be created from a writable parent' };
}

function projectDirErrorMessage(target, errors = []) {
  const details = errors
    .filter(Boolean)
    .map((e) => summarizeError(e))
    .filter(Boolean)
    .join('; ');
  return [
    `Could not create a project directory at ${target}.`,
    `Set CMUX_DASH_PROJECTS_ROOT to a writable folder, or choose a path under ${toHomeDisplayPath(CMUX_DASH_PROJECTS_ROOT)}.`,
    details ? `Details: ${details}` : '',
  ].filter(Boolean).join(' ');
}

function realpathOrResolved(target) {
  try { return fs.realpathSync(target); } catch (_) { return path.resolve(target); }
}

function remapFields(info = {}) {
  return info.remappedFrom ? {
    remappedFrom: info.remappedFrom,
    remappedTo: info.remappedTo || info.dir,
  } : {};
}

function withRemapFields(result, info = {}) {
  return { ...(result || {}), ...remapFields(info) };
}

function resolveProjectDirInput(inputPath, opts = {}) {
  const fallback = opts.fallback || process.cwd();
  const expanded = expandHome(inputPath || fallback);
  if (!expanded) throw new Error('project path is required');
  const original = path.resolve(expanded);
  const allowRemap = opts.allowRemap !== false && opts.kind !== 'global';
  let dir = original;
  let remappedFrom = null;
  let remappedTo = null;
  let remapReason = null;

  if (allowRemap) {
    const usability = projectDirUsability(original);
    if (!usability.ok) {
      remappedFrom = original;
      dir = safeProjectDir(opts.id || opts.name, original);
      remappedTo = dir;
      remapReason = usability.reason;
    }
  }

  if (opts.create) {
    const errors = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      errors.push(e);
      if (allowRemap && !remappedFrom) {
        remappedFrom = original;
        dir = safeProjectDir(opts.id || opts.name, original);
        remappedTo = dir;
        remapReason = 'mkdir failed at requested path';
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (fallbackErr) {
          errors.push(fallbackErr);
          throw new Error(projectDirErrorMessage(dir, errors));
        }
      } else {
        throw new Error(projectDirErrorMessage(dir, errors));
      }
    }
    if (!existingWritableDir(dir)) {
      throw new Error(projectDirErrorMessage(dir, [`${dir} is not a writable directory after creation`]));
    }
  }

  const finalDir = path.resolve(dir);
  return {
    dir: finalDir,
    cwd: finalDir,
    input: inputPath || fallback,
    resolved: original,
    remappedFrom,
    remappedTo: remappedFrom ? path.resolve(remappedTo || dir) : null,
    remapReason,
  };
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { env, ...execOpts } = opts;
    execFile(bin, args, {
      env: env || { ...process.env, CMUX_QUIET: '1' },
      maxBuffer: 8 * 1024 * 1024,
      ...execOpts,
    },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error((stderr || stdout || err.message).toString().trim());
          e.code = err.code;
          e.signal = err.signal;
          e.killed = err.killed;
          e.timedOut = err.killed && err.signal === 'SIGKILL';
          return reject(e);
        }
        resolve((stdout || '').toString().trim());
      });
  });
}

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// cmux の Unix ソケットは同時接続やパネル生成中のビジー状態で "Broken pipe" を返すため、
// (1) 全 cmux 呼び出しを直列化し、(2) 一過性のソケットエラーを長めの指数バックオフで再試行する。
let cmuxChain = Promise.resolve();
let lastWorkspaces = [];
let lastWorkspacesAt = null;
function isTransient(err) {
  const msg = typeof err === 'string' ? err : (err && err.message) || '';
  const code = typeof err === 'object' && err ? String(err.code || '') : '';
  const signal = typeof err === 'object' && err ? String(err.signal || '') : '';
  return !!(err && err.timedOut)
    || /broken pipe|EPIPE|errno 32|socket|ECONNRESET|ETIMEDOUT|EAGAIN|ENOMEM|timeout|timed out|SIGKILL/i.test(`${msg} ${code} ${signal}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CMUX_TIMEOUT = intEnv('CMUX_DASH_TIMEOUT', 20000);
const CMUX_RETRIES = intEnv('CMUX_DASH_RETRIES', 9);
const CMUX_RETRY_BUDGET = intEnv('CMUX_DASH_RETRY_BUDGET_MS', 20000);
const CMUX_READ_TIMEOUT = intEnv('CMUX_DASH_READ_TIMEOUT', 2500);
const CMUX_READ_RETRIES = intEnv('CMUX_DASH_READ_RETRIES', 2);
const CMUX_READ_RETRY_BUDGET = intEnv('CMUX_DASH_READ_RETRY_BUDGET_MS', 4200);
const CMUX_BACKOFF_BASE = intEnv('CMUX_DASH_BACKOFF_BASE_MS', 250);
const CMUX_BACKOFF_CAP = intEnv('CMUX_DASH_BACKOFF_CAP_MS', 3000);
const CMUX_BACKOFF_JITTER = Math.max(0, Math.min(1, Number(process.env.CMUX_DASH_BACKOFF_JITTER || 0.25) || 0));
const CMUX_SETTLE_MS = intEnv('CMUX_DASH_SETTLE_MS', 750);
const CMUX_OPENALL_GAP_MS = intEnv('CMUX_DASH_OPENALL_GAP_MS', 750);
const CMUX_HEALTH_FAILURE_THRESHOLD = intEnv('CMUX_DASH_HEALTH_FAILURE_THRESHOLD', 5);
const AWAITING_SCREEN_LINES = intEnv('CMUX_DASH_AWAITING_SCREEN_LINES', 40);
const AWAITING_READ_TIMEOUT_MS = intEnv('CMUX_DASH_AWAITING_READ_TIMEOUT_MS', 900);
const AWAITING_READ_TTL_MS = intEnv('CMUX_DASH_AWAITING_READ_TTL_MS', 1800);
const PROCESS_CWD_TTL_MS = intEnv('CMUX_DASH_PROCESS_CWD_TTL_MS', 5000);
const GRID_CONCIERGE_READY_TIMEOUT_MAX_MS = 20000;
const GRID_CONCIERGE_READY_TIMEOUT_DEFAULT_MS = 20000;
const GRID_CONCIERGE_READY_POLL_DEFAULT_MS = 1000;

function createCmuxHealthTracker(threshold = CMUX_HEALTH_FAILURE_THRESHOLD) {
  const state = {
    consecutiveFailures: 0,
    unhealthy: false,
    threshold: Math.max(1, Number.isFinite(threshold) ? threshold : 5),
    lastFailureAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  return {
    recordSuccess() {
      state.consecutiveFailures = 0;
      state.unhealthy = false;
      state.lastSuccessAt = new Date().toISOString();
      return this.snapshot();
    },
    recordFailure(err) {
      state.consecutiveFailures += 1;
      state.lastFailureAt = new Date().toISOString();
      state.lastError = summarizeError(err);
      if (state.consecutiveFailures >= state.threshold) state.unhealthy = true;
      return this.snapshot();
    },
    snapshot() {
      return {
        ok: !state.unhealthy && state.consecutiveFailures === 0,
        unhealthy: state.unhealthy,
        consecutiveFailures: state.consecutiveFailures,
        threshold: state.threshold,
        lastFailureAt: state.lastFailureAt,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
      };
    },
  };
}
const cmuxHealth = createCmuxHealthTracker();

function retryDelay(attempt, opts = {}) {
  const base = opts.backoffBase || CMUX_BACKOFF_BASE;
  const cap = opts.backoffCap || CMUX_BACKOFF_CAP;
  const raw = Math.min(cap, base * Math.pow(2, attempt));
  const spread = raw * CMUX_BACKOFF_JITTER;
  return Math.max(0, Math.round(raw - spread + Math.random() * spread * 2));
}
function cmuxRetryOptions(opts = {}) {
  return {
    timeout: opts.timeout || CMUX_TIMEOUT,
    retries: opts.retries != null ? opts.retries : CMUX_RETRIES,
    retryBudget: opts.retryBudget || CMUX_RETRY_BUDGET,
    backoffBase: opts.backoffBase || CMUX_BACKOFF_BASE,
    backoffCap: opts.backoffCap || CMUX_BACKOFF_CAP,
  };
}
function cmux(args, opts = {}) {
  const task = async () => {
    const retry = cmuxRetryOptions(opts);
    let lastErr;
    const started = Date.now();
    const deadline = started + retry.retryBudget;
    for (let i = 0; i <= retry.retries; i++) {
      const remaining = Math.max(1, deadline - Date.now());
      const timeout = Math.max(1, Math.min(retry.timeout, remaining));
      const execOpts = { timeout, killSignal: 'SIGKILL', env: buildCmuxEnv() };
      try { return await run(CMUX, args, execOpts); }
      catch (e) {
        lastErr = e;
        if (!isTransient(e) || i === retry.retries || Date.now() >= deadline) {
          e.message = `${e.message} (cmux args: ${args.join(' ')}, attempts: ${i + 1}, budgetMs: ${retry.retryBudget})`;
          throw e;
        }
        await sleep(Math.min(retryDelay(i, retry), Math.max(0, deadline - Date.now())));
      }
    }
    throw lastErr;
  };
  const next = cmuxChain.then(task, task); // 直前の成否に関わらず直列実行
  cmuxChain = next.catch(() => {});
  return next;
}
async function cmuxJson(args, opts) {
  const out = await cmux([...args, '--json'], opts);
  const i = out.indexOf('{');
  return JSON.parse(i >= 0 ? out.slice(i) : out);
}
async function settle(ms = CMUX_SETTLE_MS) {
  if (ms > 0) await sleep(ms);
}

const awaitingScreenCache = new Map();

function awaitingCacheKey(wsRef, surfaceRef, lines) {
  return [cleanRef(wsRef) || '', cleanRef(surfaceRef) || '', Number(lines) || AWAITING_SCREEN_LINES].join('|');
}

async function readSurfaceScreen(wsRef, surfaceRef, opts = {}) {
  const ref = cleanRef(surfaceRef);
  if (!ref) return null;
  const lines = Math.max(1, Number(opts.lines) || AWAITING_SCREEN_LINES);
  const key = awaitingCacheKey(wsRef, ref, lines);
  const now = Date.now();
  const cached = awaitingScreenCache.get(key);
  if (cached && cached.expiresAt > now && Object.prototype.hasOwnProperty.call(cached, 'value')) {
    return cached.value;
  }
  if (cached && cached.promise) return cached.promise;

  const args = ['read-screen', '--surface', ref, '--lines', String(lines)];
  const workspace = cleanRef(wsRef);
  if (workspace) args.splice(1, 0, '--workspace', workspace);
  const promise = run(CMUX, args, {
    timeout: Math.max(1, Number(opts.timeout) || AWAITING_READ_TIMEOUT_MS),
    killSignal: 'SIGKILL',
    env: buildCmuxEnv(),
  })
    .then((out) => out || '')
    .catch(() => null)
    .then((value) => {
      awaitingScreenCache.set(key, {
        value,
        expiresAt: Date.now() + Math.max(1, Number(opts.ttlMs) || AWAITING_READ_TTL_MS),
      });
      return value;
    });
  awaitingScreenCache.set(key, { promise, expiresAt: now + Math.max(1, AWAITING_READ_TTL_MS) });
  return promise;
}

function screenHasNumberedChoices(text) {
  return /(?:^|\n)\s*(?:❯\s*)?\d+[.)]\s+\S/m.test(text);
}

function classifyClaudeApproval(text) {
  const context = /\b(?:do you want to proceed|do you want to make this edit|permission|tool use|allow|approve)\b/i.test(text);
  const yesChoice = /(?:^|\n)\s*(?:❯\s*)?\d+[.)]\s+(?:yes|allow|approve)\b/i.test(text);
  const yesNoShape = /(?:^|\n)\s*\d+[.)]\s+yes\b[\s\S]*(?:^|\n)\s*\d+[.)]\s+no\b/im.test(text)
    || /(?:^|\n)\s*\d+[.)]\s+yes,\s*and\s+don't\s+ask\s+again\b/im.test(text)
    || /\b(?:allow|approve)\b/i.test(text);
  return context && yesChoice && yesNoShape;
}

function classifyInputAwaiting(text) {
  if (screenHasNumberedChoices(text)) return false;
  const hasPromptLine = /(?:^|\n)[ \t]*❯[ \t]*(?:\n|$)/.test(text);
  const hasFooter = /\b(?:auto mode on|\? for shortcuts)\b/i.test(text);
  const hasBox = /[─━]{5,}[\s\S]*❯[\s\S]*[─━]{5,}/.test(text);
  return hasPromptLine && hasFooter && hasBox;
}

function classifyAwaiting(screenText, role) {
  const text = String(screenText || '').slice(-12000);
  if (!text.trim()) return null;
  if (/\b(?:thinking|gesticulating|esc to interrupt)\b/i.test(text)) return null;
  const normalizedRole = String(role || '').toLowerCase();
  if ((normalizedRole === 'cc' || normalizedRole === 'concierge') && classifyClaudeApproval(text)) {
    return 'approval';
  }
  if (classifyInputAwaiting(text)) return 'input';
  return null;
}

// ---- agmsg ----
function agmsgAvailable() {
  try { return fs.existsSync(path.join(AGMSG_SCRIPTS, 'join.sh')); } catch (_) { return false; }
}
function agmsgScript(name) { return path.join(AGMSG_SCRIPTS, name); }
async function agmsgRun(script, args) {
  return run('/bin/bash', [agmsgScript(script), ...args]);
}
// チーム名は英数字とハイフンに正規化（agmsg のディレクトリ名になるため）
function teamName(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '-'); }

// ---- doctor / onboarding ----
const DOCTOR_FIX_HINTS = {
  cmux: 'https://cmux.com',
  agmsg: 'bash <(curl -fsSL https://raw.githubusercontent.com/fujibee/agmsg/main/setup.sh) --cmd agmsg',
  claude: 'https://claude.com/claude-code',
  codex: 'Install Codex CLI and ensure codex is on PATH.',
  app: './install-app.sh',
};

function summarizeError(err) {
  const raw = typeof err === 'string' ? err : (err && err.message) || String(err || 'unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown error';
}

const TOP_KINDS = new Set(['total', 'window', 'workspace', 'pane', 'surface', 'process']);
const PROCESS_TYPES = ['C', 'M', 'X', 'O'];
const PROCESS_TYPE_LABELS = {
  C: 'Claude',
  M: 'MCP',
  X: 'Codex',
  O: 'Other',
};

function parseMetricNumber(value, fallback = 0) {
  const n = Number.parseFloat(String(value || '').replace(/[,_]/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : fallback;
}

function parseMetricInteger(value, fallback = 0) {
  const n = Number.parseInt(String(value || '').replace(/[,_]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseTop(tsvText) {
  const rows = [];
  for (const line of String(tsvText || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const kind = String(cols[3] || '').trim();
    if (!TOP_KINDS.has(kind)) continue;
    rows.push({
      cpu: parseMetricNumber(cols[0]),
      rssBytes: parseMetricInteger(cols[1]),
      procCount: parseMetricInteger(cols[2]),
      kind,
      ref: String(cols[4] || '').trim(),
      parentRef: String(cols[5] || '').trim() || null,
      title: cols.slice(6).join('\t'),
      command: cols.slice(6).join('\t'),
    });
  }
  return rows;
}

const BYTE_UNITS = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

function parseBytesInText(text) {
  const match = String(text || '').match(/([0-9][0-9,_]*(?:\.[0-9]+)?)\s*(tib|gib|mib|kib|tb|gb|mb|kb|bytes?|b)\b/i);
  if (!match) return null;
  const value = parseMetricNumber(match[1], null);
  if (value == null) return null;
  const unit = String(match[2] || 'b').toLowerCase();
  const mult = BYTE_UNITS[unit] || 1;
  return Math.round(value * mult);
}

function parseMemory(text) {
  const result = { footprint: null, childRss: null, groups: [] };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    const bytes = parseBytesInText(line);
    if (bytes == null) continue;

    if (/footprint/.test(lower)) {
      result.footprint = bytes;
      continue;
    }
    if ((/(child|children|子)/.test(lower) && /(rss|resident)/.test(lower))
      || (/(rss|resident)/.test(lower) && /(total|合計)/.test(lower) && result.childRss == null)) {
      result.childRss = bytes;
      continue;
    }

    const group = line.match(/^(?:[-*]\s*)?([^:：]+)[:：]\s*(.+)$/);
    if (group) {
      result.groups.push({ name: group[1].trim(), rssBytes: bytes });
    }
  }
  return result;
}

function classifyProcess(command, fullCommand = '') {
  const text = `${command || ''} ${fullCommand || ''}`.toLowerCase();
  if (/\bcodex\b|codex-cli|openai[^\n]*codex/.test(text)) return 'X';
  if (/\bclaude\b|claude-code|anthropic|(?:^|[\s/])\d+\.\d+\.\d+(?:\s|$)/.test(text)) return 'C';
  if (/\bmcp\b|modelcontextprotocol|model-context-protocol|mcp-server|server-mcp/.test(text)) return 'M';
  return 'O';
}

function pathExecutables(binName) {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, binName));
}

function doctorCandidates(binName, envVar, overrideVar, known = []) {
  if (process.env[overrideVar] != null) {
    return String(process.env[overrideVar])
      .split(path.delimiter)
      .map((p) => expandHome(p.trim()))
      .filter(Boolean);
  }
  return [process.env[envVar], ...pathExecutables(binName), ...known]
    .map((p) => expandHome(p))
    .filter(Boolean);
}

function firstExistingExpanded(cands) {
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function resolveDoctorBin(binName, envVar, overrideVar, known = []) {
  return firstExistingExpanded(doctorCandidates(binName, envVar, overrideVar, known));
}

function commandCheck(name, binName, envVar, overrideVar, known = []) {
  const found = resolveDoctorBin(binName, envVar, overrideVar, known);
  return {
    name,
    ok: !!found,
    detail: found || 'not found in PATH/candidates',
    fixHint: DOCTOR_FIX_HINTS[name],
  };
}

async function safeDoctorCheck(name, fn) {
  try {
    const check = await fn();
    return {
      name,
      ok: !!check.ok,
      detail: String(check.detail || ''),
      fixHint: check.fixHint === undefined ? (DOCTOR_FIX_HINTS[name] || null) : check.fixHint,
    };
  } catch (e) {
    return { name, ok: false, detail: summarizeError(e), fixHint: DOCTOR_FIX_HINTS[name] || null };
  }
}

async function doctor() {
  const checks = [];
  checks.push(await safeDoctorCheck('node', async () => ({
    ok: true,
    detail: process.version,
    fixHint: null,
  })));
  checks.push(await safeDoctorCheck('cmux', async () => {
    try {
      await cmux(['ping'], {
        timeout: intEnv('CMUX_DASH_DOCTOR_TIMEOUT', 2500),
        retries: intEnv('CMUX_DASH_DOCTOR_RETRIES', 0),
        retryBudget: intEnv('CMUX_DASH_DOCTOR_RETRY_BUDGET_MS', 2500),
        backoffBase: 100,
        backoffCap: 250,
      });
      cmuxHealth.recordSuccess();
    } catch (e) {
      cmuxHealth.recordFailure(e);
      throw e;
    }
    return { ok: true, detail: 'reachable (ping ok)', fixHint: DOCTOR_FIX_HINTS.cmux };
  }));
  checks.push(await safeDoctorCheck('agmsg', async () => ({
    ok: agmsgAvailable(),
    detail: agmsgAvailable() ? 'installed' : 'join.sh not found',
    fixHint: DOCTOR_FIX_HINTS.agmsg,
  })));
  checks.push(await safeDoctorCheck('claude', async () => commandCheck('claude', 'claude', 'CLAUDE_BIN', 'CMUX_DASH_DOCTOR_CLAUDE_CANDIDATES', [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '~/.claude/local/claude',
  ])));
  checks.push(await safeDoctorCheck('codex', async () => commandCheck('codex', 'codex', 'CODEX_BIN', 'CMUX_DASH_DOCTOR_CODEX_CANDIDATES', [
    '~/.local/bin/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ])));
  checks.push(await safeDoctorCheck('app', async () => {
    const appPath = '/Applications/cmux Dashboard.app';
    return {
      ok: fs.existsSync(appPath),
      detail: fs.existsSync(appPath) ? appPath : 'not installed in /Applications',
      fixHint: DOCTOR_FIX_HINTS.app,
    };
  }));
  return { checks, allOk: checks.every((c) => c.ok === true) };
}

const AGMSG_BODY_LIMIT = intEnv('CMUX_DASH_AGMSG_BODY_LIMIT', 4000);

async function agmsgDbPath() {
  const storage = path.join(AGMSG_SCRIPTS, 'lib', 'storage.sh');
  if (!fs.existsSync(storage)) throw new Error('agmsg storage.sh not found');
  return run('/bin/bash', ['-lc', 'source "$1"; agmsg_db_path', 'agmsg-db-path', storage]);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function boundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

function truncateBody(body) {
  const text = String(body || '');
  if (text.length <= AGMSG_BODY_LIMIT) return { body: text, truncated: false };
  return { body: text.slice(0, AGMSG_BODY_LIMIT), truncated: true };
}

async function getTeamMessages(team, { since = 0, limit = 50 } = {}) {
  const normalizedTeam = teamName(team);
  const minId = boundedInt(since, 0, { min: 0 });
  const maxRows = boundedInt(limit, 50, { min: 1, max: 200 });
  try {
    const db = await agmsgDbPath();
    if (!db || !fs.existsSync(db)) {
      return { team: normalizedTeam, messages: [], lastId: minId, error: 'agmsg DB not found' };
    }
    const sql = [
      'SELECT id, created_at AS at, from_agent AS "from", to_agent AS "to", body',
      'FROM messages',
      `WHERE team = ${sqlString(normalizedTeam)} AND id > ${minId}`,
      'ORDER BY id DESC',
      `LIMIT ${maxRows};`,
    ].join(' ');
    const out = await run('sqlite3', ['-readonly', '-json', db, sql]);
    const rows = out ? JSON.parse(out) : [];
    const messages = rows.reverse().map((row) => {
      const body = truncateBody(row.body);
      return {
        id: Number(row.id) || 0,
        at: row.at || null,
        from: row.from || '',
        to: row.to || '',
        body: body.body,
        truncated: body.truncated,
      };
    });
    const lastId = messages.length ? messages[messages.length - 1].id : minId;
    return { team: normalizedTeam, messages, lastId };
  } catch (e) {
    return { team: normalizedTeam, messages: [], lastId: minId, error: e.message };
  }
}

// プロジェクトを agmsg チームとしてセットアップ（claude=monitor, codex=turn）
async function agmsgSetup(proj, ag) {
  if (!agmsgAvailable() || ag.enabled === false) return { ok: false, skipped: true };
  const team = teamName(proj.id);
  const pp = expandHome(proj.path);
  const results = {};
  try {
    await agmsgRun('join.sh', [team, ag.claudeName, 'claude-code', pp]);
    await agmsgRun('join.sh', [team, ag.codexName, 'codex', pp]);
    // delivery hooks をプロジェクトに書き込む（claude 起動前に必要）
    await agmsgRun('delivery.sh', ['set', ag.claudeMode || 'monitor', 'claude-code', pp]).catch(() => {});
    await agmsgRun('delivery.sh', ['set', ag.codexMode || 'turn', 'codex', pp]).catch(() => {});
    results.ok = true; results.team = team;
  } catch (e) {
    results.ok = false; results.error = e.message;
  }
  return results;
}

// ---- projects.json ----
const DEFAULT_AGMSG = {
  enabled: true,
  claudeName: 'claude',
  codexName: 'codex',
  claudeMode: 'monitor',
  codexMode: 'turn',
  brief: false,
};
const DEFAULT_CLAUDE_MD = {
  mode: 'managed-block',
  templatePath: 'templates/CLAUDE.md',
};
const DEFAULT_BRIEFING =
  '【役割分担 / 厳守】あなた=claude は「plan・設計・指示」レイヤー。実際のコード実装は基本あなたが書かず、agmsg でチームメイト codex（下ペイン=作業レイヤー）に委譲する。' +
  ' 流れ: ①やることを宣言→②タスクを分解→③ /agmsg send codex <具体的な実装指示。必ずテストまで実行して結果を返すよう明記> で依頼→④ /agmsg で結果を受け取りレビュー→⑤テスト未実施なら差し戻し、OKなら次へ。' +
  ' codex は「実装＋テスト実行」までが1セット。テストが通った証跡なしに完了としない。あなたは舵取りとレビューに集中して。';

const SLOT_ORDER = ['cc', 'cdx', 'yazi', 'term'];
const SLOT_DEFS = {
  cc: { label: 'CC', role: 'claude', defaultCommand: 'claude --enable-auto-mode', processRe: /\bclaude\b/i },
  // User-authorized (2026-06-08): codex launches in auto-approve mode so the
  // collab delivery can wake it to read agmsg inbox, implement, and reply
  // without per-command approval. Same trust level as the headless collab path.
  // Override per-project via projects.json bottomCmd / slotCommands.cdx.
  cdx: { label: 'Cdx', role: 'codex', defaultCommand: 'codex --dangerously-bypass-approvals-and-sandbox', processRe: /\bcodex\b/i },
  yazi: { label: 'Yazi', role: 'yazi', defaultCommand: 'yazi', processRe: /\byazi\b/i },
  term: { label: 'Term', role: 'shell', defaultCommand: '', processRe: /\b(zsh|bash|fish|sh|nu)\b/i },
};
const SLOT_MARK_PREFIX = 'cmuxdash:slot:';

const CLAUDE_MD_MODES = new Set(['off', 'create-if-missing', 'managed-block']);
const CLAUDE_MD_BLOCK_RE = /<!--\s*cmux-dashboard:managed:start\b[\s\S]*?<!--\s*cmux-dashboard:managed:end\s*-->/;

function normalizeClaudeMdConfig(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  const mode = CLAUDE_MD_MODES.has(src.mode) ? src.mode : DEFAULT_CLAUDE_MD.mode;
  const templatePath = typeof src.templatePath === 'string' && src.templatePath.trim()
    ? src.templatePath
    : DEFAULT_CLAUDE_MD.templatePath;
  return { mode, templatePath };
}

function resolveClaudeMdConfig(project, cfg = {}) {
  return normalizeClaudeMdConfig({
    ...(cfg.defaults && cfg.defaults.claudeMd ? cfg.defaults.claudeMd : {}),
    ...(project && project.claudeMd ? project.claudeMd : {}),
  });
}

function ensureProjectsFile() {
  if (fs.existsSync(PROJECTS_FILE)) return;
  if (!fs.existsSync(PROJECTS_EXAMPLE_FILE)) {
    throw new Error(`projects config not found: ${PROJECTS_FILE}; example missing: ${PROJECTS_EXAMPLE_FILE}`);
  }
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
  fs.copyFileSync(PROJECTS_EXAMPLE_FILE, PROJECTS_FILE);
}

function loadConfig() {
  ensureProjectsFile();
  const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  raw.defaults = raw.defaults || {};
  raw.defaults.topCmd = raw.defaults.topCmd || 'claude --enable-auto-mode';
  raw.defaults.bottomCmd = raw.defaults.bottomCmd || 'codex';
  raw.defaults.slotCommands = {
    cc: raw.defaults.topCmd,
    cdx: raw.defaults.bottomCmd,
    yazi: raw.defaults.yaziCmd || SLOT_DEFS.yazi.defaultCommand,
    term: raw.defaults.termCmd || SLOT_DEFS.term.defaultCommand,
    ...(raw.defaults.slotCommands || {}),
  };
  raw.defaults.agmsg = { ...DEFAULT_AGMSG, ...(raw.defaults.agmsg || {}) };
  raw.defaults.claudeMd = normalizeClaudeMdConfig(raw.defaults.claudeMd);
  raw.defaults.collab = normalizeCollabSetting(raw.defaults.collab, DEFAULT_COLLAB);
  raw.defaults.briefing = raw.defaults.briefing || DEFAULT_BRIEFING;
  raw.projects = raw.projects || [];
  return raw;
}
function saveConfig(cfg) {
  const out = {
    _comment: cfg._comment,
    defaults: cfg.defaults,
    projects: cfg.projects,
  };
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(out, null, 2) + '\n');
}

function projectKind(project = {}) {
  return project.kind === 'global' ? 'global' : 'project';
}

function isGlobalProject(project = {}) {
  return projectKind(project) === 'global';
}

function configuredRows(cfg = {}) {
  return Array.isArray(cfg.projects) ? cfg.projects : [];
}

function configuredProjectRows(cfg = {}) {
  return configuredRows(cfg).filter((p) => !isGlobalProject(p));
}

function configuredGlobalRows(cfg = {}) {
  return configuredRows(cfg).filter((p) => isGlobalProject(p));
}

function findConfiguredRow(cfg, id) {
  return configuredRows(cfg).find((p) => p && p.id === id);
}

function rowCwdInfo(project = {}, opts = {}) {
  const fallback = isGlobalProject(project) ? os.homedir() : process.cwd();
  return resolveProjectDirInput(project.path || fallback, {
    ...opts,
    id: project.id,
    name: project.name,
    kind: projectKind(project),
    fallback,
  });
}

function rowCwd(project = {}, opts = {}) {
  return rowCwdInfo(project, opts).dir;
}

function rowDisplayPath(project = {}) {
  if (project.path) return project.path;
  return isGlobalProject(project) ? '~' : '';
}

function projectAgmsgConfig(project, cfg = {}) {
  const src = {
    ...(cfg.defaults && cfg.defaults.agmsg ? cfg.defaults.agmsg : {}),
    ...(project && project.agmsg ? project.agmsg : {}),
  };
  if (isGlobalProject(project) && !(project && project.agmsg && Object.prototype.hasOwnProperty.call(project.agmsg, 'enabled'))) {
    src.enabled = false;
  }
  return src;
}

function normalizeCollabSetting(value, fallback = DEFAULT_COLLAB) {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && hasOwn(value, 'enabled')) return value.enabled !== false;
  return !!fallback;
}

function projectCollabEnabled(project, cfg = {}) {
  if (hasOwn(project, 'collab')) return normalizeCollabSetting(project.collab, false);
  if (isGlobalProject(project)) return false;
  return normalizeCollabSetting(cfg.defaults && hasOwn(cfg.defaults, 'collab') ? cfg.defaults.collab : undefined, DEFAULT_COLLAB);
}

function projectCollabEnabledById(id) {
  const cfg = loadConfig();
  const project = findConfiguredRow(cfg, id);
  if (!project) throw new Error('unknown project: ' + id);
  return projectCollabEnabled(project, cfg);
}

function collabBridgePath() {
  return process.env.CMUX_DASH_COLLAB_BRIDGE || path.join(COLLAB_SKILL_DIR, 'bridge', 'agmsg-codex-bridge.sh');
}

function collabInitPath() {
  return process.env.CMUX_DASH_COLLAB_INIT || path.join(COLLAB_SKILL_DIR, 'scripts', 'collab.sh');
}

function collabPgrepPath() {
  return process.env.CMUX_DASH_COLLAB_PGREP || 'pgrep';
}

function collabKillPath() {
  return process.env.CMUX_DASH_COLLAB_KILL || 'kill';
}

function normalizeCollabProjectDirInfo(projectDir, { create = false, projectId = null } = {}) {
  if (!projectDir) throw new Error('projectDir is required for collab bridge');
  return resolveProjectDirInput(projectDir, {
    create,
    id: projectId || path.basename(path.resolve(expandHome(projectDir))),
    fallback: process.cwd(),
  });
}

function normalizeCollabProjectDir(projectDir, opts = {}) {
  return normalizeCollabProjectDirInfo(projectDir, opts).dir;
}

function collabStateDir(projectDir) {
  return path.join(projectDir, '.claude-codex-collab');
}

function collabConfigFile(projectDir) {
  return path.join(collabStateDir(projectDir), 'config.env');
}

function shellEnvQuote(value) {
  return "'" + String(value || '').replace(/'/g, "'\\''") + "'";
}

function writeCollabConfigFallback(projectDir, opts = {}) {
  const stateDir = collabStateDir(projectDir);
  const runDir = path.join(stateDir, 'run');
  const logDir = path.join(stateDir, 'logs');
  const spoolDir = path.join(stateDir, 'spool');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  for (const dir of [stateDir, runDir, logDir, spoolDir]) {
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
  }
  const team = opts.team || teamName(path.basename(projectDir) || 'claude-codex-collab');
  const lines = {
    COLLAB_PROJECT_DIR: projectDir,
    COLLAB_TEAM: team,
    COLLAB_AGMSG_DIR: AGMSG_DIR,
    COLLAB_SKILL_DIR,
    COLLAB_CLAUDE_AGENT: 'claude',
    COLLAB_CODEX_AGENT: 'codex',
    COLLAB_CODEX_BIN: process.env.COLLAB_CODEX_BIN || 'codex',
    COLLAB_CODEX_FLAGS: process.env.COLLAB_CODEX_FLAGS || 'exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --json',
    COLLAB_BRIDGE_INTERVAL_SECONDS: process.env.COLLAB_BRIDGE_INTERVAL_SECONDS || '10',
    COLLAB_BRIDGE_TIMEOUT_SECONDS: process.env.COLLAB_BRIDGE_TIMEOUT_SECONDS || '600',
    COLLAB_BRIDGE_LOCK_TTL_SECONDS: process.env.COLLAB_BRIDGE_LOCK_TTL_SECONDS || '300',
  };
  const body = Object.entries(lines).map(([key, value]) => `${key}=${shellEnvQuote(value)}`).join('\n') + '\n';
  fs.writeFileSync(collabConfigFile(projectDir), body, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(collabConfigFile(projectDir), 0o600); } catch (_) {}
}

async function ensureCollabConfig(projectDir, opts = {}) {
  const configFile = collabConfigFile(projectDir);
  const init = collabInitPath();
  if (fs.existsSync(init)) {
    const existed = fs.existsSync(configFile);
    const args = path.basename(init) === 'collab.sh' ? ['init', projectDir] : [projectDir];
    if (opts.team) args.push('--team', opts.team);
    args.push('--no-start');
    await run(init, args, {
      cwd: projectDir,
      timeout: intEnv('CMUX_DASH_COLLAB_INIT_TIMEOUT_MS', 30000),
      env: { ...process.env },
    });
    return { action: existed ? 'refreshed' : 'initialized', configFile };
  }

  if (fs.existsSync(configFile)) return { action: 'exists', configFile };
  writeCollabConfigFallback(projectDir, opts);
  return { action: 'created-fallback', configFile };
}

function setCollabDisabled(projectDir, disabled) {
  const stateDir = collabStateDir(projectDir);
  const disabledFile = path.join(stateDir, '.collab-disabled');
  if (disabled) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(disabledFile, new Date().toISOString() + '\n');
  } else {
    try { fs.unlinkSync(disabledFile); } catch (_) {}
  }
}

function parsePgrepLine(line) {
  const m = String(line || '').match(/^\s*(\d+)\s+(.+?)\s*$/);
  if (!m) return null;
  return { pid: Number(m[1]), command: m[2] };
}

function collabBridgeCommandMatches(command, projectDir) {
  const cmd = String(command || '');
  const bridge = collabBridgePath();
  const defaultBridge = path.join(COLLAB_SKILL_DIR, 'bridge', 'agmsg-codex-bridge.sh');
  const bridgeOk = cmd.includes(bridge) || (!process.env.CMUX_DASH_COLLAB_BRIDGE && cmd.includes(defaultBridge));
  const escapedDir = String(projectDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const projectOk = new RegExp(`(?:^|[\\s"'])${escapedDir}(?:$|[\\s"'])`).test(cmd);
  return bridgeOk && projectOk && /(?:^|[\s"'])run(?:[\s"']|$)/.test(cmd);
}

async function collabBridgeProcesses(projectDir) {
  const dir = normalizeCollabProjectDir(projectDir);
  const pgrep = collabPgrepPath();
  const pattern = path.basename(collabBridgePath());
  let out = '';
  try {
    out = await run(pgrep, ['-fl', pattern], {
      timeout: intEnv('CMUX_DASH_COLLAB_PGREP_TIMEOUT_MS', 1500),
      env: { ...process.env },
    });
  } catch (e) {
    if (String(e.code || '') === '1' || !e.message) return [];
    throw e;
  }
  return String(out || '')
    .split(/\r?\n/)
    .map(parsePgrepLine)
    .filter(Boolean)
    .filter((proc) => Number.isInteger(proc.pid) && proc.pid > 0 && collabBridgeCommandMatches(proc.command, dir));
}

async function isCollabRunning(projectDir) {
  return (await collabBridgeProcesses(projectDir)).length > 0;
}

async function stopCollabBridge(projectDir) {
  const dir = normalizeCollabProjectDir(projectDir);
  setCollabDisabled(dir, true);
  const before = await collabBridgeProcesses(dir);
  const bridge = collabBridgePath();
  let stopError = null;
  if (fs.existsSync(bridge) && fs.existsSync(collabConfigFile(dir))) {
    try {
      await run(bridge, ['stop', dir], {
        cwd: dir,
        timeout: intEnv('CMUX_DASH_COLLAB_STOP_TIMEOUT_MS', 5000),
        env: { ...process.env },
      });
    } catch (e) {
      stopError = summarizeError(e);
    }
  }

  let after = await collabBridgeProcesses(dir);
  let killed = 0;
  if (after.length) {
    await run(collabKillPath(), ['-TERM', ...after.map((p) => String(p.pid))], {
      timeout: intEnv('CMUX_DASH_COLLAB_KILL_TIMEOUT_MS', 1500),
      env: { ...process.env },
    });
    killed = after.length;
    await sleep(intEnv('CMUX_DASH_COLLAB_STOP_DELAY_MS', 80));
    after = await collabBridgeProcesses(dir);
  }

  return {
    stopped: Math.max(0, before.length - after.length) || killed,
    running: after.length > 0,
    pids: after.map((p) => p.pid),
    ...(stopError ? { stopError } : {}),
  };
}

async function ensureCollab(projectDir, on, opts = {}) {
  const dirInfo = normalizeCollabProjectDirInfo(projectDir, { create: !!on, projectId: opts.projectId });
  const dir = dirInfo.dir;
  if (!on) {
    const stopped = await stopCollabBridge(dir);
    return { ok: true, on: false, projectDir: dir, active: false, running: false, ...stopped, ...remapFields(dirInfo) };
  }

  const config = await ensureCollabConfig(dir, opts);
  const stopped = await stopCollabBridge(dir);
  setCollabDisabled(dir, false);
  return {
    ok: true,
    on: true,
    projectDir: dir,
    config,
    setupOnly: true,
    active: false,
    running: false,
    bridge: stopped,
    ...remapFields(dirInfo),
  };
}

function collabActiveFromProjectState(projectState) {
  return !!(
    projectState &&
    projectState.open &&
    projectState.slots &&
    projectState.slots.cc &&
    projectState.slots.cdx &&
    projectState.slotRefs &&
    projectState.slotRefs.cc &&
    projectState.slotRefs.cdx &&
    projectState.slotRefs.cc !== projectState.slotRefs.cdx
  );
}

async function projectCollabState(project, cfg = {}, projectState = null) {
  const enabled = projectCollabEnabled(project, cfg);
  const explicit = hasOwn(project, 'collab');
  const active = enabled && !(isGlobalProject(project) && !explicit) && collabActiveFromProjectState(projectState);
  return { enabled, active, running: active, mode: 'pane-delivery' };
}

async function ensureProjectCollab(id, on) {
  const cfg = loadConfig();
  const project = findConfiguredRow(cfg, id);
  if (!project) throw new Error('unknown project: ' + id);
  const claudeMd = on ? ensureClaudeMd(project, cfg) : { ok: true, action: 'skipped-off' };
  const cwdInfo = rowCwdInfo(project, { create: !!on });
  const result = withRemapFields(await ensureCollab(cwdInfo.dir, !!on, { team: teamName(project.id), projectId: project.id }), cwdInfo);
  project.collab = !!on;
  saveConfig(cfg);
  let projectState = null;
  try { projectState = await getProjectState(id); } catch (_) {}
  const slots = [];
  if (on && projectState && projectState.open) {
    slots.push(...await ensureCollabSlots(id));
    try { projectState = await getProjectState(id); } catch (_) {}
  }
  const active = !!on && collabActiveFromProjectState(projectState);
  return { id, collab: { enabled: !!on, active, running: active, mode: 'pane-delivery' }, claudeMd, slots, result, cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
}

// ---- cmux 状態 ----
async function listWorkspaces({ allowStale = false, quick = false } = {}) {
  try {
    const opts = quick ? {
      timeout: CMUX_READ_TIMEOUT,
      retries: CMUX_READ_RETRIES,
      retryBudget: CMUX_READ_RETRY_BUDGET,
      backoffCap: Math.min(CMUX_BACKOFF_CAP, 1000),
    } : undefined;
    const workspaces = (await cmuxJson(['list-workspaces'], opts)).workspaces || [];
    cmuxHealth.recordSuccess();
    lastWorkspaces = workspaces;
    lastWorkspacesAt = new Date().toISOString();
    return workspaces;
  } catch (e) {
    cmuxHealth.recordFailure(e);
    if (allowStale && lastWorkspaces.length) return lastWorkspaces;
    throw e;
  }
}

function getCmuxHealth() {
  return { cmux: cmuxHealth.snapshot() };
}

async function pingCmuxForRecovery() {
  try {
    await cmux(['ping'], {
      timeout: intEnv('CMUX_DASH_RECOVERY_PING_TIMEOUT', 1200),
      retries: intEnv('CMUX_DASH_RECOVERY_PING_RETRIES', 0),
      retryBudget: intEnv('CMUX_DASH_RECOVERY_PING_RETRY_BUDGET_MS', 1200),
      backoffBase: 100,
      backoffCap: 250,
    });
    return { ok: true, health: cmuxHealth.recordSuccess() };
  } catch (e) {
    return { ok: false, error: summarizeError(e), health: cmuxHealth.recordFailure(e) };
  }
}

function tagOf(ws) {
  const d = ws && ws.description;
  return d && d.startsWith(TAG) ? d.slice(TAG.length) : null;
}
async function findWorkspaceByTag(id, { attempts = 1, delayMs = 500, allowStale = false, quick = false } = {}) {
  for (let i = 0; i < attempts; i++) {
    const found = (await listWorkspaces({ allowStale, quick })).find((ws) => tagOf(ws) === id) || null;
    if (found || i === attempts - 1) return found;
    await sleep(delayMs);
  }
  return null;
}

function emptySlots(value = false) {
  return SLOT_ORDER.reduce((acc, slot) => {
    acc[slot] = value;
    return acc;
  }, {});
}

function emptySlotRefs() {
  return SLOT_ORDER.reduce((acc, slot) => {
    acc[slot] = null;
    return acc;
  }, {});
}

const slotRefState = new Map();
const gridRuntimeState = {
  wsRef: null,
  anchorSurfaceRef: null,
  concierge: {
    surfaceRef: null,
    paneRef: null,
    marker: GRID_CONCIERGE_MARKER,
  },
  columns: [],
  orphans: [],
  lastRebalance: null,
  lastRebalanceRepairAt: null,
};
const GRID_DASHBOARD_SPLIT = (() => {
  const n = Number.parseFloat(process.env.CMUX_DASH_GRID_DASHBOARD_SPLIT || '');
  return Number.isFinite(n) && n > 0.08 && n < 0.4 ? n : 0.18;
})();
const GRID_RIGHT_ANCHOR_SPLIT = 0.94;
const GRID_REBALANCE_MAX_PASSES = 8;
const GRID_REBALANCE_TOLERANCE = 0.05;
const GRID_REBALANCE_REPAIR_TOLERANCE = 0.10;
// First-pass resize calibration coefficient (px moved per `resize-pane --amount` unit).
// Observed reality on this display is ~1.0; the previous 0.5 doubled the requested amount,
// so large first-pass moves (e.g. shrinking a 2800px browser block) overshot cmux's
// per-command resize limit and were rejected, stranding that boundary as "unmovable".
// Env-overridable for displays with a different cell-to-pixel ratio.
const GRID_RESIZE_FALLBACK_PX_PER_AMOUNT = (() => {
  const n = Number.parseFloat(process.env.CMUX_DASH_GRID_PX_PER_AMOUNT || '');
  return Number.isFinite(n) && n > 0 ? n : 1;
})();
// Clamp a single `resize-pane --amount` move to a safe fraction of total workspace width.
// cmux rejects over-large amounts outright (the boundary then reads as "unmovable" and gets
// abandoned, which is the root cause of grid columns collapsing). Large divergences are instead
// covered incrementally across rebalance passes. Env-overridable for unusual layouts.
const GRID_RESIZE_MAX_AMOUNT_RATIO = (() => {
  const n = Number.parseFloat(process.env.CMUX_DASH_GRID_MAX_RESIZE_RATIO || '');
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
})();
const GRID_RIGHT_ANCHOR_SLIVER_RATIO = 0.01;
const GRID_REBALANCE_REPAIR_THROTTLE_MS = 3000;
const GRID_REBALANCE_PANE_READ_ATTEMPTS = 5;
const GRID_REBALANCE_PANE_READ_DELAY_MS = 600;
const GRID_REBALANCE_BEST_EFFORT_RETRY_DELAY_MS = 1000;
const GRID_WORKSPACE_LOOKUP_ATTEMPTS = 3;

function cleanRef(value) {
  const text = String(value || '').trim();
  return text || null;
}

function gridSlotStateForPersistence(slot) {
  return {
    surfaceRef: cleanRef(slot && slot.surfaceRef),
    paneRef: cleanRef(slot && slot.paneRef),
    marker: cleanRef(slot && slot.marker),
  };
}

function gridColumnStateForPersistence(column, idx) {
  if (!column) return null;
  const projectId = cleanRef(column.projectId);
  const columnId = gridColumnId(column.columnId || projectId);
  const cc = gridSlotStateForPersistence(column.cc);
  const cdx = gridSlotStateForPersistence(column.cdx);
  if (!projectId || !columnId || !cc.surfaceRef || !cdx.surfaceRef) return null;
  return {
    projectId,
    columnId,
    order: Number.isFinite(column.order) ? column.order : idx,
    createdAt: cleanRef(column.createdAt),
    cc,
    cdx,
  };
}

function serializedGridRuntimeState() {
  return {
    version: 1,
    wsRef: cleanRef(gridRuntimeState.wsRef),
    anchorSurfaceRef: cleanRef(gridRuntimeState.anchorSurfaceRef),
    concierge: gridConciergeSnapshot(),
    columns: (Array.isArray(gridRuntimeState.columns) ? gridRuntimeState.columns : [])
      .map((column, idx) => gridColumnStateForPersistence(column, idx))
      .filter(Boolean),
  };
}

function persistGridRuntimeState() {
  try {
    const dir = path.dirname(GRID_STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(GRID_STATE_FILE)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(serializedGridRuntimeState(), null, 2) + '\n');
    fs.renameSync(tmp, GRID_STATE_FILE);
  } catch (err) {
    console.warn(`grid state persist failed: ${summarizeError(err)}`);
  }
}

function normalizeHydratedGridSlot(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.surfaceRef !== 'string') return null;
  if (value.paneRef != null && typeof value.paneRef !== 'string') return null;
  if (value.marker != null && typeof value.marker !== 'string') return null;
  const surfaceRef = cleanRef(value.surfaceRef);
  if (!surfaceRef) return null;
  return {
    surfaceRef,
    paneRef: cleanRef(value.paneRef),
    marker: cleanRef(value.marker),
  };
}

function normalizeHydratedGridColumn(value, idx) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.projectId !== 'string') return null;
  if (value.columnId != null && typeof value.columnId !== 'string') return null;
  if (value.order != null && !Number.isFinite(value.order)) return null;
  if (value.createdAt != null && typeof value.createdAt !== 'string') return null;
  if (value.updatedAt != null && typeof value.updatedAt !== 'string') return null;
  const projectId = cleanRef(value.projectId);
  const columnId = gridColumnId(value.columnId || projectId);
  const cc = normalizeHydratedGridSlot(value.cc);
  const cdx = normalizeHydratedGridSlot(value.cdx);
  if (!projectId || !columnId || !cc || !cdx) return null;
  return {
    columnId,
    projectId,
    wsRef: null,
    order: Number.isFinite(value.order) ? value.order : idx,
    cc,
    cdx,
    createdAt: cleanRef(value.createdAt),
    updatedAt: cleanRef(value.updatedAt),
  };
}

function normalizeHydratedGridConcierge(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.surfaceRef != null && typeof value.surfaceRef !== 'string') return null;
  if (value.paneRef != null && typeof value.paneRef !== 'string') return null;
  return {
    surfaceRef: cleanRef(value.surfaceRef),
    paneRef: cleanRef(value.paneRef),
    marker: GRID_CONCIERGE_MARKER,
  };
}

function hydrateGridRuntimeState() {
  try {
    if (!fs.existsSync(GRID_STATE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(GRID_STATE_FILE, 'utf8'));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.columns)) return;
    if (parsed.wsRef != null && typeof parsed.wsRef !== 'string') return;
    if (parsed.anchorSurfaceRef != null && typeof parsed.anchorSurfaceRef !== 'string') return;
    const concierge = normalizeHydratedGridConcierge(parsed.concierge);
    if (!concierge) return;
    const columns = parsed.columns.map(normalizeHydratedGridColumn);
    if (columns.some((column) => !column)) return;
    gridRuntimeState.wsRef = cleanRef(parsed.wsRef);
    gridRuntimeState.anchorSurfaceRef = cleanRef(parsed.anchorSurfaceRef);
    gridRuntimeState.concierge = concierge;
    gridRuntimeState.columns = columns.map((column) => ({ ...column, wsRef: cleanRef(parsed.wsRef) }));
    gridRuntimeState.orphans = [];
    gridRuntimeState.lastRebalance = null;
    gridRuntimeState.lastRebalanceRepairAt = null;
    reindexGridColumns();
  } catch (_) {}
}

async function workspaceRefExistsCheck(ref, { allowStale = true, quick = true } = {}) {
  const wsRef = cleanRef(ref);
  if (!wsRef) return { ok: true, exists: false };
  try {
    return {
      ok: true,
      exists: (await listWorkspaces({ allowStale, quick })).some((ws) => cleanRef(ws && ws.ref) === wsRef),
    };
  } catch (err) {
    return { ok: false, exists: false, error: err };
  }
}

async function workspaceRefExists(ref, opts = {}) {
  return (await workspaceRefExistsCheck(ref, opts)).exists;
}

function projectSlotRefState(projectId, { create = false } = {}) {
  const key = cleanRef(projectId);
  if (!key) return null;
  let records = slotRefState.get(key);
  if (!records && create) {
    records = {};
    slotRefState.set(key, records);
  }
  return records || null;
}

function recordSlotRef(projectId, slot, refs = {}) {
  if (!SLOT_DEFS[slot]) return null;
  const surfaceRef = cleanRef(refs.surfaceRef || refs.ref);
  if (!surfaceRef) return null;
  const records = projectSlotRefState(projectId, { create: true });
  if (!records) return null;
  records[slot] = {
    surfaceRef,
    paneRef: cleanRef(refs.paneRef),
    wsRef: cleanRef(refs.wsRef),
    updatedAt: new Date().toISOString(),
  };
  return records[slot];
}

function forgetSlotRef(projectId, slot) {
  const key = cleanRef(projectId);
  const records = projectSlotRefState(projectId);
  if (!records || !SLOT_DEFS[slot]) return false;
  const had = !!records[slot];
  delete records[slot];
  if (!SLOT_ORDER.some((key) => records[key])) {
    slotRefState.delete(key);
  }
  return had;
}

function forgetProjectSlotRefs(projectId) {
  const key = cleanRef(projectId);
  return key ? slotRefState.delete(key) : false;
}

function normalizeSurfaces(obj, paneRef = null, pane = null) {
  return (Array.isArray(obj && obj.surfaces) ? obj.surfaces : []).map((surface) => ({
    ...surface,
    paneRef: surface.paneRef || surface.pane || paneRef,
    paneTitle: surface.paneTitle || surface.paneName || (pane && (pane.title || pane.name || pane.description)) || null,
    paneDescription: surface.paneDescription || (pane && pane.description) || null,
  }));
}

async function readWorkspacePanes(wsRef) {
  const panes = (await cmuxJson(['list-panes', '--workspace', wsRef])).panes || [];
  return panes.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

async function listWorkspacePanes(wsRef) {
  try { return await readWorkspacePanes(wsRef); }
  catch (_) { return []; }
}

function firstFiniteNumber(obj, keys) {
  for (const key of keys) {
    if (!obj || !hasOwn(obj, key)) continue;
    const n = Number(obj[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeFrame(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 4) {
    const nums = value.slice(0, 4).map((item) => Number(item));
    if (nums.every(Number.isFinite)) return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
  }
  if (typeof value !== 'object') return null;
  const x = firstFiniteNumber(value, ['x', 'left']);
  const y = firstFiniteNumber(value, ['y', 'top']);
  const width = firstFiniteNumber(value, ['width', 'w']);
  const height = firstFiniteNumber(value, ['height', 'h']);
  if ([x, y, width, height].every((n) => Number.isFinite(n)) && width > 0 && height > 0) {
    return { x, y, width, height };
  }
  return null;
}

function panePixelFrame(pane) {
  if (!pane) return null;
  return normalizeFrame(
    pane.pixel_frame ||
    pane.pixelFrame ||
    pane.frame_pixels ||
    pane.framePixels ||
    pane.pixelFramePx ||
    (pane.frame && (pane.frame.pixel || pane.frame.pixels || pane.frame.pixel_frame))
  );
}

function surfacePixelFrame(surface) {
  if (!surface) return null;
  return normalizeFrame(
    surface.pixel_frame ||
    surface.pixelFrame ||
    surface.frame_pixels ||
    surface.framePixels ||
    surface.pixelFramePx ||
    (surface.frame && (surface.frame.pixel || surface.frame.pixels || surface.frame.pixel_frame))
  );
}

function paneCellFrame(pane) {
  if (!pane) return null;
  return normalizeFrame(
    pane.cell_frame ||
    pane.cellFrame ||
    pane.frame_cells ||
    pane.frameCells ||
    (pane.frame && (pane.frame.cell || pane.frame.cells || pane.frame.cell_frame))
  );
}

function plausibleCellWidthPx(value) {
  return Number.isFinite(value) && value >= 3 && value <= 40;
}

function paneCellWidthPx(pane, pixelFrame = panePixelFrame(pane)) {
  const direct = firstFiniteNumber(pane, [
    'cell_width_px',
    'cellWidthPx',
    'cell_width',
    'cellWidth',
    'char_width_px',
    'charWidthPx',
  ]);
  if (plausibleCellWidthPx(direct)) return direct;

  const cellFrame = paneCellFrame(pane);
  if (pixelFrame && cellFrame && cellFrame.width > 0) {
    const fromCellFrame = pixelFrame.width / cellFrame.width;
    if (plausibleCellWidthPx(fromCellFrame)) return fromCellFrame;
  }

  const cellCount = firstFiniteNumber(pane, ['columns', 'cols', 'cell_width_cells', 'width_cells', 'cells_width']);
  if (pixelFrame && cellCount > 0) {
    const fromCellCount = pixelFrame.width / cellCount;
    if (plausibleCellWidthPx(fromCellCount)) return fromCellCount;
  }

  const paneWidth = firstFiniteNumber(pane, ['width']);
  if (pixelFrame && paneWidth > 0 && paneWidth < pixelFrame.width) {
    const fromPaneWidth = pixelFrame.width / paneWidth;
    if (plausibleCellWidthPx(fromPaneWidth)) return fromPaneWidth;
  }

  return null;
}

async function listWorkspaceSurfaces(wsRef) {
  const panes = await listWorkspacePanes(wsRef);
  const surfaces = [];
  if (panes.length) {
    for (const pane of panes) {
      const paneRef = pane && pane.ref ? pane.ref : null;
      if (!paneRef) continue;
      try {
        const obj = await cmuxJson(['list-pane-surfaces', '--workspace', wsRef, '--pane', paneRef]);
        surfaces.push(...normalizeSurfaces(obj, paneRef, pane));
      } catch (_) {}
    }
  }
  if (surfaces.length) return surfaces;
  try {
    const obj = await cmuxJson(['list-pane-surfaces', '--workspace', wsRef]);
    return normalizeSurfaces(obj, panes[0] && panes[0].ref, panes[0] || null);
  } catch (_) {
    return [];
  }
}

async function listWorkspaceSurfacesStatus(wsRef) {
  let panes = [];
  try {
    panes = await readWorkspacePanes(wsRef);
  } catch (err) {
    return { ok: false, surfaces: [], error: err };
  }

  const surfaces = [];
  let paneReadFailed = false;
  if (panes.length) {
    for (const pane of panes) {
      const paneRef = pane && pane.ref ? pane.ref : null;
      if (!paneRef) continue;
      try {
        const obj = await cmuxJson(['list-pane-surfaces', '--workspace', wsRef, '--pane', paneRef]);
        surfaces.push(...normalizeSurfaces(obj, paneRef, pane));
      } catch (err) {
        paneReadFailed = err;
      }
    }
  }
  if (surfaces.length) return { ok: true, surfaces };

  try {
    const obj = await cmuxJson(['list-pane-surfaces', '--workspace', wsRef]);
    const fallback = normalizeSurfaces(obj, panes[0] && panes[0].ref, panes[0] || null);
    if (!fallback.length && paneReadFailed) return { ok: false, surfaces: [], error: paneReadFailed };
    return { ok: true, surfaces: fallback };
  } catch (err) {
    return { ok: false, surfaces: [], error: err || paneReadFailed };
  }
}

async function getDefaultPaneRef(wsRef) {
  const panes = await listWorkspacePanes(wsRef);
  return panes.length && panes[0].ref ? panes[0].ref : null;
}

function surfaceRefFromText(text) {
  return (String(text || '').match(/surface:[^\s"']+/) || [])[0] || null;
}

function paneRefFromText(text) {
  return (String(text || '').match(/pane:[^\s"']+/) || [])[0] || null;
}

function surfaceByRef(surfaces, ref) {
  return (Array.isArray(surfaces) ? surfaces : []).find((surface) => surface && surface.ref === ref) || null;
}

function validateRecordedSlots(projectId, wsRef, panes, surfaces) {
  const records = projectSlotRefState(projectId);
  const live = {};
  if (!records) return live;

  const bySurface = new Map();
  for (const surface of Array.isArray(surfaces) ? surfaces : []) {
    if (surface && surface.ref) bySurface.set(surface.ref, surface);
  }
  const paneRefs = new Set((Array.isArray(panes) ? panes : []).map((pane) => pane && pane.ref).filter(Boolean));

  for (const slot of SLOT_ORDER) {
    const record = records[slot];
    if (!record || !record.surfaceRef) continue;
    const surface = bySurface.get(record.surfaceRef);
    const livePaneRef = surface && cleanRef(surface.paneRef);
    const wsOk = !record.wsRef || record.wsRef === wsRef;
    const paneOk = !record.paneRef || (livePaneRef ? livePaneRef === record.paneRef : paneRefs.has(record.paneRef));
    const explicitSlot = surface ? detectSlot(surface, {}, { explicitOnly: true }) : null;
    const markerOk = !explicitSlot || explicitSlot === slot;
    const initialPaneOk = !isInitialPaneRef(livePaneRef || record.paneRef, panes) || explicitSlot === slot;
    if (surface && wsOk && paneOk && markerOk && initialPaneOk) {
      if ((!record.paneRef && livePaneRef) || record.wsRef !== wsRef) {
        recordSlotRef(projectId, slot, { surfaceRef: record.surfaceRef, paneRef: livePaneRef || record.paneRef, wsRef });
      }
      live[slot] = { surface, surfaceRef: record.surfaceRef, paneRef: livePaneRef || record.paneRef || null };
    } else {
      forgetSlotRef(projectId, slot);
    }
  }
  return live;
}

function slotSurfacesInPane(state, paneRef) {
  if (!paneRef) return [];
  return (state.surfaces || []).filter((surface) => surface && surface.paneRef === paneRef && surface.slot);
}

async function closeSlotSurfaceRefs(state, refs) {
  const uniqueRefs = Array.from(new Set((refs || []).filter(Boolean)));
  for (const ref of uniqueRefs) {
    await cmux(['close-surface', '--workspace', state.wsRef, '--surface', ref]);
  }
  return uniqueRefs.length;
}

async function closeSlotPaneRefs(state, paneRefs) {
  const uniqueRefs = Array.from(new Set((paneRefs || []).filter(Boolean)));
  let closed = 0;
  for (const ref of uniqueRefs) {
    try {
      await cmux(['close-surface', '--workspace', state.wsRef, '--surface', ref]);
      closed += 1;
    } catch (_) {}
  }
  return closed;
}

function slotOwnedPaneRefs(state, slot) {
  const panes = new Set();
  for (const surface of state.surfaces || []) {
    if (!surface || surface.slot !== slot || !surface.paneRef) continue;
    const managed = slotSurfacesInPane(state, surface.paneRef);
    if (managed.every((item) => item && item.slot === slot)) panes.add(surface.paneRef);
  }
  return panes;
}

function slotOffSurfaceRefs(state, slot, paneRefsToDrain = new Set()) {
  const refs = [];
  for (const surface of state.surfaces || []) {
    if (!surface || !surface.ref) continue;
    if (surface.slot === slot || (surface.paneRef && paneRefsToDrain.has(surface.paneRef))) {
      refs.push(surface.ref);
    }
  }
  return Array.from(new Set(refs));
}

function paneRefsHaveSurfaces(state, paneRefs) {
  for (const surface of state.surfaces || []) {
    if (surface && surface.paneRef && paneRefs.has(surface.paneRef)) return true;
  }
  return false;
}

async function closeSlotOwnedPaneSurfaces(id, state, slot) {
  const paneRefsToDrain = slotOwnedPaneRefs(state, slot);
  let next = state;
  let closed = 0;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const refs = slotOffSurfaceRefs(next, slot, paneRefsToDrain);
    if (!refs.length && !next.slots[slot] && !paneRefsHaveSurfaces(next, paneRefsToDrain)) break;

    closed += await closeSlotSurfaceRefs(next, refs);
    await settle(Math.min(CMUX_SETTLE_MS, 500));
    next = await getProjectState(id);

    if (!next.slots[slot] && !paneRefsHaveSurfaces(next, paneRefsToDrain)) break;

    if (paneRefsHaveSurfaces(next, paneRefsToDrain)) {
      await closeSlotPaneRefs(next, Array.from(paneRefsToDrain));
      await settle(Math.min(CMUX_SETTLE_MS, 500));
      next = await getProjectState(id);
      if (!next.slots[slot] && !paneRefsHaveSurfaces(next, paneRefsToDrain)) break;
    }
  }

  return { next, closed, paneRefs: Array.from(paneRefsToDrain) };
}

async function repairSharedSlotPane(state, slot) {
  const current = surfaceByRef(state.surfaces, state.slotRefs && state.slotRefs[slot]);
  if (!current || !current.paneRef) return 0;
  const slotSurfaces = slotSurfacesInPane(state, current.paneRef);
  if (slotSurfaces.length <= 1) return 0;
  return closeSlotSurfaceRefs(state, slotSurfaces.map((surface) => surface.ref));
}

async function createSplitPaneSurface(wsRef) {
  const beforePanes = await listWorkspacePanes(wsRef);
  const beforeSurfaces = await listWorkspaceSurfaces(wsRef);
  const beforePaneRefs = new Set(beforePanes.map((pane) => pane && pane.ref).filter(Boolean));
  const beforeSurfaceRefs = new Set(beforeSurfaces.map((surface) => surface && surface.ref).filter(Boolean));
  const out = await cmux(['new-pane', '--type', 'terminal', '--direction', 'down', '--workspace', wsRef, '--focus', 'false']);
  const outputSurfaceRef = surfaceRefFromText(out);
  const outputPaneRef = paneRefFromText(out);
  await settle(Math.min(CMUX_SETTLE_MS, 500));

  const afterPanes = await listWorkspacePanes(wsRef);
  const afterSurfaces = await listWorkspaceSurfaces(wsRef);
  const createdPanes = afterPanes.filter((pane) => pane && pane.ref && !beforePaneRefs.has(pane.ref));
  const createdSurfaces = afterSurfaces.filter((surface) => surface && surface.ref && !beforeSurfaceRefs.has(surface.ref));

  let surface = outputSurfaceRef ? surfaceByRef(afterSurfaces, outputSurfaceRef) : null;
  if (!surface && outputPaneRef) {
    surface = createdSurfaces.find((item) => item.paneRef === outputPaneRef) || null;
  }
  if (!surface && createdPanes.length) {
    const paneRefs = new Set(createdPanes.map((pane) => pane.ref));
    surface = createdSurfaces.find((item) => paneRefs.has(item.paneRef)) || null;
  }
  if (!surface && createdSurfaces.length) surface = createdSurfaces[createdSurfaces.length - 1];
  if (!surface && outputSurfaceRef) surface = { ref: outputSurfaceRef, paneRef: outputPaneRef || null };
  if (!surface || !surface.ref) {
    throw new Error(`new-pane did not return or create a terminal surface in ${wsRef}`);
  }
  return { surfaceRef: surface.ref, paneRef: surface.paneRef || outputPaneRef || null, split: true };
}

async function surfaceProcessMap(wsRef) {
  const bySurface = {};
  try {
    const out = await cmux(['top', '--workspace', wsRef, '--processes', '--format', 'tsv'], {
      timeout: CMUX_READ_TIMEOUT,
      retries: CMUX_READ_RETRIES,
      retryBudget: CMUX_READ_RETRY_BUDGET,
      backoffCap: Math.min(CMUX_BACKOFF_CAP, 1000),
    });
    for (const line of String(out || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length < 7 || cols[3] !== 'process') continue;
      const processRef = cleanRef(cols[4]);
      const surfaceRef = cols[5];
      if (!surfaceRef) continue;
      if (!bySurface[surfaceRef]) bySurface[surfaceRef] = [];
      bySurface[surfaceRef].push({
        pid: pidFromProcessRef(processRef),
        processRef,
        command: cols.slice(6).join('\t'),
      });
    }
  } catch (_) {}
  return bySurface;
}

function pidFromProcessRef(ref) {
  const match = String(ref || '').match(/(?:^|:)pid:(\d+)$|(?:^|:)process:(\d+)$|^(\d+)$/i);
  return match ? (match[1] || match[2] || match[3]) : null;
}

const processCwdCache = new Map();
let processCwdResolverOverride = null;

function processCwdMapOverride() {
  const raw = process.env.CMUX_DASH_PROCESS_CWD_MAP;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function resolveProcessCwdUncached(pid) {
  const cleanPid = String(pid || '').trim();
  if (!/^\d+$/.test(cleanPid)) return null;
  if (processCwdResolverOverride) return processCwdResolverOverride(cleanPid);
  const map = processCwdMapOverride();
  if (map && hasOwn(map, cleanPid)) return map[cleanPid];
  try {
    const out = execFileSync('lsof', ['-a', '-p', cleanPid, '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(250, Math.min(CMUX_READ_TIMEOUT, 2500)),
    });
    for (const line of String(out || '').split(/\r?\n/)) {
      if (line.startsWith('n')) return line.slice(1).trim() || null;
    }
  } catch (_) {}
  return null;
}

function resolveProcessCwd(pid) {
  const cleanPid = String(pid || '').trim();
  if (!/^\d+$/.test(cleanPid)) return null;
  const now = Date.now();
  const cached = processCwdCache.get(cleanPid);
  if (cached && now - cached.at <= PROCESS_CWD_TTL_MS) return cached.cwd;
  const cwd = cleanRef(resolveProcessCwdUncached(cleanPid));
  processCwdCache.set(cleanPid, { cwd: cwd || null, at: now });
  return cwd || null;
}

function setProcessCwdResolverForTest(fn) {
  processCwdResolverOverride = typeof fn === 'function' ? fn : null;
  processCwdCache.clear();
}

function emptyTypeBreakdown() {
  return PROCESS_TYPES.reduce((acc, type) => {
    acc[type] = { rssBytes: 0, procCount: 0, label: PROCESS_TYPE_LABELS[type] };
    return acc;
  }, {});
}

function emptySlotMetrics() {
  return SLOT_ORDER.reduce((acc, slot) => {
    acc[slot] = { rssBytes: 0, procCount: 0, surfaceCount: 0, refs: [] };
    return acc;
  }, {});
}

function metricProjectBase(project = {}) {
  return {
    id: project.id,
    name: project.name || project.id,
    kind: projectKind(project),
    path: project.path || null,
    wsRef: null,
    rssBytes: 0,
    procCount: 0,
    bySlot: emptySlotMetrics(),
    byType: emptyTypeBreakdown(),
  };
}

function rowIndex(rows) {
  const byRef = new Map();
  const childrenByParent = new Map();
  for (const row of rows) {
    if (row.ref) byRef.set(row.ref, row);
    if (row.parentRef) {
      if (!childrenByParent.has(row.parentRef)) childrenByParent.set(row.parentRef, []);
      childrenByParent.get(row.parentRef).push(row);
    }
  }
  return { byRef, childrenByParent };
}

function ancestorOfKind(row, kind, byRef) {
  let current = row;
  const seen = new Set();
  while (current && current.parentRef && !seen.has(current.parentRef)) {
    seen.add(current.parentRef);
    const parent = byRef.get(current.parentRef);
    if (!parent) return null;
    if (parent.kind === kind) return parent;
    current = parent;
  }
  return null;
}

function workspaceProjectRefMap(workspaces) {
  const byRef = new Map();
  for (const ws of Array.isArray(workspaces) ? workspaces : []) {
    const id = tagOf(ws);
    if (id && ws && ws.ref) byRef.set(ws.ref, id);
  }
  return byRef;
}

function metricSlotForSurface(surfaceRow, processRows) {
  const processMap = {};
  processMap[surfaceRow.ref] = processRows.map((row) => row.command);
  return detectSlot({
    ref: surfaceRow.ref,
    title: surfaceRow.command,
    name: surfaceRow.command,
    type: 'terminal',
  }, processMap) || 'other';
}

function processPid(row) {
  const ref = String(row && row.ref || '');
  const match = ref.match(/(?:^|:)([1-9][0-9]{1,7})$/);
  return match ? match[1] : null;
}

function shouldResolveFullCommand(row) {
  const cmd = String(row && row.command || '').trim().toLowerCase();
  return /^(node|bun|deno|python|python3|ruby|bash|zsh|sh|fish|nu|cmux)$/.test(cmd);
}

async function processFullCommandMap(processRows) {
  const wanted = [];
  const seen = new Set();
  for (const row of processRows) {
    if (!shouldResolveFullCommand(row)) continue;
    const pid = processPid(row);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    wanted.push(pid);
    if (wanted.length >= 40) break;
  }
  const byPid = {};
  for (const pid of wanted) {
    try {
      byPid[pid] = await run('/bin/ps', ['-p', pid, '-o', 'command='], {
        timeout: 500,
        maxBuffer: 256 * 1024,
      });
    } catch (_) {}
  }
  return byPid;
}

function addTypeMetric(project, type, rssBytes) {
  const key = PROCESS_TYPES.includes(type) ? type : 'O';
  project.byType[key].rssBytes += rssBytes;
  project.byType[key].procCount += 1;
}

function sumTypeBreakdown(projects) {
  const totals = emptyTypeBreakdown();
  for (const project of Array.isArray(projects) ? projects : []) {
    const byType = project && project.byType ? project.byType : {};
    for (const type of PROCESS_TYPES) {
      const item = byType[type] || {};
      totals[type].rssBytes += Number(item.rssBytes) || 0;
      totals[type].procCount += Number(item.procCount) || 0;
    }
  }
  return totals;
}

function addSlotMetric(project, slot, surfaceRow, processRows) {
  const key = project.bySlot[slot] ? slot : 'other';
  if (!project.bySlot[key]) project.bySlot[key] = { rssBytes: 0, procCount: 0, surfaceCount: 0, refs: [] };
  const item = project.bySlot[key];
  item.rssBytes += surfaceRow.rssBytes;
  item.procCount += surfaceRow.procCount || processRows.length;
  item.surfaceCount += 1;
  if (surfaceRow.ref) item.refs.push(surfaceRow.ref);
}

async function aggregateTopMetrics(rows, workspaces, cfg) {
  const projects = new Map();
  const configured = configuredRows(cfg);
  for (const project of configured) {
    if (project && project.id) projects.set(project.id, metricProjectBase(project));
  }

  const { byRef, childrenByParent } = rowIndex(rows);
  const workspaceToProject = workspaceProjectRefMap(workspaces);
  for (const row of rows) {
    if (row.kind !== 'workspace') continue;
    const id = workspaceToProject.get(row.ref);
    if (!id) continue;
    if (!projects.has(id)) projects.set(id, metricProjectBase({ id }));
    const project = projects.get(id);
    project.wsRef = row.ref || project.wsRef;
    project.rssBytes = row.rssBytes;
    project.procCount = row.procCount;
  }

  const processRows = rows.filter((row) => row.kind === 'process');
  const fullByPid = await processFullCommandMap(processRows);
  for (const row of processRows) {
    const ws = ancestorOfKind(row, 'workspace', byRef);
    const id = ws && workspaceToProject.get(ws.ref);
    if (!id) continue;
    if (!projects.has(id)) projects.set(id, metricProjectBase({ id }));
    const pid = processPid(row);
    const type = classifyProcess(row.command, pid ? fullByPid[pid] : '');
    addTypeMetric(projects.get(id), type, row.rssBytes);
  }

  for (const row of rows) {
    if (row.kind !== 'surface') continue;
    const ws = ancestorOfKind(row, 'workspace', byRef);
    const id = ws && workspaceToProject.get(ws.ref);
    if (!id) continue;
    if (!projects.has(id)) projects.set(id, metricProjectBase({ id }));
    const surfaceProcesses = (childrenByParent.get(row.ref) || []).filter((child) => child.kind === 'process');
    addSlotMetric(projects.get(id), metricSlotForSurface(row, surfaceProcesses), row, surfaceProcesses);
  }

  for (const project of projects.values()) {
    const processCount = PROCESS_TYPES.reduce((sum, type) => sum + project.byType[type].procCount, 0);
    const surfaceRss = Object.values(project.bySlot).reduce((sum, item) => sum + (item.rssBytes || 0), 0);
    if (!project.procCount) project.procCount = processCount;
    if (!project.rssBytes) project.rssBytes = surfaceRss;
  }

  const ordered = [];
  for (const project of configured) {
    if (project && project.id && projects.has(project.id)) ordered.push(projects.get(project.id));
  }
  for (const project of projects.values()) {
    if (!ordered.some((p) => p.id === project.id)) ordered.push(project);
  }
  return ordered;
}

function combineErrors(errors) {
  const parts = errors.filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

async function getMetrics() {
  const updatedAt = new Date().toISOString();
  let app = { footprint: null, childRss: null, groups: [] };
  let memoryError = null;
  try {
    const memoryText = await cmux(['memory', '--all'], {
      timeout: CMUX_READ_TIMEOUT,
      retries: CMUX_READ_RETRIES,
      retryBudget: CMUX_READ_RETRY_BUDGET,
      backoffCap: Math.min(CMUX_BACKOFF_CAP, 1000),
    });
    app = parseMemory(memoryText);
  } catch (e) {
    memoryError = `memory: ${summarizeError(e)}`;
  }

  let workspaces = [];
  let topText = '';
  try {
    workspaces = await listWorkspaces({ allowStale: true, quick: true });
    topText = await cmux(['top', '--all', '--processes', '--format', 'tsv'], {
      timeout: CMUX_READ_TIMEOUT,
      retries: CMUX_READ_RETRIES,
      retryBudget: CMUX_READ_RETRY_BUDGET,
      backoffCap: Math.min(CMUX_BACKOFF_CAP, 1000),
    });
  } catch (e) {
    return {
      app,
      byType: emptyTypeBreakdown(),
      projects: [],
      updatedAt,
      error: combineErrors([memoryError, `top: ${summarizeError(e)}`]),
    };
  }

  try {
    const cfg = loadConfig();
    const projects = await aggregateTopMetrics(parseTop(topText), workspaces, cfg);
    return {
      app,
      byType: sumTypeBreakdown(projects),
      projects,
      updatedAt,
      error: combineErrors([memoryError]),
    };
  } catch (e) {
    return {
      app,
      byType: emptyTypeBreakdown(),
      projects: [],
      updatedAt,
      error: combineErrors([memoryError, `aggregate: ${summarizeError(e)}`]),
    };
  }
}

function configuredSlotCommand(project, cfg, slot) {
  const slotCommands = {
    ...(cfg.defaults && cfg.defaults.slotCommands ? cfg.defaults.slotCommands : {}),
    ...(project && project.slotCommands ? project.slotCommands : {}),
  };
  if (slot === 'cc') return project.topCmd || slotCommands.cc || SLOT_DEFS.cc.defaultCommand;
  if (slot === 'cdx') return project.bottomCmd || slotCommands.cdx || SLOT_DEFS.cdx.defaultCommand;
  if (slot === 'yazi') return project.yaziCmd || slotCommands.yazi || SLOT_DEFS.yazi.defaultCommand;
  if (slot === 'term') return project.termCmd || slotCommands.term || SLOT_DEFS.term.defaultCommand;
  return null;
}

function slotMarker(slot) {
  return SLOT_MARK_PREFIX + slot;
}

function titleCommand(slot) {
  return `printf '\\033]0;${slotMarker(slot)}\\007'`;
}

function gridSlotMarker(columnId, slot) {
  return `${GRID_MARK_PREFIX}${GRID_ID}:column:${columnId}:slot:${slot}`;
}

function gridTitleCommand(columnId, slot) {
  return `printf '\\033]0;${gridSlotMarker(columnId, slot)}\\007'`;
}

function gridConciergeTitleCommand() {
  return `printf '\\033]0;${GRID_CONCIERGE_MARKER}\\007'`;
}

function gridRightAnchorTitleCommand() {
  return `printf '\\033]0;${GRID_RIGHT_ANCHOR_MARKER}\\007'`;
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function slotLaunchText(project, cfg, slot) {
  const cmd = configuredSlotCommand(project, cfg, slot);
  const cwd = shellQuote(rowCwd(project, { create: true }));
  const prefix = titleCommand(slot);
  if (slot === 'term' && !cmd) return `${prefix}; cd ${cwd}\\n`;
  return `${prefix}; cd ${cwd} && exec ${cmd || SLOT_DEFS[slot].defaultCommand}\\n`;
}

function gridLaunchCommand(project, cfg, columnId, slot) {
  const cmd = configuredSlotCommand(project, cfg, slot);
  const cwd = shellQuote(rowCwd(project, { create: true }));
  return `${gridTitleCommand(columnId, slot)}; cd ${cwd} && exec ${cmd || SLOT_DEFS[slot].defaultCommand}`;
}

function gridConciergeLaunchCommand() {
  const cwd = shellQuote(CMUX_DASH_PROJECTS_ROOT);
  const missingClaude = shellQuote('claude CLI が見つかりません: https://claude.com/claude-code');
  const claudeGuard = `command -v claude >/dev/null || { echo ${missingClaude}; exec "\${SHELL:-/bin/sh}"; }`;
  return `${gridConciergeTitleCommand()}; ${claudeGuard}; mkdir -p ${cwd} && cd ${cwd} && exec ${SLOT_DEFS.cc.defaultCommand}`;
}

function surfaceMarkerSearchText(surface) {
  return [
    surface && surface.title,
    surface && surface.name,
    surface && surface.command,
    surface && surface.description,
    surface && surface.paneTitle,
    surface && surface.paneName,
    surface && surface.paneDescription,
  ].filter(Boolean).join('\n');
}

function slotMarkerSearchText(surface) {
  return surfaceMarkerSearchText(surface).toLowerCase();
}

function normalizedPath(value) {
  const expanded = expandHome(value);
  if (!expanded) return null;
  try { return fs.realpathSync(expanded); } catch (_) {}
  try { return path.resolve(expanded); } catch (_) { return String(expanded); }
}

function surfaceCwd(surface) {
  return cleanRef(
    surface && (
      surface.cwd ||
      surface.currentWorkingDirectory ||
      surface.workingDirectory ||
      surface.currentPath
    ),
  );
}

function surfaceMatchesProjectCwd(surface, project) {
  const cwd = normalizedPath(surfaceCwd(surface));
  const expected = normalizedPath(rowCwd(project));
  return !!(cwd && expected && cwd === expected);
}

function processEntryCommand(entry) {
  if (entry && typeof entry === 'object') {
    return String(entry.command || entry.fullCommand || entry.title || '').trim();
  }
  return String(entry || '').trim();
}

function processLabelForType(type) {
  if (type === 'X') return 'codex';
  if (type === 'C') return 'claude';
  if (type === 'M') return 'mcp';
  if (type === 'O') return 'other';
  return null;
}

function gridSurfaceProcessSummary(surfaceRef, processMap = {}, role = null) {
  const ref = cleanRef(surfaceRef);
  const entries = ref && Array.isArray(processMap[ref]) ? processMap[ref] : [];
  const processes = entries.map((entry) => {
    const command = processEntryCommand(entry);
    const type = classifyProcess(command);
    return {
      pid: entry && typeof entry === 'object' ? (entry.pid || null) : null,
      processRef: entry && typeof entry === 'object' ? (entry.processRef || null) : null,
      command,
      type,
      process: processLabelForType(type),
    };
  });
  const preferredType = role === 'cdx' ? 'X' : (role === 'cc' ? 'C' : null);
  const primary = (preferredType ? processes.find((entry) => entry.type === preferredType) : null)
    || processes[0]
    || null;
  return {
    pid: primary && primary.pid || null,
    processRef: primary && primary.processRef || null,
    command: primary && primary.command || null,
    process: primary && primary.process || null,
    processes,
  };
}

function attachGridProcessDiagnosticsToColumns(columns, processMap = {}) {
  return (Array.isArray(columns) ? columns : []).map((column) => {
    if (!column) return column;
    const ccInfo = gridSurfaceProcessSummary(column.cc && column.cc.surfaceRef, processMap, 'cc');
    const cdxInfo = gridSurfaceProcessSummary(column.cdx && column.cdx.surfaceRef, processMap, 'cdx');
    return {
      ...column,
      cc: {
        ...(column.cc || {}),
        pid: ccInfo.pid,
        processRef: ccInfo.processRef,
        process: ccInfo.process,
        command: ccInfo.command,
        processes: ccInfo.processes,
      },
      cdx: {
        ...(column.cdx || {}),
        pid: cdxInfo.pid,
        processRef: cdxInfo.processRef,
        process: cdxInfo.process,
        command: cdxInfo.command,
        processes: cdxInfo.processes,
        cdxReady: false,
      },
    };
  });
}

function surfaceProcessEntries(surface, processMap = {}) {
  const entries = [];
  if (!surface) return entries;
  for (const key of ['process', 'processName', 'command']) {
    if (surface[key]) entries.push({ command: surface[key], pid: null, source: 'surface' });
  }
  if (Array.isArray(surface.processes)) {
    for (const value of surface.processes) entries.push(value);
  }
  if (surface.ref && Array.isArray(processMap[surface.ref])) entries.push(...processMap[surface.ref]);
  return entries;
}

function surfaceProcessEntriesMatchingProjectCwd(surface, processMap = {}, project) {
  const expected = normalizedPath(rowCwd(project));
  if (!expected) return [];
  return surfaceProcessEntries(surface, processMap).filter((entry) => {
    const pid = entry && typeof entry === 'object' ? entry.pid : null;
    if (!pid) return false;
    const cwd = normalizedPath(resolveProcessCwd(pid));
    return !!(cwd && cwd === expected);
  });
}

function firstPaneRef(panes) {
  const pane = (Array.isArray(panes) ? panes : []).find((item) => item && item.ref);
  return pane ? pane.ref : null;
}

function isInitialPaneRef(paneRef, panes) {
  const ref = cleanRef(paneRef);
  const initial = firstPaneRef(panes);
  return !!(ref && initial && ref === initial);
}

function recoverableSlotForSurface(surface, project, opts = {}) {
  if (!surface || !surface.ref || !surfaceMatchesProjectCwd(surface, project)) return null;
  if (isInitialPaneRef(surface.paneRef, opts.panes)) return null;
  const processMap = {};
  processMap[surface.ref] = Array.isArray(surface.processes) ? surface.processes : [];
  const slot = detectSlot(surface, processMap);
  return slot && slot !== 'term' ? slot : null;
}

function detectSlot(surface, processMap = {}, opts = {}) {
  const markerText = slotMarkerSearchText(surface);
  for (const slot of SLOT_ORDER) {
    if (markerText.includes(slotMarker(slot))) return slot;
  }
  if (opts.explicitOnly) return null;
  const title = String(surface && (surface.title || surface.name || '') || '').toLowerCase();
  if (/\bclaude\b/.test(title)) return 'cc';
  if (/\bcodex\b/.test(title)) return 'cdx';
  if (/\byazi\b/.test(title)) return 'yazi';

  const processes = (processMap[surface && surface.ref] || []).join('\n').toLowerCase();
  for (const slot of SLOT_ORDER) {
    const def = SLOT_DEFS[slot];
    if (def.processRe && def.processRe.test(processes)) return slot;
  }

  if (/\b(zsh|bash|fish|sh|nu|shell|terminal)\b/.test(title)) return 'term';
  if (!title && surface && surface.type === 'terminal') return 'term';
  return null;
}

async function getProjectState(projectId) {
  const cfg = loadConfig();
  const project = findConfiguredRow(cfg, projectId);
  if (!project) throw new Error('unknown project: ' + projectId);
  const cwdInfo = rowCwdInfo(project);
  const ws = await findWorkspaceByTag(projectId, { attempts: 1, allowStale: true, quick: true });
  const base = {
    open: !!ws,
    wsRef: ws ? ws.ref : null,
    ref: ws ? ws.ref : null,
    cwd: cwdInfo.dir,
    ...remapFields(cwdInfo),
    selected: ws ? !!ws.selected : false,
    panes: [],
    slots: emptySlots(false),
    slotRefs: emptySlotRefs(),
    slotPaneRefs: emptySlotRefs(),
    surfaces: [],
    lastMessage: ws ? (ws.latest_conversation_message || null) : null,
    lastAt: ws ? (ws.latest_submitted_at || null) : null,
  };
  if (!ws) {
    forgetProjectSlotRefs(projectId);
    return base;
  }

  base.panes = await listWorkspacePanes(ws.ref);
  const surfaces = await listWorkspaceSurfaces(ws.ref);
  const processes = await surfaceProcessMap(ws.ref);
  const recordedSlots = validateRecordedSlots(projectId, ws.ref, base.panes, surfaces);
  const slotByRecordedSurface = new Map();
  for (const slot of SLOT_ORDER) {
    if (recordedSlots[slot] && recordedSlots[slot].surfaceRef) {
      slotByRecordedSurface.set(recordedSlots[slot].surfaceRef, slot);
    }
  }
  base.surfaces = surfaces.map((surface) => {
    const recordedSlot = surface && surface.ref ? slotByRecordedSurface.get(surface.ref) : null;
    const markerSlot = recordedSlot ? null : detectSlot(surface, processes, { explicitOnly: true });
    const slot = recordedSlot || markerSlot;
    return {
      ref: surface.ref || null,
      paneRef: surface.paneRef || null,
      paneTitle: surface.paneTitle || null,
      paneDescription: surface.paneDescription || null,
      title: surface.title || null,
      cwd: surfaceCwd(surface),
      type: surface.type || null,
      slot,
      slotSource: recordedSlot ? 'recorded' : (markerSlot ? 'marker' : null),
      processes: processes[surface.ref] || [],
    };
  });
  for (const surface of base.surfaces) {
    if (!surface.slot || !SLOT_DEFS[surface.slot]) continue;
    base.slots[surface.slot] = true;
    if (!base.slotRefs[surface.slot] && surface.ref) base.slotRefs[surface.slot] = surface.ref;
    if (!base.slotPaneRefs[surface.slot] && surface.paneRef) base.slotPaneRefs[surface.slot] = surface.paneRef;
    if (surface.slotSource === 'marker' && surface.ref) {
      recordSlotRef(projectId, surface.slot, { surfaceRef: surface.ref, paneRef: surface.paneRef, wsRef: ws.ref });
    }
  }

  const claimedRefs = new Set(base.surfaces.filter((surface) => surface && surface.slot && surface.ref).map((surface) => surface.ref));
  const recoveryCandidates = SLOT_ORDER.reduce((acc, slot) => {
    acc[slot] = [];
    return acc;
  }, {});
  for (const surface of base.surfaces) {
    if (!surface || !surface.ref || claimedRefs.has(surface.ref)) continue;
    const slot = recoverableSlotForSurface(surface, project, { panes: base.panes });
    if (slot && !base.slotRefs[slot]) recoveryCandidates[slot].push(surface);
  }
  for (const slot of SLOT_ORDER) {
    if (base.slotRefs[slot] || recoveryCandidates[slot].length !== 1) continue;
    const surface = recoveryCandidates[slot][0];
    surface.slot = slot;
    surface.slotSource = 'recovered';
    base.slots[slot] = true;
    base.slotRefs[slot] = surface.ref;
    base.slotPaneRefs[slot] = surface.paneRef || null;
    recordSlotRef(projectId, slot, { surfaceRef: surface.ref, paneRef: surface.paneRef, wsRef: ws.ref });
  }

  return base;
}

async function getState() {
  const cfg = loadConfig();
  let listError = null;
  let listStale = false;
  let workspaces = [];
  try {
    workspaces = await listWorkspaces({ quick: true });
  } catch (e) {
    listError = e.message;
    listStale = !!lastWorkspaces.length;
    workspaces = lastWorkspaces;
  }
  const byTag = {};
  for (const ws of workspaces) { const t = tagOf(ws); if (t) byTag[t] = ws; }
  const buildRow = async (p) => {
    const ws = byTag[p.id];
    const ag = projectAgmsgConfig(p, cfg);
    const cwdInfo = rowCwdInfo(p);
    let projectState = {
      open: !!ws,
      wsRef: ws ? ws.ref : null,
      ref: ws ? ws.ref : null,
      cwd: cwdInfo.dir,
      ...remapFields(cwdInfo),
      selected: ws ? !!ws.selected : false,
      slots: emptySlots(false),
      slotRefs: emptySlotRefs(),
      slotPaneRefs: emptySlotRefs(),
      surfaces: [],
      lastMessage: ws ? (ws.latest_conversation_message || null) : null,
      lastAt: ws ? (ws.latest_submitted_at || null) : null,
    };
    if (ws) {
      try {
        projectState = await getProjectState(p.id);
      } catch (e) {
        projectState.surfaceError = summarizeError(e);
      }
    }
    const collab = await projectCollabState(p, cfg, projectState);
    return {
      id: p.id,
      kind: projectKind(p),
      name: p.name || p.id,
      path: rowDisplayPath(p),
      cwd: projectState.cwd || cwdInfo.dir,
      ...remapFields(projectState.remappedFrom ? projectState : cwdInfo),
      color: p.color || '#9ca3af',
      emoji: p.emoji || (isGlobalProject(p) ? '⌘' : '📁'),
      topCmd: p.topCmd || cfg.defaults.topCmd,
      bottomCmd: p.bottomCmd || cfg.defaults.bottomCmd,
      slotCommands: {
        cc: configuredSlotCommand(p, cfg, 'cc'),
        cdx: configuredSlotCommand(p, cfg, 'cdx'),
        yazi: configuredSlotCommand(p, cfg, 'yazi'),
        term: configuredSlotCommand(p, cfg, 'term'),
      },
      team: teamName(p.id),
      agmsg: ag.enabled !== false,
      collab,
      open: projectState.open,
      ref: projectState.ref,
      wsRef: projectState.wsRef,
      selected: projectState.selected,
      slots: projectState.slots,
      slotRefs: projectState.slotRefs,
      slotPaneRefs: projectState.slotPaneRefs || emptySlotRefs(),
      surfaces: projectState.surfaces,
      surfaceError: projectState.surfaceError || null,
      lastMessage: projectState.lastMessage,
      lastAt: projectState.lastAt,
    };
  };
  const projects = await Promise.all(configuredProjectRows(cfg).map(buildRow));
  const globalRows = await Promise.all(configuredGlobalRows(cfg).map(buildRow));
  const allRows = [...projects, ...globalRows];
  let grid;
  try {
    grid = await getGridState();
  } catch (e) {
    grid = { wsRef: null, columns: [], error: summarizeError(e) };
  }
  return {
    agmsgInstalled: agmsgAvailable(),
    defaults: cfg.defaults,
    projects,
    globalRows,
    grid,
    openCount: projects.filter((p) => p.open).length,
    globalOpenCount: globalRows.filter((p) => p.open).length,
    rowCount: allRows.length,
    allOpenCount: allRows.filter((p) => p.open).length,
    listError,
    listStale,
    listReadAt: listStale ? lastWorkspacesAt : new Date().toISOString(),
    health: getCmuxHealth(),
  };
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return JSON.stringify(String(value));
}

function yamlKey(key) {
  const text = String(key);
  if (/^(?:y|yes|n|no|true|false|on|off|null|nil|~)$/i.test(text)) return yamlScalar(text);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(text)) return yamlScalar(text);
  return text;
}

function yamlIsCollection(value) {
  return Array.isArray(value) || (value && typeof value === 'object');
}

function yamlStringify(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    const lines = [];
    for (const item of value) {
      if (yamlIsCollection(item) && !Array.isArray(item)) {
        const entries = Object.entries(item).filter(([, v]) => v !== undefined);
        if (!entries.length) {
          lines.push(`${pad}- {}`);
          continue;
        }
        entries.forEach(([key, val], idx) => {
          const renderedKey = yamlKey(key);
          const lead = idx === 0 ? `${pad}- ${renderedKey}:` : `${pad}  ${renderedKey}:`;
          if (yamlIsCollection(val)) {
            lines.push(lead);
            lines.push(yamlStringify(val, indent + (idx === 0 ? 4 : 4)));
          } else {
            lines.push(`${lead} ${yamlScalar(val)}`);
          }
        });
      } else if (yamlIsCollection(item)) {
        lines.push(`${pad}-`);
        lines.push(yamlStringify(item, indent + 2));
      } else {
        lines.push(`${pad}- ${yamlScalar(item)}`);
      }
    }
    return lines.join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return `${pad}{}`;
    const lines = [];
    for (const [key, val] of entries) {
      const renderedKey = yamlKey(key);
      if (yamlIsCollection(val)) {
        lines.push(`${pad}${renderedKey}:`);
        lines.push(yamlStringify(val, indent + 2));
      } else {
        lines.push(`${pad}${renderedKey}: ${yamlScalar(val)}`);
      }
    }
    return lines.join('\n');
  }
  return `${pad}${yamlScalar(value)}`;
}

function workspaceYamlRow(row = {}) {
  const slots = {};
  for (const slot of SLOT_ORDER) {
    slots[slot] = {
      on: !!(row.slots && row.slots[slot]),
      ref: row.slotRefs && row.slotRefs[slot] ? row.slotRefs[slot] : null,
      paneRef: row.slotPaneRefs && row.slotPaneRefs[slot] ? row.slotPaneRefs[slot] : null,
      command: row.slotCommands && row.slotCommands[slot] != null ? row.slotCommands[slot] : null,
    };
  }
  return {
    id: row.id,
    kind: projectKind(row),
    name: row.name || row.id,
    path: row.path || null,
    color: row.color || null,
    emoji: row.emoji || null,
    agmsg: !!row.agmsg,
    collab: row.collab || { enabled: false, running: false },
    team: row.agmsg ? row.team : null,
    workspace: {
      open: !!row.open,
      ref: row.wsRef || row.ref || null,
      selected: !!row.selected,
    },
    slots,
  };
}

function workspaceYamlPayload(st) {
  const projects = Array.isArray(st && st.projects) ? st.projects : [];
  const globalRows = Array.isArray(st && st.globalRows) ? st.globalRows : [];
  const rows = [...projects, ...globalRows];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      projects: projects.length,
      globalRows: globalRows.length,
      open: rows.filter((row) => row && row.open).length,
    },
    rows: rows.map(workspaceYamlRow),
  };
}

async function getWorkspaceYaml() {
  return yamlStringify(workspaceYamlPayload(await getState())) + '\n';
}

function templateAbsolutePath(templatePath) {
  const expanded = expandHome(templatePath);
  return path.isAbsolute(expanded) ? expanded : path.join(__dirname, expanded);
}

function renderClaudeMdTemplate(template, project) {
  const values = {
    PROJECT_NAME: project.name || project.id,
    TEAM: teamName(project.id),
    PROJECT_ID: project.id,
  };
  return String(template).replace(/\{\{(PROJECT_NAME|TEAM|PROJECT_ID)\}\}/g, (_, key) => String(values[key] || ''));
}

function managedClaudeMdBlock(renderedTemplate) {
  const match = String(renderedTemplate).match(CLAUDE_MD_BLOCK_RE);
  if (!match) throw new Error('CLAUDE.md template is missing cmux-dashboard managed block');
  return match[0];
}

function appendManagedBlock(existing, block) {
  const sep = existing.length === 0 ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
  return existing + sep + block + (block.endsWith('\n') ? '' : '\n');
}

function ensureClaudeMd(project, cfg = {}) {
  if (isGlobalProject(project)) return { ok: true, action: 'skipped-global' };
  const claudeMd = resolveClaudeMdConfig(project, cfg);
  if (claudeMd.mode === 'off') return { ok: true, action: 'off' };

  try {
    const cwdInfo = rowCwdInfo(project, { create: true });
    const target = path.join(cwdInfo.dir, 'CLAUDE.md');

    if (claudeMd.mode === 'create-if-missing' && fs.existsSync(target)) {
      return { ok: true, action: 'skipped', cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
    }

    const rendered = renderClaudeMdTemplate(
      fs.readFileSync(templateAbsolutePath(claudeMd.templatePath), 'utf8'),
      project,
    );

    if (claudeMd.mode === 'create-if-missing') {
      fs.writeFileSync(target, rendered, 'utf8');
      return { ok: true, action: 'created', cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
    }

    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, rendered, 'utf8');
      return { ok: true, action: 'created', cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
    }

    const block = managedClaudeMdBlock(rendered);
    const current = fs.readFileSync(target, 'utf8');
    if (CLAUDE_MD_BLOCK_RE.test(current)) {
      fs.writeFileSync(target, current.replace(CLAUDE_MD_BLOCK_RE, block), 'utf8');
      return { ok: true, action: 'updated-block', cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
    }

    fs.writeFileSync(target, appendManagedBlock(current, block), 'utf8');
    return { ok: true, action: 'appended-block', cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function gridColumnId(projectId) {
  return String(projectId || '').trim();
}

function gridColumnSnapshot(column, order = column && column.order) {
  if (!column) return null;
  return {
    columnId: column.columnId,
    projectId: column.projectId,
    wsRef: column.wsRef || null,
    order,
    topSurfaceRef: column.cc && column.cc.surfaceRef || null,
    bottomSurfaceRef: column.cdx && column.cdx.surfaceRef || null,
    paneRefs: [
      column.cc && column.cc.paneRef,
      column.cdx && column.cdx.paneRef,
    ].filter(Boolean),
    cc: {
      paneRef: column.cc && column.cc.paneRef || null,
      surfaceRef: column.cc && column.cc.surfaceRef || null,
      marker: column.cc && column.cc.marker || null,
      pid: column.cc && column.cc.pid || null,
      processRef: column.cc && column.cc.processRef || null,
      process: column.cc && column.cc.process || null,
      command: column.cc && column.cc.command || null,
      processes: Array.isArray(column.cc && column.cc.processes) ? column.cc.processes : [],
    },
    cdx: {
      paneRef: column.cdx && column.cdx.paneRef || null,
      surfaceRef: column.cdx && column.cdx.surfaceRef || null,
      marker: column.cdx && column.cdx.marker || null,
      pid: column.cdx && column.cdx.pid || null,
      processRef: column.cdx && column.cdx.processRef || null,
      process: column.cdx && column.cdx.process || null,
      command: column.cdx && column.cdx.command || null,
      processes: Array.isArray(column.cdx && column.cdx.processes) ? column.cdx.processes : [],
      cdxReady: column.cdx && column.cdx.cdxReady === true,
    },
    createdAt: column.createdAt || null,
    updatedAt: column.updatedAt || null,
  };
}

function emptyGridConcierge() {
  return {
    surfaceRef: null,
    paneRef: null,
    marker: GRID_CONCIERGE_MARKER,
  };
}

function resetGridConcierge() {
  gridRuntimeState.concierge = emptyGridConcierge();
}

function setGridConciergeSurface(surface) {
  const ref = cleanRef(surface && (surface.ref || surface.surfaceRef));
  const paneRef = cleanRef(surface && surface.paneRef);
  gridRuntimeState.concierge = {
    surfaceRef: ref,
    paneRef: paneRef || null,
    marker: GRID_CONCIERGE_MARKER,
  };
  return gridRuntimeState.concierge;
}

function gridConciergeSnapshot() {
  const state = gridRuntimeState.concierge || {};
  return {
    surfaceRef: cleanRef(state.surfaceRef),
    paneRef: cleanRef(state.paneRef),
    marker: GRID_CONCIERGE_MARKER,
  };
}

function gridStateSnapshot(wsRef, columns = gridRuntimeState.columns) {
  return {
    wsRef: cleanRef(wsRef),
    anchorSurfaceRef: cleanRef(gridRuntimeState.anchorSurfaceRef),
    concierge: gridConciergeSnapshot(),
    columns: (Array.isArray(columns) ? columns : [])
      .map((column, idx) => gridColumnSnapshot(column, idx))
      .filter(Boolean),
    orphans: (Array.isArray(gridRuntimeState.orphans) ? gridRuntimeState.orphans : [])
      .map((orphan) => ({ ...orphan }))
      .filter((orphan) => orphan.surfaceRef || orphan.paneRef),
    lastRebalance: gridRuntimeState.lastRebalance || null,
  };
}

function gridAwaitingTargets(state) {
  const targets = [];
  const wsRef = cleanRef(state && state.wsRef);
  if (!wsRef) return targets;
  for (const column of (Array.isArray(state.columns) ? state.columns : [])) {
    const ccRef = cleanRef(column && column.cc && column.cc.surfaceRef);
    const cdxRef = cleanRef(column && column.cdx && column.cdx.surfaceRef);
    if (ccRef) targets.push({ role: 'cc', surfaceRef: ccRef, target: column.cc });
    if (cdxRef) targets.push({ role: 'cdx', surfaceRef: cdxRef, target: column.cdx });
  }
  const conciergeRef = cleanRef(state && state.concierge && state.concierge.surfaceRef);
  if (conciergeRef) targets.push({ role: 'concierge', surfaceRef: conciergeRef, target: state.concierge });
  return targets;
}

async function attachGridAwaiting(state) {
  if (!state || !cleanRef(state.wsRef)) return state;
  const targets = gridAwaitingTargets(state);
  await Promise.all(targets.map(async (item) => {
    const screen = await readSurfaceScreen(state.wsRef, item.surfaceRef, { lines: AWAITING_SCREEN_LINES });
    item.target.awaiting = classifyAwaiting(screen, item.role);
    if (item.role === 'cdx') item.target.cdxReady = item.target.process === 'codex' && item.target.awaiting === 'input';
  }));
  return state;
}

function reindexGridColumns() {
  gridRuntimeState.columns.forEach((column, idx) => {
    column.order = idx;
  });
}

hydrateGridRuntimeState();

function dashboardBrowserUrl() {
  const port = parseInt(process.env.CMUX_DASH_PORT || String(DEFAULT_DASHBOARD_PORT), 10) || DEFAULT_DASHBOARD_PORT;
  const rawHost = String(process.env.CMUX_DASH_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

async function findGridWorkspace(opts = {}) {
  return findWorkspaceByTag(GRID_ID, opts);
}

async function ensureGridWorkspace() {
  const knownRef = cleanRef(gridRuntimeState.wsRef);
  if (knownRef && await workspaceRefExists(knownRef, { allowStale: true, quick: true })) {
    await ensureConciergeSurface(knownRef);
    persistGridRuntimeState();
    return knownRef;
  }
  if (knownRef) {
    gridRuntimeState.anchorSurfaceRef = null;
    resetGridConcierge();
  }

  const existing = await findGridWorkspace({
    attempts: GRID_WORKSPACE_LOOKUP_ATTEMPTS,
    delayMs: Math.min(CMUX_SETTLE_MS, 500),
    allowStale: true,
    quick: true,
  });
  if (existing && existing.ref) {
    if (gridRuntimeState.wsRef !== existing.ref) {
      gridRuntimeState.anchorSurfaceRef = null;
      resetGridConcierge();
    }
    gridRuntimeState.wsRef = existing.ref;
    await ensureConciergeSurface(existing.ref);
    persistGridRuntimeState();
    return existing.ref;
  }

  gridRuntimeState.anchorSurfaceRef = null;
  resetGridConcierge();
  const layout = gridWorkspaceLayout([], loadConfig());
  const out = await cmux([
    'new-workspace',
    '--name', 'cmux-dashboard grid',
    '--description', GRID_TAG,
    '--cwd', __dirname,
    '--layout', JSON.stringify(layout),
    '--focus', 'false',
  ]);
  const ref = (out.match(/workspace:\d+/) || [])[0] || null;
  if (!ref) throw new Error('grid workspace was not resolved');
  await settle();
  gridRuntimeState.wsRef = ref;
  gridRuntimeState.anchorSurfaceRef = null;
  resetGridConcierge();
  gridRuntimeState.columns = [];
  gridRuntimeState.orphans = [];
  gridRuntimeState.lastRebalance = null;
  gridRuntimeState.lastRebalanceRepairAt = null;
  await ensureConciergeSurface(ref);
  persistGridRuntimeState();
  return ref;
}

function paneLayout(surface) {
  return { pane: { surfaces: [surface] } };
}

function gridBrowserLayout() {
  return paneLayout({ type: 'browser', url: dashboardBrowserUrl() });
}

function gridTerminalLayout() {
  return paneLayout({ type: 'terminal' });
}

function gridBrowserConciergeLayout() {
  return {
    direction: 'vertical',
    split: 0.5,
    children: [
      gridBrowserLayout(),
      gridTerminalLayout(),
    ],
  };
}

function gridRightAnchorLayout() {
  return gridTerminalLayout();
}

function gridColumnLayout() {
  return {
    direction: 'vertical',
    split: 0.5,
    children: [
      gridTerminalLayout(),
      gridTerminalLayout(),
    ],
  };
}

function equalHorizontalLayout(children) {
  const list = (Array.isArray(children) ? children : []).filter(Boolean);
  if (list.length <= 1) return list[0] || gridBrowserLayout();
  return {
    direction: 'horizontal',
    split: 1 / list.length,
    children: [
      list[0],
      equalHorizontalLayout(list.slice(1)),
    ],
  };
}

function gridMainAreaLayout(columnLayouts) {
  if (!columnLayouts.length) return gridBrowserConciergeLayout();
  return {
    direction: 'horizontal',
    split: GRID_DASHBOARD_SPLIT,
    children: [
      gridBrowserConciergeLayout(),
      equalHorizontalLayout(columnLayouts),
    ],
  };
}

function gridWorkspaceLayout(columns, cfg) {
  const columnLayouts = (Array.isArray(columns) ? columns : []).map((column) => {
    const project = findConfiguredRow(cfg, column.projectId);
    if (!project) throw new Error('unknown project: ' + column.projectId);
    return gridColumnLayout();
  });
  return {
    direction: 'horizontal',
    split: GRID_RIGHT_ANCHOR_SPLIT,
    children: [
      gridMainAreaLayout(columnLayouts),
      gridRightAnchorLayout(),
    ],
  };
}

async function closeGridWorkspaceIfPresent() {
  const existing = await findGridWorkspace({
    attempts: GRID_WORKSPACE_LOOKUP_ATTEMPTS,
    delayMs: Math.min(CMUX_SETTLE_MS, 500),
    allowStale: true,
    quick: true,
  });
  let ref = cleanRef(existing && existing.ref);
  const knownRef = cleanRef(gridRuntimeState.wsRef);
  if (!ref && knownRef && await workspaceRefExists(knownRef, { allowStale: true, quick: true })) {
    ref = knownRef;
  }
  if (!ref) return null;
  try {
    await cmux(['close-workspace', '--workspace', ref]);
    await settle(Math.min(CMUX_SETTLE_MS, 500));
  } catch (_) {}
  return ref;
}

function markerSurface(surfaces, marker) {
  return (Array.isArray(surfaces) ? surfaces : []).find((surface) => {
    const text = slotMarkerSearchText(surface);
    return text.includes(String(marker || '').toLowerCase());
  }) || null;
}

async function listWorkspaceSurfacesWithRetry(wsRef, attempts = 4, markers = []) {
  let surfaces = [];
  const expected = (Array.isArray(markers) ? markers : []).map((marker) => String(marker || '').toLowerCase()).filter(Boolean);
  for (let i = 0; i < attempts; i += 1) {
    surfaces = await listWorkspaceSurfaces(wsRef);
    if (
      surfaces.length &&
      (!expected.length || expected.every((marker) => markerSurface(surfaces, marker)))
    ) return surfaces;
    await settle(Math.min(CMUX_SETTLE_MS, 500));
  }
  return surfaces;
}

function isGridTerminalSurface(surface) {
  if (!surface || !surface.ref) return false;
  const type = String(surface.type || '').toLowerCase();
  if (type === 'browser') return false;
  if (surface.url) return false;
  return true;
}

function gridTerminalSurfaces(surfaces) {
  return (Array.isArray(surfaces) ? surfaces : []).filter(isGridTerminalSurface);
}

function gridBrowserAnchorSurface(surfaces) {
  const list = Array.isArray(surfaces) ? surfaces : [];
  const dashboardUrl = dashboardBrowserUrl();
  return list.find((surface) => surface && surface.type === 'browser' && surface.url === dashboardUrl) ||
    list.find((surface) => surface && surface.type === 'browser') ||
    list.find((surface) => surface && surface.url) ||
    null;
}

async function findGridBrowserAnchorSurface(wsRef, attempts = 6) {
  let surfaces = [];
  for (let i = 0; i < attempts; i += 1) {
    surfaces = await listWorkspaceSurfaces(wsRef);
    const anchor = gridBrowserAnchorSurface(surfaces);
    if (anchor && anchor.ref) return anchor;
    await settle(Math.min(CMUX_SETTLE_MS, 500));
  }
  throw new Error(`grid browser anchor surface was not resolved in ${wsRef}`);
}

function gridColumnSurfaceRefSet(columns = gridRuntimeState.columns) {
  const refs = new Set();
  for (const column of Array.isArray(columns) ? columns : []) {
    const ccRef = cleanRef(column && column.cc && column.cc.surfaceRef);
    const cdxRef = cleanRef(column && column.cdx && column.cdx.surfaceRef);
    if (ccRef) refs.add(ccRef);
    if (cdxRef) refs.add(cdxRef);
  }
  return refs;
}

function parseGridColumnMarker(surface) {
  const text = surfaceMarkerSearchText(surface);
  if (!text) return null;
  const current = text.match(/cmuxdash:grid:__grid__:column:([^:\s'"]+):slot:(cc|cdx)\b/i);
  if (current) {
    return {
      columnId: current[1],
      projectId: current[1],
      slot: current[2].toLowerCase(),
      marker: current[0],
      style: 'grid-column',
    };
  }
  const legacy = text.match(/cmuxdash:grid:([^:\s'"]+):slot:(cc|cdx)\b/i);
  if (legacy && legacy[1] !== GRID_ID) {
    return {
      columnId: legacy[1],
      projectId: legacy[1],
      slot: legacy[2].toLowerCase(),
      marker: legacy[0],
      style: 'legacy-column',
    };
  }
  return null;
}

function hasUnrecognizedGridMarker(surface) {
  const text = slotMarkerSearchText(surface);
  return text.includes(GRID_MARK_PREFIX) &&
    !parseGridColumnMarker(surface) &&
    !text.includes(GRID_CONCIERGE_MARKER.toLowerCase()) &&
    !text.includes(GRID_RIGHT_ANCHOR_MARKER.toLowerCase());
}

function isGridRightAnchorSurface(surface) {
  if (!surface || !surface.ref) return false;
  const knownRef = cleanRef(gridRuntimeState.anchorSurfaceRef);
  if (knownRef && cleanRef(surface.ref) === knownRef) return true;
  return slotMarkerSearchText(surface).includes(GRID_RIGHT_ANCHOR_MARKER.toLowerCase());
}

function markedGridRightAnchorSurface(surfaces) {
  return markerSurface(surfaces, GRID_RIGHT_ANCHOR_MARKER);
}

function gridProjectOrderIndex(cfg) {
  const order = new Map();
  configuredRows(cfg).forEach((project, idx) => {
    if (project && project.id && !order.has(project.id)) order.set(project.id, idx);
  });
  return order;
}

function gridOrphanSurface(surface, reason, extra = {}) {
  return {
    surfaceRef: cleanRef(surface && surface.ref),
    paneRef: cleanRef(surface && surface.paneRef),
    title: surface && surface.title || null,
    type: surface && surface.type || null,
    process: surface && surface.process || null,
    reason,
    ...extra,
  };
}

function validExistingGridColumn(column, byRef, wsRef) {
  const ccRef = cleanRef(column && column.cc && column.cc.surfaceRef);
  const cdxRef = cleanRef(column && column.cdx && column.cdx.surfaceRef);
  if (!column || !ccRef || !cdxRef || !byRef.has(ccRef) || !byRef.has(cdxRef)) return null;
  const cc = byRef.get(ccRef);
  const cdx = byRef.get(cdxRef);
  return {
    ...column,
    wsRef,
    cc: { ...column.cc, paneRef: cc && cc.paneRef || column.cc.paneRef || null },
    cdx: { ...column.cdx, paneRef: cdx && cdx.paneRef || column.cdx.paneRef || null },
  };
}

function classifyGridColumnProcessSlot(surface, processMap = {}) {
  const matches = new Set();
  for (const value of surfaceProcessValues(surface, processMap)) {
    if (SLOT_DEFS.cc.processRe.test(value) || classifyProcess(value) === 'C') matches.add('cc');
    if (SLOT_DEFS.cdx.processRe.test(value) || classifyProcess(value) === 'X') matches.add('cdx');
  }
  return matches.size === 1 ? Array.from(matches)[0] : null;
}

function addGridColumnSurfaceRefs(set, column) {
  for (const slot of ['cc', 'cdx']) {
    const ref = cleanRef(column && column[slot] && column[slot].surfaceRef);
    if (ref) set.add(ref);
  }
}

function buildAdoptedGridColumns(wsRef, surfaces, cfg, now = new Date().toISOString(), opts = {}) {
  const processMap = opts && opts.processMap || {};
  const byRef = liveSurfaceIndex(surfaces);
  const records = new Map();
  const markerOrphans = [];
  const surfaceOrder = new Map();
  (Array.isArray(surfaces) ? surfaces : []).forEach((surface, idx) => {
    if (surface && surface.ref) surfaceOrder.set(surface.ref, idx);
    const marker = parseGridColumnMarker(surface);
    if (!marker) {
      if (hasUnrecognizedGridMarker(surface)) markerOrphans.push(gridOrphanSurface(surface, 'unrecognized_grid_marker'));
      return;
    }
    const projectId = cleanRef(marker.projectId);
    if (!projectId) {
      markerOrphans.push(gridOrphanSurface(surface, 'empty_grid_column_marker', { marker: marker.marker, slot: marker.slot }));
      return;
    }
    const record = records.get(projectId) || {
      columnId: gridColumnId(marker.columnId || projectId),
      projectId,
      firstIndex: idx,
      markers: {},
      cc: null,
      cdx: null,
      duplicateSurfaces: [],
    };
    if (record[marker.slot]) {
      record.duplicateSurfaces.push({ surface, marker });
    } else {
      record[marker.slot] = surface;
      record.markers[marker.slot] = marker.marker;
      record.firstIndex = Math.min(record.firstIndex, idx);
    }
    records.set(projectId, record);
  });

  const existingByProject = new Map();
  for (const column of Array.isArray(gridRuntimeState.columns) ? gridRuntimeState.columns : []) {
    const live = validExistingGridColumn(column, byRef, wsRef);
    if (live && live.projectId && !existingByProject.has(live.projectId)) {
      existingByProject.set(live.projectId, {
        ...live,
        firstIndex: Math.min(
          surfaceOrder.get(live.cc.surfaceRef) ?? Number.MAX_SAFE_INTEGER,
          surfaceOrder.get(live.cdx.surfaceRef) ?? Number.MAX_SAFE_INTEGER,
        ),
      });
    }
  }

  const merged = new Map(existingByProject);
  for (const record of records.values()) {
    for (const duplicate of record.duplicateSurfaces) {
      markerOrphans.push(gridOrphanSurface(duplicate.surface, 'duplicate_grid_column_marker', {
        projectId: record.projectId,
        slot: duplicate.marker && duplicate.marker.slot || null,
        marker: duplicate.marker && duplicate.marker.marker || null,
      }));
    }
    if (!record.cc || !record.cdx) {
      if (existingByProject.has(record.projectId)) continue;
      for (const slot of ['cc', 'cdx']) {
        if (record[slot]) {
          markerOrphans.push(gridOrphanSurface(record[slot], 'incomplete_grid_column_marker', {
            projectId: record.projectId,
            slot,
            marker: record.markers[slot] || null,
          }));
        }
      }
      continue;
    }
    const existing = existingByProject.get(record.projectId);
    if (existing) continue;
    merged.set(record.projectId, {
      columnId: gridColumnId(record.columnId || record.projectId),
      projectId: record.projectId,
      wsRef,
      firstIndex: record.firstIndex,
      cc: {
        surfaceRef: record.cc.ref,
        paneRef: record.cc.paneRef || null,
        marker: gridSlotMarker(record.columnId || record.projectId, 'cc'),
      },
      cdx: {
        surfaceRef: record.cdx.ref,
        paneRef: record.cdx.paneRef || null,
        marker: gridSlotMarker(record.columnId || record.projectId, 'cdx'),
      },
      createdAt: existing && existing.createdAt || now,
      updatedAt: now,
      adopted: !existing,
    });
  }

  const claimedSurfaceRefs = new Set();
  for (const column of merged.values()) addGridColumnSurfaceRefs(claimedSurfaceRefs, column);
  for (const record of records.values()) {
    for (const slot of ['cc', 'cdx']) {
      const ref = cleanRef(record[slot] && record[slot].ref);
      if (ref) claimedSurfaceRefs.add(ref);
    }
    for (const duplicate of record.duplicateSurfaces) {
      const ref = cleanRef(duplicate && duplicate.surface && duplicate.surface.ref);
      if (ref) claimedSurfaceRefs.add(ref);
    }
  }
  for (const surface of [
    gridBrowserAnchorSurface(surfaces),
    markedOrKnownGridConciergeSurface(surfaces),
    markedGridRightAnchorSurface(surfaces),
    gridRuntimeState.anchorSurfaceRef ? { ref: gridRuntimeState.anchorSurfaceRef } : null,
  ]) {
    const ref = cleanRef(surface && surface.ref);
    if (ref) claimedSurfaceRefs.add(ref);
  }

  for (const project of configuredProjectRows(cfg)) {
    const projectId = cleanRef(project && project.id);
    if (!projectId || merged.has(projectId)) continue;
    const candidates = { cc: [], cdx: [] };
    for (const surface of Array.isArray(surfaces) ? surfaces : []) {
      if (!isGridTerminalSurface(surface)) continue;
      const ref = cleanRef(surface && surface.ref);
      if (!ref || claimedSurfaceRefs.has(ref)) continue;
      if (parseGridColumnMarker(surface) || hasUnrecognizedGridMarker(surface)) continue;
      const cwdProcesses = surfaceProcessEntriesMatchingProjectCwd(surface, processMap, project);
      if (!cwdProcesses.length) continue;
      const scopedProcessMap = {};
      scopedProcessMap[ref] = cwdProcesses;
      const slot = classifyGridColumnProcessSlot({ ref }, scopedProcessMap);
      if (slot === 'cc' || slot === 'cdx') candidates[slot].push(surface);
    }
    if (candidates.cc.length !== 1 || candidates.cdx.length !== 1) continue;
    const cc = candidates.cc[0];
    const cdx = candidates.cdx[0];
    const columnId = gridColumnId(projectId);
    merged.set(projectId, {
      columnId,
      projectId,
      wsRef,
      firstIndex: Math.min(
        surfaceOrder.get(cc.ref) ?? Number.MAX_SAFE_INTEGER,
        surfaceOrder.get(cdx.ref) ?? Number.MAX_SAFE_INTEGER,
      ),
      cc: {
        surfaceRef: cc.ref,
        paneRef: cc.paneRef || null,
        marker: gridSlotMarker(columnId, 'cc'),
      },
      cdx: {
        surfaceRef: cdx.ref,
        paneRef: cdx.paneRef || null,
        marker: gridSlotMarker(columnId, 'cdx'),
      },
      createdAt: now,
      updatedAt: now,
      adopted: true,
    });
    claimedSurfaceRefs.add(cc.ref);
    claimedSurfaceRefs.add(cdx.ref);
  }

  const order = gridProjectOrderIndex(cfg);
  const columns = Array.from(merged.values()).sort((a, b) => {
    const ai = order.has(a.projectId) ? order.get(a.projectId) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.projectId) ? order.get(b.projectId) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    const af = Number.isFinite(a.firstIndex) ? a.firstIndex : Number.MAX_SAFE_INTEGER;
    const bf = Number.isFinite(b.firstIndex) ? b.firstIndex : Number.MAX_SAFE_INTEGER;
    if (af !== bf) return af - bf;
    return String(a.projectId || '').localeCompare(String(b.projectId || ''));
  }).map((column, idx) => {
    const { firstIndex, adopted, ...rest } = column;
    return { ...rest, order: idx, ...(adopted ? { adopted: true } : {}) };
  });

  return { columns, markerOrphans };
}

function gridRuntimeOrphansFromSurfaces(surfaces, columns, known = {}, extra = []) {
  const interpreted = gridColumnSurfaceRefSet(columns);
  for (const ref of [
    known.browserSurfaceRef,
    known.conciergeSurfaceRef,
    known.rightAnchorSurfaceRef,
  ]) {
    const clean = cleanRef(ref);
    if (clean) interpreted.add(clean);
  }
  const orphans = [...extra];
  for (const surface of Array.isArray(surfaces) ? surfaces : []) {
    if (!surface || !surface.ref || interpreted.has(surface.ref)) continue;
    if (!isGridTerminalSurface(surface)) continue;
    if (parseGridColumnMarker(surface)) continue;
    if (slotMarkerSearchText(surface).includes(GRID_CONCIERGE_MARKER.toLowerCase())) continue;
    if (slotMarkerSearchText(surface).includes(GRID_RIGHT_ANCHOR_MARKER.toLowerCase())) continue;
    orphans.push(gridOrphanSurface(surface, hasUnrecognizedGridMarker(surface) ? 'unrecognized_grid_marker' : 'unmanaged_grid_terminal'));
  }
  const seen = new Set();
  return orphans.filter((orphan) => {
    const key = `${orphan.surfaceRef || ''}:${orphan.paneRef || ''}:${orphan.reason || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isGridConciergeSurface(surface) {
  if (!surface || !surface.ref) return false;
  const state = gridRuntimeState.concierge || {};
  const knownRef = cleanRef(state.surfaceRef);
  if (knownRef && cleanRef(surface.ref) === knownRef) return true;
  return slotMarkerSearchText(surface).includes(GRID_CONCIERGE_MARKER.toLowerCase());
}

function markedOrKnownGridConciergeSurface(surfaces) {
  const list = Array.isArray(surfaces) ? surfaces : [];
  const state = gridRuntimeState.concierge || {};
  const knownRef = cleanRef(state.surfaceRef);
  if (knownRef) {
    const known = list.find((surface) => surface && cleanRef(surface.ref) === knownRef);
    if (known) return known;
  }
  return markerSurface(list, GRID_CONCIERGE_MARKER);
}

function inferUnmarkedGridConciergeSurface(surfaces, columns = gridRuntimeState.columns) {
  const list = Array.isArray(surfaces) ? surfaces : [];
  const columnRefs = gridColumnSurfaceRefSet(columns);
  const anchor = gridRightAnchorSurface(list, columns);
  const anchorRef = cleanRef(anchor && anchor.ref);
  const candidates = list.filter((surface) => (
    surface &&
    surface.ref &&
    isGridTerminalSurface(surface) &&
    !columnRefs.has(surface.ref) &&
    cleanRef(surface.ref) !== anchorRef &&
    !isGridColumnLikeTerminalSurface(surface)
  ));
  return candidates[0] || null;
}

function isGridColumnLikeTerminalSurface(surface) {
  const markerText = slotMarkerSearchText(surface);
  if (markerText.includes(GRID_MARK_PREFIX)) return true;
  const processName = String(surface && surface.process || '').toLowerCase();
  return processName === 'claude' || processName === 'codex';
}

function gridRightAnchorSurface(surfaces, columns = gridRuntimeState.columns) {
  const list = Array.isArray(surfaces) ? surfaces : [];
  const columnRefs = gridColumnSurfaceRefSet(columns);
  const knownRef = cleanRef(gridRuntimeState.anchorSurfaceRef);
  const marked = markedGridRightAnchorSurface(list);
  if (marked && marked.ref) return marked;
  const candidates = list.filter((surface) => (
    surface &&
    surface.ref &&
    isGridTerminalSurface(surface) &&
    !columnRefs.has(surface.ref) &&
    !isGridConciergeSurface(surface) &&
    !parseGridColumnMarker(surface) &&
    !isGridColumnLikeTerminalSurface(surface)
  ));
  if (knownRef) {
    const known = candidates.find((surface) => cleanRef(surface.ref) === knownRef);
    if (known) return known;
  }
  return candidates[candidates.length - 1] || null;
}

async function findGridRightAnchorSurface(wsRef, attempts = 6) {
  let surfaces = [];
  for (let i = 0; i < attempts; i += 1) {
    surfaces = await listWorkspaceSurfaces(wsRef);
    const anchor = gridRightAnchorSurface(surfaces);
    if (anchor && anchor.ref) {
      gridRuntimeState.anchorSurfaceRef = anchor.ref;
      return anchor;
    }
    await settle(Math.min(CMUX_SETTLE_MS, 500));
  }
  throw new Error(`grid right anchor surface was not resolved in ${wsRef}`);
}

function gridColumnPaneRefs(column) {
  return [
    column && column.cc && column.cc.paneRef,
    column && column.cdx && column.cdx.paneRef,
  ].map(cleanRef).filter(Boolean);
}

function gridColumnResizePaneRef(column, frameByPane) {
  const refs = gridColumnPaneRefs(column);
  return refs.find((ref) => frameByPane.has(ref)) || refs[0] || null;
}

function paneBoundsForRefs(frameByPane, refs) {
  const frames = (Array.isArray(refs) ? refs : [])
    .map((ref) => frameByPane.get(cleanRef(ref)))
    .filter(Boolean);
  if (!frames.length) return null;
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.width));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
  return { x: left, y: top, width: right - left, height: bottom - top, right, bottom };
}

function paneGeometryIndex(panes) {
  const byRef = new Map();
  const frames = [];
  let cellWidthPx = null;
  for (const pane of Array.isArray(panes) ? panes : []) {
    const ref = cleanRef(pane && pane.ref);
    const frame = panePixelFrame(pane);
    if (!ref || !frame) continue;
    byRef.set(ref, frame);
    frames.push({ ref, pane, frame });
    const paneCellWidth = paneCellWidthPx(pane, frame);
    if (paneCellWidth && (!cellWidthPx || paneCellWidth < cellWidthPx)) cellWidthPx = paneCellWidth;
  }
  return { byRef, frames, cellWidthPx: cellWidthPx || 8 };
}

function boundsForFrames(frames) {
  if (!Array.isArray(frames) || !frames.length) return null;
  const left = Math.min(...frames.map((item) => item.frame.x));
  const top = Math.min(...frames.map((item) => item.frame.y));
  const right = Math.max(...frames.map((item) => item.frame.x + item.frame.width));
  const bottom = Math.max(...frames.map((item) => item.frame.y + item.frame.height));
  return { x: left, y: top, width: right - left, height: bottom - top, right, bottom };
}

function gridRebalanceTolerancePx(targetPx, cellWidthPx, tolerance = GRID_REBALANCE_TOLERANCE) {
  const target = Math.abs(Number(targetPx));
  const ratio = Number(tolerance);
  return Math.max(
    Number(cellWidthPx) || 1,
    Number.isFinite(target) ? target * (Number.isFinite(ratio) && ratio > 0 ? ratio : GRID_REBALANCE_TOLERANCE) : 0,
  );
}

function gridResizeCoefficientPxPerAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : GRID_RESIZE_FALLBACK_PX_PER_AMOUNT;
}

function gridBoundaryOutsideTolerance(boundary, tolerance = GRID_REBALANCE_TOLERANCE) {
  const actual = Number(boundary && boundary.actualPx);
  const target = Number(boundary && (boundary.targetRightPx != null ? boundary.targetRightPx : boundary.targetPx));
  if (!Number.isFinite(actual) || !Number.isFinite(target)) return false;
  const tolerancePx = gridRebalanceTolerancePx(target, boundary && boundary.toleranceCellWidthPx, tolerance);
  return Math.abs(actual - target) > tolerancePx;
}

function gridResizeCalibrationFromSnapshot(operations, snapshot) {
  if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.boundaries)) return null;
  const byName = new Map(snapshot.boundaries.map((boundary) => [boundary.name, boundary]));
  const samples = [];
  let totalMovePx = 0;
  let totalAmount = 0;
  for (const op of Array.isArray(operations) ? operations : []) {
    if (!op || !op.resized || !op.name) continue;
    const amount = Number(op.amount);
    const before = Number(op.actualBoundaryPx);
    const next = byName.get(op.name);
    const after = Number(next && next.actualPx);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(before) || !Number.isFinite(after)) continue;
    const direction = String(op.direction || '');
    const signedMovePx = direction === '-R' || direction === 'R'
      ? after - before
      : before - after;
    if (!Number.isFinite(signedMovePx) || signedMovePx <= 0) continue;
    const pxPerAmount = signedMovePx / amount;
    if (!Number.isFinite(pxPerAmount) || pxPerAmount <= 0) continue;
    samples.push({
      name: op.name,
      amount,
      observedMovePx: Math.round(signedMovePx),
      pxPerAmount,
    });
    totalMovePx += signedMovePx;
    totalAmount += amount;
  }
  if (!samples.length || totalAmount <= 0) return null;
  return {
    pxPerAmount: gridResizeCoefficientPxPerAmount(totalMovePx / totalAmount),
    observedMovePx: Math.round(totalMovePx),
    amount: totalAmount,
    samples,
  };
}

function gridResizeObservationsFromSnapshot(operations, snapshot) {
  if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.boundaries)) return [];
  const byName = new Map(snapshot.boundaries.map((boundary) => [boundary.name, boundary]));
  const minMovePx = Math.max(1, Number(snapshot.geometry && snapshot.geometry.cellWidthPx) * 0.25 || 1);
  return (Array.isArray(operations) ? operations : []).map((op) => {
    if (!op || !op.resized || !op.name) return null;
    const before = Number(op.actualBoundaryPx);
    const next = byName.get(op.name);
    const after = Number(next && next.actualPx);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
    const observedMovePx = after - before;
    return {
      name: op.name,
      beforePx: Math.round(before),
      afterPx: Math.round(after),
      observedMovePx: Math.round(observedMovePx),
      absObservedMovePx: Math.abs(observedMovePx),
      moved: Math.abs(observedMovePx) >= minMovePx,
      minMovePx,
      operation: op,
    };
  }).filter(Boolean);
}

function fallbackPaneRefByPosition(frames, excludedRefs, side) {
  const candidates = (Array.isArray(frames) ? frames : [])
    .filter((item) => item && item.ref && !(excludedRefs || new Set()).has(item.ref));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ax = side === 'right' ? a.frame.x + a.frame.width : a.frame.x;
    const bx = side === 'right' ? b.frame.x + b.frame.width : b.frame.x;
    return side === 'right' ? bx - ax : ax - bx;
  });
  return candidates[0].ref;
}

function gridRebalanceMetric(name, actualPx, targetPx, cellWidthPx, extra = {}) {
  const actual = Number(actualPx);
  const target = Number(targetPx);
  const diffPx = actual - target;
  const tolerancePx = gridRebalanceTolerancePx(target, cellWidthPx, GRID_REBALANCE_TOLERANCE);
  return {
    name,
    actualPx: Math.round(actual),
    targetPx: Math.round(target),
    diffPx: Math.round(diffPx),
    tolerancePx: Math.round(tolerancePx),
    withinTolerance: Math.abs(diffPx) <= tolerancePx,
    ...extra,
  };
}

function gridRebalanceExpectedPaneRefs(columns, surfaces) {
  const refs = [];
  const push = (role, ref, extra = {}) => {
    const clean = cleanRef(ref);
    if (clean) refs.push({ role, ref: clean, ...extra });
  };
  for (const [index, column] of (Array.isArray(columns) ? columns : []).entries()) {
    const projectId = column && (column.projectId || column.columnId) || null;
    push('column.cc', column && column.cc && column.cc.paneRef, { index, slot: 'cc', projectId });
    push('column.cdx', column && column.cdx && column.cdx.paneRef, { index, slot: 'cdx', projectId });
  }
  const browserSurface = gridBrowserAnchorSurface(surfaces);
  const conciergeSurface = markedOrKnownGridConciergeSurface(surfaces);
  const anchorSurface = gridRightAnchorSurface(surfaces, columns);
  push('browser', browserSurface && browserSurface.paneRef, { surfaceRef: browserSurface && browserSurface.ref || null });
  push('concierge', conciergeSurface && conciergeSurface.paneRef, { surfaceRef: conciergeSurface && conciergeSurface.ref || null });
  push('rightAnchor', anchorSurface && anchorSurface.paneRef, { surfaceRef: anchorSurface && anchorSurface.ref || null });

  const seen = new Set();
  return refs.filter((item) => {
    if (!item.ref || seen.has(item.ref)) return false;
    seen.add(item.ref);
    return true;
  });
}

function gridRebalancePaneReadInfo(read) {
  const expectedPaneRefs = Array.isArray(read && read.expectedRefs) ? read.expectedRefs : [];
  const missingPaneRefs = Array.isArray(read && read.missingRefs) ? read.missingRefs : [];
  return {
    attempts: Number(read && read.attempt) || 0,
    maxAttempts: Number(read && read.attempts) || GRID_REBALANCE_PANE_READ_ATTEMPTS,
    delayMs: Number(read && read.delayMs) || GRID_REBALANCE_PANE_READ_DELAY_MS,
    frameCount: read && read.geometry && Array.isArray(read.geometry.frames) ? read.geometry.frames.length : 0,
    expectedPaneRefs,
    missingPaneRefs,
    ...(read && read.error ? { error: read.error } : {}),
  };
}

async function readGridRebalancePanesWithRetry(wsRef, columns, surfaces, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts) || GRID_REBALANCE_PANE_READ_ATTEMPTS);
  const delayMs = Math.max(0, Number(opts.delayMs) || GRID_REBALANCE_PANE_READ_DELAY_MS);
  const expectedRefs = gridRebalanceExpectedPaneRefs(columns, surfaces);
  let last = {
    panes: [],
    geometry: paneGeometryIndex([]),
    expectedRefs,
    missingRefs: expectedRefs,
    attempt: 0,
    attempts,
    delayMs,
    error: null,
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let panes = [];
    let error = null;
    try {
      panes = await readWorkspacePanes(wsRef);
    } catch (err) {
      error = summarizeError(err);
    }
    const geometry = paneGeometryIndex(panes);
    const missingRefs = expectedRefs.filter((item) => item && item.ref && !geometry.byRef.has(item.ref));
    last = { panes, geometry, expectedRefs, missingRefs, attempt, attempts, delayMs, error };
    if (geometry.frames.length && !missingRefs.length) return last;
    if (attempt < attempts) await sleep(delayMs);
  }
  return last;
}

function gridRebalanceMeasurementSummary(measurements) {
  return (Array.isArray(measurements) ? measurements : []).map((item) => ({
    name: item.name,
    actualPx: item.actualPx,
    targetPx: item.targetPx,
    diffPx: item.diffPx,
    tolerancePx: item.tolerancePx,
    withinTolerance: item.withinTolerance,
    ...(item.paneRef ? { paneRef: item.paneRef } : {}),
    ...(item.index != null ? { index: item.index } : {}),
  }));
}

function gridRebalanceBoundarySummary(boundaries) {
  return (Array.isArray(boundaries) ? boundaries : []).map((item) => ({
    name: item.name,
    leftPaneRef: item.leftPaneRef,
    rightPaneRef: item.rightPaneRef,
    paneRef: item.paneRef,
    actualPx: item.actualPx,
    targetPx: item.targetPx,
    targetRightPx: item.targetRightPx,
    diffPx: item.diffPx,
    tolerancePx: item.tolerancePx,
    withinTolerance: item.withinTolerance,
    ...(item.anchorSliver ? { anchorSliver: true } : {}),
    ...(item.sliverThresholdPx != null ? { sliverThresholdPx: item.sliverThresholdPx } : {}),
    ...(item.frameSource ? { frameSource: item.frameSource } : {}),
    ...(item.index != null ? { index: item.index } : {}),
  }));
}

function gridRebalancePassRecord(pass, snapshot, extra = {}) {
  const record = { pass, ...extra };
  if (snapshot && snapshot.paneRead) record.paneRead = snapshot.paneRead;
  if (!snapshot || !snapshot.ok) {
    return {
      ...record,
      rebalanced: false,
      error: snapshot && (snapshot.reason || snapshot.error) || 'snapshot unavailable',
    };
  }
  return {
    ...record,
    rebalanced: snapshot.withinTolerance,
    withinTolerance: snapshot.withinTolerance,
    measurements: snapshot.measurements,
    summary: gridRebalanceMeasurementSummary(snapshot.measurements),
    boundaries: gridRebalanceBoundarySummary(snapshot.boundaries),
    target: snapshot.target,
  };
}

function gridRebalanceTargets(container, columnCount) {
  const browserWidth = Math.max(1, Math.round(container.width * GRID_DASHBOARD_SPLIT));
  const maxAnchorWidth = Math.max(1, container.width - browserWidth - columnCount);
  const anchorWidth = Math.min(maxAnchorWidth, Math.max(1, Math.round(container.width * 0.02)));
  const columnsWidth = container.width - browserWidth - anchorWidth;
  if (columnsWidth <= 0) return null;
  return {
    containerWidth: container.width,
    browserWidth,
    anchorWidth,
    columnWidth: columnsWidth / columnCount,
    columnCount,
    tolerance: GRID_REBALANCE_TOLERANCE,
    repairTolerance: GRID_REBALANCE_REPAIR_TOLERANCE,
  };
}

function gridBoundaryActualPx(leftFrame, rightFrame) {
  const values = [];
  if (leftFrame) values.push(leftFrame.x + leftFrame.width);
  if (rightFrame) values.push(rightFrame.x);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gridRebalanceBoundaryRecord(boundary, geometry, cellWidthPx, tolerance = GRID_REBALANCE_TOLERANCE) {
  const leftPaneRef = cleanRef(boundary && boundary.leftPaneRef);
  const rightPaneRef = cleanRef(boundary && boundary.rightPaneRef);
  const targetRightPx = Number(boundary && boundary.targetRightPx);
  const toleranceBasisPx = Number(boundary && boundary.toleranceBasisPx);
  const leftFrame = leftPaneRef ? geometry.byRef.get(leftPaneRef) : null;
  const rightFrame = rightPaneRef ? geometry.byRef.get(rightPaneRef) : null;
  const actual = gridBoundaryActualPx(leftFrame, rightFrame);
  const target = Number.isFinite(targetRightPx) ? targetRightPx : 0;
  const tolerancePx = gridRebalanceTolerancePx(
    Number.isFinite(toleranceBasisPx) && toleranceBasisPx > 0 ? toleranceBasisPx : target,
    cellWidthPx,
    tolerance,
  );
  const diffPx = Number.isFinite(actual) ? actual - target : null;
  return {
    name: boundary && boundary.name || 'boundary',
    leftPaneRef,
    rightPaneRef,
    paneRef: leftPaneRef,
    targetRightPx: Number.isFinite(targetRightPx) ? targetRightPx : null,
    targetPx: Math.round(target),
    actualPx: Number.isFinite(actual) ? Math.round(actual) : null,
    diffPx: Number.isFinite(diffPx) ? Math.round(diffPx) : null,
    tolerancePx: Math.round(tolerancePx),
    toleranceCellWidthPx: Number(cellWidthPx) || 1,
    withinTolerance: Number.isFinite(diffPx) ? Math.abs(diffPx) <= tolerancePx : false,
    ...(boundary && boundary.index != null ? { index: boundary.index } : {}),
  };
}

async function readGridRebalanceSnapshot(wsRef, columns, surfaces) {
  const paneRead = await readGridRebalancePanesWithRetry(wsRef, columns, surfaces);
  const geometry = paneRead.geometry;
  const paneReadInfo = gridRebalancePaneReadInfo(paneRead);
  if (!geometry.frames.length) return { ok: false, reason: 'missing pixel frames', paneRead: paneReadInfo };

  const browserSurface = gridBrowserAnchorSurface(surfaces);
  const conciergeSurface = markedOrKnownGridConciergeSurface(surfaces);
  const anchorSurface = gridRightAnchorSurface(surfaces, columns);
  const columnPaneRefs = new Set(columns.flatMap(gridColumnPaneRefs));
  const excludedForBrowser = new Set(columnPaneRefs);
  const anchorPaneRefFromSurface = cleanRef(anchorSurface && anchorSurface.paneRef);
  if (anchorPaneRefFromSurface) excludedForBrowser.add(anchorPaneRefFromSurface);
  const conciergePaneRefFromSurface = cleanRef(conciergeSurface && conciergeSurface.paneRef);
  if (conciergePaneRefFromSurface) excludedForBrowser.add(conciergePaneRefFromSurface);

  let browserPaneRef = cleanRef(browserSurface && browserSurface.paneRef);
  if (!browserPaneRef || !geometry.byRef.has(browserPaneRef)) {
    browserPaneRef = fallbackPaneRefByPosition(geometry.frames, excludedForBrowser, 'left');
  }
  if (!browserPaneRef || !geometry.byRef.has(browserPaneRef)) {
    return { ok: false, reason: 'missing browser pane frame', paneRead: paneReadInfo };
  }

  let anchorPaneRef = anchorPaneRefFromSurface;
  if (!anchorPaneRef || !geometry.byRef.has(anchorPaneRef)) {
    const excludedForAnchor = new Set(columnPaneRefs);
    excludedForAnchor.add(browserPaneRef);
    if (conciergePaneRefFromSurface) excludedForAnchor.add(conciergePaneRefFromSurface);
    anchorPaneRef = fallbackPaneRefByPosition(geometry.frames, excludedForAnchor, 'right');
  }
  if (!anchorPaneRef || !geometry.byRef.has(anchorPaneRef)) {
    return { ok: false, reason: 'missing right anchor pane frame', paneRead: paneReadInfo };
  }

  const orderedColumns = columns
    .map((column) => {
      const refs = gridColumnPaneRefs(column);
      const bounds = paneBoundsForRefs(geometry.byRef, refs);
      return {
        column,
        refs,
        bounds,
        resizePaneRef: gridColumnResizePaneRef(column, geometry.byRef),
      };
    })
    .filter((item) => item.bounds && item.resizePaneRef)
    .sort((a, b) => a.bounds.x - b.bounds.x);
  if (orderedColumns.length !== columns.length) {
    return { ok: false, reason: 'missing column pane frames', paneRead: paneReadInfo };
  }

  const container = boundsForFrames(geometry.frames);
  if (!container || container.width <= 0) return { ok: false, reason: 'missing container frame', paneRead: paneReadInfo };
  const target = gridRebalanceTargets(container, orderedColumns.length);
  if (!target) return { ok: false, reason: 'insufficient container width', paneRead: paneReadInfo };

  const leftAreaPaneRefs = [browserPaneRef, conciergePaneRefFromSurface]
    .map(cleanRef)
    .filter((paneRef) => paneRef && geometry.byRef.has(paneRef));
  const browserFrame = paneBoundsForRefs(geometry.byRef, leftAreaPaneRefs) || geometry.byRef.get(browserPaneRef);
  const anchorSurfaceFrame = surfacePixelFrame(anchorSurface);
  const anchorFrame = anchorSurfaceFrame || geometry.byRef.get(anchorPaneRef);
  const anchorFrameSource = anchorSurfaceFrame ? 'surface_frame' : 'pane_frame_re_read';
  const anchorSliverThresholdPx = Math.max(1, container.width * GRID_RIGHT_ANCHOR_SLIVER_RATIO);
  const anchorSliver = !!(anchorFrame && anchorFrame.width < anchorSliverThresholdPx);
  const measurements = [
    gridRebalanceMetric('browser', browserFrame.width, target.browserWidth, geometry.cellWidthPx, { paneRef: browserPaneRef }),
    ...orderedColumns.map((item, idx) => gridRebalanceMetric(
      `column:${item.column.projectId || item.column.columnId || idx}`,
      item.bounds.width,
      target.columnWidth,
      geometry.cellWidthPx,
      { paneRef: item.resizePaneRef, index: idx },
    )),
    gridRebalanceMetric('rightAnchor', anchorFrame.width, target.anchorWidth, geometry.cellWidthPx, {
      paneRef: anchorPaneRef,
      frameSource: anchorFrameSource,
      sliver: anchorSliver,
      sliverThresholdPx: Math.round(anchorSliverThresholdPx),
    }),
  ];
  const boundarySpecs = [
    {
      name: `browser|column:${orderedColumns[0].column.projectId || orderedColumns[0].column.columnId || 0}`,
      leftPaneRef: browserPaneRef,
      rightPaneRef: orderedColumns[0].resizePaneRef,
      targetRightPx: container.x + target.browserWidth,
      toleranceBasisPx: target.browserWidth,
    },
    ...orderedColumns.map((item, idx) => {
      const next = orderedColumns[idx + 1];
      return {
        name: next
          ? `column:${item.column.projectId || item.column.columnId || idx}|column:${next.column.projectId || next.column.columnId || idx + 1}`
          : `column:${item.column.projectId || item.column.columnId || idx}|rightAnchor`,
        leftPaneRef: item.resizePaneRef,
        rightPaneRef: next ? next.resizePaneRef : anchorPaneRef,
        targetRightPx: container.x + target.browserWidth + target.columnWidth * (idx + 1),
        toleranceBasisPx: target.columnWidth,
        index: idx,
      };
    }),
  ];
  const boundaries = boundarySpecs.map((boundary) => gridRebalanceBoundaryRecord(boundary, geometry, geometry.cellWidthPx));
  if (anchorSliver && boundaries.length) {
    const last = boundaries[boundaries.length - 1];
    boundaries[boundaries.length - 1] = {
      ...last,
      withinTolerance: false,
      anchorSliver: true,
      sliverThresholdPx: Math.round(anchorSliverThresholdPx),
      frameSource: anchorFrameSource,
    };
  }
  return {
    ok: true,
    geometry,
    paneRead: paneReadInfo,
    target,
    measurements,
    boundaries,
    rightAnchor: {
      paneRef: anchorPaneRef,
      surfaceRef: anchorSurface && anchorSurface.ref || null,
      widthPx: Math.round(anchorFrame.width),
      sliver: anchorSliver,
      sliverThresholdPx: Math.round(anchorSliverThresholdPx),
      frameSource: anchorFrameSource,
    },
    withinTolerance: (
      measurements.every((item) => item.withinTolerance) &&
      boundaries.every((item) => item.withinTolerance) &&
      !anchorSliver
    ),
  };
}

async function resizeGridBoundary(wsRef, boundaryOrPaneRef, targetRightPx, cellWidthHintPx, opts = {}) {
  const ws = cleanRef(wsRef);
  if (!ws) return { resized: false, reason: 'missing workspace ref' };
  const boundary = (boundaryOrPaneRef && typeof boundaryOrPaneRef === 'object')
    ? boundaryOrPaneRef
    : { leftPaneRef: boundaryOrPaneRef, paneRef: boundaryOrPaneRef, targetRightPx };
  const leftPaneRef = cleanRef(boundary.leftPaneRef || boundary.paneRef);
  const rightPaneRef = cleanRef(boundary.rightPaneRef);
  const target = Number(boundary.targetRightPx);
  if (!leftPaneRef && !rightPaneRef) return { resized: false, reason: 'missing boundary pane refs' };
  if (!Number.isFinite(target)) return { resized: false, reason: 'missing boundary target' };
  const panes = await readWorkspacePanes(ws);
  const geometry = paneGeometryIndex(panes);
  const leftFrame = leftPaneRef ? geometry.byRef.get(leftPaneRef) : null;
  const rightFrame = rightPaneRef ? geometry.byRef.get(rightPaneRef) : null;
  if (!leftFrame && !rightFrame) return { resized: false, reason: 'missing boundary pane frames', leftPaneRef, rightPaneRef };
  const cellWidthPx = geometry.cellWidthPx || cellWidthHintPx || 8;
  const actualBoundaryPx = gridBoundaryActualPx(leftFrame, rightFrame);
  if (!Number.isFinite(actualBoundaryPx)) return { resized: false, reason: 'missing boundary measurement', leftPaneRef, rightPaneRef };
  const diffPx = target - actualBoundaryPx;
  const forceResize = !!(opts.forceResize || boundary.anchorSliver);
  const resizeTolerancePx = forceResize ? 0 : Math.max(1, Number(boundary.tolerancePx) || Number(opts.tolerancePx) || cellWidthPx);
  if (!forceResize && Math.abs(diffPx) <= resizeTolerancePx) {
    return {
      resized: false,
      reason: 'within tolerance',
      diffPx,
      actualBoundaryPx: Math.round(actualBoundaryPx),
      targetRightPx: target,
      leftPaneRef,
      rightPaneRef,
      resizeTolerancePx: Math.round(resizeTolerancePx),
      ...(boundary.name ? { name: boundary.name } : {}),
    };
  }
  const pxPerAmount = gridResizeCoefficientPxPerAmount(opts.pxPerAmount);
  const requestedAmount = Math.max(1, Math.ceil(Math.abs(diffPx) / pxPerAmount));
  // Clamp the per-command move so cmux never rejects an over-large amount (which would strand
  // this boundary as "unmovable"). Bound by a fraction of total workspace width; the remaining
  // distance is closed on subsequent rebalance passes.
  const totalWidthPx = (() => {
    const bounds = boundsForFrames(geometry.frames);
    return bounds && Number.isFinite(bounds.width) ? bounds.width : 0;
  })();
  const maxAmount = totalWidthPx > 0
    ? Math.max(1, Math.floor((totalWidthPx * GRID_RESIZE_MAX_AMOUNT_RATIO) / pxPerAmount))
    : requestedAmount;
  const amount = Math.min(requestedAmount, maxAmount);
  const clamped = amount < requestedAmount;
  const primary = diffPx > 0
    ? { ref: leftPaneRef, frame: leftFrame, direction: '-R', convention: 'left-pane-R' }
    : { ref: rightPaneRef, frame: rightFrame, direction: '-L', convention: 'right-pane-L' };
  const alternate = diffPx > 0
    ? { ref: rightPaneRef, frame: rightFrame, direction: '-L', convention: 'right-pane-L' }
    : { ref: leftPaneRef, frame: leftFrame, direction: '-R', convention: 'left-pane-R' };
  const strategy = opts.strategy === 'alternate' && alternate.ref && alternate.frame ? 'alternate' : 'primary';
  const instruction = strategy === 'alternate' ? alternate : primary;
  const direction = instruction.direction;
  const ref = instruction.ref;
  const resizeFrame = instruction.frame;
  if (!ref || !resizeFrame) {
    return {
      resized: false,
      reason: diffPx > 0 ? 'missing left boundary pane frame' : 'missing right boundary pane frame',
      leftPaneRef,
      rightPaneRef,
      diffPx,
      actualBoundaryPx: Math.round(actualBoundaryPx),
      targetRightPx: target,
      strategy,
    };
  }
  await cmux(['resize-pane', '--workspace', ws, '--pane', ref, direction, '--amount', String(amount)]);
  const signature = [boundary.name || 'boundary', ref, direction, amount].join('|');
  return {
    resized: true,
    workspace: ws,
    paneRef: ref,
    leftPaneRef,
    rightPaneRef,
    direction,
    amount,
    pxPerAmount,
    strategy,
    convention: instruction.convention,
    signature,
    requestedAmount,
    appliedAmount: amount,
    clamped,
    ...(clamped ? { maxAmount } : {}),
    estimatedMovePx: Math.round(amount * pxPerAmount),
    diffPx,
    actualBoundaryPx: Math.round(actualBoundaryPx),
    targetRightPx: target,
    ...(boundary.name ? { name: boundary.name } : {}),
  };
}

async function rebalanceGridColumns(wsRef) {
  if (process.env.CMUX_DASH_GRID_REBALANCE === 'off') {
    return { rebalanced: false, disabled: true, reason: 'rebalance disabled via CMUX_DASH_GRID_REBALANCE=off' };
  }
  const ref = cleanRef(wsRef);
  if (!ref) return { rebalanced: false, error: 'missing workspace ref' };
  const columns = (Array.isArray(gridRuntimeState.columns) ? gridRuntimeState.columns : [])
    .filter((column) => column && (!column.wsRef || column.wsRef === ref));
  if (!columns.length) return { rebalanced: false, error: 'no columns' };

  const surfaces = await listWorkspaceSurfaces(ref);
  const passes = [];
  let changed = false;
  let snapshot = null;
  let pxPerAmount = GRID_RESIZE_FALLBACK_PX_PER_AMOUNT;
  let pendingCalibration = null;
  const stagnantBoundaries = new Map();
  const abandonedBoundaries = new Map();
  for (let pass = 1; pass <= GRID_REBALANCE_MAX_PASSES; pass += 1) {
    snapshot = await readGridRebalanceSnapshot(ref, columns, surfaces);
    if (pendingCalibration && snapshot.ok) {
      for (const observation of gridResizeObservationsFromSnapshot(pendingCalibration.operations, snapshot)) {
        if (observation.moved) {
          stagnantBoundaries.delete(observation.name);
          continue;
        }
        const previous = stagnantBoundaries.get(observation.name) || { count: 0 };
        const next = {
          count: previous.count + 1,
          lastObservation: observation,
          lastOperation: observation.operation,
          nextStrategy: 'alternate',
        };
        stagnantBoundaries.set(observation.name, next);
        if (next.count >= 2) {
          abandonedBoundaries.set(observation.name, {
            name: observation.name,
            reason: 'boundary did not move after two resize attempts',
            observation: {
              beforePx: observation.beforePx,
              afterPx: observation.afterPx,
              observedMovePx: observation.observedMovePx,
            },
            lastOperation: observation.operation,
          });
        }
      }
      const calibration = gridResizeCalibrationFromSnapshot(pendingCalibration.operations, snapshot);
      if (calibration) {
        pxPerAmount = calibration.pxPerAmount;
        passes[pendingCalibration.passIndex] = {
          ...passes[pendingCalibration.passIndex],
          calibration,
        };
      }
      pendingCalibration = null;
    }
    if (!snapshot.ok) {
      const failedPasses = passes.concat(gridRebalancePassRecord(pass, snapshot));
      return { rebalanced: false, error: snapshot.reason, pass, passes: failedPasses };
    }
    if (snapshot.withinTolerance) {
      const finalPasses = passes.concat(gridRebalancePassRecord(pass, snapshot, { operations: [], converged: true, pxPerAmount }));
      const operations = finalPasses.reduce((acc, item) => acc.concat(item.operations || []), []);
      return {
        rebalanced: true,
        changed,
        converged: true,
        passCount: finalPasses.length,
        operations,
        passes: finalPasses,
        measurements: snapshot.measurements,
        boundaries: snapshot.boundaries,
        target: snapshot.target,
      };
    }

    const operations = [];
    for (const boundary of snapshot.boundaries) {
      if (abandonedBoundaries.has(boundary.name)) {
        operations.push({
          resized: false,
          name: boundary.name,
          leftPaneRef: boundary.leftPaneRef,
          rightPaneRef: boundary.rightPaneRef,
          actualBoundaryPx: boundary.actualPx,
          targetRightPx: boundary.targetRightPx,
          reason: 'unconverged boundary abandoned after no movement',
          unconverged: true,
        });
        continue;
      }
      const stagnant = stagnantBoundaries.get(boundary.name);
      operations.push(await resizeGridBoundary(ref, boundary, boundary.targetRightPx, snapshot.geometry.cellWidthPx, {
        pxPerAmount,
        tolerancePx: boundary.tolerancePx,
        strategy: stagnant && stagnant.count === 1 ? 'alternate' : 'primary',
      }));
    }
    const passChanged = operations.some((item) => item && item.resized);
    changed = changed || passChanged;
    passes.push({
      ...gridRebalancePassRecord(pass, snapshot, { pxPerAmount }),
      operations,
      changed: passChanged,
    });
    if (passChanged) pendingCalibration = { operations, passIndex: passes.length - 1 };
    if (!passChanged) break;
  }

  snapshot = await readGridRebalanceSnapshot(ref, columns, surfaces);
  if (pendingCalibration && snapshot.ok) {
    const calibration = gridResizeCalibrationFromSnapshot(pendingCalibration.operations, snapshot);
    if (calibration) {
      pxPerAmount = calibration.pxPerAmount;
      passes[pendingCalibration.passIndex] = {
        ...passes[pendingCalibration.passIndex],
        calibration,
      };
    }
    pendingCalibration = null;
  }
  const finalPass = (passes.length ? Math.max(...passes.map((item) => Number(item.pass) || 0)) : 0) + 1;
  const finalPasses = passes.concat(gridRebalancePassRecord(finalPass, snapshot, { operations: [], final: true, pxPerAmount }));
  if (!snapshot.ok) return { rebalanced: false, error: snapshot.reason, passes: finalPasses };
  const operations = finalPasses.reduce((acc, item) => acc.concat(item.operations || []), []);
  const unconvergedBoundaries = Array.from(abandonedBoundaries.values());
  return {
    rebalanced: snapshot.withinTolerance,
    changed,
    converged: snapshot.withinTolerance,
    ...(unconvergedBoundaries.length ? {
      unconverged: true,
      unconvergedBoundaries,
      repair: {
        recommendation: 'POST /api/grid/rebuild',
        requiresConfirm: false,
        reason: 'one or more grid boundaries did not move after resize commands',
      },
    } : {}),
    operations,
    passes: finalPasses,
    passCount: finalPasses.length,
    measurements: snapshot.measurements,
    boundaries: snapshot.boundaries,
    target: snapshot.target,
    ...(snapshot.withinTolerance ? {} : { error: `grid rebalance did not converge within ${GRID_REBALANCE_MAX_PASSES} passes` }),
  };
}

async function rebalanceGridColumnsBestEffort(wsRef) {
  try {
    let result = await rebalanceGridColumns(wsRef);
    if (result && result.rebalanced === false) {
      const firstResult = result;
      await settle(GRID_REBALANCE_BEST_EFFORT_RETRY_DELAY_MS);
      try {
        result = await rebalanceGridColumns(wsRef);
        result = {
          ...result,
          retried: true,
          retryDelayMs: GRID_REBALANCE_BEST_EFFORT_RETRY_DELAY_MS,
          firstResult,
        };
      } catch (retryErr) {
        result = {
          rebalanced: false,
          retried: true,
          retryDelayMs: GRID_REBALANCE_BEST_EFFORT_RETRY_DELAY_MS,
          firstResult,
          error: summarizeError(retryErr),
        };
      }
    }
    gridRuntimeState.lastRebalance = { ...result, checkedAt: new Date().toISOString() };
    return gridRuntimeState.lastRebalance;
  }
  catch (err) {
    console.warn(`grid column rebalance failed: ${summarizeError(err)}`);
    gridRuntimeState.lastRebalance = { rebalanced: false, error: summarizeError(err), checkedAt: new Date().toISOString() };
    return gridRuntimeState.lastRebalance;
  }
}

async function createAnchoredGridSplitSurface(wsRef, anchorSurfaceRef, direction) {
  const anchor = cleanRef(anchorSurfaceRef);
  if (!wsRef) throw new Error('grid workspace ref is required');
  if (!anchor) throw new Error('grid split anchor surface ref is required');

  const beforePanes = await listWorkspacePanes(wsRef);
  const beforeSurfaces = await listWorkspaceSurfaces(wsRef);
  const beforePaneRefs = new Set(beforePanes.map((pane) => pane && pane.ref).filter(Boolean));
  const beforeSurfaceRefs = new Set(beforeSurfaces.map((surface) => surface && surface.ref).filter(Boolean));

  const out = await cmux(['new-split', direction, '--workspace', wsRef, '--surface', anchor, '--focus', 'false']);
  const outputSurfaceRef = surfaceRefFromText(out);
  const outputPaneRef = paneRefFromText(out);
  await settle(Math.min(CMUX_SETTLE_MS, 500));

  const afterPanes = await listWorkspacePanes(wsRef);
  const afterSurfaces = await listWorkspaceSurfaces(wsRef);
  const createdPanes = afterPanes.filter((pane) => pane && pane.ref && !beforePaneRefs.has(pane.ref));
  const createdSurfaces = afterSurfaces.filter((surface) => surface && surface.ref && !beforeSurfaceRefs.has(surface.ref));

  let surface = outputSurfaceRef ? surfaceByRef(afterSurfaces, outputSurfaceRef) : null;
  if (!surface && outputPaneRef) {
    surface = createdSurfaces.find((item) => item.paneRef === outputPaneRef) || null;
  }
  if (!surface && createdPanes.length) {
    const paneRefs = new Set(createdPanes.map((pane) => pane.ref));
    surface = createdSurfaces.find((item) => paneRefs.has(item.paneRef)) || null;
  }
  if (!surface && createdSurfaces.length) surface = createdSurfaces[createdSurfaces.length - 1];
  if (!surface && outputSurfaceRef) surface = { ref: outputSurfaceRef, paneRef: outputPaneRef || null };
  if (!surface || !surface.ref) {
    throw new Error(`new-split ${direction} from ${anchor} did not create a terminal surface in ${wsRef}`);
  }
  return {
    surfaceRef: surface.ref,
    paneRef: surface.paneRef || outputPaneRef || null,
    split: true,
    splitFrom: anchor,
    direction,
  };
}

async function ensureGridRightAnchorSurface(wsRef) {
  try {
    return await findGridRightAnchorSurface(wsRef);
  } catch (err) {
    // Anchor surface was lost. Recreate it instead of deadlocking — previously this
    // rethrew whenever any column existed, which permanently blocked opening new
    // projects once the dedicated right-anchor terminal had been closed.
  }
  // When columns already exist, split the new anchor off the right edge of the
  // rightmost existing column so it lands at the far right (rebalance fixes ordering).
  // Otherwise fall back to splitting off the dashboard browser pane.
  let splitFromRef = null;
  const cols = Array.isArray(gridRuntimeState.columns) ? gridRuntimeState.columns : [];
  if (cols.length) {
    const rightmost = cols[cols.length - 1];
    splitFromRef = cleanRef(rightmost && rightmost.cc && rightmost.cc.surfaceRef)
      || cleanRef(rightmost && rightmost.cdx && rightmost.cdx.surfaceRef);
  }
  if (!splitFromRef) {
    const browserAnchor = await findGridBrowserAnchorSurface(wsRef);
    splitFromRef = browserAnchor.ref;
  }
  const anchor = await createAnchoredGridSplitSurface(wsRef, splitFromRef, 'right');
  gridRuntimeState.anchorSurfaceRef = anchor.surfaceRef;
  persistGridRuntimeState();
  return { ref: anchor.surfaceRef, paneRef: anchor.paneRef || null };
}

async function launchGridConciergeSurface(wsRef, surfaceRef) {
  const ref = cleanRef(surfaceRef);
  if (!wsRef) throw new Error('grid workspace ref is required');
  if (!ref) throw new Error('grid concierge surface ref is required');
  await cmux(['send', '--workspace', wsRef, '--surface', ref, gridConciergeLaunchCommand() + '\n']);
}

function conciergeReadyTimeoutMs() {
  return Math.min(
    GRID_CONCIERGE_READY_TIMEOUT_MAX_MS,
    intEnv('CMUX_DASH_CONCIERGE_READY_TIMEOUT_MS', GRID_CONCIERGE_READY_TIMEOUT_DEFAULT_MS),
  );
}

function conciergeReadyPollMs() {
  const ms = intEnv('CMUX_DASH_CONCIERGE_READY_POLL_MS', GRID_CONCIERGE_READY_POLL_DEFAULT_MS);
  return Math.max(1, ms);
}

function surfaceProcessValues(surface, processMap = {}) {
  const values = [];
  if (surface) {
    for (const key of ['process', 'processName', 'command']) {
      if (surface[key]) values.push(surface[key]);
    }
    if (Array.isArray(surface.processes)) values.push(...surface.processes);
    if (surface.ref && Array.isArray(processMap[surface.ref])) values.push(...processMap[surface.ref]);
  }
  return values.map((value) => processEntryCommand(value)).filter(Boolean);
}

function conciergeSurfaceHasClaudeProcess(surface, processMap = {}) {
  return surfaceProcessValues(surface, processMap)
    .some((value) => SLOT_DEFS.cc.processRe.test(value) || classifyProcess(value) === 'C');
}

async function waitForConciergeReady(wsRef, concierge) {
  const surfaceRef = cleanRef(concierge && (concierge.surfaceRef || concierge.ref));
  const started = Date.now();
  const timeoutMs = conciergeReadyTimeoutMs();
  const deadline = started + timeoutMs;
  let lastSurface = null;
  let lastProcess = null;

  while (true) {
    const surfaces = await listWorkspaceSurfaces(wsRef);
    const surface = surfaceByRef(surfaces, surfaceRef) || markedOrKnownGridConciergeSurface(surfaces);
    if (surface && surface.ref) {
      lastSurface = surface;
      setGridConciergeSurface(surface);
      const processMap = await surfaceProcessMap(wsRef);
      const values = surfaceProcessValues(surface, processMap);
      lastProcess = values.join('\n') || null;
      if (conciergeSurfaceHasClaudeProcess(surface, processMap)) {
        return {
          ready: true,
          surfaceRef: surface.ref,
          paneRef: surface.paneRef || null,
          process: lastProcess,
        };
      }
    }

    if (Date.now() >= deadline) {
      return {
        ready: false,
        surfaceRef: surfaceRef || cleanRef(lastSurface && lastSurface.ref),
        paneRef: lastSurface && lastSurface.paneRef || concierge && concierge.paneRef || null,
        process: lastProcess,
        timeoutMs,
      };
    }

    await sleep(Math.min(conciergeReadyPollMs(), Math.max(0, deadline - Date.now())));
  }
}

async function ensureConciergeSurface(wsRef) {
  const ref = cleanRef(wsRef);
  if (!ref) throw new Error('grid workspace ref is required');

  let surfaces = await listWorkspaceSurfaces(ref);
  const known = markedOrKnownGridConciergeSurface(surfaces);
  if (known && known.ref) {
    const state = setGridConciergeSurface(known);
    persistGridRuntimeState();
    return { ref: state.surfaceRef, surfaceRef: state.surfaceRef, paneRef: state.paneRef, marker: state.marker, existing: true };
  }

  const adoptable = inferUnmarkedGridConciergeSurface(surfaces);
  if (adoptable && adoptable.ref) {
    const state = setGridConciergeSurface(adoptable);
    await launchGridConciergeSurface(ref, state.surfaceRef);
    await settle(Math.min(CMUX_SETTLE_MS, 500));
    surfaces = await listWorkspaceSurfaces(ref);
    const launched = markedOrKnownGridConciergeSurface(surfaces) || adoptable;
    const next = setGridConciergeSurface(launched);
    persistGridRuntimeState();
    return { ref: next.surfaceRef, surfaceRef: next.surfaceRef, paneRef: next.paneRef, marker: next.marker, existing: true, launched: true };
  }

  const browserAnchor = await findGridBrowserAnchorSurface(ref);
  const created = await createAnchoredGridSplitSurface(ref, browserAnchor.ref, 'down');
  const state = setGridConciergeSurface({ ref: created.surfaceRef, paneRef: created.paneRef || null });
  await launchGridConciergeSurface(ref, state.surfaceRef);
  await settle(Math.min(CMUX_SETTLE_MS, 500));
  surfaces = await listWorkspaceSurfaces(ref);
  const launched = markedOrKnownGridConciergeSurface(surfaces);
  const next = setGridConciergeSurface(launched || state);
  persistGridRuntimeState();
  return {
    ref: next.surfaceRef,
    surfaceRef: next.surfaceRef,
    paneRef: next.paneRef,
    marker: next.marker,
    existing: false,
    launched: true,
    split: true,
    splitFrom: browserAnchor.ref,
    direction: 'down',
  };
}

async function ensureConciergeReadySurface(wsRef) {
  const ref = cleanRef(wsRef);
  if (!ref) throw new Error('grid workspace ref is required');
  const concierge = await ensureConciergeSurface(ref);
  let ready = await waitForConciergeReady(ref, concierge);
  if (ready.ready) {
    return { ...ready, wsRef: ref, marker: GRID_CONCIERGE_MARKER, repaired: false };
  }

  const surfaceRef = cleanRef(ready.surfaceRef || concierge && (concierge.surfaceRef || concierge.ref));
  if (surfaceRef) {
    await launchGridConciergeSurface(ref, surfaceRef);
    await settle(Math.min(CMUX_SETTLE_MS, 500));
    ready = await waitForConciergeReady(ref, { ...concierge, surfaceRef });
  }
  return { ...ready, wsRef: ref, marker: GRID_CONCIERGE_MARKER, repaired: true };
}

async function listGridTerminalSurfacesWithRetry(wsRef, expectedCount, attempts = 6) {
  let terminals = [];
  for (let i = 0; i < attempts; i += 1) {
    terminals = gridTerminalSurfaces(await listWorkspaceSurfaces(wsRef));
    if (terminals.length >= expectedCount) return terminals;
    await settle(Math.min(CMUX_SETTLE_MS, 500));
  }
  return terminals;
}

function resolveGridColumnSurfaces(wsRef, desired, terminalSurfaces, now) {
  const expectedCount = desired.length * 2;
  if (terminalSurfaces.length < expectedCount) {
    throw new Error(`grid layout created ${terminalSurfaces.length}/${expectedCount} terminal surfaces`);
  }
  return desired.map((column, idx) => {
    const ccMarker = gridSlotMarker(column.columnId, 'cc');
    const cdxMarker = gridSlotMarker(column.columnId, 'cdx');
    const cc = terminalSurfaces[idx * 2] || null;
    const cdx = terminalSurfaces[idx * 2 + 1] || null;
    if (!cc || !cc.ref) throw new Error(`grid layout did not create cc surface for ${column.projectId}`);
    if (!cdx || !cdx.ref) throw new Error(`grid layout did not create cdx surface for ${column.projectId}`);
    return {
      columnId: column.columnId,
      projectId: column.projectId,
      wsRef,
      order: idx,
      cc: { surfaceRef: cc.ref, paneRef: cc.paneRef || null, marker: ccMarker },
      cdx: { surfaceRef: cdx.ref, paneRef: cdx.paneRef || null, marker: cdxMarker },
      createdAt: column.createdAt || now,
      updatedAt: now,
    };
  });
}

async function launchGridColumnSurfaces(wsRef, columns, cfg) {
  for (const column of columns) {
    const project = findConfiguredRow(cfg, column.projectId);
    if (!project) throw new Error('unknown project: ' + column.projectId);
    await cmux(['send', '--workspace', wsRef, '--surface', column.cc.surfaceRef, gridLaunchCommand(project, cfg, column.columnId, 'cc') + '\n']);
    await cmux(['send', '--workspace', wsRef, '--surface', column.cdx.surfaceRef, gridLaunchCommand(project, cfg, column.columnId, 'cdx') + '\n']);
  }
}

async function closeGridColumnSurfaces(wsRef, column) {
  const refs = [
    column && column.cdx && column.cdx.surfaceRef,
    column && column.cc && column.cc.surfaceRef,
  ].filter(Boolean);
  const uniqueRefs = Array.from(new Set(refs));
  const uniquePaneRefs = Array.from(new Set([
    column && column.cdx && column.cdx.paneRef,
    column && column.cc && column.cc.paneRef,
  ].filter(Boolean)));
  const closed = [];
  for (const ref of uniqueRefs) {
    try {
      await cmux(['close-surface', '--workspace', wsRef, '--surface', ref]);
      closed.push(ref);
    } catch (_) {}
  }
  for (const ref of uniquePaneRefs) {
    try {
      await cmux(['close-surface', '--workspace', wsRef, '--surface', ref]);
    } catch (_) {}
  }
  return {
    surfaceRefs: closed,
    paneRefs: uniquePaneRefs,
  };
}

async function closeGridOrphanSurfaces(wsRef, orphans) {
  const refs = [];
  for (const orphan of Array.isArray(orphans) ? orphans : []) {
    const ref = cleanRef(orphan && (orphan.surfaceRef || orphan.ref));
    const paneRef = cleanRef(orphan && orphan.paneRef);
    if (ref) refs.push({ ref, kind: 'surface' });
    else if (paneRef) refs.push({ ref: paneRef, kind: 'pane' });
  }
  const seen = new Set();
  const closed = [];
  for (const item of refs) {
    if (!item.ref || seen.has(item.ref)) continue;
    seen.add(item.ref);
    try {
      await cmux(['close-surface', '--workspace', wsRef, '--surface', item.ref]);
      closed.push(item);
    } catch (err) {
      closed.push({ ...item, error: summarizeError(err) });
    }
  }
  return closed;
}

function normalizeGridRebuildProjectIds(value, currentColumns, cfg) {
  if (Array.isArray(value)) {
    const ids = [];
    const seen = new Set();
    for (const item of value) {
      const id = cleanRef(item);
      if (!id || seen.has(id)) continue;
      if (!findConfiguredRow(cfg, id)) throw new Error('unknown project: ' + id);
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }
  return (Array.isArray(currentColumns) ? currentColumns : [])
    .map((column) => cleanRef(column && column.projectId))
    .filter(Boolean);
}

async function rebuildGridSafely(opts = {}) {
  const cfg = loadConfig();
  const confirm = opts && opts.confirm === true;
  const state = await validateGridRuntimeState();
  const desiredIds = normalizeGridRebuildProjectIds(opts && opts.projectIds, state.columns, cfg);
  const currentIds = (Array.isArray(gridRuntimeState.columns) ? gridRuntimeState.columns : [])
    .map((column) => cleanRef(column && column.projectId))
    .filter(Boolean);
  const desiredSet = new Set(desiredIds);
  const liveColumnsToClose = currentIds.filter((id) => !desiredSet.has(id));
  const wsRef = cleanRef(state.wsRef || gridRuntimeState.wsRef);
  const orphansToClose = Array.isArray(gridRuntimeState.orphans) ? gridRuntimeState.orphans.slice() : [];
  if ((liveColumnsToClose.length || orphansToClose.length) && !confirm) {
    return {
      requiresConfirm: true,
      safe: false,
      destructive: true,
      strategy: 'adopt-close-orphans-add-missing',
      detail: {
        reason: liveColumnsToClose.length
          ? 'rebuild would close live grid column surfaces'
          : 'rebuild would close unmanaged grid orphan surfaces',
        projectIds: liveColumnsToClose,
        orphanRefs: orphansToClose.map((orphan) => cleanRef(orphan && (orphan.surfaceRef || orphan.ref || orphan.paneRef))).filter(Boolean),
        confirmHint: 'repeat with confirm:true to allow destructive grid closes',
      },
      ...gridStateSnapshot(state.wsRef),
    };
  }

  const result = {
    requiresConfirm: false,
    safe: true,
    rebuilt: false,
    destructive: liveColumnsToClose.length > 0 || orphansToClose.length > 0,
    strategy: 'adopt-close-orphans-add-missing',
    moveSupported: false,
    closedOrphans: [],
    removedColumns: [],
    addedColumns: [],
  };

  for (const projectId of liveColumnsToClose) {
    const removed = await removeProjectColumn(projectId);
    result.removedColumns.push({ projectId, ...removed });
  }

  let next = await validateGridRuntimeState();
  const orphans = Array.isArray(gridRuntimeState.orphans) ? gridRuntimeState.orphans.slice() : [];
  if (wsRef && orphans.length) {
    result.closedOrphans = await closeGridOrphanSurfaces(wsRef, orphans);
    next = await validateGridRuntimeState();
  }

  const liveAfterClose = new Set((Array.isArray(gridRuntimeState.columns) ? gridRuntimeState.columns : [])
    .map((column) => cleanRef(column && column.projectId))
    .filter(Boolean));
  for (const projectId of desiredIds) {
    if (liveAfterClose.has(projectId)) continue;
    const added = await addProjectColumn(projectId, { focus: false });
    result.addedColumns.push({ projectId, ...added });
    liveAfterClose.add(projectId);
  }

  next = await getGridState();
  return {
    ...result,
    ...next,
  };
}

async function rebuildGridWorkspace(columns, cfg = loadConfig()) {
  const desired = (Array.isArray(columns) ? columns : []).map((column) => ({
    columnId: gridColumnId(column.projectId),
    projectId: column.projectId,
    createdAt: column.createdAt || new Date().toISOString(),
  }));

  if (!desired.length) {
    const closedWs = await closeGridWorkspaceIfPresent();
    gridRuntimeState.wsRef = null;
    gridRuntimeState.anchorSurfaceRef = null;
    resetGridConcierge();
    gridRuntimeState.columns = [];
    gridRuntimeState.orphans = [];
    gridRuntimeState.lastRebalance = null;
    gridRuntimeState.lastRebalanceRepairAt = null;
    persistGridRuntimeState();
    return { ...gridStateSnapshot(null, []), closedWs, rebuilt: true };
  }

  await closeGridWorkspaceIfPresent();
  gridRuntimeState.anchorSurfaceRef = null;
  resetGridConcierge();
  gridRuntimeState.lastRebalance = null;
  gridRuntimeState.lastRebalanceRepairAt = null;
  const layout = gridWorkspaceLayout(desired, cfg);
  const out = await cmux([
    'new-workspace',
    '--name', 'cmux-dashboard grid',
    '--description', GRID_TAG,
    '--cwd', __dirname,
    '--layout', JSON.stringify(layout),
    '--focus', 'false',
  ]);
  const wsRef = (out.match(/workspace:\d+/) || [])[0] || null;
  if (!wsRef) throw new Error('grid workspace was not resolved');
  await settle();

  const now = new Date().toISOString();
  const terminalSurfaces = await listGridTerminalSurfacesWithRetry(wsRef, desired.length * 2 + 2, 6);
  const conciergeSurface = terminalSurfaces[0] || null;
  const columnSurfaces = terminalSurfaces.slice(1, 1 + desired.length * 2);
  const rebuilt = resolveGridColumnSurfaces(wsRef, desired, columnSurfaces, now);
  if (conciergeSurface && conciergeSurface.ref) {
    setGridConciergeSurface(conciergeSurface);
    await launchGridConciergeSurface(wsRef, conciergeSurface.ref);
  } else {
    await ensureConciergeSurface(wsRef);
  }
  await launchGridColumnSurfaces(wsRef, rebuilt, cfg);
  await settle();
  gridRuntimeState.wsRef = wsRef;
  gridRuntimeState.columns = rebuilt;
  gridRuntimeState.orphans = [];
  try {
    const anchor = await findGridRightAnchorSurface(wsRef);
    gridRuntimeState.anchorSurfaceRef = anchor && anchor.ref || null;
  } catch (_) {
    gridRuntimeState.anchorSurfaceRef = null;
  }
  persistGridRuntimeState();
  return { ...gridStateSnapshot(wsRef, rebuilt), layout, rebuilt: true };
}

function liveSurfaceIndex(surfaces) {
  const byRef = new Map();
  for (const surface of Array.isArray(surfaces) ? surfaces : []) {
    if (surface && surface.ref) byRef.set(surface.ref, surface);
  }
  return byRef;
}

async function validateGridRuntimeState() {
  const knownRef = cleanRef(gridRuntimeState.wsRef);
  let ws = await findGridWorkspace({
    attempts: GRID_WORKSPACE_LOOKUP_ATTEMPTS,
    delayMs: Math.min(CMUX_SETTLE_MS, 500),
    allowStale: true,
    quick: true,
  });
  let knownRefCheck = null;
  if ((!ws || !ws.ref) && knownRef) {
    knownRefCheck = await workspaceRefExistsCheck(knownRef, { allowStale: true, quick: true });
    if (knownRefCheck.exists) ws = { ref: knownRef };
  }
  if (!ws || !ws.ref) {
    if (knownRef && knownRefCheck && !knownRefCheck.ok) {
      gridRuntimeState.wsRef = knownRef;
      reindexGridColumns();
      return gridStateSnapshot(knownRef);
    }
    gridRuntimeState.wsRef = null;
    gridRuntimeState.anchorSurfaceRef = null;
    resetGridConcierge();
    gridRuntimeState.columns = [];
    gridRuntimeState.orphans = [];
    gridRuntimeState.lastRebalance = null;
    gridRuntimeState.lastRebalanceRepairAt = null;
    persistGridRuntimeState();
    return gridStateSnapshot(null, []);
  }

  gridRuntimeState.wsRef = ws.ref;
  const surfaceState = await listWorkspaceSurfacesStatus(ws.ref);
  if (!surfaceState.ok) {
    gridRuntimeState.columns = gridRuntimeState.columns.map((column) => (
      column ? { ...column, wsRef: ws.ref } : column
    ));
    reindexGridColumns();
    return gridStateSnapshot(ws.ref);
  }
  const surfaces = surfaceState.surfaces;
  const cfg = loadConfig();
  const anchorRef = cleanRef(gridRuntimeState.anchorSurfaceRef);
  const byRef = liveSurfaceIndex(surfaces);
  if (anchorRef && !byRef.has(anchorRef)) gridRuntimeState.anchorSurfaceRef = null;
  const concierge = markedOrKnownGridConciergeSurface(surfaces);
  if (concierge && concierge.ref) {
    setGridConciergeSurface(concierge);
  } else {
    resetGridConcierge();
  }
  const processMap = await surfaceProcessMap(ws.ref);
  const resync = buildAdoptedGridColumns(ws.ref, surfaces, cfg, undefined, { processMap });
  gridRuntimeState.columns = attachGridProcessDiagnosticsToColumns(resync.columns, processMap);
  const rightAnchor = markedGridRightAnchorSurface(surfaces) || gridRightAnchorSurface(surfaces, gridRuntimeState.columns);
  if (rightAnchor && rightAnchor.ref) {
    gridRuntimeState.anchorSurfaceRef = rightAnchor.ref;
  }
  const browser = gridBrowserAnchorSurface(surfaces);
  gridRuntimeState.orphans = gridRuntimeOrphansFromSurfaces(surfaces, gridRuntimeState.columns, {
    browserSurfaceRef: browser && browser.ref || null,
    conciergeSurfaceRef: gridRuntimeState.concierge && gridRuntimeState.concierge.surfaceRef || null,
    rightAnchorSurfaceRef: gridRuntimeState.anchorSurfaceRef,
  }, resync.markerOrphans);
  reindexGridColumns();
  persistGridRuntimeState();
  return gridStateSnapshot(ws.ref);
}

function gridTimestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function gridRecentRebalanceOrRepairMs() {
  return Math.max(
    gridTimestampMs(gridRuntimeState.lastRebalance && gridRuntimeState.lastRebalance.checkedAt),
    gridTimestampMs(gridRuntimeState.lastRebalanceRepairAt),
  );
}

async function maybeRepairGridColumnsAfterValidation(state) {
  const ref = cleanRef(state && state.wsRef || gridRuntimeState.wsRef);
  const columns = (Array.isArray(gridRuntimeState.columns) ? gridRuntimeState.columns : [])
    .filter((column) => column && (!column.wsRef || column.wsRef === ref));
  if (!ref || !columns.length) return null;
  const now = Date.now();
  const recentAt = gridRecentRebalanceOrRepairMs();
  if (recentAt && now - recentAt < GRID_REBALANCE_REPAIR_THROTTLE_MS) return null;

  let surfaces = [];
  try {
    surfaces = await listWorkspaceSurfaces(ref);
  } catch (_) {
    return null;
  }

  let snapshot = null;
  try {
    snapshot = await readGridRebalanceSnapshot(ref, columns, surfaces);
  } catch (_) {
    return null;
  }
  if (!snapshot || !snapshot.ok) return null;

  const divergent = (Array.isArray(snapshot.boundaries) ? snapshot.boundaries : [])
    .find((boundary) => gridBoundaryOutsideTolerance(boundary, GRID_REBALANCE_REPAIR_TOLERANCE));
  if (!divergent) return null;

  const repairAt = new Date(now).toISOString();
  gridRuntimeState.lastRebalanceRepairAt = repairAt;
  const result = await rebalanceGridColumnsBestEffort(ref);
  gridRuntimeState.lastRebalance = {
    ...result,
    autoRepair: true,
    repairReason: 'grid boundary drift',
    repairCheckedAt: repairAt,
    repairBoundary: gridRebalanceBoundarySummary([divergent])[0] || null,
  };
  return gridRuntimeState.lastRebalance;
}

async function getGridState() {
  const state = await validateGridRuntimeState();
  const repair = await maybeRepairGridColumnsAfterValidation(state);
  return attachGridAwaiting(repair ? gridStateSnapshot(cleanRef(gridRuntimeState.wsRef), gridRuntimeState.columns) : state);
}

function conciergeKickoffText(text) {
  const userText = String(text || '').trim();
  const templatePath = templateAbsolutePath(path.join('templates', 'CONCIERGE.md'));
  const templateInstruction = fs.existsSync(templatePath)
    ? `まず ${templatePath} を読み、そのプロトコルに従って対話→確定後に API でプロジェクト登録と列起動を実行せよ`
    : `まず ${templatePath} を読む。存在しない場合は、プロジェクト作成窓口として対話→確定後に API でプロジェクト登録と列起動を実行せよ`;
  return `${userText}\n\n${templateInstruction}`;
}

async function conciergeAsk(text) {
  const wsRef = await ensureGridWorkspace();
  const kickoffText = conciergeKickoffText(text);
  const ready = await ensureConciergeReadySurface(wsRef);
  const surfaceRef = cleanRef(ready.surfaceRef || ready.ref);
  if (!ready.ready) {
    return {
      sent: false,
      error: 'concierge not ready',
      wsRef,
      surfaceRef,
      paneRef: ready.paneRef || null,
      marker: GRID_CONCIERGE_MARKER,
      kickoffText,
    };
  }
  await submitToSurface(wsRef, surfaceRef, kickoffText);
  return {
    sent: true,
    wsRef,
    surfaceRef,
    paneRef: ready.paneRef || null,
    marker: GRID_CONCIERGE_MARKER,
    kickoffText,
  };
}

async function focusGridWorkspace({ ensure = false, wsRef = null } = {}) {
  let ref = cleanRef(wsRef || gridRuntimeState.wsRef);
  let ws = ref ? { ref } : null;
  if (!ws || !ws.ref) {
    ws = await findGridWorkspace({ attempts: 3, delayMs: 500, allowStale: true, quick: true });
  }
  if ((!ws || !ws.ref) && ensure) {
    ref = await ensureGridWorkspace();
    ws = ref ? { ref } : null;
  }
  if (!ws || !ws.ref) return { focused: false };
  await cmux(['select-workspace', '--workspace', ws.ref]);
  gridRuntimeState.wsRef = ws.ref;
  persistGridRuntimeState();
  return { focused: true, ref: ws.ref, wsRef: ws.ref };
}

async function addProjectColumn(projectId, { focus = false } = {}) {
  const cfg = loadConfig();
  const project = findConfiguredRow(cfg, projectId);
  if (!project) throw new Error('unknown project: ' + projectId);
  const columnId = gridColumnId(projectId);
  if (!columnId) throw new Error('grid project id is required');

  await validateGridRuntimeState();
  const existing = gridRuntimeState.columns.find((column) => column.projectId === projectId);
  if (existing) {
    const result = { ...gridColumnSnapshot(existing, existing.order), already: true, added: false };
    if (focus) result.focus = await focusGridWorkspace({ wsRef: result.wsRef });
    return result;
  }

  const now = new Date().toISOString();
  const hadGridWorkspace = !!gridRuntimeState.wsRef;
  const wsRef = await ensureGridWorkspace();
  const anchor = await ensureGridRightAnchorSurface(wsRef);
  const anchorSurfaceRef = anchor && anchor.ref;

  let cc = null;
  let cdx = null;
  try {
    cc = await createAnchoredGridSplitSurface(wsRef, anchorSurfaceRef, 'left');
    cdx = await createAnchoredGridSplitSurface(wsRef, cc.surfaceRef, 'down');
    const column = {
      columnId,
      projectId,
      wsRef,
      order: gridRuntimeState.columns.length,
      cc: {
        surfaceRef: cc.surfaceRef,
        paneRef: cc.paneRef || null,
        marker: gridSlotMarker(columnId, 'cc'),
      },
      cdx: {
        surfaceRef: cdx.surfaceRef,
        paneRef: cdx.paneRef || null,
        marker: gridSlotMarker(columnId, 'cdx'),
      },
      createdAt: now,
      updatedAt: now,
    };
    await launchGridColumnSurfaces(wsRef, [column], cfg);
    await settle();
    gridRuntimeState.wsRef = wsRef;
    gridRuntimeState.columns.push(column);
    reindexGridColumns();
  } catch (err) {
    await closeGridColumnSurfaces(wsRef, { cc, cdx });
    if (!hadGridWorkspace) {
      await closeGridWorkspaceIfPresent();
      gridRuntimeState.wsRef = null;
      gridRuntimeState.anchorSurfaceRef = null;
      resetGridConcierge();
      gridRuntimeState.columns = [];
      gridRuntimeState.orphans = [];
      gridRuntimeState.lastRebalance = null;
      gridRuntimeState.lastRebalanceRepairAt = null;
    }
    throw err;
  }

  const next = await validateGridRuntimeState();
  const column = next.columns.find((item) => item && item.projectId === projectId);
  if (!column) throw new Error('grid column was not created: ' + projectId);
  const rebalance = await rebalanceGridColumnsBestEffort(next.wsRef);
  const response = { ...column, added: true, already: false, rebuilt: false, incremental: true, rebalance, lastRebalance: rebalance };
  if (focus) response.focus = await focusGridWorkspace({ wsRef: next.wsRef });
  return response;
}

async function removeProjectColumn(projectId) {
  await validateGridRuntimeState();
  const idx = gridRuntimeState.columns.findIndex((column) => column.projectId === projectId);
  if (idx < 0) {
      return { projectId, removed: false, already: true, ...(await getGridState()) };
  }
  const previousWsRef = gridRuntimeState.wsRef || gridRuntimeState.columns[idx].wsRef || null;
  const target = gridRuntimeState.columns[idx];
  const finalColumn = gridRuntimeState.columns.length === 1;
  const closed = finalColumn
    ? { surfaceRefs: [
      target && target.cdx && target.cdx.surfaceRef,
      target && target.cc && target.cc.surfaceRef,
    ].filter(Boolean), paneRefs: [
      target && target.cdx && target.cdx.paneRef,
      target && target.cc && target.cc.paneRef,
    ].filter(Boolean) }
    : await closeGridColumnSurfaces(previousWsRef, target);

  if (finalColumn) {
    const closedWs = await closeGridWorkspaceIfPresent();
    gridRuntimeState.wsRef = null;
    gridRuntimeState.anchorSurfaceRef = null;
    resetGridConcierge();
    gridRuntimeState.columns = [];
    gridRuntimeState.orphans = [];
    gridRuntimeState.lastRebalance = null;
    gridRuntimeState.lastRebalanceRepairAt = null;
    persistGridRuntimeState();
    return {
      projectId,
      removed: true,
      rebuilt: false,
      incremental: true,
      closedWorkspace: closedWs || previousWsRef,
      wsClosed: true,
      closedSurfaces: closed.surfaceRefs,
      closedPaneRefs: closed.paneRefs,
      wsRef: null,
      columns: [],
      lastRebalance: null,
    };
  }

  gridRuntimeState.columns.splice(idx, 1);
  reindexGridColumns();
  await settle();
  const result = await validateGridRuntimeState();
  const rebalance = await rebalanceGridColumnsBestEffort(result.wsRef);
  return {
    projectId,
    removed: true,
    rebuilt: false,
    incremental: true,
    closedWorkspace: null,
    wsClosed: false,
    closedSurfaces: closed.surfaceRefs,
    closedPaneRefs: closed.paneRefs,
    ...result,
    rebalance,
    lastRebalance: rebalance,
  };
}

async function openProject(id, { focus = true } = {}) {
  const cfg = loadConfig();
  const p = findConfiguredRow(cfg, id);
  if (!p) throw new Error('unknown project: ' + id);
  const ag = projectAgmsgConfig(p, cfg);
  const collabEnabled = projectCollabEnabled(p, cfg);
  const cwdInfo = rowCwdInfo(p, { create: true });
  const claudeMd = ensureClaudeMd(p, cfg);
  if (!claudeMd.ok) console.warn(`CLAUDE.md preflight failed for ${id}: ${claudeMd.error}`);

  const existing = await findWorkspaceByTag(id, { attempts: 3, delayMs: 500 });
  if (existing) {
    if (focus) await focusProject(id);
    const collab = collabEnabled ? withRemapFields(await ensureCollab(cwdInfo.dir, true, { team: teamName(p.id), projectId: p.id }), cwdInfo) : { ok: true, on: false, skipped: true };
    const slots = collabEnabled ? await ensureCollabSlots(id) : [];
    return { ref: existing.ref, wsRef: existing.ref, alreadyOpen: true, cwd: cwdInfo.dir, ...remapFields(cwdInfo), claudeMd, slots, collab, state: await getProjectState(id) };
  }

  // 1) agmsg チームをセットアップ（claude 起動前に hook を書き込む）
  const agResult = await agmsgSetup(p, ag);

  // 2) workspace 作成。デフォルト terminal surface は中立扱いにし、
  // cc/cdx/yazi/term は個別 slot toggle で明示 marker 付き surface として追加する。
  const args = [
    'new-workspace',
    '--name', `${p.emoji || (isGlobalProject(p) ? '⌘' : '📁')} ${p.name || p.id}`,
    '--description', TAG + id,
    '--cwd', cwdInfo.dir,
    '--focus', focus ? 'true' : 'false',
  ];
  const out = await cmux(args);
  const ref = (out.match(/workspace:\d+/) || [])[0] || null;
  await settle();
  const collab = (ref && collabEnabled) ? withRemapFields(await ensureCollab(cwdInfo.dir, true, { team: teamName(p.id), projectId: p.id }), cwdInfo) : { ok: true, on: false, skipped: true };
  const slots = (ref && collabEnabled) ? await ensureCollabSlots(id) : [];

  return { ref, wsRef: ref, alreadyOpen: false, cwd: cwdInfo.dir, ...remapFields(cwdInfo), agmsg: agResult, claudeMd, slots, collab, state: ref ? await getProjectState(id) : null };
}

async function ensureCollabSlots(id) {
  const results = [];
  for (const slot of ['cc', 'cdx']) {
    results.push(await ensureSlot(id, slot, true));
  }
  return results;
}

async function ensureCollabPair(id, on) {
  const cfg = loadConfig();
  const project = findConfiguredRow(cfg, id);
  if (!project) throw new Error('unknown project: ' + id);
  const cwdInfo = rowCwdInfo(project, { create: projectCollabEnabled(project, cfg) });
  const collab = projectCollabEnabled(project, cfg)
    ? withRemapFields(await ensureCollab(cwdInfo.dir, true, { team: teamName(project.id), projectId: project.id }), cwdInfo)
    : { ok: true, on: false, skipped: true };
  const slots = [];
  if (on) {
    slots.push(...await ensureCollabSlots(id));
  } else {
    slots.push(await ensureSlot(id, 'cdx', false));
    slots.push(await ensureSlot(id, 'cc', false));
  }
  const state = await getProjectState(id);
  const active = projectCollabEnabled(project, cfg) && collabActiveFromProjectState(state);
  return { id, on: !!on, cwd: cwdInfo.dir, ...remapFields(cwdInfo), collab: { enabled: projectCollabEnabled(project, cfg), active, running: active, mode: 'pane-delivery' }, slots, setup: collab, state };
}

async function ensureSlot(id, slot, on) {
  if (!SLOT_DEFS[slot]) throw new Error('unknown slot: ' + slot);
  const cfg = loadConfig();
  const p = findConfiguredRow(cfg, id);
  if (!p) throw new Error('unknown project: ' + id);
  const cwdInfo = rowCwdInfo(p, { create: !!on });

  if (on) {
    let state = await getProjectState(id);
    if (!state.open) {
      await openProject(id, { focus: false });
      state = await getProjectState(id);
    }
    if (state.slots[slot] && state.slotRefs[slot]) {
      const repaired = await repairSharedSlotPane(state, slot);
      if (!repaired) {
        return { id, slot, on: true, already: true, ref: state.slotRefs[slot], paneRef: state.slotPaneRefs[slot] || null, wsRef: state.wsRef, cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
      }
      await settle(Math.min(CMUX_SETTLE_MS, 500));
      state = await getProjectState(id);
    }
    const created = await createSplitPaneSurface(state.wsRef);
    const surfaceRef = created.surfaceRef;
    if (!surfaceRef) throw new Error(`slot surface was not resolved for ${id}/${slot}`);
    await cmux(['send', '--workspace', state.wsRef, '--surface', surfaceRef, slotLaunchText(p, cfg, slot)]);
    recordSlotRef(id, slot, { surfaceRef, paneRef: created.paneRef || null, wsRef: state.wsRef });
    await settle();
    const next = await getProjectState(id);
    return {
      id,
      slot,
      on: !!next.slots[slot],
      ref: next.slotRefs[slot] || surfaceRef,
      paneRef: next.slotPaneRefs[slot] || created.paneRef || null,
      wsRef: next.wsRef,
      split: created.split,
      reused: !!created.reused,
      cwd: cwdInfo.dir,
      ...remapFields(cwdInfo),
    };
  }

  const state = await getProjectState(id);
  if (!state.open || !state.slots[slot]) return { id, slot, on: false, already: true, wsRef: state.wsRef, cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
  const closed = await closeSlotOwnedPaneSurfaces(id, state, slot);
  const next = closed.next || await getProjectState(id);
  if (!next.slots[slot]) forgetSlotRef(id, slot);
  return { id, slot, on: !!next.slots[slot], closed: closed.closed, paneRefs: closed.paneRefs, wsRef: next.wsRef, cwd: cwdInfo.dir, ...remapFields(cwdInfo) };
}

async function closeProject(id) {
  const cfg = loadConfig();
  const p = findConfiguredRow(cfg, id);
  const ws = await findWorkspaceByTag(id, { attempts: 4, delayMs: 500 });
  let result = { closed: false };
  if (ws) {
    await cmux(['close-workspace', '--workspace', ws.ref]);
    await settle(Math.min(CMUX_SETTLE_MS, 500));
    forgetProjectSlotRefs(id);
    result = { closed: true, ref: ws.ref };
  }
  if (p && projectCollabEnabled(p, cfg)) {
    const cwdInfo = rowCwdInfo(p);
    result.cwd = cwdInfo.dir;
    Object.assign(result, remapFields(cwdInfo));
    result.collab = withRemapFields(await ensureCollab(cwdInfo.dir, false, { team: teamName(p.id), projectId: p.id }), cwdInfo);
  }
  return result;
}

async function focusProject(id) {
  const ws = await findWorkspaceByTag(id, { attempts: 3, delayMs: 500 });
  if (!ws) return { focused: false };
  await cmux(['select-workspace', '--workspace', ws.ref]);
  return { focused: true, ref: ws.ref };
}

async function sendToSurface(wsRef, surfaceRef, text) {
  if (!wsRef) throw new Error('workspace ref is required for cmux send');
  if (!surfaceRef) throw new Error('surface ref is required for cmux send');
  return cmux(['send', '--workspace', wsRef, '--surface', surfaceRef, String(text || '')]);
}

// Submit a line of input to a running TUI agent (claude/codex) pane.
//
// `cmux send "text\r"` does NOT work for these TUIs: the agent has bracketed
// paste enabled, so the whole payload (including a trailing \r) is delivered as
// a single paste and the Enter is swallowed into the input box rather than
// submitting. Empirically verified against codex: a one-shot send leaves the
// prompt unsent. The fix is two separate sends — the text as a paste, then a
// LONE carriage return as its own keystroke — with a short settle in between so
// the paste lands before Enter. Verified: codex runs the injected task.
const TUI_SUBMIT_GAP_MS = (() => {
  const n = parseInt(process.env.CMUX_DASH_TUI_SUBMIT_GAP_MS || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 250;
})();
async function submitToSurface(wsRef, surfaceRef, text) {
  if (!wsRef) throw new Error('workspace ref is required for cmux send');
  if (!surfaceRef) throw new Error('surface ref is required for cmux send');
  // Strip any trailing newline/Enter escapes the caller may have appended; the
  // separate \r below is what actually submits.
  const body = String(text || '').replace(/(\\[rn]|[\r\n])+$/g, '');
  await cmux(['send', '--workspace', wsRef, '--surface', surfaceRef, body]);
  await settle(TUI_SUBMIT_GAP_MS);
  return cmux(['send', '--workspace', wsRef, '--surface', surfaceRef, '\\r']);
}

async function openAll() {
  const cfg = loadConfig();
  const results = [];
  const rows = configuredRows(cfg);
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    try {
      results.push({ id: p.id, ok: true, ...(await openProject(p.id, { focus: false })) });
    } catch (e) {
      results.push({ id: p.id, ok: false, error: summarizeError(e) });
    }
    if (i < rows.length - 1) await settle(CMUX_OPENALL_GAP_MS);
  }
  return results;
}
async function closeAll() {
  const cfg = loadConfig();
  const results = [];
  const rows = configuredRows(cfg);
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    try {
      results.push({ id: p.id, ok: true, ...(await closeProject(p.id)) });
    } catch (e) {
      results.push({ id: p.id, ok: false, error: summarizeError(e) });
    }
    if (i < rows.length - 1) await settle(CMUX_OPENALL_GAP_MS);
  }
  return results;
}

function normalizeProjectOrder(order, projects) {
  if (!Array.isArray(order)) throw new Error('order must be an array of project ids');
  const existing = (Array.isArray(projects) ? projects : [])
    .filter((p) => !isGlobalProject(p))
    .map((p) => p && p.id)
    .filter(Boolean);
  const existingSet = new Set(existing);
  const seen = new Set();
  const normalized = order.map((id) => String(id || '').trim());
  for (const id of normalized) {
    if (!id) throw new Error('order contains an empty project id');
    if (!existingSet.has(id)) throw new Error('order contains unknown project id: ' + id);
    if (seen.has(id)) throw new Error('order contains duplicate project id: ' + id);
    seen.add(id);
  }
  const missing = existing.filter((id) => !seen.has(id));
  if (missing.length) throw new Error('order is missing project id(s): ' + missing.join(', '));
  return normalized;
}

async function reorderProjects(order) {
  const cfg = loadConfig();
  const normalized = normalizeProjectOrder(order, cfg.projects);
  const workspaces = await listWorkspaces({ allowStale: true, quick: true });
  const refByProject = new Map();
  for (const ws of workspaces) {
    const id = tagOf(ws);
    if (id && ws && ws.ref) refByProject.set(id, ws.ref);
  }
  const orderedRefs = normalized.map((id) => refByProject.get(id)).filter(Boolean);
  if (orderedRefs.length > 1) {
    await cmux(['reorder-workspaces', '--order', orderedRefs.join(',')]);
    await settle(Math.min(CMUX_SETTLE_MS, 500));
  }

  const byId = new Map(cfg.projects.map((p) => [p.id, p]));
  const globals = cfg.projects.filter((p) => isGlobalProject(p));
  cfg.projects = [...normalized.map((id) => byId.get(id)), ...globals];
  saveConfig(cfg);
  return {
    order: normalized,
    workspaceOrder: orderedRefs,
    cmuxReordered: orderedRefs.length > 1,
  };
}

// ---- プロジェクト CRUD ----
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('proj-' + process.pid);
}
const PALETTE = ['#6ee7b7', '#93c5fd', '#fcd34d', '#f9a8d4', '#c4b5fd', '#fda4af', '#5eead4', '#fdba74'];
function addProject({ name, path: ppath, color, emoji, topCmd, bottomCmd, create, gitInit }) {
  const cfg = loadConfig();
  const cleanName = String(name || '').trim();
  const cleanPath = String(ppath || '').trim();
  if (!cleanName && !cleanPath) throw new Error('project name or path is required');
  let id = slugify(cleanName || path.basename(expandHome(cleanPath)) || cleanPath);
  while (cfg.projects.some((p) => p.id === id)) id += '-1';
  // パス未指定なら安全な projects root 配下を既定にする（新規プロジェクト作成を楽にする）
  const requestedPath = cleanPath || defaultProjectPath(id);
  const dirInfo = resolveProjectDirInput(requestedPath, {
    id,
    name: cleanName || id,
    create: !!create,
    fallback: defaultProjectPath(id),
  });
  const finalPath = dirInfo.remappedFrom ? toHomeDisplayPath(dirInfo.dir) : requestedPath;
  const proj = {
    id, name: cleanName || id, path: finalPath,
    color: color || PALETTE[cfg.projects.length % PALETTE.length],
    emoji: emoji || '🆕',
  };
  if (topCmd) proj.topCmd = topCmd;
  if (bottomCmd) proj.bottomCmd = bottomCmd;

  // フォルダを実際に作成（無ければ）。理想形を自動で保つための足場づくり。
  if (create) {
    const abs = dirInfo.dir;
    if (gitInit) {
      try { if (!fs.existsSync(path.join(abs, '.git'))) require('child_process').execFileSync('git', ['init', '-q'], { cwd: abs }); } catch (_) {}
    }
  }
  cfg.projects.push(proj);
  saveConfig(cfg);
  return { ...proj, cwd: dirInfo.dir, ...remapFields(dirInfo) };
}
function removeProject(id) {
  const cfg = loadConfig();
  const before = cfg.projects.length;
  cfg.projects = cfg.projects.filter((p) => p.id !== id);
  saveConfig(cfg);
  forgetProjectSlotRefs(id);
  return { removed: before !== cfg.projects.length };
}

module.exports = {
  CMUX, TAG, AGMSG_DIR, CMUX_CONTEXT_ENV_KEYS, SLOT_ORDER, SLOT_DEFS, CMUX_DASH_PROJECTS_ROOT,
  buildCmuxEnv, agmsgAvailable, teamName, isTransient,
  parseTop, parseMemory, classifyProcess, getMetrics,
  doctor,
  ensureClaudeMd,
  ensureCollab, ensureProjectCollab, ensureCollabPair, isCollabRunning, projectCollabEnabled, projectCollabEnabledById,
  agmsgDbPath, getTeamMessages,
  createCmuxHealthTracker, getCmuxHealth, pingCmuxForRecovery,
  getState, getWorkspaceYaml, getProjectState, ensureSlot, ensureCollabSlots, sendToSurface, submitToSurface, loadConfig, saveConfig, openProject, closeProject, focusProject,
  workspaceRefExists, ensureGridWorkspace, ensureConciergeSurface, ensureConciergeReadySurface, conciergeAsk, focusGridWorkspace, addProjectColumn, removeProjectColumn, rebalanceGridColumns, getGridState, gridWorkspaceLayout, rebuildGridSafely,
  openAll, closeAll, reorderProjects, addProject, removeProject, expandHome, rowCwd, rowCwdInfo, normalizeCollabProjectDir, normalizeCollabProjectDirInfo,
  projectKind, isGlobalProject, configuredRows, configuredProjectRows, configuredGlobalRows,
};
