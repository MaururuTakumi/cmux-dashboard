#!/usr/bin/env bash
set -u -o pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ID="${CMUX_DASH_TEST_PROJECT:-demo-project}"
TAG="cmuxdash:${PROJECT_ID}"
# Use an isolated default port so the test exercises server startup without
# depending on or perturbing a dashboard instance that is already open.
PORT="${CMUX_DASH_PORT:-$((18000 + ($$ % 1000)))}"
HOST="${CMUX_DASH_HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"
TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cmux-dashboard-test.XXXXXX")"
TEST_PROJECTS_FILE="$TEST_TMP_DIR/projects.json"
TEST_PROJECT_DIR="$TEST_TMP_DIR/project-${PROJECT_ID}"
AGMSG_TEST_STORAGE="$TEST_TMP_DIR/agmsg-store"
export AGMSG_STORAGE_PATH="$AGMSG_TEST_STORAGE"
LOG="${CMUX_DASH_TEST_LOG:-$TEST_TMP_DIR/server.log}"
ACTION_ATTEMPTS="${CMUX_DASH_TEST_ATTEMPTS:-3}"

TOTAL=0
FAILED=0
STARTED_SERVER=0
SERVER_PID=""
BAD_SERVER_PID=""
CREATED_WORKSPACE=0
TEAM_NAME=""
CLAUDE_AGENT=""
CODEX_AGENT=""

pass() {
  TOTAL=$((TOTAL + 1))
  printf 'PASS: %s\n' "$*"
}

fail() {
  TOTAL=$((TOTAL + 1))
  FAILED=1
  printf 'FAIL: %s\n' "$*"
}

info() {
  printf 'INFO: %s\n' "$*"
}

finish() {
  if [ "$FAILED" -eq 0 ]; then
    printf 'FINAL: PASS (%s checks)\n' "$TOTAL"
    exit 0
  fi
  printf 'FINAL: FAIL (%s checks)\n' "$TOTAL"
  exit 1
}

cleanup() {
  if [ "$CREATED_WORKSPACE" -eq 1 ] && [ "$FAILED" -ne 0 ]; then
    post_action close >/dev/null 2>&1 || true
    wait_for_api_project absent 30 >/dev/null 2>&1 || true
  fi
  if [ "$STARTED_SERVER" -eq 1 ] && [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$BAD_SERVER_PID" ]; then
    kill "$BAD_SERVER_PID" >/dev/null 2>&1 || true
    wait "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_TMP_DIR"
}
trap cleanup EXIT

resolve_node() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi
  local n
  for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /opt/homebrew/opt/node@22/bin/node /usr/local/bin/node; do
    if [ -n "$n" ] && [ -x "$n" ]; then
      printf '%s\n' "$n"
      return 0
    fi
  done
  return 1
}

resolve_cmux() {
  if [ -n "${CMUX_BIN:-}" ] && [ -x "$CMUX_BIN" ]; then
    printf '%s\n' "$CMUX_BIN"
    return 0
  fi
  local c
  for c in /Applications/cmux.app/Contents/Resources/bin/cmux /usr/local/bin/cmux /opt/homebrew/bin/cmux "$(command -v cmux 2>/dev/null)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node || true)"
CMUX_BIN="$(resolve_cmux || true)"
REAL_CMUX_BIN="$CMUX_BIN"
REAL_CMUX_AVAILABLE=0

if [ -z "$NODE_BIN" ]; then
  fail "node executable not found"
  finish
fi
if [ -z "$CMUX_BIN" ]; then
  fail "cmux executable not found"
  finish
fi
if CMUX_QUIET=1 "$REAL_CMUX_BIN" list-workspaces --json >/dev/null 2>&1; then
  REAL_CMUX_AVAILABLE=1
fi

mkdir -p "$TEST_PROJECT_DIR"

run_p1_oss_checks() {
  local phase_dir="$TEST_TMP_DIR/p1-oss"
  local restore_file="$phase_dir/projects.json"
  local results
  local rc
  local saw_output=0
  mkdir -p "$phase_dir"

  results="$(
    CMUX_DASH_PROJECTS_FILE="$restore_file" \
    "$NODE_BIN" - "$DIR" "$restore_file" <<'NODE'
const fs = require("fs");
const path = require("path");

const repo = process.argv[2];
const restoreFile = process.argv[3];
const exampleFile = path.join(repo, "projects.example.json");
const licenseFile = path.join(repo, "LICENSE");
const readmeFile = path.join(repo, "README.md");
const ctl = require(path.join(repo, "cmuxctl.js"));

let failed = 0;
function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}
function read(file) {
  return fs.readFileSync(file, "utf8");
}

try {
  fs.rmSync(restoreFile, { force: true });

  const example = JSON.parse(read(exampleFile));
  const projects = Array.isArray(example.projects) ? example.projects : [];
  const normalProjects = projects.filter((p) => p && p.kind !== "global");
  const global = projects.find((p) => p && p.id === "cc-general" && p.kind === "global");
  const slots = example.defaults && example.defaults.slotCommands;
  const agmsg = example.defaults && example.defaults.agmsg;
  const claudeMd = example.defaults && example.defaults.claudeMd;

  check("P1 projects.example.json is valid JSON with placeholders and global cc-general", (
    normalProjects.length >= 1 &&
    normalProjects.length <= 2 &&
    normalProjects.every((p) => /^~\/projects\//.test(p.path || "") && p.color && p.emoji) &&
    global &&
    global.path === "~" &&
    global.color &&
    global.emoji
  ));

  check("P1 projects.example.json defaults include slots, agmsg, claudeMd, and collab=true", (
    slots &&
    ["cc", "cdx", "yazi", "term"].every((slot) => Object.prototype.hasOwnProperty.call(slots, slot)) &&
    agmsg &&
    agmsg.enabled === true &&
    agmsg.claudeName === "claude" &&
    agmsg.codexName === "codex" &&
    claudeMd &&
    claudeMd.mode === "managed-block" &&
    example.defaults.collab === true
  ));

  const cfg = ctl.loadConfig();
  const restored = read(restoreFile);
  check("P1 loadConfig restores missing projects.json from projects.example.json", (
    fs.existsSync(restoreFile) &&
    restored === read(exampleFile) &&
    Array.isArray(cfg.projects) &&
    cfg.projects.some((p) => p && p.id === "cc-general" && p.kind === "global")
  ));

  const license = read(licenseFile);
  check("P1 LICENSE is MIT with cmux-dashboard contributors copyright", (
    license.includes("MIT License") &&
    license.includes("Copyright (c) 2026 cmux-dashboard contributors") &&
    license.includes("Permission is hereby granted")
  ));

  const readme = read(readmeFile);
  check("P1 README has OSS quick start, requirements, usage, limitations, and English quick start", (
    readme.includes("## 概要") &&
    readme.includes("## 必要要件") &&
    readme.includes("## クイックスタート") &&
    readme.includes("## English Quick Start") &&
    readme.includes("## 使い方") &&
    readme.includes("## 既知の制約") &&
    readme.includes("./cmux-dash up") &&
    readme.includes("cmuxペイン") &&
    readme.includes("collab") &&
    readme.includes("visible pane delivery") &&
    readme.includes("does not start a headless Codex")
  ));
} catch (err) {
  failed += 1;
  console.log("FAIL\tP1 OSS runner exception: " + (err && err.message ? err.message : err));
}

process.exit(failed ? 1 : 0);
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "$label" ;;
      FAIL) fail "$label" ;;
      *) info "P1 output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "P1 OSS runner produced no output"
  fi
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi

  if grep -qx 'projects.json' "$DIR/.gitignore" 2>/dev/null; then
    pass "P1 .gitignore contains projects.json"
  else
    fail "P1 .gitignore does not contain projects.json"
    return 1
  fi

  if [ -z "$(cd "$DIR" && git ls-files projects.json)" ]; then
    pass "P1 git ls-files excludes projects.json"
  else
    fail "P1 git ls-files still includes projects.json"
    return 1
  fi
}

if ! run_p1_oss_checks; then
  finish
fi

run_r2_metrics_checks() {
  local phase_dir="$TEST_TMP_DIR/r2-metrics"
  local fake_cmux="$phase_dir/cmux"
  local cfg_file="$phase_dir/projects.json"
  local api_log="$phase_dir/api.log"
  local bad_cmux="$phase_dir/cmux-top-fail"
  local bad_api_log="$phase_dir/api-top-fail.log"
  local api_port=$((PORT + 3300))
  local api_url="http://${HOST}:${api_port}"
  local bad_api_port=$((api_port + 1))
  local bad_api_url="http://${HOST}:${bad_api_port}"
  local results
  local rc
  local body
  local bad_body
  local saw_output=0
  mkdir -p "$phase_dir/alpha" "$phase_dir/beta"
  cat >"$fake_cmux" <<'SH'
#!/usr/bin/env bash
cmd="${1:-}"
case "$cmd" in
  ping)
    printf 'pong\n'
    ;;
  list-workspaces)
    printf '{"workspaces":[{"ref":"workspace:alpha","description":"cmuxdash:alpha"},{"ref":"workspace:beta","description":"cmuxdash:beta"}]}\n'
    ;;
  top)
    cat <<'TSV'
cpu	rss	proc	kind	ref	parentRef	command
0	167772160	5	total	total		cmux
0	104857600	4	workspace	workspace:alpha	window:1	Alpha
0	73400320	3	pane	pane:alpha	workspace:alpha	Alpha pane
0	52428800	2	surface	surface:cc	pane:alpha	cmuxdash:slot:cc
0	10485760	1	process	process:9876501	surface:cc	2.1.168
0	20971520	1	process	process:9876502	surface:cc	mcp-server
0	20971520	1	surface	surface:cdx	pane:alpha	cmuxdash:slot:cdx
0	20971520	1	process	process:9876503	surface:cdx	codex
0	62914560	1	workspace	workspace:beta	window:1	Beta
0	62914560	1	pane	pane:beta	workspace:beta	Beta pane
0	62914560	1	surface	surface:term	pane:beta	terminal
0	62914560	1	process	process:9876504	surface:term	zsh
TSV
    ;;
  memory)
    cat <<'TXT'
cmux memory summary
Footprint: 512 MiB
Child RSS total: 160 MiB
Top groups:
  renderer: 90 MiB
TXT
    ;;
  *)
    printf '{}\n'
    ;;
esac
SH
  chmod +x "$fake_cmux"
  cat >"$bad_cmux" <<'SH'
#!/usr/bin/env bash
cmd="${1:-}"
case "$cmd" in
  ping)
    printf 'pong\n'
    ;;
  list-workspaces)
    printf '{"workspaces":[{"ref":"workspace:alpha","description":"cmuxdash:alpha"}]}\n'
    ;;
  memory)
    printf 'Footprint: 64 MiB\nChild RSS total: 32 MiB\n'
    ;;
  top)
    printf 'simulated top failure\n' >&2
    exit 44
    ;;
  *)
    printf '{}\n'
    ;;
esac
SH
  chmod +x "$bad_cmux"

  results="$(
    CMUX_BIN="$fake_cmux" \
    CMUX_DASH_PROJECTS_FILE="$cfg_file" \
    CMUX_DASH_READ_TIMEOUT=1000 \
    CMUX_DASH_READ_RETRY_BUDGET_MS=1000 \
    CMUX_DASH_READ_RETRIES=0 \
    "$NODE_BIN" - "$DIR" "$phase_dir" <<'NODE'
const fs = require("fs");
const path = require("path");

const repo = process.argv[2];
const phaseDir = process.argv[3];
const cfgFile = process.env.CMUX_DASH_PROJECTS_FILE;
const ctl = require(path.join(repo, "cmuxctl.js"));

let failed = 0;
function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}

(async () => {
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({
      _comment: "R2 metrics isolated test config",
      defaults: { agmsg: { enabled: false }, claudeMd: { mode: "off" }, collab: false },
      projects: [
        { id: "alpha", name: "Alpha", path: path.join(phaseDir, "alpha") },
        { id: "beta", name: "Beta", path: path.join(phaseDir, "beta") },
      ],
    }, null, 2) + "\n");

    const topSample = [
      "cpu\trss\tproc\tkind\tref\tparentRef\tcommand",
      "0\t104857600\t4\tworkspace\tworkspace:alpha\twindow:1\tAlpha",
      "0\t52428800\t2\tsurface\tsurface:cc\tpane:alpha\tcmuxdash:slot:cc",
      "0\t10485760\t1\tprocess\tprocess:9876501\tsurface:cc\t2.1.168",
    ].join("\n");
    const rows = ctl.parseTop(topSample);
    check("parseTop skips header and parses numeric tsv fields", (
      rows.length === 3 &&
      rows[0].kind === "workspace" &&
      rows[0].rssBytes === 104857600 &&
      rows[2].command === "2.1.168"
    ));

    const mem = ctl.parseMemory("Footprint: 512 MiB\nChild RSS total: 160 MiB\nrenderer: 90 MiB\n");
    check("parseMemory extracts footprint, child RSS, and groups", (
      mem.footprint === 536870912 &&
      mem.childRss === 167772160 &&
      mem.groups.length === 1 &&
      mem.groups[0].rssBytes === 94371840
    ));

    check("classifyProcess maps claude/codex/mcp/other", (
      ctl.classifyProcess("2.1.168") === "C" &&
      ctl.classifyProcess("codex") === "X" &&
      ctl.classifyProcess("node", "node /tmp/mcp-server/index.js") === "M" &&
      ctl.classifyProcess("zsh") === "O"
    ));

    const metrics = await ctl.getMetrics();
    const alpha = metrics.projects.find((p) => p.id === "alpha");
    const beta = metrics.projects.find((p) => p.id === "beta");
    check("getMetrics returns app footprint and child RSS from cmux memory", (
      metrics.app.footprint === 536870912 &&
      metrics.app.childRss === 167772160 &&
      metrics.error === null
    ));
    check("getMetrics aggregates per-project RSS and process counts", (
      alpha && beta &&
      alpha.rssBytes === 104857600 &&
      alpha.procCount === 4 &&
      beta.rssBytes === 62914560 &&
      beta.procCount === 1
    ));
    check("getMetrics aggregates per-slot surface RSS", (
      alpha.bySlot.cc.rssBytes === 52428800 &&
      alpha.bySlot.cdx.rssBytes === 20971520 &&
      beta.bySlot.term.rssBytes === 62914560
    ));
    check("getMetrics aggregates process type breakdown", (
      metrics.byType.C.rssBytes === 10485760 &&
      metrics.byType.M.rssBytes === 20971520 &&
      metrics.byType.X.rssBytes === 20971520 &&
      metrics.byType.O.rssBytes === 62914560 &&
      alpha.byType.C.rssBytes === 10485760 &&
      alpha.byType.M.rssBytes === 20971520 &&
      alpha.byType.X.rssBytes === 20971520 &&
      beta.byType.O.rssBytes === 62914560
    ));
  } catch (err) {
    failed += 1;
    console.log("FAIL\tR2 metrics runner exception: " + (err && err.message ? err.message : err));
  }
  process.exit(failed ? 1 : 0);
})();
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "R2: $label" ;;
      FAIL) fail "R2: $label" ;;
      *) info "R2 output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "R2 metrics runner produced no output"
  fi
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi

  (cd "$DIR" && exec env CMUX_BIN="$fake_cmux" CMUX_DASH_PORT="$api_port" CMUX_DASH_HOST="$HOST" CMUX_DASH_PROJECTS_FILE="$cfg_file" CMUX_DASH_READ_TIMEOUT=1000 CMUX_DASH_READ_RETRY_BUDGET_MS=1000 CMUX_DASH_READ_RETRIES=0 "$NODE_BIN" server.js >"$api_log" 2>&1) &
  BAD_SERVER_PID=$!
  for _ in $(seq 1 50); do
    body="$(curl -fsS --max-time 2 "$api_url/api/metrics" 2>/dev/null || true)"
    [ -n "$body" ] && break
    sleep 0.2
  done
  kill "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  wait "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  BAD_SERVER_PID=""

  if printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const alpha = (Array.isArray(obj.projects) ? obj.projects : []).find((p) => p && p.id === "alpha");
const ok = obj && obj.app && obj.app.footprint === 536870912 &&
  typeof obj.updatedAt === "string" &&
  obj.error === null &&
  obj.byType && obj.byType.C && obj.byType.M && obj.byType.X && obj.byType.O &&
  alpha &&
  alpha.bySlot && alpha.bySlot.cc && alpha.bySlot.cc.rssBytes === 52428800 &&
  alpha.byType && alpha.byType.X && alpha.byType.X.procCount === 1;
process.exit(ok ? 0 : 1);
' 2>/dev/null; then
    pass "R2: GET /api/metrics returns app/projects/bySlot/byType contract"
  else
    fail "R2: GET /api/metrics contract failed"
    info "R2 metrics API payload: ${body:-empty}; log=$api_log"
    return 1
  fi

  (cd "$DIR" && exec env CMUX_BIN="$bad_cmux" CMUX_DASH_PORT="$bad_api_port" CMUX_DASH_HOST="$HOST" CMUX_DASH_PROJECTS_FILE="$cfg_file" CMUX_DASH_READ_TIMEOUT=1000 CMUX_DASH_READ_RETRY_BUDGET_MS=1000 CMUX_DASH_READ_RETRIES=0 "$NODE_BIN" server.js >"$bad_api_log" 2>&1) &
  BAD_SERVER_PID=$!
  for _ in $(seq 1 50); do
    bad_body="$(curl -fsS --max-time 2 "$bad_api_url/api/metrics" 2>/dev/null || true)"
    [ -n "$bad_body" ] && break
    sleep 0.2
  done
  kill "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  wait "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  BAD_SERVER_PID=""

  if printf '%s' "$bad_body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const ok = obj && obj.app && obj.app.footprint === 67108864 &&
  obj.byType && obj.byType.C && obj.byType.M && obj.byType.X && obj.byType.O &&
  Array.isArray(obj.projects) && obj.projects.length === 0 &&
  typeof obj.updatedAt === "string" &&
  typeof obj.error === "string" && /top:/.test(obj.error);
process.exit(ok ? 0 : 1);
' 2>/dev/null; then
    pass "R2: GET /api/metrics returns empty projects plus error on top failure"
  else
    fail "R2: GET /api/metrics top failure contract failed"
    info "R2 metrics top-fail payload: ${bad_body:-empty}; log=$bad_api_log"
    return 1
  fi

  if "$NODE_BIN" - "$DIR/public/index.html" <<'NODE' 2>/dev/null
const fs = require("fs");
const html = fs.readFileSync(process.argv[2], "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) process.exit(2);
const script = scriptMatch[1];
const checks = [
  html.includes("Memory"),
  html.includes("CC &amp; Codex"),
  html.includes("id=\"metricsPanels\""),
  script.includes("function refreshMetrics()"),
  script.includes("jget('/api/metrics')"),
  script.includes("document.visibilityState"),
  script.includes("C=Claude/CC"),
  script.includes("typeChips(totals)"),
];
process.exit(checks.every(Boolean) ? 0 : 1);
NODE
  then
    pass "R2: UI metrics panels and scoped polling static contract are present"
  else
    fail "R2: UI metrics static contract failed"
    return 1
  fi
}

if ! run_r2_metrics_checks; then
  finish
fi

run_r4_checks() {
  local phase_dir="$TEST_TMP_DIR/r4"
  local fake_cmux="$phase_dir/cmux"
  local cfg_file="$phase_dir/projects.json"
  local api_log="$phase_dir/api.log"
  local header_file="$phase_dir/workspace-yaml.headers"
  local api_port=$((PORT + 3400))
  local api_url="http://${HOST}:${api_port}"
  local state_file="$phase_dir/state.json"
  local results
  local rc
  local body
  local saw_output=0
  mkdir -p "$phase_dir/alpha"
  printf '{"workspaces":[],"panes":[],"surfaces":[],"nextWorkspace":1,"nextPane":1,"nextSurface":1}\n' >"$state_file"
  cat >"$fake_cmux" <<SH
#!/usr/bin/env bash
STATE="$state_file"
NODE_BIN="$NODE_BIN"
cmd="\${1:-}"
shift || true
case "\$cmd" in
  ping)
    printf 'pong\n'
    ;;
  list-workspaces)
    "\$NODE_BIN" - "\$STATE" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
let s = { workspaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
process.stdout.write(JSON.stringify({ workspaces: Array.isArray(s.workspaces) ? s.workspaces : [] }) + "\n");
NODE
    ;;
  new-workspace)
    desc=""
    name=""
    cwd=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --description) desc="\${2:-}"; shift 2 ;;
        --name) name="\${2:-}"; shift 2 ;;
        --cwd) cwd="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$desc" "\$name" "\$cwd" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const desc = process.argv[3] || "cmuxdash:unknown";
const name = process.argv[4] || "";
const cwd = process.argv[5] || "";
let s = { workspaces: [], panes: [], surfaces: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.workspaces = Array.isArray(s.workspaces) ? s.workspaces : [];
s.panes = Array.isArray(s.panes) ? s.panes : [];
s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
const wsRef = "workspace:" + (s.nextWorkspace || 1);
const paneRef = "pane:" + (s.nextPane || 1);
const surfaceRef = "surface:" + (s.nextSurface || 1);
s.nextWorkspace = (s.nextWorkspace || 1) + 1;
s.nextPane = (s.nextPane || 1) + 1;
s.nextSurface = (s.nextSurface || 1) + 1;
s.workspaces.push({ ref: wsRef, description: desc, name, cwd, selected: false, latest_conversation_message: null, latest_submitted_at: null });
s.panes.push({ ref: paneRef, workspace: wsRef, index: 0 });
s.surfaces.push({ ref: surfaceRef, workspace: wsRef, pane: paneRef, title: "terminal", type: "terminal", process: "zsh", cwd, sendText: null, initial: true });
    fs.writeFileSync(file, JSON.stringify(s) + "\n");
    process.stdout.write(wsRef + "\n");
NODE
    ;;
  close-workspace)
    workspace=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
let s = { workspaces: [], panes: [], surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.workspaces = (Array.isArray(s.workspaces) ? s.workspaces : [])
  .filter((ws) => !(ws && ws.ref === workspace));
s.panes = (Array.isArray(s.panes) ? s.panes : [])
  .filter((pane) => !(pane && pane.workspace === workspace));
s.surfaces = (Array.isArray(s.surfaces) ? s.surfaces : [])
  .filter((surface) => !(surface && surface.workspace === workspace));
fs.writeFileSync(file, JSON.stringify(s) + "\n");
NODE
    ;;
  list-panes)
    workspace=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
let s = { panes: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
const panes = (s.panes || []).filter((p) => !workspace || p.workspace === workspace);
process.stdout.write(JSON.stringify({ panes }) + "\n");
NODE
    ;;
  list-pane-surfaces)
    workspace=""
    pane=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --pane) pane="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$pane" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
const pane = process.argv[4] || "";
let s = { surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
const surfaces = (s.surfaces || [])
  .filter((x) => (!workspace || x.workspace === workspace) && (!pane || x.pane === pane))
  .map((x) => ({ ref: x.ref, title: x.title, type: x.type, url: x.url || null, paneRef: x.pane, cwd: x.cwd || null }));
process.stdout.write(JSON.stringify({ surfaces }) + "\n");
NODE
    ;;
  new-pane)
    workspace=""
    direction=""
    type="terminal"
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --direction) direction="\${2:-}"; shift 2 ;;
        --type) type="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$direction" "\$type" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
const direction = process.argv[4] || "";
const type = process.argv[5] || "terminal";
let s = { panes: [], surfaces: [], nextPane: 1, nextSurface: 1 };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.panes = Array.isArray(s.panes) ? s.panes : [];
s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
const paneRef = "pane:" + (s.nextPane || 1);
const surfaceRef = "surface:" + (s.nextSurface || 1);
s.nextPane = (s.nextPane || 1) + 1;
s.nextSurface = (s.nextSurface || 1) + 1;
s.panes.push({ ref: paneRef, workspace, index: s.panes.filter((p) => !workspace || p.workspace === workspace).length, direction });
s.surfaces.push({ ref: surfaceRef, workspace, pane: paneRef, title: "terminal", type, process: "zsh", cwd: null, sendText: null });
fs.writeFileSync(file, JSON.stringify(s) + "\n");
process.stdout.write(surfaceRef + "\n");
NODE
    ;;
  new-split)
    direction="\${1:-right}"
    if [ "\$#" -gt 0 ]; then shift; fi
    workspace=""
    surface=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --surface|--panel) surface="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$surface" "\$direction" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
const anchorSurface = process.argv[4] || "";
const direction = process.argv[5] || "right";
let s = { panes: [], surfaces: [], nextPane: 1, nextSurface: 1 };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.panes = Array.isArray(s.panes) ? s.panes : [];
s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
const anchor = s.surfaces.find((item) => item && item.ref === anchorSurface && (!workspace || item.workspace === workspace));
const anchorPaneRef = anchor && anchor.pane || "";
const anchorPane = s.panes.find((pane) => pane && pane.ref === anchorPaneRef && (!workspace || pane.workspace === workspace));
const paneRef = "pane:" + (s.nextPane || 1);
const surfaceRef = "surface:" + (s.nextSurface || 1);
s.nextPane = (s.nextPane || 1) + 1;
s.nextSurface = (s.nextSurface || 1) + 1;
const insertAt = anchorPane && Number.isFinite(anchorPane.index) ? anchorPane.index + 1 : s.panes.filter((p) => !workspace || p.workspace === workspace).length;
for (const pane of s.panes) {
  if (pane && (!workspace || pane.workspace === workspace) && Number.isFinite(pane.index) && pane.index >= insertAt) {
    pane.index += 1;
  }
}
s.panes.push({ ref: paneRef, workspace, index: insertAt, direction, splitFrom: anchorSurface, parentPane: anchorPaneRef });
s.surfaces.push({ ref: surfaceRef, workspace, pane: paneRef, title: "terminal", type: "terminal", process: "zsh", cwd: anchor && anchor.cwd || null, sendText: null, splitFrom: anchorSurface, direction });
fs.writeFileSync(file, JSON.stringify(s) + "\n");
process.stdout.write("OK " + surfaceRef + " " + paneRef + " " + workspace + "\n");
NODE
    ;;
  new-surface)
    workspace=""
    pane=""
    type="terminal"
    url=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --pane) pane="\${2:-}"; shift 2 ;;
        --type) type="\${2:-}"; shift 2 ;;
        --url) url="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$pane" "\$type" "\$url" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
let pane = process.argv[4] || "";
const type = process.argv[5] || "terminal";
const url = process.argv[6] || "";
let s = { panes: [], surfaces: [], nextSurface: 1 };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.panes = Array.isArray(s.panes) ? s.panes : [];
s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
if (!pane) {
  const p = s.panes.find((x) => x && (!workspace || x.workspace === workspace));
  pane = p && p.ref || "pane:1";
}
const surfaceRef = "surface:" + (s.nextSurface || 1);
s.nextSurface = (s.nextSurface || 1) + 1;
s.surfaces.push({
  ref: surfaceRef,
  workspace,
  pane,
  title: type === "browser" ? url : "terminal",
  type,
  url: type === "browser" ? url : null,
  process: type === "browser" ? "browser" : "zsh",
  cwd: null,
  sendText: null,
});
fs.writeFileSync(file, JSON.stringify(s) + "\n");
process.stdout.write(surfaceRef + "\n");
NODE
    ;;
  send)
    surface=""
    workspace=""
    text=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --surface) surface="\${2:-}"; shift 2 ;;
        --workspace) workspace="\${2:-}"; shift 2 ;;
        *) text="\$1"; shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$surface" "\$workspace" "\$text" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const surface = process.argv[3] || "";
const workspace = process.argv[4] || "";
const text = process.argv[5] || "";
let s = { surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
const match = text.match(/cmuxdash:slot:(cc|cdx|yazi|term)/);
const gridMatch = text.match(/(cmuxdash:grid:[^\s']+:slot:(cc|cdx))/);
const slot = gridMatch && gridMatch[2] || match && match[1];
const title = gridMatch && gridMatch[1] || (slot ? "cmuxdash:slot:" + slot : null);
const processBySlot = { cc: "claude", cdx: "codex", yazi: "yazi", term: "zsh" };
const cdMarker = "cd " + String.fromCharCode(39);
const cdStart = text.indexOf(cdMarker);
let cwd = null;
if (cdStart >= 0) {
  const quote = String.fromCharCode(39);
  const backslash = String.fromCharCode(92);
  const rest = text.slice(cdStart + cdMarker.length);
  let parsed = "";
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === quote) {
      if (rest[i + 1] === backslash && rest[i + 2] === quote && rest[i + 3] === quote) {
        parsed += quote;
        i += 3;
        continue;
      }
      cwd = parsed;
      break;
    }
    parsed += rest[i];
  }
}
for (const item of (s.surfaces || [])) {
  if (item && item.ref === surface && slot) {
    item.title = process.env.CMUX_FAKE_OVERWRITE_SLOT_TITLE === "1" && slot === "cc"
      ? "✳ Claude Code"
      : title;
    item.process = processBySlot[slot] || "zsh";
    item.workspace = item.workspace || workspace;
    item.cwd = cwd;
    item.sendText = text;
  }
}
fs.writeFileSync(file, JSON.stringify(s) + "\n");
NODE
    ;;
  close-surface)
    workspace=""
    surface=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --surface) surface="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$surface" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
