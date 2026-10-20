/**
 * Is this daemon PROCESS settled enough to take a server-driven (source:auto) upgrade?
 *
 * The busy gate in `handleDaemonUpgrade` reads in-memory runtime state. A process that has just started has none:
 * no active turn, no pending message, nothing streaming. That says nothing about being idle. After a crash the
 * work that was running is only about to resume from disk (queue rehydrate, tmux sessions re-created, turns
 * resumed), and the server re-offers the upgrade on every reconnect. 158, 2026-10-07: the gate blocked 9 times for
 * 20 min, the daemon was ABRT-killed, and the fresh process upgraded 10 s after boot -- before its durable queue
 * was rehydrated -- and restarted the service under the resuming sessions.
 *
 * Three independent conditions hold a source:auto upgrade back, all measured from THIS process's start:
 *  - settle window: no auto upgrade for DAEMON_UPGRADE_STARTUP_SETTLE_MS after any start;
 *  - startup restore: every DAEMON_STARTUP_PHASES entry must have reported done (a wedged phase stops holding
 *    after DAEMON_UPGRADE_STARTUP_RESTORE_TIMEOUT_MS);
 *  - unclean previous exit: no auto upgrade for DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS.
 * Every hold ends by itself (all are bounded by uptime), so a stale marker or a failed marker write can never pin
 * the daemon on an old version. Manual and forced upgrades never consult this module.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  DAEMON_RUN_STATE,
  DAEMON_RUN_STATE_FILE,
  DAEMON_STARTUP_PHASES,
  DAEMON_UPGRADE_DEFERRAL,
  DAEMON_UPGRADE_STARTUP_RESTORE_TIMEOUT_MS,
  DAEMON_UPGRADE_STARTUP_SETTLE_MS,
  DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS,
  type DaemonStartupPhase,
  type DaemonUpgradeDeferral,
} from '../../shared/daemon-upgrade.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';
import logger from '../util/logger.js';

export interface UpgradeReadinessInput {
  now: number;
  /** Epoch ms this process started. */
  startedAt: number;
  /** The previous process did not exit on purpose. */
  uncleanPreviousExit: boolean;
  phasesDone: ReadonlySet<DaemonStartupPhase>;
  requiredPhases?: readonly DaemonStartupPhase[];
  settleMs?: number;
  uncleanRecoveryMs?: number;
  restoreTimeoutMs?: number;
}

export type UpgradeReadinessVerdict =
  | { ready: true }
  | {
    ready: false;
    deferral: DaemonUpgradeDeferral;
    /** Time until this hold lapses at the latest; the server clamps it into its own retry bounds. */
    retryAfterMs: number;
    pendingPhases: DaemonStartupPhase[];
    uptimeMs: number;
  };

/** Pure decision; the module state below only feeds it. */
export function evaluateUpgradeReadiness(input: UpgradeReadinessInput): UpgradeReadinessVerdict {
  const settleMs = input.settleMs ?? DAEMON_UPGRADE_STARTUP_SETTLE_MS;
  const recoveryMs = input.uncleanRecoveryMs ?? DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS;
  const restoreTimeoutMs = input.restoreTimeoutMs ?? DAEMON_UPGRADE_STARTUP_RESTORE_TIMEOUT_MS;
  const required = input.requiredPhases ?? DAEMON_STARTUP_PHASES;
  // A clock that went backwards must not pin the daemon: treat it as "long since started".
  const uptimeMs = input.now >= input.startedAt ? input.now - input.startedAt : Number.MAX_SAFE_INTEGER;
  const pendingPhases = required.filter((phase) => !input.phasesDone.has(phase));

  // 1. Startup: settle window and the restore phases, in that order of urgency (the longer wait wins).
  const settleRemaining = Math.max(0, settleMs - uptimeMs);
  const restoreRemaining = pendingPhases.length > 0 ? Math.max(0, restoreTimeoutMs - uptimeMs) : 0;
  if (settleRemaining > 0 || restoreRemaining > 0) {
    return {
      ready: false,
      deferral: DAEMON_UPGRADE_DEFERRAL.STARTING_UP,
      retryAfterMs: Math.max(settleRemaining, restoreRemaining),
      pendingPhases: restoreRemaining > 0 ? pendingPhases : [],
      uptimeMs,
    };
  }
  // 2. Recovery from an unclean exit.
  if (input.uncleanPreviousExit) {
    const recoveryRemaining = Math.max(0, recoveryMs - uptimeMs);
    if (recoveryRemaining > 0) {
      return {
        ready: false,
        deferral: DAEMON_UPGRADE_DEFERRAL.UNCLEAN_SHUTDOWN_RECOVERY,
        retryAfterMs: recoveryRemaining,
        pendingPhases: [],
        uptimeMs,
      };
    }
  }
  return { ready: true };
}

