#!/usr/bin/env bash
# sync-base.sh — one-click: replicate a box's ENTIRE user home to another box.
#
# How it works: rsync runs ON the dest, pulling from the source over a dedicated
# dest→source SSH key (generated + authorized automatically on first run). The
# rsync is launched detached (setsid) on the dest, so a dropped control-side
# connection never aborts it — this script just tails the remote log to show
# progress and can be safely re-run to re-attach.
#
# SRC and DST are REQUIRED (no hardcoded hosts). Each is `[user@]host[:port]` —
# the username defaults to `ai` and the SSH port to `22`, both overridable:
#   ./sync-base.sh 1.2.3.4 5.6.7.8                 # → ai@1.2.3.4:22  ai@5.6.7.8:22
#   ./sync-base.sh root@1.2.3.4 ai@5.6.7.8:2222    # per-side user + port
#   ./sync-base.sh 1.2.3.4 5.6.7.8 --port 2222     # set the default port for both
#   ./sync-base.sh --src ai@1.2.3.4 --dst ai@5.6.7.8
#   SRC=ai@1.2.3.4 DST=ai@5.6.7.8 ./sync-base.sh
#   ./sync-base.sh <src> <dst> --dry-run           # preview, transfer nothing
#   ./sync-base.sh <src> <dst> --delete            # mirror: remove dest-only files
#   ./sync-base.sh <src> <dst> --foreground        # run rsync inline (no detach)
#
# What is NOT cloned (see EXCLUDES) and why — these would break the dest or are
# pointless to copy:
#   .imcodes/        imcodes daemon identity (server.json bind, sessions, DB) —
#                    cloning makes two daemons share one identity. Run `imcodes
#                    bind` on the dest instead.
#   .ssh/            keep the dest's OWN keys + authorized_keys (avoid lockout)
#                    and never copy the source's private keys.
#   .nvm/            the dest keeps its own Node toolchain (from init.sh) —
#                    avoids a version clash and ~1GB of duplicate binaries.
#   caches           regenerable (.cache, npm/bun caches).
#   .config/systemd/ machine-specific service units.
set -euo pipefail

# SRC/DST are REQUIRED — no hardcoded hosts. Accept them positionally
# (`sync-base.sh src dst`), via --src/--dst, or via SRC=/DST= env vars. Each is
# `[user@]host[:port]`; --port sets the default port for any side without an
# inline `:port`.
SRC="${SRC:-}"
DST="${DST:-}"
DELETE=""
DRYRUN=""
DETACH=1
PORT=""
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --dst) DST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --delete) DELETE="--delete-after"; shift ;;
    --dry-run) DRYRUN="--dry-run"; shift ;;
    --foreground) DETACH=0; shift ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    -*) echo "unknown arg: $1" >&2; exit 1 ;;
    *) POS+=("$1"); shift ;;
  esac
done
if [ -z "$SRC" ] && [ "${#POS[@]}" -ge 1 ]; then SRC="${POS[0]}"; fi
if [ -z "$DST" ] && [ "${#POS[@]}" -ge 2 ]; then DST="${POS[1]}"; fi
if [ -z "$SRC" ] || [ -z "$DST" ]; then
  echo "error: SRC and DST are required." >&2
  echo "usage: $0 <[user@]src-host[:port]> <[user@]dst-host[:port]> [--port N] [--dry-run|--delete|--foreground]" >&2
  echo "   or: $0 --src user@host --dst user@host" >&2
  echo "   or: SRC=user@host DST=user@host $0" >&2
  exit 1
fi

DEF_PORT="${PORT:-22}"
case "$DEF_PORT" in *[!0-9]*|'') echo "error: --port must be a number (got '$DEF_PORT')" >&2; exit 1 ;; esac

# Parse "[user@]host[:port]" into _U/_H/_P (defaults: user 'ai', port $DEF_PORT).
_U=""; _H=""; _P=""
parse_endpoint() {
  local spec="$1" u h p
  case "$spec" in
    *@*) u="${spec%%@*}"; spec="${spec#*@}" ;;
    *)   u="ai" ;;
  esac
  if [[ "$spec" =~ ^(.+):([0-9]+)$ ]]; then
    h="${BASH_REMATCH[1]}"; p="${BASH_REMATCH[2]}"
  else
    h="$spec"; p="$DEF_PORT"
  fi
  _U="$u"; _H="$h"; _P="$p"
}

parse_endpoint "$SRC"; SRC_USER="$_U"; SRC_HOST="$_H"; SRC_PORT="$_P"
parse_endpoint "$DST"; DST_USER="$_U"; DST_HOST="$_H"; DST_PORT="$_P"
if [ -z "$SRC_HOST" ]; then echo "error: could not parse a host from src ('$SRC')" >&2; exit 1; fi
if [ -z "$DST_HOST" ]; then echo "error: could not parse a host from dst ('$DST')" >&2; exit 1; fi
SRC_UH="$SRC_USER@$SRC_HOST"   # user@host (no port) — for `ssh -p` + the rsync path
DST_UH="$DST_USER@$DST_HOST"
if [ "$SRC_UH:$SRC_PORT" = "$DST_UH:$DST_PORT" ]; then
  echo "error: src and dst are the same endpoint ($SRC_UH:$SRC_PORT)" >&2; exit 1
