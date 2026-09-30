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
 *   process.argv[9] = npm global prefix owning the running daemon package
 *
 * Exit code:
 *   0 on success or expected abort (install fail, version mismatch).
 *   Non-zero only on truly unexpected runner crash — even then the lock
 *   gets cleaned up via the top-level try/finally before exit.
 */

import { spawnSync, spawn, execSync } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWatchdogProcessListing, windowsTaskName } from './windows-daemon-watchdog.mjs';

// IMCODES_HOME is already the state directory.  Otherwise honor an explicit
// HOME override before falling back to the platform homedir; this keeps
// upgrade.lock and daemon.pid scoped to the same instance as the daemon lock.
function resolveImcodesStateDir() {
  const configured = process.env.IMCODES_HOME?.trim();
  if (configured) return resolve(configured);
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
  return resolve(join(home, '.imcodes'));
}

const IMCODES_HOME = resolveImcodesStateDir();
const LOCK = join(IMCODES_HOME, 'upgrade.lock');
const PIDFILE = join(IMCODES_HOME, 'daemon.pid');
const DEFAULT_STATE_DIR = resolve(join(
  process.env.IMCODES_DEFAULT_HOME?.trim() || homedir(),
  '.imcodes',
));
const DAEMON_TASK = windowsTaskName('daemon', IMCODES_HOME, DEFAULT_STATE_DIR);

const LOG_FILE = process.argv[2];
const NPM_CMD = process.argv[3];
const PKG_SPEC = process.argv[4];
const TARGET_VER = process.argv[5];
const SCRIPT_DIR = process.argv[6];
// "-" sentinel means "use npm's ambient/default registry" (no --registry flag).
const REGISTRY = process.argv[7] && process.argv[7] !== '-' ? process.argv[7] : null;
const CURRENT_VER = process.argv[8] || null;
const NPM_PREFIX = process.argv[9]?.trim() || null;

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
/** How long the health check waits for a new daemon, and how much longer when a daemon was running before
 *  (a cold start after an upgrade can be slow). Overridable so the rollback path is testable in seconds. */
const HEALTH_CHECK_MS = Number(process.env.IMCODES_UPGRADE_HEALTH_MS) || 15_000;
const HEALTH_CHECK_EXTENDED_MS = Number(process.env.IMCODES_UPGRADE_HEALTH_EXTENDED_MS) || 120_000;

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
    PATH: `${npmDir}${delimiter}${(opts.env?.PATH ?? process.env.PATH ?? '')}`,
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
    PATH: `${dir}${delimiter}${(opts.env?.PATH ?? process.env.PATH ?? '')}`,
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
    "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
  try {
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${psScript}"`, {
      encoding: 'utf8', windowsHide: true,
    });
    for (const pid of parseWatchdogProcessListing(out, IMCODES_HOME, DEFAULT_STATE_DIR)) {
      tryKillPid(pid);
    }
    return;
  } catch { /* fall through to wmic */ }
  try {
    const out = execSync(
      `wmic process where "Name='cmd.exe' and CommandLine like '%daemon-watchdog%'" get ProcessId,CommandLine /format:list`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    const pids = parseWatchdogProcessListing(out, IMCODES_HOME, DEFAULT_STATE_DIR);
    for (const pid of pids) tryKillPid(pid);
  } catch { /* both methods failed — best effort */ }
}

/** Resolve the npm global prefix.  We need this to verify the install
 *  shim exists at the right path.  On nvm/fnm/volta/system installs
 *  this lives under different roots — the only authoritative source
 *  is `npm prefix -g` itself. */
