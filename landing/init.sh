#!/usr/bin/env bash
# landing/init.sh — provision a fresh Ubuntu server into the IM.codes "base".
#
# Replicates our reference dev box: a developer-friendly shell
# (nvm + mise + atuin + starship + zoxide + uv + modern CLI tools) PLUS imcodes
# and the agent CLIs (Claude Code, Codex, Qwen, Gemini), wired so the daemon's
# auto-upgrade keeps working — including in restricted-network regions.
#
# Just give it the IP and username; it ships itself over SSH and provisions:
#   ./init.sh ai@1.2.3.4
#   ./init.sh ai@1.2.3.4 --source mirror --channel dev
# Or run it ON the target directly:
#   curl -fsSL https://im.codes/init.sh | bash
#
# Hard lessons baked in (do not regress):
#   * Node via nvm in $HOME — NOT apt. `apt autoremove` has nuked /usr/bin/node
#     out from under a running daemon, which then can't upgrade (no npm) and
#     can't restart (no node). A user-owned nvm/tarball node is immune.
#   * Restricted region → Tencent mirror, NEVER npmmirror. npmmirror re-hosts
#     tarballs and refuses packages >80MB, so its `dev` dist-tag permanently
#     lags imcodes (~220MB) and the daemon "downgrades"/sticks on an old build.
#   * Record the registry in ~/.imcodes/install.json so the daemon's own
#     auto-upgrade resolves through the same source.
# Source/registry constants mirror shared/installer-contract.ts & install.sh.

# No `-u`: we source/eval third-party shell (nvm, mise activate, atuin env)
# that is not nounset-clean. `-e` + explicit checks keep us honest.
set -eo pipefail

# ── Remote driver: given user@host, ship THIS script over SSH and run it there ──
if [ "${1:-}" ] && printf '%s' "$1" | grep -q '@'; then
  TARGET="$1"; shift
  printf '\n==> provisioning %s (shipping init.sh over SSH)...\n\n' "$TARGET"
  exec ssh -o ConnectTimeout=15 "$TARGET" "bash -s -- $*" < "$0"
fi

# ─────────────────────────── on-target bootstrap ───────────────────────────────
CHANNEL="${IMCODES_CHANNEL:-dev}"
SOURCE="${IMCODES_SOURCE:-auto}"
NODE_MAJOR="${IMCODES_NODE_MAJOR:-24}"
while [ $# -gt 0 ]; do
  case "$1" in
    --channel)    CHANNEL="${2:-}"; shift 2 ;;
    --source)     SOURCE="${2:-}"; shift 2 ;;
    --node-major) NODE_MAJOR="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
case "$CHANNEL" in latest|dev) ;; *) echo "invalid --channel '$CHANNEL'" >&2; exit 1 ;; esac
case "$SOURCE"  in auto|mirror|direct) ;; *) echo "invalid --source '$SOURCE'" >&2; exit 1 ;; esac
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || { echo "invalid --node-major '$NODE_MAJOR'" >&2; exit 1; }

if [ -t 1 ]; then C='\033[36m'; G='\033[32m'; Y='\033[33m'; W='\033[37m'; N='\033[0m'; else C=''; G=''; Y=''; W=''; N=''; fi
step() { printf "${C}==> %s${N}\n" "$1"; }
ok()   { printf "    ${G}%s${N}\n" "$1"; }
note() { printf "    ${Y}%s${N}\n" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
# best-effort: run a step but never abort the whole provision on a single
# optional tool failing (the box is still usable; re-run init.sh to retry).
try()  { "$@" || note "（可选步骤失败，已跳过：$*）"; }

printf "\n  ${W}IM.codes base provisioner${N}\n  channel=%s  source=%s  node=%s  user=%s\n\n" \
  "$CHANNEL" "$SOURCE" "$NODE_MAJOR" "$(id -un)"

# ── 0. Ensure curl (needed by the probe + every installer below) ──────────────
if ! have curl; then
  step "Installing curl..."
  if have sudo && have apt-get; then sudo apt-get update -y && sudo apt-get install -y curl
  else echo "curl is required but missing and sudo/apt-get unavailable" >&2; exit 1; fi
fi

# ── 1. Source selection (restricted-network aware) ─────────────────────────────
# Probe a 204 endpoint reachable only on the open internet (mirrors install.sh /
# INSTALLER_PROBE_URL). Failure ⇒ restricted region ⇒ Tencent mirror.
use_mirror=0
case "$SOURCE" in
  mirror) use_mirror=1 ;;
  direct) use_mirror=0 ;;
  auto)
    step "Probing network..."
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' https://www.google.com/generate_204 2>/dev/null || echo 000)
    if [ "$code" = "204" ]; then ok "open internet — using direct sources"
    else use_mirror=1; ok "restricted network detected — using Tencent mirror"; fi ;;