fi

say() { printf '\033[36m==> %s\033[0m\n' "$1"; }

# ── 1. Ensure DEST can ssh SOURCE passwordless (idempotent) ────────────────────
say "Ensuring $DST_UH:$DST_PORT → $SRC_UH:$SRC_PORT passwordless SSH..."
PUB=$(ssh -p "$DST_PORT" -o ConnectTimeout=10 "$DST_UH" \
  'test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N "" -C "sync-base" -f ~/.ssh/id_ed25519 >/dev/null 2>&1; cat ~/.ssh/id_ed25519.pub')
ssh -p "$SRC_PORT" -o ConnectTimeout=10 "$SRC_UH" \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '$PUB' ~/.ssh/authorized_keys || echo '$PUB' >> ~/.ssh/authorized_keys"
ssh -p "$DST_PORT" -o ConnectTimeout=10 "$DST_UH" "ssh-keyscan -p $SRC_PORT -H '$SRC_HOST' >> ~/.ssh/known_hosts 2>/dev/null || true"
ssh -p "$DST_PORT" -o ConnectTimeout=10 "$DST_UH" "ssh -p $SRC_PORT -o BatchMode=yes -o ConnectTimeout=8 '$SRC_UH' true" \
  || { echo "ERROR: $DST_UH still cannot ssh $SRC_UH passwordless (port $SRC_PORT)" >&2; exit 1; }

# ── 2. Write the exclude list on the dest ──────────────────────────────────────
ssh -p "$DST_PORT" -o ConnectTimeout=10 "$DST_UH" "cat > ~/.sync-base-excludes" <<'EXCL'
# imcodes: copy the DATA (timeline history, memory, transport, presets, hooks,
# sessions.json — the daemon recreates missing tmux sessions on start) but NOT
# the server binding (would conflict — two daemons one identity) or pure runtime
# artifacts. *.sqlite-wal/-shm are excluded globally below so a LIVE db copies
# as a consistent last-checkpoint snapshot.
.imcodes/server.json
.imcodes/logs/
.imcodes/daemon.log
.imcodes/hook-port
.imcodes/*.tmp
# keep the dest's own SSH access + Node toolchain; skip regenerable caches.
.ssh/
.nvm/
.cache/
.npm/_cacache/
.bun/install/cache/
.config/systemd/
.local/state/
.local/share/Trash/
*.sock
*.pid
*.sqlite-wal
*.sqlite-shm
EXCL

# progress2 only on a TTY (foreground): to a log file it writes \r-joined
# progress as one multi-MB "line", so the detached path uses stats2 alone.
INFO="--info=stats2"
[ "$DETACH" = 0 ] && INFO="--info=stats2,progress2"
# Double-quote the -e arg (NOT single): the detached path wraps this whole
# string in `bash -c '...'`, so any single quote here would terminate it early.
RSYNC="rsync -a --human-readable $INFO $DRYRUN $DELETE \
-e \"ssh -p $SRC_PORT\" \
--exclude-from=\$HOME/.sync-base-excludes \
$SRC_UH:/home/$SRC_USER/ /home/$DST_USER/"

# ── 3. Run rsync on the dest (detached by default), pulling from source ────────
if [ "$DETACH" = 0 ]; then
  say "rsync (foreground): $SRC_UH → $DST_UH ${DRYRUN:+[dry-run]}${DELETE:+ [mirror]}"
  exec ssh -p "$DST_PORT" -o ConnectTimeout=10 "$DST_UH" "$RSYNC"
fi

say "Launching detached rsync on $DST_UH ${DRYRUN:+[dry-run]}${DELETE:+ [mirror]}..."
ssh -p "$DST_PORT" -o ConnectTimeout=10 "$DST_UH" \
  "rm -f ~/sync-base.log; setsid bash -c '$RSYNC' >~/sync-base.log 2>&1 </dev/null & echo started pid=\$!"

say "rsync running detached on $DST_UH — Ctrl-C is safe (it keeps going); re-run to re-attach."
START=$(date +%s)
for _ in $(seq 1 240); do   # heartbeat up to ~80 min (20s interval)
  if ! ssh -p "$DST_PORT" -o ConnectTimeout=8 "$DST_UH" 'pgrep -x rsync >/dev/null 2>&1'; then
    say "rsync finished. Summary:"
    ssh -p "$DST_PORT" -o ConnectTimeout=10 "$DST_UH" 'tail -14 ~/sync-base.log'
    exit 0
  fi
  printf '    ...syncing (%d min elapsed, dest home %s)\n' \
    "$(( ($(date +%s) - START) / 60 ))" \
    "$(ssh -p "$DST_PORT" -o ConnectTimeout=8 "$DST_UH" 'du -sh ~ 2>/dev/null | cut -f1' 2>/dev/null || echo '?')"
  sleep 20
done
echo "still running after 80 min — check: ssh -p $DST_PORT $DST_UH 'tail -f ~/sync-base.log'" >&2
