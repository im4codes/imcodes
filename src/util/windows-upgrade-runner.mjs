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
 *   process.argv[7] = npm registry to pin (or "-" for npm's ambient default)
 *   process.argv[8] = current daemon version (for the latest downgrade guard)
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
import { basename, dirname, join } from 'node:path';

const HOME = homedir();
const LOCK = join(HOME, '.imcodes', 'upgrade.lock');
const PIDFILE = join(HOME, '.imcodes', 'daemon.pid');
const DAEMON_TASK = 'imcodes-daemon';

const LOG_FILE = process.argv[2];
const NPM_CMD = process.argv[3];
const PKG_SPEC = process.argv[4];
const TARGET_VER = process.argv[5];
const SCRIPT_DIR = process.argv[6];
// "-" sentinel means "use npm's ambient/default registry" (no --registry flag).
const REGISTRY = process.argv[7] && process.argv[7] !== '-' ? process.argv[7] : null;
const CURRENT_VER = process.argv[8] || null;

/** Compare two daemon version strings (release + optional prerelease).
 *  Returns <0 if a<b, 0 if equal, >0 if a>b. Mirrors the in-script
 *  comparator the Linux/macOS upgrade script bakes in, so the Windows
 *  downgrade guard uses identical semantics. */
function compareDaemonVersionsLocal(a, b) {
  const parse = (v) => {
    const i = v.indexOf('-');
    return {
      rel: (i < 0 ? v : v.slice(0, i)).split('.').map((n) => parseInt(n, 10) || 0),
      pre: i < 0 ? null : v.slice(i + 1).split('.'),
    };
  };
  const A = parse(a), B = parse(b);
  const len = Math.max(A.rel.length, B.rel.length);
  for (let i = 0; i < len; i++) {
    const da = A.rel[i] || 0, db = B.rel[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;   // a release outranks a prerelease
  if (B.pre === null) return -1;
  const plen = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < plen; i++) {
    const pa = A.pre[i] || '', pb = B.pre[i] || '';
    const na = /^\d+$/.test(pa) ? parseInt(pa, 10) : null;
    const nb = /^\d+$/.test(pb) ? parseInt(pb, 10) : null;
    if (na !== null && nb !== null) { if (na !== nb) return na < nb ? -1 : 1; }
    else if (pa !== pb) return pa < pb ? -1 : 1;
  }
  return 0;
}

function log(msg) {
  // Best-effort logging.  fs failures here MUST NOT throw — losing a
  // log line is preferable to crashing the upgrade and stranding the lock.
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (LOG_FILE) appendFileSync(LOG_FILE, line);
  } catch { /* ignore */ }
}

/** Emit a `[trace] step=N <stage>` marker.  When the runner dies silently
 *  (or the daemon's 15-min watchdog timer fires before we kill it), the
 *  LAST trace line in upgrade.log pinpoints exactly which step was last
 *  reached.  Mirrors the same pattern in the legacy windows-upgrade-script
 *  batch so post-mortems use the same grep — `grep -F '[trace]'`. */
function trace(step, stage, extra) {
  log(`[trace] step=${step} ${stage}${extra ? ' ' + extra : ''}`);
}

/** Default per-step timeout for spawnSync calls.  The runner used to call
 *  spawnSync with no timeout, so any hung child (npm install stuck on a
 *  slow registry, taskkill blocked behind a kernel handle, etc.) would
 *  burn the daemon's full 15-minute memory-freeze timer.
 *
 *  Bound npm install at 10 minutes — typical install of imcodes is 1-3
 *  min on a fast network, 5-7 min on slow links.  10 min is the cliff
 *  past which we abandon and preserve the tmp dir for postmortem.
 *  Other commands (prefix -g, --version, taskkill, repair-watchdog) get
 *  a tight 60 s budget — none of them have any reason to take longer. */
const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000;
const FAST_CMD_TIMEOUT_MS = 60_000;

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

/** spawnSync wrapper that handles .cmd / .bat files reliably on Node 24+.
 *
 *  History of broken approaches we tried:
 *
 *  1. Direct `spawnSync('foo.cmd', args)` — Node 24 (post CVE-2024-27980)
 *     returns EINVAL.  Cannot use this any more.
 *
 *  2. `spawnSync('cmd.exe', ['/d', '/s', '/c', 'C:\\Program Files\\nodejs\\npm.cmd', ...])`
 *     — looks correct on paper but FAILS when the path contains spaces.
 *     Node serializes the argv into a Windows command line, wrapping the
 *     path in quotes.  The result reaching Windows is roughly:
 *       cmd.exe /d /s /c "C:\Program Files\nodejs\npm.cmd" --version
 *     With /s, cmd.exe ought to preserve the inner quotes — but in our
 *     real-world Node 24 + Windows 10 testing it does NOT, and cmd ends
 *     up running `C:\Program` as the executable.  The empirical failure:
 *       'C:\Program' is not recognized as an internal or external command
 *     This was the cause of the 2026-05-08 daemon crash loop where every
 *     auto-upgrade silently failed at `npm install` step, leaving the
 *     daemon in "memory freeze" until its 15-min watchdog fired three
 *     times in a row.
 *
 *  3. `shell: true` with absolute path — same quoting hell as (2).
 *
 *  WORKING APPROACH (current):
 *
 *  For .cmd files, we bypass cmd.exe entirely whenever possible:
 *
 *    a) NPM specifically: invoke npm's underlying `npm-cli.js` directly
 *       via `node.exe`.  npm.cmd is just a shim around `node npm-cli.js`,
 *       so calling node directly with the .js path skips all cmd.exe
 *       quoting rules.  node.exe is a real .exe (not a batch file),
 *       so spawnSync handles it without any Node 24 EINVAL issues.
 *
 *    b) For other .cmd files (e.g. the imcodes.cmd shim), fall back to
 *       `shell: true` with the bare basename and the parent directory
 *       prepended to PATH.  cmd.exe's PATH lookup handles spaces in
 *       the directory path natively (it's how interactive cmd works).
 *       Empirically verified: this is the ONLY pattern that reliably
 *       runs npm.cmd / imcodes.cmd from a Node 24 child on Windows
 *       when the install lives under a path with spaces. */
function resolveNpmCliJs(npmCmd) {
  // npm.cmd's directory contains node_modules/npm/bin/npm-cli.js on
  // every official npm-with-Node distribution we've tested (the bundled
  // npm shipped with node, nvm, fnm, volta, system).  If this layout
  // doesn't match (custom prefixes, weird repacks), we fall through to
  // the shell:true path below.
  if (!npmCmd) return null;
  const npmDir = dirname(npmCmd);
  const candidates = [
    join(npmDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Some installs (Homebrew on macOS — ignored on Windows but harmless
    // to probe) put npm in a sibling layout one level up.
    join(npmDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function spawnNpm(npmCmd, args, options) {
  const opts = { timeout: FAST_CMD_TIMEOUT_MS, killSignal: 'SIGKILL', ...options };
  // Path A (preferred): `node npm-cli.js <args>`.  No cmd.exe involved.
  const cliJs = resolveNpmCliJs(npmCmd);
  if (cliJs) {
    const result = spawnSync(process.execPath, [cliJs, ...args], opts);
    if (result.error) log(`spawnNpm(node ${cliJs}) error: ${result.error.code ?? ''} ${result.error.message}`);
    if (result.signal) log(`spawnNpm killed by signal: ${result.signal} (likely timeout=${opts.timeout}ms)`);
    return result;
  }
  // Path B (fallback): `shell: true` with bare 'npm', PATH-prepended.
  const npmDir = dirname(npmCmd);
  const env = {
    ...(opts.env ?? process.env),
    PATH: `${npmDir};${(opts.env?.PATH ?? process.env.PATH ?? '')}`,
  };
  const result = spawnSync('npm', args, { ...opts, env, shell: true });
  if (result.error) log(`spawnNpm(shell npm) error: ${result.error.code ?? ''} ${result.error.message}`);
  if (result.signal) log(`spawnNpm killed by signal: ${result.signal} (likely timeout=${opts.timeout}ms)`);
  return result;
}

/** Run an arbitrary .cmd shim (e.g. imcodes.cmd repair-watchdog) by
 *  prepending its directory to PATH and invoking the bare basename via
 *  `shell: true`.  Same reliability story as spawnNpm path B. */
function spawnCmdShim(shimCmd, args, options) {
  const opts = { timeout: FAST_CMD_TIMEOUT_MS, killSignal: 'SIGKILL', ...options };
  const dir = dirname(shimCmd);
  const baseName = basename(shimCmd).replace(/\.(cmd|bat)$/i, '');
  const env = {
    ...(opts.env ?? process.env),
    PATH: `${dir};${(opts.env?.PATH ?? process.env.PATH ?? '')}`,
  };
  const result = spawnSync(baseName, args, { ...opts, env, shell: true });
  if (result.error) log(`spawnCmdShim(${baseName}) error: ${result.error.code ?? ''} ${result.error.message}`);
  if (result.signal) log(`spawnCmdShim killed by signal: ${result.signal} (likely timeout=${opts.timeout}ms)`);
  return result;
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
    const r = spawnNpm(NPM_CMD, ['prefix', '-g'], {
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
  log(`sharp subtree broken [${brokenDep}/package.json missing] — repairing via nested npm install`);
  for (const dep of checkDeps) {
    const dir = join(root, dep);
    const pkgJson = join(dir, 'package.json');
    if (!existsSync(pkgJson) && existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const imcodesDir = join(npmPrefix, 'node_modules', 'imcodes');
  const result = spawnNpm(NPM_CMD, ['install', '--no-save', '--ignore-scripts', 'sharp@0.34.5'], {
    cwd: imcodesDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Sharp install is a small nested install — bound it tighter than
    // top-level npm install so a hung sharp install doesn't burn the
    // full 10-minute budget.
    timeout: 5 * 60_000,
  });
  if (result.status === 0) {
    log('sharp repair succeeded');
  } else {
    log(`sharp repair FAILED [exit ${result.status} signal ${result.signal ?? 'none'}] — semantic memory recall will sticky-disable`);
    if (result.stderr) log(`sharp repair stderr: ${result.stderr.toString().trim()}`);
  }
}

/** Schedule a deferred delete of the runner's tmp dir.
 *
 *  IMPORTANT: only call this on the SUCCESS path.  On failure paths we
 *  PRESERVE the tmp dir (with its upgrade.log) so we have something to
 *  postmortem.  Without this guard, the previous version self-cleaned
 *  60 s after every run regardless of outcome — destroying the diagnostic
 *  trail (lesson from 2026-05-08, three consecutive silent failures
 *  whose upgrade.log files were already gone by the time we looked).
 *
 *  The 60 s defer runs in a detached node child so this script can exit
 *  cleanly without holding open file handles in SCRIPT_DIR. */
function scheduleTmpDelete() {
  if (!SCRIPT_DIR) return;
  const detached = spawn(process.execPath, [
    '-e',
    `setTimeout(() => { try { require('fs').rmSync(${JSON.stringify(SCRIPT_DIR)}, { recursive: true, force: true }); } catch {} }, 60_000);`,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  detached.unref();
}

/** Set to true at the very END of main() — only when every step has
 *  succeeded (or failed in a way we explicitly accept).  The `finally`
 *  block uses this to decide whether to delete the tmp dir or PRESERVE
 *  it for postmortem diagnostics.
 *
 *  Lesson from 2026-05-08: three consecutive failed upgrade attempts on
 *  PID 849488 (targets 2026.5.2070-dev.2047) silently failed AND
 *  self-cleaned their tmp dirs 60 s later, so by the time we looked the
 *  upgrade.log files were gone — we couldn't tell why npm install or
 *  verify or any later step had failed.  Now: fail = preserve. */
let upgradeSucceeded = false;

async function main() {
  log('=== upgrade started ===');
  log(`pkg: ${PKG_SPEC}, target: ${TARGET_VER}`);
  log(`npm: ${NPM_CMD}`);
  log(`script_dir: ${SCRIPT_DIR}`);
  log(`runner_pid: ${process.pid}`);
  trace(0, 'main-entry');

  // Step 1: Acquire upgrade lock (watchdog will park on it).
  // Use a directory write — even if upgrade.lock's parent .imcodes
  // doesn't yet exist for some reason, mkdir is idempotent.
  mkdirSync(join(HOME, '.imcodes'), { recursive: true });
  writeFileSync(LOCK, 'upgrade');
  trace(1, 'lock-acquired');

  // Step 2: Capture old daemon PID.
  const oldPid = readNumber(PIDFILE);
  log(`old daemon PID: ${oldPid ?? 'none'} (kill only after install succeeds)`);
  trace(2, 'old-pid-captured', `pid=${oldPid ?? 'none'}`);

  // Step 3: npm install (bounded heap, bounded wall-clock).  Old daemon
  // stays alive — its .js modules were loaded into V8 at startup, so npm
  // overwriting them on disk doesn't affect the running process.
  const env = {
    ...process.env,
    // Cap heap at 4 GB.  Older versions accumulated --max-old-space-size
    // flags across upgrades because the daemon's relaunched env inherited
    // our setlocal value; that bug is gone now (we don't mutate process
    // env, we just pass a fresh env object to the npm child).
    NODE_OPTIONS: '--max-old-space-size=4096',
  };
  log(`installing ${PKG_SPEC}...`);
  trace(3, 'pre-npm-install');
  const installStartedAt = Date.now();
  if (REGISTRY) log(`pinning npm registry: ${REGISTRY}`);
  const installResult = spawnNpm(
    NPM_CMD,
    // --ignore-scripts: sharp's install hook is unreliable on global
    // npm-prefix installs (see sharpRepair() doc).  Skip post-install,
    // we'll nest-install sharp ourselves below.
    // --registry pins the same source the daemon's pre-flight probe used.
    // --fetch-retries / --fetch-timeout: `npm install -g` removes the old
    // install's files before completing the new one, so a SINGLE transient
    // network drop (ECONNRESET) mid-download aborts the install and leaves
    // BOTH the old and new versions broken — imcodes.cmd + node_modules gone —
    // which permanently bricks the daemon (workers can't spawn, watchdog can't
    // relaunch the missing shim). Observed on a flaky-network Windows host that
    // "kept dying after every upgrade". Retrying the network fetches turns a
    // transient blip into a slow-but-successful upgrade instead of a brick.
    [
      'install', '-g', '--ignore-scripts',
      '--fetch-retries', '4',
      '--fetch-retry-mintimeout', '10000',
      '--fetch-retry-maxtimeout', '120000',
      '--fetch-timeout', '300000',
      ...(REGISTRY ? ['--registry', REGISTRY] : []),
      PKG_SPEC,
    ],
    {
      env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true,
      timeout: NPM_INSTALL_TIMEOUT_MS,
    },
  );
  const installElapsedMs = Date.now() - installStartedAt;
  if (installResult.stdout) log(`npm stdout: ${installResult.stdout.trim()}`);
  if (installResult.stderr) log(`npm stderr: ${installResult.stderr.trim()}`);
  trace(3, 'post-npm-install', `exit=${installResult.status} signal=${installResult.signal ?? 'none'} elapsed=${installElapsedMs}ms`);
  if (installResult.status !== 0) {
    log(`install FAILED (exit ${installResult.status}, signal ${installResult.signal ?? 'none'}) — old daemon untouched, lock released`);
    return;  // finally clears the lock; tmp dir preserved (success flag stays false)
  }
  log('install OK');

  // Step 4: Verify install — shim must exist, version must match (if pinned).
  trace(4, 'pre-resolve-npm-prefix');
  const npmPrefix = resolveNpmPrefix();
  trace(4, 'post-resolve-npm-prefix', `prefix=${npmPrefix ?? 'null'}`);
  if (!npmPrefix) {
    log('could not resolve npm global prefix — aborting');
    return;
  }
  const shim = join(npmPrefix, 'imcodes.cmd');
  if (!existsSync(shim)) {
    log(`shim missing at ${shim} — aborting`);
    return;
  }
  trace(4, 'shim-exists', `path=${shim}`);
  let installedVer = '';
  try {
    const r = spawnCmdShim(shim, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: FAST_CMD_TIMEOUT_MS,
    });
    if (r.status === 0) installedVer = (r.stdout || '').trim();
  } catch { /* ignore */ }
  trace(4, 'post-version-check', `installed=${installedVer || '?'} target=${TARGET_VER}`);
  log(`installed version: ${installedVer || '?'}, target: ${TARGET_VER}`);
  if (TARGET_VER !== 'latest' && installedVer && installedVer !== TARGET_VER) {
    log('version mismatch after install — aborting');
    return;
  }
  // Downgrade guard for `latest`: Linux/macOS refuse to restart when the
  // freshly-installed version is older than the running daemon (a stale mirror
  // `latest` can resolve below a local dev build). Windows had no such guard.
  // The old daemon keeps running (its modules are already loaded in memory);
  // we simply decline to kill + relaunch into the older on-disk version.
  if (TARGET_VER === 'latest' && installedVer && CURRENT_VER) {
    if (compareDaemonVersionsLocal(installedVer, CURRENT_VER) < 0) {
      log(`installed ${installedVer} is OLDER than current ${CURRENT_VER} — refusing to downgrade`);
      return;
    }
  }

  // Step 5: Sharp repair (best effort).
  trace(5, 'pre-sharp-repair');
  try { sharpRepair(npmPrefix); } catch (e) { log(`sharp repair threw: ${e?.message ?? e}`); }
  trace(5, 'post-sharp-repair');

  // Step 6: Kill stale watchdogs and the old daemon.
  trace(6, 'pre-kill-watchdogs');
  log('killing stale watchdogs');
  killStaleWatchdogs();
  trace(6, 'post-kill-watchdogs');
  if (oldPid) {
    log(`stopping old daemon PID ${oldPid}`);
    tryKillPid(oldPid);
    trace(6, 'old-daemon-killed', `pid=${oldPid}`);
  }
  // Brief settle so Windows finishes process teardown before we ask the
  // new shim to do its repair-watchdog dance.
  sleepMs(2_000);

  // Step 7: Regenerate launch chain via the new shim.
  // shim is .cmd → must go through cmd.exe explicitly under Node 24.
  trace(7, 'pre-repair-watchdog');
  log('regenerating launch chain via repair-watchdog');
  try {
    const r = spawnCmdShim(shim, ['repair-watchdog'], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true,
      timeout: FAST_CMD_TIMEOUT_MS,
    });
    if (r.status !== 0) log(`repair-watchdog exit ${r.status}: ${(r.stderr || '').trim()}`);
    trace(7, 'post-repair-watchdog', `exit=${r.status}`);
  } catch (e) {
    log(`repair-watchdog warning: ${e?.message ?? e}`);
  }

  // Step 8: Ask Task Scheduler to own the replacement watchdog. The repair
  // command normally starts it already; this idempotent /Run is a safety net.
  // Never spawn VBS directly here: that creates an unmanaged watchdog which
  // Task Scheduler cannot observe or recover after an external tree-kill.
  trace(8, 'pre-scheduled-task-launch');
  log('starting new watchdog via Task Scheduler');
  try {
    const taskStart = spawnSync('schtasks', ['/Run', '/TN', DAEMON_TASK], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true,
      timeout: FAST_CMD_TIMEOUT_MS,
    });
    trace(8, 'post-scheduled-task-launch', `exit=${taskStart.status}`);
    if (taskStart.status !== 0) {
      log(`scheduled task start warning [exit ${taskStart.status}]: ${(taskStart.stderr || '').trim()}`);
    }
  } catch (e) {
    log(`scheduled task start warning: ${e?.message ?? e}`);
    trace(8, 'scheduled-task-launch-failed');
  }

  // Step 9: Lock removed in `finally` — watchdog exits :wait_loop and
  // launches the new daemon as soon as it sees the lock gone.

  // Step 10: Health check — wait up to 15s for a NEW daemon PID.
  trace(10, 'pre-health-check');
  const deadline = Date.now() + 15_000;
  let newPid = null;
  while (Date.now() < deadline) {
    sleepMs(500);
    const pid = readNumber(PIDFILE);
    if (pid && pid !== oldPid) { newPid = pid; break; }
  }
  if (newPid) {
    log(`health check PASSED: new daemon PID ${newPid}`);
    trace(10, 'health-check-passed', `pid=${newPid}`);
  } else {
    log('health check FAILED: no new daemon PID within 15s (watchdog will keep retrying)');
    trace(10, 'health-check-failed');
  }

  // Mark the run as a success — even a failed health check counts as
  // "ran to completion" because the watchdog will recover.  Only
  // EARLY-RETURN aborts (install fail, no prefix, version mismatch)
  // leave upgradeSucceeded === false → tmp preserved for postmortem.
  upgradeSucceeded = true;
  trace(99, 'main-exit-success');
}

// Top-level try/finally guarantees the lock gets cleared no matter how
// main() exits — clean return, abort, or unexpected throw.  This is the
// invariant the cmd.exe version kept getting wrong.
main()
  .catch((e) => {
    log(`FATAL: ${e?.stack ?? e?.message ?? String(e)}`);
    trace(99, 'main-exit-fatal');
  })
  .finally(() => {
    const cleared = clearLock();
    log(cleared ? 'lock released' : 'WARNING: failed to release lock — watchdog self-heal will recover');
    if (upgradeSucceeded) {
      log('=== upgrade done — tmp dir scheduled for delete in 60s ===');
      scheduleTmpDelete();
    } else {
      // PRESERVE the tmp dir on any failure path so its upgrade.log is
      // available for postmortem.  This is the bug from 2026-05-08 that
      // kept us blind to three consecutive silent failures.
      log(`=== upgrade FAILED — tmp dir PRESERVED for postmortem: ${SCRIPT_DIR} ===`);
      log('grep [trace] in upgrade.log to find the last reached step.');
    }
  });
