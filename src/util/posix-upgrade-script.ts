/**
 * The detached Linux/macOS upgrade script, shared by the daemon's server-driven
 * upgrade and the `imcodes upgrade` CLI so there is ONE install path (lock,
 * retries, staged install, restart, health check, cooldown sentinel).
 *
 * Extracted verbatim from command-handler.ts; the install itself is now staged
 * and switched by the standalone helper `staged-package-install.mjs` (see its
 * header for the incident and the contract).
 */
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';
import { buildBashNodeDatachannelRepair } from './node-datachannel-repair-script.js';
import { buildBashSharpRepair } from './sharp-repair-script.js';
import { shellQuote } from './shell-quote.js';
import { POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE, buildPosixUpgradeLayoutRecoveryScript } from './posix-upgrade-layout-recovery.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The standalone staged-install helper: the built sibling in dist/, else the source in src/ (tsx/dev). */
export function resolveStagedInstallerPath(): string {
  const built = resolve(here, 'staged-package-install.mjs');
  if (existsSync(built)) return built;
  const dev = resolve(here, '..', '..', 'src', 'util', 'staged-package-install.mjs');
  return existsSync(dev) ? dev : built;
}

/** The service restart commands, per platform (the script runs them after the switch, and again after a rollback). */
export function buildPosixRestartCommand(input: { platform: NodeJS.Platform; home: string; stateDir: string }): string {
  if (input.platform === 'linux') {
    const userSvc = join(input.home, '.config/systemd/user/imcodes.service');
    return existsSync(userSvc)
      ? 'systemctl --user restart imcodes'
      : 'echo "No user service found. Run: imcodes bind" && exit 1';
  }
  const plist = join(input.home, 'Library/LaunchAgents/imcodes.daemon.plist');
  const pidFile = join(input.stateDir, 'daemon.pid');
  return `launchctl unload "${plist}" 2>/dev/null || true
# Kill any lingering daemon processes after unload
STALE_PID=$(cat "${pidFile}" 2>/dev/null)
if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
  kill "$STALE_PID" 2>/dev/null; sleep 2
  kill -0 "$STALE_PID" 2>/dev/null && kill -9 "$STALE_PID" 2>/dev/null
fi
launchctl load -w "${plist}"`;
}

/**
 * Write the script (and a private copy of the installer helper) into a fresh
 * scratch directory and start it fully detached: its own session, no inherited
 * stdio, unref'd. Whoever asked for the upgrade -- a daemon, a terminal, an SSH
 * session -- can disappear without touching the install.
 */
export function launchPosixUpgrade(params: Omit<PosixUpgradeScriptParams, 'logFile' | 'scriptDir' | 'statusFile' | 'atomicInstallerPath'> & { scriptDir?: string }): {
  scriptDir: string; logFile: string; statusFile: string; resultFile: string; scriptPath: string; child: ReturnType<typeof spawn>;
} {
  const scriptDir = params.scriptDir ?? mkdtempSync(join(tmpdir(), 'imcodes-upgrade-'));
  const logFile = join(scriptDir, 'upgrade.log');
  const statusFile = join(scriptDir, 'upgrade-status.json');
  const scriptPath = join(scriptDir, 'upgrade.sh');
  // The package this file lives in is replaced by the upgrade: run a copy.
  const atomicInstallerPath = join(scriptDir, 'staged-package-install.mjs');
  copyFileSync(resolveStagedInstallerPath(), atomicInstallerPath);
  writeFileSync(scriptPath, buildPosixUpgradeScript({ ...params, logFile, scriptDir, statusFile, atomicInstallerPath }), { mode: 0o755 });
  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
  return { scriptDir, logFile, statusFile, resultFile: join(scriptDir, 'upgrade-result'), scriptPath, child };
}

export interface PosixUpgradeScriptParams {
  logFile: string;
  scriptDir: string;
  statusFile: string;
  /** `--registry <url>` or '' (the official default). */
  registryArg: string;
  pkgSpec: string;
  /** Pinned version, or `latest`. */
  targetVer: string;
  /** Running version: the downgrade guard compares against it. */
  currentVer: string;
  /** The daemon being replaced; null when none is known (the CLI with no daemon running). */
  oldDaemonPid: number | null;
  nodeBin: string;
  nodeDir: string;
  stateDir: string;
  /** Shell commands that restart the service (platform specific). */
  restartCmd: string;
  cleanupAfterSec: number;
  /** Path of the copied staged-package-install.mjs. */
  atomicInstallerPath: string;
  /** Test seam: waits, in seconds (production defaults keep the original timings). */
  timing?: { settleSec?: number; healthFirstWaitSec?: number; healthExtendedWaitSec?: number };
  /** An explicit, human-requested install of an older version (the CLI): do not refuse it as a downgrade. */
  allowDowngrade?: boolean;
  /** Test seam: skip the launch-chain and CLI-wrapper rewrites (they touch $HOME). */
  skipLaunchChain?: boolean;
}

