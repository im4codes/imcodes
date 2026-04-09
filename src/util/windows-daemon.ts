import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

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
  } catch {
    return false;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Tree-kill every cmd.exe process whose command line references
 *  daemon-watchdog.  Works on any locale because the wmic query and
 *  taskkill commands are language-independent.
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
  try {
    const out = execSync(
      'wmic process where "Name=\'cmd.exe\' and CommandLine like \'%daemon-watchdog%\'" get ProcessId /format:list',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pids = out
      .split(/\r?\n/)
      .map((line) => line.match(/^ProcessId=(\d+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => parseInt(m[1], 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
    for (const pid of pids) {
      try { execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore' }); } catch { /* already dead */ }
    }
  } catch { /* wmic missing or no matches */ }
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
    execSync(`schtasks /Run /TN ${WINDOWS_DAEMON_TASK}`, { stdio: 'ignore' });
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
    try { execSync(`taskkill /f /pid ${previousPid}`, { stdio: 'ignore' }); } catch { /* not running */ }
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
