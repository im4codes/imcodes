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

// ── Kill the watchdog cmd.exe tree that parents the daemon ──────────────────

/** Find the parent PID of a process via wmic. Returns null on failure. */
function getParentPid(pid: number): number | null {
  try {
    const raw = execSync(`wmic process where "ProcessId=${pid}" get ParentProcessId /format:list`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const m = raw.match(/ParentProcessId=(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** Kill the watchdog process tree that parents the daemon.
 *  The tree is: wscript → cmd.exe (watchdog loop) → node.exe (daemon).
 *  We kill the top-level process tree so no stale watchdog keeps respawning. */
function killWatchdogTree(daemonPid: number): void {
  // Walk up to the watchdog (cmd.exe or wscript)
  const parentPid = getParentPid(daemonPid);
  if (!parentPid) return;

  // The parent of the daemon is the watchdog cmd.exe loop.
  // Kill the entire process tree from the watchdog down — this also kills the daemon.
  try {
    execSync(`taskkill /f /t /pid ${parentPid}`, { stdio: 'ignore' });
  } catch { /* already dead */ }
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
  spawn('cmd', ['/c', startupCmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
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
    // Kill the entire watchdog tree, not just the daemon.
    // This prevents the old watchdog from racing with the new one.
    killWatchdogTree(previousPid);
    // Belt-and-suspenders: ensure the daemon itself is dead even if tree-kill missed it
    sleepMs(500);
    if (isPidAlive(previousPid)) {
      try { execSync(`taskkill /f /pid ${previousPid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  }

  // Launch a fresh hidden watchdog.
  // Priority: VBS (always hidden) > scheduled task > startup shortcut.
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