esac
if [ "$use_mirror" = 1 ]; then
  # Tencent ONLY (see header): mirrors.cloud.tencent.com carries current imcodes.
  NPM_REGISTRY="https://mirrors.cloud.tencent.com/npm/"
  NODE_MIRROR="https://mirrors.cloud.tencent.com/nodejs-release"   # nvm honours this
else
  NPM_REGISTRY="https://registry.npmjs.org/"
  NODE_MIRROR="https://nodejs.org/dist"
fi

# ── 2. System packages (best-effort; needs passwordless sudo) ──────────────────
# Modern CLI tools that live in the distro repos. bat/fd ship as batcat/fdfind
# on Debian/Ubuntu — we symlink them to the canonical names under ~/.local/bin
# (the same arrangement as the reference box).
step "Installing base apt packages..."
mkdir -p "$HOME/.local/bin"
if have sudo && have apt-get; then
  try sudo apt-get update -y
  # Core set is in every supported Ubuntu (20.04+). eza / git-delta are newer
  # and may be absent on older releases, so install them separately — a missing
  # one must not drop the whole transaction.
  try sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git curl wget ca-certificates build-essential pkg-config unzip xz-utils \
    tmux htop jq ripgrep fd-find fzf bat
  try sudo DEBIAN_FRONTEND=noninteractive apt-get install -y eza
  try sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git-delta
  [ -x /usr/bin/batcat ] && ln -sf /usr/bin/batcat "$HOME/.local/bin/bat"
  [ -x /usr/bin/fdfind ] && ln -sf /usr/bin/fdfind "$HOME/.local/bin/fd"
else
  note "sudo/apt-get unavailable — skipping system packages"
fi

# ── 3. Node via nvm (apt-immune, user-owned) ───────────────────────────────────
step "Installing nvm + Node $NODE_MAJOR (user-owned; NOT apt)..."
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
# nvm downloads node from this mirror in restricted regions.
export NVM_NODEJS_ORG_MIRROR="$NODE_MIRROR"
nvm install "$NODE_MAJOR"
nvm alias default "$NODE_MAJOR"
nvm use default >/dev/null
ok "node $(node -v)  npm $(npm -v)"

# ── 4. npm registry + record it for the daemon's auto-upgrade ──────────────────
mkdir -p "$HOME/.imcodes"
if [ "$use_mirror" = 1 ]; then
  step "Pinning npm registry to Tencent (global + install.json)..."
  npm config set registry "$NPM_REGISTRY"
  printf '{\n  "npmRegistry": "%s"\n}\n' "$NPM_REGISTRY" > "$HOME/.imcodes/install.json"
  ok "registry -> $NPM_REGISTRY  (+ ~/.imcodes/install.json)"
else
  # direct: leave npm default; clear any stale imcodes mirror memory.
  rm -f "$HOME/.imcodes/install.json" 2>/dev/null || true
fi

# ── 5. imcodes + agent CLIs ────────────────────────────────────────────────────
# imcodes is the hard requirement; agents install independently so one missing
# package (e.g. a momentary mirror lag) can't abort the others or imcodes.
step "Installing imcodes@$CHANNEL ..."
npm install -g --no-fund --no-audit --registry "$NPM_REGISTRY" "imcodes@$CHANNEL"
ok "imcodes $(imcodes --version 2>/dev/null || echo '?')"
step "Installing agent CLIs (Claude Code / Codex / Qwen / Gemini)..."
for pkg in @anthropic-ai/claude-code @openai/codex @qwen-code/qwen-code @google/gemini-cli; do
  try npm install -g --no-fund --no-audit --registry "$NPM_REGISTRY" "$pkg"
done

# ── 6. Developer-friendly shell tooling (best-effort) ──────────────────────────
# mise (toolchain versions), uv (python), atuin (history), starship (prompt),
# zoxide (smart cd) — matching the reference box. Installers pull from their own
# CDNs / GitHub; in restricted regions they are slower but reachable.
step "Installing mise / uv / atuin / starship / zoxide..."
have mise     || try bash -c 'curl -fsSL https://mise.run | sh'
have uv       || try bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
have starship || try bash -c 'curl -fsSL https://starship.rs/install.sh | sh -s -- -y'
have zoxide   || try bash -c 'curl -fsSL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh'
if [ ! -x "$HOME/.atuin/bin/atuin" ]; then
  try bash -c 'curl -fsSL https://setup.atuin.sh | sh -s -- --no-modify-path'
