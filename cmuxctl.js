'use strict';
// cmuxctl — cmux を CLI 経由で操作するコアライブラリ。
// 各プロジェクト = 1 workspace = 1 agmsg チーム。
// R1 rebuild: workspace 内の terminal surface を slot として扱う。
//   cc=claude, cdx=codex, yazi=yazi, term=shell
// workspace.description タグ "cmuxdash:<id>" で識別する。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAG = 'cmuxdash:';
const GRID_ID = '__grid__';
const GRID_TAG = TAG + GRID_ID;
const GRID_MARK_PREFIX = `${TAG}grid:`;
const PROJECTS_FILE = process.env.CMUX_DASH_PROJECTS_FILE || path.join(__dirname, 'projects.json');
const PROJECTS_EXAMPLE_FILE = process.env.CMUX_DASH_PROJECTS_EXAMPLE_FILE || path.join(__dirname, 'projects.example.json');
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

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
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
    || /broken pipe|EPIPE|errno 32|socket|ECONNRESET|ETIMEDOUT|timeout|timed out|SIGKILL/i.test(`${msg} ${code} ${signal}`);
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

function rowCwd(project = {}) {
  const fallback = isGlobalProject(project) ? os.homedir() : process.cwd();
  return expandHome(project.path || fallback);
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

function normalizeCollabProjectDir(projectDir, { create = false } = {}) {
  const expanded = expandHome(projectDir);
  if (!expanded) throw new Error('projectDir is required for collab bridge');
  const resolved = path.resolve(expanded);
  if (create) fs.mkdirSync(resolved, { recursive: true });
  try { return fs.realpathSync(resolved); } catch (_) { return resolved; }
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
  const dir = normalizeCollabProjectDir(projectDir, { create: !!on });
  if (!on) {
    const stopped = await stopCollabBridge(dir);
    return { ok: true, on: false, projectDir: dir, active: false, running: false, ...stopped };
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
  const result = await ensureCollab(rowCwd(project), !!on, { team: teamName(project.id) });
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
  return { id, collab: { enabled: !!on, active, running: active, mode: 'pane-delivery' }, claudeMd, slots, result };
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
  columns: [],
};

function cleanRef(value) {
  const text = String(value || '').trim();
  return text || null;
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

async function listWorkspacePanes(wsRef) {
  try {
    const panes = (await cmuxJson(['list-panes', '--workspace', wsRef])).panes || [];
    return panes.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  } catch (_) {
    return [];
  }
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
      const surfaceRef = cols[5];
      if (!surfaceRef) continue;
      if (!bySurface[surfaceRef]) bySurface[surfaceRef] = [];
      bySurface[surfaceRef].push(cols.slice(6).join('\t'));
    }
  } catch (_) {}
  return bySurface;
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

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function slotLaunchText(project, cfg, slot) {
  const cmd = configuredSlotCommand(project, cfg, slot);
  const cwd = shellQuote(rowCwd(project));
  const prefix = titleCommand(slot);
  if (slot === 'term' && !cmd) return `${prefix}; cd ${cwd}\\n`;
  return `${prefix}; cd ${cwd} && exec ${cmd || SLOT_DEFS[slot].defaultCommand}\\n`;
}

function gridLaunchText(project, cfg, columnId, slot) {
  const cmd = configuredSlotCommand(project, cfg, slot);
  const cwd = shellQuote(rowCwd(project));
  return `${gridTitleCommand(columnId, slot)}; cd ${cwd} && exec ${cmd || SLOT_DEFS[slot].defaultCommand}\\n`;
}

function slotMarkerSearchText(surface) {
  return [
    surface && surface.title,
    surface && surface.name,
    surface && surface.command,
    surface && surface.description,
    surface && surface.paneTitle,
    surface && surface.paneName,
    surface && surface.paneDescription,
  ].filter(Boolean).join('\n').toLowerCase();
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
  const ws = await findWorkspaceByTag(projectId, { attempts: 1, allowStale: true, quick: true });
  const base = {
    open: !!ws,
    wsRef: ws ? ws.ref : null,
    ref: ws ? ws.ref : null,
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
    let projectState = {
      open: !!ws,
      wsRef: ws ? ws.ref : null,
      ref: ws ? ws.ref : null,
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
    const projectPath = expandHome(project.path);
    if (!projectPath) throw new Error(`project path is missing for ${project.id}`);
    const target = path.join(projectPath, 'CLAUDE.md');

    if (claudeMd.mode === 'create-if-missing' && fs.existsSync(target)) {
      return { ok: true, action: 'skipped' };
    }

    const rendered = renderClaudeMdTemplate(
      fs.readFileSync(templateAbsolutePath(claudeMd.templatePath), 'utf8'),
      project,
    );

    if (claudeMd.mode === 'create-if-missing') {
      fs.writeFileSync(target, rendered, 'utf8');
      return { ok: true, action: 'created' };
    }

    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, rendered, 'utf8');
      return { ok: true, action: 'created' };
    }

    const block = managedClaudeMdBlock(rendered);
    const current = fs.readFileSync(target, 'utf8');
    if (CLAUDE_MD_BLOCK_RE.test(current)) {
      fs.writeFileSync(target, current.replace(CLAUDE_MD_BLOCK_RE, block), 'utf8');
      return { ok: true, action: 'updated-block' };
    }

    fs.writeFileSync(target, appendManagedBlock(current, block), 'utf8');
    return { ok: true, action: 'appended-block' };
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
    },
    cdx: {
      paneRef: column.cdx && column.cdx.paneRef || null,
      surfaceRef: column.cdx && column.cdx.surfaceRef || null,
      marker: column.cdx && column.cdx.marker || null,
    },
    createdAt: column.createdAt || null,
    updatedAt: column.updatedAt || null,
  };
}

