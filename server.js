'use strict';
// cmux-dashboard サーバー — ブラウザのダッシュボードから cmux/agmsg を操作する。
// 依存ゼロ（Node 標準モジュールのみ）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const ctl = require('./cmuxctl');
const { createCollabDelivery } = require('./collab-delivery');

const PORT = parseInt(process.env.CMUX_DASH_PORT || '7799', 10);
const HOST = process.env.CMUX_DASH_HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (_) { resolve({}); } });
  });
}

// cmux に副作用を与えるアクションは「先に200を返し、レスポンス完了後に実行」する。
// cmux の browser ペイン内 webview から fetch された場合、同期実行すると
// cmux ソケットへの再入で Broken pipe になるため、fetch のラウンドトリップから抜けてから実行する。
// さらに action 単位でも直列化し、open/close/open などの連続操作が cmux の
// workspace/pane 生成中に自分で次の socket 操作をぶつける状況を避ける。
let lastError = null;
let actionSeq = 0;
let actionChain = Promise.resolve();
const actions = [];
let selfExitScheduled = false;
let unhealthyExitCheckInFlight = false;
const collabDelivery = createCollabDelivery({ ctl });

function nowIso() { return new Date().toISOString(); }
function actionParts(label) {
  const [type, ...rest] = String(label || 'action').split(':');
  let target = rest.join(':') || null;
  if (type === 'slot' && rest.length) target = rest[0];
  if (type === 'collab' && rest.length) target = rest[0];
  if (type === 'grid') target = rest.length > 1 ? rest[0] : null;
  return { type, target };
}
function rememberAction(label) {
  const parts = actionParts(label);
  const action = {
    id: ++actionSeq,
    label,
    type: parts.type,
    target: parts.target,
    status: 'queued',
    queuedAt: nowIso(),
    updatedAt: nowIso(),
  };
  actions.push(action);
  return action;
}
function updateAction(action, status, extra = {}) {
  Object.assign(action, extra, { status, updatedAt: nowIso() });
  if (status === 'failed') {
    lastError = {
      label: action.label,
      action: action.type,
      target: action.target,
      message: action.error || 'unknown action error',
      at: action.updatedAt,
    };
  } else if (status === 'succeeded' && lastError && lastError.label === action.label) {
    lastError = null;
  }
}
function actionSnapshot() {
  return actions.slice(-50);
}
function latestProjectAction(projectId) {
  const candidates = actionSnapshot()
    .filter((a) => a.target === projectId)
    .sort((a, b) => (b.id || 0) - (a.id || 0));
  return candidates[0] || null;
}
function enrichState(st) {
  st.actions = actionSnapshot();
  st.lastActionError = lastError;
  st.lastError = lastError ? `${lastError.label}: ${lastError.message}` : null;
  st.projects = (st.projects || []).map((p) => ({ ...p, action: latestProjectAction(p.id) }));
  st.globalRows = (st.globalRows || []).map((p) => ({ ...p, action: latestProjectAction(p.id) }));
  return st;
}

function scheduleExit(reason, code = 75) {
  if (selfExitScheduled) return;
  selfExitScheduled = true;
  console.error(reason);
  const t = setTimeout(() => process.exit(code), 150);
  if (typeof t.unref === 'function') t.unref();
}

async function maybeExitOnUnhealthy(st) {
  const cmux = st && st.health && st.health.cmux;
  if (process.env.CMUX_DASH_EXIT_ON_UNHEALTHY !== '1' || !cmux || !cmux.unhealthy) return;
  if (selfExitScheduled || unhealthyExitCheckInFlight) return;

  unhealthyExitCheckInFlight = true;
  try {
    const finalPing = await ctl.pingCmuxForRecovery();
    if (finalPing.ok) {
      console.error(`cmux unhealthy threshold reached at ${cmux.consecutiveFailures}/${cmux.threshold}, but final ping recovered; reset health counter and keep running`);
      return;
    }
    scheduleExit(
      `cmux unhealthy confirmed after ${cmux.consecutiveFailures}/${cmux.threshold} failures; final ping failed: ${finalPing.error || 'unknown error'}; exiting for supervisor restart`,
      74
    );
  } finally {
    unhealthyExitCheckInFlight = false;
  }
}

