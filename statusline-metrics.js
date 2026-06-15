'use strict';
// statusline-metrics.js — T5 (#5): per-session metrics derived from Claude Code
// transcripts (jsonl). ccsl (usedhonda/statusline) is the reference for the
// concepts (context-window %, cost, weekly budget); this is an independent Node
// reimplementation that reads the same data source (transcript jsonl + usage in
// each assistant message). No external deps. cmux is NOT required — transcripts
// are plain files under ~/.claude/projects/<slug>/<sessionId>.jsonl.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Context window sizes (tokens) per model family. Current models are 1M; Haiku
// 4.5 is 200K. Unknown models fall back to 200K (the conservative classic size).
const MODEL_CONTEXT_WINDOW = {
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

// Per-MILLION-token USD rates {input, output, cacheWrite, cacheRead}.
// ⚠️ APPROXIMATE — verify against the claude-api reference / billing before
// trusting cost output. Override the whole table at runtime via either:
//   - env CMUX_DASH_PRICING_JSON='{"claude-opus-4-8":{"input":5,...}}'
//   - env CMUX_DASH_PRICING_FILE=/path/to/pricing.json
// Fable 5 is metered/credit ("Ext") billed and priced above the Opus tier.
const DEFAULT_PRICING = {
  'claude-fable-5':   { input: 6.0, output: 30.0, cacheWrite: 7.5,  cacheRead: 0.6 },
  'claude-mythos-5':  { input: 6.0, output: 30.0, cacheWrite: 7.5,  cacheRead: 0.6 },
  'claude-opus-4-8':  { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7':  { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6':  { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-6':{ input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0,  cacheWrite: 1.25, cacheRead: 0.1 },
};

function loadPricing() {
  try {
    if (process.env.CMUX_DASH_PRICING_JSON) {
      return { ...DEFAULT_PRICING, ...JSON.parse(process.env.CMUX_DASH_PRICING_JSON) };
    }
    if (process.env.CMUX_DASH_PRICING_FILE && fs.existsSync(process.env.CMUX_DASH_PRICING_FILE)) {
      return { ...DEFAULT_PRICING, ...JSON.parse(fs.readFileSync(process.env.CMUX_DASH_PRICING_FILE, 'utf8')) };
    }
  } catch (_) { /* fall through to defaults on malformed override */ }
  return DEFAULT_PRICING;
}

function contextWindowFor(model) {
  return MODEL_CONTEXT_WINDOW[model] || DEFAULT_CONTEXT_WINDOW;
}

// Normalize one transcript line into { ts, tsMs, model, usage } or null.
function normalizeEntry(line) {
  let o;
  try { o = JSON.parse(line); } catch (_) { return null; }
  const msg = o && o.message;
  const u = msg && msg.usage;
  if (!u || typeof u !== 'object') return null;
  const tsMs = o.timestamp ? Date.parse(o.timestamp) : NaN;
  return {
    ts: o.timestamp || null,
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
    model: msg.model || null,
    usage: {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheWrite: Number(u.cache_creation_input_tokens) || 0,
    },
  };
}

function parseTranscript(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const e = normalizeEntry(line);
    if (e) out.push(e);
  }
  return out;
}

// Context window occupancy from the most recent assistant turn. The tokens
// "in context" for the next turn = input + cache_read + cache_creation of the
// latest billed message.
function contextUsage(entries) {
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  const tokens = last.usage.input + last.usage.cacheRead + last.usage.cacheWrite;
  const windowTokens = contextWindowFor(last.model);
  const pct = windowTokens > 0 ? Math.min(100, (tokens / windowTokens) * 100) : 0;
  const cachePct = tokens > 0 ? (last.usage.cacheRead / tokens) * 100 : 0;
  return {
    model: last.model,
    tokens,
    windowTokens,
    pct: Math.round(pct * 10) / 10,
    cachePct: Math.round(cachePct * 10) / 10,
    // ccsl thresholds: warn at 80%, danger at 90%.
    level: pct >= 90 ? 'danger' : pct >= 80 ? 'warn' : 'ok',
  };
}

function costOfUsage(usage, rates) {
  if (!rates) return 0;
  return (
    usage.input * (rates.input || 0) +
    usage.output * (rates.output || 0) +
    usage.cacheWrite * (rates.cacheWrite || 0) +
    usage.cacheRead * (rates.cacheRead || 0)
  ) / 1_000_000;
}

// {turn, session, week} USD. turn = last message; session = whole file;
// week = messages within the last 7 days (by timestamp).
function aggregateCost(entries, pricing, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  let session = 0;
  let week = 0;
  for (const e of entries) {
    const c = costOfUsage(e.usage, pricing[e.model]);
    session += c;
    if (e.tsMs != null && e.tsMs >= weekAgo) week += c;
  }
  const turn = entries.length ? costOfUsage(entries[entries.length - 1].usage, pricing[entries[entries.length - 1].model]) : 0;
  const round = (n) => Math.round(n * 10000) / 10000;
  return { turn: round(turn), session: round(session), week: round(week) };
}

// Locate the newest transcript jsonl for a given project cwd. Claude Code stores
// transcripts under ~/.claude/projects/<slug>/ where slug is the cwd with
// '/' and '.' replaced by '-'.
function transcriptDirForCwd(cwd, baseDir) {
  const root = baseDir || path.join(os.homedir(), '.claude', 'projects');
  const slug = String(cwd || '').replace(/[/.]/g, '-');
  return path.join(root, slug);
}

function newestTranscript(cwd, baseDir) {
  const dir = transcriptDirForCwd(cwd, baseDir);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return null; }
  let best = null;
  let bestMtime = -1;
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = full; }
  }
  return best;
}