function reindexGridColumns() {
  gridRuntimeState.columns.forEach((column, idx) => {
    column.order = idx;
  });
}

async function findGridWorkspace(opts = {}) {
  return findWorkspaceByTag(GRID_ID, opts);
}

async function ensureGridWorkspace() {
  const existing = await findGridWorkspace({ attempts: 1, allowStale: true, quick: true });
  if (existing && existing.ref) {
    gridRuntimeState.wsRef = existing.ref;
    return existing.ref;
  }

  const out = await cmux([
    'new-workspace',
    '--name', 'cmux-dashboard grid',
    '--description', GRID_TAG,
    '--cwd', __dirname,
    '--focus', 'false',
  ]);
  const ref = (out.match(/workspace:\d+/) || [])[0] || null;
  if (!ref) throw new Error('grid workspace was not resolved');
  await settle();
  gridRuntimeState.wsRef = ref;
  gridRuntimeState.columns = [];
  return ref;
}

async function ensureGridAnchorSurface(wsRef) {
  const surfaces = await listWorkspaceSurfaces(wsRef);
  const existing = surfaces.find((surface) => surface && surface.ref);
  if (existing) {
    return { surfaceRef: existing.ref, paneRef: existing.paneRef || null, existing: true };
  }

  const paneRef = await getDefaultPaneRef(wsRef);
  const args = ['new-surface', '--type', 'terminal', '--workspace', wsRef, '--focus', 'false'];
  if (paneRef) args.push('--pane', paneRef);
  const out = await cmux(args);
  const surfaceRef = surfaceRefFromText(out);
  await settle(Math.min(CMUX_SETTLE_MS, 500));
  const nextSurfaces = await listWorkspaceSurfaces(wsRef);
  const created = surfaceRef ? surfaceByRef(nextSurfaces, surfaceRef) : nextSurfaces.find((surface) => surface && surface.ref);
  if (!created || !created.ref) throw new Error(`grid anchor surface was not resolved in ${wsRef}`);
  return { surfaceRef: created.ref, paneRef: created.paneRef || paneRef || null, existing: false };
}