const surface = process.argv[4] || "";
let s = { panes: [], surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
if (surface.startsWith("pane:")) {
  const blocked = (Array.isArray(s.surfaces) ? s.surfaces : [])
    .some((item) => item && item.pane === surface && item.initial && (!workspace || item.workspace === workspace));
  if (blocked) {
    fs.writeFileSync(file, JSON.stringify(s) + "\n");
    process.exit(0);
  }
  s.panes = (Array.isArray(s.panes) ? s.panes : [])
    .filter((pane) => !(pane && pane.ref === surface && (!workspace || pane.workspace === workspace)));
  s.surfaces = (Array.isArray(s.surfaces) ? s.surfaces : [])
    .filter((item) => !(item && item.pane === surface && (!workspace || item.workspace === workspace)));
  fs.writeFileSync(file, JSON.stringify(s) + "\n");
  process.exit(0);
}
const initialTarget = (Array.isArray(s.surfaces) ? s.surfaces : [])
  .find((item) => item && item.ref === surface && item.initial && (!workspace || item.workspace === workspace));
if (initialTarget) {
  fs.writeFileSync(file, JSON.stringify(s) + "\n");
  process.exit(0);
}
if (process.env.CMUX_FAKE_STALE_SLOT_CLOSE === "1") {
  const target = (Array.isArray(s.surfaces) ? s.surfaces : [])
    .find((item) => item && item.ref === surface && (!workspace || item.workspace === workspace));
  const match = target && String(target.title || "").match(/cmuxdash:slot:(cc|cdx|yazi|term)/);
  if (match) {
    fs.writeFileSync(file, JSON.stringify(s) + "\n");
    process.exit(0);
  }
}
const removed = (Array.isArray(s.surfaces) ? s.surfaces : [])
  .filter((item) => item && item.ref === surface && (!workspace || item.workspace === workspace));
s.surfaces = (Array.isArray(s.surfaces) ? s.surfaces : [])
  .filter((item) => !(item && item.ref === surface && (!workspace || item.workspace === workspace)));
const removedPanes = new Set(removed.map((item) => item && item.pane).filter(Boolean));
s.panes = (Array.isArray(s.panes) ? s.panes : []).filter((pane) => {
  if (!pane || !removedPanes.has(pane.ref)) return true;
  return s.surfaces.some((surface) => surface && surface.pane === pane.ref);
});
fs.writeFileSync(file, JSON.stringify(s) + "\n");
NODE
    ;;
  top)
    "\$NODE_BIN" - "\$STATE" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
let s = { surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
let idx = 1;
for (const surface of (s.surfaces || [])) {
  process.stdout.write("0\t0\t1\tprocess\tprocess:" + (idx++) + "\t" + surface.ref + "\t" + (surface.process || "zsh") + "\n");
}
NODE
    ;;
  reorder-workspaces|select-workspace)
    ;;
  *)
    printf '{}\n'
    ;;
esac
SH
  chmod +x "$fake_cmux"

  results="$(
    CMUX_BIN="$fake_cmux" \
    CMUX_DASH_PROJECTS_FILE="$cfg_file" \
    CMUX_DASH_PORT="$api_port" \
    CMUX_DASH_HOST="$HOST" \
    CMUX_DASH_SETTLE_MS=0 \
    CMUX_DASH_OPENALL_GAP_MS=0 \
    "$NODE_BIN" - "$DIR" "$phase_dir" "$state_file" <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = process.argv[2];
const phaseDir = process.argv[3];
const stateFile = process.argv[4];
const cfgFile = process.env.CMUX_DASH_PROJECTS_FILE;
const ctl = require(path.join(repo, "cmuxctl.js"));

let failed = 0;
function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}
function yamlHasGlobalCcOn(yaml) {
  const ruby = spawnSync("ruby", ["-e", [
    "require 'yaml'",
    "obj = YAML.safe_load(STDIN.read, aliases: false)",
    "rows = obj['rows'] || []",
    "ok = rows.any? { |r| r['id'] == 'cc-general' && r['kind'] == 'global' && r.dig('slots', 'cc', 'on') == true }",
    "exit(ok ? 0 : 1)",
  ].join("; ")], { input: yaml, encoding: "utf8" });
  return ruby.status === 0;
}
function rawCmuxState() {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}
function workspaceFor(id) {
  return (rawCmuxState().workspaces || []).find((w) => w && w.description === "cmuxdash:" + id) || null;
}
function surfacesFor(id) {
  const ws = workspaceFor(id);
  if (!ws) return [];
  return (rawCmuxState().surfaces || []).filter((s) => s && s.workspace === ws.ref);
}
function panesFor(id) {
  const ws = workspaceFor(id);
  if (!ws) return [];
  return (rawCmuxState().panes || []).filter((p) => p && p.workspace === ws.ref);
}
function paneForRef(ref) {
  return (rawCmuxState().panes || []).find((p) => p && p.ref === ref) || null;
}
function surfaceForSlot(id, slot) {
  return surfacesFor(id).find((s) => s && s.title === "cmuxdash:slot:" + slot) || null;
}
function rawSurface(ref) {
  return (rawCmuxState().surfaces || []).find((s) => s && s.ref === ref) || null;
}
function surfaceCountFor(id) {
  return surfacesFor(id).length;
}
function stateHasSlotMarker(state, slot) {
  const marker = "cmuxdash:slot:" + slot;
  return (state.surfaces || []).some((surface) => {
    const haystack = [surface.title, surface.paneTitle, surface.paneDescription].filter(Boolean).join("\n");
    return surface.slot === slot || haystack.includes(marker);
  });
}
function shellQuoted(value) {
  const q = String.fromCharCode(39);
  const backslash = String.fromCharCode(92);
  return q + String(value || "").split(q).join(q + backslash + q + q) + q;
}
async function exerciseSlotCycle(id, slot, expectedCwd, label, expectAutoOpen) {
  const beforeState = await ctl.getProjectState(id);
  const beforeCount = surfacesFor(id).length;
  const onResult = await ctl.ensureSlot(id, slot, true);
  const afterOnState = await ctl.getProjectState(id);
  const afterOnCount = surfacesFor(id).length;
  const surface = surfaceForSlot(id, slot);
  const splitPane = surface && surface.pane ? paneForRef(surface.pane) : null;
  if (expectAutoOpen) {
    check("slot " + label + "/" + slot + ": ON auto-opens unopened row", !beforeState.open && afterOnState.open);
  }
  check("slot " + label + "/" + slot + ": ON increases surface count", (
    onResult.on === true &&
    afterOnState.slots[slot] === true &&
    afterOnCount === beforeCount + (beforeState.open ? 1 : 2)
  ));
  check("slot " + label + "/" + slot + ": ON creates vertical split pane", (
    surface &&
    surface.pane &&
    onResult.paneRef === surface.pane &&
    onResult.split === true &&
    splitPane &&
    splitPane.direction === "down"
  ));
  check("slot " + label + "/" + slot + ": send text cd into expected cwd", (
    surface &&
    surface.cwd === expectedCwd &&
    typeof surface.sendText === "string" &&
    surface.sendText.includes("cd " + shellQuoted(expectedCwd))
  ));
  check("slot " + label + "/" + slot + ": launch command shape is correct", (
    slot === "term"
      ? surface && !surface.sendText.includes("&& exec")
      : surface && surface.sendText.includes("&& exec true")
  ));

  const repeatOn = await ctl.ensureSlot(id, slot, true);
  check("slot " + label + "/" + slot + ": repeated ON is idempotent", (
    repeatOn.already === true &&
    repeatOn.ref === onResult.ref &&
    surfacesFor(id).length === afterOnCount
  ));

  const offResult = await ctl.ensureSlot(id, slot, false);
  const afterOffState = await ctl.getProjectState(id);
  const afterOffCount = surfacesFor(id).length;
  const paneAfterOff = surface && surface.pane ? paneForRef(surface.pane) : null;
  check("slot " + label + "/" + slot + ": OFF decreases surface count", (
    offResult.on === false &&
    afterOffState.slots[slot] === false &&
    !afterOffState.slotRefs[slot] &&
    !afterOffState.slotPaneRefs[slot] &&
    !stateHasSlotMarker(afterOffState, slot) &&
    afterOffCount === afterOnCount - 1
  ));
  check("slot " + label + "/" + slot + ": OFF removes the marked split pane", !paneAfterOff);

  const repeatOff = await ctl.ensureSlot(id, slot, false);
  check("slot " + label + "/" + slot + ": repeated OFF is idempotent", (
    repeatOff.already === true &&
    surfacesFor(id).length === afterOffCount
  ));
}
async function exerciseAllSlots(id, expectedCwd, label) {
  let expectAutoOpen = true;
  for (const slot of ctl.SLOT_ORDER) {
    await exerciseSlotCycle(id, slot, expectedCwd, label, expectAutoOpen);
    expectAutoOpen = false;
  }
}

(async () => {
  try {
    const alphaDir = path.join(phaseDir, "alpha path with spaces and quote" + String.fromCharCode(39) + "s mark");
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({
      _comment: "R4 isolated test config",
      defaults: {
        topCmd: "true",
        bottomCmd: "true",
        yaziCmd: "true",
        termCmd: "",
        agmsg: { enabled: false, brief: false },
        claudeMd: { mode: "off" },
        collab: false,
      },
      projects: [
        { id: "alpha", name: "Alpha", path: alphaDir },
        {
          id: "cc-general",
          kind: "global",
          name: "cc-general",
          path: "~",
          agmsg: { enabled: false },
          slotCommands: { cc: "true", cdx: "true", yazi: "true", term: "" },
        },
      ],
    }, null, 2) + "\n");

    let state = await ctl.getState();
    const global = state.globalRows.find((p) => p.id === "cc-general");
    check("state separates normal projects from global rows", (
      state.projects.length === 1 &&
      state.projects[0].id === "alpha" &&
      Array.isArray(state.globalRows) &&
      state.globalRows.length === 1
    ));
    check("global row exposes kind/agmsg/slot display contract", (
      global &&
      global.kind === "global" &&
      global.agmsg === false &&
      global.path === "~" &&
      ["cc", "cdx", "yazi", "term"].every((slot) => global.slots && typeof global.slots[slot] === "boolean")
    ));

    await exerciseAllSlots("alpha", alphaDir, "normal project");
    await exerciseAllSlots("cc-general", os.homedir(), "global row");

    {
      const raw = rawCmuxState();
      const ws = workspaceFor("alpha");
      const pane = panesFor("alpha")[0] || { ref: "pane:marker", workspace: ws && ws.ref };
      if (!panesFor("alpha").length && ws) raw.panes.push(pane);
      const unmarkedCcRef = "surface:marker-unmarked-cc";
      const unmarkedCdxRef = "surface:marker-unmarked-cdx";
      const markedRef = "surface:marker-cdx";
      raw.surfaces = (raw.surfaces || []).filter((surface) => ![unmarkedCcRef, unmarkedCdxRef, markedRef].includes(surface && surface.ref));
      raw.surfaces.push({ ref: unmarkedCcRef, workspace: ws.ref, pane: pane.ref, title: "Claude Code", type: "terminal", process: "claude", cwd: alphaDir, initial: true });
      raw.surfaces.push({ ref: unmarkedCdxRef, workspace: ws.ref, pane: pane.ref, title: "codex", type: "terminal", process: "codex", cwd: alphaDir, initial: true });
      raw.surfaces.push({ ref: markedRef, workspace: ws.ref, pane: pane.ref, title: "cmuxdash:slot:cdx", type: "terminal", process: "zsh" });
      fs.writeFileSync(stateFile, JSON.stringify(raw) + "\n");
      const markerState = await ctl.getProjectState("alpha");
      const unmarkedCc = markerState.surfaces.find((surface) => surface.ref === unmarkedCcRef);
      const unmarkedCdx = markerState.surfaces.find((surface) => surface.ref === unmarkedCdxRef);
      check("slot detection ignores unmarked default terminal title/process fallback", (
        markerState.slots.cdx === true &&
        markerState.slotRefs.cdx === markedRef &&
        markerState.slots.cc === false &&
        !markerState.slotRefs.cc &&
        unmarkedCc &&
        unmarkedCc.slot === null &&
        unmarkedCdx &&
        unmarkedCdx.slot === null
      ));
      const cleaned = rawCmuxState();
      cleaned.surfaces = (cleaned.surfaces || []).filter((surface) => ![unmarkedCcRef, unmarkedCdxRef, markedRef].includes(surface && surface.ref));
      fs.writeFileSync(stateFile, JSON.stringify(cleaned) + "\n");
    }

    {
      process.env.CMUX_FAKE_OVERWRITE_SLOT_TITLE = "1";
      let onResult;
      let afterOnState;
      let repeatOn;
      let offResult;
      let afterOffState;
      let rawSurface;
      let countAfterOn = 0;
      let countAfterRepeat = 0;
      try {
        onResult = await ctl.ensureSlot("alpha", "cc", true);
        afterOnState = await ctl.getProjectState("alpha");
        rawSurface = surfacesFor("alpha").find((surface) => surface && surface.ref === onResult.ref) || null;
        countAfterOn = surfacesFor("alpha").length;
        repeatOn = await ctl.ensureSlot("alpha", "cc", true);
        countAfterRepeat = surfacesFor("alpha").length;
        offResult = await ctl.ensureSlot("alpha", "cc", false);
        afterOffState = await ctl.getProjectState("alpha");
      } finally {
        delete process.env.CMUX_FAKE_OVERWRITE_SLOT_TITLE;
      }
      check("slot recorded ref: fake cmux overwrites visible title marker", (
        rawSurface &&
        rawSurface.title === "✳ Claude Code" &&
        !String(rawSurface.title || "").includes("cmuxdash:slot:cc")
      ));
      check("slot recorded ref: getProjectState keeps overwritten-title CC ON", (
        onResult &&
        onResult.on === true &&
        afterOnState &&
        afterOnState.slots.cc === true &&
        afterOnState.slotRefs.cc === onResult.ref &&
        afterOnState.slotPaneRefs.cc === onResult.paneRef
      ));
      check("slot recorded ref: repeated ON reuses overwritten-title surface", (
        repeatOn &&
        repeatOn.already === true &&
        repeatOn.ref === onResult.ref &&
        countAfterRepeat === countAfterOn
      ));
      check("slot recorded ref: OFF closes overwritten-title pane and clears refs", (
        offResult &&
        offResult.on === false &&
        afterOffState &&
        afterOffState.slots.cc === false &&
        !afterOffState.slotRefs.cc &&
        !afterOffState.slotPaneRefs.cc &&
        !surfacesFor("alpha").some((surface) => surface && surface.ref === onResult.ref)
      ));
    }

    {
      await ctl.ensureSlot("alpha", "cc", true);
      process.env.CMUX_FAKE_STALE_SLOT_CLOSE = "1";
      let staleOff;
      try {
        staleOff = await ctl.ensureSlot("alpha", "cc", false);
      } finally {
        delete process.env.CMUX_FAKE_STALE_SLOT_CLOSE;
      }
      const staleState = await ctl.getProjectState("alpha");
      check("slot stale close: OFF drains marker-retaining pane fallback", (
        staleOff &&
        staleOff.on === false &&
        staleState.slots.cc === false &&
        !staleState.slotRefs.cc &&
        !staleState.slotPaneRefs.cc &&
        !stateHasSlotMarker(staleState, "cc")
      ));
    }

    let unknownProjectError = false;
    try { await ctl.ensureSlot("missing-project", "cc", true); } catch (err) { unknownProjectError = /unknown project: missing-project/.test(err.message); }
    check("slot errors: unknown project rejects", unknownProjectError);

    let unknownSlotError = false;
    try { await ctl.ensureSlot("alpha", "bogus", true); } catch (err) { unknownSlotError = /unknown slot: bogus/.test(err.message); }
    check("slot errors: unknown slot rejects", unknownSlotError);

    await ctl.reorderProjects(["alpha"]);
    const saved = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    check("reorder keeps global rows outside normal project order", (
      saved.projects.length === 2 &&
      saved.projects[0].id === "alpha" &&
      saved.projects[1].id === "cc-general" &&
      saved.projects[1].kind === "global"
    ));

    await ctl.ensureSlot("cc-general", "cc", true);
    const yaml = await ctl.getWorkspaceYaml();
    check("workspace YAML is parseable and contains global CC slot state", yamlHasGlobalCcOn(yaml));

    {
      const gridRef = await ctl.ensureGridWorkspace();
      const gridWs = workspaceFor("__grid__");
      const dashboardUrl = "http://" + (process.env.CMUX_DASH_HOST || "127.0.0.1") + ":" + (process.env.CMUX_DASH_PORT || "7799");
      const alphaStateBeforeGrid = await ctl.getProjectState("alpha");
      const alphaColumn = await ctl.addProjectColumn("alpha");
      const afterAlphaCount = surfaceCountFor("__grid__");
      const repeatAlpha = await ctl.addProjectColumn("alpha");
      const afterRepeatCount = surfaceCountFor("__grid__");
      const generalColumn = await ctl.addProjectColumn("cc-general");
      const gridState = await ctl.getGridState();
      const alphaCc = rawSurface(alphaColumn.cc.surfaceRef);
      const alphaCdx = rawSurface(alphaColumn.cdx.surfaceRef);
      const generalCc = rawSurface(generalColumn.cc.surfaceRef);
      const generalCdx = rawSurface(generalColumn.cdx.surfaceRef);
      const browserAnchor = surfacesFor("__grid__").find((surface) => (
        surface &&
        surface.type === "browser" &&
        surface.url === dashboardUrl
      ));
      const alphaStateAfterGrid = await ctl.getProjectState("alpha");

      check("grid C1: ensureGridWorkspace uses dedicated tag and stays out of project state", (
        gridRef &&
        gridWs &&
        gridWs.ref === gridRef &&
        gridWs.description === "cmuxdash:__grid__" &&
        alphaStateBeforeGrid.wsRef !== gridRef &&
        alphaStateAfterGrid.wsRef !== gridRef &&
        alphaStateAfterGrid.surfaces.every((surface) => !String(surface.title || "").includes("cmuxdash:grid:"))
      ));
      check("grid C1: addProjectColumn creates ordered scoped cc/cdx columns", (
        gridState.wsRef === gridRef &&
        gridState.columns.length === 2 &&
        gridState.columns.map((column) => column.projectId).join(",") === "alpha,cc-general" &&
        alphaColumn.added === true &&
        generalColumn.added === true &&
        alphaCc &&
        alphaCdx &&
        generalCc &&
        generalCdx &&
        alphaCc.title === alphaColumn.cc.marker &&
        alphaCdx.title === alphaColumn.cdx.marker &&
        generalCc.title === generalColumn.cc.marker &&
        generalCdx.title === generalColumn.cdx.marker &&
        !alphaCc.title.includes("cmuxdash:slot:") &&
        !generalCdx.title.includes("cmuxdash:slot:")
      ));
      check("grid C4: dashboard browser anchor points at the running dashboard URL", (
        browserAnchor &&
        browserAnchor.title === dashboardUrl &&
        browserAnchor.url === dashboardUrl
      ));
      check("grid C1: columns split from explicit surface anchors in order", (
        browserAnchor &&
        alphaCc.splitFrom === browserAnchor.ref &&
        alphaCc.direction === "right" &&
        alphaCdx.splitFrom === alphaCc.ref &&
        alphaCdx.direction === "down" &&
        generalCc.splitFrom === alphaCc.ref &&
        generalCc.direction === "right" &&
        generalCdx.splitFrom === generalCc.ref &&
        generalCdx.direction === "down"
      ));
      check("grid C1: duplicate addProjectColumn is idempotent", (
        repeatAlpha &&
        repeatAlpha.already === true &&
        repeatAlpha.added === false &&
        repeatAlpha.cc.surfaceRef === alphaColumn.cc.surfaceRef &&
        afterRepeatCount === afterAlphaCount
      ));

      const removedAlpha = await ctl.removeProjectColumn("alpha");
      const afterRemove = await ctl.getGridState();
      const afterRemoveCount = surfaceCountFor("__grid__");
      const repeatRemove = await ctl.removeProjectColumn("alpha");
      check("grid C1: removeProjectColumn closes only tracked column surfaces", (
        removedAlpha.removed === true &&
        removedAlpha.closed >= 2 &&
        afterRemove.columns.length === 1 &&
        afterRemove.columns[0].projectId === "cc-general" &&
        !rawSurface(alphaColumn.cc.surfaceRef) &&
        !rawSurface(alphaColumn.cdx.surfaceRef) &&
        !!rawSurface(generalColumn.cc.surfaceRef) &&
        !!rawSurface(generalColumn.cdx.surfaceRef)
      ));
      check("grid C1: repeated removeProjectColumn is idempotent", (
        repeatRemove &&
        repeatRemove.already === true &&
        repeatRemove.removed === false &&
        surfaceCountFor("__grid__") === afterRemoveCount
      ));
      {
        const raw = rawCmuxState();
        raw.surfaces = (raw.surfaces || []).filter((surface) => surface && surface.ref !== generalColumn.cc.surfaceRef);
        fs.writeFileSync(stateFile, JSON.stringify(raw) + "\n");
        const staleGridState = await ctl.getGridState();
        check("grid C4: getGridState drops columns with stale live surface refs", (
          staleGridState.wsRef === gridRef &&
          Array.isArray(staleGridState.columns) &&
          staleGridState.columns.length === 0
        ));
      }
    }
  } catch (err) {
    failed += 1;
    console.log("FAIL\tR4 runner exception: " + (err && err.message ? err.message : err));
  }
  process.exit(failed ? 1 : 0);
})();
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "R4: $label" ;;
      FAIL) fail "R4: $label" ;;
      *) info "R4 output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "R4 runner produced no output"
  fi
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi

  r4_slot_api_and_wait() {
    local id="$1"
    local slot="$2"
    local on_bool="$3"
    local label="$4"
    local body
    local action_id
    local line
    local status=""
    body="$(curl -fsS -X POST --max-time 10 -H 'Content-Type: application/json' --data "{\"on\":${on_bool}}" "$api_url/api/project/$id/slot/$slot" 2>/dev/null || true)"
    action_id="$(printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
if (obj && obj.queued === true && obj.actionId) process.stdout.write(String(obj.actionId));
' 2>/dev/null || true)"
    if [ -z "$action_id" ]; then
      fail "R4 API: $label did not return queued actionId"
      info "R4 API slot payload: ${body:-empty}"
      return 1
    fi
    for _ in $(seq 1 50); do
      line="$(curl -fsS --max-time 5 "$api_url/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
const actionId = Number(process.argv[1]);
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const action = (Array.isArray(obj.actions) ? obj.actions : []).find((a) => Number(a.id) === actionId);
if (action) process.stdout.write(`${action.status}\t${action.error || ""}`);
' "$action_id" 2>/dev/null || true)"
      status="${line%%	*}"
      [ "$status" = "succeeded" ] && break
      [ "$status" = "failed" ] && break
      sleep 0.2
    done
    if [ "$status" != "succeeded" ]; then
      fail "R4 API: $label action status was ${status:-missing}"
      return 1
    fi
    if curl -fsS --max-time 5 "$api_url/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
const id = process.argv[1];
const slot = process.argv[2];
const want = process.argv[3] === "true";
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const rows = [...(Array.isArray(obj.projects) ? obj.projects : []), ...(Array.isArray(obj.globalRows) ? obj.globalRows : [])];
const row = rows.find((p) => p && p.id === id);
process.exit(row && row.slots && row.slots[slot] === want ? 0 : 1);
' "$id" "$slot" "$on_bool" 2>/dev/null; then
      pass "R4 API: $label queued, succeeded, and state matched"
      return 0
    fi
    fail "R4 API: $label state did not match ${on_bool}"
    return 1
  }

  r4_grid_api_and_wait() {
    local id="$1"
    local on_bool="$2"
    local label="$3"
    local body
    local action_id
    local line
    local status=""
    body="$(curl -fsS -X POST --max-time 10 -H 'Content-Type: application/json' --data "{\"on\":${on_bool}}" "$api_url/api/grid/column/$id" 2>/dev/null || true)"
    action_id="$(printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
if (obj && obj.queued === true && obj.actionId && String(obj.label || "").startsWith("grid:")) process.stdout.write(String(obj.actionId));
' 2>/dev/null || true)"
    if [ -z "$action_id" ]; then
      fail "R4 API: $label did not return queued grid actionId"
      info "R4 API grid payload: ${body:-empty}"
      return 1
    fi
    for _ in $(seq 1 50); do
      line="$(curl -fsS --max-time 5 "$api_url/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
const actionId = Number(process.argv[1]);
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const action = (Array.isArray(obj.actions) ? obj.actions : []).find((a) => Number(a.id) === actionId);
if (action) process.stdout.write(`${action.status}\t${action.error || ""}`);
' "$action_id" 2>/dev/null || true)"
      status="${line%%	*}"
      [ "$status" = "succeeded" ] && break
      [ "$status" = "failed" ] && break
      sleep 0.2
    done
    if [ "$status" = "succeeded" ]; then
      pass "R4 API: $label queued and succeeded"
      return 0
    fi
    fail "R4 API: $label action status was ${status:-missing}"
    return 1
  }

  (cd "$DIR" && exec env CMUX_BIN="$fake_cmux" CMUX_DASH_PORT="$api_port" CMUX_DASH_HOST="$HOST" CMUX_DASH_PROJECTS_FILE="$cfg_file" CMUX_DASH_SETTLE_MS=0 "$NODE_BIN" server.js >"$api_log" 2>&1) &
  BAD_SERVER_PID=$!
  for _ in $(seq 1 50); do
    body="$(curl -fsS --max-time 2 "$api_url/api/state" 2>/dev/null || true)"
    [ -n "$body" ] && break
    sleep 0.2
  done
  if printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const alpha = (Array.isArray(obj.projects) ? obj.projects : []).find((p) => p && p.id === "alpha");
const global = (Array.isArray(obj.globalRows) ? obj.globalRows : []).find((p) => p && p.id === "cc-general");
const ok = alpha && global &&
  Array.isArray(obj.actions) &&
  obj.grid && Array.isArray(obj.grid.columns) &&
  obj.health && obj.health.cmux &&
  obj.rowCount === 2 &&
  obj.allOpenCount >= 2;
process.exit(ok ? 0 : 1);
' 2>/dev/null; then
    pass "R4 API: GET /api/state returns projects/globalRows/actions/grid/health contract"
  else
    fail "R4 API: GET /api/state contract failed"
    info "R4 state payload: ${body:-empty}; log=$api_log"
    return 1
  fi

  body="$(curl -fsS --max-time 5 "$api_url/api/grid" 2>/dev/null || true)"
  if printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
process.exit(obj && Object.prototype.hasOwnProperty.call(obj, "wsRef") && Array.isArray(obj.columns) ? 0 : 1);
' 2>/dev/null; then
    pass "R4 API: GET /api/grid returns grid state contract"
  else
    fail "R4 API: GET /api/grid contract failed"
    info "R4 grid payload: ${body:-empty}; log=$api_log"
    return 1
  fi

  if ! r4_slot_api_and_wait "alpha" "cdx" "true" "normal project cdx ON"; then return 1; fi
  if ! r4_slot_api_and_wait "alpha" "cdx" "false" "normal project cdx OFF"; then return 1; fi
  if ! r4_slot_api_and_wait "cc-general" "yazi" "true" "global row yazi ON"; then return 1; fi
  if ! r4_slot_api_and_wait "cc-general" "yazi" "false" "global row yazi OFF"; then return 1; fi

  if ! r4_grid_api_and_wait "alpha" "true" "grid alpha ON"; then return 1; fi
  if curl -fsS --max-time 5 "$api_url/api/grid" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const col = (Array.isArray(obj.columns) ? obj.columns : []).find((c) => c && c.projectId === "alpha");
process.exit(col && col.cc && col.cc.surfaceRef && col.cdx && col.cdx.surfaceRef ? 0 : 1);
' 2>/dev/null && curl -fsS --max-time 5 "$api_url/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const grid = obj && obj.grid;
const col = grid && (Array.isArray(grid.columns) ? grid.columns : []).find((c) => c && c.projectId === "alpha");
const project = (Array.isArray(obj.projects) ? obj.projects : []).find((p) => p && p.id === "alpha");
const action = project && project.action;
process.exit(col && col.cc && col.cc.surfaceRef && col.cdx && col.cdx.surfaceRef && action && action.type === "grid" && action.target === "alpha" ? 0 : 1);
' 2>/dev/null; then
    pass "R4 API: grid ON is reflected by /api/grid and /api/state.grid with project action target"
  else
    fail "R4 API: grid ON did not reflect in /api/grid or /api/state.grid"
    return 1
  fi
  if ! r4_grid_api_and_wait "alpha" "false" "grid alpha OFF"; then return 1; fi
  if curl -fsS --max-time 5 "$api_url/api/grid" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