function resolveNpmPrefix() {
  if (NPM_PREFIX) return NPM_PREFIX;
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

/** Verify and repair node-datachannel's native addon after the global install.
 *
 * The top-level upgrade intentionally uses --ignore-scripts for sharp, which
 * also skips node-datachannel's native install hook. Rebuild only this optional
 * dependency with lifecycle scripts enabled, then verify it can actually be
 * imported. Failure remains non-fatal because relay upload is still available.
 */
function nodeDatachannelRepair(npmPrefix) {
  const imcodesDir = join(npmPrefix, 'node_modules', 'imcodes');
  const repairScript = join(imcodesDir, 'dist', 'src', 'util', 'node-datachannel-repair.mjs');
  if (!existsSync(repairScript)) {
    log('node-datachannel repair utility absent — relay remains enabled');
    return;
  }
  const result = spawnSync(process.execPath, [repairScript, imcodesDir], {
    env: { ...process.env, IMCODES_NPM_BIN: NPM_CMD },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 6 * 60_000,
  });
  if (result.stderr) log(result.stderr.toString().trim());
  if (result.status !== 0) log('node-datachannel repair unavailable — relay remains enabled');
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

/** The shared staged-install helper, staged next to this runner (it is a separate file so the swap logic
 *  exists once for POSIX and Windows; it is spawned, never imported). */
const STAGED_INSTALL_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'staged-package-install.mjs');

/** Run one command of the helper. stdout/stderr go to the log; the caller reads `.status` (see the helper's exit codes). */
function stagedInstall(command, args, timeout = 10 * 60_000) {
  const result = spawnSync(process.execPath, [STAGED_INSTALL_HELPER, command, ...args], {
    encoding: 'utf8', windowsHide: true, timeout, killSignal: 'SIGKILL',
  });
  if (result.error) log(`[staged-install ${command}] spawn error: ${result.error.code ?? ''} ${result.error.message}`);
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    if (line.trim() && !line.startsWith('VERIFIED_VERSION=')) log(line.trim());
  }
  if (result.stderr) log(`[staged-install ${command}] ${String(result.stderr).trim()}`);
  return result;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** Stop a process and everything it started (workers, MCP servers: they hold the addons). Bounded. */
function stopProcessTree(pid, waitMs = 20_000) {
  if (!pid || pid === process.pid) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: FAST_CMD_TIMEOUT_MS }); } catch { /* not running */ }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* not running */ }
  }
  const deadline = Date.now() + waitMs;
  while (isAlive(pid) && Date.now() < deadline) sleepMs(250);
  if (isAlive(pid)) log(`process ${pid} is still alive ${waitMs} ms after the kill — continuing; the swap will report a lock if it matters`);
}

/**
 * Processes whose command line names the live package directory (a stdio MCP server an agent started from
 * it, a worker the daemon's tree kill missed) hold files inside it and would block the rename. They run the
 * package that is about to be replaced, so they stop with it. Windows only: a POSIX rename does not care.
 */
function stopPackageLockers(packageDir) {
  if (process.platform !== 'win32') return;
  const needle = packageDir.replaceAll('/', '\\').toLowerCase().replaceAll("'", "''");
  // The `imcodes upgrade` command that launched this run also runs from the package and follows the log: it is not a locker.
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle}') -and $_.CommandLine -notmatch '\\supgrade(\\s|$)' } | ForEach-Object { $_.ProcessId }`;
  let out = '';
  try {
    // -EncodedCommand: no shell quoting of a path that may hold spaces, quotes or non-ASCII.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { encoding: 'utf8', windowsHide: true, timeout: FAST_CMD_TIMEOUT_MS });
  } catch (error) {
    log(`lockers query failed: ${error?.message ?? error}`);
    return;
  }
  for (const line of out.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      log(`stopping PID ${pid}: its command line names ${packageDir}`);
      stopProcessTree(pid, 10_000);
    }
  }
}

/** Wait up to `ms` for a live daemon whose pid is not one we killed. */
function waitForNewDaemon(killedPids, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    sleepMs(500);
    const pid = readNumber(PIDFILE);
    if (pid && !killedPids.has(pid) && isAlive(pid)) return pid;
  }
  return null;
}