async function createGridSplitSurface(wsRef, anchorSurfaceRef, direction) {
  if (!wsRef) throw new Error('grid workspace ref is required');
  if (!anchorSurfaceRef) throw new Error('grid split anchor surface is required');
  if (!['left', 'right', 'up', 'down'].includes(direction)) throw new Error('invalid grid split direction: ' + direction);

  const beforePanes = await listWorkspacePanes(wsRef);
  const beforeSurfaces = await listWorkspaceSurfaces(wsRef);
  const beforePaneRefs = new Set(beforePanes.map((pane) => pane && pane.ref).filter(Boolean));
  const beforeSurfaceRefs = new Set(beforeSurfaces.map((surface) => surface && surface.ref).filter(Boolean));

  const out = await cmux([
    'new-split',
    direction,
    '--workspace', wsRef,
    '--surface', anchorSurfaceRef,
    '--focus', 'false',
  ]);
  const outputSurfaceRef = surfaceRefFromText(out);
  await settle(Math.min(CMUX_SETTLE_MS, 500));

  const afterPanes = await listWorkspacePanes(wsRef);
  const afterSurfaces = await listWorkspaceSurfaces(wsRef);
  const createdPanes = afterPanes.filter((pane) => pane && pane.ref && !beforePaneRefs.has(pane.ref));
  const createdSurfaces = afterSurfaces.filter((surface) => surface && surface.ref && !beforeSurfaceRefs.has(surface.ref));

  let surface = outputSurfaceRef ? surfaceByRef(afterSurfaces, outputSurfaceRef) : null;
  if (!surface && createdPanes.length) {
    const paneRefs = new Set(createdPanes.map((pane) => pane.ref));
    surface = createdSurfaces.find((item) => paneRefs.has(item.paneRef)) || null;
  }
  if (!surface && createdSurfaces.length) surface = createdSurfaces[createdSurfaces.length - 1];
  if (!surface && outputSurfaceRef) surface = { ref: outputSurfaceRef, paneRef: null };
  if (!surface || !surface.ref) {
    throw new Error(`new-split did not create a grid surface in ${wsRef}`);
  }
  return { surfaceRef: surface.ref, paneRef: surface.paneRef || null, direction, splitFrom: anchorSurfaceRef };
}

function liveSurfaceIndex(surfaces) {
  const byRef = new Map();
  for (const surface of Array.isArray(surfaces) ? surfaces : []) {
    if (surface && surface.ref) byRef.set(surface.ref, surface);
  }
  return byRef;
}

async function validateGridRuntimeState() {
  const ws = await findGridWorkspace({ attempts: 1, allowStale: true, quick: true });
  if (!ws || !ws.ref) {
    gridRuntimeState.wsRef = null;
    gridRuntimeState.columns = [];
    return { wsRef: null, columns: [] };
  }

  gridRuntimeState.wsRef = ws.ref;
  const surfaces = await listWorkspaceSurfaces(ws.ref);
  const byRef = liveSurfaceIndex(surfaces);
  gridRuntimeState.columns = gridRuntimeState.columns.filter((column) => (
    column &&
    column.cc &&
    column.cdx &&
    byRef.has(column.cc.surfaceRef) &&
    byRef.has(column.cdx.surfaceRef)
  )).map((column) => {
    const cc = byRef.get(column.cc.surfaceRef);
    const cdx = byRef.get(column.cdx.surfaceRef);
    return {
      ...column,
      wsRef: ws.ref,
      cc: { ...column.cc, paneRef: cc && cc.paneRef || column.cc.paneRef || null },
      cdx: { ...column.cdx, paneRef: cdx && cdx.paneRef || column.cdx.paneRef || null },
    };
  });
  reindexGridColumns();
  return { wsRef: ws.ref, columns: gridRuntimeState.columns.map((column, idx) => gridColumnSnapshot(column, idx)) };
}

async function getGridState() {
  return validateGridRuntimeState();
}

