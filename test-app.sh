#!/usr/bin/env bash
set -u -o pipefail

APP_NAME="cmux Dashboard.app"
BIN_NAME="cmux-dashboard"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
APP_DIR="${DIR}/build/${APP_NAME}"
BIN_PATH="${APP_DIR}/Contents/MacOS/${BIN_NAME}"
PLIST_PATH="${APP_DIR}/Contents/Info.plist"
TOTAL=0
FAILED=0
TMP_DIR=""

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
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if ! command -v swiftc >/dev/null 2>&1; then
  printf 'SKIP: swiftc not found; Swift app checks skipped.\n'
  printf 'FINAL: PASS (0 checks, Swift tooling unavailable)\n'
  exit 0
fi

info "$(swiftc --version 2>&1 | head -n 1)"

if bash "${DIR}/build-app.sh"; then
  pass "build-app.sh completed"
else
  fail "build-app.sh failed"
  finish
fi

if [ -x "$BIN_PATH" ]; then
  pass "MacOS binary is executable"
else
  fail "MacOS binary is missing or not executable: ${BIN_PATH}"
fi

if plutil -lint "$PLIST_PATH" >/dev/null; then
  pass "Info.plist passes plutil -lint"
else
  fail "Info.plist failed plutil -lint"
fi

if codesign --verify --deep "$APP_DIR" >/dev/null 2>&1; then
  pass "app bundle passes codesign --verify --deep"
else
  fail "app bundle failed codesign --verify --deep"
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cmux-dashboard-app-test.XXXXXX")"
INSTALL_DIR="${TMP_DIR}/Applications"
mkdir -p "$INSTALL_DIR"
if CMUX_DASHBOARD_INSTALL_DIR="$INSTALL_DIR" CMUX_DASHBOARD_INSTALL_FORCE=1 bash "${DIR}/install-app.sh" >/dev/null; then
  pass "install-app.sh installs build app into temporary directory"
else
  fail "install-app.sh failed against temporary directory"
fi

if [ -x "${INSTALL_DIR}/${APP_NAME}/Contents/MacOS/${BIN_NAME}" ]; then
  pass "temporary install contains Swift app binary"
else
  fail "temporary install does not contain Swift app binary"
fi

SMOKE_PORT=$((19000 + ($$ % 1000)))
if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 50); do
    if ! curl -fsS "http://127.0.0.1:${SMOKE_PORT}/api/state" >/dev/null 2>&1; then
      break
    fi
    SMOKE_PORT=$((SMOKE_PORT + 1))
  done
fi
if [ -x "$BIN_PATH" ]; then
  if CMUX_DASH_PORT="$SMOKE_PORT" CMUX_DASH_SMOKE_REQUIRE_START=1 "$BIN_PATH" --smoke-server-lifecycle; then
    pass "server lifecycle smoke starts and stops owned node"
  else
    fail "server lifecycle smoke failed"
  fi
else
  fail "server lifecycle smoke could not run because binary is missing"
fi

finish
