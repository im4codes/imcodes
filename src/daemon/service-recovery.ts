import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  probeProcessLiveness,
  readInstanceLockMetadata,
  type InstanceLockMetadata,
  type ProcessLiveness,
} from './instance-lock.js';

/**
 * Recovery for the one state systemd cannot resolve on its own.
 *
 * When the daemon's main process is reaped into `Z` but its `imcodes.service`
 * cgroup still holds residual processes, systemd keeps the unit `active` with a
 * non-zero `MainPID` and therefore never applies `Restart=`. The unit is dead in
 * every way that matters — no authority socket, no proof — yet nothing restarts
 * it. This module detects exactly that state and performs a single bounded
 * repair. Every branch requires positive proof; anything indeterminate returns
 * `none` so a healthy daemon is never torn down.
 */

/** Minimum spacing between repairs, so repeated invocations cannot become a storm. */
export const RECOVERY_MIN_INTERVAL_MS = 60_000;

/** Grace period between SIGTERM and SIGKILL for residual cgroup members. */
export const RESIDUAL_TERMINATION_GRACE_MS = 2_000;

export interface SystemdUnitView {
  activeState: string;
  subState: string;
  mainPid: number;
}

export interface ServiceRecoveryDeps {
  readUnit: () => SystemdUnitView | null;
  probeLiveness: (pid: number) => ProcessLiveness;
  /** True when the daemon authority socket accepts a connection. */
  authoritySocketReachable: () => Promise<boolean>;
  /** PIDs currently accounted to the exact `imcodes.service` cgroup. */
  /** Null means membership could not be proven and recovery must fail closed. */
  listCgroupPids: () => number[] | null;
  signalPid: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  readLockMetadata: () => InstanceLockMetadata | null;
  removeLockArtifacts: () => void;
  restartUnit: () => void;
  readRecoveryStamp: () => ServiceRecoveryStamp | null;
  writeRecoveryStamp: (stamp: ServiceRecoveryStamp) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  selfPid: number;
}

export type ServiceRecoveryOutcome =
  | { action: 'none'; reason: string }
  | {
    action: 'recovered';
    zombieMainPid: number;
    terminatedPids: number[];
    clearedLockArtifacts: boolean;
    restarted: true;
  };

export interface ServiceRecoveryStamp {
  attemptedAt: number;
  pid: number;
  startToken: string;
}

/**
 * Detect and repair a falsely-active unit exactly once.
 *
 * Returns `none` for every state that is not provably the false-active one,
 * including any indeterminate liveness. Performs at most one `restartUnit()`
 * call and never polls for the unit to come back.
 */
export async function recoverFalseActiveDaemonService(
  deps: ServiceRecoveryDeps,
): Promise<ServiceRecoveryOutcome> {
  const unit = deps.readUnit();
  if (!unit) return { action: 'none', reason: 'unit-state-unavailable' };
  if (unit.activeState !== 'active') {
    // systemd already considers the unit down, so its own Restart= applies.
    return { action: 'none', reason: `unit-not-active:${unit.activeState}` };
  }
  if (!Number.isSafeInteger(unit.mainPid) || unit.mainPid <= 0) {
    return { action: 'none', reason: 'unit-has-no-main-pid' };
  }

  const liveness = deps.probeLiveness(unit.mainPid);
  if (liveness.status !== 'reclaimable' || liveness.reason !== 'reaped') {
    // Only a positively reaped main process qualifies. `alive` is healthy and
    // `unknown` is indeterminate; both must be left alone.
    const detail = liveness.status === 'unknown' ? `unknown:${liveness.reason}` : liveness.status;
    return { action: 'none', reason: `main-pid-not-reaped:${detail}` };
  }

  const previous = deps.readRecoveryStamp();
  if (previous?.pid === unit.mainPid && previous.startToken === liveness.startToken) {
    // A failed restart must not make the timer attack the same zombie forever.
    // The next genuine daemon incarnation has a different PID or start token.
    return { action: 'none', reason: 'recovery-already-attempted-for-owner' };
  }
  if (previous && deps.now() - previous.attemptedAt < RECOVERY_MIN_INTERVAL_MS) {
    return { action: 'none', reason: 'recovery-attempted-recently' };
  }

  if (await deps.authoritySocketReachable()) {
    // Something is still serving daemon authority; tearing the cgroup down here
    // would kill a working daemon.
    return { action: 'none', reason: 'authority-socket-reachable' };
  }

  // Terminate only the exact residual members of this unit's cgroup, never this
  // process and never the already-reaped main PID (signals to a zombie are lost).
  const members = deps.listCgroupPids();
  if (members === null) return { action: 'none', reason: 'cgroup-members-unavailable' };
  const residual = members
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    .filter((pid) => pid !== deps.selfPid && pid !== unit.mainPid);

  for (const pid of residual) deps.signalPid(pid, 'SIGTERM');
  if (residual.length > 0) await deps.sleep(RESIDUAL_TERMINATION_GRACE_MS);
  const survivors = residual.filter((pid) => deps.probeLiveness(pid).status === 'alive');
  for (const pid of survivors) deps.signalPid(pid, 'SIGKILL');

  // Clear lock/PID metadata only when it still names the exact reaped owner.
  const recorded = deps.readLockMetadata();
  const clearedLockArtifacts = recorded !== null
    && recorded.pid === unit.mainPid
    && recorded.startToken === liveness.startToken;
  if (clearedLockArtifacts) deps.removeLockArtifacts();

  deps.writeRecoveryStamp({
    attemptedAt: deps.now(),
    pid: unit.mainPid,
    startToken: liveness.startToken,
  });
  deps.restartUnit();
  return {
    action: 'recovered',
    zombieMainPid: unit.mainPid,
    terminatedPids: residual,
    clearedLockArtifacts,
    restarted: true,
  };
}

const RECOVERY_STAMP_PATH = join(homedir(), '.imcodes', 'daemon.recovery-stamp');

export function readRecoveryStamp(path = RECOVERY_STAMP_PATH): ServiceRecoveryStamp | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (/^\d+$/.test(raw)) {
      const attemptedAt = Number.parseInt(raw, 10);
      return Number.isSafeInteger(attemptedAt) && attemptedAt > 0
        ? { attemptedAt, pid: 0, startToken: '' }
        : null;
    }
    const parsed = JSON.parse(raw) as Partial<ServiceRecoveryStamp>;
    return Number.isSafeInteger(parsed.attemptedAt) && Number(parsed.attemptedAt) > 0
      && Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0
      && typeof parsed.startToken === 'string' && parsed.startToken.length > 0
      ? parsed as ServiceRecoveryStamp
      : null;
  } catch {
    return null;
  }
}

export function writeRecoveryStamp(stamp: ServiceRecoveryStamp, path = RECOVERY_STAMP_PATH): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(stamp)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch {
    try { unlinkSync(temporaryPath); } catch { /* already absent */ }
  }
}

export function removeInstanceLockArtifacts(
  metadataPath = join(homedir(), '.imcodes', 'daemon.lock.json'),
  pidPath = join(homedir(), '.imcodes', 'daemon.pid'),
  socketPath = join(homedir(), '.imcodes', 'daemon.sock'),
): void {
  for (const path of [socketPath, metadataPath, pidPath]) {
    try { unlinkSync(path); } catch { /* already absent */ }
  }
}

export { readInstanceLockMetadata, probeProcessLiveness };