process.exit(obj && Array.isArray(obj.columns) && obj.columns.length === 0 && !obj.wsRef ? 0 : 1);
' 2>/dev/null; then
    pass "R4 API: grid OFF removes column and cleans empty grid workspace"
  else
    fail "R4 API: grid OFF did not return empty grid state"
    return 1
  fi

  local agmsg_status
  local agmsg_body
  agmsg_body="$(curl -sS -o "$phase_dir/agmsg-api.json" -w '%{http_code}' --max-time 5 "$api_url/api/agmsg/alpha" 2>/dev/null || true)"
  agmsg_status="$agmsg_body"
  if [ "$agmsg_status" = "200" ] && "$NODE_BIN" - "$phase_dir/agmsg-api.json" <<'NODE' 2>/dev/null
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch (_) { process.exit(2); }
process.exit(obj && obj.team === "alpha" && Array.isArray(obj.messages) && typeof obj.lastId === "number" ? 0 : 1);
NODE
  then
    pass "R4 API: /api/agmsg/:id returns JSON without 5xx when DB is empty or unavailable"
  else
    fail "R4 API: /api/agmsg/:id DB edge contract failed with HTTP ${agmsg_status:-empty}"
    return 1
  fi

  body="$(curl -fsS --max-time 2 -D "$header_file" "$api_url/api/workspace-yaml" 2>/dev/null || true)"
  kill "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  wait "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  BAD_SERVER_PID=""

  if printf '%s' "$body" | ruby -e 'require "yaml"; obj = YAML.safe_load(STDIN.read, aliases: false); rows = obj["rows"] || []; exit(rows.any? { |r| r["id"] == "cc-general" && r["kind"] == "global" } ? 0 : 1)' 2>/dev/null \
    && grep -Eiq '^content-type: text/yaml' "$header_file" 2>/dev/null; then
    pass "R4: GET /api/workspace-yaml returns text/yaml with valid global-row YAML"
  else
    fail "R4: GET /api/workspace-yaml contract failed"
    info "R4 workspace-yaml payload: ${body:-empty}; log=$api_log"
    return 1
  fi

  if "$NODE_BIN" - "$DIR/public/index.html" <<'NODE' 2>/dev/null
const fs = require("fs");
const html = fs.readFileSync(process.argv[2], "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) process.exit(2);
const script = scriptMatch[1];
const checks = [
  html.includes('id="workspaceYamlOpen"'),
  html.includes('id="workspaceYamlModal"'),
  html.includes('id="workspaceYamlBody"'),
  html.includes('id="gridPanel"'),
  html.includes(".grid-side"),
  html.includes('id="globalRowsSeparator"'),
  script.includes("fetch('/api/workspace-yaml'"),
  script.includes("body.textContent"),
  script.includes("function renderProjectRows(s)"),
  script.includes("function renderGridSidePanel(s)"),
  script.includes("function toggleGridColumn(id, on)"),
  script.includes("/api/grid/column/"),
  script.includes("data-grid-project-id"),
  script.includes("data-grid-column-project"),
  script.includes("renderGridSidePanel(s)"),
  script.includes("globalRows"),
  script.includes("data-row-kind"),
  !script.includes("window.open('/api/workspace-yaml"),
];
process.exit(checks.every(Boolean) ? 0 : 1);
NODE
  then
    pass "R4: UI global rows, workspace YAML, and grid side-panel static contract are present"
  else
    fail "R4: UI global rows/workspace YAML/grid side-panel static contract failed"
    return 1
  fi
}

if ! run_r4_checks; then
  finish
fi

run_r5_collab_checks() {
  local phase_dir="$TEST_TMP_DIR/r5-collab"
  local results
  local rc
  local saw_output=0
  mkdir -p "$phase_dir"

  results="$(
    "$NODE_BIN" - "$DIR" "$phase_dir" "$HOST" "$PORT" <<'NODE'
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const repo = process.argv[2];
const phaseDir = process.argv[3];
const host = process.argv[4];
const basePort = Number(process.argv[5]) + 3900;
const nodeBin = process.execPath;

let failed = 0;
const children = [];
function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function writeExecutable(file, body) { fs.writeFileSync(file, body, { mode: 0o755 }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function readLog(file) {
  try { return fs.readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (_) { return []; }
}
function request(port, requestPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? JSON.stringify(opts.body) : "";
    const req = http.request({
      host,
      port,
      path: requestPath,
      method: opts.method || "GET",
      timeout: 1800,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : undefined,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, body: text, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
async function waitForHttp(port, requestPath, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, requestPath);
      if (res.status >= 200 && res.status < 500) return true;
    } catch (_) {}
    await sleep(100);
  }
  return false;
}
async function findFreePort(start) {
  for (let port = start; port < start + 120; port += 1) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("no free port near " + start);
}
async function waitForAction(port, actionId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(port, "/api/state").catch(() => null);
    const actions = res && res.json && Array.isArray(res.json.actions) ? res.json.actions : [];
    const action = actions.find((a) => Number(a.id) === Number(actionId));
    if (action && (action.status === "succeeded" || action.status === "failed")) return action;
    await sleep(120);
  }
  return null;
}
function fakeScriptHeader() { return "#!/usr/bin/env node\n"; }
function writeFakeCmux(file, stateFile) {
  writeExecutable(file, fakeScriptHeader() + `
const fs = require("fs");
const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
const cmd = args.shift() || "";
function readState(){ try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (_) { return { workspaces: [], panes: [], surfaces: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }; } }
function writeState(s){ fs.writeFileSync(stateFile, JSON.stringify(s) + "\\n"); }
function argValue(name){ const i = args.indexOf(name); return i >= 0 ? args[i + 1] || "" : ""; }
if (cmd === "ping") { console.log("pong"); process.exit(0); }
if (cmd === "list-workspaces") { const s = readState(); console.log(JSON.stringify({ workspaces: s.workspaces || [] })); process.exit(0); }
if (cmd === "new-workspace") {
  const s = readState();
  const ref = "workspace:" + (s.nextWorkspace || 1);
  const paneRef = "pane:" + (s.nextPane || 1);
  const surfaceRef = "surface:" + (s.nextSurface || 1);
  s.nextWorkspace = (s.nextWorkspace || 1) + 1;
  s.nextPane = (s.nextPane || 1) + 1;
  s.nextSurface = (s.nextSurface || 1) + 1;
  s.workspaces = Array.isArray(s.workspaces) ? s.workspaces : [];
  s.panes = Array.isArray(s.panes) ? s.panes : [];
  s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
  s.workspaces.push({ ref, description: argValue("--description"), name: argValue("--name"), cwd: argValue("--cwd"), selected: false });
  s.panes.push({ ref: paneRef, workspace: ref, index: 0 });
  s.surfaces.push({ ref: surfaceRef, workspace: ref, pane: paneRef, title: "terminal", type: "terminal", process: "zsh", sendText: "", initial: true });
  writeState(s);
  console.log(ref);
  process.exit(0);
}
if (cmd === "close-workspace") {
  const ws = argValue("--workspace");
  const s = readState();
  s.workspaces = (s.workspaces || []).filter((w) => w && w.ref !== ws);
  s.panes = (s.panes || []).filter((p) => p && p.workspace !== ws);
  s.surfaces = (s.surfaces || []).filter((surface) => surface && surface.workspace !== ws);
  writeState(s);
  console.log("{}");
  process.exit(0);
}
if (cmd === "select-workspace" || cmd === "reorder-workspaces") { console.log("{}"); process.exit(0); }
if (cmd === "list-panes") {
  const s = readState();
  const workspace = argValue("--workspace");
  const panes = (s.panes || []).filter((p) => !workspace || p.workspace === workspace);
  console.log(JSON.stringify({ panes }));
  process.exit(0);
}
if (cmd === "list-pane-surfaces") {
  const s = readState();
  const workspace = argValue("--workspace");
  const pane = argValue("--pane");
  const surfaces = (s.surfaces || [])
    .filter((surface) => (!workspace || surface.workspace === workspace) && (!pane || surface.pane === pane))
    .map((surface) => ({ ref: surface.ref, title: surface.title, type: surface.type, paneRef: surface.pane, cwd: surface.cwd || null }));
  console.log(JSON.stringify({ surfaces }));
  process.exit(0);
}
if (cmd === "new-pane") {
  const s = readState();
  const workspace = argValue("--workspace");
  const direction = argValue("--direction");
  const type = argValue("--type") || "terminal";
  s.panes = Array.isArray(s.panes) ? s.panes : [];
  s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
  const paneRef = "pane:" + (s.nextPane || 1);
  const ref = "surface:" + (s.nextSurface || 1);
  s.nextPane = (s.nextPane || 1) + 1;
  s.nextSurface = (s.nextSurface || 1) + 1;
  s.panes.push({ ref: paneRef, workspace, index: s.panes.filter((item) => item && item.workspace === workspace).length, direction });
  s.surfaces.push({ ref, workspace, pane: paneRef, title: "terminal", type, process: "zsh", sendText: "" });
  writeState(s);
  console.log(ref);
  process.exit(0);
}
if (cmd === "new-surface") {
  const s = readState();
  const workspace = argValue("--workspace");
  let pane = argValue("--pane");
  s.panes = Array.isArray(s.panes) ? s.panes : [];
  s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
  if (!pane) pane = ((s.panes || []).find((item) => item && (!workspace || item.workspace === workspace)) || {}).ref || "pane:1";
  const ref = "surface:" + (s.nextSurface || 1);
  s.nextSurface = (s.nextSurface || 1) + 1;
  s.surfaces.push({ ref, workspace, pane, title: "terminal", type: "terminal", process: "zsh", sendText: "" });
  writeState(s);
  console.log(ref);
  process.exit(0);
}
if (cmd === "send") {
  const s = readState();
  const surface = argValue("--surface");
  const workspace = argValue("--workspace");
  const text = args.filter((arg, idx) => !["--surface", "--workspace"].includes(args[idx - 1]) && !["--surface", "--workspace"].includes(arg)).join(" ");
  const match = text.match(/cmuxdash:slot:(cc|cdx|yazi|term)/);
  const slot = match && match[1];
  const processBySlot = { cc: "claude", cdx: "codex", yazi: "yazi", term: "zsh" };
  for (const item of (s.surfaces || [])) {
    if (item && item.ref === surface) {
      item.sendText = text;
      item.workspace = item.workspace || workspace;
      if (slot) {
        item.title = "cmuxdash:slot:" + slot;
        item.process = processBySlot[slot] || "zsh";
      }
    }
  }
  writeState(s);
  process.exit(0);
}
if (cmd === "close-surface") {
  const s = readState();
  const workspace = argValue("--workspace");
  const surface = argValue("--surface");
  if (surface.startsWith("pane:")) {
    if ((s.surfaces || []).some((item) => item && item.pane === surface && item.initial && (!workspace || item.workspace === workspace))) {
      writeState(s);
      process.exit(0);
    }
    s.panes = (s.panes || []).filter((pane) => !(pane && pane.ref === surface && (!workspace || pane.workspace === workspace)));
    s.surfaces = (s.surfaces || []).filter((item) => !(item && item.pane === surface && (!workspace || item.workspace === workspace)));
    writeState(s);
    process.exit(0);
  }
  if ((s.surfaces || []).some((item) => item && item.ref === surface && item.initial && (!workspace || item.workspace === workspace))) {
    writeState(s);
    process.exit(0);
  }
  const removed = (s.surfaces || []).filter((item) => item && item.ref === surface && (!workspace || item.workspace === workspace));
  s.surfaces = (s.surfaces || []).filter((item) => !(item && item.ref === surface && (!workspace || item.workspace === workspace)));
  const removedPanes = new Set(removed.map((item) => item && item.pane).filter(Boolean));
  s.panes = (s.panes || []).filter((pane) => {
    if (!pane || !removedPanes.has(pane.ref)) return true;
    return s.surfaces.some((item) => item && item.pane === pane.ref);
  });
  writeState(s);
  process.exit(0);
}
if (cmd === "top") {
  const s = readState();
  let idx = 1;
  for (const surface of (s.surfaces || [])) {
    process.stdout.write("0\\t0\\t1\\tprocess\\tprocess:" + (idx++) + "\\t" + surface.ref + "\\t" + (surface.process || "zsh") + "\\n");
  }
  process.exit(0);
}
if (cmd === "memory") { console.log("Footprint: 64 MiB\\nChild RSS total: 16 MiB"); process.exit(0); }
console.log("{}");
`);
}
function writeCollabFakes(base) {
  const stateFile = path.join(base, "collab-state.json");
  const logFile = path.join(base, "collab-log.jsonl");
  const init = path.join(base, "collab.sh");
  const bridge = path.join(base, "agmsg-codex-bridge.sh");
  const pgrep = path.join(base, "pgrep");
  const nohup = path.join(base, "nohup");
  const kill = path.join(base, "kill");
  fs.writeFileSync(stateFile, JSON.stringify({ running: {} }) + "\n");
  fs.writeFileSync(logFile, "");
  const common = `
const fs = require("fs");
const path = require("path");
const stateFile = ${JSON.stringify(stateFile)};
const logFile = ${JSON.stringify(logFile)};
const bridge = ${JSON.stringify(bridge)};
function readState(){ try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (_) { return { running: {} }; } }
function writeState(s){ fs.writeFileSync(stateFile, JSON.stringify(s) + "\\n"); }
function log(event, args){ fs.appendFileSync(logFile, JSON.stringify({ event, args }) + "\\n"); }
`;
  writeExecutable(init, fakeScriptHeader() + common + `
const args = process.argv.slice(2);
log("init", args);
if (args[0] === "init") args.shift();
let project = "";
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--team") { i += 1; continue; }
  if (arg.startsWith("--")) continue;
  project = arg;
  break;
}
if (!project) process.exit(2);
const stateDir = path.join(project, ".claude-codex-collab");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "config.env"), "COLLAB_PROJECT_DIR='" + project.replace(/'/g, "'\\\\''") + "'\\n");
`);
  writeExecutable(bridge, fakeScriptHeader() + common + `
const args = process.argv.slice(2);
log("bridge", args);
if (args[0] === "stop" && args[1]) {
  const s = readState();
  s.running = s.running || {};
  s.running[args[1]] = false;
  writeState(s);
  console.log("bridge stopped");
}
`);
  writeExecutable(pgrep, fakeScriptHeader() + common + `
log("pgrep", process.argv.slice(2));
const s = readState();
for (const [project, running] of Object.entries(s.running || {})) {
  if (running) console.log("4242 " + bridge + " run " + project);
}
process.exit(0);
`);
  writeExecutable(nohup, fakeScriptHeader() + common + `
const args = process.argv.slice(2);
log("nohup", args);
const project = args[2] || "";
const s = readState();
s.running = s.running || {};
if (project) s.running[project] = true;
writeState(s);
`);
  writeExecutable(kill, fakeScriptHeader() + common + `
log("kill", process.argv.slice(2));
const s = readState();
for (const key of Object.keys(s.running || {})) s.running[key] = false;
writeState(s);
`);
  return { stateFile, logFile, init, bridge, pgrep, nohup, kill };
}
function collabEnv(fakes) {
  return {
    CMUX_DASH_COLLAB_INIT: fakes.init,
    CMUX_DASH_COLLAB_BRIDGE: fakes.bridge,
    CMUX_DASH_COLLAB_PGREP: fakes.pgrep,
    CMUX_DASH_COLLAB_NOHUP: fakes.nohup,
    CMUX_DASH_COLLAB_KILL: fakes.kill,
    CMUX_DASH_COLLAB_START_DELAY_MS: "80",
    CMUX_DASH_COLLAB_STOP_DELAY_MS: "20",
  };
}
function runningFor(fakes, projectDir) {
  const s = readJson(fakes.stateFile, { running: {} });
  return !!(s.running && s.running[projectDir]);
}
function countLog(fakes, event) {
  return readLog(fakes.logFile).filter((item) => item.event === event).length;
}

(async () => {
  try {
    const cmuxState = path.join(phaseDir, "cmux-state.json");
    const fakeCmux = path.join(phaseDir, "cmux");
    const cfgFile = path.join(phaseDir, "projects.json");
    const projectDir = path.resolve(path.join(phaseDir, "alpha path"));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(cmuxState, JSON.stringify({ workspaces: [], panes: [], surfaces: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }) + "\n");
    writeFakeCmux(fakeCmux, cmuxState);
    const fakes = writeCollabFakes(phaseDir);
    Object.assign(process.env, {
      CMUX_BIN: fakeCmux,
      CMUX_DASH_PROJECTS_FILE: cfgFile,
      CMUX_DASH_SETTLE_MS: "0",
      CMUX_DASH_READ_TIMEOUT: "500",
      CMUX_DASH_READ_RETRY_BUDGET_MS: "500",
      CMUX_DASH_READ_RETRIES: "0",
      ...collabEnv(fakes),
    });
    const ctl = require(path.join(repo, "cmuxctl.js"));

    const first = await ctl.ensureCollab(projectDir, true, { team: "alpha-team" });
    const realProjectDir = first.projectDir;
    const firstLog = readLog(fakes.logFile);
    check("R5 ensureCollab creates config with collab.sh init --no-start", (
      fs.existsSync(path.join(realProjectDir, ".claude-codex-collab", "config.env")) &&
      first.config && first.config.action === "initialized" &&
      firstLog.some((item) => item.event === "init" && item.args[0] === "init" && item.args.includes("--no-start") && item.args.includes("--team") && item.args.includes("alpha-team"))
    ));
    check("R5 ensureCollab setup-only does not invoke nohup bridge run", (
      first.setupOnly === true &&
      first.running === false &&
      !runningFor(fakes, realProjectDir) &&
      countLog(fakes, "nohup") === 0
    ));

    fs.writeFileSync(fakes.stateFile, JSON.stringify({ running: { [realProjectDir]: true } }) + "\n");
    const repeat = await ctl.ensureCollab(projectDir, true, { team: "alpha-team" });
    check("R5 ensureCollab enable stops residual headless bridge defensively", (
      repeat.setupOnly === true &&
      repeat.bridge &&
      repeat.bridge.running === false &&
      !runningFor(fakes, realProjectDir) &&
      readLog(fakes.logFile).some((item) => item.event === "bridge" && item.args[0] === "stop" && item.args[1] === realProjectDir) &&
      countLog(fakes, "nohup") === 0
    ));

    fs.writeFileSync(fakes.stateFile, JSON.stringify({ running: { [realProjectDir]: true } }) + "\n");
    const off = await ctl.ensureCollab(projectDir, false);
    check("R5 ensureCollab off stops residual bridge without starting headless", (
      off.running === false &&
      !runningFor(fakes, realProjectDir) &&
      readLog(fakes.logFile).some((item) => item.event === "bridge" && item.args[0] === "stop" && item.args[1] === realProjectDir) &&
      countLog(fakes, "nohup") === 0
    ));

    fs.writeFileSync(cfgFile, JSON.stringify({
      _comment: "R5 default-on isolated test config",
      defaults: { agmsg: { enabled: false }, claudeMd: { mode: "off" } },
      projects: [{ id: "alpha", name: "Alpha", path: projectDir }],
    }, null, 2) + "\n");
    fs.writeFileSync(cmuxState, JSON.stringify({ workspaces: [], panes: [], surfaces: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }) + "\n");
    fs.writeFileSync(fakes.stateFile, JSON.stringify({ running: {} }) + "\n");
    fs.writeFileSync(fakes.logFile, "");
    const defaultOnCfg = ctl.loadConfig();
    const defaultOnState = await ctl.getState();
    const defaultOnRow = defaultOnState.projects.find((p) => p.id === "alpha");
    check("R5 collab defaults to on when defaults.collab is omitted", (
      defaultOnCfg.defaults.collab === true &&
      ctl.projectCollabEnabled(defaultOnCfg.projects[0], defaultOnCfg) === true &&
      defaultOnRow &&
      defaultOnRow.collab &&
      defaultOnRow.collab.enabled === true &&
      defaultOnRow.collab.active === false &&
      defaultOnRow.collab.running === false &&
      countLog(fakes, "init") === 0 &&
      countLog(fakes, "nohup") === 0
    ));

    fs.writeFileSync(cfgFile, JSON.stringify({
      _comment: "R5 isolated test config",
      defaults: { agmsg: { enabled: false }, claudeMd: { mode: "off" }, collab: true },
      projects: [{ id: "alpha", name: "Alpha", path: projectDir }],
    }, null, 2) + "\n");
    fs.writeFileSync(cmuxState, JSON.stringify({ workspaces: [], panes: [], surfaces: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }) + "\n");
    fs.writeFileSync(fakes.stateFile, JSON.stringify({ running: {} }) + "\n");
    fs.writeFileSync(fakes.logFile, "");

    const opened = await ctl.openProject("alpha", { focus: false });
    let st = await ctl.getState();
    const rowAfterOpen = st.projects.find((p) => p.id === "alpha");
    const ccRefAfterOpen = rowAfterOpen && rowAfterOpen.slotRefs && rowAfterOpen.slotRefs.cc;
    const cdxRefAfterOpen = rowAfterOpen && rowAfterOpen.slotRefs && rowAfterOpen.slotRefs.cdx;
    const ccPaneAfterOpen = rowAfterOpen && rowAfterOpen.slotPaneRefs && rowAfterOpen.slotPaneRefs.cc;
    const cdxPaneAfterOpen = rowAfterOpen && rowAfterOpen.slotPaneRefs && rowAfterOpen.slotPaneRefs.cdx;
    check("R5 openProject collab ON creates cc/cdx slots and setup-only collab", (
      opened.collab && opened.collab.on === true &&
      opened.collab.setupOnly === true &&
      Array.isArray(opened.slots) && opened.slots.length === 2 &&
      rowAfterOpen && rowAfterOpen.open === true &&
      rowAfterOpen.slots && rowAfterOpen.slots.cc === true &&
      rowAfterOpen.slots && rowAfterOpen.slots.cdx === true &&
      ccRefAfterOpen && cdxRefAfterOpen && ccRefAfterOpen !== cdxRefAfterOpen &&
      ccPaneAfterOpen && cdxPaneAfterOpen && ccPaneAfterOpen !== cdxPaneAfterOpen &&
      rowAfterOpen.collab && rowAfterOpen.collab.enabled === true &&
      rowAfterOpen.collab.active === true &&
      rowAfterOpen.collab.running === true &&
      countLog(fakes, "init") >= 1 &&
      countLog(fakes, "nohup") === 0
    ));

    {
      const raw = readJson(cmuxState, {});
      const ccSurface = (raw.surfaces || []).find((surface) => surface && surface.ref === ccRefAfterOpen);
      const cdxSurface = (raw.surfaces || []).find((surface) => surface && surface.ref === cdxRefAfterOpen);
      if (ccSurface) ccSurface.title = "✳ Claude Code";
      if (cdxSurface) cdxSurface.title = "Codex";
      fs.writeFileSync(cmuxState, JSON.stringify(raw) + "\n");
      st = await ctl.getState();
      const rowAfterTitleOverwrite = st.projects.find((p) => p.id === "alpha");
      check("R5 collab active survives overwritten CC/Cdx titles via recorded refs", (
        ccSurface &&
        cdxSurface &&
        ccSurface.title === "✳ Claude Code" &&
        !String(ccSurface.title || "").includes("cmuxdash:slot:cc") &&
        !String(cdxSurface.title || "").includes("cmuxdash:slot:cdx") &&
        rowAfterTitleOverwrite &&
        rowAfterTitleOverwrite.slots.cc === true &&
        rowAfterTitleOverwrite.slots.cdx === true &&
        rowAfterTitleOverwrite.slotRefs.cc === ccRefAfterOpen &&
        rowAfterTitleOverwrite.slotRefs.cdx === cdxRefAfterOpen &&
        rowAfterTitleOverwrite.collab.active === true
      ));
    }

    await ctl.openProject("alpha", { focus: false });
    st = await ctl.getState();
    const rowAfterRepeatOpen = st.projects.find((p) => p.id === "alpha");
    check("R5 openProject already-open keeps cc/cdx slots idempotent without headless start", (
      rowAfterRepeatOpen &&
      rowAfterRepeatOpen.slots.cc === true &&
      rowAfterRepeatOpen.slots.cdx === true &&
      rowAfterRepeatOpen.slotRefs.cc === ccRefAfterOpen &&
      rowAfterRepeatOpen.slotRefs.cdx === cdxRefAfterOpen &&
      rowAfterRepeatOpen.slotPaneRefs.cc === ccPaneAfterOpen &&
      rowAfterRepeatOpen.slotPaneRefs.cdx === cdxPaneAfterOpen &&
      countLog(fakes, "nohup") === 0
    ));

    const pairOff = await ctl.ensureCollabPair("alpha", false);
    st = await ctl.getState();
    const rowAfterPairOff = st.projects.find((p) => p.id === "alpha");
    check("R5 CC pair OFF closes both cc/cdx panes while keeping collab enabled pending", (
      pairOff.on === false &&
      rowAfterPairOff &&
      rowAfterPairOff.open === true &&
      rowAfterPairOff.slots.cc === false &&
      rowAfterPairOff.slots.cdx === false &&
      rowAfterPairOff.collab.enabled === true &&
      rowAfterPairOff.collab.active === false
    ));

    const pairOn = await ctl.ensureCollabPair("alpha", true);
    st = await ctl.getState();
    const rowAfterPairOn = st.projects.find((p) => p.id === "alpha");
    check("R5 CC pair ON recreates distinct marked cc/cdx panes and reactivates collab", (
      pairOn.on === true &&
      rowAfterPairOn &&
      rowAfterPairOn.slots.cc === true &&
      rowAfterPairOn.slots.cdx === true &&
      rowAfterPairOn.slotRefs.cc &&
      rowAfterPairOn.slotRefs.cdx &&
      rowAfterPairOn.slotRefs.cc !== rowAfterPairOn.slotRefs.cdx &&
      rowAfterPairOn.slotPaneRefs.cc !== rowAfterPairOn.slotPaneRefs.cdx &&
      rowAfterPairOn.collab.active === true
    ));

    const closed = await ctl.closeProject("alpha");
    st = await ctl.getState();
    const rowAfterClose = st.projects.find((p) => p.id === "alpha");
    check("R5 closeProject stops pane delivery and residual bridge only", (
      closed.collab && closed.collab.running === false &&
      rowAfterClose && rowAfterClose.open === false &&
      rowAfterClose.collab &&
      rowAfterClose.collab.enabled === true &&
      rowAfterClose.collab.active === false &&
      rowAfterClose.collab.running === false &&
      countLog(fakes, "nohup") === 0
    ));

    fs.writeFileSync(cmuxState, JSON.stringify({ workspaces: [], panes: [], surfaces: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }) + "\n");
    fs.writeFileSync(fakes.stateFile, JSON.stringify({ running: {} }) + "\n");
    fs.writeFileSync(fakes.logFile, "");
    fs.writeFileSync(cfgFile, JSON.stringify({
      _comment: "R5 collab false override isolated test config",
      defaults: { agmsg: { enabled: false }, claudeMd: { mode: "off" }, collab: true },
      projects: [{ id: "alpha", name: "Alpha", path: projectDir, collab: false }],
    }, null, 2) + "\n");
    const openedOff = await ctl.openProject("alpha", { focus: false });
    st = await ctl.getState();
    const rowAfterOpenOff = st.projects.find((p) => p.id === "alpha");
    check("R5 openProject does not start collab when project collab=false", (
      openedOff.collab &&
      openedOff.collab.on === false &&
      openedOff.collab.skipped === true &&
      rowAfterOpenOff &&
      rowAfterOpenOff.open === true &&
      rowAfterOpenOff.collab &&
      rowAfterOpenOff.collab.enabled === false &&
      rowAfterOpenOff.collab.active === false &&
      rowAfterOpenOff.collab.running === false &&
      rowAfterOpenOff.slots && rowAfterOpenOff.slots.cc === false &&
      rowAfterOpenOff.slots && rowAfterOpenOff.slots.cdx === false &&
      countLog(fakes, "init") === 0 &&
      countLog(fakes, "nohup") === 0
    ));

    fs.writeFileSync(cmuxState, JSON.stringify({ workspaces: [], panes: [], surfaces: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }) + "\n");
    fs.writeFileSync(fakes.stateFile, JSON.stringify({ running: {} }) + "\n");
    fs.writeFileSync(fakes.logFile, "");
    fs.writeFileSync(cfgFile, JSON.stringify({
      _comment: "R5 API isolated test config",
      defaults: { agmsg: { enabled: false }, claudeMd: { mode: "off" }, collab: false },
      projects: [{ id: "alpha", name: "Alpha", path: projectDir }],
    }, null, 2) + "\n");

    const port = await findFreePort(basePort);
    const serverLog = path.join(phaseDir, "server.log");
    const out = fs.openSync(serverLog, "w");
    const child = spawn(nodeBin, ["server.js"], {
      cwd: repo,
      env: {
        ...process.env,
        CMUX_BIN: fakeCmux,
        CMUX_DASH_PROJECTS_FILE: cfgFile,
        CMUX_DASH_PORT: String(port),
        CMUX_DASH_HOST: host,
        CMUX_DASH_SETTLE_MS: "0",
        CMUX_DASH_READ_TIMEOUT: "500",
        CMUX_DASH_READ_RETRY_BUDGET_MS: "500",
        CMUX_DASH_READ_RETRIES: "0",
        ...collabEnv(fakes),
      },
      stdio: ["ignore", out, out],
    });
    child.once("exit", () => fs.closeSync(out));
    children.push(child);
    if (!await waitForHttp(port, "/api/state")) throw new Error("R5 API server did not start");

    const stateBefore = await request(port, "/api/state");
    const rowBefore = stateBefore.json && stateBefore.json.projects && stateBefore.json.projects.find((p) => p.id === "alpha");
    check("R5 /api/state exposes collab.active field without bridge fanout", (
      rowBefore &&
      rowBefore.collab &&
      rowBefore.collab.enabled === false &&
      rowBefore.collab.active === false &&
      rowBefore.collab.running === false &&
      countLog(fakes, "init") === 0 &&
      countLog(fakes, "nohup") === 0
    ));

    const onResp = await request(port, "/api/project/alpha/collab", { method: "POST", body: { on: true } });
    const onAction = onResp.json && onResp.json.actionId ? await waitForAction(port, onResp.json.actionId) : null;
    const stateOn = await request(port, "/api/state");
    const rowOn = stateOn.json.projects.find((p) => p.id === "alpha");
    check("R5 API collab ON queues, succeeds, persists action target, and remains inactive until Cdx slot exists", (
      onResp.json && onResp.json.queued === true &&
      onAction && onAction.status === "succeeded" &&
      rowOn.action && rowOn.action.label === "collab:alpha:on" &&
      rowOn.collab && rowOn.collab.enabled === true &&
      rowOn.collab.active === false &&
      rowOn.collab.running === false &&
      countLog(fakes, "init") >= 1 &&
      countLog(fakes, "nohup") === 0
    ));

    const ccPairOnResp = await request(port, "/api/project/alpha/slot/cc", { method: "POST", body: { on: true } });
    const ccPairOnAction = ccPairOnResp.json && ccPairOnResp.json.actionId ? await waitForAction(port, ccPairOnResp.json.actionId) : null;
    const statePairOn = await request(port, "/api/state");
    const rowPairOn = statePairOn.json.projects.find((p) => p.id === "alpha");
    const pairOnOk = (
      ccPairOnResp.json && ccPairOnResp.json.queued === true &&
      ccPairOnAction && ccPairOnAction.status === "succeeded" &&
      rowPairOn.action && rowPairOn.action.label === "slot:alpha:cc:on" &&
      rowPairOn.open === true &&
      rowPairOn.slots.cc === true &&
      rowPairOn.slots.cdx === true &&
      rowPairOn.slotRefs.cc &&
      rowPairOn.slotRefs.cdx &&
      rowPairOn.slotRefs.cc !== rowPairOn.slotRefs.cdx &&
      rowPairOn.slotPaneRefs.cc !== rowPairOn.slotPaneRefs.cdx &&
      rowPairOn.collab.active === true
    );
    if (!pairOnOk) {
      console.log("INFO\tR5 API CC pair ON diagnostic " + JSON.stringify({ resp: ccPairOnResp.json, action: ccPairOnAction, row: rowPairOn }));
    }
    check("R5 API CC button collab ON creates visible cc/cdx pair and activates", pairOnOk);

    const ccPairOffResp = await request(port, "/api/project/alpha/slot/cc", { method: "POST", body: { on: false } });
    const ccPairOffAction = ccPairOffResp.json && ccPairOffResp.json.actionId ? await waitForAction(port, ccPairOffResp.json.actionId) : null;
    const statePairOff = await request(port, "/api/state");
    const rowPairOff = statePairOff.json.projects.find((p) => p.id === "alpha");
    check("R5 API CC button OFF removes both pair panes and leaves collab pending", (
      ccPairOffResp.json && ccPairOffResp.json.queued === true &&
      ccPairOffAction && ccPairOffAction.status === "succeeded" &&
      rowPairOff.action && rowPairOff.action.label === "slot:alpha:cc:off" &&
      rowPairOff.open === true &&
      rowPairOff.slots.cc === false &&
      rowPairOff.slots.cdx === false &&
      rowPairOff.collab.enabled === true &&
      rowPairOff.collab.active === false
    ));

    const offResp = await request(port, "/api/project/alpha/collab", { method: "POST", body: { on: false } });
    const offAction = offResp.json && offResp.json.actionId ? await waitForAction(port, offResp.json.actionId) : null;
    const stateOff = await request(port, "/api/state");
    const rowOff = stateOff.json.projects.find((p) => p.id === "alpha");
    const saved = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    check("R5 API collab OFF queues, succeeds, persists project.collab=false, and stops", (
      offResp.json && offResp.json.queued === true &&
      offAction && offAction.status === "succeeded" &&
      rowOff.action && rowOff.action.label === "collab:alpha:off" &&
      rowOff.collab && rowOff.collab.enabled === false &&
      rowOff.collab.active === false &&
      rowOff.collab.running === false &&
      saved.projects[0].collab === false
    ));

    const html = fs.readFileSync(path.join(repo, "public", "index.html"), "utf8");
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    const script = scriptMatch ? scriptMatch[1] : "";
    check("R5 UI exposes collab indicator and toggle contract", (
      html.includes("collab-btn") &&
      html.includes("協業ON") &&
      script.includes("function toggleCollab(id, on)") &&
      script.includes("/api/project/${encodeURIComponent(id)}/collab") &&
      script.includes("p.collab") &&
      script.includes("active") &&
      script.includes("data-action=\"collab\"")
    ));

    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  } catch (err) {
    failed += 1;
    console.log("FAIL\tR5 runner exception: " + (err && err.message ? err.message : err));
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
  process.exit(failed ? 1 : 0);
})();
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "$label" ;;
      FAIL) fail "$label" ;;
      *) info "R5 output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "R5 runner produced no output"
  fi
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi
}

if ! run_r5_collab_checks; then
  finish
fi

run_r6_collab_delivery_checks() {
  local phase_dir="$TEST_TMP_DIR/r6-collab-delivery"
  local results
  local rc
  local saw_output=0
  mkdir -p "$phase_dir"

  results="$(
    "$NODE_BIN" - "$DIR" "$phase_dir" <<'NODE'
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = process.argv[2];
const phaseDir = process.argv[3];
const realSqlite3 = spawnSync("bash", ["-lc", "command -v sqlite3"], { encoding: "utf8" }).stdout.trim();

let failed = 0;
function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function writeExecutable(file, body) { fs.writeFileSync(file, body, { mode: 0o755 }); }
function readJsonLines(file) {
  try { return fs.readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (_) { return []; }
}
function sqlite(db, sql) {
  const res = spawnSync(realSqlite3, [db, sql], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(res.stderr || res.stdout || "sqlite failed");
  return res.stdout;
}
function makeCtl(rows) {
  return {
    teamName(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, "-"); },
    async getState() { return { projects: rows(), globalRows: [] }; },
    async sendToSurface(wsRef, surfaceRef, text) {
      sends.push({ wsRef, surfaceRef, text });
    },
    async submitToSurface(wsRef, surfaceRef, text) {
      sends.push({ wsRef, surfaceRef, text });
    },
  };
}

(async () => {
  try {
    if (!realSqlite3) {
      check("R6 sqlite3 executable is available for collab delivery tests", false);
      process.exit(1);
    }

    const db = path.join(phaseDir, "agmsg.sqlite3");
    const sqliteLog = path.join(phaseDir, "sqlite-log.jsonl");
    const sqliteWrapper = path.join(phaseDir, "sqlite3-wrapper");
    writeExecutable(sqliteWrapper, `#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(sqliteLog)}, JSON.stringify({ args }) + "\\n");
if (!args.includes("-readonly")) {
  console.error("missing -readonly");
  process.exit(64);
}
const res = spawnSync(process.env.REAL_SQLITE3, args, { stdio: "inherit" });
process.exit(res.status == null ? 1 : res.status);
`);

    sqlite(db, [
      "CREATE TABLE messages (id INTEGER PRIMARY KEY, created_at TEXT, team TEXT, from_agent TEXT, to_agent TEXT, body TEXT, read_at TEXT);",
      "INSERT INTO messages (id, created_at, team, from_agent, to_agent, body, read_at) VALUES",
      "(1, '2026-06-08T00:00:01Z', 'alpha', 'claude', 'codex', 'SECRET_BODY_ALPHA', NULL),",
      "(2, '2026-06-08T00:00:02Z', 'alpha', 'claude', 'codex', 'already read', '2026-06-08T00:00:03Z'),",
      "(3, '2026-06-08T00:00:03Z', 'alpha', 'bob', 'codex', 'wrong from', NULL),",
      "(4, '2026-06-08T00:00:04Z', 'beta', 'claude', 'codex', 'wrong team', NULL),",
      "(0, '2026-06-08T00:00:05Z', 'alpha', 'codex', 'claude', 'wrong direction', NULL);",
    ].join(" "));

    const deliveryModule = require(path.join(repo, "collab-delivery.js"));
    const readOpts = {
      dbPath: db,
      sqlite3Bin: sqliteWrapper,
      env: { ...process.env, REAL_SQLITE3: realSqlite3 },
    };
    const unread = await deliveryModule.readUnreadWakeMessages("alpha", readOpts);
    const sqliteCalls = readJsonLines(sqliteLog);
    check("R6 delivery unread filter uses sqlite3 -readonly", (
      sqliteCalls.length >= 1 &&
      sqliteCalls.every((call) => Array.isArray(call.args) && call.args.includes("-readonly"))
    ));
    check("R6 delivery unread filter selects only team/from claude/to codex/read_at NULL", (
      unread.length === 1 &&
      unread[0].id === 1 &&
      unread[0].team === "alpha" &&
      unread[0].from === "claude" &&
      unread[0].to === "codex" &&
      !Object.prototype.hasOwnProperty.call(unread[0], "body")
    ));

    let sends = [];
    let now = 1000;
    let activeRows = [{
      id: "alpha",
      team: "alpha",
      open: true,
      wsRef: "workspace:1",
      slotRefs: { cc: "surface:cc", cdx: "surface:cdx" },
      collab: { enabled: true, active: true },
      surfaces: [
        { ref: "surface:cc", title: "cmuxdash:slot:cc", slot: "cc" },
        { ref: "surface:first", title: "terminal", processes: ["codex"] },
        { ref: "surface:cdx", title: "cmuxdash:slot:cdx", slot: "cdx" },
      ],
    }];
    const ctl = {
      teamName(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, "-"); },
      async getState() { return { projects: activeRows, globalRows: [] }; },
      async sendToSurface(wsRef, surfaceRef, text) {
        sends.push({ wsRef, surfaceRef, text });
      },
      async submitToSurface(wsRef, surfaceRef, text) {
        sends.push({ wsRef, surfaceRef, text });
      },
    };
    const delivery = deliveryModule.createCollabDelivery({
      ctl,
      dbPath: db,
      sqlite3Bin: sqliteWrapper,
      env: { ...process.env, REAL_SQLITE3: realSqlite3 },
      intervalMs: 0,
      retryMs: 50,
      minWakeIntervalMs: 0,
      now: () => now,
    });

    await delivery.tick();
    let snap = delivery.snapshot().projects.alpha;
    check("R6 delivery sends fixed wake text only and never includes agmsg body", (
      sends.length === 1 &&
      sends[0].text === deliveryModule.DEFAULT_WAKE_TEXT &&
      !sends[0].text.includes("SECRET_BODY_ALPHA")
    ));
    check("R6 delivery sends only to cmuxdash:slot:cdx marker surface", (
      sends[0].surfaceRef === "surface:cdx" &&
      sends[0].surfaceRef !== "surface:first"
    ));
    check("R6 delivery keeps pending and does not advance HWM after cmux send success alone", (
      snap &&
      snap.pending.length === 1 &&
      snap.pending[0].id === 1 &&
      snap.highWater === 0 &&
      snap.sentHighWater === 1
    ));

    await delivery.tick();
    check("R6 delivery pending unread does not retry before retry interval", sends.length === 1);
    now += 60;
    await delivery.tick();
    snap = delivery.snapshot().projects.alpha;
    check("R6 delivery retries pending unread after retry interval", (
      sends.length === 2 &&
      snap.pending[0].attempts === 2 &&
      snap.highWater === 0
    ));

    sqlite(db, "UPDATE messages SET read_at='2026-06-08T00:01:00Z' WHERE id=1;");
    await delivery.tick();
    snap = delivery.snapshot().projects.alpha;
    check("R6 delivery marks delivered and advances HWM only after read_at", (
      snap.pending.length === 0 &&
      snap.highWater === 1
    ));

    sqlite(db, "INSERT INTO messages (id, created_at, team, from_agent, to_agent, body, read_at) VALUES (6, '2026-06-08T00:02:00Z', 'alpha', 'claude', 'codex', 'reply-pending-body', NULL);");
    now += 60;
    await delivery.tick();
    sqlite(db, "INSERT INTO messages (id, created_at, team, from_agent, to_agent, body, read_at) VALUES (7, '2026-06-08T00:02:10Z', 'alpha', 'codex', 'claude', 'reply', NULL);");
    await delivery.tick();
    snap = delivery.snapshot().projects.alpha;
    check("R6 delivery treats codex reply as delivered", (
      snap.pending.length === 0 &&
      snap.highWater === 6
    ));

    sends = [];
    activeRows = [{
      id: "alpha",
      team: "alpha",
      open: true,
      wsRef: "workspace:1",
      slotRefs: { cdx: "surface:first" },
      collab: { enabled: true, active: false },
      surfaces: [{ ref: "surface:first", title: "terminal", processes: ["codex"] }],
    }];
    const markerOnly = deliveryModule.createCollabDelivery({
      ctl,
      readUnreadWakeMessages: async () => [{ id: 99, createdAt: "now" }],
      readDeliveryStatus: async () => ({ delivered: false }),
      intervalMs: 0,
      minWakeIntervalMs: 0,
      now: () => now,
    });
    await markerOnly.tick();
    check("R6 delivery refuses first terminal/process=codex fallback without cdx marker", sends.length === 0);

    sends = [];
    activeRows = [{
      id: "alpha",
      team: "alpha",
      open: true,
      wsRef: "workspace:1",
      slotRefs: { cdx: "surface:cdx" },
      collab: { enabled: true, active: true },
      surfaces: [{ ref: "surface:cdx", title: "cmuxdash:slot:cdx", slot: "cdx" }],
    }];
    const cdxOnly = deliveryModule.createCollabDelivery({
      ctl,
      readUnreadWakeMessages: async () => [{ id: 100, createdAt: "now" }],
      readDeliveryStatus: async () => ({ delivered: false }),
      intervalMs: 0,
      minWakeIntervalMs: 0,
      now: () => now,
    });
    await cdxOnly.tick();
    check("R6 delivery active predicate requires cc/cdx pair refs", sends.length === 0);

    let slowStarted = false;
    const slowDelivery = deliveryModule.createCollabDelivery({
      ctl: makeCtl(() => [{
        id: "slow",
        team: "slow",
        open: true,
        wsRef: "workspace:slow",
        slotRefs: { cc: "surface:slow-cc", cdx: "surface:slow" },
        collab: { enabled: true, active: true },
      }]),
      readUnreadWakeMessages: async () => {
        slowStarted = true;
        await sleep(80);
        return [];
      },
      readDeliveryStatus: async () => ({ delivered: false }),
      sendWake: async () => {},
      intervalMs: 0,
      minWakeIntervalMs: 0,
      now: () => now,
    });
    const firstTick = slowDelivery.tick();
    while (!slowStarted) await sleep(5);
    const secondTick = await slowDelivery.tick();
    await firstTick;
    check("R6 delivery single in-flight guard suppresses concurrent duplicate ticks", secondTick && secondTick.skipped === "in-flight");

    let failFirst = true;
    const failRows = [{
      id: "fail",
      team: "fail",
      open: true,
      wsRef: "workspace:fail",
      slotRefs: { cc: "surface:fail-cc", cdx: "surface:fail" },
      collab: { enabled: true, active: true },
    }];
    const failDelivery = deliveryModule.createCollabDelivery({
      ctl: makeCtl(() => failRows),
      readUnreadWakeMessages: async () => [{ id: 200, createdAt: "now" }],
      readDeliveryStatus: async () => ({ delivered: false }),
      sendWake: async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("send failed");
        }
      },
      intervalMs: 0,
      retryMs: 10,
      minWakeIntervalMs: 0,
      now: () => now,
    });
    await failDelivery.tick();
    let failSnap = failDelivery.snapshot().projects.fail;
    now += 11;
    await failDelivery.tick();
    failSnap = failDelivery.snapshot().projects.fail;
    check("R6 delivery failure leaves message pending and eligible for retry", (
      failSnap.pending.length === 1 &&
      failSnap.pending[0].attempts === 2 &&
      failSnap.pending[0].lastError === null
    ));
  } catch (err) {
    failed += 1;
    console.log("FAIL\tR6 runner exception: " + (err && err.message ? err.message : err));
  }
  process.exit(failed ? 1 : 0);
})();
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "$label" ;;
      FAIL) fail "$label" ;;
      *) info "R6 output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "R6 runner produced no output"
  fi
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi
}

