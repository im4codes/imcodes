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
PROJECT_ROOT="$(pwd)"

npm install
npm run build
npm link --force

PROJECT_ROOT="$PROJECT_ROOT" node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const projectRoot = process.env.PROJECT_ROOT;
const localManifestPath = join(projectRoot, 'dist/.build-manifest.json');
if (!existsSync(localManifestPath)) {
  throw new Error(`missing local build manifest: ${localManifestPath}`);
}
const imcodesBin = execFileSync('bash', ['-lc', 'command -v imcodes'], { encoding: 'utf8' }).trim();
if (!imcodesBin) throw new Error('imcodes is not on PATH after npm link');

let dir = dirname(realpathSync(imcodesBin));
let linkedRoot = '';
for (let i = 0; i < 8; i += 1) {
  const packageJsonPath = join(dir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (pkg.name === 'imcodes') {
        linkedRoot = dir;
        break;
      }
    } catch {
      // Keep walking upward.
    }
  }
  const next = dirname(dir);
  if (next === dir) break;
  dir = next;
}
if (!linkedRoot) throw new Error(`could not locate linked imcodes package root from ${imcodesBin}`);

const linkedManifestPath = join(linkedRoot, 'dist/.build-manifest.json');
if (!existsSync(linkedManifestPath)) {
  throw new Error(`linked package missing build manifest: ${linkedManifestPath}`);
}
const localManifest = JSON.parse(readFileSync(localManifestPath, 'utf8'));
const linkedManifest = JSON.parse(readFileSync(linkedManifestPath, 'utf8'));
const mismatches = [];
if (localManifest.buildId !== linkedManifest.buildId) {
  mismatches.push(`buildId ${localManifest.buildId} != ${linkedManifest.buildId}`);
}
for (const [rel, hash] of Object.entries(localManifest.critical ?? {})) {
  if (linkedManifest.critical?.[rel] !== hash) {
    mismatches.push(`${rel} hash mismatch`);
  }
}
if (mismatches.length > 0) {
  throw new Error(`linked imcodes build does not match checkout (${linkedRoot}):\n${mismatches.join('\n')}`);
}
console.log(`Build manifest verified (${localManifest.buildId}) against ${linkedRoot}`);
NODE

if [[ "$(uname -s)" == "Linux" ]]; then
  USER_SERVICE="$HOME/.config/systemd/user/imcodes.service"
  if [[ -f "$USER_SERVICE" ]]; then
    LOCAL_EXEC="ExecStart=$PROJECT_ROOT/bin/imcodes-launch.sh start --foreground"
    if ! grep -Fxq "$LOCAL_EXEC" "$USER_SERVICE"; then
      backup="$USER_SERVICE.bak.$(date +%Y%m%d%H%M%S)"
      cp -p -- "$USER_SERVICE" "$backup"
      tmp="$(mktemp)"
      awk -v exec_line="$LOCAL_EXEC" '
        /^ExecStart=/ { print exec_line; replaced=1; next }
        { print }
        END { if (!replaced) print exec_line }
      ' "$USER_SERVICE" >"$tmp"
      mv "$tmp" "$USER_SERVICE"
      if command -v systemd-analyze >/dev/null 2>&1 && ! systemd-analyze --user verify "$USER_SERVICE" >/dev/null 2>&1; then
        mv "$backup" "$USER_SERVICE"
        echo "Patched systemd unit failed verification; restored $backup" >&2
        exit 1
      fi
      echo "Patched systemd ExecStart to current checkout: $PROJECT_ROOT"
    fi
  fi
fi

# Spawn the restart fully detached:
#   - setsid (or `nohup` fallback) puts it in a new session so SIGHUP from the
#     parent shell exiting won't kill it.
#   - stdout/stderr go to a log so we can inspect failures.
#   - `&` + `disown` releases it from the current shell's job table.
LOG="${TMPDIR:-/tmp}/imcodes-restart-daemon.log"
echo "Detaching restart; logs: $LOG"

if [[ "$(uname -s)" == "Linux" ]]; then
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c 'systemctl --user daemon-reload && systemctl --user restart imcodes' </dev/null >>"$LOG" 2>&1 &
  else
    nohup bash -c 'systemctl --user daemon-reload && systemctl --user restart imcodes' </dev/null >>"$LOG" 2>&1 &
  fi
elif command -v setsid >/dev/null 2>&1; then
  setsid bash -c 'imcodes service restart --no-build' </dev/null >>"$LOG" 2>&1 &
else
  # macOS lacks setsid by default — `nohup` + new process group is good enough.
  nohup bash -c 'imcodes service restart --no-build' </dev/null >>"$LOG" 2>&1 &
fi
disown || true

echo "Restart dispatched (pid $!). Daemon will come back on its own."
