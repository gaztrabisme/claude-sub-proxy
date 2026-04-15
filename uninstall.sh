#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="claude-sub-proxy"
SERVICE_NAME="com.claude-sub-proxy"
CONFIG_DIR="${HOME}/.claude-sub-proxy"
GLOBAL_CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
PROJECT_CLAUDE_SETTINGS="$(pwd)/.claude/settings.json"
LOCAL_CLAUDE_SETTINGS="$(pwd)/.claude/settings.local.json"
DEFAULT_PROXY_URL="http://127.0.0.1:13456"

DRY_RUN=0

log() {
  printf '%s\n' "$*"
}

run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi

  "$@"
}

remove_path() {
  local path="$1"

  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi

  if [ -d "$path" ] && [ ! -L "$path" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] rm -r %s\n' "$path"
      return 0
    fi

    rm -r "$path"
    return 0
  fi

  if [ -f "$path" ] || [ -L "$path" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] rm %s\n' "$path"
      return 0
    fi

    rm "$path"
    return 0
  fi

  printf 'Refusing to remove unsupported path type: %s\n' "$path" >&2
  exit 1
}

cleanup_claude_settings() {
  local settings_path="$1"

  [ -f "$settings_path" ] || return 0

  if [ "$DRY_RUN" -eq 1 ]; then
    :
  fi

  SETTINGS_PATH="$settings_path" DEFAULT_PROXY_URL="$DEFAULT_PROXY_URL" DRY_RUN="$DRY_RUN" node <<'EOF'
const fs = require("fs");

const settingsPath = process.env.SETTINGS_PATH;
const defaultProxyUrl = process.env.DEFAULT_PROXY_URL;
const dryRun = process.env.DRY_RUN === "1";

let raw;
try {
  raw = fs.readFileSync(settingsPath, "utf8");
} catch {
  process.exit(0);
}

let settings;
try {
  settings = JSON.parse(raw);
} catch (error) {
  console.error(`Skipping ${settingsPath}: invalid JSON (${error.message})`);
  process.exit(0);
}

if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
  console.error(`Skipping ${settingsPath}: expected a JSON object`);
  process.exit(0);
}

if (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env)) {
  process.exit(0);
}

const currentValue = settings.env.ANTHROPIC_BASE_URL;
const isProxyValue = typeof currentValue === "string"
  && (currentValue === defaultProxyUrl || /^http:\/\/127\.0\.0\.1:\d+$/.test(currentValue));

if (!isProxyValue) {
  process.exit(0);
}

delete settings.env.ANTHROPIC_BASE_URL;
if (Object.keys(settings.env).length === 0) {
  delete settings.env;
}

const serialized = `${JSON.stringify(settings, null, 2)}\n`;

if (dryRun) {
  console.log(`[dry-run] remove ANTHROPIC_BASE_URL from ${settingsPath}`);
  process.exit(0);
}

fs.writeFileSync(settingsPath, serialized, "utf8");
console.log(`Updated Claude settings: ${settingsPath}`);
EOF
}

uninstall_service_macos() {
  local service_file="${HOME}/Library/LaunchAgents/${SERVICE_NAME}.plist"
  local uid service_target

  [ -e "$service_file" ] || return 0

  uid="${SUDO_UID:-$(id -u)}"
  service_target="gui/${uid}/${SERVICE_NAME}"

  if command -v launchctl >/dev/null 2>&1; then
    run_cmd launchctl bootout "gui/${uid}" "$service_file" >/dev/null 2>&1 || true
    run_cmd launchctl disable "$service_target" >/dev/null 2>&1 || true
  fi

  remove_path "$service_file"
}

uninstall_service_linux() {
  local service_file="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"

  [ -e "$service_file" ] || return 0

  if command -v systemctl >/dev/null 2>&1; then
    run_cmd systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    run_cmd systemctl --user disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi

  remove_path "$service_file"

  if command -v systemctl >/dev/null 2>&1; then
    run_cmd systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}

uninstall_package() {
  if ! command -v npm >/dev/null 2>&1; then
    log "Skipping npm uninstall: npm not found"
    return 0
  fi

  if npm ls --global "$PACKAGE_NAME" >/dev/null 2>&1; then
    run_cmd npm uninstall --global "$PACKAGE_NAME"
    return 0
  fi

  log "Global npm package not installed: $PACKAGE_NAME"
}

usage() {
  cat <<EOF
Usage:
  ./uninstall.sh [--dry-run]

Removes:
  - global npm package: ${PACKAGE_NAME}
  - user service: ${SERVICE_NAME}
  - config and logs: ${CONFIG_DIR}
  - Claude settings ANTHROPIC_BASE_URL entries that still point to this local proxy

Notes:
  - global Claude settings are cleaned at ${GLOBAL_CLAUDE_SETTINGS}
  - project-local Claude settings are cleaned only in the current directory
EOF
}

main() {
  case "${1:-}" in
    --dry-run)
      DRY_RUN=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    "")
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac

  log "Uninstalling ${PACKAGE_NAME}..."

  case "$(uname -s)" in
    Darwin)
      uninstall_service_macos
      ;;
    Linux)
      uninstall_service_linux
      ;;
    *)
      log "Skipping service cleanup on unsupported platform: $(uname -s)"
      ;;
  esac

  uninstall_package
  remove_path "$CONFIG_DIR"
  cleanup_claude_settings "$GLOBAL_CLAUDE_SETTINGS"
  cleanup_claude_settings "$PROJECT_CLAUDE_SETTINGS"
  cleanup_claude_settings "$LOCAL_CLAUDE_SETTINGS"

  log "Uninstall complete."
}

main "$@"
