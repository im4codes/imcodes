#!/usr/bin/env bash
# imcodes-launch — self-healing daemon supervisor.
#
# Entry point for systemd ExecStart / launchctl ProgramArguments. Sits
# in front of the real Node entry and pre-flight-checks the global
# install for half-finished upgrades:
#
#   - if `imcodes upgrade` (or any `npm install -g imcodes@…`) gets
#     killed mid-write — power loss, OOM-kill, ssh-disconnect, etc —
#     npm leaves CRITICAL_DEPS as empty placeholder directories
#     (e.g. `node_modules/commander/` exists but has no package.json).
#     The next daemon start hits ERR_MODULE_NOT_FOUND on the FIRST
#     `import 'commander'`, exits 1, systemd Restart=always thrashes
#     forever.
#
#   - this launcher detects that signature, re-installs the SAME
#     pinned version (read from the surviving package.json — never
#     rolls forward without explicit user intent), then execs the
#     real daemon. systemd / launchctl never has to know.
#
# Pure bash by design — node_modules being broken is exactly when
# Node-side guard rails go missing too. No tool we use here lives
# under node_modules.
#
# Idempotent: if node_modules is healthy, this is just a thin wrapper
# that exec's the real entry with no overhead beyond a directory stat.
set -u

# Resolve our own real path so we can find the package root regardless
# of how npm symlinked the bin (`$PREFIX/bin/imcodes-launch ->
# ../lib/node_modules/imcodes/bin/imcodes-launch.sh`). `readlink -f`
# is GNU on Linux; on macOS we fall back to `python3 os.path.realpath`,
# and finally `$0` raw if neither is around (works when invoked via
# absolute path, which systemd always does).
resolve_self() {
  if command -v readlink >/dev/null 2>&1 && readlink -f "$0" >/dev/null 2>&1; then
    readlink -f "$0"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0"
  else
    echo "$0"
  fi
}

SELF_REAL="$(resolve_self)"
PKG_ROOT="$(cd "$(dirname "$SELF_REAL")/.." 2>/dev/null && pwd)"
ENTRY="$PKG_ROOT/dist/src/index.js"
NODE="${IMCODES_NODE_BIN:-$(command -v node 2>/dev/null || echo /usr/bin/node)}"
NPM="${IMCODES_NPM_BIN:-$(command -v npm 2>/dev/null || true)}"
HOME_DIR="${IMCODES_HOME:-$HOME}"
REPAIR_LOG="${IMCODES_LAUNCH_REPAIR_LOG:-$HOME_DIR/.imcodes/launch-repair.log}"

log() {
  echo "[imcodes-launch $(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

# Critical deps — daemon CANNOT start without these. Each is a top-level
# dependency directly required by `dist/src/index.js` or its synchronous
# transitive imports. If npm install was killed mid-tarball-extract,
# these dirs exist (npm pre-creates them before fetching) but have no
# `package.json` inside.
#
# Keep this list short and stable — over-eager checks cost startup
# latency on every healthy boot.
CRITICAL_DEPS=(commander ws cors body-parser hono "@huggingface/transformers")

# Returns 0 if a dep dir exists but lacks package.json (the half-install
# signature); 1 otherwise. A missing dep dir entirely is also fine —
# npm dedupes some packages to higher levels — only the EMPTY-DIR case
# is the smoking gun.
is_half_installed() {
  local dep_dir="$1"
  [ -d "$dep_dir" ] && [ ! -f "$dep_dir/package.json" ]
}

# Clear stale `upgrade.lock.d/` left behind by killed `imcodes upgrade`
# runs. The lock isn't a daemon-blocker on Linux/macOS (it gates only
# the next upgrade attempt — see step 0.5 of the bash upgrade script)
# but a stuck lock surprises operators ("why does my upgrade say
# 'another upgrade is in progress'?"). The bash upgrade script has a
# 1800 s stale watchdog that fires when a NEW upgrade is initiated;
# this is the same logic, but at daemon-start time, so the lock gets
# cleared even if no human-or-cron-triggered upgrade ever arrives.
#
# Cheap: a stat per startup. Idempotent: never touches a lock that's
# fresh (a real upgrade really does block daemon restarts during its
# 5–60 s install window).
LOCK_DIR="$HOME_DIR/.imcodes/upgrade.lock.d"
LOCK_STALE_AFTER_SEC="${IMCODES_LAUNCH_LOCK_STALE_AFTER_SEC:-1800}"
if [ -d "$LOCK_DIR" ]; then
  started=""
  source="none"
  if [ -f "$LOCK_DIR/started" ]; then
    started="$(cat "$LOCK_DIR/started" 2>/dev/null || true)"
    source="started-file"
  fi
  # Fall back to dir mtime if `started` was never written. `stat -c %Y`
  # is GNU; `stat -f %m` is BSD. Try both — empty (= "stat failed") is
  # treated as "unknown age", NOT zero, so we don't accidentally
  # classify a fresh lock as stale because of a probe error.
  if [ -z "$started" ]; then
    started="$(stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null || true)"
    source="dir-mtime"
  fi
  # Reject blanks / non-numerics — anything else means we couldn't
  # determine the age and SHOULD NOT decide to delete.
  case "$started" in
    ''|*[!0-9]*) started="" ;;
  esac
  if [ -n "$started" ]; then
    now="$(date +%s)"
    age=$(( now - started ))
    if [ "$age" -gt "$LOCK_STALE_AFTER_SEC" ]; then
      log "clearing stale upgrade.lock.d (age ${age}s, source=${source}, threshold ${LOCK_STALE_AFTER_SEC}s)"
      rm -rf "$LOCK_DIR" 2>/dev/null || true
    fi
  fi
