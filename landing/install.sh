#!/usr/bin/env bash
# IM.codes daemon — Linux / macOS one-click installer
#
#   Quick install (latest):
#     curl -fsSL https://im.codes/install.sh | bash
#
#   Dev channel:
#     curl -fsSL https://im.codes/install.sh | IMCODES_CHANNEL=dev bash
#
#   Force mirror / direct source, or pass flags:
#     curl -fsSL https://im.codes/install.sh | bash -s -- --channel dev --source mirror
#
# Behavior (no sudo):
#   1. Source auto-detect: probes a host reachable only on unrestricted networks.
#      If unreachable, assumes a restricted-network region and uses the mirror
#      for both Node downloads and the npm registry.
#   2. If npm is already on PATH it is used as-is (no Node install, no version gate);
#      only when npm is missing do we install Node (portable tarball).
#   3. Installs with a plain dist-tag (imcodes@<channel>) — no version pin and no
#      custom upgrade logic; the daemon's own auto-upgrade takes over from here.
#      To keep that auto-upgrade working without sudo, we fall back to a
#      user-writable npm prefix when the global one isn't writable; in a
#      restricted-network region we also persist the mirror registry (user ~/.npmrc)
#      so the daemon's plain `npm i -g` keeps resolving through the mirror.

set -euo pipefail

CHANNEL="${IMCODES_CHANNEL:-}"
SOURCE="${IMCODES_SOURCE:-}"
NODE_MAJOR="${IMCODES_NODE_MAJOR:-24}"
INSTALL_ROOT="${IMCODES_INSTALL_ROOT:-$HOME/.imcodes}"

# ── Validate NODE_MAJOR ───────────────────────────────────────────────────────
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]]; then
  echo "invalid --node-major '$NODE_MAJOR' (must be a number)" >&2; exit 1
fi

# ── Parse flags ───────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --channel)      CHANNEL="${2:-}"; shift 2 ;;
    --source)       SOURCE="${2:-}"; shift 2 ;;
    --node-major)   NODE_MAJOR="${2:-}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
CHANNEL="${CHANNEL:-latest}"
SOURCE="${SOURCE:-auto}"
case "$CHANNEL" in latest|dev) ;; *) echo "invalid --channel '$CHANNEL' (use: latest | dev)" >&2; exit 1 ;; esac
case "$SOURCE"  in auto|mirror|direct) ;; *) echo "invalid --source '$SOURCE' (use: auto | mirror | direct)" >&2; exit 1 ;; esac

# ── Output helpers ────────────────────────────────────────────────────────────
if [ -t 1 ]; then C='\033[36m'; G='\033[32m'; Y='\033[33m'; W='\033[37m'; N='\033[0m'; else C=''; G=''; Y=''; W=''; N=''; fi
step() { printf "${C}==> %s${N}\n" "$1"; }
ok()   { printf "    ${G}%s${N}\n" "$1"; }
note() { printf "    ${Y}%s${N}\n" "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }
have curl || have wget || { echo "need curl or wget on PATH" >&2; exit 1; }

fetch_stdout() { if have curl; then curl -fsSL -m 30 "$1"; else wget -qO- -T 30 "$1"; fi; }
fetch_file()   { if have curl; then curl -fsSL -m 600 -o "$2" "$1"; else wget -q -T 600 -O "$2" "$1"; fi; }

# verify_sha256 <file> <expected_hash> — exits non-zero on mismatch
verify_sha256() {
  if have shasum && shasum -a 256 --status -c <(echo "$2  $1") 2>/dev/null; then return 0
  elif have sha256sum && sha256sum --status -c <(echo "$2  $1") 2>/dev/null; then return 0
  else
    local actual; actual=$(sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" 2>/dev/null | awk '{print $1}')
    echo "SHA256 mismatch for $1" >&2
    echo "  expected: $2" >&2
    echo "   got:      ${actual:-?}" >&2
    return 1
  fi
}

probe() {  # open-internet check: exactly HTTP 204 within 3s (curl). Any other
           # result (block / timeout / captive-portal 200) => not open => mirror.
  if have curl; then
    local code; code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null || echo 000)
    [ "${code:-000}" = "204" ]
  else
    # wget fallback can't read the status code; best-effort reachability only.
    wget -q --spider -T 3 "$1" 2>/dev/null
  fi
}

printf "\n  ${W}IM.codes daemon installer${N}\n  channel=%s  source=%s\n\n" "$CHANNEL" "$SOURCE"

# ── Source selection ──────────────────────────────────────────────────────────
use_mirror=0
case "$SOURCE" in
  mirror) use_mirror=1 ;;
  direct) use_mirror=0 ;;
  auto)
    step "Probing network..."
    # Single 3s probe of a 204 connectivity endpoint; failure => restricted region => mirror.
    if probe https://www.google.com/generate_204; then
      ok "open internet reachable  ->  using direct source"
    else
      use_mirror=1
      ok "restricted network detected  ->  using mirror"
    fi ;;