if ! run_r6_collab_delivery_checks; then
  finish
fi

# R6b: submitToSurface must drive a TUI agent with a TWO-STEP send — the text as
# a paste, then a SEPARATE lone carriage return — because codex/claude have
# bracketed paste enabled and swallow a trailing \r in the same send. Regression
# guard for the empirically-verified codex wake fix.
run_r6b_submit_two_step_checks() {
  local phase_dir="$TEST_TMP_DIR/r6b-submit"
  local fake_cmux="$phase_dir/fake-cmux"
  local log_file="$phase_dir/cmux.log"
  mkdir -p "$phase_dir"
  cat >"$fake_cmux" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_CMUX_LOG"
exit 0
SH
  chmod +x "$fake_cmux"
  rm -f "$log_file"
  CMUX_BIN="$fake_cmux" FAKE_CMUX_LOG="$log_file" CMUX_DASH_TUI_SUBMIT_GAP_MS=1 \
    node -e 'require(process.argv[1]).submitToSurface("workspace:1","surface:cdx","wake text\n").then(()=>process.exit(0)).catch((e)=>{console.error(e);process.exit(1)})' \
    "$DIR/cmuxctl.js" >/dev/null 2>&1
  local sends first last
  sends="$(grep -c '^send ' "$log_file" 2>/dev/null || echo 0)"
  first="$(grep '^send ' "$log_file" | head -1)"
  last="$(grep '^send ' "$log_file" | tail -1)"
  if [ "$sends" = "2" ]; then
    pass "R6b submitToSurface emits exactly two cmux send calls"
  else
    fail "R6b submitToSurface should emit two cmux send calls (got $sends)"
  fi
  case "$first" in
    *"wake text"*'\n'* | *"wake text"*'\r') fail "R6b first send must carry text with no trailing Enter escape (got: $first)" ;;
    *"wake text"*) pass "R6b first send carries the text with no trailing Enter escape" ;;
    *) fail "R6b first send should carry the wake text (got: $first)" ;;
  esac
  case "$last" in
    *"wake text"*) fail "R6b second send must be the lone submit, not the text (got: $last)" ;;
    *'\r') pass "R6b second send is a lone carriage return (the submit)" ;;
    *) fail "R6b second send should be a lone carriage return (got: $last)" ;;
  esac
}
run_r6b_submit_two_step_checks

run_phase2a_checks() {
  local phase_dir="$TEST_TMP_DIR/phase2a"
  local fake_cmux="$phase_dir/fake-cmux"
  local cfg_file="$phase_dir/projects.json"
  local results
  local rc
  local saw_output=0
  mkdir -p "$phase_dir"
  cat >"$fake_cmux" <<'SH'
#!/usr/bin/env bash
case "$1" in
  list-workspaces)
    printf '{"workspaces":[]}\n'
    ;;
  new-workspace)
    printf 'workspace:1\n'
    ;;
  select-workspace|send)
    ;;
  *)
    printf '{}\n'
    ;;
esac
SH
  chmod +x "$fake_cmux"

  results="$(
    CMUX_BIN="$fake_cmux" \
    CMUX_DASH_PROJECTS_FILE="$cfg_file" \
    CMUX_DASH_SETTLE_MS=0 \
    "$NODE_BIN" - "$DIR" "$phase_dir" <<'NODE'
const fs = require("fs");
const path = require("path");

const repo = process.argv[2];
const base = process.argv[3];
const cfgFile = process.env.CMUX_DASH_PROJECTS_FILE;
const ctl = require(path.join(repo, "cmuxctl.js"));
const templatePath = path.join(repo, "templates", "CLAUDE.md");

let failed = 0;
function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}
function mkdir(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function read(file) {
  return fs.readFileSync(file, "utf8");
}
function unresolvedVars(txt) {
  return /\{\{(?:PROJECT_NAME|TEAM|PROJECT_ID)\}\}/.test(txt);
}

(async () => {
  try {
    const dirs = {
      createNew: mkdir("create-new"),
      createExisting: mkdir("create-existing"),
      managedExisting: mkdir("managed-existing"),
      managedAppend: mkdir("managed-append"),
      off: mkdir("off"),
    };
    fs.writeFileSync(path.join(dirs.createExisting, "CLAUDE.md"), "user owned content\n");
    fs.writeFileSync(path.join(dirs.managedExisting, "CLAUDE.md"), [
      "user intro",
      "<!-- cmux-dashboard:managed:start -->",
      "old managed block",
      "<!-- cmux-dashboard:managed:end -->",
      "user outro",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(dirs.managedAppend, "CLAUDE.md"), "append user text\n");

    const cfg = {
      _comment: "Phase2a isolated test config",
      defaults: {
        topCmd: "true",
        bottomCmd: "true",
        agmsg: { enabled: false, brief: false },
        claudeMd: { mode: "managed-block", templatePath },
        collab: false,
      },
      projects: [
        { id: "phase-create-new", name: "Create New", path: dirs.createNew, claudeMd: { mode: "create-if-missing" } },
        { id: "phase-create-existing", name: "Create Existing", path: dirs.createExisting, claudeMd: { mode: "create-if-missing" } },
        { id: "phase-managed-existing", name: "Managed Existing", path: dirs.managedExisting },
        { id: "phase-managed-append", name: "Managed Append", path: dirs.managedAppend },
        { id: "phase-off", name: "Off Project", path: dirs.off, claudeMd: { mode: "off" } },
      ],
    };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");

    const results = {};
    for (const project of cfg.projects) {
      results[project.id] = await ctl.openProject(project.id, { focus: false });
    }

    const createNew = read(path.join(dirs.createNew, "CLAUDE.md"));
    check("create-if-missing creates CLAUDE.md with rendered template", (
      results["phase-create-new"].claudeMd.action === "created" &&
      createNew.includes("# Create New") &&
      createNew.includes("agmsg send phase-create-new claude codex") &&
      !unresolvedVars(createNew)
    ));

    check("create-if-missing leaves existing CLAUDE.md unchanged", (
      results["phase-create-existing"].claudeMd.action === "skipped" &&
      read(path.join(dirs.createExisting, "CLAUDE.md")) === "user owned content\n"
    ));

    const managedExisting = read(path.join(dirs.managedExisting, "CLAUDE.md"));
    check("managed-block preserves user text and replaces only managed block", (
      results["phase-managed-existing"].claudeMd.action === "updated-block" &&
      managedExisting.includes("user intro") &&
      managedExisting.includes("user outro") &&
      !managedExisting.includes("old managed block") &&
      managedExisting.includes("# Managed Existing") &&
      managedExisting.includes("phase-managed-existing")
    ));

    const managedAppend = read(path.join(dirs.managedAppend, "CLAUDE.md"));
    check("managed-block appends block when no managed block exists", (
      results["phase-managed-append"].claudeMd.action === "appended-block" &&
      managedAppend.startsWith("append user text\n") &&
      managedAppend.includes("<!-- cmux-dashboard:managed:start") &&
      managedAppend.includes("# Managed Append")
    ));

    check("off mode performs no CLAUDE.md operation", (
      results["phase-off"].claudeMd.action === "off" &&
      !fs.existsSync(path.join(dirs.off, "CLAUDE.md"))
    ));

    const generated = [createNew, managedExisting, managedAppend].join("\n");
    check("rendered CLAUDE.md files contain no unresolved variables", !unresolvedVars(generated));
  } catch (err) {
    failed += 1;
    console.log(`FAIL\tPhase2a runner exception: ${err && err.message ? err.message : err}`);
  }
  process.exit(failed ? 1 : 0);
})();
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "Phase2a: $label" ;;
      FAIL) fail "Phase2a: $label" ;;
      *) info "Phase2a output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "Phase2a runner produced no output"
  fi
  return "$rc"
}

if ! run_phase2a_checks; then
  finish
fi

run_phase5_checks() {
  local phase_dir="$TEST_TMP_DIR/phase5"
  local fake_cmux="$phase_dir/cmux"
  local cfg_file="$phase_dir/projects.json"
  local env_log="$phase_dir/env.log"
  local event_log="$phase_dir/events.tsv"
  local state_file="$phase_dir/workspaces.json"
  local results
  local rc
  local saw_output=0
  mkdir -p "$phase_dir/a" "$phase_dir/fail" "$phase_dir/c"
  printf '{"workspaces":[]}\n' >"$state_file"
  : >"$env_log"
  : >"$event_log"
  cat >"$fake_cmux" <<SH
#!/usr/bin/env bash
STATE="$state_file"
ENV_LOG="$env_log"
EVENT_LOG="$event_log"
NODE_BIN="$NODE_BIN"

record_env() {
  local key
  for key in CMUX_WORKSPACE_ID CMUX_TAB_ID CMUX_PANEL_ID CMUX_SURFACE_ID CMUX_PORT CMUX_PORT_END CMUX_SOCKET CMUX_SOCKET_PATH CMUX_CLAUDE_PID; do
    if [ -n "\${!key+x}" ]; then
      printf 'forbidden env still present: %s\n' "\$key" >&2
      exit 90
    fi
  done
  env | sort >>"\$ENV_LOG"
  printf '%s\n' '---' >>"\$ENV_LOG"
}

log_event() {
  "\$NODE_BIN" - "\$EVENT_LOG" "\$1" "\${2:-}" <<'NODE'
const fs = require("fs");
fs.appendFileSync(process.argv[2], Date.now() + "\t" + process.argv[3] + "\t" + (process.argv[4] || "") + "\n");
NODE
}

cmd="\${1:-}"
shift || true
record_env
case "\$cmd" in
  ping)
    printf 'pong\n'
    ;;
  list-workspaces)
    cat "\$STATE"
    ;;
  new-workspace)
    desc=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --description) desc="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    log_event new-workspace "\$desc"
    if [ "\$desc" = "cmuxdash:phase5-fail" ]; then
      printf 'simulated open failure\n' >&2
      exit 42
    fi
    "\$NODE_BIN" - "\$STATE" "\$desc" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const desc = process.argv[3] || "cmuxdash:unknown";
let obj = { workspaces: [] };
try { obj = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
obj.workspaces = Array.isArray(obj.workspaces) ? obj.workspaces : [];
const ref = "workspace:" + (obj.workspaces.length + 1);
obj.workspaces.push({ ref, description: desc, selected: false, latest_conversation_message: null, latest_submitted_at: null });
fs.writeFileSync(file, JSON.stringify(obj) + "\n");
process.stdout.write(ref + "\n");
NODE
    ;;
  close-workspace)
    workspace=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    log_event close-workspace "\$workspace"
    "\$NODE_BIN" - "\$STATE" "\$workspace" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
let obj = { workspaces: [] };
try { obj = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
obj.workspaces = (Array.isArray(obj.workspaces) ? obj.workspaces : []).filter((w) => w && w.ref !== workspace);
fs.writeFileSync(file, JSON.stringify(obj) + "\n");
NODE
    ;;
  list-pane-surfaces)
    printf '{"surfaces":[{"ref":"surface:1","title":"claude"}]}\n'
    ;;
  send|select-workspace)
    ;;
  *)
    printf '{}\n'
    ;;
esac
SH
  chmod +x "$fake_cmux"

  results="$(
    CMUX_BIN="$fake_cmux" \
    CMUX_WORKSPACE_ID="workspace:stale" \
    CMUX_TAB_ID="tab:stale" \
    CMUX_PANEL_ID="panel:stale" \
    CMUX_SURFACE_ID="surface:stale" \
    CMUX_PORT="1111" \
    CMUX_PORT_END="2222" \
    CMUX_SOCKET="/tmp/stale.sock" \
    CMUX_SOCKET_PATH="/tmp/stale-path.sock" \
    CMUX_CLAUDE_PID="99999" \
    CMUX_DASH_PROJECTS_FILE="$cfg_file" \
    CMUX_DASH_SETTLE_MS=0 \
    CMUX_DASH_OPENALL_GAP_MS=120 \
    CMUX_DASH_HEALTH_FAILURE_THRESHOLD=3 \
    "$NODE_BIN" - "$DIR" "$phase_dir" "$env_log" "$event_log" <<'NODE'
const fs = require("fs");
const path = require("path");

const repo = process.argv[2];
const base = process.argv[3];
const envLog = process.argv[4];
const eventLog = process.argv[5];
const cfgFile = process.env.CMUX_DASH_PROJECTS_FILE;
const ctl = require(path.join(repo, "cmuxctl.js"));

let failed = 0;
function check(label, ok) {
  if (ok) console.log(`PASS\t${label}`);
  else {
    failed += 1;
    console.log(`FAIL\t${label}`);
  }
}

