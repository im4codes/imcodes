#!/usr/bin/env node
/**
 * windows-launch-preflight.mjs — Windows-side counterpart of
 * `bin/imcodes-launch.sh`.
 *
 * Invoked by `daemon-watchdog.cmd` BEFORE every daemon-launch attempt.
 * Detects the half-installed `node_modules` signature that
 * `imcodes upgrade` (or any `npm install -g imcodes@…`) leaves behind
 * when it gets killed mid-write — power loss, OOM-kill, RDP-disconnect,
 * etc. Without this, top-level deps like `commander`/`ws`/`hono` can be
 * empty placeholder dirs (no `package.json` inside), and the daemon's
 * very first import crashes with `ERR_MODULE_NOT_FOUND` → watchdog
 * restarts → same crash → infinite loop, no operator-visible recovery.
 *
 * Pure Node built-ins only (`node:fs`, `node:path`, `node:child_process`).
 * Importing anything from `node_modules/` would defeat the entire point —
 * `node_modules` being broken is exactly when this script needs to run.
 *
 * Mirrors the bash launcher's behavior verbatim:
 *   - same CRITICAL_DEPS list
 *   - same "dir exists but no package.json inside" detection
 *   - same `--ignore-scripts --prefer-online imcodes@<pinned>` reinstall
 *   - same "exit 0 even on repair failure so the watchdog retries
 *     instead of getting wedged on the repair shim"
 *
 * Idempotent: healthy install costs one stat per dep + the dist check
 * (~ms) and exits 0 with no side effects.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
// Layout: <PKG_ROOT>/dist/src/util/windows-launch-preflight.mjs
//         ^^^^^^^^^^ resolve up 4 levels: util → src → dist → PKG_ROOT
const PKG_ROOT = resolve(SELF, '..', '..', '..', '..');

// Critical deps — daemon CANNOT start without these. Keep in lockstep
// with `bin/imcodes-launch.sh` so the two platforms have the same
// recovery surface.
const CRITICAL_DEPS = [
  'commander',
  'ws',
  'cors',
  'body-parser',
  'hono',
  '@huggingface/transformers',
];

const REPAIR_LOG = process.env.IMCODES_LAUNCH_REPAIR_LOG
  ?? join(process.env.IMCODES_HOME ?? homedir(), '.imcodes', 'launch-repair.log');

function log(line) {
  // Emit to stderr so the watchdog's `>> watchdog.log 2>&1` captures it,
  // and also append to a dedicated repair log for post-mortem.
  const stamp = new Date().toISOString();
  const msg = `[imcodes-launch ${stamp}] ${line}\n`;
  process.stderr.write(msg);
  try {
    mkdirSync(dirname(REPAIR_LOG), { recursive: true });
    appendFileSync(REPAIR_LOG, msg);
  } catch { /* best-effort */ }
}

function isHalfInstalled(depDir) {
  try {
    return existsSync(depDir) && !existsSync(join(depDir, 'package.json'));
  } catch {
    return false;
  }
}

function readPinnedVersion() {
  const pkgPath = join(PKG_ROOT, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

// Stale upgrade-lock probe — mirror the bash launcher. Windows already
// has watchdog.cmd's own 10-min stale probe; this one's 30-min and only
// fires when the launch preflight runs, so it's a defense-in-depth
// pass for cases where the watchdog probe didn't fire (e.g. lock got
// re-created right after watchdog's cleanup, or upgrade.lock.d/ from
// the Unix-style bash upgrade ended up here cross-platform).
function clearStaleUpgradeLock() {
  const lockDir = join(process.env.IMCODES_HOME ?? homedir(), '.imcodes', 'upgrade.lock.d');
  const lockFile = join(process.env.IMCODES_HOME ?? homedir(), '.imcodes', 'upgrade.lock');
  const stalenessSec = parseInt(
    process.env.IMCODES_LAUNCH_LOCK_STALE_AFTER_SEC ?? '1800',
    10,
  );
  for (const target of [lockDir, lockFile]) {
    try {
      if (!existsSync(target)) continue;
      const st = statSync(target);
      const ageSec = (Date.now() - st.mtimeMs) / 1000;
      if (ageSec > stalenessSec) {
        log(`clearing stale upgrade lock at ${target} (age ${Math.round(ageSec)}s)`);
        if (st.isDirectory()) {
          rmSync(target, { recursive: true, force: true });
        } else {
          unlinkSync(target);
        }
      }
    } catch { /* best-effort */ }
  }
}

clearStaleUpgradeLock();

let needsRepair = false;
const missing = [];

for (const dep of CRITICAL_DEPS) {
  const depDir = join(PKG_ROOT, 'node_modules', dep);
  if (isHalfInstalled(depDir)) {
    needsRepair = true;
    missing.push(dep);
  }
}

const entryPath = join(PKG_ROOT, 'dist', 'src', 'index.js');
if (!existsSync(entryPath)) {
  needsRepair = true;
  missing.push('dist/src/index.js');
}

if (!needsRepair) {
  // Healthy install — hand back to the watchdog with no action.
  process.exit(0);
}

const pinned = readPinnedVersion();
if (!pinned) {
  log(`node_modules half-installed (missing: ${missing.join(', ')}) but cannot read pinned version from ${PKG_ROOT}/package.json — handing back to watchdog without repair`);
  process.exit(0);
}

log(`node_modules half-installed (missing: ${missing.join(', ')}) — reinstalling imcodes@${pinned}`);

// Reinstall with the same flags the bash launcher uses. `npm.cmd` is
// the Windows shim; npm itself isn't on PATH as `npm` after a custom
// prefix install on some configurations.
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(
  npmCmd,
  ['install', '-g', '--ignore-scripts', '--prefer-online', `imcodes@${pinned}`],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 5 * 60 * 1000, // 5 min — npm install rarely takes longer; if it does, watchdog will retry next loop
    windowsHide: true,
    shell: false,
  },
);

if (r.stdout) {
  try { appendFileSync(REPAIR_LOG, `[npm stdout]\n${r.stdout}\n`); } catch { /* ignore */ }
}
if (r.stderr) {
  try { appendFileSync(REPAIR_LOG, `[npm stderr]\n${r.stderr}\n`); } catch { /* ignore */ }
}

if (r.status === 0) {
  log('self-repair OK');
} else {
  log(`self-repair FAILED (npm exit ${r.status}; signal ${r.signal ?? 'none'}) — see ${REPAIR_LOG}`);
}

// Always exit 0: even if repair failed (transient network etc.), we
// want the watchdog to TRY launching the daemon. If it crashes again,
// the watchdog re-enters the loop and the next iteration re-runs the
// preflight — converges as soon as ONE npm install succeeds.
process.exit(0);
