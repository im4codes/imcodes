#!/usr/bin/env node
/**
 * Windows daemon upgrade runner — Node.js, NOT cmd.exe batch.
 *
 * History: this file replaces a 200-line cmd.exe batch script generated
 * from a string template.  That batch was the source of every Windows
 * auto-upgrade outage we shipped:
 *
 *   - 2026-04-21: NODE_OPTIONS accumulating across upgrade cycles caused
 *     V8 to try reserving 16 GB heap → MemoryChunk allocation failed.
 *   - 2026-04-27: `del "%UPGRADE_LOCK%" >nul 2>&1` silently failed (the
 *     paths got doubled-backslashed in a sibling script's interpolation).
 *   - 2026-05-07: an unescaped `(` inside an `if exist (...)` echo
 *     terminated the if-block early; the lock-removal step ended up
 *     outside any code path that ran.  Daemon wedged for hours.
 *
 * cmd.exe is fundamentally hostile to writing reliable batch scripts:
 *
 *   - if-blocks are parsed by counting parens — literal `(`/`)` inside
 *     echo args silently breaks them.
 *   - `timeout /t N /nobreak` aborts immediately when stdin is missing
 *     (which is always, when launched via wscript → cmd).
 *   - `del` returns 0 on sharing-violation / AV-scan / weird-ACL races.
 *   - chcp 65001 only takes effect AFTER the file's first lines parse,
 *     so any non-ASCII byte in a comment header gets reinterpreted as
 *     OEM.  Filenames in %TEMP% containing Chinese / Cyrillic / etc.
 *     characters trip this.
 *
 * Node.js fs APIs use the Windows wide-char API natively.  Paths with
 * non-ASCII characters (including Chinese %USERPROFILE% values like
 * `C:\Users\张三`) round-trip transparently — no codepage games, no
 * escaping rules to remember.  Errors throw with proper stack traces.
 * Control flow is normal try/catch/finally instead of paren-counting.
 *
 * Invocation: spawned via wscript → WshShell.Run("node upgrade.mjs ...")
 * so the runner runs hidden, fully detached from the calling daemon's
 * process group.  It outlives the daemon it's about to kill+replace.
 *
 * Args:
 *   process.argv[2] = absolute path to log file (script_dir/upgrade.log)
 *   process.argv[3] = absolute path to npm.cmd (or 'npm' on PATH)
 *   process.argv[4] = pkg spec (e.g. "imcodes@2026.5.2059-dev.2036")
 *   process.argv[5] = target version (e.g. "2026.5.2059-dev.2036" or "latest")
 *   process.argv[6] = absolute path to script_dir (for self-cleanup)
 *
 * Exit code:
 *   0 on success or expected abort (install fail, version mismatch).
 *   Non-zero only on truly unexpected runner crash — even then the lock
 *   gets cleaned up via the top-level try/finally before exit.
 */

import { spawnSync, spawn, execSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const LOCK = join(HOME, '.imcodes', 'upgrade.lock');
const PIDFILE = join(HOME, '.imcodes', 'daemon.pid');
const VBS_LAUNCHER = join(HOME, '.imcodes', 'daemon-launcher.vbs');

const LOG_FILE = process.argv[2];
const NPM_CMD = process.argv[3];
const PKG_SPEC = process.argv[4];
const TARGET_VER = process.argv[5];
const SCRIPT_DIR = process.argv[6];

function log(msg) {
  // Best-effort logging.  fs failures here MUST NOT throw — losing a
  // log line is preferable to crashing the upgrade and stranding the lock.
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (LOG_FILE) appendFileSync(LOG_FILE, line);
  } catch { /* ignore */ }
}

function sleepMs(ms) {
  // Synchronous sleep without setTimeout — matches the rest of the
  // sequential upgrade flow so we don't have to await timers.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Remove the lock with retries.  Even Node fs occasionally hits
 *  EBUSY/EPERM if AV is mid-scan; a few short retries cover that. */
function clearLock() {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!existsSync(LOCK)) return true;
    try {
      unlinkSync(LOCK);
      if (!existsSync(LOCK)) return true;
    } catch (e) {
      log(`unlink attempt ${attempt + 1} failed: ${e?.code ?? e?.message ?? e}`);
    }
    sleepMs(200);
  }
  // Last-ditch: rmSync with force (different code path internally on some Win versions).
  try { rmSync(LOCK, { force: true }); } catch { /* ignore */ }
  return !existsSync(LOCK);
}