fi

needs_repair=0
missing_summary=""
if [ -d "$PKG_ROOT/node_modules" ]; then
  for dep in "${CRITICAL_DEPS[@]}"; do
    d="$PKG_ROOT/node_modules/$dep"
    if is_half_installed "$d"; then
      needs_repair=1
      missing_summary="$missing_summary $dep"
    fi
  done
fi

# `dist/src/index.js` itself missing → the package files were also
# wiped (rare; tarball extraction is per-package atomic in npm v9+,
# but a corrupted disk or an accidentally-rm'd dist/ can produce
# this). Treat as needs_repair so the launcher doesn't just exec a
# missing file and lose the diagnostic.
if [ ! -f "$ENTRY" ]; then
  needs_repair=1
  missing_summary="$missing_summary dist/src/index.js"
fi

if [ "$needs_repair" = "1" ]; then
  if [ -z "$NPM" ]; then
    log "node_modules half-installed (missing:$missing_summary) but npm not on PATH — cannot self-repair"
  elif [ ! -f "$PKG_ROOT/package.json" ]; then
    log "node_modules half-installed but $PKG_ROOT/package.json missing — cannot read pinned version"
  else
    pinned="$("$NODE" -e "console.log(require('$PKG_ROOT/package.json').version)" 2>/dev/null || true)"
    if [ -z "$pinned" ]; then
      log "node_modules half-installed but pinned version unreadable — proceeding without repair"
    else
      log "node_modules half-installed (missing:$missing_summary) — reinstalling imcodes@$pinned"
      mkdir -p "$(dirname "$REPAIR_LOG")"
      # Clear the leftovers npm leaves when its rename step fails:
      #   1. `.imcodes-XXXXX` — npm's atomic-rename tempdir from the
      #      interrupted install.
      #   2. `~/.imcodes/upgrade.lock.d/` — daemon's own coordination
      #      lock from the killed `imcodes upgrade` flow.
      # Both make the next `npm install` fail with ENOTEMPTY/EBUSY.
      GLOBAL_LIB="$(dirname "$PKG_ROOT")"
      {
        echo "==== $(date '+%Y-%m-%d %H:%M:%S') self-repair start (target imcodes@$pinned) ===="
        echo "GLOBAL_LIB=$GLOBAL_LIB"
        echo "PKG_ROOT=$PKG_ROOT"
        echo "missing:$missing_summary"
      } >>"$REPAIR_LOG" 2>&1 || true
      rm -rf "$GLOBAL_LIB"/.imcodes-* "$HOME_DIR/.imcodes/upgrade.lock.d" >>"$REPAIR_LOG" 2>&1 || true
      if "$NPM" install -g --ignore-scripts --prefer-online "imcodes@$pinned" >>"$REPAIR_LOG" 2>&1; then
        log "self-repair OK"
      else
        log "self-repair FAILED — see $REPAIR_LOG"
        # Fall through and let exec fail; systemd will keep retrying
        # and the next attempt may succeed (e.g. transient network).
      fi
    fi
  fi
fi

# Hand off to the real daemon. `exec` replaces this shell so
# systemd/launchctl tracks the node PID directly — no extra hop.
exec "$NODE" "$ENTRY" "$@"
