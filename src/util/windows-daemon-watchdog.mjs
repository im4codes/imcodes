import { win32 } from 'node:path';

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