function queueUnhealthyExitCheck(st) {
  setImmediate(() => {
    maybeExitOnUnhealthy(st).catch((e) => {
      scheduleExit(`cmux unhealthy final check threw: ${e && e.message ? e.message : e}; exiting for supervisor restart`, 74);
    });
  });
}

function defer(res, fn, label) {
  const action = rememberAction(label || 'action');
  sendJson(res, 200, { queued: true, actionId: action.id, label: action.label });
  setImmediate(() => {
    const run = async () => {
      updateAction(action, 'running');
      try {
        const result = await fn();
        updateAction(action, 'succeeded', { result, error: null });
        console.log('action ok', label || '', JSON.stringify(result));
      } catch (e) {
        updateAction(action, 'failed', { error: e.message });
        console.error('action error', label || '', e.message);
      }
    };
    actionChain = actionChain.then(run, run);
    actionChain.catch(() => {});
  });
}

async function api(req, res, urlPath) {
  try {
    const m = urlPath.match(/^\/api\/(open|close|focus)\/(.+)$/);
    const slotToggle = urlPath.match(/^\/api\/project\/([^/]+)\/slot\/([^/]+)$/);
    const collabToggle = urlPath.match(/^\/api\/project\/([^/]+)\/collab$/);
    const gridColumnToggle = urlPath.match(/^\/api\/grid\/column\/([^/]+)$/);
    const agmsg = urlPath.match(/^\/api\/agmsg\/(.+)$/);
    if (req.method === 'GET' && urlPath === '/api/state') {
      const st = enrichState(await ctl.getState());
      sendJson(res, 200, st);
      queueUnhealthyExitCheck(st);
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/metrics') {
      return sendJson(res, 200, await ctl.getMetrics());
    }
    if (req.method === 'GET' && urlPath === '/api/grid') {
      return sendJson(res, 200, await ctl.getGridState());
    }
    if (req.method === 'POST' && urlPath === '/api/grid/rebuild') {
      const body = await readBody(req);
      return sendJson(res, 200, await ctl.rebuildGridSafely(body));
    }
    if (req.method === 'POST' && urlPath === '/api/grid/focus') {
      return defer(res, () => ctl.focusGridWorkspace(), 'grid:focus');
    }
    if (req.method === 'POST' && urlPath === '/api/concierge/ask') {
      const body = await readBody(req);
      return defer(res, () => ctl.conciergeAsk(body && body.text), 'concierge:ask');
    }
    if (req.method === 'GET' && urlPath === '/api/workspace-yaml') {
      return sendText(res, 200, await ctl.getWorkspaceYaml(), 'text/yaml; charset=utf-8');
    }
    if (req.method === 'GET' && urlPath === '/api/doctor') {
      const result = await ctl.doctor();
      return sendJson(res, 200, result);
    }
    if (req.method === 'GET' && agmsg) {
      const id = decodeURIComponent(agmsg[1]);
      const url = new URL(req.url || '/', `http://${HOST}`);
      const team = ctl.teamName(id);
      const result = await ctl.getTeamMessages(team, {
        since: url.searchParams.get('since'),
        limit: url.searchParams.get('limit'),
      });
      return sendJson(res, 200, { ...result, team });
    }
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[2]);
      if (m[1] === 'open')  return defer(res, () => ctl.openProject(id, { focus: true }), "open:"+id);
      if (m[1] === 'close') return defer(res, async () => {
        const result = await ctl.closeProject(id);
        collabDelivery.forgetProject(id);
        return result;
      }, "close:"+id);
      if (m[1] === 'focus') return defer(res, () => ctl.focusProject(id), "focus:"+id);
    }
    if (req.method === 'POST' && slotToggle) {
      const id = decodeURIComponent(slotToggle[1]);
      const slot = decodeURIComponent(slotToggle[2]);
      const body = await readBody(req);
      const on = body && body.on === true;
      return defer(res, () => (
        slot === 'cc' && ctl.projectCollabEnabledById(id)
          ? ctl.ensureCollabPair(id, on)
          : ctl.ensureSlot(id, slot, on)
      ), `slot:${id}:${slot}:${on ? 'on' : 'off'}`);
    }
    if (req.method === 'POST' && collabToggle) {
      const id = decodeURIComponent(collabToggle[1]);
      const body = await readBody(req);
      const on = body && body.on === true;
      return defer(res, async () => {
        const result = await ctl.ensureProjectCollab(id, on);
        if (!on) collabDelivery.forgetProject(id);
        return result;
      }, `collab:${id}:${on ? 'on' : 'off'}`);
    }
    if (req.method === 'POST' && gridColumnToggle) {
      const id = decodeURIComponent(gridColumnToggle[1]);
      const body = await readBody(req);
      const on = body && body.on === true;
      return defer(res, () => (
        on ? ctl.addProjectColumn(id, { focus: body.focus !== false }) : ctl.removeProjectColumn(id)
      ), `grid:${id}:${on ? 'on' : 'off'}`);
    }
    if (req.method === 'POST' && urlPath === '/api/reorder') {
      const body = await readBody(req);
      return defer(res, () => ctl.reorderProjects(body.order), 'reorder');
    }
    if (req.method === 'POST' && urlPath === '/api/open-all')  return defer(res, () => ctl.openAll());
    if (req.method === 'POST' && urlPath === '/api/close-all') return defer(res, async () => {
      const result = await ctl.closeAll();
      for (const item of Array.isArray(result) ? result : []) {
        if (item && item.id) collabDelivery.forgetProject(item.id);
      }
      return result;
    });
    if (req.method === 'POST' && urlPath === '/api/restart') {
      sendJson(res, 202, { ok: true, restarting: true });
      scheduleExit('manual restart requested via /api/restart', 75);
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/projects') {
      const body = await readBody(req);
      // 作成: フォルダ足場づくり込みで登録。autostart=true なら直後に claude/codex/agmsg を起動。
      let proj;
      try {
        proj = ctl.addProject({ ...body, create: body.create !== false });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      if (body.autostart) {
        const action = rememberAction('autostart:' + proj.id);
        setImmediate(() => {
          const run = async () => {
            updateAction(action, 'running');
            try {
              const result = await ctl.openProject(proj.id, { focus: true });
              updateAction(action, 'succeeded', { result, error: null });
              console.log('action ok autostart:' + proj.id, JSON.stringify(result));
            } catch (e) {
              updateAction(action, 'failed', { error: e.message });
              console.error('autostart error', e.message);
            }
          };
          actionChain = actionChain.then(run, run);
          actionChain.catch(() => {});
        });
      }
      return sendJson(res, 200, { ...proj, autostart: !!body.autostart });
    }
    if (req.method === 'DELETE' && urlPath.startsWith('/api/projects/')) {
      const id = decodeURIComponent(urlPath.slice('/api/projects/'.length));
      return sendJson(res, 200, ctl.removeProject(id));
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURI((req.url || '/').split('?')[0]);
  if (urlPath.startsWith('/api/')) return api(req, res, urlPath);
  serveStatic(res, urlPath);
});

server.listen(PORT, HOST, () => {
  console.log(`cmux-dashboard → http://${HOST}:${PORT}`);
  console.log(`  agmsg installed: ${ctl.agmsgAvailable()}`);
  const delivery = collabDelivery.start();
  if (delivery.started) console.log(`  collab pane delivery: every ${delivery.intervalMs}ms`);
});
