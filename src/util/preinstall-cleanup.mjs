#!/usr/bin/env node
/**
 * preinstall-cleanup.mjs — runs FIRST during `npm install -g imcodes@…`,
 * before npm renames the existing global imcodes/ aside.
 *
 * Why this exists: npm's atomic-rename + cleanup flow is fragile in the
 * presence of leftovers from a previous install that was killed mid-way.
 * The classic symptom is `ENOTEMPTY: directory not empty, rmdir
 * .../imcodes/node_modules/<some-deep-dir>` because the prior install
 * left files inside that npm doesn't know about (and therefore doesn't
 * try to delete during cleanup). Or the previous install left an
 * `.imcodes-XXXXX` sibling that the next install can't atomically
 * rename onto. Or the daemon's own `imcodes upgrade` is running in the
 * background and racing with the user's manual `npm install`.
 *
 * This script handles those cases BEFORE npm gets a chance to fail:
 *
 *   1. Removes any `.imcodes-XXXXX` siblings of the global imcodes/
 *      (npm's tempdir prefix from a killed atomic-rename — purely
 *      stale, never legitimately "in use" since npm only uses these
 *      transiently within a single install).
 *
 *   2. Removes a stale `~/.imcodes/upgrade.lock.d/` (older than 30 min
 *      — way past any realistic install completion path). Same
 *      threshold as the bash upgrade script's own watchdog.
 *
 *   3. Detects an in-flight `imcodes-upgrade` script. If found,
 *      ABORTS (exit 1) with a clear message instead of silently
 *      racing — the user would otherwise see a confusing ENOTEMPTY a
 *      few seconds later when both npms collide on the same node_modules.
 *
 * Pure Node built-ins (`node:fs`, `node:path`, `node:os`,
 * `node:child_process`). MUST stay tiny — runs at the very front of
 * every install, including from clean machines that have never seen
 * imcodes before. Most invocations exit in milliseconds with nothing
 * to do.
 *
 * Idempotent. Safe to skip if anything goes wrong — the worst case is
 * the user falls back to the old failure mode (ENOTEMPTY etc.), which
 * is what we'd have today without this file.
 */
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const LOCK_STALE_AFTER_SEC = parseInt(
  process.env.IMCODES_PREINSTALL_LOCK_STALE_AFTER_SEC ?? '1800',
  10,
);

function log(line) {
  // npm captures stderr into the install log only when --loglevel info or
  // higher; with default loglevel only stdout is shown. Use stdout so
  // operators see what we did without --verbose.
  process.stdout.write(`[imcodes preinstall] ${line}\n`);
}

// ── 1. Resolve the npm global prefix's node_modules dir ─────────────
// npm sets `npm_config_prefix` for child scripts, but not always for
// preinstall on global installs (depends on npm version). Fall back
// to `npm prefix -g` which is reliable but ~150ms.
function resolveGlobalNodeModules() {
  const fromEnv = process.env.npm_config_prefix;
  if (fromEnv) return join(fromEnv, 'lib', 'node_modules');
  try {
    const out = execSync('npm prefix -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return join(out, 'lib', 'node_modules');
  } catch { /* fall through */ }
  return null;
}

// ── 2. Clear `.imcodes-XXXXX` siblings ──────────────────────────────
// npm leaves these as the atomic-rename target when an install gets
// killed between rename-aside and final cleanup. Subsequent installs
// see them as "directory exists" obstacles.
function clearAtomicRenameLeftovers(globalNodeModules) {
  if (!globalNodeModules || !existsSync(globalNodeModules)) return;
  let entries;
  try {
    entries = readdirSync(globalNodeModules);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('.imcodes-')) continue;
    const target = join(globalNodeModules, entry);
    try {
      log(`removing leftover ${target}`);
      rmSync(target, { recursive: true, force: true });
    } catch (err) {
      log(`failed to remove ${target}: ${err.message ?? err}`);
    }
  }
}