function tryKillPid(pid) {
  if (!pid || pid === process.pid) return;
  try { execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore', windowsHide: true }); }
  catch { /* not running */ }
}

/** spawnSync wrapper that handles .cmd / .bat files via explicit cmd.exe.
 *
 *  Node 24 (post CVE-2024-27980) returns EINVAL when spawn() is invoked
 *  on a .cmd/.bat file without `shell: true`.  We don't want shell:true
 *  because its quoting rules differ across platforms and surprise on
 *  args with spaces or `&`.  Explicit `cmd.exe /d /s /c <bat> <args>`
 *  is the documented Microsoft pattern for invoking batch files with
 *  precise argv preservation — Node passes our argv tokens through
 *  unchanged, cmd.exe parses them with its standard rules.
 *
 *  /d  skips AutoRun registry hooks (no surprise environment mutations)
 *  /s  forces the conservative "preserve quotes around the whole string"
 *      behavior; combined with /c it's the canonical safe invocation.
 *  /c  run the command and exit
 */
function spawnCmdExe(file, args, options) {
  const isBatch = /\.(cmd|bat)$/i.test(file);
  if (!isBatch) return spawnSync(file, args, options);
  return spawnSync('cmd.exe', ['/d', '/s', '/c', file, ...args], options);
}

function readNumber(file) {
  try { return parseInt(readFileSync(file, 'utf8').trim(), 10) || null; }
  catch { return null; }
}

function killStaleWatchdogs() {
  // PowerShell first (Windows 7+, works on every locale).  If PS is not
  // available — extremely unlikely on a stock Windows install — wmic is
  // our fallback.  Both query Win32_Process by command-line pattern
  // ('*daemon-watchdog*') so this is locale-independent.
  const psScript =
    "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*daemon-watchdog*' } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    execSync(`powershell -NoProfile -NonInteractive -Command "${psScript}"`, {
      stdio: 'ignore', windowsHide: true,
    });
    return;
  } catch { /* fall through to wmic */ }
  try {
    const out = execSync(
      'wmic process where "Name=\'cmd.exe\' and CommandLine like \'%daemon-watchdog%\'" get ProcessId /format:list',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    const pids = out.split(/\r?\n/)
      .map((line) => line.match(/^ProcessId=(\d+)/))
      .filter((m) => m !== null)
      .map((m) => parseInt(m[1], 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
    for (const pid of pids) tryKillPid(pid);
  } catch { /* both methods failed — best effort */ }
}

/** Resolve the npm global prefix.  We need this to verify the install
 *  shim exists at the right path.  On nvm/fnm/volta/system installs
 *  this lives under different roots — the only authoritative source
 *  is `npm prefix -g` itself. */
function resolveNpmPrefix() {
  try {
    const r = spawnCmdExe(NPM_CMD, ['prefix', '-g'], {
      encoding: 'utf8', windowsHide: true,
    });
    if (r.status === 0) return r.stdout.trim();
  } catch { /* fall through */ }
  return null;
}

/** Sharp's npm-global empty-dir bug: the post-install hook for
 *  @img/sharp-* sometimes leaves transitive deps as empty placeholder
 *  directories.  detect-libc and semver are the usual victims.  When
 *  that happens, loading @huggingface/transformers crashes on
 *  "Cannot find module 'detect-libc'" and semantic search permanently
 *  sticky-disables.  Fix is to nuke the empty dirs and re-install sharp
 *  with --ignore-scripts (the runtime binary is the prebuilt
 *  @img/sharp-win32-* package, no install script needed).
 *
 *  Failure here doesn't block the upgrade — semantic search degrades
 *  gracefully. */
function sharpRepair(npmPrefix) {
  const root = join(npmPrefix, 'node_modules', 'imcodes', 'node_modules');
  const checkDeps = ['sharp', 'detect-libc', 'semver'];
  let broken = false;
  let brokenDep = '';
  for (const dep of checkDeps) {
    const pkgJson = join(root, dep, 'package.json');
    if (!existsSync(pkgJson)) {
      broken = true;
      brokenDep = brokenDep || dep;
    }
  }
  if (!broken) return;
  log(`sharp subtree broken (${brokenDep}/package.json missing) — repairing via nested npm install`);
  for (const dep of checkDeps) {
    const dir = join(root, dep);
    const pkgJson = join(dir, 'package.json');
    if (!existsSync(pkgJson) && existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const imcodesDir = join(npmPrefix, 'node_modules', 'imcodes');
  const result = spawnCmdExe(NPM_CMD, ['install', '--no-save', '--ignore-scripts', 'sharp@0.34.5'], {
    cwd: imcodesDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status === 0) {
    log('sharp repair succeeded');
  } else {
    log(`sharp repair FAILED (exit ${result.status}) — semantic memory recall will sticky-disable`);
    if (result.stderr) log(`sharp repair stderr: ${result.stderr.toString().trim()}`);
  }
}

function selfCleanup() {
  // Self-cleanup deferred 60 s — long enough that you can tail the log
  // for diagnostics, short enough that we don't litter %TEMP%.  We
  // detach into a separate node child so this script can exit cleanly
  // and the watchdog-spawned new daemon doesn't compete with us for
  // the lock file write.
  log('=== upgrade done ===');
  if (!SCRIPT_DIR) return;
  const detached = spawn(process.execPath, [
    '-e',
    `setTimeout(() => { try { require('fs').rmSync(${JSON.stringify(SCRIPT_DIR)}, { recursive: true, force: true }); } catch {} }, 60_000);`,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  detached.unref();
}

async function main() {
  log('=== upgrade started ===');
  log(`pkg: ${PKG_SPEC}, target: ${TARGET_VER}`);
  log(`npm: ${NPM_CMD}`);

  // Step 1: Acquire upgrade lock (watchdog will park on it).
  // Use a directory write — even if upgrade.lock's parent .imcodes
  // doesn't yet exist for some reason, mkdir is idempotent.
  mkdirSync(join(HOME, '.imcodes'), { recursive: true });
  writeFileSync(LOCK, 'upgrade');
  log('lock acquired');

  // Step 2: Capture old daemon PID.
  const oldPid = readNumber(PIDFILE);
  log(`old daemon PID: ${oldPid ?? 'none'} (kill only after install succeeds)`);

  // Step 3: npm install (bounded heap).  Old daemon stays alive — its
  // .js modules were loaded into V8 at startup, so npm overwriting them
  // on disk doesn't affect the running process.
  const env = {
    ...process.env,
    // Cap heap at 4 GB.  Older versions accumulated --max-old-space-size
    // flags across upgrades because the daemon's relaunched env inherited
    // our setlocal value; that bug is gone now (we don't mutate process
    // env, we just pass a fresh env object to the npm child).
    NODE_OPTIONS: '--max-old-space-size=4096',
  };
  log(`installing ${PKG_SPEC}...`);
  const installResult = spawnCmdExe(
    NPM_CMD,
    // --ignore-scripts: sharp's install hook is unreliable on global
    // npm-prefix installs (see sharpRepair() doc).  Skip post-install,
    // we'll nest-install sharp ourselves below.
    ['install', '-g', '--ignore-scripts', PKG_SPEC],
    { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true },
  );
  if (installResult.stdout) log(`npm stdout: ${installResult.stdout.trim()}`);
  if (installResult.stderr) log(`npm stderr: ${installResult.stderr.trim()}`);
  if (installResult.status !== 0) {
    log(`install FAILED (exit ${installResult.status}) — old daemon untouched, lock released`);
    return;  // finally clears the lock
  }
  log('install OK');

  // Step 4: Verify install — shim must exist, version must match (if pinned).
  const npmPrefix = resolveNpmPrefix();
  if (!npmPrefix) {
    log('could not resolve npm global prefix — aborting');
    return;
  }
  const shim = join(npmPrefix, 'imcodes.cmd');
  if (!existsSync(shim)) {
    log(`shim missing at ${shim} — aborting`);
    return;
  }
  let installedVer = '';
  try {
    const r = spawnCmdExe(shim, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) installedVer = r.stdout.trim();
  } catch { /* ignore */ }
  log(`installed version: ${installedVer || '?'}, target: ${TARGET_VER}`);
  if (TARGET_VER !== 'latest' && installedVer && installedVer !== TARGET_VER) {
    log('version mismatch after install — aborting');
    return;
  }

  // Step 5: Sharp repair (best effort).
  try { sharpRepair(npmPrefix); } catch (e) { log(`sharp repair threw: ${e?.message ?? e}`); }

  // Step 6: Kill stale watchdogs and the old daemon.
  log('killing stale watchdogs');
  killStaleWatchdogs();
  if (oldPid) {
    log(`stopping old daemon PID ${oldPid}`);
    tryKillPid(oldPid);
  }
  // Brief settle so Windows finishes process teardown before we ask the
  // new shim to do its repair-watchdog dance.
  sleepMs(2_000);

  // Step 7: Regenerate launch chain via the new shim.
  // shim is .cmd → must go through cmd.exe explicitly under Node 24.
  log('regenerating launch chain via repair-watchdog');
  try {
    const r = spawnCmdExe(shim, ['repair-watchdog'], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true,
    });
    if (r.status !== 0) log(`repair-watchdog exit ${r.status}: ${(r.stderr || '').trim()}`);
  } catch (e) {
    log(`repair-watchdog warning: ${e?.message ?? e}`);
  }

  // Step 8: Spawn new watchdog via VBS (preferred — runs hidden).
  log('starting new watchdog via VBS');
  if (existsSync(VBS_LAUNCHER)) {
    spawn('wscript', [VBS_LAUNCHER], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } else {
    log(`WARNING: VBS launcher not found at ${VBS_LAUNCHER}`);
  }

  // Step 9: Lock removed in `finally` — watchdog exits :wait_loop and
  // launches the new daemon as soon as it sees the lock gone.

  // Step 10: Health check — wait up to 15s for a NEW daemon PID.
  const deadline = Date.now() + 15_000;
  let newPid = null;
  while (Date.now() < deadline) {
    sleepMs(500);
    const pid = readNumber(PIDFILE);
    if (pid && pid !== oldPid) { newPid = pid; break; }
  }
  if (newPid) log(`health check PASSED: new daemon PID ${newPid}`);
  else log('health check FAILED: no new daemon PID within 15s (watchdog will keep retrying)');
}

// Top-level try/finally guarantees the lock gets cleared no matter how
// main() exits — clean return, abort, or unexpected throw.  This is the
// invariant the cmd.exe version kept getting wrong.
main()
  .catch((e) => {
    log(`FATAL: ${e?.stack ?? e?.message ?? String(e)}`);
  })
  .finally(() => {
    const cleared = clearLock();
    log(cleared ? 'lock released' : 'WARNING: failed to release lock — watchdog self-heal will recover');
    selfCleanup();
  });