esac

if [ "$use_mirror" = 1 ]; then
  # Single mirror vendor (Tencent): a pass-through proxy that always carries the
  # current imcodes. NOTE: npmmirror is deliberately NOT used — it re-hosts
  # tarballs and refuses packages over 80MB, so it permanently lags imcodes
  # (~220MB) and would break the daemon's auto-upgrade in a restricted-network region.
  NODE_BASE="https://mirrors.cloud.tencent.com/nodejs-release"
  NPM_REGISTRY="https://mirrors.cloud.tencent.com/npm/"
else
  NODE_BASE="https://nodejs.org/dist"
  NPM_REGISTRY=""   # keep npm default (registry.npmjs.org)
fi

# ── OS / arch ─────────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux)  NODE_OS=linux ;;
  Darwin) NODE_OS=darwin ;;
  *) echo "unsupported OS '$(uname -s)' — use install.ps1 on Windows" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  NODE_ARCH=x64 ;;
  arm64|aarch64) NODE_ARCH=arm64 ;;
  *) echo "unsupported arch '$(uname -m)'" >&2; exit 1 ;;
esac

# ── Node: use existing npm if present, otherwise install Node (portable) ──────
NPM=npm
PATH_DIR=""   # a dir we must add to PATH (portable node bin, or a user npm prefix bin)
if have npm; then
  step "Node/npm check"
  ok "found node $(node -v 2>/dev/null || echo '?'), npm $(npm -v 2>/dev/null || echo '?') — using it as-is"
  nmajor=$(node -v 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
  if [ -n "$nmajor" ] && [ "$nmajor" -lt 22 ]; then
    note "WARNING: Node $nmajor is below imcodes's required >= 22 — the daemon may fail at runtime; please upgrade Node."
  fi
else
  step "npm not found — installing Node $NODE_MAJOR (portable tarball, no sudo)..."
  ver=$(fetch_stdout "$NODE_BASE/index.json" \
        | grep -oE "\"version\":\"v${NODE_MAJOR}\.[0-9]+\.[0-9]+\"" \
        | sed 's/"version":"\(v[^"]*\)"/\1/' \
        | sort -t. -k1,1n -k2,2n -k3,3n \
        | tail -1 || true)
  [ -n "$ver" ] || { echo "could not resolve Node v$NODE_MAJOR.x from $NODE_BASE" >&2; exit 1; }
  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "IM.codes requires Node.js 22 or later (detected major: $NODE_MAJOR)" >&2
    echo "Please install Node.js 22+ and re-run, or use --node-major 22 to install Node 22." >&2
    exit 1
  fi
  pkg="node-${ver}-${NODE_OS}-${NODE_ARCH}"
  url="$NODE_BASE/$ver/$pkg.tar.gz"
  # Cross-source integrity (N1): SHASUMS is a tiny text file fetched from the
  # OFFICIAL nodejs.org even when the binary comes from a mirror — a poisoned
  # mirror cannot forge a matching hash here. Fail-closed if unreachable.
  shasums_url="https://nodejs.org/dist/$ver/SHASUMS256.txt"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp" 2>/dev/null || true' EXIT
  ok "downloading $url"
  fetch_file "$url" "$tmp/node.tar.gz"
  ok "downloading SHASUMS (from nodejs.org for verification)"
  # Fetch SHASUMS from official source — independent of NODE_BASE mirror path
  shasums=$(fetch_stdout "$shasums_url") || { echo "failed to fetch SHASUMS256.txt from $shasums_url" >&2; rm -rf "$tmp"; exit 1; }
  expected_hash=$(echo "$shasums" | grep "  $pkg.tar.gz$" | awk '{print $1}' || true)
  [ -n "$expected_hash" ] || { echo "SHA256 entry not found for $pkg.tar.gz in SHASUMS256.txt" >&2; rm -rf "$tmp"; exit 1; }
  ok "verifying SHA256 of $pkg.tar.gz ..."
  verify_sha256 "$tmp/node.tar.gz" "$expected_hash" || { rm -rf "$tmp"; exit 1; }
  node_dir="$INSTALL_ROOT/node"
  rm -rf "$node_dir"; mkdir -p "$node_dir"
  ok "extracting to $node_dir"
  tar -xzf "$tmp/node.tar.gz" -C "$node_dir"
  rm -rf "$tmp"
  node_home="$node_dir/$pkg"
  PATH_DIR="$node_home/bin"
  export PATH="$PATH_DIR:$PATH"
  NPM="$PATH_DIR/npm"
  ok "node $("$PATH_DIR/node" -v) installed"
fi

# ── Existing npm whose global dir isn't writable: use a user prefix (no sudo) ──
#    Keeps both this install and the daemon's auto-upgrade off sudo.
if [ "$NPM" = npm ]; then
  groot="$(npm root -g 2>/dev/null || true)"
  if [ -n "$groot" ] && [ -w "$groot" ]; then
    : # global is user-writable — install directly
  else
    prefix="$INSTALL_ROOT/npm-global"
    step "Global npm dir not writable — using a user prefix (no sudo): $prefix"
    mkdir -p "$prefix"
    npm config set prefix "$prefix"
    PATH_DIR="$prefix/bin"
    export PATH="$PATH_DIR:$PATH"
    ok "npm prefix -> $prefix"
  fi
fi

# ── Restricted region: persist mirror registry so daemon auto-upgrade works here ─
if [ "$use_mirror" = 1 ]; then
  step "Setting npm registry to the mirror (keeps the daemon's auto-upgrade working here)..."
  "$NPM" config set registry "$NPM_REGISTRY"
  ok "npm registry -> $NPM_REGISTRY   (revert any time: npm config delete registry)"
fi

# ── Install the daemon (plain dist-tag; no pin, no custom upgrade path) ────────
step "Installing imcodes@$CHANNEL ..."
"$NPM" install -g "imcodes@$CHANNEL" --no-fund --no-audit

# ── Persist PATH to shell rc files (only when we added a dir) ──────────────────
if [ -n "$PATH_DIR" ]; then
  marker="# added by IM.codes installer"
  line="export PATH=\"$PATH_DIR:\$PATH\""
  for rc in "$HOME/.profile" "$HOME/.bashrc"; do
    if [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ]; then
      if ! grep -qF "$PATH_DIR" "$rc" 2>/dev/null; then
        printf '\n%s\n%s\n' "$marker" "$line" >> "$rc"
      fi
    fi
  done
  # For zsh: always touch .zshrc (login shell reads it) and .zprofile
  for rc in "$HOME/.zshrc" "$HOME/.zprofile"; do
    if ! grep -qF "$PATH_DIR" "$rc" 2>/dev/null; then
      printf '\n%s\n%s\n' "$marker" "$line" >> "$rc"
    fi
  done
fi

# ── Done ──────────────────────────────────────────────────────────────────────
installed="$(imcodes --version 2>/dev/null || true)"
printf "\n  ${G}imcodes installed  %s${N}\n\n" "$installed"
echo "  Next steps:"
[ -n "$PATH_DIR" ] && echo "    1) Restart your shell  (or: export PATH=\"$PATH_DIR:\$PATH\")"
echo "    2) imcodes bind     # connect this machine to your IM.codes server"
echo "    3) imcodes          # start the daemon (it keeps itself up to date)"
echo ""