// ── 3. Clear stale upgrade lock dir ─────────────────────────────────
// Same logic as the launcher's stale-lock sweep + the bash upgrade
// script's own watchdog. The lock is the daemon's own coordination
// primitive, not npm's — but a stale one signals a previous killed
// upgrade, which often comes paired with the npm-side leftovers above.
function clearStaleUpgradeLock() {
  const lockDir = join(homedir(), '.imcodes', 'upgrade.lock.d');
  if (!existsSync(lockDir)) return;
  let started = '';
  const startedFile = join(lockDir, 'started');
  if (existsSync(startedFile)) {
    try { started = readFileSync(startedFile, 'utf8').trim(); } catch { /* ignore */ }
  }
  let startedSec = parseInt(started, 10);
  if (!Number.isFinite(startedSec)) {
    try { startedSec = Math.floor(statSync(lockDir).mtimeMs / 1000); } catch { return; }
  }
  const ageSec = Math.floor(Date.now() / 1000) - startedSec;
  if (ageSec > LOCK_STALE_AFTER_SEC) {
    try {
      log(`clearing stale upgrade.lock.d (age ${ageSec}s, threshold ${LOCK_STALE_AFTER_SEC}s)`);
      rmSync(lockDir, { recursive: true, force: true });
    } catch (err) {
      log(`failed to remove stale lock ${lockDir}: ${err.message ?? err}`);
    }
  }
}

// ── 4. Detect concurrent `imcodes-upgrade` script and abort ─────────
// If the daemon's auto-upgrade is running in parallel, our install
// will collide on the same `node_modules/imcodes/` dir and produce a
// confusing ENOTEMPTY. Better to fail fast with a clear message so
// the user can either wait or pkill the in-flight upgrade.
//
// `pgrep` is on every Linux/macOS by default; on Windows we skip the
// check (the Windows watchdog has its own coordination via
// `upgrade.lock` file, and our preinstall on Windows should still
// run the residue cleanup above).
// Walk the process ancestry from `start` upward, returning every PID
// from `start` (inclusive) up to PID 1. Used to determine if we're
// running INSIDE an `imcodes-upgrade` script — in which case any
// imcodes-upgrade we see via pgrep is our ancestor, not a competitor.
//
// Linux exposes PPid in /proc/<pid>/status; macOS via `ps -o ppid= -p`.
// Both are POSIX-portable enough that we don't need a special path
// per OS.
function ancestorPids(start) {
  const seen = new Set();
  let cur = start;
  for (let i = 0; i < 40 && cur > 1; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    let ppid = 0;
    try {
      if (existsSync(`/proc/${cur}/status`)) {
        const status = readFileSync(`/proc/${cur}/status`, 'utf8');
        const m = status.match(/^PPid:\s*(\d+)/m);
        if (m) ppid = parseInt(m[1], 10);
      } else {
        const out = execSync(`ps -o ppid= -p ${cur}`, {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
        }).trim();
        ppid = parseInt(out, 10);
      }
    } catch {
      break;
    }
    if (!Number.isFinite(ppid) || ppid <= 0) break;
    cur = ppid;
  }
  return seen;
}

function detectConcurrentUpgrade() {
  if (process.platform === 'win32') return false;
  if (process.env.IMCODES_PREINSTALL_SKIP_CONCURRENT_CHECK === '1') return false;
  try {
    const out = execSync(
      'pgrep -af "imcodes-upgrade-[A-Za-z0-9]+/upgrade.sh" || true',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    ).trim();
    if (!out) return false;
    // Exclude every ancestor PID — `npm install` invoked from inside
    // the daemon's own upgrade.sh would otherwise see its own
    // grandparent and falsely flag a concurrent upgrade. We walk the
    // full ancestry chain (us → npm → bash upgrade.sh → daemon) so
    // matches against ANY of those count as "self, not competitor".
    const myAncestors = ancestorPids(process.pid);
    const lines = out.split('\n').filter(Boolean);
    const others = lines.filter((line) => {
      const pid = parseInt(line.split(/\s+/)[0], 10);
      if (!Number.isFinite(pid)) return false;
      return !myAncestors.has(pid);
    });
    if (others.length === 0) return false;
    log('---------------------------------------------------------');
    log('Another `imcodes upgrade` is already running:');
    for (const line of others) log(`  ${line}`);
    log('');
    log('Two parallel `npm install -g imcodes@…` against the same global');
    log('prefix collide on node_modules/imcodes/ and produce ENOTEMPTY.');
    log('Either:');
    log('  • wait for the other upgrade to finish (`tail -f /tmp/imcodes-upgrade-*/upgrade.log`)');
    log('  • abort it: `pkill -f imcodes-upgrade && rm -rf ~/.imcodes/upgrade.lock.d`,');
    log('    then re-run `npm install -g imcodes@dev`');
    log('---------------------------------------------------------');
    return true;
  } catch {
    return false; // pgrep unavailable / failed → don't block
  }
}

// ── main ────────────────────────────────────────────────────────────
const globalNodeModules = resolveGlobalNodeModules();
clearAtomicRenameLeftovers(globalNodeModules);
clearStaleUpgradeLock();
if (detectConcurrentUpgrade()) {
  // Exit non-zero so npm aborts the install BEFORE the rename collision.
  process.exit(1);
}
