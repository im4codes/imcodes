#!/usr/bin/env bash
# Rebuild, relink, and restart the local imcodes daemon service (dev only).
# Usage: ./scripts/restart-daemon.sh
#
# This upgrades the locally linked CLI/daemon from the current checkout:
#   1. install/update deps
#   2. build the repo
#   3. refresh the global npm link
#   4. restart the daemon service without rebuilding again (detached, so the
#      restart survives the parent shell / calling daemon exiting)

set -euo pipefail
cd "$(dirname "$0")/.."

npm install
npm run build
npm link --force

# Spawn the restart fully detached:
#   - setsid (or `nohup` fallback) puts it in a new session so SIGHUP from the
#     parent shell exiting won't kill it.
#   - stdout/stderr go to a log so we can inspect failures.
#   - `&` + `disown` releases it from the current shell's job table.
LOG="${TMPDIR:-/tmp}/imcodes-restart-daemon.log"
echo "Detaching restart; logs: $LOG"

if command -v setsid >/dev/null 2>&1; then
  setsid bash -c 'imcodes service restart --no-build' </dev/null >>"$LOG" 2>&1 &
else
  # macOS lacks setsid by default — `nohup` + new process group is good enough.
  nohup bash -c 'imcodes service restart --no-build' </dev/null >>"$LOG" 2>&1 &
fi
disown || true

echo "Restart dispatched (pid $!). Daemon will come back on its own."