(async () => {
  try {
    const cfg = {
      _comment: "Phase5 isolated test config",
      defaults: {
        topCmd: "true",
        bottomCmd: "true",
        agmsg: { enabled: false, brief: false },
        claudeMd: { mode: "off" },
        collab: false,
      },
      projects: [
        { id: "phase5-a", name: "Phase5 A", path: path.join(base, "a") },
        { id: "phase5-fail", name: "Phase5 Fail", path: path.join(base, "fail") },
        { id: "phase5-c", name: "Phase5 C", path: path.join(base, "c") },
      ],
    };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");

    const doctor = await ctl.doctor();
    const envText = fs.readFileSync(envLog, "utf8");
    const forbidden = ctl.CMUX_CONTEXT_ENV_KEYS.filter((key) => new RegExp(`^${key}=`, "m").test(envText));
    check("env scrub removes cmux pane variables from child env", forbidden.length === 0);
    check("env scrub preserves CMUX_BIN and sets CMUX_QUIET=1", /^CMUX_BIN=.+/m.test(envText) && /^CMUX_QUIET=1$/m.test(envText));
    check("scrubbed cmux ping succeeds", Array.isArray(doctor.checks) && doctor.checks.some((c) => c && c.name === "cmux" && c.ok === true));

    const openResults = await ctl.openAll();
    check("open-all continues after one project failure", (
      Array.isArray(openResults) &&
      openResults.length === 3 &&
      openResults[0].ok === true &&
      openResults[1].ok === false &&
      openResults[2].ok === true
    ));
    check("open-all records per-project success and error", (
      openResults.every((r) => r && typeof r.id === "string" && typeof r.ok === "boolean") &&
      typeof openResults[1].error === "string" &&
      openResults[1].error.includes("simulated open failure")
    ));

    const events = fs.readFileSync(eventLog, "utf8").trim().split(/\n/).filter(Boolean)
      .map((line) => {
        const [at, type, detail] = line.split("\t");
        return { at: Number(at), type, detail };
      });
    const opens = events.filter((e) => e.type === "new-workspace");
    check("open-all applies configured settle gap", (
      opens.length === 3 &&
      opens[1].at - opens[0].at >= 90 &&
      opens[2].at - opens[1].at >= 90
    ));

    const closeResults = await ctl.closeAll();
    check("close-all returns per-project success records", (
      Array.isArray(closeResults) &&
      closeResults.length === 3 &&
      closeResults.every((r) => r && typeof r.id === "string" && r.ok === true)
    ));

    const tracker = ctl.createCmuxHealthTracker(3);
    tracker.recordFailure(new Error("one"));
    tracker.recordFailure(new Error("two"));
    const before = tracker.snapshot();
    tracker.recordFailure(new Error("three"));
    const unhealthy = tracker.snapshot();
    tracker.recordSuccess();
    const recovered = tracker.snapshot();
    check("self-heal counter stays healthy below threshold", before.consecutiveFailures === 2 && before.unhealthy === false);
    check("self-heal counter marks unhealthy at threshold", unhealthy.consecutiveFailures === 3 && unhealthy.unhealthy === true && unhealthy.lastError.includes("three"));
    check("self-heal counter recovers on successful read", recovered.consecutiveFailures === 0 && recovered.unhealthy === false);

    const server = fs.readFileSync(path.join(repo, "server.js"), "utf8");
    const html = fs.readFileSync(path.join(repo, "public", "index.html"), "utf8");
    const dash = fs.readFileSync(path.join(repo, "cmux-dash"), "utf8");
    const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
    check("server exposes health on /api/state and restart endpoint", (
      server.includes("maybeExitOnUnhealthy") &&
      server.includes("urlPath === '/api/restart'") &&
      server.includes("CMUX_DASH_EXIT_ON_UNHEALTHY")
    ));
    check("UI unhealthy banner, restart affordance, and R1 slot controls are present", (
      html.includes("cmux応答不良: サーバー再起動が必要") &&
      html.includes("function restartServer()") &&
      html.includes("jpost('/api/restart'") &&
      html.includes("./cmux-dash restart") &&
      html.includes("s.health && s.health.cmux") &&
      html.includes("function toggleSlot(id, slot, on)") &&
      html.includes("/api/project/${encodeURIComponent(id)}/slot/${encodeURIComponent(slot)}") &&
      html.includes("class=\"slot-btn")
    ));
    check("cmux-dash restart subcommand is present", (
      dash.includes("restart_server()") &&
      dash.includes("restart) restart_server ;;") &&
      dash.includes("up|server|open|stop|restart")
    ));
    check("cmux-dash uses in-pane server workspace instead of background server startup", (
      dash.includes("SERVER_WORKSPACE_DESC") &&
      dash.includes("ensure_server_workspace()") &&
      dash.includes("ensure_server_surface()") &&
      dash.includes("wait_for_server_surface_ready()") &&
      dash.includes("wait_for_port_released()") &&
      dash.includes("print_server_start_diagnostics()") &&
      dash.includes("server_exec_command()") &&
      dash.includes("install-server is disabled") &&
      !dash.includes('nohup "$NODE_BIN" server.js') &&
      !dash.includes("start_launchd_server") &&
      !dash.includes("kickstart -k") &&
      !dash.includes("install-server|uninstall-server")
    ));
    check("cmux-dash documents in-pane server as stable mode", (
      dash.includes("Stable in-pane mode") &&
      dash.includes("cmuxdash:__server__") &&
      dash.includes("server workspace") &&
      dash.includes("./cmux-dash server") &&
      dash.includes("node server.js")
    ));
    check("README documents in-pane startup and orphan mitigation", (
      readme.includes("推奨の安定運用") &&
      readme.includes("cmuxdash:__server__") &&
      readme.includes("./cmux-dash up") &&
      readme.includes("health.cmux") &&
      readme.includes("orphan")
    ));
  } catch (err) {
    failed += 1;
    console.log(`FAIL\tPhase5 runner exception: ${err && err.message ? err.message : err}`);
  }
  process.exit(failed ? 1 : 0);
})();
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "Phase5: $label" ;;
      FAIL) fail "Phase5: $label" ;;
      *) info "Phase5 output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "Phase5 runner produced no output"
  fi
  return "$rc"
}

if ! run_phase5_checks; then
  finish
fi

run_phase5c_checks() {
  local phase_dir="$TEST_TMP_DIR/phase5c"
  local results
  local rc
  local saw_output=0
  mkdir -p "$phase_dir"

  results="$(
    "$NODE_BIN" - "$DIR" "$phase_dir" "$HOST" "$PORT" <<'NODE'
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repo = process.argv[2];
const phaseDir = process.argv[3];
const host = process.argv[4];
const basePort = Number(process.argv[5]) + 2300;
const nodeBin = process.execPath;
let failed = 0;
const children = [];
const servers = [];

function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function shDoubleQuote(value) {
  return JSON.stringify(String(value));
}
function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}
function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: requestPath, timeout: 1200 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
  });
}
async function waitForHttp(port, requestPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, requestPath);
      if (res.status >= 200 && res.status < 500) return true;
    } catch (_) {}
    await sleep(100);
  }
  return false;
}
	function waitForExit(child, timeoutMs) {
	  return new Promise((resolve) => {
	    if (child.exitCode !== null || child.signalCode !== null) {
	      resolve({ code: child.exitCode, signal: child.signalCode });
	      return;
	    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, host, () => {
        server.close(() => resolve(true));
      });
    });
    if (ok) return port;
  }
  throw new Error("no free port near " + start);
}
async function canListen(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}
async function startDashboard({ port, cmuxBin, projectsFile, logFile }) {
  const out = fs.openSync(logFile, "w");
  const child = spawn(nodeBin, ["server.js"], {
    cwd: repo,
    env: {
      ...process.env,
      CMUX_BIN: cmuxBin,
      CMUX_DASH_PORT: String(port),
      CMUX_DASH_HOST: host,
      CMUX_DASH_PROJECTS_FILE: projectsFile,
      CMUX_DASH_HEALTH_FAILURE_THRESHOLD: "1",
      CMUX_DASH_EXIT_ON_UNHEALTHY: "1",
      CMUX_DASH_RECOVERY_PING_TIMEOUT: "250",
      CMUX_DASH_RECOVERY_PING_RETRY_BUDGET_MS: "250",
      CMUX_DASH_RECOVERY_PING_RETRIES: "0",
      CMUX_DASH_DOCTOR_TIMEOUT: "250",
      CMUX_DASH_DOCTOR_RETRY_BUDGET_MS: "250",
      CMUX_DASH_DOCTOR_RETRIES: "0",
    },
    stdio: ["ignore", out, out],
  });
  child.once("exit", () => fs.closeSync(out));
  children.push(child);
  if (!await waitForHttp(port, "/", 5000)) {
    throw new Error("dashboard did not serve / on " + port);
  }
  return child;
}
	async function startHealthyServer(port) {
  const server = http.createServer((req, res) => {
    if ((req.url || "").startsWith("/api/state")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
	  servers.push(server);
	  return server;
	}
	async function startStateServer(port, modeFile) {
      const server = http.createServer((req, res) => {
        if ((req.url || "").startsWith("/api/state")) {
          let mode = "healthy";
          try { mode = fs.readFileSync(modeFile, "utf8").trim() || "healthy"; } catch (_) {}
          if (mode === "invalid") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("not json");
            return;
          }
          const cmux = mode === "healthy"
            ? { ok: true, unhealthy: false, consecutiveFailures: 0, threshold: 3 }
            : { ok: false, unhealthy: true, consecutiveFailures: 3, threshold: 3, lastError: "simulated degraded cmux" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ health: { cmux } }));
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
	  servers.push(server);
	  return server;
	}
async function startStickyListener(port, pidFile, releaseDelayMs) {
  const child = spawn(nodeBin, ["-e", `
const http = require("http");
const fs = require("fs");
const host = process.env.HOST;
const port = Number(process.env.PORT);
const pidFile = process.env.PIDFILE;
const releaseDelayMs = Number(process.env.RELEASE_DELAY_MS || "800");
let stopping = false;
const server = http.createServer((req, res) => {
  if ((req.url || "").startsWith("/api/state")) {
    if (stopping) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("stopping");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ health: { cmux: { ok: true, unhealthy: false } } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});
server.listen(port, host, () => fs.writeFileSync(pidFile, String(process.pid)));
process.on("SIGTERM", () => {
  stopping = true;
  setTimeout(() => server.close(() => process.exit(0)), releaseDelayMs);
});
`], {
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      PIDFILE: pidFile,
      RELEASE_DELAY_MS: String(releaseDelayMs),
    },
    stdio: "ignore",
  });
  children.push(child);
  if (!await waitForHttp(port, "/api/state", 5000)) {
    throw new Error("sticky listener did not start on " + port);
  }
  return child;
}
function runCommand(command, args, opts = {}, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: 124, signal: "SIGKILL", stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ status: code, signal, stdout, stderr, timedOut: false });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      finish({ status: 127, signal: null, stdout, stderr: stderr + err.message, timedOut: false });
    });
  });
}

(async () => {
  try {
    const projectsFile = path.join(phaseDir, "projects.json");
    fs.writeFileSync(projectsFile, JSON.stringify({
	      _comment: "Phase5c isolated test config",
      defaults: { agmsg: { enabled: false }, claudeMd: { mode: "off" }, collab: false },
      projects: [],
    }) + "\n");

    const exitFake = path.join(phaseDir, "cmux-exit");
    writeExecutable(exitFake, [
      "#!/usr/bin/env bash",
      'case "${1:-}" in',
      "  list-workspaces) printf 'simulated list failure\\n' >&2; exit 52 ;;",
      "  ping) printf 'simulated final ping failure\\n' >&2; exit 53 ;;",
      "  *) printf '{}\\n' ;;",
      "esac",
    ].join("\n") + "\n");
    const exitPort = await findFreePort(basePort);
    const exitLog = path.join(phaseDir, "exit-server.log");
    const exitChild = await startDashboard({ port: exitPort, cmuxBin: exitFake, projectsFile, logFile: exitLog });
    await request(exitPort, "/api/state").catch(() => null);
    const exitResult = await waitForExit(exitChild, 4000);
    const exitLogText = fs.existsSync(exitLog) ? fs.readFileSync(exitLog, "utf8") : "";
    check("EXIT_ON_UNHEALTHY exits nonzero after final ping failure", !!exitResult && exitResult.code !== 0);
    check("EXIT_ON_UNHEALTHY logs confirmed final ping failure before exit", /cmux unhealthy confirmed/.test(exitLogText) && /final ping failed/.test(exitLogText));

    const flapState = path.join(phaseDir, "flap-recovered");
    const flapFake = path.join(phaseDir, "cmux-flap");
    writeExecutable(flapFake, [
      "#!/usr/bin/env bash",
      "STATE=" + shDoubleQuote(flapState),
      'case "${1:-}" in',
      "  list-workspaces)",
      "    if [ ! -f \"$STATE\" ]; then printf 'transient list failure\\n' >&2; exit 62; fi",
      "    printf '{\"workspaces\":[]}\\n'",
      "    ;;",
      "  ping)",
      "    : > \"$STATE\"",
      "    printf 'pong\\n'",
      "    ;;",
      "  *) printf '{}\\n' ;;",
      "esac",
    ].join("\n") + "\n");
    const flapPort = await findFreePort(exitPort + 1);
    const flapLog = path.join(phaseDir, "flap-server.log");
    const flapChild = await startDashboard({ port: flapPort, cmuxBin: flapFake, projectsFile, logFile: flapLog });
    let flapExited = false;
    flapChild.once("exit", () => { flapExited = true; });
    await request(flapPort, "/api/state").catch(() => null);
    await sleep(900);
    const recoveredBody = await request(flapPort, "/api/state").catch(() => null);
    let recoveredHealth = null;
    try { recoveredHealth = JSON.parse(recoveredBody && recoveredBody.body || "{}").health.cmux; } catch (_) {}
    const flapLogText = fs.existsSync(flapLog) ? fs.readFileSync(flapLog, "utf8") : "";
    check("final ping recovery prevents unhealthy exit", !flapExited && flapChild.exitCode === null);
    check("final ping recovery resets health counter", !!recoveredHealth && recoveredHealth.unhealthy === false && recoveredHealth.consecutiveFailures === 0);
    check("final ping recovery is logged", /final ping recovered/.test(flapLogText));
    flapChild.kill("SIGTERM");
    await waitForExit(flapChild, 2000);

	    const watchdog = path.join(repo, "bin", "health-watchdog.sh");
	    const statePort = await findFreePort(flapPort + 1);
	    const modeFile = path.join(phaseDir, "watchdog-state-mode");
	    fs.writeFileSync(modeFile, "healthy");
	    await startStateServer(statePort, modeFile);
	    const watchdogBaseEnv = {
	      ...process.env,
	      NODE_BIN: nodeBin,
	      CMUX_DASH_URL: "http://" + host + ":" + statePort + "/api/state",
	      CMUX_DASH_WATCHDOG_CURL_TIMEOUT: "1",
	      CMUX_DASH_WATCHDOG_FAILURE_THRESHOLD: "3",
	    };
	    const healthyCheck = await runCommand("/bin/bash", [watchdog, "check"], {
	      cwd: repo,
	      env: watchdogBaseEnv,
	    }, 5000);
	    check("watchdog check treats healthy state as ok", healthyCheck.status === 0 && !/unhealthy|NOT RESPONDING|invalid/.test(healthyCheck.stdout + healthyCheck.stderr));

	    fs.writeFileSync(modeFile, "unhealthy");
	    const noRestartOnce = await runCommand("/bin/bash", [watchdog, "once"], {
	      cwd: repo,
	      env: watchdogBaseEnv,
	    }, 5000);
	    check("watchdog default prompts foreground server instead of detached restart", (
	      noRestartOnce.status === 0 &&
	      /foreground server required/.test(noRestartOnce.stdout) &&
	      /not restarted: detached watchdog restarts cannot restore/.test(noRestartOnce.stdout) &&
	      /\.\/cmux-dash server/.test(noRestartOnce.stdout)
	    ));
	
	    const unhealthyRestartLog = path.join(phaseDir, "watchdog-unhealthy-restart.log");
	    fs.writeFileSync(modeFile, "unhealthy");
	    const unhealthyOnce = await runCommand("/bin/bash", [watchdog, "once"], {
	      cwd: repo,
	      env: {
	        ...watchdogBaseEnv,
	        CMUX_DASH_WATCHDOG_RESTART_CMD: "printf '%s\\n' restarted >> " + shDoubleQuote(unhealthyRestartLog) + "; printf '%s' healthy > " + shDoubleQuote(modeFile),
	      },
	    }, 5000);
	    const unhealthyRestarted = fs.existsSync(unhealthyRestartLog) ? fs.readFileSync(unhealthyRestartLog, "utf8") : "";
	    check("watchdog once restarts on unhealthy cmux health", (
	      unhealthyOnce.status === 0 &&
	      /restarted/.test(unhealthyRestarted) &&
	      /cmux unhealthy/.test(unhealthyOnce.stdout) &&
	      /restarted; cmux ok=true/.test(unhealthyOnce.stdout)
	    ));
	
	    const deadPort = await findFreePort(statePort + 1);
	    const unreachableRestartLog = path.join(phaseDir, "watchdog-unreachable-restart.log");
	    const unreachableOnce = await runCommand("/bin/bash", [watchdog, "once"], {
	      cwd: repo,
	      env: {
	        ...watchdogBaseEnv,
	        CMUX_DASH_URL: "http://" + host + ":" + deadPort + "/api/state",
	        CMUX_DASH_WATCHDOG_RESTART_CMD: "printf '%s\\n' restarted >> " + shDoubleQuote(unreachableRestartLog),
	      },
	    }, 5000);
	    const unreachableRestarted = fs.existsSync(unreachableRestartLog) ? fs.readFileSync(unreachableRestartLog, "utf8") : "";
	    check("watchdog once restarts when /api/state is unreachable", (
	      unreachableOnce.status === 0 &&
	      /restarted/.test(unreachableRestarted) &&
	      /server NOT RESPONDING/.test(unreachableOnce.stdout)
	    ));
	
	    const help = spawnSync("/bin/bash", [path.join(repo, "cmux-dash"), "help"], {
	      cwd: repo,
	      env: { ...process.env, NODE_BIN: nodeBin },
	      encoding: "utf8",
	    });
	    check("cmux-dash help documents stable in-pane server mode", (
	      help.status === 0 &&
	      /Stable in-pane mode/.test(help.stdout) &&
	      /cmuxdash:__server__/.test(help.stdout) &&
	      /\.\/cmux-dash up/.test(help.stdout) &&
	      /\.\/cmux-dash server/.test(help.stdout) &&
	      /exec node server\.js/.test(help.stdout)
	    ));

	    const fakeCmux = path.join(phaseDir, "cmux-in-pane");
	    const fakeCmuxState = path.join(phaseDir, "cmux-in-pane-state.json");
	    const fakeCmuxLog = path.join(phaseDir, "cmux-in-pane-log.jsonl");
	    const fakeProjects = path.join(phaseDir, "in-pane-projects.json");
	    const fakeServerLog = path.join(phaseDir, "in-pane-server.log");
	    fs.writeFileSync(fakeCmuxState, JSON.stringify({ workspaces: [], panes: [], surfaces: [], serverPids: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }) + "\n");
	    fs.writeFileSync(fakeCmuxLog, "");
	    fs.writeFileSync(fakeProjects, JSON.stringify({
	      _comment: "Phase5c in-pane startup isolated config",
	      defaults: { agmsg: { enabled: false }, claudeMd: { mode: "off" }, collab: false },
	      projects: [],
	    }) + "\n");
	    writeExecutable(fakeCmux, "#!/usr/bin/env node\n" + `
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const repo = ${JSON.stringify(repo)};
const stateFile = ${JSON.stringify(fakeCmuxState)};
const logFile = ${JSON.stringify(fakeCmuxLog)};
const serverLog = ${JSON.stringify(fakeServerLog)};
const self = ${JSON.stringify(fakeCmux)};
const args = process.argv.slice(2);
const cmd = args.shift() || "";
const surfaceReadyDelayMs = Number(process.env.FAKE_CMUX_SURFACE_READY_DELAY_MS || "0");
const serverStartDelayMs = Number(process.env.FAKE_CMUX_SERVER_START_DELAY_MS || "0");
const serverNoStart = process.env.FAKE_CMUX_SERVER_NO_START === "1";
function readState(){ try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (_) { return { workspaces: [], panes: [], surfaces: [], serverPids: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }; } }
function writeState(s){ fs.writeFileSync(stateFile, JSON.stringify(s) + "\\n"); }
function log(event, data){ fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), event, ...(data || {}) }) + "\\n"); }
function argValue(name){ const i = args.indexOf(name); return i >= 0 ? args[i + 1] || "" : ""; }
function firstTextArg(){
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--surface" || arg === "--workspace" || arg === "--pane" || arg === "--type" || arg === "--url" || arg === "--focus") { i += 1; continue; }
    if (arg === "--json") continue;
    return arg;
  }
  return "";
}
if (cmd === "ping") { log("ping"); console.log("pong"); process.exit(0); }
if (cmd === "list-workspaces") {
  const s = readState();
  log("list-workspaces", { count: (s.workspaces || []).length });
  console.log(JSON.stringify({ workspaces: s.workspaces || [] }));
  process.exit(0);
}
if (cmd === "new-workspace") {
  const s = readState();
  s.workspaces = Array.isArray(s.workspaces) ? s.workspaces : [];
  s.panes = Array.isArray(s.panes) ? s.panes : [];
  const wsRef = "workspace:" + (s.nextWorkspace || 1);
  const paneRef = "pane:" + (s.nextPane || 1);
  s.nextWorkspace = (s.nextWorkspace || 1) + 1;
  s.nextPane = (s.nextPane || 1) + 1;
  const description = argValue("--description");
  const name = argValue("--name");
  s.workspaces.push({ ref: wsRef, description, name, cwd: argValue("--cwd"), selected: false });
  s.panes.push({ ref: paneRef, workspace: wsRef });
  writeState(s);
  log("new-workspace", { ref: wsRef, pane: paneRef, description, name });
  console.log(wsRef);
  process.exit(0);
}
if (cmd === "list-panes") {
  const s = readState();
  const workspace = argValue("--workspace");
  const panes = (s.panes || []).filter((pane) => !workspace || pane.workspace === workspace);
  log("list-panes", { workspace, count: panes.length });
  console.log(JSON.stringify({ panes }));
  process.exit(0);
}
if (cmd === "list-pane-surfaces") {
  const s = readState();
  const workspace = argValue("--workspace");
  const pane = argValue("--pane");
  const surfaces = (s.surfaces || []).filter((surface) => (!workspace || surface.workspace === workspace) && (!pane || surface.pane === pane));
  log("list-pane-surfaces", { workspace, pane, count: surfaces.length });
  console.log(JSON.stringify({ surfaces }));
  process.exit(0);
}
if (cmd === "new-surface") {
  const s = readState();
  s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
  const workspace = argValue("--workspace");
  let pane = argValue("--pane");
  if (!pane) pane = ((s.panes || []).find((item) => item.workspace === workspace) || {}).ref || "";
  const ref = "surface:" + (s.nextSurface || 1);
  s.nextSurface = (s.nextSurface || 1) + 1;
  s.surfaces.push({ ref, workspace, pane, type: "terminal", title: "terminal", readyAt: Date.now() + surfaceReadyDelayMs });
  writeState(s);
  log("new-surface", { ref, workspace, pane });
  console.log(ref);
  process.exit(0);
}
if (cmd === "send") {
  const s = readState();
  const workspace = argValue("--workspace");
  const surface = argValue("--surface");
  const text = firstTextArg();
  log("send", { workspace, surface, text });
  const surfaceRow = (s.surfaces || []).find((item) => item && item.ref === surface);
  if (surfaceRow && surfaceRow.readyAt && Date.now() < surfaceRow.readyAt) {
    log("send-before-ready", { workspace, surface, readyAt: surfaceRow.readyAt, text });
    process.exit(43);
  }
  if (/server\\.js/.test(text)) {
    if (serverNoStart) {
      writeState(s);
      process.exit(0);
    }
    const out = fs.openSync(serverLog, "a");
    const nodeBin = process.env.NODE_BIN || process.execPath;
    const childOptions = {
      cwd: repo,
      detached: true,
      env: {
        ...process.env,
        FAKE_CMUX_REPO: repo,
        CMUX_BIN: self,
        CMUX_DASH_PROJECTS_FILE: process.env.CMUX_DASH_PROJECTS_FILE,
        CMUX_DASH_PORT: process.env.CMUX_DASH_PORT,
        CMUX_DASH_HOST: process.env.CMUX_DASH_HOST,
        CMUX_DASH_SETTLE_MS: "0",
        CMUX_DASH_READ_TIMEOUT: "500",
        CMUX_DASH_READ_RETRY_BUDGET_MS: "500",
        CMUX_DASH_READ_RETRIES: "0",
      },
      stdio: ["ignore", out, out],
    };
    const child = serverStartDelayMs > 0
      ? spawn(nodeBin, ["-e", [
          "const { spawn } = require('child_process');",
          "const delay = Number(process.env.FAKE_CMUX_SERVER_START_DELAY_MS || '0');",
          "let child = null;",
          "process.on('SIGTERM', () => { if (child) child.kill('SIGTERM'); setTimeout(() => process.exit(0), 50); });",
          "setTimeout(() => {",
          "  child = spawn(process.execPath, ['server.js'], { cwd: process.env.FAKE_CMUX_REPO, env: process.env, stdio: 'inherit' });",
          "  child.on('exit', (code, signal) => process.exit(code == null ? (signal ? 1 : 0) : code));",
          "}, delay);",
        ].join("\\n")], childOptions)
      : spawn(nodeBin, ["server.js"], childOptions);
    child.unref();
    s.serverPids = Array.isArray(s.serverPids) ? s.serverPids : [];
    s.serverPids.push(child.pid);
    if (process.env.CMUX_DASH_SERVER_PIDFILE) fs.writeFileSync(process.env.CMUX_DASH_SERVER_PIDFILE, String(child.pid));
    writeState(s);
  }
  process.exit(0);
}
if (cmd === "new-pane") {
  const s = readState();
  s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
  const workspace = argValue("--workspace");
  const ref = "surface:" + (s.nextSurface || 1);
  s.nextSurface = (s.nextSurface || 1) + 1;
  s.surfaces.push({ ref, workspace, pane: "", type: argValue("--type") || "browser", title: argValue("--url") });
  writeState(s);
  log("new-pane", { ref, workspace, type: argValue("--type"), url: argValue("--url") });
  console.log(ref);
  process.exit(0);
}
if (cmd === "close-surface") {
  const s = readState();
  const surface = argValue("--surface");
  s.surfaces = (s.surfaces || []).filter((item) => item.ref !== surface);
  writeState(s);
  log("close-surface", { surface });
  process.exit(0);
}
if (cmd === "open") { log("open", { url: args[0] || "" }); process.exit(0); }
if (cmd === "top") { process.exit(0); }
if (cmd === "memory") { console.log("Footprint: 64 MiB\\nChild RSS total: 16 MiB"); process.exit(0); }
console.log("{}");
`);
	    const readFakeLog = () => fs.readFileSync(fakeCmuxLog, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
	    const readFakeState = () => JSON.parse(fs.readFileSync(fakeCmuxState, "utf8"));
	    const upPort = await findFreePort(deadPort + 1);
	    const inPanePidFile = path.join(phaseDir, "in-pane-server.pid");
	    const upEnv = {
	      ...process.env,
	      NODE_BIN: nodeBin,
	      CMUX_BIN: fakeCmux,
	      CMUX_DASH_PORT: String(upPort),
	      CMUX_DASH_HOST: host,
	      CMUX_DASH_PROJECTS_FILE: fakeProjects,
	      CMUX_DASH_SERVER_PIDFILE: inPanePidFile,
	      CMUX_DASH_STATE_CURL_TIMEOUT: "1",
	      CMUX_DASH_SERVER_SURFACE_READY_DELAY_MS: "250",
	      CMUX_DASH_SERVER_SURFACE_READY_TIMEOUT_MS: "1200",
	      CMUX_DASH_SERVER_SURFACE_READY_INTERVAL_MS: "50",
	      CMUX_DASH_SERVER_REACHABLE_TIMEOUT_MS: "3000",
	      CMUX_DASH_SERVER_REACHABLE_INTERVAL_MS: "100",
	      CMUX_DASH_SERVER_HEALTH_TIMEOUT_MS: "3000",
	      CMUX_DASH_SERVER_HEALTH_INTERVAL_MS: "100",
	      CMUX_DASH_SERVER_PORT_RELEASE_TIMEOUT_MS: "3000",
	      CMUX_DASH_SERVER_PORT_RELEASE_INTERVAL_MS: "100",
	      FAKE_CMUX_SURFACE_READY_DELAY_MS: "150",
	      FAKE_CMUX_SERVER_START_DELAY_MS: "600",
	      CMUX_DASH_SETTLE_MS: "0",
	      CMUX_DASH_READ_TIMEOUT: "500",
	      CMUX_DASH_READ_RETRY_BUDGET_MS: "500",
	      CMUX_DASH_READ_RETRIES: "0",
	    };
	    const up = await runCommand("/bin/bash", [path.join(repo, "cmux-dash"), "up"], { cwd: repo, env: upEnv }, 12000);
	    const upStateResp = await request(upPort, "/api/state").catch(() => null);
	    let upState = null;
	    try { upState = JSON.parse(upStateResp && upStateResp.body || "{}"); } catch (_) {}
	    let logs = readFakeLog();
	    let fakeState = readFakeState();
	    const serverWorkspaceCreates = logs.filter((item) => item.event === "new-workspace" && item.description === "cmuxdash:__server__");
	    const serverSends = logs.filter((item) => item.event === "send" && /CMUX_DASH_PORT=/.test(item.text || "") && /server\.js/.test(item.text || ""));
	    const serverSurfaceCreate = logs.find((item) => item.event === "new-surface");
	    const browserPanes = logs.filter((item) => item.event === "new-pane" && item.type === "browser" && item.url === "http://" + host + ":" + upPort);
	    const upContractOk = (
	      up.status === 0 &&
	      serverWorkspaceCreates.length === 1 &&
	      serverSends.length === 1 &&
	      /CMUX_DASH_PORT=/.test(serverSends[0].text) &&
	      browserPanes.length === 1 &&
	      !logs.some((item) => item.event === "open")
	    );
	    if (!upContractOk) console.log("INFO\tPhase5c in-pane up debug " + JSON.stringify({
	      status: up.status,
	      stdout: (up.stdout || "").slice(0, 200),
	      stderr: (up.stderr || "").slice(0, 200),
	      serverWorkspaceCreates: serverWorkspaceCreates.length,
	      serverSends: serverSends.length,
	      browserPanes: browserPanes.length,
	      events: logs.map((item) => item.event + ":" + (item.description || item.type || item.count || "")).slice(0, 20),
	    }));
	    check("cmux-dash up creates server workspace, sends server command, and opens browser pane", upContractOk);
	    const launchCommandOk = (
	      serverSends.length === 1 &&
	      /CMUX_DASH_PORT=/.test(serverSends[0].text) &&
	      /CMUX_DASH_HOST=/.test(serverSends[0].text) &&
	      /server\.js/.test(serverSends[0].text) &&
	      !/\bexec\b[\s\S]*server\.js/.test(serverSends[0].text) &&
	      serverSurfaceCreate &&
	      serverSends[0].at - serverSurfaceCreate.at >= 120 &&
	      !logs.some((item) => item.event === "send-before-ready")
	    );
	    if (!launchCommandOk) console.log("INFO\tPhase5c in-pane command/ready debug " + JSON.stringify({
	      sendText: serverSends[0] && serverSends[0].text,
	      newSurfaceAt: serverSurfaceCreate && serverSurfaceCreate.at,
	      sendAt: serverSends[0] && serverSends[0].at,
	      sendBeforeReady: logs.filter((item) => item.event === "send-before-ready").length,
	    }));
	    check("cmux-dash waits for server surface readiness and sends non-exec node command", launchCommandOk);
	    const upHealthOk = (
	      upStateResp && upStateResp.status === 200 &&
	      upState && upState.health && upState.health.cmux && upState.health.cmux.ok === true &&
	      /server reachable/.test(up.stdout + up.stderr) &&
	      /health\.cmux ok/.test(up.stdout + up.stderr) &&
	      fs.existsSync(fakeServerLog) &&
	      fs.readFileSync(fakeServerLog, "utf8").includes("http://" + host + ":" + upPort)
	    );
	    if (!upHealthOk) console.log("INFO\tPhase5c in-pane health debug " + JSON.stringify({
	      respStatus: upStateResp && upStateResp.status,
	      respBody: (upStateResp && upStateResp.body || "").slice(0, 160),
	      serverLogExists: fs.existsSync(fakeServerLog),
	      serverLog: fs.existsSync(fakeServerLog) ? fs.readFileSync(fakeServerLog, "utf8").slice(0, 160) : "",
	    }));
	    check("cmux-dash in-pane server is reachable with health.cmux ok", upHealthOk);
	    const firstServerPid = fakeState.serverPids && fakeState.serverPids[0];
	    const upAgain = await runCommand("/bin/bash", [path.join(repo, "cmux-dash"), "up"], { cwd: repo, env: upEnv }, 12000);
	    logs = readFakeLog();
	    fakeState = readFakeState();
	    const sendsAfterReuse = logs.filter((item) => item.event === "send" && /server\.js/.test(item.text || ""));
	    const browserAfterReuse = logs.filter((item) => item.event === "new-pane" && item.type === "browser");
	    const reuseOk = (
	      upAgain.status === 0 &&
	      /server already running in cmux workspace/.test(upAgain.stdout + upAgain.stderr) &&
	      /dashboard workspace already open/.test(upAgain.stdout + upAgain.stderr) &&
	      sendsAfterReuse.length === 1 &&
	      browserAfterReuse.length === 1 &&
	      fakeState.serverPids[0] === firstServerPid
	    );
	    if (!reuseOk) console.log("INFO\tPhase5c in-pane reuse debug " + JSON.stringify({
	      status: upAgain.status,
	      stdout: (upAgain.stdout || "").slice(0, 200),
	      stderr: (upAgain.stderr || "").slice(0, 200),
	      sendsAfterReuse: sendsAfterReuse.length,
	      browserAfterReuse: browserAfterReuse.length,
	      firstServerPid,
	      serverPids: fakeState.serverPids,
	    }));
	    check("cmux-dash reuses existing __server__ workspace and does not double-start", reuseOk);
	    const restart = await runCommand("/bin/bash", [path.join(repo, "cmux-dash"), "restart"], { cwd: repo, env: upEnv }, 12000);
	    const restartStateResp = await request(upPort, "/api/state").catch(() => null);
	    logs = readFakeLog();
	    const sendsAfterRestart = logs.filter((item) => item.event === "send" && /server\.js/.test(item.text || ""));
	    const restartOk = (
	      restart.status === 0 &&
	      sendsAfterRestart.length === 2 &&
	      restartStateResp && restartStateResp.status === 200 &&
	      /health\.cmux ok/.test(restart.stdout + restart.stderr)
	    );
	    if (!restartOk) console.log("INFO\tPhase5c in-pane restart debug " + JSON.stringify({
	      status: restart.status,
	      stdout: (restart.stdout || "").slice(0, 240),
	      stderr: (restart.stderr || "").slice(0, 240),
	      sendsAfterRestart: sendsAfterRestart.length,
	      restartRespStatus: restartStateResp && restartStateResp.status,
	    }));
	    check("cmux-dash restart restarts through cmux pane and health-checks state", restartOk);
	    await runCommand("/bin/bash", [path.join(repo, "cmux-dash"), "stop"], { cwd: repo, env: upEnv }, 5000);

	    fs.writeFileSync(fakeCmuxState, JSON.stringify({ workspaces: [], panes: [], surfaces: [], serverPids: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 }) + "\n");
	    fs.writeFileSync(fakeCmuxLog, "");
	    const failPort = await findFreePort(upPort + 10);
	    const failServerLog = path.join(phaseDir, "in-pane-start-failure.log");
	    const failEnv = {
	      ...upEnv,
	      CMUX_DASH_PORT: String(failPort),
	      CMUX_DASH_SERVER_LOG: failServerLog,
	      CMUX_DASH_SERVER_PIDFILE: path.join(phaseDir, "in-pane-start-failure.pid"),
	      CMUX_DASH_SERVER_REACHABLE_TIMEOUT_MS: "500",
	      CMUX_DASH_SERVER_REACHABLE_INTERVAL_MS: "100",
	      CMUX_DASH_SERVER_SURFACE_READY_DELAY_MS: "20",
	      FAKE_CMUX_SERVER_NO_START: "1",
	      FAKE_CMUX_SERVER_START_DELAY_MS: "0",
	      FAKE_CMUX_SURFACE_READY_DELAY_MS: "0",
	    };
	    const failedUp = await runCommand("/bin/bash", [path.join(repo, "cmux-dash"), "up"], { cwd: repo, env: failEnv }, 4000);
	    const failedOutput = failedUp.stdout + failedUp.stderr;
	    const failedDiagnosticOk = (
	      failedUp.status !== 0 &&
	      /server failed to become reachable/.test(failedOutput) &&
	      /startup diagnostics/.test(failedOutput) &&
	      /workspace=workspace:/.test(failedOutput) &&
	      /surface=surface:/.test(failedOutput) &&
	      failedOutput.includes(failServerLog)
	    );
	    if (!failedDiagnosticOk) console.log("INFO\tPhase5c failed-start diagnostics debug " + JSON.stringify({
	      status: failedUp.status,
	      stdout: (failedUp.stdout || "").slice(0, 500),
	      stderr: (failedUp.stderr || "").slice(0, 1200),
	      expectedLog: failServerLog,
	    }));
	    check("cmux-dash failed in-pane start prints workspace/surface diagnostics", failedDiagnosticOk);

	    const stickyPort = await findFreePort(failPort + 1);
	    const stickyPidFile = path.join(phaseDir, "sticky-listener.pid");
	    const sticky = await startStickyListener(stickyPort, stickyPidFile, 800);
	    const stickyStartedAt = Date.now();
	    const stickyStop = await runCommand("/bin/bash", [path.join(repo, "cmux-dash"), "stop"], {
	      cwd: repo,
	      env: {
	        ...process.env,
	        NODE_BIN: nodeBin,
	        CMUX_DASH_PORT: String(stickyPort),
	        CMUX_DASH_HOST: host,
	        CMUX_DASH_SERVER_PIDFILE: stickyPidFile,
	        CMUX_DASH_START_WATCHDOG: "0",
	        CMUX_DASH_SERVER_PORT_RELEASE_TIMEOUT_MS: "3000",
	        CMUX_DASH_SERVER_PORT_RELEASE_INTERVAL_MS: "100",
	      },
	    }, 5000);
	    const stickyElapsed = Date.now() - stickyStartedAt;
	    await waitForExit(sticky, 2000);
	    check("cmux-dash stop waits for TCP LISTEN release after /api/state drops", (
	      stickyStop.status === 0 &&
	      stickyElapsed >= 650 &&
	      await canListen(stickyPort)
	    ));
	
	    const stopPidFile = path.join(phaseDir, "stop-watchdog.pid");
	    const sleeper = spawn("/bin/sh", ["-c", "sleep 60"], { stdio: "ignore" });
	    children.push(sleeper);
	    fs.writeFileSync(stopPidFile, String(sleeper.pid));
	    const stopPort = await findFreePort(upPort + 1);
	    const stop = await runCommand("/bin/bash", [path.join(repo, "cmux-dash"), "stop"], {
	      cwd: repo,
	      env: {
	        ...process.env,
	        CMUX_DASH_PORT: String(stopPort),
	        CMUX_DASH_HOST: host,
	        CMUX_DASH_WATCHDOG_PIDFILE: stopPidFile,
	        CMUX_DASH_SERVER_PIDFILE: path.join(phaseDir, "stop-server.pid"),
	        CMUX_DASH_SERVER_LOG: path.join(phaseDir, "stop-server.log"),
	      },
	    }, 5000);
	    const stopped = await waitForExit(sleeper, 1500);
	    check("cmux-dash stop stops the in-session watchdog", (
	      stop.status === 0 &&
	      !!stopped &&
	      !fs.existsSync(stopPidFile) &&
	      /stopped watchdog/.test(stop.stdout + stop.stderr) &&
	      /no running server/.test(stop.stdout + stop.stderr)
	    ));
	
	    const fakeLaunchctlLog = path.join(phaseDir, "launchctl.log");
	    const fakeLaunchctl = path.join(phaseDir, "launchctl");
	    writeExecutable(fakeLaunchctl, [
	      "#!/usr/bin/env bash",
	      "printf '%s\\n' \"$*\" >> " + shDoubleQuote(fakeLaunchctlLog),
	      "exit 0",
	    ].join("\n") + "\n");
	    const label = "com.cmux-dashboard.server.test." + process.pid;
	    const plistPath = path.join(phaseDir, label + ".plist");
	    const launchEnv = {
	      ...process.env,
	      HOME: path.join(phaseDir, "home"),
	      NODE_BIN: nodeBin,
	      CMUX_DASH_PORT: String(stopPort),
	      CMUX_DASH_HOST: host,
	      CMUX_DASH_SERVER_LABEL: label,
	      CMUX_DASH_SERVER_PLIST_PATH: plistPath,
	      CMUX_DASH_LAUNCHCTL_BIN: fakeLaunchctl,
	    };
	    const install = spawnSync("/bin/bash", [path.join(repo, "cmux-dash"), "install-server"], {
	      cwd: repo,
	      env: launchEnv,
	      encoding: "utf8",
	    });
	    const launchLogAfterInstall = fs.existsSync(fakeLaunchctlLog) ? fs.readFileSync(fakeLaunchctlLog, "utf8") : "";
	    check("install-server is disabled for launchd-managed dashboard servers", (
	      install.status !== 0 &&
	      /install-server is disabled/.test(install.stderr) &&
	      /session context/.test(install.stderr) &&
	      !fs.existsSync(plistPath)
	    ));
	    check("install-server does not write plist or call launchctl", !fs.existsSync(plistPath) && launchLogAfterInstall === "");
	
	    fs.writeFileSync(plistPath, "legacy plist");
	    const uninstall = spawnSync("/bin/bash", [path.join(repo, "cmux-dash"), "uninstall-server"], {
	      cwd: repo,
	      env: launchEnv,
	      encoding: "utf8",
	    });
	    const launchLogAfterUninstall = fs.existsSync(fakeLaunchctlLog) ? fs.readFileSync(fakeLaunchctlLog, "utf8") : "";
	    check("uninstall-server remains as legacy launchd cleanup", uninstall.status === 0 && !fs.existsSync(plistPath) && /bootout /.test(launchLogAfterUninstall));
	  } catch (err) {
	    failed += 1;
	    console.log("FAIL\tPhase5c runner exception: " + (err && err.message ? err.message : err));
  } finally {
    for (const child of children) {
	      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child, 1000);
      }
    }
    for (const server of servers) {
      try { server.close(); } catch (_) {}
    }
  }
  process.exit(failed ? 1 : 0);
})();
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
	      PASS) pass "Phase5c: $label" ;;
	      FAIL) fail "Phase5c: $label" ;;
	      *) info "Phase5c output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "Phase5c runner produced no output"
  fi
  return "$rc"
}

