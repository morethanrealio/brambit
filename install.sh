#!/usr/bin/env bash
# Installs Brambit for the current user on macOS or Linux, no administrator needed:
#
#   curl -fsSL https://raw.githubusercontent.com/morethanrealio/brambit/main/install.sh | bash
#
# Downloads its own Node.js (checksums pinned below, nothing else on the computer
# changes) and Brambit, installs the `brambit` command, the shortcut and starting
# with the computer, then opens the setup page in the browser. Running it again
# updates Brambit. Your data stays in ~/.brambit and survives updates.
#
# Program folder: ~/Library/Application Support/Brambit (macOS) or
# ~/.local/share/brambit (Linux). For tests: BRAMBIT_HOME (program folder),
# BRAMBIT_SOURCE (a local copy of this repository instead of the download) and
# BRAMBIT_NO_OPEN=1 (do not start it at the end).
set -euo pipefail

BRAMBIT_VERSION="0.2.13"
NODE_VERSION="24.21.0"

say() { printf '[brambit] %s\n' "$*"; }
die() { printf '[brambit] %s\n' "$*" >&2; exit 1; }

# Everything inside a function, so a download cut in half never runs half a script.
main() {
  local os arch node_pkg node_sha
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "this installer is for macOS and Linux; on Windows use install.ps1" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "unsupported processor: $(uname -m)" ;;
  esac
  case "$os-$arch" in
    darwin-arm64) node_pkg="node-v$NODE_VERSION-darwin-arm64.tar.gz"; node_sha=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
    darwin-x64) node_pkg="node-v$NODE_VERSION-darwin-x64.tar.gz"; node_sha=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
    linux-arm64) node_pkg="node-v$NODE_VERSION-linux-arm64.tar.gz"; node_sha=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5 ;;
    linux-x64) node_pkg="node-v$NODE_VERSION-linux-x64.tar.gz"; node_sha=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff ;;
  esac
  command -v curl >/dev/null || die "curl is missing"
  command -v tar >/dev/null || die "tar is missing"

  local home="${BRAMBIT_HOME:-}"
  if [ -z "$home" ]; then
    if [ "$os" = darwin ]; then home="$HOME/Library/Application Support/Brambit"
    else home="${XDG_DATA_HOME:-$HOME/.local/share}/brambit"; fi
  fi
  mkdir -p "$home"
  # Global, not local: the EXIT trap runs after main returns.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  # An older copy running holds its files: stop it before replacing them.
  if [ -x "$home/node/bin/node" ] && [ -f "$home/app/installer/brambit.mjs" ]; then
    "$home/node/bin/node" "$home/app/installer/brambit.mjs" stop >/dev/null 2>&1 || true
  fi

  if [ "$("$home/node/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    say "downloading Node.js $NODE_VERSION"
    curl -fsSL --retry 3 -o "$tmp/$node_pkg" "https://nodejs.org/dist/v$NODE_VERSION/$node_pkg"
    local got
    if command -v sha256sum >/dev/null; then got="$(sha256sum "$tmp/$node_pkg" | cut -d' ' -f1)"
    else got="$(shasum -a 256 "$tmp/$node_pkg" | cut -d' ' -f1)"; fi
    [ "$got" = "$node_sha" ] || die "the Node.js download does not match its checksum; nothing was installed"
    mkdir -p "$tmp/node"
    tar -xzf "$tmp/$node_pkg" -C "$tmp/node" --strip-components 1
    rm -rf "$home/node"
    mv "$tmp/node" "$home/node"
  fi

  local new="$home/app.new"
  rm -rf "$new"
  mkdir -p "$new"
  if [ -n "${BRAMBIT_SOURCE:-}" ]; then
    say "copying Brambit from $BRAMBIT_SOURCE"
    tar -C "$BRAMBIT_SOURCE" --exclude ./node_modules --exclude ./.git --exclude ./.local -cf - . | tar -C "$new" -xf -
  else
    say "downloading Brambit $BRAMBIT_VERSION"
    curl -fsSL --retry 3 -o "$tmp/brambit.tar.gz" "https://github.com/morethanrealio/brambit/archive/refs/tags/v$BRAMBIT_VERSION.tar.gz"
    tar -xzf "$tmp/brambit.tar.gz" -C "$new" --strip-components 1
  fi

  say "installing what Brambit needs (this takes a few minutes)"
  (cd "$new" && PATH="$home/node/bin:$PATH" npm_config_update_notifier=false "$home/node/bin/npm" ci --no-audit --no-fund --loglevel=error) \
    || die "npm could not install Brambit's packages; the copy already installed was kept"

  rm -rf "$home/app.old"
  if [ -d "$home/app" ]; then mv "$home/app" "$home/app.old"; fi
  mv "$new" "$home/app"
  rm -rf "$home/app.old"
  printf '%s\n' "$BRAMBIT_VERSION" > "$home/.brambit-install"

  "$home/node/bin/node" "$home/app/installer/desktop.mjs" install
  say "installed in $home"
  if [ -z "${BRAMBIT_NO_OPEN:-}" ]; then
    "$home/node/bin/node" "$home/app/installer/brambit.mjs" open
  fi
}

main "$@"