/** Regenerate the launch chain through the live package's shim and ask Task Scheduler to own the watchdog. */
function relaunchDaemon(shim, stepLabel) {
  trace(7, `pre-repair-watchdog${stepLabel}`);
  log(`regenerating launch chain via repair-watchdog${stepLabel}`);
  try {
    const r = spawnCmdShim(shim, ['repair-watchdog'], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, timeout: FAST_CMD_TIMEOUT_MS,
    });
    if (r.status !== 0) log(`repair-watchdog exit ${r.status}: ${(r.stderr || '').trim()}`);
    trace(7, `post-repair-watchdog${stepLabel}`, `exit=${r.status}`);
  } catch (e) {
    log(`repair-watchdog warning: ${e?.message ?? e}`);
  }
  // Never spawn VBS directly: that creates an unmanaged watchdog Task Scheduler cannot observe or recover.
  trace(8, `pre-scheduled-task-launch${stepLabel}`);
  log(`starting new watchdog via Task Scheduler${stepLabel}`);
  try {
    const taskStart = spawnSync('schtasks', ['/Run', '/TN', DAEMON_TASK], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, timeout: FAST_CMD_TIMEOUT_MS,
    });
    trace(8, `post-scheduled-task-launch${stepLabel}`, `exit=${taskStart.status}`);
    if (taskStart.status !== 0) log(`scheduled task start warning [exit ${taskStart.status}]: ${(taskStart.stderr || '').trim()}`);
  } catch (e) {
    log(`scheduled task start warning: ${e?.message ?? e}`);
    trace(8, `scheduled-task-launch-failed${stepLabel}`);
  }
}

/** The package's bin names, to find their shims in an npm prefix root. */
function binNamesOf(packageDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    return typeof pkg.bin === 'string' ? [pkg.name ?? 'imcodes'] : Object.keys(pkg.bin ?? {});
  } catch {
    return ['imcodes'];
  }
}

const SHIM_SUFFIXES = ['', '.cmd', '.ps1'];

/** Copy the shims of `names` from one prefix root to another (npm writes them at the prefix root). Best effort. */
function copyShims(fromRoot, toRoot, names) {
  for (const name of names) {
    for (const suffix of SHIM_SUFFIXES) {
      const source = join(fromRoot, `${name}${suffix}`);
      if (!existsSync(source)) continue;
      try { copyFileSync(source, join(toRoot, `${name}${suffix}`)); } catch (error) {
        log(`could not copy shim ${name}${suffix}: ${error?.code ?? error?.message ?? error}`);
      }
    }
  }
}

/**
 * Stage, verify, stop the daemon, switch, relaunch, health-check, roll back on failure.
 * Returns true when the run ended in a state worth a clean exit (upgraded, or already current).
 * The daemon is left running, and the old package in place, on every failure BEFORE the stop;
 * after the stop a failed switch or an unhealthy new package puts the old package back and relaunches it.
 */