if ! run_phase5c_checks; then
  finish
fi

create_integration_fake_cmux() {
  local fake_dir="$TEST_TMP_DIR/integration-fake-cmux"
  local fake_cmux="$fake_dir/cmux"
  local state="$fake_dir/state.json"
  mkdir -p "$fake_dir"
  printf '{"workspaces":[],"panes":[],"surfaces":[],"nextWorkspace":1,"nextPane":1,"nextSurface":1}\n' >"$state"
  cat >"$fake_cmux" <<SH
#!/usr/bin/env bash
STATE="$state"
NODE_BIN="$NODE_BIN"
cmd="\${1:-}"
shift || true
case "\$cmd" in
  ping)
    printf 'pong\n'
    ;;
  list-workspaces)
    "\$NODE_BIN" - "\$STATE" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
let s = { workspaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
process.stdout.write(JSON.stringify({ workspaces: Array.isArray(s.workspaces) ? s.workspaces : [] }) + "\n");
NODE
    ;;
  new-workspace)
    desc=""
    name=""
    cwd=""
    command=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --description) desc="\${2:-}"; shift 2 ;;
        --name) name="\${2:-}"; shift 2 ;;
        --cwd) cwd="\${2:-}"; shift 2 ;;
        --command) command="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "\$desc" ] || desc="cmuxdash:unknown"
    "\$NODE_BIN" - "\$STATE" "\$desc" "\$name" "\$cwd" "\$command" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const desc = process.argv[3] || "cmuxdash:unknown";
const name = process.argv[4] || "";
const cwd = process.argv[5] || "";
const command = process.argv[6] || "";
let s = { workspaces: [], panes: [], surfaces: [], nextWorkspace: 1, nextPane: 1, nextSurface: 1 };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.workspaces = Array.isArray(s.workspaces) ? s.workspaces : [];
s.panes = Array.isArray(s.panes) ? s.panes : [];
s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
const wsRef = "workspace:" + (s.nextWorkspace || 1);
const paneRef = "pane:" + (s.nextPane || 1);
const surfaceRef = "surface:" + (s.nextSurface || 1);
s.nextWorkspace = (s.nextWorkspace || 1) + 1;
s.nextPane = (s.nextPane || 1) + 1;
s.nextSurface = (s.nextSurface || 1) + 1;
s.workspaces.forEach((w) => { if (w) w.selected = false; });
s.workspaces.push({ ref: wsRef, description: desc, name, cwd, selected: true, latest_conversation_message: null, latest_submitted_at: null });
s.panes.push({ ref: paneRef, workspace: wsRef, index: 0 });
const hasTermMarker = command.includes("cmuxdash:slot:term");
const title = hasTermMarker ? "cmuxdash:slot:term" : "claude";
const processName = hasTermMarker ? "zsh" : "claude";
s.surfaces.push({ ref: surfaceRef, workspace: wsRef, pane: paneRef, title, type: "terminal", process: processName });
fs.writeFileSync(file, JSON.stringify(s) + "\n");
process.stdout.write(wsRef + "\n");
NODE
    ;;
  close-workspace)
    workspace=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
let s = { workspaces: [], panes: [], surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.workspaces = (s.workspaces || []).filter((w) => w && w.ref !== workspace);
s.panes = (s.panes || []).filter((p) => p && p.workspace !== workspace);
s.surfaces = (s.surfaces || []).filter((x) => x && x.workspace !== workspace);
fs.writeFileSync(file, JSON.stringify(s) + "\n");
NODE
    ;;
  select-workspace)
    workspace=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
let s = { workspaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
(s.workspaces || []).forEach((w) => { if (w) w.selected = w.ref === workspace; });
fs.writeFileSync(file, JSON.stringify(s) + "\n");
NODE
    ;;
  list-panes)
    workspace=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
let s = { panes: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
const panes = (s.panes || []).filter((p) => !workspace || p.workspace === workspace);
process.stdout.write(JSON.stringify({ panes }) + "\n");
NODE
    ;;
  list-pane-surfaces)
    workspace=""
    pane=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --pane) pane="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$pane" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
const pane = process.argv[4] || "";
let s = { surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
const surfaces = (s.surfaces || [])
  .filter((x) => (!workspace || x.workspace === workspace) && (!pane || x.pane === pane))
  .map((x) => ({ ref: x.ref, title: x.title, type: x.type, paneRef: x.pane }));
process.stdout.write(JSON.stringify({ surfaces }) + "\n");
NODE
    ;;
  new-pane)
    workspace=""
    direction=""
    type="terminal"
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --direction) direction="\${2:-}"; shift 2 ;;
        --type) type="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$direction" "\$type" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
const direction = process.argv[4] || "";
const type = process.argv[5] || "terminal";
let s = { panes: [], surfaces: [], nextPane: 1, nextSurface: 1 };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.panes = Array.isArray(s.panes) ? s.panes : [];
s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
const paneRef = "pane:" + (s.nextPane || 1);
const surfaceRef = "surface:" + (s.nextSurface || 1);
s.nextPane = (s.nextPane || 1) + 1;
s.nextSurface = (s.nextSurface || 1) + 1;
s.panes.push({ ref: paneRef, workspace, index: s.panes.filter((p) => !workspace || p.workspace === workspace).length, direction });
s.surfaces.push({ ref: surfaceRef, workspace, pane: paneRef, title: "terminal", type, process: "zsh" });
fs.writeFileSync(file, JSON.stringify(s) + "\n");
process.stdout.write(surfaceRef + "\n");
NODE
    ;;
  new-surface)
    workspace=""
    pane=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --pane) pane="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$pane" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
let pane = process.argv[4] || "";
let s = { panes: [], surfaces: [], nextSurface: 1 };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
s.panes = Array.isArray(s.panes) ? s.panes : [];
s.surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
if (!pane) {
  const p = s.panes.find((x) => x && (!workspace || x.workspace === workspace));
  pane = p && p.ref || "pane:1";
}
const surfaceRef = "surface:" + (s.nextSurface || 1);
s.nextSurface = (s.nextSurface || 1) + 1;
s.surfaces.push({ ref: surfaceRef, workspace, pane, title: "terminal", type: "terminal", process: "zsh" });
fs.writeFileSync(file, JSON.stringify(s) + "\n");
process.stdout.write(surfaceRef + "\n");
NODE
    ;;
  close-surface)
    workspace=""
    surface=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --workspace) workspace="\${2:-}"; shift 2 ;;
        --surface) surface="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$workspace" "\$surface" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const workspace = process.argv[3] || "";
const surface = process.argv[4] || "";
let s = { panes: [], surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
if (surface.startsWith("pane:")) {
  s.panes = (s.panes || []).filter((p) => !(p && p.ref === surface && (!workspace || p.workspace === workspace)));
  s.surfaces = (s.surfaces || []).filter((x) => !(x && x.pane === surface && (!workspace || x.workspace === workspace)));
  fs.writeFileSync(file, JSON.stringify(s) + "\n");
  process.exit(0);
}
const removed = (s.surfaces || []).filter((x) => x && x.ref === surface && (!workspace || x.workspace === workspace));
s.surfaces = (s.surfaces || []).filter((x) => !(x && x.ref === surface && (!workspace || x.workspace === workspace)));
const removedPanes = new Set(removed.map((x) => x && x.pane).filter(Boolean));
s.panes = (s.panes || []).filter((pane) => {
  if (!pane || !removedPanes.has(pane.ref)) return true;
  return s.surfaces.some((x) => x && x.pane === pane.ref);
});
fs.writeFileSync(file, JSON.stringify(s) + "\n");
NODE
    ;;
  top)
    "\$NODE_BIN" - "\$STATE" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
let s = { surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
let idx = 1;
for (const surface of (s.surfaces || [])) {
  process.stdout.write("0\t0\t1\tprocess\tprocess:" + (idx++) + "\t" + surface.ref + "\t" + (surface.process || "zsh") + "\n");
}
NODE
    ;;
  send)
    surface=""
    text=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --surface) surface="\${2:-}"; shift 2 ;;
        --workspace) shift 2 ;;
        --) shift; text="\$*"; break ;;
        *) text="\$1"; shift ;;
      esac
    done
    "\$NODE_BIN" - "\$STATE" "\$surface" "\$text" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const surface = process.argv[3] || "";
const text = process.argv[4] || "";
let s = { surfaces: [] };
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
const match = text.match(/cmuxdash:slot:(cc|cdx|yazi|term)/);
const slot = match && match[1];
const processBySlot = { cc: "claude", cdx: "codex", yazi: "yazi", term: "zsh" };
for (const item of (s.surfaces || [])) {
  if (item && item.ref === surface && slot) {
    item.title = "cmuxdash:slot:" + slot;
    item.process = processBySlot[slot] || "zsh";
  }
}
fs.writeFileSync(file, JSON.stringify(s) + "\n");
NODE
    ;;
  *)
    printf '{}\n'
    ;;
esac
SH
  chmod +x "$fake_cmux"
  printf '%s\n' "$fake_cmux"
}

if [ -z "${CMUX_WORKSPACE_ID:-}" ]; then
  info "not running as a child of a live cmux pane; using isolated fake cmux for integration checks"
  CMUX_BIN="$(create_integration_fake_cmux)"
elif [ "$REAL_CMUX_AVAILABLE" -ne 1 ]; then
  info "real cmux list-workspaces failed; using isolated fake cmux for integration checks"
  CMUX_BIN="$(create_integration_fake_cmux)"
fi

if ! "$NODE_BIN" - "$PROJECT_ID" "$TEST_PROJECTS_FILE" "$TEST_PROJECT_DIR" <<'NODE'
const fs = require("fs");
const projectId = process.argv[2];
const target = process.argv[3];
const projectDir = process.argv[4];
const out = {
  _comment: "cmux-dashboard test config generated by test.sh",
  defaults: {
    topCmd: "claude --enable-auto-mode",
    bottomCmd: "codex",
    slotCommands: {
      cc: "claude --enable-auto-mode",
      cdx: "codex",
      yazi: "yazi",
      term: "",
    },
    agmsg: {
      enabled: true,
      claudeName: "claude",
      codexName: "codex",
      claudeMode: "monitor",
      codexMode: "turn",
      brief: false,
    },
    claudeMd: {
      mode: "managed-block",
      templatePath: "templates/CLAUDE.md",
    },
    collab: false,
    briefing: "Integration test fixture generated by test.sh.",
  },
  projects: [{
    id: projectId,
    name: "Demo",
    path: projectDir,
    color: "#6ee7b7",
    emoji: "D",
  }],
};
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
NODE
then
  fail "failed to create isolated test projects file for $PROJECT_ID"
  finish
fi

PROJECT_META="$("$NODE_BIN" - "$TEST_PROJECTS_FILE" "$PROJECT_ID" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const path = process.argv[2];
const projectId = process.argv[3];
function teamName(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, "-"); }
const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
const defaults = cfg.defaults || {};
const defaultAg = Object.assign({
  enabled: true,
  claudeName: "claude",
  codexName: "codex",
}, defaults.agmsg || {});
const project = (cfg.projects || []).find((p) => p && p.id === projectId);
if (!project) process.exit(1);
const ag = Object.assign({}, defaultAg, project.agmsg || {});
process.stdout.write(JSON.stringify({
  team: teamName(project.id),
  claudeName: ag.claudeName || "claude",
  codexName: ag.codexName || "codex",
}));
NODE
)"
if [ -z "$PROJECT_META" ]; then
  fail "project metadata not found in projects.json for $PROJECT_ID"
  finish
fi
TEAM_NAME="$(printf '%s' "$PROJECT_META" | "$NODE_BIN" -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).team)')"
CLAUDE_AGENT="$(printf '%s' "$PROJECT_META" | "$NODE_BIN" -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).claudeName)')"
CODEX_AGENT="$(printf '%s' "$PROJECT_META" | "$NODE_BIN" -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).codexName)')"

server_healthy() {
  curl -fsS --max-time 5 "$URL/api/state" >/dev/null 2>&1
}

json_field_ok() {
  local expr="$1"
  "$NODE_BIN" -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
let obj;
try { obj = JSON.parse(input); } catch (_) { process.exit(2); }
const expr = process.argv[1];
const projectId = process.argv[2];
if (expr === "queued") process.exit(obj && obj.queued === true ? 0 : 1);
if (expr === "state") {
  const projects = Array.isArray(obj.projects) ? obj.projects : [];
  process.exit(projects.some((p) => p && p.id === projectId) ? 0 : 1);
}
process.exit(1);
' "$expr" "$PROJECT_ID"
}

cmux_list_json() {
  local attempt=1
  local delay=1
  local out
  while [ "$attempt" -le 8 ]; do
    out="$(CMUX_QUIET=1 "$CMUX_BIN" list-workspaces --json 2>&1)" && {
      printf '%s' "$out"
      return 0
    }
    if ! printf '%s' "$out" | grep -Eiq 'broken pipe|EPIPE|errno 32|socket|ECONNRESET|ETIMEDOUT|timeout|timed out'; then
      printf '%s\n' "$out" >&2
      return 1
    fi
    sleep "$delay"
    attempt=$((attempt + 1))
    [ "$delay" -lt 4 ] && delay=$((delay * 2))
  done
  printf '%s\n' "$out" >&2
  return 1
}

workspace_has_tag() {
  local out
  out="$(cmux_list_json)" || return 2
  printf '%s' "$out" | "$NODE_BIN" -e '
const fs = require("fs");
const tag = process.argv[1];
const input = fs.readFileSync(0, "utf8");
const start = input.indexOf("{");
if (start < 0) process.exit(3);
let obj;
try { obj = JSON.parse(input.slice(start)); } catch (_) { process.exit(3); }
const workspaces = Array.isArray(obj.workspaces) ? obj.workspaces : [];
process.exit(workspaces.some((w) => w && w.description === tag) ? 0 : 1);
' "$TAG"
}

workspace_status() {
  local attempts=0
  local rc=0
  while [ "$attempts" -lt 5 ]; do
    workspace_has_tag
    rc=$?
    case "$rc" in
      0) printf 'present\n'; return 0 ;;
      1) printf 'absent\n'; return 0 ;;
    esac
    attempts=$((attempts + 1))
    sleep 0.5
  done
  printf 'error\n'
  return 1
}

workspace_ref_by_tag() {
  local out
  out="$(cmux_list_json)" || return 2
  printf '%s' "$out" | "$NODE_BIN" -e '
const fs = require("fs");
const tag = process.argv[1];
const input = fs.readFileSync(0, "utf8");
const start = input.indexOf("{");
if (start < 0) process.exit(3);
let obj;
try { obj = JSON.parse(input.slice(start)); } catch (_) { process.exit(3); }
const matches = (Array.isArray(obj.workspaces) ? obj.workspaces : []).filter((w) => w && w.description === tag);
if (matches.length !== 1 || !matches[0].ref) process.exit(matches.length === 0 ? 1 : 4);
process.stdout.write(matches[0].ref);
' "$TAG"
}

