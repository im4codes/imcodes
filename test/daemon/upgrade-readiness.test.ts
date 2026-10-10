import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  DAEMON_RUN_STATE,
  DAEMON_RUN_STATE_FILE,
  DAEMON_STARTUP_PHASE,
  DAEMON_STARTUP_PHASES,
  DAEMON_UPGRADE_DEFERRAL,
  DAEMON_UPGRADE_STARTUP_RESTORE_TIMEOUT_MS,
  DAEMON_UPGRADE_STARTUP_SETTLE_MS,
  DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS,
} from '../../shared/daemon-upgrade.js';
import {
  __resetUpgradeReadinessForTests,
  beginUpgradeReadinessTracking,
  evaluateUpgradeReadiness,
  getUpgradeReadiness,
  markGracefulShutdownStarted,
  markStartupPhaseDone,
  readPreviousExitWasUnclean,
} from '../../src/daemon/upgrade-readiness.js';
import { imcodesStateDir } from '../../src/util/imcodes-state-dir.js';

const MIN = 60_000;
const all = new Set(DAEMON_STARTUP_PHASES);
const none = new Set<(typeof DAEMON_STARTUP_PHASES)[number]>();
const base = { now: 10_000_000, startedAt: 10_000_000 - 0 };

describe('evaluateUpgradeReadiness (pure)', () => {
  it('158: ten seconds after a crash restart, everything idle-looking, is NOT ready', () => {
    const verdict = evaluateUpgradeReadiness({ ...base, now: base.startedAt + 10_000, uncleanPreviousExit: true, phasesDone: none });
    expect(verdict).toMatchObject({ ready: false, deferral: DAEMON_UPGRADE_DEFERRAL.STARTING_UP });
    if (!verdict.ready) {
      expect(verdict.retryAfterMs).toBeGreaterThanOrEqual(DAEMON_UPGRADE_STARTUP_SETTLE_MS - 10_000);
      expect(verdict.pendingPhases).toEqual([...DAEMON_STARTUP_PHASES]);
    }
  });

  it('settle window: exact boundary (one ms before holds, at the boundary releases) on a clean start', () => {
    expect(evaluateUpgradeReadiness({ ...base, now: base.startedAt + DAEMON_UPGRADE_STARTUP_SETTLE_MS - 1, uncleanPreviousExit: false, phasesDone: all }).ready).toBe(false);
    expect(evaluateUpgradeReadiness({ ...base, now: base.startedAt + DAEMON_UPGRADE_STARTUP_SETTLE_MS, uncleanPreviousExit: false, phasesDone: all }).ready).toBe(true);
  });

  it('a clean start is NOT held by the 15 minute recovery window', () => {
    expect(evaluateUpgradeReadiness({ ...base, now: base.startedAt + 6 * MIN, uncleanPreviousExit: false, phasesDone: all }).ready).toBe(true);
  });

  it('an unclean start is held until the recovery window ends, with the recovery reason once startup is done', () => {
    const during = evaluateUpgradeReadiness({ ...base, now: base.startedAt + 6 * MIN, uncleanPreviousExit: true, phasesDone: all });
    expect(during).toMatchObject({ ready: false, deferral: DAEMON_UPGRADE_DEFERRAL.UNCLEAN_SHUTDOWN_RECOVERY });
    if (!during.ready) expect(during.retryAfterMs).toBe(DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS - 6 * MIN);
    expect(evaluateUpgradeReadiness({ ...base, now: base.startedAt + DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS, uncleanPreviousExit: true, phasesDone: all }).ready).toBe(true);
  });

  it('every restore phase is required, and each one is named while it is pending', () => {
    for (const done of DAEMON_STARTUP_PHASES) {
      const missing = DAEMON_STARTUP_PHASES.filter((phase) => phase !== done);
      const verdict = evaluateUpgradeReadiness({ ...base, now: base.startedAt + 6 * MIN, uncleanPreviousExit: false, phasesDone: new Set([done]) });
      expect(verdict.ready, `only ${done} done`).toBe(false);
      if (!verdict.ready) expect(verdict.pendingPhases).toEqual(missing);
    }
  });

  it('a phase that never reports stops holding at the restore timeout (never pins the version)', () => {
    expect(evaluateUpgradeReadiness({ ...base, now: base.startedAt + DAEMON_UPGRADE_STARTUP_RESTORE_TIMEOUT_MS - 1, uncleanPreviousExit: false, phasesDone: none }).ready).toBe(false);
    expect(evaluateUpgradeReadiness({ ...base, now: base.startedAt + DAEMON_UPGRADE_STARTUP_RESTORE_TIMEOUT_MS, uncleanPreviousExit: false, phasesDone: none }).ready).toBe(true);
  });

  it('a clock that went backwards cannot pin the daemon', () => {
    expect(evaluateUpgradeReadiness({ ...base, now: base.startedAt - 5 * MIN, uncleanPreviousExit: true, phasesDone: all }).ready).toBe(true);
  });

  it('the retry hint is bounded by the longest remaining hold, never zero while holding', () => {
    for (const uptime of [0, 1, 30_000, 4 * MIN, 5 * MIN - 1]) {
      const verdict = evaluateUpgradeReadiness({ ...base, now: base.startedAt + uptime, uncleanPreviousExit: true, phasesDone: none });
      expect(verdict.ready).toBe(false);
      if (!verdict.ready) {
        expect(verdict.retryAfterMs).toBeGreaterThan(0);
        expect(verdict.retryAfterMs).toBeLessThanOrEqual(DAEMON_UPGRADE_STARTUP_RESTORE_TIMEOUT_MS);
      }
    }
  });
});

