#!/usr/bin/env bash

set -u

APP_NAME="cmux Dashboard.app"
DEST_DIR_ENV_NAME="CMUX_DASHBOARD_INSTALL_DIR"
FORCE_ENV_NAME="CMUX_DASHBOARD_INSTALL_FORCE"
FORCE=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--force|-f]

Install "${APP_NAME}" into /Applications.

Options:
  -f, --force    Overwrite an existing destination app without prompting.
  -h, --help     Show this help.

Environment:
  ${DEST_DIR_ENV_NAME}     Destination directory. Defaults to /Applications.
  ${FORCE_ENV_NAME}   Set to 1, true, yes, or y to overwrite without prompting.
USAGE
}

error() {
  printf 'ERROR: %s\n' "$*" >&2
}

die() {
  error "$*"
  exit 1
}

parse_force_env() {
  case "${!FORCE_ENV_NAME:-}" in
    ""|0|false|FALSE|False|no|NO|No|n|N)
      ;;
    1|true|TRUE|True|yes|YES|Yes|y|Y)
      FORCE=1
      ;;
    *)
      die "Invalid ${FORCE_ENV_NAME} value: ${!FORCE_ENV_NAME}. Use 1/true/yes or 0/false/no."
      ;;
  esac
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -f|--force)
        FORCE=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

confirm_overwrite() {
  if [ "$FORCE" -eq 1 ]; then
    return 0
  fi

  if [ ! -t 0 ]; then
    die "Destination already exists: ${DEST_APP}. Re-run with --force to overwrite non-interactively."
  fi

  printf 'Overwrite existing app at %s? [y/N] ' "$DEST_APP" >&2
  IFS= read -r answer || die "Could not read overwrite confirmation."

  case "$answer" in
    y|Y|yes|YES|Yes)
      ;;
    *)
      printf 'Install cancelled.\n'
      exit 0
      ;;
  esac
}

copy_app_bundle() {
  if command -v ditto >/dev/null 2>&1; then
    ditto "$SOURCE_APP" "$TMP_APP"
    return $?
  fi

  cp -R "$SOURCE_APP" "$TMP_APP"
}

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

parse_args "$@"
parse_force_env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" \
  || die "Could not determine script directory."
BUILD_SOURCE_APP="${SCRIPT_DIR}/build/${APP_NAME}"
LEGACY_SOURCE_APP="${SCRIPT_DIR}/${APP_NAME}"
if [ -d "$BUILD_SOURCE_APP" ]; then
  SOURCE_APP="$BUILD_SOURCE_APP"
else
  SOURCE_APP="$LEGACY_SOURCE_APP"
fi

DEST_DIR_RAW="${CMUX_DASHBOARD_INSTALL_DIR:-/Applications}"
[ -n "$DEST_DIR_RAW" ] || die "${DEST_DIR_ENV_NAME} must not be empty."
[ -d "$DEST_DIR_RAW" ] || die "Destination directory does not exist: ${DEST_DIR_RAW}"

DEST_DIR="$(cd "$DEST_DIR_RAW" >/dev/null 2>&1 && pwd -P)" \
  || die "Could not resolve destination directory: ${DEST_DIR_RAW}"
DEST_APP="${DEST_DIR}/${APP_NAME}"

[ -d "$SOURCE_APP" ] || die "Source app bundle not found: ${SOURCE_APP}. Run ./build-app.sh or restore ${LEGACY_SOURCE_APP}."

if [ "$SOURCE_APP" = "$DEST_APP" ]; then
  die "Destination resolves to the source app bundle; refusing to overwrite ${SOURCE_APP}."
fi

if [ -e "$DEST_APP" ]; then
  confirm_overwrite
fi

TMP_DIR="$(mktemp -d "${DEST_DIR}/.cmux-dashboard-install.XXXXXX")" \
  || die "Could not create temporary directory in ${DEST_DIR}."
TMP_APP="${TMP_DIR}/${APP_NAME}"
BACKUP_APP="${TMP_DIR}/previous-${APP_NAME}"
trap cleanup EXIT

if ! copy_app_bundle; then
  die "Failed to copy app bundle from ${SOURCE_APP} to ${TMP_APP}."
fi

[ -d "$TMP_APP" ] || die "Copied app bundle is missing at temporary path: ${TMP_APP}"

if [ -e "$DEST_APP" ]; then
  if ! mv "$DEST_APP" "$BACKUP_APP"; then
    die "Failed to move existing app out of the way: ${DEST_APP}"
  fi
fi

if ! mv "$TMP_APP" "$DEST_APP"; then
  if [ -e "$BACKUP_APP" ] && [ ! -e "$DEST_APP" ]; then
    mv "$BACKUP_APP" "$DEST_APP" >/dev/null 2>&1 || true
  fi
  die "Failed to move app into destination: ${DEST_APP}"
fi

printf 'Installed %s\n' "$DEST_APP"
