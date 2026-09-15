import { describe, expect, it } from 'vitest';
import { runShippedServiceRecovery } from '../../src/daemon/service-recovery-runner.js';
import { linuxProcStatLiveness, type ProcessLiveness } from '../../src/daemon/instance-lock.js';
import {
  RECOVERY_MIN_INTERVAL_MS,
  type ServiceRecoveryDeps,
  type ServiceRecoveryStamp,
} from '../../src/daemon/service-recovery.js';

function procStat(state: string, startTicks: string): string {
  const tail = ['1', '2411', '2411', '0', '-1', '4194560', '0', '0', '0', '0',
    '12', '4', '0', '0', '20', '0', '1', '0', startTicks, '0', '0'];
  return `2411 (imcodes) ${state} ${tail.join(' ')}\n`;
}
const ZOMBIE = linuxProcStatLiveness(procStat('Z', '45316174'));
const LIVE = linuxProcStatLiveness(procStat('S', '45316174'));

const NOW = 10_000_000;

function overrides(custom: Partial<ServiceRecoveryDeps> = {}): Partial<ServiceRecoveryDeps> {
  return {
    readUnit: () => ({ activeState: 'active', subState: 'running', mainPid: 1483961 }),
    probeLiveness: (pid) => (pid === 1483961 ? ZOMBIE : LIVE),
    authoritySocketReachable: async () => false,
    listCgroupPids: () => [1483961, 1484002],
    signalPid: () => {},
    readLockMetadata: () => ({
      version: 1, pid: 1483961, startToken: 'linux:45316174', acquiredAt: 1,
      socketPath: '/tmp/daemon.sock', sessionIds: [], residualResources: [],
    }),
    removeLockArtifacts: () => {},
    restartUnit: () => {},
    readRecoveryStamp: () => null,
    writeRecoveryStamp: () => {},
    now: () => NOW,
    sleep: async () => {},
    selfPid: 99_999,
    ...custom,
  };
}

describe('shipped recovery trigger', () => {
  it('recovers the false-active unit exactly once', async () => {
    let restarts = 0;
    const signals: Array<{ pid: number; signal: string }> = [];
    const outcome = await runShippedServiceRecovery(overrides({
      restartUnit: () => { restarts += 1; },
      signalPid: (pid, signal) => signals.push({ pid, signal }),
    }), 'linux');

    expect(outcome).toMatchObject({
      action: 'recovered', zombieMainPid: 1483961, terminatedPids: [1484002], clearedLockArtifacts: true,
    });
    expect(restarts).toBe(1);
    // Never the zombie main PID (signals to it are discarded) and never itself.
    expect(signals.map((s) => s.pid)).not.toContain(1483961);
    expect(signals.map((s) => s.pid)).not.toContain(99_999);
  });

  it('is a no-op while the daemon is genuinely live', async () => {
    let restarts = 0;
    const outcome = await runShippedServiceRecovery(overrides({
      probeLiveness: () => LIVE,
      restartUnit: () => { restarts += 1; },
    }), 'linux');

    expect(outcome).toEqual({ action: 'none', reason: 'main-pid-not-reaped:alive' });
    expect(restarts).toBe(0);
  });

  it('is a no-op when liveness is indeterminate', async () => {
    let restarts = 0;
    const unknown: ProcessLiveness = { status: 'unknown', reason: 'proc-stat-unreadable:EACCES' };
    const outcome = await runShippedServiceRecovery(overrides({
      probeLiveness: () => unknown,
      restartUnit: () => { restarts += 1; },
    }), 'linux');

    expect(outcome).toEqual({ action: 'none', reason: 'main-pid-not-reaped:unknown:proc-stat-unreadable:EACCES' });
    expect(restarts).toBe(0);
  });

  it('is a no-op while the authority socket still answers', async () => {
    let restarts = 0;
    const outcome = await runShippedServiceRecovery(overrides({
      authoritySocketReachable: async () => true,
      restartUnit: () => { restarts += 1; },
    }), 'linux');

    expect(outcome).toEqual({ action: 'none', reason: 'authority-socket-reachable' });
    expect(restarts).toBe(0);
  });

  it('cannot storm: a timer tick inside the spacing window is refused', async () => {
    let restarts = 0;
    const outcome = await runShippedServiceRecovery(overrides({
      readRecoveryStamp: () => ({
        attemptedAt: NOW - RECOVERY_MIN_INTERVAL_MS + 1,
        pid: 7,
        startToken: 'linux:7',
      }),
      restartUnit: () => { restarts += 1; },
    }), 'linux');

    expect(outcome).toEqual({ action: 'none', reason: 'recovery-attempted-recently' });
    expect(restarts).toBe(0);
  });

  it('bounds repeated timer ticks for the same zombie to one restart total', async () => {
    let restarts = 0;
    let stamp: ServiceRecoveryStamp | null = null;
    let clock = NOW;
    const tick = () => runShippedServiceRecovery(overrides({
      readRecoveryStamp: () => stamp,
      writeRecoveryStamp: (value) => { stamp = value; },
      now: () => clock,
      restartUnit: () => { restarts += 1; },
    }), 'linux');

    for (let i = 0; i < 20; i++) {
      await tick();
      clock += 5_000; // a tick every 5s, far tighter than the shipped timer
    }
    expect(restarts).toBe(1);
  });

  it('does nothing on platforms without systemd cgroups', async () => {
    let restarts = 0;
    const outcome = await runShippedServiceRecovery(
      overrides({ restartUnit: () => { restarts += 1; } }),
      'darwin',
    );
    expect(outcome).toEqual({ action: 'none', reason: 'unsupported-platform' });
    expect(restarts).toBe(0);
  });

  it('defers to systemd when the unit is already not active', async () => {
    const outcome = await runShippedServiceRecovery(overrides({
      readUnit: () => ({ activeState: 'failed', subState: 'failed', mainPid: 0 }),
    }), 'linux');
    expect(outcome).toEqual({ action: 'none', reason: 'unit-not-active:failed' });
  });

  it('does nothing when unit state cannot be read', async () => {
    const outcome = await runShippedServiceRecovery(overrides({ readUnit: () => null }), 'linux');
    expect(outcome).toEqual({ action: 'none', reason: 'unit-state-unavailable' });
  });
});