async function addProjectColumn(projectId) {
  const cfg = loadConfig();
  const project = findConfiguredRow(cfg, projectId);
  if (!project) throw new Error('unknown project: ' + projectId);
  const columnId = gridColumnId(projectId);
  if (!columnId) throw new Error('grid project id is required');

  await validateGridRuntimeState();
  const existing = gridRuntimeState.columns.find((column) => column.projectId === projectId);
  if (existing) return { ...gridColumnSnapshot(existing, existing.order), already: true, added: false };

  const wsRef = await ensureGridWorkspace();
  await validateGridRuntimeState();
  const anchor = gridRuntimeState.columns.length
    ? { surfaceRef: gridRuntimeState.columns[gridRuntimeState.columns.length - 1].cc.surfaceRef }
    : await ensureGridAnchorSurface(wsRef);
  const cc = await createGridSplitSurface(wsRef, anchor.surfaceRef, 'right');
  const cdx = await createGridSplitSurface(wsRef, cc.surfaceRef, 'down');

  await cmux(['send', '--workspace', wsRef, '--surface', cc.surfaceRef, gridLaunchText(project, cfg, columnId, 'cc')]);
  await cmux(['send', '--workspace', wsRef, '--surface', cdx.surfaceRef, gridLaunchText(project, cfg, columnId, 'cdx')]);
  await settle();

  const now = new Date().toISOString();
  const column = {
    columnId,
    projectId,
    wsRef,
    order: gridRuntimeState.columns.length,
    cc: { surfaceRef: cc.surfaceRef, paneRef: cc.paneRef || null, marker: gridSlotMarker(columnId, 'cc') },
    cdx: { surfaceRef: cdx.surfaceRef, paneRef: cdx.paneRef || null, marker: gridSlotMarker(columnId, 'cdx') },
    createdAt: now,
    updatedAt: now,
  };
  gridRuntimeState.columns.push(column);
  return { ...gridColumnSnapshot(column, column.order), added: true, already: false };
}

async function removeProjectColumn(projectId) {
  await validateGridRuntimeState();
  const idx = gridRuntimeState.columns.findIndex((column) => column.projectId === projectId);
  if (idx < 0) {
    return { projectId, removed: false, already: true, ...(await getGridState()) };
  }
  const column = gridRuntimeState.columns[idx];
  const wsRef = gridRuntimeState.wsRef || column.wsRef;
  const refs = [column.cdx && column.cdx.surfaceRef, column.cc && column.cc.surfaceRef].filter(Boolean);
  let closed = 0;
  for (const ref of refs) {
    try {
      await cmux(['close-surface', '--workspace', wsRef, '--surface', ref]);
      closed += 1;
    } catch (_) {}
  }
  gridRuntimeState.columns.splice(idx, 1);
  reindexGridColumns();
  await settle(Math.min(CMUX_SETTLE_MS, 500));
  if (gridRuntimeState.columns.length === 0 && wsRef) {
    await cmux(['close-workspace', '--workspace', wsRef]);
    await settle(Math.min(CMUX_SETTLE_MS, 500));
    gridRuntimeState.wsRef = null;
    gridRuntimeState.columns = [];
    return { projectId, removed: true, closed, wsClosed: true, wsRef: null, columns: [] };
  }
  const state = await getGridState();
  return { projectId, removed: true, closed, ...state };
}

async function openProject(id, { focus = true } = {}) {
  const cfg = loadConfig();
  const p = findConfiguredRow(cfg, id);
  if (!p) throw new Error('unknown project: ' + id);
  const ag = projectAgmsgConfig(p, cfg);
  const collabEnabled = projectCollabEnabled(p, cfg);
  const claudeMd = ensureClaudeMd(p, cfg);
  if (!claudeMd.ok) console.warn(`CLAUDE.md preflight failed for ${id}: ${claudeMd.error}`);

  const existing = await findWorkspaceByTag(id, { attempts: 3, delayMs: 500 });
  if (existing) {
    if (focus) await focusProject(id);
    const collab = collabEnabled ? await ensureCollab(rowCwd(p), true, { team: teamName(p.id) }) : { ok: true, on: false, skipped: true };
    const slots = collabEnabled ? await ensureCollabSlots(id) : [];
    return { ref: existing.ref, wsRef: existing.ref, alreadyOpen: true, claudeMd, slots, collab, state: await getProjectState(id) };
  }

  // 1) agmsg チームをセットアップ（claude 起動前に hook を書き込む）
  const agResult = await agmsgSetup(p, ag);

  // 2) workspace 作成。デフォルト terminal surface は中立扱いにし、
  // cc/cdx/yazi/term は個別 slot toggle で明示 marker 付き surface として追加する。
  const args = [
    'new-workspace',
    '--name', `${p.emoji || (isGlobalProject(p) ? '⌘' : '📁')} ${p.name || p.id}`,
    '--description', TAG + id,
    '--cwd', rowCwd(p),
    '--focus', focus ? 'true' : 'false',
  ];
  const out = await cmux(args);
  const ref = (out.match(/workspace:\d+/) || [])[0] || null;
  await settle();
  const collab = (ref && collabEnabled) ? await ensureCollab(rowCwd(p), true, { team: teamName(p.id) }) : { ok: true, on: false, skipped: true };
  const slots = (ref && collabEnabled) ? await ensureCollabSlots(id) : [];

  return { ref, wsRef: ref, alreadyOpen: false, agmsg: agResult, claudeMd, slots, collab, state: ref ? await getProjectState(id) : null };
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
  const collab = projectCollabEnabled(project, cfg)
    ? await ensureCollab(rowCwd(project), true, { team: teamName(project.id) })
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
  return { id, on: !!on, collab: { enabled: projectCollabEnabled(project, cfg), active, running: active, mode: 'pane-delivery' }, slots, setup: collab, state };
}

