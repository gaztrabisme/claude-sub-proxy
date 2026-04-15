#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="gaztrabisme"
REPO_NAME="claude-sub-proxy"
REPO_REF="${CLAUDE_SUB_PROXY_INSTALL_REF:-master}"
PACKAGE_NAME="claude-sub-proxy"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

detect_npm_global_bin() {
  local bin_path
  local prefix

  if bin_path="$(npm bin -g 2>/dev/null)"; then
    printf '%s\n' "$bin_path"
    return 0
  fi

  prefix="$(npm config get prefix 2>/dev/null || true)"
  [ -n "$prefix" ] || return 1
  printf '%s\n' "$prefix/bin"
}

path_contains_dir() {
  local dir="$1"
  case ":$PATH:" in
    *":$dir:"*) return 0 ;;
    *) return 1 ;;
  esac
}

print_path_warning() {
  local global_bin="$1"

  printf '\nWarning: %s was installed but %s is not on PATH.\n' "$PACKAGE_NAME" "$global_bin" >&2
  printf 'Add this to your shell profile, then start a new shell:\n' >&2
  printf '  export PATH="%s:$PATH"\n' "$global_bin" >&2
}

main() {
  local tmp_dir archive_url archive_path package_dir global_bin installed_cli

  tmp_dir=""
  need_cmd bash
  need_cmd curl
  need_cmd tar
  need_cmd node
  need_cmd npm

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/claude-sub-proxy.XXXXXX")"
  trap '[ -n "${tmp_dir:-}" ] && rm -rf "$tmp_dir"' EXIT

  archive_url="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${REPO_REF}.tar.gz"
  archive_path="${tmp_dir}/package.tar.gz"

  printf 'Downloading %s...\n' "$archive_url"
  curl -fsSL "$archive_url" -o "$archive_path"

  tar -xzf "$archive_path" -C "$tmp_dir"
  package_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d -name "${REPO_NAME}-*" | head -n 1)"
  [ -n "$package_dir" ] || die "failed to locate extracted package directory"

  printf 'Installing %s globally with npm...\n' "$PACKAGE_NAME"
  npm install --global "$package_dir"

  global_bin="$(detect_npm_global_bin || true)"
  installed_cli=""

  if [ -n "$global_bin" ] && [ -x "${global_bin}/${PACKAGE_NAME}" ]; then
    installed_cli="${global_bin}/${PACKAGE_NAME}"
  elif command -v "$PACKAGE_NAME" >/dev/null 2>&1; then
    installed_cli="$(command -v "$PACKAGE_NAME")"
  else
    die "installation finished but ${PACKAGE_NAME} could not be located"
  fi

  "$installed_cli" --help >/dev/null

  printf '\nInstalled: %s\n' "$installed_cli"

  if [ -n "$global_bin" ] && ! path_contains_dir "$global_bin"; then
    print_path_warning "$global_bin"
  fi

  cat <<EOF

Next steps:
  ${PACKAGE_NAME} configure init
  ${PACKAGE_NAME} configure add
  ${PACKAGE_NAME} claude install
  ${PACKAGE_NAME} service install
  ${PACKAGE_NAME} service start
EOF
}

main "$@"
