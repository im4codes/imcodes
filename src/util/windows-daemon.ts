import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WINDOWS_DAEMON_TASK = 'imcodes-daemon';

function readDaemonPid(currentPid?: number): number | null {
  const pidFile = resolve(homedir(), '.imcodes', 'daemon.pid');
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid || pid <= 0 || pid === currentPid) return null;
    return pid;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM on Windows means the process IS alive but was spawned in a
    // different security context (e.g. via VBS/watchdog detached launch).
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Tree-kill every cmd.exe process whose command line references
 *  daemon-watchdog.  Works on any Windows locale and any Windows version
 *  (Windows 10/11, Server 2016/2019/2022/2025) — newer Windows Server
 *  images have deprecated `wmic`, so we use PowerShell's CIM cmdlets.
 *
 *  Why this exists:
 *    - Old daemon installs (pre-fix) wrote watchdog.cmd with a UTF-8 BOM.
 *    - cmd.exe parses [BOM]@echo as the unknown command "[BOM]@echo" and
 *      crash-loops forever printing the same error.
 *    - Restart/upgrade must KILL these zombies before laying down new
 *      files; otherwise the old watchdog re-spawns on the next loop tick
 *      and overwrites the daemon PID with a stale one.
 *
 *  This function is best-effort: it logs nothing and swallows all errors. */