async function ensureSlot(id, slot, on) {
  if (!SLOT_DEFS[slot]) throw new Error('unknown slot: ' + slot);
  const cfg = loadConfig();
  const p = findConfiguredRow(cfg, id);
  if (!p) throw new Error('unknown project: ' + id);

  if (on) {
    let state = await getProjectState(id);
    if (!state.open) {
      await openProject(id, { focus: false });
      state = await getProjectState(id);
    }
    if (state.slots[slot] && state.slotRefs[slot]) {
      const repaired = await repairSharedSlotPane(state, slot);
      if (!repaired) {
        return { id, slot, on: true, already: true, ref: state.slotRefs[slot], paneRef: state.slotPaneRefs[slot] || null, wsRef: state.wsRef };
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
    };
  }

  const state = await getProjectState(id);
  if (!state.open || !state.slots[slot]) return { id, slot, on: false, already: true, wsRef: state.wsRef };
  const closed = await closeSlotOwnedPaneSurfaces(id, state, slot);
  const next = closed.next || await getProjectState(id);
  if (!next.slots[slot]) forgetSlotRef(id, slot);
  return { id, slot, on: !!next.slots[slot], closed: closed.closed, paneRefs: closed.paneRefs, wsRef: next.wsRef };
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
    result.collab = await ensureCollab(rowCwd(p), false, { team: teamName(p.id) });
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
  // パス未指定なら ~/projects/<id> を既定にする（新規プロジェクト作成を楽にする）
  const finalPath = cleanPath || `~/projects/${id}`;
  const proj = {
    id, name: cleanName || id, path: finalPath,
    color: color || PALETTE[cfg.projects.length % PALETTE.length],
    emoji: emoji || '🆕',
  };
  if (topCmd) proj.topCmd = topCmd;
  if (bottomCmd) proj.bottomCmd = bottomCmd;

  // フォルダを実際に作成（無ければ）。理想形を自動で保つための足場づくり。
  if (create) {
    const abs = expandHome(finalPath);
    try { fs.mkdirSync(abs, { recursive: true }); } catch (_) {}
    if (gitInit) {
      try { if (!fs.existsSync(path.join(abs, '.git'))) require('child_process').execFileSync('git', ['init', '-q'], { cwd: abs }); } catch (_) {}
    }
  }
  cfg.projects.push(proj);
  saveConfig(cfg);
  return proj;
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
  CMUX, TAG, AGMSG_DIR, CMUX_CONTEXT_ENV_KEYS, SLOT_ORDER, SLOT_DEFS,
  buildCmuxEnv, agmsgAvailable, teamName,
  parseTop, parseMemory, classifyProcess, getMetrics,
  doctor,
  ensureClaudeMd,
  ensureCollab, ensureProjectCollab, ensureCollabPair, isCollabRunning, projectCollabEnabled, projectCollabEnabledById,
  agmsgDbPath, getTeamMessages,
  createCmuxHealthTracker, getCmuxHealth, pingCmuxForRecovery,
  getState, getWorkspaceYaml, getProjectState, ensureSlot, ensureCollabSlots, sendToSurface, submitToSurface, loadConfig, saveConfig, openProject, closeProject, focusProject,
  ensureGridWorkspace, addProjectColumn, removeProjectColumn, getGridState,
  openAll, closeAll, reorderProjects, addProject, removeProject, expandHome,
  projectKind, isGlobalProject, configuredRows, configuredProjectRows, configuredGlobalRows,
};