// ── run-state marker (clean vs unclean exit) ────────────────────────────────

interface RunStateRecord {
  version: 1;
  state: string;
  pid: number;
  startedAt: number;
}

function runStatePath(): string {
  return join(imcodesStateDir(), DAEMON_RUN_STATE_FILE);
}

/** Atomic (temp + rename) so a crash mid-write leaves the previous record, never a torn one. */
function writeRunState(record: RunStateRecord): boolean {
  const path = runStatePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    // Disk full / read-only state dir: the daemon runs on. A start record that could not be written means the NEXT
    // boot sees no marker (treated as clean); a stop record that could not be written means it sees `running`
    // (treated as unclean) -- bounded either way by the recovery window.
    logger.warn({ err, path }, 'daemon run-state marker could not be written');
    return false;
  }
}

/** What the previous process left behind. Anything unreadable or absent is "not known to be unclean". */
export function readPreviousExitWasUnclean(path = runStatePath()): boolean {
  try {
    if (!existsSync(path)) return false;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunStateRecord> | null;
    return parsed?.state === DAEMON_RUN_STATE.RUNNING;
  } catch {
    return false;
  }
}

// ── module state ────────────────────────────────────────────────────────────

interface TrackingState {
  startedAt: number;
  uncleanPreviousExit: boolean;
  phasesDone: Set<DaemonStartupPhase>;
}

let tracking: TrackingState | null = null;

/**
 * Called once by the daemon that owns the instance lock, before it restores anything. Records this start and
 * remembers whether the previous process exited on purpose. Only that process may call it: the CLI helpers and
 * workers that merely import this module never write the marker.
 */
export function beginUpgradeReadinessTracking(now = Date.now()): { uncleanPreviousExit: boolean } {
  const uncleanPreviousExit = readPreviousExitWasUnclean();
  tracking = { startedAt: now, uncleanPreviousExit, phasesDone: new Set() };
  writeRunState({ version: 1, state: DAEMON_RUN_STATE.RUNNING, pid: process.pid, startedAt: now });
  if (uncleanPreviousExit) {
    logger.warn({ recoveryMs: DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS }, 'daemon: previous process did not exit cleanly; automatic upgrades wait for its work to resume');
  }
  return { uncleanPreviousExit };
}

/** First thing a graceful shutdown does (SIGTERM/SIGINT, `systemctl restart`, the upgrade script's restart). */
export function markGracefulShutdownStarted(): void {
  if (!tracking) return;
  writeRunState({ version: 1, state: DAEMON_RUN_STATE.STOPPING, pid: process.pid, startedAt: tracking.startedAt });
}

export function markStartupPhaseDone(phase: DaemonStartupPhase): void {
  if (!tracking || tracking.phasesDone.has(phase)) return;
  tracking.phasesDone.add(phase);
  logger.info({ phase, uptimeMs: Date.now() - tracking.startedAt }, 'daemon: startup phase done');
}

/**
 * The verdict for a server-driven upgrade right now. A process that never began tracking (tests, tools importing
 * the handler directly) is ready: only the daemon that owns the lock opts into the hold.
 */
export function getUpgradeReadiness(now = Date.now()): UpgradeReadinessVerdict {
  if (!tracking) return { ready: true };
  return evaluateUpgradeReadiness({
    now,
    startedAt: tracking.startedAt,
    uncleanPreviousExit: tracking.uncleanPreviousExit,
    phasesDone: tracking.phasesDone,
  });
}

export function __resetUpgradeReadinessForTests(): void {
  tracking = null;
}

/** Test-only: begin tracking without touching the run-state file. */
export function __beginUpgradeReadinessTrackingForTests(input: { startedAt: number; uncleanPreviousExit: boolean; phasesDone?: Iterable<DaemonStartupPhase> }): void {
  tracking = { startedAt: input.startedAt, uncleanPreviousExit: input.uncleanPreviousExit, phasesDone: new Set(input.phasesDone ?? []) };
}
