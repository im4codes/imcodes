import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

const TASK_BASE_NAMES = Object.freeze({
  daemon: 'imcodes-daemon',
  watchdog: 'imcodes-daemon-watchdog',
  's4u-guard': 'imcodes-daemon-s4u-guard',
});

/** Canonical identity used by every Windows per-home registration. */
export function normalizeWindowsTaskHome(home) {
  return win32.resolve(String(home).replaceAll('/', '\\')).replace(/[\\]+$/, '').toLowerCase();
}

export function windowsHomeHash(home) {
  return createHash('sha256').update(normalizeWindowsTaskHome(home), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Return the Task Scheduler name for a role/home pair.  The real user's
 * default installation keeps the historical names; isolated homes receive
 * the same stable short hash used by the lock pipe.
 */
export function windowsTaskName(role, stateHome, defaultHome = stateHome) {
  const base = TASK_BASE_NAMES[role];
  if (!base) throw new Error(`unknown_windows_task_role:${role}`);
  if (normalizeWindowsTaskHome(stateHome) === normalizeWindowsTaskHome(defaultHome)) return base;
  return `${base}-${windowsHomeHash(stateHome)}`;
}

const WATCHDOG_FILE = 'daemon-watchdog.cmd';

function normalizeHome(homePath) {
  return win32.resolve(String(homePath).replaceAll('/', '\\')).replace(/[\\]+$/, '').toLowerCase();
}

export function canonicalWatchdogPath(homePath) {
  return `${normalizeHome(homePath)}\\${WATCHDOG_FILE}`;
}

/**
 * Match one watchdog command line to one state home.  A default-home legacy
 * command that names only `daemon-watchdog.cmd` remains reclaimable, but a
 * command carrying any path is never treated as legacy: it must match the
 * requested canonical artifact exactly.
 */
export function watchdogCommandLineMatchesHome(commandLine, stateHome, defaultStateHome = stateHome) {
  const normalized = String(commandLine ?? '').replaceAll('/', '\\').toLowerCase();
  const marker = WATCHDOG_FILE;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return false;
  if (normalized.includes(canonicalWatchdogPath(stateHome))) return true;
  if (normalizeHome(stateHome) !== normalizeHome(defaultStateHome)) return false;
  const preceding = normalized[markerIndex - 1] ?? '';
  // A slash or drive separator immediately before the artifact means the
  // command contains a recognizable path belonging to some home.
  return preceding !== '\\' && preceding !== ':';
}

/**
 * Match a daemon process command line to one state home.  Unlike watchdogs,
 * daemon processes have no safe legacy no-path exception: a package path by
 * itself does not identify which HOME owns the process.  Callers therefore
 * must only kill a process when its command line contains the canonical state
 * directory (for example an IMCODES_HOME/--home argument).  A command that
 * names another state directory can never match by prefix or substring.
 */
export function daemonCommandLineMatchesHome(commandLine, stateHome, defaultStateHome = stateHome) {
  const normalized = String(commandLine ?? '').replaceAll('/', '\\').toLowerCase();
  const target = normalizeHome(stateHome);
  // Require a path boundary after the canonical state home.  This prevents
  // C:\\Temp\\lock from matching C:\\Temp\\lock2 while still accepting a
  // quoted path followed by a switch, separator, or end of command line.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetRe = new RegExp(`(?:^|[\\s"'=])${escaped}(?=$|[\\s"'/\\\\])`, 'i');
  return targetRe.test(normalized);
}

/** Parse PID/command-line process listings through the daemon matcher. */
export function parseDaemonProcessListing(output, stateHome, defaultStateHome = stateHome) {
  const pids = new Set();
  let pendingPid = null;
  let pendingCommand = '';
  const flush = () => {
    if (pendingPid !== null && daemonCommandLineMatchesHome(pendingCommand, stateHome, defaultStateHome)) {
      pids.add(pendingPid);
    }
    pendingPid = null;
    pendingCommand = '';
  };
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.includes('\t')) {
      const [pidText, ...commandParts] = line.split('\t');
      const pid = Number.parseInt(pidText.trim(), 10);
      if (Number.isFinite(pid) && pid > 0
        && daemonCommandLineMatchesHome(commandParts.join('\t'), stateHome, defaultStateHome)) {
        pids.add(pid);
      }
      continue;
    }
    const pidMatch = line.match(/^ProcessId=(\d+)$/i);
    if (pidMatch) { pendingPid = Number.parseInt(pidMatch[1], 10); continue; }
    const commandMatch = line.match(/^CommandLine=(.*)$/i);
    if (commandMatch) { pendingCommand = commandMatch[1]; continue; }
  }
  flush();
  return [...pids];
}

/** Parse PowerShell tab output or WMIC key/value blocks and apply the matcher. */
export function parseWatchdogProcessListing(output, stateHome, defaultStateHome = stateHome) {
  const pids = new Set();
  let pendingPid = null;
  let pendingCommand = '';
  const flush = () => {
    if (pendingPid !== null && watchdogCommandLineMatchesHome(pendingCommand, stateHome, defaultStateHome)) {
      pids.add(pendingPid);
    }
    pendingPid = null;
    pendingCommand = '';
  };
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.includes('\t')) {
      const [pidText, ...commandParts] = line.split('\t');
      const pid = Number.parseInt(pidText.trim(), 10);
      if (Number.isFinite(pid) && pid > 0
        && watchdogCommandLineMatchesHome(commandParts.join('\t'), stateHome, defaultStateHome)) {
        pids.add(pid);
      }
      continue;
    }
    const pidMatch = line.match(/^ProcessId=(\d+)$/i);
    if (pidMatch) { pendingPid = Number.parseInt(pidMatch[1], 10); continue; }
    const commandMatch = line.match(/^CommandLine=(.*)$/i);
    if (commandMatch) { pendingCommand = commandMatch[1]; continue; }
  }
  flush();
  return [...pids];
}