export function killAllStaleWatchdogs(): void {
  if (process.platform !== 'win32') return;
  const pids = findStaleWatchdogPids();
  for (const pid of pids) {
    try { execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', windowsHide: true }); } catch { /* already dead */ }
  }
}

/** Enumerate cmd.exe processes whose command line references daemon-watchdog.
 *  Tries PowerShell via a temp .ps1 file (works on every Windows since 7),
 *  then falls back to wmic for legacy Windows where PowerShell is missing.
 *
 *  CRITICAL: PowerShell command must be in a .ps1 FILE, not passed via
 *  `-Command "..."`.  When the script contains nested double quotes
 *  (e.g. inside a Filter clause), cmd.exe→powershell command-line parsing
 *  closes the outer quote prematurely and the script becomes truncated.
 *  This was the root cause of the CI failure. */
function findStaleWatchdogPids(): number[] {
  const pids = new Set<number>();
  // ── PowerShell path (works on every Windows since 7) ────────────────────
  let scriptDir: string | null = null;
  try {
    scriptDir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-query-'));
    const scriptPath = join(scriptDir, 'find-stale.ps1');
    // Use single quotes around 'cmd.exe' inside the filter to avoid escaping
    // headaches.  Format-Wide -Property ProcessId so each PID is on its own
    // line for easy parsing.
    writeFileSync(
      scriptPath,
      "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*daemon-watchdog*' } | " +
        "ForEach-Object { $_.ProcessId }\r\n",
    );
    const out = execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
  } catch { /* fall through to wmic */ } finally {
    if (scriptDir) {
      try { rmSync(scriptDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  if (pids.size > 0) return [...pids];
  // ── Legacy wmic path ────────────────────────────────────────────────────
  try {
    const out = execSync(
      'wmic process where "Name=\'cmd.exe\' and CommandLine like \'%daemon-watchdog%\'" get ProcessId /format:list',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^ProcessId=(\d+)/);
      if (m) {
        const pid = parseInt(m[1], 10);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
    }
  } catch { /* both methods failed */ }
  return [...pids];
}

// ── Launcher methods (all hidden — no visible windows) ──────────────────────

function tryStartVbsLauncher(): boolean {
  const vbs = resolve(homedir(), '.imcodes', 'daemon-launcher.vbs');
  if (!existsSync(vbs)) return false;
  spawn('wscript', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

function tryStartScheduledTask(): boolean {
  try {
    execSync(`schtasks /Run /TN ${WINDOWS_DAEMON_TASK}`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function tryStartStartupShortcut(): boolean {
  const startupCmd = resolve(
    homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'imcodes-daemon.cmd',
  );
  if (!existsSync(startupCmd)) return false;
  const cmdExe = process.env.COMSPEC || `${process.env.SystemRoot || 'C:\\Windows'}\\system32\\cmd.exe`;
  spawn(cmdExe, ['/c', startupCmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

/** Restart the Windows daemon by killing the entire watchdog tree and
 *  spawning a fresh hidden watchdog.
 *
 *  Previous approach only killed the daemon node process, leaving the old
 *  watchdog cmd.exe alive.  The old watchdog would respawn the daemon with
 *  potentially stale code, AND the new launcher would spawn a second watchdog,
 *  leading to duplicate loops and version-mismatch restarts.
 *
 *  Now we:
 *  1. Kill the entire watchdog tree (wscript→cmd→node) so nothing stale remains.
 *  2. Launch a fresh hidden watchdog via VBS (preferred) / schtask / shortcut.
 *  3. Wait for a new daemon PID. */
export function restartWindowsDaemon(currentPid?: number): boolean {
  const previousPid = readDaemonPid(currentPid);
  if (previousPid) {
    // Kill the daemon process. The watchdog loop will detect the exit and
    // restart it automatically (within ~5 seconds).
    try { execSync(`taskkill /f /pid ${previousPid}`, { stdio: 'ignore', windowsHide: true }); } catch { /* not running */ }
  }
  // CRITICAL: also tree-kill any stale daemon-watchdog cmd.exe processes by
  // command-line pattern.  This handles the upgrade-from-bad-watchdog case
  // where an OLD watchdog with a UTF-8 BOM is in a crash-loop printing
  // "is not a recognized command" forever.  Without this kill, the new
  // watchdog we spawn below will race with the old one.
  killAllStaleWatchdogs();

  // If no watchdog is running (e.g. first start after bind), launch one.
  // Priority: VBS (always hidden) > scheduled task > startup shortcut.
  // If a watchdog IS already running, it will restart the daemon on its own —
  // but launching a second VBS is harmless (the daemon lock prevents duplicates,
  // and the extra watchdog exits when it sees "already running").
  let triggered = false;
  if (tryStartVbsLauncher()) {
    triggered = true;
  } else if (tryStartScheduledTask()) {
    triggered = true;
  } else if (tryStartStartupShortcut()) {
    triggered = true;
  }
  if (!triggered) return false;

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pid = readDaemonPid(currentPid);
    if (pid && pid !== previousPid && isPidAlive(pid)) return true;
    if (!previousPid && pid && isPidAlive(pid)) return true;
    sleepMs(250);
  }
  return false;
}

/** Forcefully kill any node.exe process that is listening on the imcodes
 *  daemon's named pipe (`\\.\pipe\imcodes-daemon-lock`).  This handles the
 *  edge case where an orphan daemon survives `taskkill` because it was
 *  spawned with elevated privileges.  We use `wmic process delete` (the
 *  one method that works against permission-denied targets in our test
 *  environment) and PowerShell `Stop-Process -Force` as fallback.
 *
 *  This is the LAST RESORT before bind/restart give up.  Without it, a
 *  user with an orphan daemon from a crashed previous session can never
 *  restart imcodes successfully.
 *
 *  Returns true if at least one orphan was killed. */
export function killOrphanDaemonProcesses(): boolean {
  if (process.platform !== 'win32') return false;
  let killed = false;
  let scriptDir: string | null = null;
  try {
    // Find every node.exe process whose command line references imcodes
    // (covers `node imcodes/dist/src/index.js`, the npm shim, etc.)
    scriptDir = mkdtempSync(join(tmpdir(), 'imcodes-orphan-query-'));
    const scriptPath = join(scriptDir, 'find-orphans.ps1');
    // CRITICAL: filter must be SPECIFIC to the daemon entry point, not just
    // any process with "imcodes" in its command line.  The repo working
    // directory itself contains "imcodes" (C:\Users\X\imcodes-src) so a
    // loose `*imcodes*` filter would kill the test runner itself.
    //
    // The npm-installed imcodes daemon always runs as one of:
    //   "C:\Program Files\nodejs\node.exe" "<npm root>\node_modules\imcodes\dist\src\index.js"
    //   "C:\Users\<user>\AppData\Roaming\npm\imcodes.cmd" start --foreground
    //
    // We match the substring "node_modules\imcodes\dist" which appears in
    // both cases (the .cmd shim resolves to the dist path internally).
    writeFileSync(
      scriptPath,
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*node_modules\\imcodes\\dist*' } | " +
        "ForEach-Object { $_.ProcessId }\r\n",
    );
    const out = execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    const orphanPids = out
      .split(/\r?\n/)
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);

    for (const pid of orphanPids) {
      // Try taskkill first (fast path).  Always pass windowsHide so no
      // console window flashes during the kill chain.
      try {
        execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore', windowsHide: true });
        if (!isPidAlive(pid)) { killed = true; continue; }
      } catch { /* try next method */ }
      // Fallback: wmic delete (works against access-denied targets in some cases)
      try {
        execSync(`wmic process where ProcessId=${pid} delete`, { stdio: 'ignore', windowsHide: true });
        if (!isPidAlive(pid)) { killed = true; continue; }
      } catch { /* try next method */ }
      // Last resort: PowerShell Stop-Process
      try {
        execSync(
          `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`,
          { stdio: 'ignore', windowsHide: true },
        );
        if (!isPidAlive(pid)) { killed = true; }
      } catch { /* gave up */ }
    }
  } catch { /* enumeration failed */ } finally {
    if (scriptDir) {
      try { rmSync(scriptDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  return killed;
}

/** Ensure the imcodes daemon is running on Windows.
 *
 *  This is the SINGLE entry point that bind / restart / repair-watchdog /
 *  upgrade should all call.  It handles every edge case we've hit:
 *
 *  1. Stale daemon.pid file pointing at a dead process
 *  2. Crash-looping watchdog from the BOM bug (killed via command-line match)
 *  3. Orphan daemon holding the named-pipe lock (killed via wmic delete)
 *  4. Missing watchdog files (caller should regenerate before calling this)
 *  5. Multiple watchdogs racing (de-duped: kill all → spawn one)
 *
 *  Returns true if a daemon is alive at the end.  */
export function ensureDaemonRunning(currentPid?: number): boolean {
  if (process.platform !== 'win32') return false;
  // Step 1: kill orphan daemons holding the named-pipe lock
  killOrphanDaemonProcesses();
  // Step 2: kill any stale crash-looping watchdog cmd.exe processes
  killAllStaleWatchdogs();
  // Step 3: spawn a fresh hidden watchdog (VBS > schtask > startup shortcut)
  return restartWindowsDaemon(currentPid);
}