wait_for_workspace() {
  local want="$1"
  local timeout="${2:-60}"
  local elapsed=0
  local status
  while [ "$elapsed" -lt "$timeout" ]; do
    status="$(workspace_status || true)"
    [ "$status" = "$want" ] && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

pane_refs_for_workspace() {
  local workspace_ref="$1"
  CMUX_QUIET=1 "$CMUX_BIN" list-panes --workspace "$workspace_ref" --json 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const panes = Array.isArray(obj.panes) ? obj.panes.slice() : [];
panes.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
if (panes.length !== 2 || !panes[0].ref || !panes[1].ref) process.exit(1);
process.stdout.write(`${panes[0].ref}\t${panes[1].ref}`);
'
}

pane_title_for_pane() {
  local workspace_ref="$1"
  local pane_ref="$2"
  CMUX_QUIET=1 "$CMUX_BIN" list-pane-surfaces --workspace "$workspace_ref" --pane "$pane_ref" --json 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const surfaces = Array.isArray(obj.surfaces) ? obj.surfaces : [];
if (surfaces.length < 1) process.exit(1);
process.stdout.write(String(surfaces[0].title || ""));
'
}

pane_surface_ref_for_pane() {
  local workspace_ref="$1"
  local pane_ref="$2"
  CMUX_QUIET=1 "$CMUX_BIN" list-pane-surfaces --workspace "$workspace_ref" --pane "$pane_ref" --json 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const surfaces = Array.isArray(obj.surfaces) ? obj.surfaces : [];
if (surfaces.length < 1 || !surfaces[0].ref) process.exit(1);
process.stdout.write(String(surfaces[0].ref));
'
}

surface_count_for_workspace() {
  local workspace_ref="$1"
  local pane_refs
  local total=0
  local count
  local pane_ref
  pane_refs="$(CMUX_QUIET=1 "$CMUX_BIN" list-panes --workspace "$workspace_ref" --json 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const panes = Array.isArray(obj.panes) ? obj.panes : [];
process.stdout.write(panes.map((pane) => pane && pane.ref).filter(Boolean).join("\n"));
' 2>/dev/null)" || return 2
  if [ -z "$pane_refs" ]; then
    CMUX_QUIET=1 "$CMUX_BIN" list-pane-surfaces --workspace "$workspace_ref" --json 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const surfaces = Array.isArray(obj.surfaces) ? obj.surfaces : [];
process.stdout.write(String(surfaces.length));
'
    return $?
  fi
  while IFS= read -r pane_ref; do
    [ -n "$pane_ref" ] || continue
    count="$(CMUX_QUIET=1 "$CMUX_BIN" list-pane-surfaces --workspace "$workspace_ref" --pane "$pane_ref" --json 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const surfaces = Array.isArray(obj.surfaces) ? obj.surfaces : [];
process.stdout.write(String(surfaces.length));
' 2>/dev/null)" || return 2
    total=$((total + count))
  done <<EOF
$pane_refs
EOF
  printf '%s' "$total"
}

pane_count_for_workspace() {
  local workspace_ref="$1"
  CMUX_QUIET=1 "$CMUX_BIN" list-panes --workspace "$workspace_ref" --json 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const panes = Array.isArray(obj.panes) ? obj.panes : [];
process.stdout.write(String(panes.length));
'
}

surface_has_process() {
  local workspace_ref="$1"
  local surface_ref="$2"
  local pattern="$3"
  CMUX_QUIET=1 "$CMUX_BIN" top --workspace "$workspace_ref" --processes --format tsv 2>/dev/null \
    | awk -v surface="$surface_ref" -v pat="$pattern" '
      $4 == "process" && $6 == surface && tolower($7) ~ pat { found=1 }
      END { exit found ? 0 : 1 }
    '
}

assert_open_workspace_details() {
  local workspace_ref
  local surface_count
  local api_check
  local ctl_check

  workspace_ref="$(workspace_ref_by_tag 2>/dev/null || true)"
  if [ -z "$workspace_ref" ]; then
    fail "expected exactly one $TAG workspace after open"
    return 1
  fi
  pass "exactly one tagged workspace exists: $TAG ($workspace_ref)"

  surface_count="$(surface_count_for_workspace "$workspace_ref" 2>/dev/null || true)"
  if [ -n "$surface_count" ] && [ "$surface_count" -ge 1 ]; then
    pass "workspace $workspace_ref exposes slot-capable surfaces"
  else
    fail "workspace $workspace_ref does not expose any surfaces"
    return 1
  fi

  api_check="$(curl -fsS --max-time 10 "$URL/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
const projectId = process.argv[1];
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const p = (Array.isArray(obj.projects) ? obj.projects : []).find((x) => x && x.id === projectId);
if (!p || !p.open || !p.wsRef) process.exit(3);
for (const slot of ["cc", "cdx", "yazi", "term"]) {
  if (!p.slots || typeof p.slots[slot] !== "boolean") process.exit(4);
}
process.stdout.write("ok");
' "$PROJECT_ID" 2>/dev/null || true)"
  if [ "$api_check" = "ok" ]; then
    pass "GET /api/state exposes R1 slot contract for $PROJECT_ID"
  else
    fail "GET /api/state is missing R1 slot contract for $PROJECT_ID"
    return 1
  fi

  ctl_check="$(CMUX_BIN="$CMUX_BIN" CMUX_DASH_PROJECTS_FILE="$TEST_PROJECTS_FILE" "$NODE_BIN" - "$DIR" "$PROJECT_ID" <<'NODE' 2>/dev/null || true
const path = require("path");
const repo = process.argv[2];
const projectId = process.argv[3];
const ctl = require(path.join(repo, "cmuxctl.js"));
(async () => {
  const st = await ctl.getProjectState(projectId);
  const ok = st && st.open && st.wsRef && st.slots && ["cc", "cdx", "yazi", "term"].every((slot) => typeof st.slots[slot] === "boolean");
  process.stdout.write(ok ? "ok" : "bad");
})().catch(() => process.stdout.write("bad"));
NODE
)"
  if [ "$ctl_check" = "ok" ]; then
    pass "cmuxctl.getProjectState returns R1 slot state"
  else
    fail "cmuxctl.getProjectState did not return valid R1 slot state"
    return 1
  fi
}

assert_agmsg_team_members() {
  local team_script="$HOME/.agents/skills/agmsg/scripts/team.sh"
  local out
  if [ ! -x "$team_script" ]; then
    fail "agmsg team script missing: $team_script"
    return 1
  fi
  out="$("$team_script" "$TEAM_NAME" 2>/dev/null || true)"
  if printf '%s\n' "$out" | grep -F "$CLAUDE_AGENT (claude-code)" >/dev/null \
    && printf '%s\n' "$out" | grep -F "$CODEX_AGENT (codex)" >/dev/null; then
    pass "agmsg team $TEAM_NAME contains $CLAUDE_AGENT and $CODEX_AGENT"
    return 0
  fi
  fail "agmsg team $TEAM_NAME is missing $CLAUDE_AGENT/$CODEX_AGENT membership"
  info "agmsg team output: $(printf '%s' "$out" | tr '\n' ';')"
  return 1
}

api_project_status() {
  curl -fsS --max-time 30 "$URL/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
const projectId = process.argv[1];
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const projects = Array.isArray(obj.projects) ? obj.projects : [];
const project = projects.find((p) => p && p.id === projectId);
if (!project) process.exit(3);
process.stdout.write(project.open ? "present" : "absent");
' "$PROJECT_ID" 2>/dev/null
}

wait_for_api_project() {
  local want="$1"
  local timeout="${2:-60}"
  local elapsed=0
  local status
  while [ "$elapsed" -lt "$timeout" ]; do
    status="$(api_project_status || true)"
    [ "$status" = "$want" ] && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

state_last_error() {
  curl -fsS --max-time 5 "$URL/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj = {};
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) {}
if (obj.lastError) process.stdout.write(String(obj.lastError));
' 2>/dev/null
}

create_phase3_fake_cmux() {
  local mode="$1"
  local fake_dir="$TEST_TMP_DIR/phase3-fake-cmux-$mode"
  local fake_cmux="$fake_dir/cmux"
  mkdir -p "$fake_dir"
  cat >"$fake_cmux" <<SH
#!/usr/bin/env bash
cmd="\${1:-}"
case "\$cmd" in
  ping)
    if [ "$mode" = "fail" ]; then
      printf 'simulated cmux ping failure\n' >&2
      exit 17
    fi
    printf 'pong\n'
    ;;
  list-workspaces)
    printf '{"workspaces":[]}\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac
SH
  chmod +x "$fake_cmux"
  printf '%s\n' "$fake_cmux"
}

phase3_fetch_doctor_server() {
  local port="$1"
  local cmux_bin="$2"
  local claude_candidates="$3"
  local codex_candidates="$4"
  local log="$5"
  local body=""
  local temp_url="http://${HOST}:${port}"

  (cd "$DIR" && exec env \
    CMUX_BIN="$cmux_bin" \
    CMUX_DASH_PORT="$port" \
    CMUX_DASH_HOST="$HOST" \
    CMUX_DASH_PROJECTS_FILE="$TEST_PROJECTS_FILE" \
    CMUX_DASH_DOCTOR_TIMEOUT=800 \
    CMUX_DASH_DOCTOR_RETRY_BUDGET_MS=800 \
    CMUX_DASH_DOCTOR_RETRIES=0 \
    CMUX_DASH_DOCTOR_CLAUDE_CANDIDATES="$claude_candidates" \
    CMUX_DASH_DOCTOR_CODEX_CANDIDATES="$codex_candidates" \
    "$NODE_BIN" server.js >"$log" 2>&1) &
  BAD_SERVER_PID=$!
  for _ in $(seq 1 50); do
    body="$(curl -fsS --max-time 2 "$temp_url/api/doctor" 2>/dev/null || true)"
    [ -n "$body" ] && break
    sleep 0.2
  done
  kill "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  wait "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  BAD_SERVER_PID=""
  printf '%s' "$body"
}

run_phase3_checks() {
  local body
  local fake_ok
  local fake_fail
  local missing_body
  local ping_fail_body
  local ui_check
  local missing_claude="$TEST_TMP_DIR/no-such-claude"
  local missing_codex="$TEST_TMP_DIR/no-such-codex"
  local missing_log="$TEST_TMP_DIR/phase3-missing-bin.log"
  local ping_fail_log="$TEST_TMP_DIR/phase3-ping-fail.log"

  body="$(curl -fsS --max-time 10 "$URL/api/doctor" 2>/dev/null || true)"
  if printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const checks = Array.isArray(obj.checks) ? obj.checks : [];
const required = ["node", "cmux", "agmsg", "claude", "codex", "app"];
const byName = new Map(checks.map((c) => [c && c.name, c]));
if (typeof obj.allOk !== "boolean") process.exit(3);
for (const name of required) {
  const c = byName.get(name);
  if (!c || typeof c.ok !== "boolean" || typeof c.detail !== "string" || !Object.prototype.hasOwnProperty.call(c, "fixHint")) process.exit(4);
}
if (byName.get("node").ok !== true || !/^v/.test(byName.get("node").detail)) process.exit(5);
if (obj.allOk !== checks.every((c) => c && c.ok === true)) process.exit(6);
' 2>/dev/null; then
    pass "Phase3: GET /api/doctor returns checks/allOk contract with node ok"
  else
    fail "Phase3: GET /api/doctor contract failed"
    info "Phase3 doctor payload: ${body:-empty}"
    return 1
  fi

  fake_ok="$(create_phase3_fake_cmux ok)"
  missing_body="$(phase3_fetch_doctor_server "$((PORT + 2100))" "$fake_ok" "$missing_claude" "$missing_codex" "$missing_log")"
  if printf '%s' "$missing_body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const checks = Array.isArray(obj.checks) ? obj.checks : [];
const byName = new Map(checks.map((c) => [c && c.name, c]));
for (const name of ["claude", "codex"]) {
  const c = byName.get(name);
  if (!c || c.ok !== false || typeof c.fixHint !== "string" || c.fixHint.length < 3 || !/not found/i.test(c.detail)) process.exit(3);
}
' 2>/dev/null; then
    pass "Phase3: doctor reports missing claude/codex bins without 5xx"
  else
    fail "Phase3: missing claude/codex simulation failed"
    info "Phase3 missing-bin payload: ${missing_body:-empty}; log=$missing_log"
    return 1
  fi

  fake_fail="$(create_phase3_fake_cmux fail)"
  ping_fail_body="$(phase3_fetch_doctor_server "$((PORT + 2200))" "$fake_fail" "$fake_ok" "$fake_ok" "$ping_fail_log")"
  if printf '%s' "$ping_fail_body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const cmux = (Array.isArray(obj.checks) ? obj.checks : []).find((c) => c && c.name === "cmux");
if (!cmux || cmux.ok !== false || typeof cmux.detail !== "string" || cmux.detail.length === 0 || !cmux.fixHint) process.exit(3);
' 2>/dev/null; then
    pass "Phase3: cmux ping failure returns cmux ok:false without 5xx"
  else
    fail "Phase3: cmux ping failure contract failed"
    info "Phase3 ping-fail payload: ${ping_fail_body:-empty}; log=$ping_fail_log"
    return 1
  fi

  ui_check="$("$NODE_BIN" - "$DIR/public/index.html" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const html = fs.readFileSync(process.argv[2], "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) process.exit(2);
const script = scriptMatch[1];
const checks = [
  html.includes('id="onboarding"'),
  html.includes('onclick="openOnboarding(true)"'),
  script.includes('stateRows(s).length===0'),
  script.includes("jget('/api/doctor')"),
  script.includes('function renderDoctorChecks()'),
  script.includes('function onboardAddProject()'),
  script.includes("jpost('/api/projects'"),
  script.includes('copyFrom(this)'),
  script.includes('setOnboardingStep(3)'),
];
process.stdout.write(checks.every(Boolean) ? "ok" : "bad");
NODE
)"
  if [ "$ui_check" = "ok" ]; then
    pass "Phase3: UI onboarding static contract is present"
  else
    fail "Phase3: UI onboarding static contract failed"
    return 1
  fi
}

post_action() {
  local action="$1"
  curl -fsS -X POST --max-time 10 "$URL/api/${action}/${PROJECT_ID}" 2>/dev/null || true
}

post_api() {
  local path="$1"
  curl -fsS -X POST --max-time 10 "$URL$path" 2>/dev/null || true
}

post_api_json() {
  local path="$1"
  local body="$2"
  curl -fsS -X POST --max-time 10 -H 'Content-Type: application/json' --data "$body" "$URL$path" 2>/dev/null || true
}

agmsg_test_db_path() {
  local storage_lib="$HOME/.agents/skills/agmsg/scripts/lib/storage.sh"
  bash -lc 'source "$1"; agmsg_db_path' _ "$storage_lib"
}

run_phase2b_checks() {
  local agmsg_send="$HOME/.agents/skills/agmsg/scripts/send.sh"
  local agmsg_id="cmuxdash-test-$$"
  local agmsg_team="$agmsg_id"
  local msg1="phase2b claude to codex $$"
  local msg2="phase2b codex to claude $$"
  local db
  local before
  local after
  local ids
  local id1
  local id2
  local body
  local long_body
  local bad_port
  local bad_url
  local bad_log
  local bad_body
  local ui_check

  if [ ! -x "$agmsg_send" ]; then
    fail "Phase2b: agmsg send script missing: $agmsg_send"
    return 1
  fi

  mkdir -p "$AGMSG_TEST_STORAGE"
  "$agmsg_send" "$agmsg_team" claude codex "$msg1" >/dev/null
  "$agmsg_send" "$agmsg_team" codex claude "$msg2" >/dev/null

  db="$(agmsg_test_db_path)"
  if [ ! -f "$db" ]; then
    fail "Phase2b: isolated agmsg DB was not created"
    return 1
  fi

  before="$(sqlite3 -json "$db" "SELECT id, read_at FROM messages WHERE team='$agmsg_team' ORDER BY id ASC;" 2>/dev/null || true)"
  ids="$(printf '%s' "$before" | "$NODE_BIN" -e '
const fs = require("fs");
let rows;
try { rows = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
if (!Array.isArray(rows) || rows.length !== 2) process.exit(3);
if (rows.some((r) => r.read_at !== null)) process.exit(4);
process.stdout.write(`${rows[0].id}\t${rows[1].id}`);
' 2>/dev/null || true)"
  if [ -z "$ids" ]; then
    fail "Phase2b: inserted test messages start unread with read_at NULL"
    info "Phase2b read state before API: $before"
    return 1
  fi
  IFS="$(printf '\t')" read -r id1 id2 <<EOF
$ids
EOF
  pass "Phase2b: inserted test messages start unread with read_at NULL"

  body="$(curl -fsS --max-time 10 "$URL/api/agmsg/${agmsg_id}?limit=10" 2>/dev/null || true)"
  if printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
const [team, id1, id2, msg1, msg2] = process.argv.slice(1);
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const m = Array.isArray(obj.messages) ? obj.messages : [];
if (obj.team !== team || m.length !== 2) process.exit(3);
if (m[0].id !== Number(id1) || m[1].id !== Number(id2)) process.exit(4);
if (m[0].from !== "claude" || m[0].to !== "codex" || m[0].body !== msg1) process.exit(5);
if (m[1].from !== "codex" || m[1].to !== "claude" || m[1].body !== msg2) process.exit(6);
if (m[0].truncated !== false || m[1].truncated !== false) process.exit(7);
if (obj.lastId !== Number(id2)) process.exit(8);
' "$agmsg_team" "$id1" "$id2" "$msg1" "$msg2" 2>/dev/null; then
    pass "Phase2b: GET /api/agmsg returns from/to/body in ascending id order"
  else
    fail "Phase2b: GET /api/agmsg returned unexpected payload"
    info "Phase2b API payload: $body"
    return 1
  fi

  after="$(sqlite3 -json "$db" "SELECT id, read_at FROM messages WHERE team='$agmsg_team' AND id IN ($id1,$id2) ORDER BY id ASC;" 2>/dev/null || true)"
  if [ "$before" = "$after" ]; then
    pass "Phase2b: GET /api/agmsg does not consume read_at"
  else
    fail "Phase2b: read_at changed after GET /api/agmsg"
    info "Phase2b read state after API: $after"
    return 1
  fi

  body="$(curl -fsS --max-time 10 "$URL/api/agmsg/${agmsg_id}?limit=1" 2>/dev/null || true)"
  if printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
const id2 = Number(process.argv[1]);
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const m = Array.isArray(obj.messages) ? obj.messages : [];
process.exit(m.length === 1 && m[0].id === id2 && obj.lastId === id2 ? 0 : 1);
' "$id2" 2>/dev/null; then
    pass "Phase2b: limit=1 returns only the latest message"
  else
    fail "Phase2b: limit=1 did not limit results"
    info "Phase2b limit payload: $body"
    return 1
  fi

  body="$(curl -fsS --max-time 10 "$URL/api/agmsg/${agmsg_id}?since=${id1}&limit=10" 2>/dev/null || true)"
  if printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
const id2 = Number(process.argv[1]);
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const m = Array.isArray(obj.messages) ? obj.messages : [];
process.exit(m.length === 1 && m[0].id === id2 && obj.lastId === id2 ? 0 : 1);
' "$id2" 2>/dev/null; then
    pass "Phase2b: since returns only messages after the given id"
  else
    fail "Phase2b: since did not filter results"
    info "Phase2b since payload: $body"
    return 1
  fi

  long_body="$(printf '%*s' 4505 '' | tr ' ' x)"
  "$agmsg_send" "$agmsg_team" claude codex "$long_body" >/dev/null
  body="$(curl -fsS --max-time 10 "$URL/api/agmsg/${agmsg_id}?since=${id2}&limit=10" 2>/dev/null || true)"
  if printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const m = Array.isArray(obj.messages) ? obj.messages : [];
if (m.length !== 1) process.exit(3);
if (m[0].truncated !== true || m[0].body.length !== 4000) process.exit(4);
if (!m[0].body.split("").every((c) => c === "x")) process.exit(5);
' 2>/dev/null; then
    pass "Phase2b: long body is truncated with truncated=true"
  else
    fail "Phase2b: long body truncate contract failed"
    info "Phase2b truncate payload length: ${#body}"
    return 1
  fi

  bad_port=$((PORT + 1000))
  bad_url="http://${HOST}:${bad_port}"
  bad_log="$TEST_TMP_DIR/agmsg-db-error-server.log"
  (cd "$DIR" && exec env CMUX_BIN="$CMUX_BIN" CMUX_DASH_PORT="$bad_port" CMUX_DASH_HOST="$HOST" CMUX_DASH_PROJECTS_FILE="$TEST_PROJECTS_FILE" AGMSG_STORAGE_PATH="/dev/null" "$NODE_BIN" server.js >"$bad_log" 2>&1) &
  BAD_SERVER_PID=$!
  for _ in $(seq 1 50); do
    bad_body="$(curl -fsS --max-time 2 "$bad_url/api/agmsg/${agmsg_id}" 2>/dev/null || true)"
    [ -n "$bad_body" ] && break
    sleep 0.2
  done
  kill "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  wait "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  BAD_SERVER_PID=""
  if printf '%s' "$bad_body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const ok = obj && Array.isArray(obj.messages) && obj.messages.length === 0 && typeof obj.error === "string" && obj.error.length > 0;
process.exit(ok ? 0 : 1);
' 2>/dev/null; then
    pass "Phase2b: DB error path returns empty messages plus error without 5xx"
  else
    fail "Phase2b: DB error path did not return empty messages plus error"
    info "Phase2b DB error payload: ${bad_body:-empty}; log=$bad_log"
    return 1
  fi

  ui_check="$("$NODE_BIN" - "$DIR/public/index.html" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const html = fs.readFileSync(process.argv[2], "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) process.exit(2);
const script = scriptMatch[1];
const refresh = script.match(/async function refresh\(\)\{([\s\S]*?)\n\}/);
const toggleThread = script.match(/function toggleThread\(id\)\{([\s\S]*?)\n\}/);
const closeThread = script.match(/function closeThread\(id\)\{([\s\S]*?)\n\}/);
const fetchThread = script.match(/async function fetchThread\(id,initial\)\{([\s\S]*?)\n\}/);
const checks = [
  refresh && !refresh[1].includes("/api/agmsg/"),
  toggleThread && toggleThread[1].includes("setInterval(()=>fetchThread(id,false),3000)"),
  closeThread && closeThread[1].includes("clearInterval(st.timer)"),
  fetchThread && fetchThread[1].includes("/api/agmsg/") && fetchThread[1].includes("since="),
  script.includes("function renderProjectRow(p, index)") && script.includes("function toggleSlot(id, slot, on)"),
];
process.stdout.write(checks.every(Boolean) ? "ok" : "bad");
NODE
)"
  if [ "$ui_check" = "ok" ]; then
    pass "Phase2b: UI agmsg polling stays scoped while R1 slot rows render"
  else
    fail "Phase2b: UI conversation polling static contract failed"
    return 1
  fi

  sqlite3 "$db" "DELETE FROM messages WHERE team='$agmsg_team';" >/dev/null 2>&1 || true
}

json_action_id() {
  "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
if (!obj || !obj.actionId) process.exit(1);
process.stdout.write(String(obj.actionId));
'
}

action_status() {
  local action_id="$1"
  curl -fsS --max-time 30 "$URL/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
const actionId = Number(process.argv[1]);
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const action = (Array.isArray(obj.actions) ? obj.actions : []).find((a) => Number(a.id) === actionId);
if (!action) process.exit(3);
process.stdout.write(`${action.status}\t${action.error || ""}`);
' "$action_id" 2>/dev/null
}

wait_for_action_success() {
  local action_id="$1"
  local label="$2"
  local timeout="${3:-120}"
  local elapsed=0
  local line
  local status
  local error
  while [ "$elapsed" -lt "$timeout" ]; do
    line="$(action_status "$action_id" || true)"
    status="${line%%	*}"
    error="${line#*	}"
    case "$status" in
      succeeded) return 0 ;;
      failed)
        info "$label failed: $error"
        return 1
        ;;
    esac
    sleep 1
    elapsed=$((elapsed + 1))
  done
  info "$label did not reach succeeded within ${timeout}s"
  return 1
}

run_r3_rich_checks() {
  local phase_dir="$TEST_TMP_DIR/r3-rich"
  local fake_cmux="$phase_dir/cmux"
  local cfg_file="$phase_dir/projects.json"
  local state_file="$phase_dir/workspaces.json"
  local event_log="$phase_dir/events.tsv"
  local api_port=$((PORT + 3600))
  local api_url="http://${HOST}:${api_port}"
  local api_log="$phase_dir/api.log"
  local results
  local rc
  local saw_output=0
  local body
  local action_id
  local line
  local status
  local add_body
  local delete_body
  local invalid_status
  local ui_check
  mkdir -p "$phase_dir/a" "$phase_dir/b" "$phase_dir/c"
  : >"$event_log"
  cat >"$fake_cmux" <<SH
#!/usr/bin/env bash
STATE="$state_file"
EVENT_LOG="$event_log"
NODE_BIN="$NODE_BIN"
cmd="\${1:-}"
shift || true
case "\$cmd" in
  ping)
    printf 'pong\n'
    ;;
  list-workspaces)
    cat "\$STATE"
    ;;
  reorder-workspaces)
    order=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --order) order="\${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'reorder-workspaces\t%s\n' "\$order" >>"\$EVENT_LOG"
    "\$NODE_BIN" - "\$STATE" "\$order" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const order = String(process.argv[3] || "").split(",").filter(Boolean);
let obj = { workspaces: [] };
try { obj = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
const workspaces = Array.isArray(obj.workspaces) ? obj.workspaces : [];
const byRef = new Map(workspaces.map((w) => [w && w.ref, w]).filter((x) => x[0]));
const leading = order.map((ref) => byRef.get(ref)).filter(Boolean);
const rest = workspaces.filter((w) => w && !order.includes(w.ref));
fs.writeFileSync(file, JSON.stringify({ workspaces: leading.concat(rest) }) + "\n");
NODE
    printf '{"ok":true}\n'
    ;;
  list-panes)
    printf '{"panes":[]}\n'
    ;;
  list-pane-surfaces)
    printf '{"surfaces":[]}\n'
    ;;
  top)
    ;;
  memory)
    printf 'Footprint: 64 MiB\nChild RSS total: 16 MiB\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac
SH
  chmod +x "$fake_cmux"

  results="$(
    CMUX_BIN="$fake_cmux" \
    CMUX_DASH_PROJECTS_FILE="$cfg_file" \
    CMUX_DASH_SETTLE_MS=0 \
    CMUX_DASH_READ_TIMEOUT=1000 \
    CMUX_DASH_READ_RETRY_BUDGET_MS=1000 \
    CMUX_DASH_READ_RETRIES=0 \
    "$NODE_BIN" - "$DIR" "$phase_dir" "$cfg_file" "$state_file" "$event_log" <<'NODE'
const fs = require("fs");
const path = require("path");

const repo = process.argv[2];
const base = process.argv[3];
const cfgFile = process.argv[4];
const stateFile = process.argv[5];
const eventLog = process.argv[6];

let failed = 0;
function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}
function writeBaseConfig() {
  const cfg = {
    _comment: "R3 isolated test config",
    defaults: { agmsg: { enabled: false }, claudeMd: { mode: "off" }, collab: false },
    projects: [
      { id: "a", name: "Alpha", path: path.join(base, "a"), color: "#111111", emoji: "A" },
      { id: "b", name: "Beta", path: path.join(base, "b"), color: "#222222", emoji: "B" },
      { id: "c", name: "Gamma", path: path.join(base, "c"), color: "#333333", emoji: "C" },
    ],
  };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  fs.writeFileSync(stateFile, JSON.stringify({
    workspaces: cfg.projects.map((p, i) => ({ ref: "workspace:" + (i + 1), description: "cmuxdash:" + p.id })),
  }) + "\n");
}
function ids() {
  return JSON.parse(fs.readFileSync(cfgFile, "utf8")).projects.map((p) => p.id).join(",");
}

(async () => {
  try {
    writeBaseConfig();
    const ctl = require(path.join(repo, "cmuxctl.js"));
    const result = await ctl.reorderProjects(["c", "a", "b"]);
    const log = fs.readFileSync(eventLog, "utf8");
    check("R3 reorder: cmuxctl persists projects.json order", ids() === "c,a,b" && result.order.join(",") === "c,a,b");
    check("R3 reorder: cmuxctl calls reorder-workspaces with workspace refs", /reorder-workspaces\tworkspace:3,workspace:1,workspace:2/.test(log));

    const added = ctl.addProject({ name: "New Project", path: path.join(base, "new-project"), emoji: "NP", color: "#abcdef", create: false });
    const cfgAfterAdd = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    check("R3 addProject keeps name/path/emoji/color contract", (
      added.id === "new-project" &&
      added.name === "New Project" &&
      added.path === path.join(base, "new-project") &&
      added.emoji === "NP" &&
      added.color === "#abcdef" &&
      cfgAfterAdd.projects.some((p) => p.id === "new-project")
    ));

    let invalidAddRejected = false;
    try { ctl.addProject({}); } catch (_) { invalidAddRejected = true; }
    check("R3 addProject rejects empty name/path", invalidAddRejected);

    const removed = ctl.removeProject("a");
    check("R3 removeProject persists deletion", removed.removed === true && ids() === "c,b,new-project");
    writeBaseConfig();
  } catch (err) {
    failed += 1;
    console.log("FAIL\tR3 runner exception: " + (err && err.message ? err.message : err));
  }
  process.exit(failed ? 1 : 0);
})();
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "$label" ;;
      FAIL) fail "$label" ;;
      *) info "R3 output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "R3 runner produced no output"
  fi
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi

  (cd "$DIR" && exec env CMUX_BIN="$fake_cmux" CMUX_DASH_PORT="$api_port" CMUX_DASH_HOST="$HOST" CMUX_DASH_PROJECTS_FILE="$cfg_file" CMUX_DASH_SETTLE_MS=0 CMUX_DASH_READ_TIMEOUT=1000 CMUX_DASH_READ_RETRY_BUDGET_MS=1000 CMUX_DASH_READ_RETRIES=0 "$NODE_BIN" server.js >"$api_log" 2>&1) &
  BAD_SERVER_PID=$!
  for _ in $(seq 1 50); do
    body="$(curl -fsS --max-time 2 "$api_url/api/state" 2>/dev/null || true)"
    [ -n "$body" ] && break
    sleep 0.2
  done
  if [ -z "$body" ]; then
    fail "R3 API server did not start; log=$api_log"
    return 1
  fi

  body="$(curl -fsS -X POST --max-time 10 -H 'Content-Type: application/json' --data '{"order":["b","c","a"]}' "$api_url/api/reorder" 2>/dev/null || true)"
  action_id="$(printf '%s' "$body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