// Token-usage sparklines derived purely from transcript timestamps — no live
// data needed. Returns small arrays of per-bucket total tokens (input+output)
// for the last 5h (session window) and last 7 days (weekly window).
function sparklines(entries, nowMs, opts = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const session = bucketTokens(entries, now, 5 * 60 * 60 * 1000, opts.sessionBuckets || 12);
  const week = bucketTokens(entries, now, 7 * 24 * 60 * 60 * 1000, opts.weekBuckets || 7);
  return { session, week };
}

function bucketTokens(entries, now, spanMs, n) {
  const buckets = new Array(n).fill(0);
  const start = now - spanMs;
  const width = spanMs / n;
  for (const e of entries) {
    if (e.tsMs == null || e.tsMs < start || e.tsMs > now) continue;
    let idx = Math.floor((e.tsMs - start) / width);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;
    buckets[idx] += e.usage.input + e.usage.output;
  }
  return buckets;
}

// Render a numeric series as a unicode block sparkline. UI-independent so it can
// be unit-tested and reused server-side.
function renderSparkline(series) {
  const blocks = '▁▂▃▄▅▆▇█';
  const arr = Array.isArray(series) ? series : [];
  const max = Math.max(0, ...arr);
  if (max <= 0) return '▁'.repeat(arr.length);
  return arr.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join('');
}

// Top-level: summarize a transcript file. Graceful degrade — returns
// { ok:false } rather than throwing when data is missing/empty.
function summarizeTranscript(filePath, opts = {}) {
  if (!filePath) return { ok: false, reason: 'no transcript' };
  const entries = parseTranscript(filePath);
  if (!entries.length) return { ok: false, reason: 'empty transcript' };
  const pricing = opts.pricing || loadPricing();
  const ctx = contextUsage(entries);
  const cost = aggregateCost(entries, pricing, opts.nowMs);
  const spark = sparklines(entries, opts.nowMs);
  const last = entries[entries.length - 1];
  return {
    ok: true,
    model: ctx.model,
    context: ctx,
    cost,
    spark,
    sparkText: { session: renderSparkline(spark.session), week: renderSparkline(spark.week) },
    lastTs: last.ts,
    lastTsMs: last.tsMs,
    messageCount: entries.length,
  };
}

// Summarize the newest transcript for a project cwd (convenience).
function summarizeForCwd(cwd, opts = {}) {
  const file = newestTranscript(cwd, opts.baseDir);
  if (!file) return { ok: false, reason: 'no transcript for cwd' };
  return summarizeTranscript(file, opts);
}

module.exports = {
  MODEL_CONTEXT_WINDOW,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_PRICING,
  loadPricing,
  contextWindowFor,
  parseTranscript,
  normalizeEntry,
  contextUsage,
  costOfUsage,
  aggregateCost,
  sparklines,
  renderSparkline,
  transcriptDirForCwd,
  newestTranscript,
  summarizeTranscript,
  summarizeForCwd,
};