export function buildPosixUpgradeScript(params: PosixUpgradeScriptParams): string {
  const {
    logFile, scriptDir, statusFile, registryArg, pkgSpec, targetVer, currentVer, nodeBin, nodeDir, restartCmd,
    atomicInstallerPath,
  } = params;
  const CLEANUP_AFTER_SEC = params.cleanupAfterSec;
  const oldDaemonPid = params.oldDaemonPid ?? '';
  const imcodesStateDir = () => params.stateDir;
  return `#!/bin/bash
# imcodes daemon-upgrade script. Generated by daemon.upgrade.
# Runs detached, outlives the parent daemon process.
# Logs every step to "$LOG" — keep the file for 24 h after exit so a
# stuck or failed restart can be diagnosed post-hoc.

LOG="${logFile}"
SCRIPT_DIR="${scriptDir}"
UPGRADE_STATUS_FILE="${statusFile}"
CLEANUP_AFTER_SEC=${CLEANUP_AFTER_SEC}
REGISTRY_ARG="${registryArg}"
log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*" >> "$LOG"; }

# Outlive whoever started us: the SSH session, terminal or daemon that spawned
# this script may vanish at any moment, and an interrupted install is exactly
# what this script exists to prevent.
trap '' HUP
ATOMIC_INSTALLER=${shellQuote(atomicInstallerPath)}
SKIP_LAUNCH_CHAIN=${params.skipLaunchChain ? 1 : 0}
ALLOW_DOWNGRADE=${params.allowDowngrade ? 1 : 0}
SETTLE_SEC=${params.timing?.settleSec ?? 3}
HEALTH_FIRST_WAIT_SEC=${params.timing?.healthFirstWaitSec ?? 14}
HEALTH_EXTENDED_WAIT_SEC=${params.timing?.healthExtendedWaitSec ?? 120}
# One line the caller (the \`imcodes upgrade\` CLI, tests) waits for: how this run ended.
# ok | noop | refused | skipped | rolled_back | failed
UPGRADE_RESULT_FILE="$SCRIPT_DIR/upgrade-result"
UPGRADE_RESULT="failed"
SWITCHED=0
write_upgrade_result() {
  printf '%s\n' "$UPGRADE_RESULT" > "$UPGRADE_RESULT_FILE.tmp.$$" 2>/dev/null && mv "$UPGRADE_RESULT_FILE.tmp.$$" "$UPGRADE_RESULT_FILE" 2>/dev/null
}
finish_upgrade() {
  # A staged package that was never switched in must not linger.
  if [ "$SWITCHED" != "1" ] && [ -n "\${STAGE_PREFIX:-}" ]; then rm -rf "$STAGE_PREFIX" 2>/dev/null; fi
  release_upgrade_lock
  write_upgrade_result
}
trap finish_upgrade EXIT

${buildPosixUpgradeLayoutRecoveryScript()}

write_install_failure_status() {
  local retry_reason="$1"
  local attempts="$2"
  local exit_code="$3"
  local status_tmp="$UPGRADE_STATUS_FILE.tmp.$$"
  printf '{"state":"blocked","reason":"${DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED}","retryReason":"%s","attempts":%s,"exitCode":%s}\\n' \
    "$retry_reason" "$attempts" "$exit_code" > "$status_tmp" 2>>"$LOG" || return 1
  mv "$status_tmp" "$UPGRADE_STATUS_FILE" 2>>"$LOG"
}

# Old attempts' script directories (logs, the staged installer) are removed by the NEXT attempt, not by a timer: a
# background sleeper (sleep, then remove) per attempt left one process per attempt behind for a day (26 of them on a Mac whose
# install kept failing and retrying). Only directories that look exactly like ours are touched: a direct child of the
# directory this attempt's own script directory is in, named imcodes-upgrade-*, owned by this user, holding an upgrade.sh,
# untouched for the retention time (the 24 h the logs are kept for diagnosis), never this attempt's own directory; at most 64
# per run.
sweep_old_upgrade_dirs() {
  [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR" ] || return 0
  case "$(basename "$SCRIPT_DIR")" in imcodes-upgrade-*) ;; *) return 0 ;; esac
  SWEEP_PARENT=$(dirname "$SCRIPT_DIR")
  SWEEP_MINUTES=$(( CLEANUP_AFTER_SEC / 60 ))
  SWEEP_COUNT=0
  find "$SWEEP_PARENT" -maxdepth 1 -type d -name 'imcodes-upgrade-*' -user "$(id -u)" -mmin "+$SWEEP_MINUTES" 2>/dev/null | while IFS= read -r OLD_DIR; do
    [ "$OLD_DIR" = "$SCRIPT_DIR" ] && continue
    [ -f "$OLD_DIR/upgrade.sh" ] || continue
    [ -L "$OLD_DIR" ] && continue
    SWEEP_COUNT=$(( SWEEP_COUNT + 1 ))
    [ "$SWEEP_COUNT" -gt 64 ] && break
    rm -rf "$OLD_DIR" 2>/dev/null && log "[cleanup] removed old upgrade directory: $(basename "$OLD_DIR")"
  done
  return 0
}

schedule_self_cleanup() {
  if [ -z "$SCRIPT_DIR" ] || [ ! -d "$SCRIPT_DIR" ]; then
    return 0
  fi

  sweep_old_upgrade_dirs

  if [ "$(uname)" = "Linux" ]; then
    if command -v systemd-run >/dev/null 2>&1; then
      CLEANUP_LABEL=$(printf '%s' "$(basename "$SCRIPT_DIR")" | tr -c 'A-Za-z0-9_.-' '-')
      CLEANUP_UNIT="imcodes-upgrade-cleanup-$CLEANUP_LABEL"
      if systemd-run --user --unit="$CLEANUP_UNIT" --collect --quiet /bin/sh -c 'sleep "$1"; rm -rf "$2"' imcodes-upgrade-cleanup "$CLEANUP_AFTER_SEC" "$SCRIPT_DIR" >> "$LOG" 2>&1; then
        log "[cleanup] scheduled via systemd-run user unit: $CLEANUP_UNIT"
        return 0
      fi
      log "[cleanup] systemd-run scheduling failed (non-fatal); $SCRIPT_DIR is removed by a later upgrade attempt"
    else
      log "[cleanup] systemd-run unavailable; $SCRIPT_DIR is removed by a later upgrade attempt"
    fi
    log "[cleanup] skipped background sleeper on Linux to avoid leaking into imcodes.service cgroup"
    return 0
  fi

  # No timer process elsewhere either (a sleeper per attempt piled up): a later upgrade attempt removes this directory
  # once it is older than the retention time.
  log "[cleanup] $SCRIPT_DIR is removed by a later upgrade attempt after $CLEANUP_AFTER_SEC s"
}

log "=== imcodes upgrade started ==="
log "[step 0] daemon PID at gen time: ${oldDaemonPid}"
log "[step 0] node bin: ${nodeBin}"
log "[step 0] target: ${pkgSpec} (current daemon version: ${currentVer})"
log "[step 0] registry: \${REGISTRY_ARG:-<npm default>}"

# ── Single-flight guard ─────────────────────────────────────────────────
#
# npm global installs are NOT atomic: a failed or concurrent
# \`npm install -g imcodes@...\` can remove/replace the global package while a
# second upgrade has already installed a good copy.  Keep the old daemon
# serving while the install runs, but allow only ONE upgrade script to touch
# the global install / service restart path at a time.
IMCODES_STATE_DIR=${shellQuote(imcodesStateDir())}
UPGRADE_LOCK_DIR="$IMCODES_STATE_DIR/upgrade.lock.d"
UPGRADE_LOCK_PID="$UPGRADE_LOCK_DIR/pid"
UPGRADE_LOCK_STARTED="$UPGRADE_LOCK_DIR/started"
UPGRADE_LOCK_STALE_AFTER_SEC=1800
UPGRADE_LOCK_HELD=0

lock_age_seconds() {
  local started now
  started=$(cat "$UPGRADE_LOCK_STARTED" 2>/dev/null || true)
  now=$(date +%s)
  case "$started" in
    ''|*[!0-9]*)
      # If a prior process crashed between mkdir and writing the started
      # file, fall back to the lock directory's mtime so it can still expire.
      started=$(stat -c %Y "$UPGRADE_LOCK_DIR" 2>/dev/null || stat -f %m "$UPGRADE_LOCK_DIR" 2>/dev/null || echo "$now")
      case "$started" in
        ''|*[!0-9]*) echo 0 ;;
        *) echo $((now - started)) ;;
      esac
      ;;
    *) echo $((now - started)) ;;
  esac
}

acquire_upgrade_lock() {
  mkdir -p "$IMCODES_STATE_DIR" 2>/dev/null || true
  while true; do
    if mkdir "$UPGRADE_LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$UPGRADE_LOCK_PID" 2>/dev/null || true
      date +%s > "$UPGRADE_LOCK_STARTED" 2>/dev/null || true
      UPGRADE_LOCK_HELD=1
      log "[step 0.5] acquired upgrade lock: $UPGRADE_LOCK_DIR"
      return 0
    fi

    LOCK_OWNER=$(cat "$UPGRADE_LOCK_PID" 2>/dev/null || true)
    LOCK_AGE=$(lock_age_seconds)
    if [ -n "$LOCK_OWNER" ] && kill -0 "$LOCK_OWNER" 2>/dev/null; then
      log "[step 0.5] another upgrade is already running (pid $LOCK_OWNER, age \${LOCK_AGE}s) — exiting without touching npm/service"
      return 1
    fi
    if [ -z "$LOCK_OWNER" ] && [ "$LOCK_AGE" -lt "$UPGRADE_LOCK_STALE_AFTER_SEC" ]; then
      log "[step 0.5] upgrade lock exists without owner (age \${LOCK_AGE}s) — treating as active, exiting"
      return 1
    fi

    STALE_LOCK="\${UPGRADE_LOCK_DIR}.stale.$$"
    log "[step 0.5] removing stale upgrade lock (owner: \${LOCK_OWNER:-unknown}, age \${LOCK_AGE}s)"
    if mv "$UPGRADE_LOCK_DIR" "$STALE_LOCK" 2>/dev/null; then
      rm -rf "$STALE_LOCK"
      # Loop back and acquire with mkdir; if another process won the race,
      # mkdir will fail and we'll re-check the new owner.
      continue
    fi

    log "[step 0.5] lost race while clearing stale upgrade lock — exiting"
    return 1
  done
}

release_upgrade_lock() {
  if [ "$UPGRADE_LOCK_HELD" = "1" ]; then
    OWNER=$(cat "$UPGRADE_LOCK_PID" 2>/dev/null || true)
    if [ "$OWNER" = "$$" ]; then
      rm -rf "$UPGRADE_LOCK_DIR"
      log "[step 0.5] released upgrade lock"
    else
      log "[step 0.5] not releasing upgrade lock; owner changed to \${OWNER:-unknown}"
    fi
  fi
}

if ! acquire_upgrade_lock; then
  log "=== upgrade skipped: another upgrade is in progress ==="
  UPGRADE_RESULT="skipped"
  schedule_self_cleanup
  exit 0
fi
# A daemon that is up now must be up again afterwards; if none is running,
# nothing is expected of the restart (a machine without a service, say).
DAEMON_WAS_RUNNING=0
PRE_PID=$(cat "$IMCODES_STATE_DIR/daemon.pid" 2>/dev/null || true)
if [ -n "$PRE_PID" ] && kill -0 "$PRE_PID" 2>/dev/null; then DAEMON_WAS_RUNNING=1; fi
log "[step 0.6] daemon running before the upgrade: $DAEMON_WAS_RUNNING"

# Make node visible to everything we spawn (npm post-install scripts,
# node-gyp, the freshly-installed imcodes --version probe, etc).
# Critical on nvm/fnm/volta where node lives outside system PATH.
export PATH="${nodeDir}:$PATH"
log "[step 0] PATH=$PATH"

# Discover npm-cli.js dynamically — works for any node install method
# (Homebrew, nvm, fnm, volta, system pkg, snap, plain tarball, custom).
# Strategy ordering: most reliable first, fall through on failure.
NODE="${nodeBin}"
NPM_CLI=""

# Strategy 1: ask npm itself where it's installed. The shebang in
# <nodeDir>/npm will find node (we just exported PATH), so this works
# regardless of how the user installed node.
if [ -z "$NPM_CLI" ]; then
  NPM_PREFIX=$(npm prefix -g 2>>"$LOG")
  if [ -n "$NPM_PREFIX" ] && [ -f "$NPM_PREFIX/lib/node_modules/npm/bin/npm-cli.js" ]; then
    NPM_CLI="$NPM_PREFIX/lib/node_modules/npm/bin/npm-cli.js"
    log "[step 0] npm-cli.js via npm prefix -g: $NPM_CLI"
  fi
fi

# Strategy 2: realpath the npm sibling next to node. Handles symlink-
# based installs (Homebrew, nvm, fnm — even when their layouts diverge).
if [ -z "$NPM_CLI" ] && [ -e "${nodeDir}/npm" ]; then
  RESOLVED=$(readlink -f "${nodeDir}/npm" 2>/dev/null || readlink "${nodeDir}/npm" 2>/dev/null)
  case "$RESOLVED" in
    *npm-cli.js)
      if [ -f "$RESOLVED" ]; then
        NPM_CLI="$RESOLVED"
        log "[step 0] npm-cli.js via realpath \\\${nodeDir}/npm: $NPM_CLI"
      fi
      ;;
  esac
fi

# Strategy 3: probe known relative-from-nodeDir layouts.
if [ -z "$NPM_CLI" ]; then
  for CANDIDATE in \
    "${nodeDir}/../lib/node_modules/npm/bin/npm-cli.js" \
    "${nodeDir}/../../../lib/node_modules/npm/bin/npm-cli.js" \
    "${nodeDir}/node_modules/npm/bin/npm-cli.js" \
  ; do
    if [ -f "$CANDIDATE" ]; then
      NPM_CLI="$CANDIDATE"
      log "[step 0] npm-cli.js via candidate probe: $NPM_CLI"
      break
    fi
  done
fi

# Strategy 4: fall back to bare \`npm\` on PATH (PATH already includes nodeDir).
# The shebang chain still works because node is on PATH from our export.
if [ -z "$NPM_CLI" ]; then
  log "[step 0] npm-cli.js NOT located via any strategy — using bare 'npm' from PATH"
  NPM_RUN='npm'
else
  NPM_RUN="\\"$NODE\\" \\"$NPM_CLI\\""
fi
log "[step 0] npm runner: $NPM_RUN"

# Give the running daemon a moment to finish in-flight responses.
sleep "$SETTLE_SEC"

log "[step 1] discover global package root"
GLOBAL_ROOT=$(eval "$NPM_RUN root -g" 2>>"$LOG")
log "[step 1] global root: $GLOBAL_ROOT"
GLOBAL_PKG="$GLOBAL_ROOT/imcodes"
NPM_GLOBAL_PREFIX=$(eval "$NPM_RUN prefix -g" 2>>"$LOG")
BIN_DIR=""
if [ -n "$NPM_GLOBAL_PREFIX" ]; then BIN_DIR="$NPM_GLOBAL_PREFIX/bin"; fi
# The stage lives next to the global root (same filesystem: the switch is two renames).
STAGE_PREFIX="$(dirname "$GLOBAL_ROOT")/.imcodes-stage.$$"
UPGRADE_TAG="$$"
REGISTRY_URL="\${REGISTRY_ARG#--registry }"
ATOMIC_ARGS=(--global-root "$GLOBAL_ROOT" --pkg "${pkgSpec}" --target "${targetVer}" --node "$NODE" --npm-cli "$NPM_CLI" --registry "$REGISTRY_URL" --bin-dir "$BIN_DIR")

# A previous run that died between its two renames leaves no live package.
"$NODE" "$ATOMIC_INSTALLER" recover "\${ATOMIC_ARGS[@]}" >> "$LOG" 2>&1 || log "[step 1.4] recovery pass reported a problem (continuing)"

# npm's rename destination is created before the incoming package's
# preinstall hook can run, so the package-level cleanup cannot heal this
# failure. Remove interrupted reify leftovers here, before npm starts.
cleanup_stale_imcodes_staging_dirs "$GLOBAL_ROOT" "$UPGRADE_LOCK_STALE_AFTER_SEC" \
  || log "[step 1.5] stale npm staging cleanup was incomplete; install may retry targeted recovery"

# Remove existing npm link if any — it shadows install and prevents real upgrade.
if [ -L "$GLOBAL_PKG" ]; then
  log "[step 1] removing pre-existing npm link: $GLOBAL_PKG -> $(readlink "$GLOBAL_PKG")"
  eval "$NPM_RUN uninstall -g imcodes" >> "$LOG" 2>&1 || log "[step 1] uninstall returned non-zero (ignored)"
fi

log "[step 2] installing ${pkgSpec}"
# --ignore-scripts: \`scripts/strip-onnxruntime-gpu.mjs\` strips
# \`node_modules/sharp/\` from the published tarball so npm re-resolves it on
# the user's actual platform (otherwise the Linux-built bundle ships a
# Linux-only sharp wrapper that can't load on macOS/Windows). When npm
# re-resolves sharp during a global install, sharp's \`install\` hook
# (\`node install/check.js || npm run build\`) fails with MODULE_NOT_FOUND
# in a way we couldn't reproduce in nested project installs — npm seems
# to half-extract sharp under \`<global>/imcodes/node_modules/sharp/\` (the
# install/ directory ends up missing) and then runs the hook anyway. The
# fallback \`npm run build\` then walks UP into imcodes's package.json,
# tries to run imcodes's \`tsc\` build, and exits 127 because tsc isn't on
# the global PATH. Net effect: every auto-upgrade since the strip-sharp
# change has been failing with exit 127 and operators were getting
# \`Cannot find module .../sharp/install/check.js\` in upgrade.log.
#
# Skipping install scripts is safe here because (a) sharp 0.34's runtime
# binary is the prebuilt \`@img/sharp-<platform>-<arch>\` package (which
# npm STILL fetches and unpacks because it's a regular optionalDependency
# of sharp — no install script involvement), and (b) the only thing
# install/check.js does is dlopen-test that prebuilt; if it fails
# check.js falls back to compiling from source (npm run build), which
# we never want on a user machine anyway.
#
# After the install we probe \`sharp/package.json\`. If npm left an empty
# placeholder dir (the half-extract pathology above), do a one-shot
# \`npm install\` from inside the global package to repopulate it. Run with
# --ignore-scripts again for the same reason.
#
# ── Retry on publish propagation / transient network failures ──────────
# Real-world failure mode caught on a production daemon: server publishes a
# new dev release to npm and broadcasts \`daemon.upgrade { targetVersion }\`
# almost immediately. npm origin has the version but the regional CDN
# edge serving this daemon hasn't replicated yet — so the packument
# response is a 200 missing the new version → npm exits with ETARGET.
# Pre-fix this either killed the upgrade for that release or, worse, ran
# \`npm cache clean --force\`, deleting every cached dependency on the box.
# The eventual successful install then had to redownload 200+ packages and
# took minutes. We now use a cheap \`npm view\` precheck for pinned versions,
# avoid full-cache wipes, and retry transient network failures like
# ECONNRESET/ETIMEDOUT/EAI_AGAIN.
INSTALL_OUT="${scriptDir}/install-attempt.log"
INSTALL_RC=1
ATTEMPT=0
MAX_ATTEMPTS=5
RETRY_REASON="not-classified"
# Indexed sequentially with $ATTEMPT (1-based), so element 0 is unused.
# 15s / 30s / 60s / 120s keeps the common npm publish-CDN window quick
# without stretching a bad target into a 10-minute local stall.
RETRY_DELAYS=(0 15 30 60 120)

is_etarget_output() {
  grep -qiE 'code ETARGET|No matching version found' "$1" 2>/dev/null
}

is_transient_npm_output() {
  grep -qiE 'code (ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)|network aborted|socket timeout|fetch failed|network socket disconnected|5[0-9][0-9]' "$1" 2>/dev/null
}

while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  log "[step 2] install attempt $ATTEMPT/$MAX_ATTEMPTS"
  : > "$INSTALL_OUT"

  if [ "${targetVer}" != "latest" ]; then
    log "[step 2] registry visibility precheck for ${pkgSpec}"
    eval "$NPM_RUN view --prefer-online \${REGISTRY_ARG} ${pkgSpec} version" >> "$INSTALL_OUT" 2>&1
    VIEW_RC=$?
    cat "$INSTALL_OUT" >> "$LOG"
    if [ "$VIEW_RC" -ne 0 ] && is_etarget_output "$INSTALL_OUT"; then
      RETRY_REASON="target-not-visible"
      log "[step 2] ${pkgSpec} not visible in registry yet"
      if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
        log "[step 2] target never became visible across $MAX_ATTEMPTS attempts — giving up before heavyweight install"
        INSTALL_RC=$VIEW_RC
        break
      fi
      DELAY=\${RETRY_DELAYS[$ATTEMPT]}
      log "[step 2] waiting \${DELAY}s for npm publish propagation"
      sleep "$DELAY"
      continue
    fi
    if [ "$VIEW_RC" -ne 0 ]; then
      log "[step 2] registry precheck failed (exit $VIEW_RC); trying install anyway"
    fi
    : > "$INSTALL_OUT"
  fi

  # --prefer-online: tell npm to revalidate cached packument metadata
  # rather than serve potentially-stale entries. Do NOT use \`npm cache
  # clean --force\` here: it wipes cached dependency tarballs too, which is
  # exactly what made upgrades on large SDK dependency sets feel glacial.
  # Staged install: npm writes into a sibling prefix, never into the live
  # package. The helper preflights the prefix (writable) and the disk (2x the
  # package), and appends npm's own output to $INSTALL_OUT for the classifier.
  "$NODE" "$ATOMIC_INSTALLER" stage "\${ATOMIC_ARGS[@]}" --stage-prefix "$STAGE_PREFIX" --npm-output "$INSTALL_OUT" >> "$LOG" 2>&1
  INSTALL_RC=$?
  # Always tee the attempt's output into the main log for forensics.
  cat "$INSTALL_OUT" >> "$LOG"
  # A helper that exits 0 must have produced the staged package; never trust the exit code alone.
  if [ "$INSTALL_RC" -eq 0 ] && [ ! -d "$STAGE_PREFIX/lib/node_modules/imcodes" ]; then
    log "[step 2] the staging helper reported success but no staged package exists — treating as a failed install"
    INSTALL_RC=75
  fi
  if [ "$INSTALL_RC" -eq 0 ]; then
    log "[step 2] install attempt $ATTEMPT succeeded"
    break
  fi
  log "[step 2] install attempt $ATTEMPT failed (exit $INSTALL_RC)"
  # Not worth retrying, and nothing was changed: say so plainly.
  if [ "$INSTALL_RC" = "76" ]; then
    RETRY_REASON="prefix-not-writable"
    log "[step 2] the npm global prefix is not writable by this user — nothing was changed; see the message above"
    break
  fi
  if [ "$INSTALL_RC" = "77" ]; then
    RETRY_REASON="low-disk"
    log "[step 2] not enough free disk for a staged install — nothing was changed; see the message above"
    break
  fi
  IS_RETRYABLE=0
  RETRY_REASON="non-retryable"
  if is_etarget_output "$INSTALL_OUT"; then
    IS_RETRYABLE=1
    RETRY_REASON="target-not-visible"
  elif is_transient_npm_output "$INSTALL_OUT"; then
    IS_RETRYABLE=1
    RETRY_REASON="transient-network"
  elif is_recoverable_layout_output "$INSTALL_OUT" "$GLOBAL_ROOT"; then
    IS_RETRYABLE=1
    RETRY_REASON="stale-staging-dir"
    if ! recover_stale_layout_from_output "$INSTALL_OUT" "$GLOBAL_ROOT"; then
      log "[step 2] targeted stale staging cleanup failed; retrying remains bounded"
    fi
  fi
  if [ "$IS_RETRYABLE" -ne 1 ]; then
    log "[step 2] non-retryable npm failure — not retrying. Tail of npm output:"
    tail -20 "$INSTALL_OUT" | while IFS= read -r line; do log "[step 2]   $line"; done
    break
  fi
  if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
    log "[step 2] retryable npm failure ($RETRY_REASON) persisted across $MAX_ATTEMPTS attempts"
    break
  fi
  DELAY=\${RETRY_DELAYS[$ATTEMPT]}
  log "[step 2] retryable npm failure ($RETRY_REASON) — retrying in \${DELAY}s"
  sleep "$DELAY"
done
if [ "$INSTALL_RC" -ne 0 ]; then
  log "[step 2] install FAILED after $ATTEMPT attempts (final exit $INSTALL_RC) — keeping current daemon running"
  write_install_failure_status "$RETRY_REASON" "$ATTEMPT" "$INSTALL_RC" \
    || log "[step 2] failed to write upgrade status marker: $UPGRADE_STATUS_FILE"
  log "=== upgrade aborted ==="
  schedule_self_cleanup
  exit ${POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE}
fi
log "[step 2] staged install succeeded after $ATTEMPT attempt(s)"

# The repairs run on the STAGED package, so what gets switched in is complete.
export IMCODES_REPAIR_ROOT="$STAGE_PREFIX/lib/node_modules"
${buildBashSharpRepair()}

${buildBashNodeDatachannelRepair()}
unset IMCODES_REPAIR_ROOT

# Verify the staged package BEFORE it can replace anything: bins present, entry
# script runs and prints the target version. A failure leaves the live package untouched.
log "[step 2.5] verifying the staged package"
VERIFY_OUT=$("$NODE" "$ATOMIC_INSTALLER" verify --stage-prefix "$STAGE_PREFIX" --target "${targetVer}" --node "$NODE" 2>>"$LOG")
VERIFY_RC=$?
printf '%s\n' "$VERIFY_OUT" | grep -v '^VERIFIED_VERSION=' >> "$LOG"
INSTALLED_VER=$(printf '%s\n' "$VERIFY_OUT" | sed -n 's/^VERIFIED_VERSION=//p' | tail -1)
if [ "$VERIFY_RC" -eq 0 ] && [ -z "$INSTALLED_VER" ]; then
  # Exit 0 without a version means the helper did not actually verify anything.
  VERIFY_RC=1
  log "[step 2.5] the verifier reported no version — treating that as a failed verification"
fi
if [ "$VERIFY_RC" -ne 0 ]; then
  log "[step 2.5] staged package FAILED verification (exit $VERIFY_RC) — the current install is untouched and keeps running"
  write_install_failure_status "verify-failed" "$ATTEMPT" "$VERIFY_RC" \
    || log "[step 2.5] failed to write upgrade status marker: $UPGRADE_STATUS_FILE"
  log "=== upgrade aborted ==="
  schedule_self_cleanup
  exit ${POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE}
fi
log "[step 3] staged version: $INSTALLED_VER, target: ${targetVer}"

NEW_IMCODES_SCRIPT="$GLOBAL_ROOT/imcodes/dist/src/index.js"
NEW_LAUNCHER="$GLOBAL_ROOT/imcodes/bin/imcodes-launch.sh"

repair_cli_wrappers() {
  if [ "$SKIP_LAUNCH_CHAIN" = "1" ]; then
    log "[step 3.6] skipped (SKIP_LAUNCH_CHAIN)"
    return 0
  fi
  if [ ! -f "$NEW_IMCODES_SCRIPT" ]; then
    log "[step 3.6] $NEW_IMCODES_SCRIPT not found — skipping CLI wrapper repair"
    return 0
  fi

  WRAPPER_TMP="$SCRIPT_DIR/imcodes-cli-wrapper"
  {
    printf '%s\\n' '#!/bin/sh'
    printf 'exec "%s" "%s" "$@"\\n' "$NODE" "$NEW_IMCODES_SCRIPT"
  } > "$WRAPPER_TMP" || {
    log "[step 3.6] failed to write temporary CLI wrapper (non-fatal)"
    return 0
  }
  chmod 755 "$WRAPPER_TMP" 2>/dev/null || true

  USER_BIN="$HOME/.local/bin"
  USER_SHIM="$USER_BIN/imcodes"
  if mkdir -p "$USER_BIN" 2>/dev/null; then
    if rm -f "$USER_SHIM" 2>/dev/null && cp "$WRAPPER_TMP" "$USER_SHIM" 2>/dev/null && chmod 755 "$USER_SHIM" 2>/dev/null; then
      log "[step 3.6] refreshed CLI wrapper: $USER_SHIM"
    else
      log "[step 3.6] failed to refresh $USER_SHIM (non-fatal)"
    fi
  else
    log "[step 3.6] failed to create $USER_BIN (non-fatal)"
  fi

  case "$(uname)" in
    Linux|Darwin)
      GLOBAL_SHIM="/usr/local/bin/imcodes"
      if [ ! -d "/usr/local/bin" ]; then
        log "[step 3.6] /usr/local/bin absent — skipped global CLI wrapper"
      elif rm -f "$GLOBAL_SHIM" 2>/dev/null && cp "$WRAPPER_TMP" "$GLOBAL_SHIM" 2>/dev/null && chmod 755 "$GLOBAL_SHIM" 2>/dev/null; then
        log "[step 3.6] refreshed CLI wrapper: $GLOBAL_SHIM"
      elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        if sudo install -m 755 "$WRAPPER_TMP" "$GLOBAL_SHIM" >> "$LOG" 2>&1; then
          log "[step 3.6] refreshed CLI wrapper with sudo: $GLOBAL_SHIM"
        else
          log "[step 3.6] sudo install failed for $GLOBAL_SHIM (non-fatal)"
        fi
      else
        log "[step 3.6] skipped $GLOBAL_SHIM: not writable and passwordless sudo unavailable"
      fi
      ;;
  esac
}

# Downgrade guard — refuse to restart if installed < current daemon.
# Catches: server broadcasts \`latest\` but npm's "latest" dist-tag
# resolves to an older release than the operator's local dev build.
CURRENT_VER="${currentVer}"
"$NODE" -e "
  const a = process.argv[1], b = process.argv[2];
  const parse = v => { const i = v.indexOf('-'); return { rel: (i<0?v:v.slice(0,i)).split('.').map(n => parseInt(n,10)||0), pre: i<0 ? null : v.slice(i+1).split('.') }; };
  const A = parse(a), B = parse(b);
  const len = Math.max(A.rel.length, B.rel.length);
  for (let i = 0; i < len; i++) { const da = A.rel[i]||0, db = B.rel[i]||0; if (da !== db) process.exit(da < db ? 1 : 2); }
  if (A.pre === null && B.pre === null) process.exit(0);
  if (A.pre === null) process.exit(2);
  if (B.pre === null) process.exit(1);
  const plen = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < plen; i++) {
    const pa = A.pre[i]||'', pb = B.pre[i]||'';
    const na = /^\\d+\$/.test(pa) ? parseInt(pa,10) : null;
    const nb = /^\\d+\$/.test(pb) ? parseInt(pb,10) : null;
    if (na !== null && nb !== null) { if (na !== nb) process.exit(na < nb ? 1 : 2); }
    else if (pa !== pb) process.exit(pa < pb ? 1 : 2);
  }
  process.exit(0);
" "$INSTALLED_VER" "$CURRENT_VER"
CMP=$?
# Exit codes: 0=equal, 1=installed<current (downgrade), 2=installed>current (upgrade)
if [ "$CMP" = "1" ] && [ "$ALLOW_DOWNGRADE" = "1" ]; then
  log "[step 3] installed $INSTALLED_VER is older than current $CURRENT_VER — installing it anyway: an older version was requested explicitly"
elif [ "$CMP" = "1" ]; then
  log "[step 3] installed $INSTALLED_VER is OLDER than current $CURRENT_VER — refusing to downgrade"
  log "=== upgrade aborted ==="
  UPGRADE_RESULT="refused"
  schedule_self_cleanup
  exit 0
fi
LIVE_OK=0
if [ "$CMP" = "0" ]; then
  # Same version as the running daemon: nothing to switch IF the live package is sound.
  # A live package that fails verification is what a repair-by-reinstall is for.
  if "$NODE" "$ATOMIC_INSTALLER" verify --pkg-dir "$GLOBAL_ROOT/imcodes" --target "$INSTALLED_VER" --node "$NODE" >> "$LOG" 2>&1; then LIVE_OK=1; fi
  if [ "$LIVE_OK" = "1" ]; then
    log "[step 3] installed $INSTALLED_VER matches current and the live package verifies — repairing CLI wrappers without restart"
    log "[step 3.6] repairing CLI wrappers"
    repair_cli_wrappers
    log "=== upgrade complete (no-op) ==="
    UPGRADE_RESULT="noop"
    schedule_self_cleanup
    exit 0
  fi
  log "[step 3] same version but the live package does not verify — switching to the staged copy to repair it"
else
  log "[step 3] version comparator: installed > current → switch and restart"
fi

# ── Step 3.4: switch (two same-filesystem renames; the old package is kept) ──
log "[step 3.4] switching to the verified package"
"$NODE" "$ATOMIC_INSTALLER" switch "\${ATOMIC_ARGS[@]}" --stage-prefix "$STAGE_PREFIX" --tag "$UPGRADE_TAG" >> "$LOG" 2>&1
SWITCH_RC=$?
if [ "$SWITCH_RC" -ne 0 ]; then
  log "[step 3.4] switch FAILED (exit $SWITCH_RC) — the previous package was put back and keeps running"
  write_install_failure_status "switch-failed" "$ATTEMPT" "$SWITCH_RC" \
    || log "[step 3.4] failed to write upgrade status marker: $UPGRADE_STATUS_FILE"
  log "=== upgrade aborted ==="
  schedule_self_cleanup
  exit ${POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE}
fi
SWITCHED=1

# ── Step 3.5: Regenerate launch chain with the new binary's paths ──────
#
# Why this exists: on Linux the systemd unit at
# ~/.config/systemd/user/imcodes.service hard-codes ExecStart with the
# absolute path to \`node\` and the imcodes entry script as they existed at
# \`imcodes bind\` time. Any of these scenarios leaves it pointing at a
# bin that no longer exists / no longer resolves correctly:
#
#   * user switches node via nvm/fnm/volta — \`/.../node/v22.x.x/bin/imcodes\`
#     still resolves but a fresh \`npm i -g\` populated the new version's
#     prefix instead, so the old absolute path is stale.
#   * \`npm uninstall -g imcodes\` followed by reinstall under a different
#     prefix (homebrew vs nvm vs system) leaves the symlink dangling.
#   * any reorg of node versions where the bin sits at a new absolute path.
#
# Real-world hit: a production daemon stuck on an older dev build because the
# unit's ExecStart pointed at /home/k/.nvm/versions/node/v22.22.2/bin/imcodes
# from a prior install — \`systemctl restart imcodes\` succeeds in the
# upgrade script's eyes but the spawned process crashes "Cannot find
# module '/home/k/.../bin/imcodes'" (988 recorded crashes in daemon.log
# before one of them finally caught a working state by lucky races).
#
# Windows already does the equivalent (Step 5 "Regenerate daemon launch
# chain" in windows-upgrade-script.ts).  This mirrors that behavior for
# Linux + macOS so a successful npm install is always followed by a
# launch-chain pointing at the freshly-installed binary.
#
# Safe-by-design: we only touch ExecStart on Linux and ProgramArguments
# on macOS. Other Environment= / Restart= / KillMode= settings the user
# may have customised are preserved verbatim. If the unit / plist file
# doesn't exist, we skip silently — the user may run via \`imcodes start\`
# directly or have a non-standard launcher, neither of which we should
# clobber.
# Runs after the switch, and again after a rollback (an older package may not ship
# the launcher the unit was just pointed at, so the chain is regenerated for whichever
# package is live).
regenerate_launch_chain() {
  if [ "$SKIP_LAUNCH_CHAIN" = "1" ]; then
    log "[step 3.5] skipped (SKIP_LAUNCH_CHAIN)"
    return 0
  fi
  log "[step 3.5] regenerating launch chain"

  # Prefer the self-healing launcher (bin/imcodes-launch.sh) when the
  # freshly-installed package ships it. Older installs (pre-launcher) fall
  # back to the direct node ExecStart so we never break versions that
  # don't ship the file. Either way the resulting unit/plist points at
  # absolute paths from THIS install — consistent with the rest of step
  # 3.5's contract.
  if [ -f "$NEW_LAUNCHER" ]; then
    LINUX_EXEC="ExecStart=$NEW_LAUNCHER start --foreground"
    DARWIN_PROGRAM_ARGS="[\\"$NEW_LAUNCHER\\",\\"start\\",\\"--foreground\\"]"
    log "[step 3.5] using self-healing launcher: $NEW_LAUNCHER"
  else
    LINUX_EXEC="ExecStart=$NODE $NEW_IMCODES_SCRIPT start --foreground"
    DARWIN_PROGRAM_ARGS="[\\"$NODE\\",\\"$NEW_IMCODES_SCRIPT\\",\\"start\\",\\"--foreground\\"]"
    log "[step 3.5] $NEW_LAUNCHER not present in this version — using direct node ExecStart"
  fi

  if [ ! -f "$NEW_IMCODES_SCRIPT" ]; then
    log "[step 3.5] $NEW_IMCODES_SCRIPT not found — skipping (will rely on existing launch chain)"
  elif [ "$(uname)" = "Linux" ]; then
    SVC="$HOME/.config/systemd/user/imcodes.service"
    if [ -f "$SVC" ]; then
      NEW_EXEC="$LINUX_EXEC"
      OLD_EXEC=$(grep -m1 '^ExecStart=' "$SVC" || echo '(none)')
      if [ "$OLD_EXEC" = "$NEW_EXEC" ]; then
        log "[step 3.5] systemd ExecStart already current"
      else
        log "[step 3.5] rewriting ExecStart"
        log "[step 3.5]   from: $OLD_EXEC"
        log "[step 3.5]   to:   $NEW_EXEC"
        # Use awk for portability — sed -i's in-place behavior differs
        # between BSD (mac) and GNU (linux), and quoting the replacement
        # gets thorny with paths that may contain '/'. awk on a temp
        # file is unambiguous on every Unix.
        if awk -v new="$NEW_EXEC" '
          BEGIN { done = 0 }
          /^ExecStart=/ { if (!done) { print new; done = 1; next } }
          { print }
        ' "$SVC" > "$SVC.new" && mv "$SVC.new" "$SVC"; then
          systemctl --user daemon-reload >> "$LOG" 2>&1 && log "[step 3.5] systemd daemon-reload OK" || log "[step 3.5] systemd daemon-reload FAILED (non-fatal)"
        else
          log "[step 3.5] awk rewrite FAILED — keeping old unit (non-fatal)"
          rm -f "$SVC.new"
        fi
      fi
    else
      log "[step 3.5] $SVC absent — nothing to rewrite"
    fi
  elif [ "$(uname)" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/imcodes.daemon.plist"
    if [ -f "$PLIST" ]; then
      if command -v plutil >/dev/null 2>&1; then
        log "[step 3.5] rewriting plist ProgramArguments"
        if plutil -replace ProgramArguments -json "$DARWIN_PROGRAM_ARGS" "$PLIST" >> "$LOG" 2>&1; then
          log "[step 3.5] plutil rewrite OK"
        else
          log "[step 3.5] plutil rewrite FAILED (non-fatal)"
        fi
      else
        log "[step 3.5] plutil not available — skipping plist regen"
      fi
    else
      log "[step 3.5] $PLIST absent — nothing to rewrite"
    fi
  fi

}
regenerate_launch_chain

log "[step 3.6] repairing CLI wrappers"
repair_cli_wrappers

OLD_DAEMON_PID="${oldDaemonPid}"
ROLLED_BACK=0

run_restart() {
  # Wrap restartCmd in a subshell so its multi-line content captures all
  # stdout/stderr to LOG. The previous template-literal interpolation
  # attached >>$LOG to only the LAST line of restartCmd, swallowing
  # everything before launchctl load (silent unload failures, kill exit
  # codes, etc).
  {
${restartCmd}
  } >> "$LOG" 2>&1
}

# A NEW daemon is one whose pid file names a live process other than the one we replaced.
wait_for_new_daemon() {
  local limit="$1" waited=0 pid=""
  while :; do
    if [ -f "$IMCODES_STATE_DIR/daemon.pid" ]; then
      pid=$(cat "$IMCODES_STATE_DIR/daemon.pid" 2>/dev/null || true)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$pid" != "$OLD_DAEMON_PID" ]; then
        HEALTH_PID="$pid"
        return 0
      fi
    fi
    if [ "$waited" -ge "$limit" ]; then return 1; fi
    sleep 3
    waited=$((waited + 3))
  done
}

log "[step 4] running restart command"
run_restart
RC=$?
log "[step 4] restart command exit code: $RC"

# Verify the old daemon process is actually gone — surfacing platform-
# specific restart failures (launchctl unload silently no-op'd, systemd
# returned 0 without restarting, etc).
sleep 2
if [ -n "$OLD_DAEMON_PID" ] && kill -0 "$OLD_DAEMON_PID" 2>/dev/null; then
  log "[step 4] WARN: old daemon PID $OLD_DAEMON_PID still alive after restart command"
else
  log "[step 4] old daemon PID \${OLD_DAEMON_PID:-none} terminated as expected"
fi

# ── Step 5: Health check — verify a NEW daemon is actually running ─────
#
# Why: a successful step 4 (e.g. "systemctl --user restart imcodes" returns 0
# when the unit transitions to "activating") doesn't guarantee the new
# daemon survives. systemd returns success once the spawned process forks,
# but if its ExecStart fails (e.g. node crashes immediately on a stale
# module path that survived step 3.5), Restart=always immediately re-spawns
# it, and the failure repeats invisibly. The new daemon's PID is recorded
# in <state dir>/daemon.pid AFTER successful startup, so we can use the pid
# file as a positive-liveness signal and kill -0 it.
#
# A slow start is not a failed one (a busy node writes its pid file late), so a
# miss at the first check only WARNs; the new package is judged unusable, and
# rolled back, only if a daemon that was running before is still not back after
# the extended wait.
log "[step 5] post-restart health check"
HEALTH_PID=""
if wait_for_new_daemon "$HEALTH_FIRST_WAIT_SEC"; then
  log "[step 5] new daemon healthy: PID $HEALTH_PID"
else
  log "[step 5] WARN: no live new daemon after \${HEALTH_FIRST_WAIT_SEC}s — service unit may have a stale path or the new binary crashes on startup"
  log "[step 5] WARN: check 'systemctl --user status imcodes' (linux) or 'log show --predicate \"subsystem == \\\"imcodes\\\"\"' (macos)"
  if [ "$DAEMON_WAS_RUNNING" = "1" ]; then
    log "[step 5] a daemon was running before: waiting up to \${HEALTH_EXTENDED_WAIT_SEC}s more before judging the new version unusable"
    if wait_for_new_daemon "$HEALTH_EXTENDED_WAIT_SEC"; then
      log "[step 5] new daemon healthy (late): PID $HEALTH_PID"
    fi
  fi
fi

# ── Step 5.5: roll back a new package the daemon cannot start on ────────
if [ -z "$HEALTH_PID" ] && [ "$DAEMON_WAS_RUNNING" = "1" ] && [ "$SWITCHED" = "1" ]; then
  log "[step 5.5] ROLLBACK: the daemon did not come back on the new package — restoring the previous one"
  if "$NODE" "$ATOMIC_INSTALLER" rollback "\${ATOMIC_ARGS[@]}" --tag "$UPGRADE_TAG" >> "$LOG" 2>&1; then
    SWITCHED=0
    ROLLED_BACK=1
    regenerate_launch_chain
    repair_cli_wrappers
    run_restart
    log "[step 5.5] restart command exit code after rollback: $?"
    if wait_for_new_daemon "$HEALTH_FIRST_WAIT_SEC"; then
      log "[step 5.5] previous version is running again: PID $HEALTH_PID"
    else
      log "[step 5.5] WARN: no live daemon after the rollback restart either — the service unit needs attention (see the WARN lines above)"
    fi
  else
    log "[step 5.5] ROLLBACK FAILED — the previous package is kept as $GLOBAL_ROOT/.imcodes-old.$UPGRADE_TAG"
  fi
elif [ "$SWITCHED" = "1" ]; then
  "$NODE" "$ATOMIC_INSTALLER" commit "\${ATOMIC_ARGS[@]}" --stage-prefix "$STAGE_PREFIX" --tag "$UPGRADE_TAG" >> "$LOG" 2>&1 \
    || log "[step 5.5] commit cleanup reported a problem (harmless: leftovers are swept next run)"
fi

# Drop the auto-upgrade cooldown sentinel UNCONDITIONALLY — an upgrade was just
# attempted, and this rate-limits the NEXT attempt, not successes.
#
# It used to be written only on a confirmed-healthy restart within 14s. On a
# busy node the new daemon writes its pid file later than that (heavy startup,
# many restored sessions), so the health check timed out, the sentinel was
# never written, the cooldown never engaged, and every dev-tag poll re-ran the
# upgrade — an endless "preparing upgrade -> restart" thrash (stuck upgrade.sh,
# hundreds of restarts) even though the daemon was actually coming up fine. A
# genuinely dead daemon is still surfaced by the WARN lines above; throttling
# its retries is correct too. handleDaemonUpgrade consults this on the new
# daemon's next auto-upgrade attempt; it survives restart by design (the very
# transition we are throttling against).
# Epoch ms (matches Date.now in JS). MUST stay portable: BSD/macOS \`date\`
# has no %N, so \`date +%s%3N\` emits a bogus "<seconds>3N" there and corrupts
# the sentinel — which made the cooldown never apply and drove a macOS
# auto-upgrade thrash loop. seconds*1000 is ms-granular enough for a
# multi-minute cooldown and works on both GNU and BSD date. Best-effort: a
# missing sentinel means no cooldown.
printf '%s\n' "$(( $(date +%s) * 1000 ))" > "$IMCODES_STATE_DIR/last-upgrade-at" 2>/dev/null || true
log "[step 5] cooldown sentinel updated: $IMCODES_STATE_DIR/last-upgrade-at"

if [ "$ROLLED_BACK" = "1" ]; then
  # Surface it: the daemon reports exit 75 + this marker to the server as a blocked upgrade.
  UPGRADE_RESULT="rolled_back"
  write_install_failure_status "new-version-unhealthy" "$ATTEMPT" 1 \
    || log "[step 5.5] failed to write upgrade status marker: $UPGRADE_STATUS_FILE"
  log "=== upgrade rolled back: the previous version is running ==="
  schedule_self_cleanup
  exit ${POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE}
fi
UPGRADE_RESULT="ok"
log "=== upgrade script done ==="

# Self-cleanup after 24 h so failures stay debuggable.
schedule_self_cleanup
`;
}