async function stageAndSwap(npmPrefix, oldPid, env) {
  const globalRoot = join(npmPrefix, 'node_modules');
  const livePackage = join(globalRoot, 'imcodes');
  const stagePrefix = join(npmPrefix, `.imcodes-stage.${process.pid}`);
  const stagedPackage = join(stagePrefix, 'node_modules', 'imcodes');
  const tag = String(process.pid);
  const swapArgs = ['--global-root', globalRoot, '--stage-prefix', stagePrefix, '--tag', tag, '--node', process.execPath];
  const shim = join(npmPrefix, 'imcodes.cmd');
  const killed = new Set(oldPid ? [oldPid] : []);

  // A run that died between its two renames leaves no live package; put it back before anything else,
  // and drop what dead upgrades left behind.
  trace(3, 'pre-recover');
  stagedInstall('recover', ['--global-root', globalRoot], 2 * 60_000);

  // Refuse before changing anything: prefix not writable, not enough free disk (2x the package).
  let expectedBytes = '';
  const view = spawnNpm(NPM_CMD, ['view', '--prefer-online', ...(REGISTRY ? ['--registry', REGISTRY] : []), PKG_SPEC, 'dist.unpackedSize', '--json'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: FAST_CMD_TIMEOUT_MS,
  });
  const reported = Number.parseInt(String(view.stdout ?? '').trim().replace(/^"|"$/g, ''), 10);
  if (view.status === 0 && Number.isFinite(reported) && reported > 0) expectedBytes = String(reported);
  const preflight = stagedInstall('preflight', ['--global-root', globalRoot, '--pkg', PKG_SPEC, ...(expectedBytes ? ['--expected-bytes', expectedBytes] : [])], 2 * 60_000);
  if (preflight.status !== 0) {
    log(`preflight refused the upgrade [exit ${preflight.status}] — nothing was changed; the old daemon keeps running`);
    return false;
  }

  // Stage: npm writes into a sibling prefix (same volume), never into the live package.
  log(`installing ${PKG_SPEC} into the staging prefix ${stagePrefix}...`);
  trace(3, 'pre-npm-install');
  const installStartedAt = Date.now();
  if (REGISTRY) log(`pinning npm registry: ${REGISTRY}`);
  rmSync(stagePrefix, { recursive: true, force: true });
  mkdirSync(stagePrefix, { recursive: true });
  const installResult = spawnNpm(
    NPM_CMD,
    // --ignore-scripts: sharp's install hook is unreliable on global npm-prefix installs (see sharpRepair()
    // doc); skip post-install and nest-install sharp ourselves below. --registry pins the same source the
    // daemon's pre-flight probe used. --fetch-retries / --fetch-timeout: a transient network drop
    // (ECONNRESET) mid-download must not abort the install; retrying turns a blip into a slow success.
    // --prefix: the STAGE. The live package is not touched until it verifies.
    [
      'install', '-g', '--ignore-scripts',
      '--fetch-retries', '4',
      '--fetch-retry-mintimeout', '10000',
      '--fetch-retry-maxtimeout', '120000',
      '--fetch-timeout', '300000',
      '--prefix', stagePrefix,
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
  if (installResult.status !== 0 || !existsSync(stagedPackage)) {
    log(`install FAILED [exit ${installResult.status} signal ${installResult.signal ?? 'none'}] — the stage is discarded, the old package and daemon are untouched, lock released`);
    rmSync(stagePrefix, { recursive: true, force: true });
    return false;
  }
  log('install OK (staged)');

  // Repairs run on the STAGE, so what gets switched in is complete.
  trace(5, 'pre-sharp-repair');
  try { sharpRepair(stagePrefix); } catch (e) { log(`sharp repair threw: ${e?.message ?? e}`); }
  trace(5, 'post-sharp-repair');
  trace(5, 'pre-node-datachannel-repair');
  try { nodeDatachannelRepair(stagePrefix); } catch (e) { log(`node-datachannel repair threw: ${e?.message ?? e}`); }
  trace(5, 'post-node-datachannel-repair');

  // Verify BEFORE the daemon is touched: bins present, entry script prints the target version.
  const verify = spawnSync(process.execPath, [STAGED_INSTALL_HELPER, 'verify', '--pkg-dir', stagedPackage, '--target', TARGET_VER, '--node', process.execPath], {
    encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000, killSignal: 'SIGKILL',
  });
  for (const line of String(verify.stdout ?? '').split(/\r?\n/)) if (line.trim() && !line.startsWith('VERIFIED_VERSION=')) log(line.trim());
  const installedVer = (String(verify.stdout ?? '').match(/^VERIFIED_VERSION=(.+)$/m)?.[1] ?? '').trim();
  trace(4, 'post-version-check', `installed=${installedVer || '?'} target=${TARGET_VER}`);
  log(`installed version: ${installedVer || '?'}, target: ${TARGET_VER}`);
  if (verify.status !== 0 || !installedVer) {
    log(`staged package FAILED verification [exit ${verify.status}] — discarded; the old package and daemon are untouched`);
    rmSync(stagePrefix, { recursive: true, force: true });
    return false;
  }
  // Downgrade guard for `latest`: a stale mirror can resolve below a local dev build. The daemon keeps running.
  if (TARGET_VER === 'latest' && CURRENT_VER && compareDaemonVersionsLocal(installedVer, CURRENT_VER) < 0) {
    log(`installed ${installedVer} is OLDER than current ${CURRENT_VER} — refusing to downgrade`);
    rmSync(stagePrefix, { recursive: true, force: true });
    return false;
  }

  // ---- point of no return is the daemon stop; everything below restores the old package on failure ----
  trace(6, 'pre-kill-watchdogs');
  log('killing stale watchdogs');
  killStaleWatchdogs();
  trace(6, 'post-kill-watchdogs');
  if (oldPid) {
    log(`stopping old daemon PID ${oldPid} (and its process tree)`);
    stopProcessTree(oldPid);
    trace(6, 'old-daemon-killed', `pid=${oldPid}`);
  }
  stopPackageLockers(livePackage);
  // Brief settle so Windows releases the image files before the rename.
  sleepMs(2_000);

  const restartPrevious = (why) => {
    log(`${why} — relaunching the previous version`);
    relaunchDaemon(shim, ' [previous version]');
    // The watchdog parks on upgrade.lock: release it so the relaunched daemon can actually start.
    clearLock();
    const pid = waitForNewDaemon(killed, 45_000);
    log(pid ? `previous version is running again: PID ${pid}` : 'WARNING: no live daemon after relaunching the previous version — the watchdog will keep retrying');
  };

  trace(9, 'pre-switch');
  const oldShimsDir = join(SCRIPT_DIR || npmPrefix, 'shims-old');
  try { mkdirSync(oldShimsDir, { recursive: true }); copyShims(npmPrefix, oldShimsDir, binNamesOf(livePackage)); } catch { /* best effort */ }
  const switched = stagedInstall('switch', swapArgs, 3 * 60_000);
  trace(9, 'post-switch', `exit=${switched.status}`);
  if (switched.status !== 0) {
    log(`switch FAILED [exit ${switched.status}] — the previous package is in place (a rename stayed locked or failed)`);
    restartPrevious('switch failed');
    rmSync(stagePrefix, { recursive: true, force: true });
    return false;
  }
  copyShims(stagePrefix, npmPrefix, binNamesOf(livePackage));

  const rollBack = (why) => {
    log(`ROLLBACK: ${why}`);
    // Hold the lock again: the watchdog must not start a daemon inside the package being put back.
    try { writeFileSync(LOCK, 'upgrade'); } catch { /* the daemon is already stopped; best effort */ }
    killStaleWatchdogs();
    for (const pid of [readNumber(PIDFILE)].filter(Boolean)) { killed.add(pid); stopProcessTree(pid); }
    stopPackageLockers(livePackage);
    sleepMs(2_000);
    const back = stagedInstall('rollback', swapArgs, 3 * 60_000);
    if (back.status !== 0) {
      log(`ROLLBACK FAILED [exit ${back.status}] — the previous package is kept as ${join(globalRoot, `.imcodes-old.${tag}`)}`);
      return;
    }
    try { copyShims(oldShimsDir, npmPrefix, binNamesOf(livePackage)); } catch { /* best effort */ }
    restartPrevious('rolled back');
    rmSync(stagePrefix, { recursive: true, force: true });
  };

  // The live shim must exist and run the new package.
  trace(4, 'pre-resolve-npm-prefix');
  trace(4, 'post-resolve-npm-prefix', `prefix=${npmPrefix}`);
  if (!existsSync(shim)) {
    log(`shim missing at ${shim}`);
    rollBack('the new package has no shim');
    return false;
  }
  trace(4, 'shim-exists', `path=${shim}`);
  let shimVersion = '';
  try {
    const r = spawnCmdShim(shim, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: FAST_CMD_TIMEOUT_MS });
    if (r.status === 0) shimVersion = (r.stdout || '').trim();
  } catch { /* ignore */ }
  if (shimVersion !== installedVer) {
    log(`the live shim prints [${shimVersion || '?'}], expected [${installedVer}]`);
    rollBack('the shim does not run the new package');
    return false;
  }

  relaunchDaemon(shim, '');

  // Step 9: release the lock now -- the watchdog exits :wait_loop and launches the new daemon as soon as the
  // lock is gone, and the health check below needs that daemon. (The `finally` clears it again if a throw skips this.)
  clearLock();
  // Step 10: health check -- 15 s as before, extended (only when a daemon was running before) before judging the package unusable.
  trace(10, 'pre-health-check');
  let newPid = waitForNewDaemon(killed, HEALTH_CHECK_MS);
  if (!newPid && oldPid) {
    log(`no new daemon after ${HEALTH_CHECK_MS} ms; a daemon was running before, so waiting up to ${HEALTH_CHECK_EXTENDED_MS} ms more before judging the new package unusable`);
    newPid = waitForNewDaemon(killed, HEALTH_CHECK_EXTENDED_MS);
  }
  if (newPid) {
    log(`health check PASSED: new daemon PID ${newPid}`);
    trace(10, 'health-check-passed', `pid=${newPid}`);
  } else if (oldPid) {
    log('health check FAILED: no new daemon within the extended wait');
    trace(10, 'health-check-failed');
    rollBack('the daemon did not come back on the new package');
    return false;
  } else {
    log('health check: no daemon was running before, none is expected (the watchdog will start one)');
    trace(10, 'health-check-skipped');
  }

  stagedInstall('commit', ['--global-root', globalRoot, '--stage-prefix', stagePrefix, '--tag', tag], 2 * 60_000);
  return true;
}

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
  mkdirSync(IMCODES_HOME, { recursive: true });
  writeFileSync(LOCK, 'upgrade');
  trace(1, 'lock-acquired');

  // Step 2: Capture old daemon PID. It is stopped only after the new package is staged and verified.
  const oldPid = readNumber(PIDFILE);
  log(`old daemon PID: ${oldPid ?? 'none'} (stopped only after the new package is staged and verified)`);
  trace(2, 'old-pid-captured', `pid=${oldPid ?? 'none'}`);

  const env = {
    ...process.env,
    // Cap heap at 4 GB.  Older versions accumulated --max-old-space-size
    // flags across upgrades because the daemon's relaunched env inherited
    // our setlocal value; that bug is gone now (we don't mutate process
    // env, we just pass a fresh env object to the npm child).
    NODE_OPTIONS: '--max-old-space-size=4096',
  };

  // The prefix must be known up front: the stage and the swap live inside it.
  trace(4, 'pre-resolve-npm-prefix');
  const npmPrefix = resolveNpmPrefix();
  trace(4, 'post-resolve-npm-prefix', `prefix=${npmPrefix ?? 'null'}`);
  if (!npmPrefix) {
    log('could not resolve npm global prefix — aborting');
    return;
  }
  log(`npm prefix: ${npmPrefix}`);

  const ok = await stageAndSwap(npmPrefix, oldPid, env);

  // Mark the run as a success only when the swap ended well (or was a clean refusal we
  // explicitly accept, like the downgrade guard: those return false and PRESERVE the tmp dir
  // for postmortem). A failed health check with no daemon expected still counts as done.
  if (ok) {
    upgradeSucceeded = true;
    trace(99, 'main-exit-success');
  } else {
    trace(99, 'main-exit-not-upgraded');
  }
}

// A staged-runner smoke check loads the module without starting an upgrade.
// Production invocations never pass these flags; they are only used by the
// bounded staging guard test.
if (process.argv.includes('--help') || process.argv.includes('--dry-run')) {
  console.log('windows-upgrade-runner: staged dependency closure loaded');
} else {
  // Top-level try/finally guarantees the lock gets cleared no matter how
  // main() exits — clean return, abort, or unexpected throw.
  // This is the invariant the cmd.exe version kept getting wrong.
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
}