if (obj && obj.queued === true && obj.actionId) process.stdout.write(String(obj.actionId));
' 2>/dev/null || true)"
  if [ -n "$action_id" ]; then
    pass "R3 API: POST /api/reorder returns queued actionId"
  else
    fail "R3 API: POST /api/reorder contract failed"
    info "R3 reorder payload: ${body:-empty}; log=$api_log"
    return 1
  fi
  for _ in $(seq 1 50); do
    line="$(curl -fsS --max-time 5 "$api_url/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
const actionId = Number(process.argv[1]);
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const action = (Array.isArray(obj.actions) ? obj.actions : []).find((a) => Number(a.id) === actionId);
if (action) process.stdout.write(`${action.status}\t${action.error || ""}`);
' "$action_id" 2>/dev/null || true)"
    status="${line%%	*}"
    [ "$status" = "succeeded" ] && break
    [ "$status" = "failed" ] && break
    sleep 0.2
  done
  if [ "$status" = "succeeded" ] \
    && "$NODE_BIN" - "$cfg_file" "$state_file" "$event_log" <<'NODE' 2>/dev/null
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const state = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const log = fs.readFileSync(process.argv[4], "utf8");
const cfgOrder = cfg.projects.map((p) => p.id).join(",");
const wsOrder = state.workspaces.map((w) => w.description.replace(/^cmuxdash:/, "")).join(",");
const ok = cfgOrder === "b,c,a" &&
  wsOrder === "b,c,a" &&
  /reorder-workspaces\tworkspace:2,workspace:3,workspace:1/.test(log);
process.exit(ok ? 0 : 1);
NODE
  then
    pass "R3 API: /api/reorder persists order and calls fake reorder-workspaces"
  else
    fail "R3 API: /api/reorder did not persist order or fake cmux reorder"
    return 1
  fi

  if curl -fsS --max-time 5 "$api_url/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const order = (Array.isArray(obj.projects) ? obj.projects : []).map((p) => p.id).join(",");
process.exit(order === "b,c,a" ? 0 : 1);
' 2>/dev/null; then
    pass "R3 API: GET /api/state follows reordered projects.json order"
  else
    fail "R3 API: GET /api/state did not follow reordered order"
    return 1
  fi

  add_body="$(curl -fsS -X POST --max-time 10 -H 'Content-Type: application/json' --data "{\"name\":\"API Project\",\"path\":\"$phase_dir/api-project\",\"emoji\":\"AP\",\"color\":\"#123456\",\"create\":false}" "$api_url/api/projects" 2>/dev/null || true)"
  if printf '%s' "$add_body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
process.exit(obj && obj.id === "api-project" && obj.name === "API Project" && obj.emoji === "AP" && obj.color === "#123456" ? 0 : 1);
' 2>/dev/null; then
    pass "R3 API: POST /api/projects returns added project contract"
  else
    fail "R3 API: POST /api/projects contract failed"
    info "R3 add payload: ${add_body:-empty}"
    return 1
  fi

  invalid_status="$(curl -sS -o "$phase_dir/invalid-add.json" -w '%{http_code}' -X POST --max-time 10 -H 'Content-Type: application/json' --data '{}' "$api_url/api/projects" 2>/dev/null || true)"
  if [ "$invalid_status" = "400" ]; then
    pass "R3 API: POST /api/projects rejects empty body"
  else
    fail "R3 API: POST /api/projects empty body status was ${invalid_status:-empty}"
    return 1
  fi

  delete_body="$(curl -fsS -X DELETE --max-time 10 "$api_url/api/projects/api-project" 2>/dev/null || true)"
  if printf '%s' "$delete_body" | "$NODE_BIN" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
process.exit(obj && obj.removed === true ? 0 : 1);
' 2>/dev/null && "$NODE_BIN" - "$cfg_file" <<'NODE' 2>/dev/null
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.exit(cfg.projects.some((p) => p.id === "api-project") ? 1 : 0);
NODE
  then
    pass "R3 API: DELETE /api/projects/:id removes persisted project"
  else
    fail "R3 API: DELETE /api/projects/:id contract failed"
    info "R3 delete payload: ${delete_body:-empty}"
    return 1
  fi

  kill "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  wait "$BAD_SERVER_PID" >/dev/null 2>&1 || true
  BAD_SERVER_PID=""

  ui_check="$("$NODE_BIN" - "$DIR/public/index.html" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const html = fs.readFileSync(process.argv[2], "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) process.exit(2);
const script = scriptMatch[1];
const gridAssign = script.match(/\$\('#grid'\)\.innerHTML =([\s\S]*?)renderMetricsPanels\(\);/);
const checks = [
  html.includes(".projects-list"),
  html.includes(".row-origin"),
  html.includes(".project-row.dragging"),
  script.includes('data-project-id="${esc(p.id)}"'),
  script.includes('data-project-index="${index}"'),
  script.includes('draggable="true"'),
  script.includes("function dragStart(ev,id)"),
  script.includes("function dropProject(ev,targetId)"),
  script.includes("function reorderProjects(order)"),
  script.includes("jpost('/api/reorder',{order})"),
  script.includes('data-action="drop"'),
  script.includes('data-action="delete"'),
  script.includes("encodeURIComponent(id),{method:'DELETE'}"),
  script.includes("function renderProjectRows(s)"),
  script.includes('id="projectRows"'),
  script.includes("projects.map((p,i)=>renderProjectRow(p,i)).join('')"),
  gridAssign && gridAssign[1].includes("renderProjectRows(s)"),
  html.includes("Memory") && html.includes("CC &amp; Codex"),
];
process.stdout.write(checks.every(Boolean) ? "ok" : "bad");
NODE
  )"
  if [ "$ui_check" = "ok" ]; then
    pass "R3 UI: drag rows, compact lcl layout, delete/drop, and lower panels static contract are present"
  else
    fail "R3 UI static contract failed"
    return 1
  fi
}

api_slot_status() {
  local slot="$1"
  curl -fsS --max-time 30 "$URL/api/state" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("fs");
const projectId = process.argv[1];
const slot = process.argv[2];
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const p = (Array.isArray(obj.projects) ? obj.projects : []).find((x) => x && x.id === projectId);
if (!p || !p.slots || typeof p.slots[slot] !== "boolean") process.exit(3);
process.stdout.write(p.slots[slot] ? "on" : "off");
' "$PROJECT_ID" "$slot" 2>/dev/null
}

wait_for_api_slot() {
  local slot="$1"
  local want="$2"
  local timeout="${3:-60}"
  local elapsed=0
  local status
  while [ "$elapsed" -lt "$timeout" ]; do
    status="$(api_slot_status "$slot" || true)"
    [ "$status" = "$want" ] && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

slot_action_and_wait() {
  local slot="$1"
  local on="$2"
  local want="$3"
  local body
  local action_id
  body="$(post_api_json "/api/project/${PROJECT_ID}/slot/${slot}" "{\"on\":${on}}")"
  if [ -z "$body" ] || ! printf '%s' "$body" | json_field_ok queued; then
    fail "POST /api/project/${PROJECT_ID}/slot/${slot} failed"
    return 1
  fi
  action_id="$(printf '%s' "$body" | json_action_id 2>/dev/null || true)"
  if [ -z "$action_id" ]; then
    fail "POST /api/project/${PROJECT_ID}/slot/${slot} did not return actionId"
    return 1
  fi
  if wait_for_action_success "$action_id" "slot:${PROJECT_ID}:${slot}:${want}" 120 \
    && wait_for_api_slot "$slot" "$want" 30; then
    pass "POST /api/project/${PROJECT_ID}/slot/${slot} queued on=${on}"
    pass "action slot:${PROJECT_ID}:${slot}:${want} succeeded"
    pass "GET /api/state reports slot ${slot} ${want}"
    return 0
  fi
  fail "slot ${slot} did not reach ${want}"
  return 1
}

assert_cc_slot_toggle() {
  local workspace_ref
  local before
  local panes_before
  local after_on
  local panes_after_on
  local after_repeat
  local after_off
  local panes_after_off
  workspace_ref="$(workspace_ref_by_tag 2>/dev/null || true)"
  if [ -z "$workspace_ref" ]; then
    fail "cannot test slot toggle without tagged workspace"
    return 1
  fi
  before="$(surface_count_for_workspace "$workspace_ref" 2>/dev/null || true)"
  panes_before="$(pane_count_for_workspace "$workspace_ref" 2>/dev/null || true)"
  if [ -z "$before" ]; then
    fail "could not count surfaces before CC slot toggle"
    return 1
  fi
  if [ "$(api_slot_status cc || true)" = "off" ]; then
    pass "GET /api/state reports slot cc off before toggle"
  else
    fail "GET /api/state did not report slot cc off before toggle"
    return 1
  fi
  if ! slot_action_and_wait cc true on; then return 1; fi
  after_on="$(surface_count_for_workspace "$workspace_ref" 2>/dev/null || true)"
  panes_after_on="$(pane_count_for_workspace "$workspace_ref" 2>/dev/null || true)"
  if [ -n "$after_on" ] && [ "$after_on" -gt "$before" ]; then
    pass "CC slot ON increased surface count (${before} -> ${after_on})"
  else
    fail "CC slot ON did not create a dedicated visible surface (${before} -> ${after_on:-unknown})"
    return 1
  fi
  if [ -n "$panes_before" ] && [ -n "$panes_after_on" ] && [ "$panes_after_on" -gt "$panes_before" ]; then
    pass "CC slot ON created a dedicated split pane (${panes_before} -> ${panes_after_on})"
  else
    fail "CC slot ON did not create a dedicated split pane (${panes_before:-unknown} -> ${panes_after_on:-unknown})"
    return 1
  fi
  if ! slot_action_and_wait cc true on; then return 1; fi
  after_repeat="$(surface_count_for_workspace "$workspace_ref" 2>/dev/null || true)"
  if [ "$after_repeat" = "$after_on" ]; then
    pass "CC slot repeated ON is idempotent"
  else
    fail "CC slot repeated ON changed surface count (${after_on} -> ${after_repeat:-unknown})"
    return 1
  fi
  if ! slot_action_and_wait cc false off; then return 1; fi
  after_off="$(surface_count_for_workspace "$workspace_ref" 2>/dev/null || true)"
  panes_after_off="$(pane_count_for_workspace "$workspace_ref" 2>/dev/null || true)"
  if [ -n "$after_off" ] && [ "$after_off" -lt "$after_on" ]; then
    pass "CC slot OFF decreased surface count (${after_on} -> ${after_off})"
  else
    fail "CC slot OFF did not decrease surface count (${after_on} -> ${after_off:-unknown})"
    return 1
  fi
  if [ -n "$panes_after_on" ] && [ -n "$panes_after_off" ] && [ "$panes_after_off" -lt "$panes_after_on" ]; then
    pass "CC slot OFF decreased pane count (${panes_after_on} -> ${panes_after_off})"
  elif [ -n "$panes_before" ] && [ -n "$panes_after_on" ] && [ "$panes_after_on" = "$panes_before" ] && [ -n "$panes_after_off" ] && [ "$panes_after_off" = "$panes_after_on" ]; then
    fail "CC slot OFF left reused top pane in place (${panes_after_on} -> ${panes_after_off})"
    return 1
  else
    fail "CC slot OFF did not decrease pane count (${panes_after_on:-unknown} -> ${panes_after_off:-unknown})"
    return 1
  fi
}

run_c2_real_grid_checks() {
  local phase_dir="$TEST_TMP_DIR/c2-real-grid"
  local cfg_file="$phase_dir/projects.json"
  local results
  local rc
  local saw_output=0

  if [ "$REAL_CMUX_AVAILABLE" -ne 1 ]; then
    pass "C2 real-cmux grid skipped: real cmux is unavailable or unhealthy"
    return 0
  fi

  mkdir -p "$phase_dir/project-a" "$phase_dir/project-b"
  results="$(
    CMUX_BIN="$REAL_CMUX_BIN" \
    CMUX_DASH_PROJECTS_FILE="$cfg_file" \
    CMUX_DASH_SETTLE_MS=700 \
    "$NODE_BIN" - "$DIR" "$phase_dir" "$cfg_file" "$REAL_CMUX_BIN" <<'NODE'
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const repo = process.argv[2];
const phaseDir = process.argv[3];
const cfgFile = process.argv[4];
const cmuxBin = process.argv[5];
const gridTag = "cmuxdash:__grid__";
const ctl = require(path.join(repo, "cmuxctl.js"));

let failed = 0;
let createdGrid = false;
function check(label, ok) {
  if (ok) console.log("PASS\t" + label);
  else {
    failed += 1;
    console.log("FAIL\t" + label);
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isTransient(err) {
  const text = [
    err && err.message,
    err && err.stderr,
    err && err.stdout,
    err && err.code,
    err && err.signal,
  ].filter(Boolean).join(" ");
  return /broken pipe|EPIPE|errno 32|socket|ECONNRESET|ETIMEDOUT|timeout|timed out|SIGKILL/i.test(text);
}
async function cmux(args, opts = {}) {
  const env = ctl.buildCmuxEnv(process.env);
  const timeout = opts.timeout || 15000;
  const retries = opts.retries == null ? 6 : opts.retries;
  const deadline = Date.now() + (opts.budgetMs || 30000);
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        execFile(cmuxBin, args, { env, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
            return;
          }
          resolve(String(stdout || "").trim());
        });
      });
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === retries || Date.now() >= deadline) throw err;
      await sleep(Math.min(3000, 200 * Math.pow(2, attempt)));
    }
  }
  throw lastErr || new Error("cmux command failed");
}
async function cmuxJson(args) {
  const out = await cmux([...args, "--json"]);
  const start = out.indexOf("{");
  return JSON.parse(start >= 0 ? out.slice(start) : out);
}
async function listWorkspaces() {
  return (await cmuxJson(["list-workspaces"])).workspaces || [];
}
async function findGridWorkspace() {
  return (await listWorkspaces()).find((ws) => ws && ws.description === gridTag) || null;
}
async function listPanes(wsRef) {
  return (await cmuxJson(["list-panes", "--workspace", wsRef])).panes || [];
}
async function listSurfaces(wsRef, paneRef = null) {
  const args = ["list-pane-surfaces", "--workspace", wsRef];
  if (paneRef) args.push("--pane", paneRef);
  const surfaces = (await cmuxJson(args)).surfaces || [];
  return surfaces.map((surface) => ({
    ...surface,
    paneRef: surface.paneRef || surface.pane || paneRef || null,
  }));
}
async function liveLayout(wsRef) {
  const panes = await listPanes(wsRef);
  const surfaces = [];
  if (panes.length) {
    for (const pane of panes) {
      if (!pane || !pane.ref) continue;
      surfaces.push(...await listSurfaces(wsRef, pane.ref));
    }
  } else {
    surfaces.push(...await listSurfaces(wsRef));
  }
  return { panes, surfaces };
}
function surfaceByRef(layout, ref) {
  return (layout.surfaces || []).find((surface) => surface && surface.ref === ref) || null;
}
function stateMatchesLive(state, layout) {
  if (!state || !Array.isArray(state.columns)) return false;
  for (const column of state.columns) {
    const cc = surfaceByRef(layout, column.cc && column.cc.surfaceRef);
    const cdx = surfaceByRef(layout, column.cdx && column.cdx.surfaceRef);
    if (!cc || !cdx) return false;
    if ((column.cc.paneRef || null) !== (cc.paneRef || null)) return false;
    if ((column.cdx.paneRef || null) !== (cdx.paneRef || null)) return false;
  }
  return true;
}
function refsGone(layout, refs) {
  return refs.every((ref) => !surfaceByRef(layout, ref));
}
function refsPresent(layout, refs) {
  return refs.every((ref) => !!surfaceByRef(layout, ref));
}
async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last && last.ok) return last.value;
    await sleep(500);
  }
  throw new Error("timed out waiting for " + label);
}

(async () => {
  const preExisting = await findGridWorkspace();
  if (preExisting && preExisting.ref) {
    check("real grid skipped: pre-existing cmuxdash:__grid__ workspace left untouched (" + preExisting.ref + ")", true);
    return;
  }
  check("real grid precondition: no pre-existing cmuxdash:__grid__ workspace", true);

  const suffix = String(process.pid) + "-" + Date.now();
  const projectA = "c2-grid-a-" + suffix;
  const projectB = "c2-grid-b-" + suffix;
  const dirA = path.join(phaseDir, "project-a");
  const dirB = path.join(phaseDir, "project-b");
  fs.writeFileSync(cfgFile, JSON.stringify({
    _comment: "C2 real-cmux grid integration config generated by test.sh",
    defaults: {
      topCmd: "sleep 600",
      bottomCmd: "sleep 600",
      slotCommands: { cc: "sleep 600", cdx: "sleep 600" },
      agmsg: { enabled: false, brief: false },
      claudeMd: { mode: "off" },
      collab: false,
    },
    projects: [
      { id: projectA, name: "C2 Grid A", path: dirA, agmsg: { enabled: false } },
      { id: projectB, name: "C2 Grid B", path: dirB, agmsg: { enabled: false } },
    ],
  }, null, 2) + "\n");

  let wsRef = null;
  try {
    createdGrid = true;
    const colA = await ctl.addProjectColumn(projectA);
    const wsAfterA = await waitFor("grid workspace after first column", async () => {
      const ws = await findGridWorkspace();
      if (!ws || !ws.ref) return { ok: false };
      const layout = await liveLayout(ws.ref);
      return { ok: refsPresent(layout, [colA.cc.surfaceRef, colA.cdx.surfaceRef]), value: { ws, layout } };
    });
    wsRef = wsAfterA.ws.ref;
    const afterA = wsAfterA.layout;
    const afterAState = await ctl.getGridState();
    check("real grid add first column: dedicated workspace " + wsRef + " has cc/cdx refs and live layout panes=" + afterA.panes.length + " surfaces=" + afterA.surfaces.length, (
      colA.added === true &&
      afterAState.wsRef === wsRef &&
      afterAState.columns.length === 1 &&
      afterAState.columns[0].projectId === projectA &&
      afterAState.columns[0].order === 0 &&
      refsPresent(afterA, [colA.cc.surfaceRef, colA.cdx.surfaceRef]) &&
      stateMatchesLive(afterAState, afterA)
    ));

    const colB = await ctl.addProjectColumn(projectB);
    const afterB = await waitFor("second grid column live refs", async () => {
      const layout = await liveLayout(wsRef);
      return {
        ok: refsPresent(layout, [colA.cc.surfaceRef, colA.cdx.surfaceRef, colB.cc.surfaceRef, colB.cdx.surfaceRef]),
        value: layout,
      };
    });
    const afterBState = await ctl.getGridState();
    check("real grid add second column: each column adds cc/cdx pair panes " + afterA.panes.length + "->" + afterB.panes.length + " surfaces " + afterA.surfaces.length + "->" + afterB.surfaces.length, (
      colB.added === true &&
      afterB.panes.length === afterA.panes.length + 2 &&
      afterB.surfaces.length === afterA.surfaces.length + 2
    ));
    check("real grid getGridState: columns ordered and refs match live list-panes/list-pane-surfaces", (
      afterBState.wsRef === wsRef &&
      afterBState.columns.length === 2 &&
      afterBState.columns.map((column) => column.projectId).join(",") === projectA + "," + projectB &&
      afterBState.columns[0].order === 0 &&
      afterBState.columns[1].order === 1 &&
      stateMatchesLive(afterBState, afterB)
    ));

    await ctl.removeProjectColumn(projectA);
    const afterRemoveA = await waitFor("first grid column removed", async () => {
      const layout = await liveLayout(wsRef);
      return {
        ok: refsGone(layout, [colA.cc.surfaceRef, colA.cdx.surfaceRef]) && refsPresent(layout, [colB.cc.surfaceRef, colB.cdx.surfaceRef]),
        value: layout,
      };
    });
    const afterRemoveAState = await ctl.getGridState();
    check("real grid remove first column: A refs closed, B survives panes " + afterB.panes.length + "->" + afterRemoveA.panes.length + " surfaces " + afterB.surfaces.length + "->" + afterRemoveA.surfaces.length, (
      afterRemoveA.surfaces.length === afterB.surfaces.length - 2 &&
      afterRemoveAState.columns.length === 1 &&
      afterRemoveAState.columns[0].projectId === projectB &&
      refsPresent(afterRemoveA, [colB.cc.surfaceRef, colB.cdx.surfaceRef]) &&
      stateMatchesLive(afterRemoveAState, afterRemoveA)
    ));

    await ctl.removeProjectColumn(projectB);
    await waitFor("last grid column cleanup", async () => {
      const ws = await findGridWorkspace();
      return { ok: !ws, value: true };
    });
    const finalState = await ctl.getGridState();
    check("real grid remove last column: grid workspace cleaned up and getGridState is empty", (
      !finalState.wsRef &&
      Array.isArray(finalState.columns) &&
      finalState.columns.length === 0
    ));
    createdGrid = false;
  } finally {
    if (createdGrid) {
      try {
        const ws = await findGridWorkspace();
        if (ws && ws.ref) await cmux(["close-workspace", "--workspace", ws.ref]);
      } catch (err) {
        check("real grid cleanup: close throwaway workspace", false);
      }
    }
  }
})().catch((err) => {
  failed += 1;
  console.log("FAIL\treal grid runner exception: " + (err && err.message ? err.message : err));
}).finally(() => {
  process.exit(failed ? 1 : 0);
});
NODE
  )"
  rc=$?

  while IFS="$(printf '\t')" read -r status label; do
    [ -z "$status" ] && continue
    saw_output=1
    case "$status" in
      PASS) pass "C2: $label" ;;
      FAIL) fail "C2: $label" ;;
      *) info "C2 output: $status $label" ;;
    esac
  done <<EOF
$results
EOF

  if [ "$saw_output" -eq 0 ]; then
    fail "C2 real-cmux grid runner produced no output"
  fi
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi
  return 0
}

open_and_wait() {
  local attempt=1
  local body
  local action_id
  while [ "$attempt" -le "$ACTION_ATTEMPTS" ]; do
    body="$(post_action open)"
    if [ -n "$body" ] && printf '%s' "$body" | json_field_ok queued; then
      action_id="$(printf '%s' "$body" | json_action_id 2>/dev/null || true)"
      if [ -n "$action_id" ] && wait_for_action_success "$action_id" "open ${PROJECT_ID}" 120 \
        && wait_for_api_project present 20 && [ "$(workspace_status || true)" = "present" ]; then
        pass "POST /api/open/${PROJECT_ID} queued"
        pass "action open:${PROJECT_ID} succeeded"
        pass "cmux list-workspaces contains $TAG"
        return 0
      fi
      info "open attempt $attempt queued but $TAG did not appear yet; retrying"
    else
      info "open attempt $attempt did not return queued response; retrying"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

close_and_wait() {
  local attempt=1
  local body
  local action_id
  while [ "$attempt" -le "$ACTION_ATTEMPTS" ]; do
    body="$(post_action close)"
    if [ -n "$body" ] && printf '%s' "$body" | json_field_ok queued; then
      action_id="$(printf '%s' "$body" | json_action_id 2>/dev/null || true)"
      if [ -n "$action_id" ] && wait_for_action_success "$action_id" "close ${PROJECT_ID}" 120 \
        && wait_for_api_project absent 20 && [ "$(workspace_status || true)" = "absent" ]; then
        pass "POST /api/close/${PROJECT_ID} queued"
        pass "action close:${PROJECT_ID} succeeded"
        pass "cmux list-workspaces no longer contains $TAG"
        return 0
      fi
      info "close attempt $attempt queued but $TAG is still present; retrying"
    else
      info "close attempt $attempt did not return queued response; retrying"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

api_action_and_wait() {
  local path="$1"
  local label="$2"
  local body
  local action_id
  body="$(post_api "$path")"
  if [ -z "$body" ] || ! printf '%s' "$body" | json_field_ok queued; then
    fail "POST $path failed"
    return 1
  fi
  action_id="$(printf '%s' "$body" | json_action_id 2>/dev/null || true)"
  if [ -z "$action_id" ]; then
    fail "POST $path did not return actionId"
    return 1
  fi
  if wait_for_action_success "$action_id" "$label" 180; then
    pass "POST $path queued"
    pass "action $label succeeded"
    return 0
  fi
  fail "action $label did not succeed"
  return 1
}

assert_no_unrecovered_socket_errors() {
  if [ -f "$LOG" ] && grep -E 'action error.*(Broken pipe|EPIPE|errno 32|ECONNRESET|timed out|timeout)' "$LOG" >/dev/null 2>&1; then
    fail "server log contains unrecovered transient socket action error: $LOG"
    return 1
  fi
  pass "server log has no unrecovered transient socket action errors"
}

if ! run_c2_real_grid_checks; then
  finish
fi

if server_healthy; then
  if [ -n "${CMUX_DASH_PORT:-}" ]; then
    fail "test port already has a dashboard server at $URL; choose a free CMUX_DASH_PORT for isolated tests"
    finish
  fi
  for _ in $(seq 1 20); do
    PORT=$((PORT + 1))
    URL="http://${HOST}:${PORT}"
    if ! server_healthy; then
      break
    fi
  done
  if server_healthy; then
    fail "could not find a free isolated test port near $PORT"
    finish
  fi
fi
(cd "$DIR" && exec env CMUX_BIN="$CMUX_BIN" CMUX_DASH_PORT="$PORT" CMUX_DASH_HOST="$HOST" CMUX_DASH_PROJECTS_FILE="$TEST_PROJECTS_FILE" CMUX_DASH_DOCTOR_TIMEOUT=1000 CMUX_DASH_DOCTOR_RETRY_BUDGET_MS=1000 CMUX_DASH_DOCTOR_RETRIES=0 "$NODE_BIN" server.js >"$LOG" 2>&1) &
SERVER_PID=$!
STARTED_SERVER=1
for _ in $(seq 1 50); do
  if server_healthy; then
    pass "server startup confirmed: started isolated server at $URL"
    break
  fi
  sleep 0.2
done
if ! server_healthy; then
  fail "server startup failed; see $LOG"
  finish
fi

STATE_JSON="$(curl -fsS --max-time 10 "$URL/api/state" 2>/dev/null || true)"
if [ -n "$STATE_JSON" ] && printf '%s' "$STATE_JSON" | json_field_ok state; then
  pass "GET /api/state returned JSON and includes $PROJECT_ID"
else
  fail "GET /api/state failed or $PROJECT_ID is missing"
  finish
fi

if ! run_phase3_checks; then
  finish
fi

if ! run_phase2b_checks; then
  finish
fi

if ! run_r3_rich_checks; then
  finish
fi

PRE_STATUS="$(workspace_status || true)"
if [ "$PRE_STATUS" = "present" ]; then
  fail "precondition failed: $TAG already exists; refusing to close a pre-existing workspace"
  finish
elif [ "$PRE_STATUS" = "absent" ]; then
  pass "precondition confirmed: no pre-existing $TAG workspace"
else
  fail "precondition failed: unable to read cmux workspaces"
  finish
fi

if ! open_and_wait; then
  ERR="$(state_last_error)"
  [ -n "$ERR" ] && ERR="; lastError: $ERR"
  fail "POST /api/open/${PROJECT_ID} did not produce $TAG after ${ACTION_ATTEMPTS} attempt(s)${ERR}"
  finish
fi
CREATED_WORKSPACE=1

if ! assert_open_workspace_details; then
  finish
fi

if ! assert_cc_slot_toggle; then
  finish
fi

if ! assert_agmsg_team_members; then
  finish
fi

if ! close_and_wait; then
  ERR="$(state_last_error)"
  [ -n "$ERR" ] && ERR="; lastError: $ERR"
  fail "POST /api/close/${PROJECT_ID} did not remove $TAG after ${ACTION_ATTEMPTS} attempt(s)${ERR}"
  finish
fi
CREATED_WORKSPACE=0

if ! open_and_wait; then
  ERR="$(state_last_error)"
  [ -n "$ERR" ] && ERR="; lastError: $ERR"
  fail "stress open #1 did not produce $TAG${ERR}"
  finish
fi
CREATED_WORKSPACE=1
if ! close_and_wait; then
  ERR="$(state_last_error)"
  [ -n "$ERR" ] && ERR="; lastError: $ERR"
  fail "stress close did not remove $TAG${ERR}"
  finish
fi
CREATED_WORKSPACE=0
if ! open_and_wait; then
  ERR="$(state_last_error)"
  [ -n "$ERR" ] && ERR="; lastError: $ERR"
  fail "stress open #2 did not produce $TAG${ERR}"
  finish
fi
CREATED_WORKSPACE=1
if ! close_and_wait; then
  ERR="$(state_last_error)"
  [ -n "$ERR" ] && ERR="; lastError: $ERR"
  fail "stress cleanup close did not remove $TAG${ERR}"
  finish
fi
CREATED_WORKSPACE=0
pass "stress open-close-open sequence completed"

if [ "$(workspace_status || true)" != "absent" ]; then
  fail "open-all precondition failed: $TAG is already open"
  finish
fi
if ! api_action_and_wait "/api/open-all" "open-all"; then
  finish
fi
if wait_for_api_project present 30 && [ "$(workspace_status || true)" = "present" ]; then
  pass "open-all created $TAG"
else
  fail "open-all did not create $TAG"
  finish
fi
CREATED_WORKSPACE=1
if ! api_action_and_wait "/api/close-all" "close-all"; then
  finish
fi
if wait_for_api_project absent 30 && [ "$(workspace_status || true)" = "absent" ]; then
  pass "close-all removed $TAG"
else
  fail "close-all did not remove $TAG"
  finish
fi
CREATED_WORKSPACE=0

assert_no_unrecovered_socket_errors

finish
