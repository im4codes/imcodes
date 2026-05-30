#!/usr/bin/env bash
# sync-base.sh — one-click: replicate a box's ENTIRE user home to another box.
#
# How it works: rsync runs ON the dest, pulling from the source over a dedicated
# dest→source SSH key (generated + authorized automatically on first run). The
# rsync is launched detached (setsid) on the dest, so a dropped control-side
# connection never aborts it — this script just tails the remote log to show
# progress and can be safely re-run to re-attach.
#
# SRC and DST are REQUIRED (no hardcoded hosts). Usage:
#   ./sync-base.sh ai@SRC-host ai@DST-host      # positional src dst
#   ./sync-base.sh --src ai@1.2.3.4 --dst ai@5.6.7.8
#   SRC=ai@1.2.3.4 DST=ai@5.6.7.8 ./sync-base.sh
#   ./sync-base.sh <src> <dst> --dry-run        # preview, transfer nothing
#   ./sync-base.sh <src> <dst> --delete         # mirror: remove dest-only files
#   ./sync-base.sh <src> <dst> --foreground     # run rsync inline (no detach)
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
# (`sync-base.sh src dst`), via --src/--dst, or via SRC=/DST= env vars.
SRC="${SRC:-}"
DST="${DST:-}"
DELETE=""
DRYRUN=""
DETACH=1
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --dst) DST="$2"; shift 2 ;;
    --delete) DELETE="--delete-after"; shift ;;
    --dry-run) DRYRUN="--dry-run"; shift ;;
    --foreground) DETACH=0; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "unknown arg: $1" >&2; exit 1 ;;
    *) POS+=("$1"); shift ;;
  esac
done
if [ -z "$SRC" ] && [ "${#POS[@]}" -ge 1 ]; then SRC="${POS[0]}"; fi
if [ -z "$DST" ] && [ "${#POS[@]}" -ge 2 ]; then DST="${POS[1]}"; fi
if [ -z "$SRC" ] || [ -z "$DST" ]; then
  echo "error: SRC and DST are required." >&2
  echo "usage: $0 <src-user@host> <dst-user@host> [--dry-run|--delete|--foreground]" >&2
  echo "   or: $0 --src user@host --dst user@host" >&2
  echo "   or: SRC=user@host DST=user@host $0" >&2
  exit 1
fi
case "$SRC" in *@*) ;; *) echo "error: --src must be user@host (got '$SRC')" >&2; exit 1 ;; esac
case "$DST" in *@*) ;; *) echo "error: --dst must be user@host (got '$DST')" >&2; exit 1 ;; esac
if [ "$SRC" = "$DST" ]; then echo "error: src and dst are the same host ('$SRC')" >&2; exit 1; fi
SRC_USER="${SRC%@*}"; SRC_HOST="${SRC#*@}"
DST_USER="${DST%@*}"

say() { printf '\033[36m==> %s\033[0m\n' "$1"; }

# ── 1. Ensure DEST can ssh SOURCE passwordless (idempotent) ────────────────────
say "Ensuring $DST → $SRC passwordless SSH..."
PUB=$(ssh -o ConnectTimeout=10 "$DST" \
  'test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N "" -C "sync-base" -f ~/.ssh/id_ed25519 >/dev/null 2>&1; cat ~/.ssh/id_ed25519.pub')
ssh -o ConnectTimeout=10 "$SRC" \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '$PUB' ~/.ssh/authorized_keys || echo '$PUB' >> ~/.ssh/authorized_keys"
ssh -o ConnectTimeout=10 "$DST" "ssh-keyscan -H '$SRC_HOST' >> ~/.ssh/known_hosts 2>/dev/null || true"
ssh -o ConnectTimeout=10 "$DST" "ssh -o BatchMode=yes -o ConnectTimeout=8 '$SRC' true" \
  || { echo "ERROR: $DST still cannot ssh $SRC passwordless" >&2; exit 1; }

# ── 2. Write the exclude list on the dest ──────────────────────────────────────
ssh -o ConnectTimeout=10 "$DST" "cat > ~/.sync-base-excludes" <<'EXCL'
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
RSYNC="rsync -a --human-readable $INFO $DRYRUN $DELETE \
--exclude-from=\$HOME/.sync-base-excludes \
$SRC:/home/$SRC_USER/ /home/$DST_USER/"

# ── 3. Run rsync on the dest (detached by default), pulling from source ────────
if [ "$DETACH" = 0 ]; then
  say "rsync (foreground): $SRC → $DST ${DRYRUN:+[dry-run]}${DELETE:+ [mirror]}"
  exec ssh -o ConnectTimeout=10 "$DST" "$RSYNC"
fi

say "Launching detached rsync on $DST ${DRYRUN:+[dry-run]}${DELETE:+ [mirror]}..."
ssh -o ConnectTimeout=10 "$DST" \
  "rm -f ~/sync-base.log; setsid bash -c '$RSYNC' >~/sync-base.log 2>&1 </dev/null & echo started pid=\$!"

say "rsync running detached on $DST — Ctrl-C is safe (it keeps going); re-run to re-attach."
START=$(date +%s)
for _ in $(seq 1 240); do   # heartbeat up to ~80 min (20s interval)
  if ! ssh -o ConnectTimeout=8 "$DST" 'pgrep -x rsync >/dev/null 2>&1'; then
    say "rsync finished. Summary:"
    ssh -o ConnectTimeout=10 "$DST" 'tail -14 ~/sync-base.log'
    exit 0
  fi
  printf '    ...syncing (%d min elapsed, dest home %s)\n' \
    "$(( ($(date +%s) - START) / 60 ))" \
    "$(ssh -o ConnectTimeout=8 "$DST" 'du -sh ~ 2>/dev/null | cut -f1' 2>/dev/null || echo '?')"
  sleep 20
done
echo "still running after 80 min — check: ssh $DST 'tail -f ~/sync-base.log'" >&2
