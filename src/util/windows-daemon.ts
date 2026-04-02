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

function isTaskRunning(): boolean {
  try {
    const taskInfo = execSync(`schtasks /Query /TN ${WINDOWS_DAEMON_TASK} /FO CSV /NH`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return taskInfo.includes('Running');
  } catch {
    return false;
  }
}

function tryStartScheduledTask(): boolean {
  try {
    execSync(`schtasks /Run /TN ${WINDOWS_DAEMON_TASK}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function tryStartVbsLauncher(): boolean {
  const vbs = resolve(homedir(), '.imcodes', 'daemon-launcher.vbs');
  if (!existsSync(vbs)) return false;
  spawn('wscript', [vbs], { detached: true, stdio: 'ignore' }).unref();
  return true;
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
  spawn('cmd', ['/c', startupCmd], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

/** Restart the Windows daemon by killing the current process and ensuring the
 * watchdog/launcher path is active. Returns true only after a live daemon PID
 * is observed (or immediately if we can prove one is already running). */
export function restartWindowsDaemon(currentPid?: number): boolean {
  const previousPid = readDaemonPid(currentPid);
  if (previousPid) {
    try { execSync(`taskkill /f /pid ${previousPid}`, { stdio: 'ignore' }); } catch { /* not running */ }
  }

  let triggered = false;
  if (tryStartScheduledTask()) {
    triggered = true;
  } else if (isTaskRunning()) {
    // A running scheduled task usually means the watchdog loop is already alive
    // and will relaunch the daemon shortly.
    triggered = true;
  } else if (tryStartVbsLauncher()) {
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
