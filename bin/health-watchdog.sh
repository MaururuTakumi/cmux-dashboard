#!/usr/bin/env bash
set -euo pipefail

URL="${CMUX_DASH_URL:-http://${CMUX_DASH_HOST:-127.0.0.1}:${CMUX_DASH_PORT:-7799}/api/state}"
CURL_TIMEOUT="${CMUX_DASH_WATCHDOG_CURL_TIMEOUT:-3}"
RESTART_CMD="${CMUX_DASH_WATCHDOG_RESTART_CMD:-}"

fetch_state() {
  curl -fsS --max-time "$CURL_TIMEOUT" "$URL" 2>/dev/null
}

cmux_health_line() {
  "${NODE_BIN:-node}" -e '
const fs = require("fs");
let obj;
try { obj = JSON.parse(fs.readFileSync(0, "utf8")); } catch (_) { process.exit(2); }
const cmux = obj && obj.health && obj.health.cmux;
if (!cmux || typeof cmux !== "object") process.exit(3);
if (cmux.unhealthy) {
  console.log("cmux unhealthy: " + (cmux.lastError || cmux.error || "threshold reached"));
  process.exit(10);
}
if (cmux.ok === false) {
  console.log("cmux ok=false: " + (cmux.lastError || cmux.error || "not ok"));
  process.exit(11);
}
console.log("cmux ok=true");
'
}

check_once() {
  local body
  if ! body="$(fetch_state)"; then
    echo "server NOT RESPONDING: $URL"
    return 20
  fi
  printf '%s' "$body" | cmux_health_line
}

run_restart() {
  if [ -z "$RESTART_CMD" ]; then
    echo "foreground server required"
    echo "not restarted: detached watchdog restarts cannot restore the in-pane server reliably"
    echo "Run ./cmux-dash server in a cmux server pane."
    return 0
  fi
  /bin/bash -lc "$RESTART_CMD"
  return 0
}

case "${1:-once}" in
  check)
    check_once
    ;;
  once)
    set +e
    out="$(check_once 2>&1)"
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
      printf '%s\n' "$out"
      exit 0
    fi
    printf '%s\n' "$out"
    run_restart
    if [ -n "$RESTART_CMD" ] && [ "$rc" -ne 20 ]; then
      set +e
      after="$(check_once 2>&1)"
      after_rc=$?
      set -e
      if [ "$after_rc" -eq 0 ]; then
        echo "restarted; $after"
      else
        echo "restarted; health still failing: $after"
      fi
    fi
    ;;
  *)
    echo "usage: health-watchdog.sh [check|once]" >&2
    exit 2
    ;;
esac
