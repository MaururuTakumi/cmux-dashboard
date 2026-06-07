#!/usr/bin/env bash
set -euo pipefail

APP_NAME="cmux Dashboard.app"
BIN_NAME="cmux-dashboard"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
SWIFT_SRC="${SCRIPT_DIR}/swift/main.swift"
BUILD_DIR="${SCRIPT_DIR}/build"
APP_DIR="${BUILD_DIR}/${APP_NAME}"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
BIN_PATH="${MACOS_DIR}/${BIN_NAME}"
PLIST_PATH="${CONTENTS_DIR}/Info.plist"

error() {
  printf 'ERROR: %s\n' "$*" >&2
}

die() {
  error "$*"
  exit 1
}

command -v swiftc >/dev/null 2>&1 || die "swiftc not found."
[ -f "$SWIFT_SRC" ] || die "Swift source not found: ${SWIFT_SRC}"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

swiftc "$SWIFT_SRC" \
  -framework AppKit \
  -framework WebKit \
  -o "$BIN_PATH" || die "swiftc failed."

chmod 755 "$BIN_PATH"

if [ -f "${SCRIPT_DIR}/cmux Dashboard.app/Contents/Resources/applet.icns" ]; then
  cp "${SCRIPT_DIR}/cmux Dashboard.app/Contents/Resources/applet.icns" "${RESOURCES_DIR}/applet.icns"
fi

printf '%s\n' "$SCRIPT_DIR" >"${RESOURCES_DIR}/project-path.txt"

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>cmux Dashboard</string>
  <key>CFBundleExecutable</key>
  <string>${BIN_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>applet</string>
  <key>CFBundleIdentifier</key>
  <string>com.cmuxdash.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>cmux Dashboard</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.4.0</string>
  <key>CFBundleVersion</key>
  <string>4</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

plutil -lint "$PLIST_PATH" >/dev/null || die "Generated Info.plist is invalid."
codesign --force --deep -s - "$APP_DIR" >/dev/null || die "codesign failed."

printf 'Built %s\n' "$APP_DIR"
