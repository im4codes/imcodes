import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `/proc/<pid>/stat` state characters proving the PID entry survives only as a
 *  corpse awaiting its parent's `wait()`. */
const REAPED_PROCESS_STATES = new Set(['Z', 'X', 'x']);

/** Start-token schemes this build can emit. Two different KNOWN schemes describe
 *  the same PID in incomparable units, so they must never be read as a mismatch
 *  when deciding lock reclaim authority, and must fail closed when verifying a
 *  process before signalling it. */
export const KNOWN_START_TOKEN_SCHEMES = new Set(['linux', 'ps', 'windows']);

export function isReapedProcessState(state) {
  return REAPED_PROCESS_STATES.has(String(state || '').charAt(0));
}

export function startTokenScheme(token) {
  if (typeof token !== 'string') return '';
  const separator = token.indexOf(':');
  return separator < 0 ? '' : token.slice(0, separator);
}

/** Classify a raw `/proc/<pid>/stat` payload. Exported so the exact production
 *  decision is testable on any platform against real kernel-shaped input. */
export function linuxProcStatLiveness(statText) {
  const closeParen = statText.lastIndexOf(')');
  if (closeParen < 0) return { status: 'unknown', reason: 'proc-stat-malformed' };
  const fields = statText.slice(closeParen + 2).trim().split(/\s+/);
  const state = fields[0];
  if (!state) return { status: 'unknown', reason: 'proc-stat-missing-state' };
  const startTicks = fields[19];
  if (!startTicks) return { status: 'unknown', reason: 'proc-stat-missing-starttime' };
  if (!/^\d+$/.test(startTicks)) return { status: 'unknown', reason: 'proc-stat-nonnumeric-starttime' };
  if (isReapedProcessState(state)) {
    return { status: 'reclaimable', reason: 'reaped', startToken: `linux:${startTicks}` };
  }
  return { status: 'alive', startToken: `linux:${startTicks}` };
}

/** Classify one `ps -o state= -o lstart=` line. */
export function psLiveness(output) {
  const trimmed = output.trim();
  if (!trimmed) return { status: 'reclaimable', reason: 'absent' };
  const boundary = trimmed.search(/\s/);
  if (boundary < 0) return { status: 'unknown', reason: 'ps-malformed' };
  const started = trimmed.slice(boundary + 1).trim().replace(/\s+/g, ' ');
  if (!started) return { status: 'unknown', reason: 'ps-missing-lstart' };
  if (isReapedProcessState(trimmed.slice(0, boundary))) {
    return { status: 'reclaimable', reason: 'reaped', startToken: `ps:${started}` };
  }
  return { status: 'alive', startToken: `ps:${started}` };
}

export function probeProcessLivenessWithExec(
  pid,
  platform = process.platform,
  runExecFileSync = execFileSync,
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unknown', reason: 'invalid-pid' };
  if (platform === 'linux') {
    try {
      return linuxProcStatLiveness(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (code === 'ENOENT') return { status: 'reclaimable', reason: 'absent' };
      return { status: 'unknown', reason: `proc-stat-unreadable:${code ?? 'unknown'}` };
    }
  }
  if (platform === 'win32') {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (code === 'ESRCH') return { status: 'reclaimable', reason: 'absent' };
    }
    try {
      const started = String(
        runExecFileSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
      ).trim();
      if (!started) return { status: 'unknown', reason: 'powershell-empty' };
      return { status: 'alive', startToken: `windows:${started}` };
    } catch {
      return { status: 'unknown', reason: 'powershell-failed' };
    }
  }
  try {
    const output = String(
      runExecFileSync('ps', ['-o', 'state=', '-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    return psLiveness(output);
  } catch (error) {
    const status = error && typeof error === 'object' ? error.status : undefined;
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === undefined && status === 1) return { status: 'reclaimable', reason: 'absent' };
    return { status: 'unknown', reason: `ps-failed:${code ?? status ?? 'unknown'}` };
  }
}

export function probeProcessLiveness(pid, platform = process.platform) {
  return probeProcessLivenessWithExec(pid, platform, execFileSync);
}

export function probeProcessStartToken(pid, platform = process.platform) {
  const liveness = probeProcessLiveness(pid, platform);
  return liveness.status === 'alive' ? liveness.startToken : null;
}

export function daemonProcessAppearsRunning(pid, probe = probeProcessLiveness) {
  return probe(pid).status !== 'reclaimable';
}

/**
 * Whether a recorded owner must still be treated as the authoritative daemon
 * when acquiring/reclaiming `daemon.lock.json` (fails closed on `unknown` or
 * incomparable schemes so a live daemon cannot be displaced).
 */
export function ownerRemainsAuthoritative(owner, liveness) {
  if (liveness.status === 'unknown') return true;
  if (liveness.status === 'reclaimable') return false;
  const recordedScheme = startTokenScheme(owner.startToken);
  const observedScheme = startTokenScheme(liveness.startToken);
  if (recordedScheme !== observedScheme
    && KNOWN_START_TOKEN_SCHEMES.has(recordedScheme)
    && KNOWN_START_TOKEN_SCHEMES.has(observedScheme)) {
    return true;
  }
  return liveness.startToken === owner.startToken;
}

/**
 * Positive verification that a live OS process matches the recorded lock owner
 * before signalling/stopping it or trusting its daemon identity. Fails closed
 * on missing token, unknown liveness, reaped state, unknown scheme, or
 * cross-scheme token comparisons.
 */
export function ownerMatchesLiveProcess(owner, liveness) {
  if (!owner || typeof owner !== 'object') return false;
  if (typeof owner.startToken !== 'string' || !owner.startToken) return false;
  if (!liveness || liveness.status !== 'alive') return false;
  const recordedScheme = startTokenScheme(owner.startToken);
  const observedScheme = startTokenScheme(liveness.startToken);
  if (!KNOWN_START_TOKEN_SCHEMES.has(recordedScheme) || recordedScheme !== observedScheme) {
    return false;
  }
  return liveness.startToken === owner.startToken;
}

function isStringArray(value) {
  return Array.isArray(value) && value.length <= 10_000 && value.every((item) => typeof item === 'string');
}

export function readInstanceLockMetadata(metadataPath) {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0
      || typeof parsed.startToken !== 'string' || !parsed.startToken
      || typeof parsed.acquiredAt !== 'number' || typeof parsed.socketPath !== 'string'
      || !isStringArray(parsed.sessionIds) || !isStringArray(parsed.residualResources)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function defaultDaemonLockMetadataPath(stateDir) {
  return join(stateDir, 'daemon.lock.json');
}