describe('run-state marker: clean vs unclean previous exit', () => {
  const file = () => join(imcodesStateDir(), DAEMON_RUN_STATE_FILE);

  beforeEach(() => {
    __resetUpgradeReadinessForTests();
    rmSync(file(), { force: true });
  });
  afterEach(() => {
    __resetUpgradeReadinessForTests();
    rmSync(file(), { force: true });
  });

  it('a first start (no marker) is clean', () => {
    expect(beginUpgradeReadinessTracking().uncleanPreviousExit).toBe(false);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ state: DAEMON_RUN_STATE.RUNNING, pid: process.pid });
  });

  it('a process that never stopped on purpose leaves `running`: the next start is unclean (crash / OOM / SIGKILL)', () => {
    beginUpgradeReadinessTracking();
    expect(readPreviousExitWasUnclean()).toBe(true);
    __resetUpgradeReadinessForTests();
    expect(beginUpgradeReadinessTracking().uncleanPreviousExit).toBe(true);
  });

  it('a graceful shutdown (SIGTERM, systemctl restart, the upgrade script\'s own restart) is NOT mistaken for a crash', () => {
    beginUpgradeReadinessTracking();
    markGracefulShutdownStarted();
    expect(JSON.parse(readFileSync(file(), 'utf8')).state).toBe(DAEMON_RUN_STATE.STOPPING);
    __resetUpgradeReadinessForTests();
    expect(beginUpgradeReadinessTracking().uncleanPreviousExit).toBe(false);
  });

  it('a corrupt or unreadable marker is treated as clean, and never throws', () => {
    mkdirSync(imcodesStateDir(), { recursive: true });
    writeFileSync(file(), '{not json', 'utf8');
    expect(beginUpgradeReadinessTracking().uncleanPreviousExit).toBe(false);
    __resetUpgradeReadinessForTests();
    writeFileSync(file(), JSON.stringify({ state: 12 }), 'utf8');
    expect(beginUpgradeReadinessTracking().uncleanPreviousExit).toBe(false);
  });

  it('a marker that cannot be written (state dir is a file) does not crash the daemon and does not refuse forever', () => {
    // Make the marker path itself a directory: renameSync onto it fails, as a read-only/full disk would.
    rmSync(file(), { force: true, recursive: true });
    mkdirSync(file(), { recursive: true });
    try {
      expect(() => beginUpgradeReadinessTracking(Date.now() - DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS - 1_000)).not.toThrow();
      expect(() => markGracefulShutdownStarted()).not.toThrow();
      // Whatever the marker says, the hold is bounded by this process's uptime: long after the windows it is ready.
      markStartupPhaseDone(DAEMON_STARTUP_PHASE.SESSIONS_RECONCILED);
      expect(getUpgradeReadiness(Date.now() + DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS + MIN).ready).toBe(true);
    } finally {
      rmSync(file(), { force: true, recursive: true });
    }
  });

  it('a stale `running` marker from long ago holds only for the recovery window of THIS process', () => {
    mkdirSync(imcodesStateDir(), { recursive: true });
    writeFileSync(file(), JSON.stringify({ version: 1, state: DAEMON_RUN_STATE.RUNNING, pid: 1, startedAt: 1 }), 'utf8');
    const started = Date.now();
    expect(beginUpgradeReadinessTracking(started).uncleanPreviousExit).toBe(true);
    for (const phase of DAEMON_STARTUP_PHASES) markStartupPhaseDone(phase);
    expect(getUpgradeReadiness(started + 10 * MIN)).toMatchObject({ ready: false, deferral: DAEMON_UPGRADE_DEFERRAL.UNCLEAN_SHUTDOWN_RECOVERY });
    expect(getUpgradeReadiness(started + DAEMON_UPGRADE_UNCLEAN_RECOVERY_MS + 1).ready).toBe(true);
  });

  it('graceful-shutdown marking before tracking began (a helper process) writes nothing', () => {
    markGracefulShutdownStarted();
    expect(existsSync(file())).toBe(false);
  });

  it('phases reported out of order and twice are idempotent', () => {
    const started = Date.now() - 6 * MIN;
    beginUpgradeReadinessTracking(started);
    markStartupPhaseDone(DAEMON_STARTUP_PHASE.TRANSPORT_WARM_RESTORED);
    markStartupPhaseDone(DAEMON_STARTUP_PHASE.TRANSPORT_WARM_RESTORED);
    expect(getUpgradeReadiness()).toMatchObject({ ready: false, pendingPhases: [DAEMON_STARTUP_PHASE.SESSIONS_RECONCILED, DAEMON_STARTUP_PHASE.TRANSPORT_RESUMED] });
    markStartupPhaseDone(DAEMON_STARTUP_PHASE.TRANSPORT_RESUMED);
    markStartupPhaseDone(DAEMON_STARTUP_PHASE.SESSIONS_RECONCILED);
    expect(getUpgradeReadiness().ready).toBe(true);
  });
});