fi
# atuin's bash integration needs bash-preexec.
[ -f "$HOME/.bash-preexec.sh" ] || try bash -c \
  'curl -fsSL https://raw.githubusercontent.com/rcaloras/bash-preexec/master/bash-preexec.sh -o "$HOME/.bash-preexec.sh"'

# mise toolchains (java/gradle/maven) — same as the reference box.
if have mise || [ -x "$HOME/.local/bin/mise" ]; then
  MISE="$(command -v mise || echo "$HOME/.local/bin/mise")"
  mkdir -p "$HOME/.config/mise"
  cat > "$HOME/.config/mise/config.toml" <<'TOML'
[tools]
java = "temurin-21"
gradle = "latest"
maven = "latest"
TOML
  try "$MISE" install
fi

# ── 7. Wire ~/.bashrc (one managed block, replaced on re-run) ──────────────────
step "Wiring ~/.bashrc (nvm / mise / atuin / zoxide / starship / eza)..."
BEGIN="# >>> IM.codes base (init.sh) >>>"
END="# <<< IM.codes base (init.sh) <<<"
read -r -d '' BLOCK <<'BLOCK_EOF' || true
# nvm (user-owned Node — apt-immune)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
# mise (java/gradle/maven), uv (python), atuin (history)
[ -x "$HOME/.local/bin/mise" ] && eval "$("$HOME/.local/bin/mise" activate bash)"
[ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"
[ -f "$HOME/.atuin/bin/env" ] && . "$HOME/.atuin/bin/env"
[ -f "$HOME/.bash-preexec.sh" ] && source "$HOME/.bash-preexec.sh"
command -v atuin    >/dev/null 2>&1 && eval "$(atuin init bash)"
command -v zoxide   >/dev/null 2>&1 && eval "$(zoxide init bash)"
command -v starship >/dev/null 2>&1 && eval "$(starship init bash)"
# modern ls
if command -v eza >/dev/null 2>&1; then
  alias ls="eza --group-directories-first"
  alias ll="eza -lh --group-directories-first --git"
  alias lt="eza -T --git-ignore -L 2"
fi
BLOCK_EOF
RC="$HOME/.bashrc"
touch "$RC"
if grep -qF "$BEGIN" "$RC" 2>/dev/null; then
  tmp="$(mktemp)"
  awk -v b="$BEGIN" -v e="$END" '$0==b{s=1} s==0{print} $0==e{s=0}' "$RC" > "$tmp"
  { cat "$tmp"; printf '\n%s\n%s\n%s\n' "$BEGIN" "$BLOCK" "$END"; } > "$RC"
  rm -f "$tmp"
else
  printf '\n%s\n%s\n%s\n' "$BEGIN" "$BLOCK" "$END" >> "$RC"
fi
ok "~/.bashrc managed block written"

# ── 8. Verify ──────────────────────────────────────────────────────────────────
step "Verifying toolchain..."
printf '    %-14s %s\n' node    "$(node -v 2>/dev/null || echo MISSING)"
printf '    %-14s %s\n' npm     "$(npm -v 2>/dev/null || echo MISSING)"
printf '    %-14s %s\n' imcodes "$(imcodes --version 2>/dev/null || echo MISSING)"
for pair in "claude:@anthropic-ai/claude-code" "codex:@openai/codex" "qwen:@qwen-code/qwen-code" "gemini:@google/gemini-cli"; do
  bin="${pair%%:*}"
  printf '    %-14s %s\n' "$bin" "$(command -v "$bin" >/dev/null 2>&1 && echo OK || echo 'MISSING (check npm output above)')"
done
for t in mise atuin starship zoxide uv eza rg fd bat fzf; do
  printf '    %-14s %s\n' "$t" "$(command -v "$t" >/dev/null 2>&1 && echo OK || echo '-')"
done

printf "\n  ${G}base ready.${N}\n\n"
echo "  Next steps:"
echo "    1) reconnect (or: source ~/.bashrc)   # load nvm/mise/atuin/starship"
echo "    2) imcodes bind                        # connect this box to your IM.codes server"
echo "    3) imcodes                             # start the daemon (self-upgrades from here)"
echo ""
