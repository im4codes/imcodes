import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECOVERY_MIN_INTERVAL_MS,
  readRecoveryStamp,
  recoverFalseActiveDaemonService,
  writeRecoveryStamp,
  type ServiceRecoveryStamp,
  type ServiceRecoveryDeps,
  type SystemdUnitView,
} from '../../src/daemon/service-recovery.js';
import { linuxProcStatLiveness, type ProcessLiveness } from '../../src/daemon/instance-lock.js';
import type { InstanceLockMetadata } from '../../src/daemon/instance-lock.js';

function procStat(state: string, startTicks: string): string {
  const tail = ['1', '2411', '2411', '0', '-1', '4194560', '0', '0', '0', '0',
    '12', '4', '0', '0', '20', '0', '1', '0', startTicks, '0', '0'];
  return `2411 (imcodes) ${state} ${tail.join(' ')}\n`;
}

const ZOMBIE: ProcessLiveness = linuxProcStatLiveness(procStat('Z', '45316174'));
const LIVE: ProcessLiveness = linuxProcStatLiveness(procStat('S', '45316174'));

interface Harness {
  deps: ServiceRecoveryDeps;
  signals: Array<{ pid: number; signal: string }>;
  restarts: number;
  removedLock: number;
  stamp: { value: ServiceRecoveryStamp | null };
}

function harness(overrides: {
  unit?: SystemdUnitView | null;
  liveness?: Record<number, ProcessLiveness>;
  socketReachable?: boolean;
  cgroupPids?: number[] | null;
  lock?: InstanceLockMetadata | null;
  recoveryStamp?: ServiceRecoveryStamp | null;
  now?: number;
} = {}): Harness {
  const signals: Array<{ pid: number; signal: string }> = [];
  const state = { restarts: 0, removedLock: 0 };
  const stamp = { value: overrides.recoveryStamp ?? null };
  const liveness = overrides.liveness ?? { 1483961: ZOMBIE };
  const killed = new Set<number>();

  const deps: ServiceRecoveryDeps = {
    readUnit: () => (overrides.unit === undefined
      ? { activeState: 'active', subState: 'running', mainPid: 1483961 }
      : overrides.unit),
    probeLiveness: (pid) => {
      if (killed.has(pid)) return { status: 'reclaimable', reason: 'absent' };
      return liveness[pid] ?? { status: 'reclaimable', reason: 'absent' };
    },
    authoritySocketReachable: async () => overrides.socketReachable ?? false,
    listCgroupPids: () => overrides.cgroupPids === undefined ? [] : overrides.cgroupPids,
    signalPid: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === 'SIGKILL') killed.add(pid);
    },
    readLockMetadata: () => (overrides.lock === undefined
      ? {
        version: 1, pid: 1483961, startToken: 'linux:45316174', acquiredAt: 1,
        socketPath: '/tmp/daemon.sock', sessionIds: [], residualResources: [],
      }
      : overrides.lock),
    removeLockArtifacts: () => { state.removedLock += 1; },
    restartUnit: () => { state.restarts += 1; },
    readRecoveryStamp: () => stamp.value,
    writeRecoveryStamp: (value) => { stamp.value = value; },
    now: () => overrides.now ?? 10_000_000,
    sleep: async () => { /* deterministic: no real waiting in tests */ },
    selfPid: 99_999,
  };
  return { deps, signals, get restarts() { return state.restarts; }, get removedLock() { return state.removedLock; }, stamp } as Harness;
}

describe('false-active daemon service recovery', () => {
  it('recovers the exact zombie-MainPID + residual-cgroup state exactly once', async () => {
    // systemd reports the unit active with a non-zero MainPID, but that PID is a
    // zombie and nothing answers on the authority socket, so Restart= never fires.
    const h = harness({ cgroupPids: [1483961, 1484002, 1484003, 99_999] });
    const outcome = await recoverFalseActiveDaemonService(h.deps);

    expect(outcome).toMatchObject({
      action: 'recovered', zombieMainPid: 1483961, clearedLockArtifacts: true, restarted: true,
    });
    // Neither this process nor the unsignalable zombie may be targeted.
    expect(outcome.action === 'recovered' && outcome.terminatedPids).toEqual([1484002, 1484003]);
    expect(h.signals.filter((s) => s.pid === 99_999)).toHaveLength(0);
    expect(h.signals.filter((s) => s.pid === 1483961)).toHaveLength(0);
    expect(h.restarts).toBe(1);
    expect(h.removedLock).toBe(1);
  });

  it('escalates to SIGKILL only for residual processes that survive SIGTERM', async () => {
    const h = harness({
      cgroupPids: [1484002, 1484003],
      liveness: { 1483961: ZOMBIE, 1484002: LIVE, 1484003: { status: 'reclaimable', reason: 'absent' } },
    });
    await recoverFalseActiveDaemonService(h.deps);

    expect(h.signals).toEqual([
      { pid: 1484002, signal: 'SIGTERM' },
      { pid: 1484003, signal: 'SIGTERM' },
      { pid: 1484002, signal: 'SIGKILL' },
    ]);
  });

  it('leaves a healthy daemon completely alone', async () => {
    const h = harness({ liveness: { 1483961: LIVE }, cgroupPids: [1484002] });
    const outcome = await recoverFalseActiveDaemonService(h.deps);

    expect(outcome).toEqual({ action: 'none', reason: 'main-pid-not-reaped:alive' });
    expect(h.signals).toEqual([]);
    expect(h.restarts).toBe(0);
    expect(h.removedLock).toBe(0);
  });

  it('never tears down a unit whose authority socket still answers', async () => {
    // A reachable socket proves a daemon is serving, whatever the main PID looks like.
    const h = harness({ socketReachable: true, cgroupPids: [1484002] });
    const outcome = await recoverFalseActiveDaemonService(h.deps);

    expect(outcome).toEqual({ action: 'none', reason: 'authority-socket-reachable' });
    expect(h.signals).toEqual([]);
    expect(h.restarts).toBe(0);
  });

  it('defers to systemd when the main process is simply gone, not reaped', async () => {
    // An absent MainPID is a state systemd itself notices and acts on. Only the
    // reaped-in-place case wedges it, so only that case is ours to repair.
    const h = harness({ liveness: { 1483961: { status: 'reclaimable', reason: 'absent' } }, cgroupPids: [1484002] });
    const outcome = await recoverFalseActiveDaemonService(h.deps);

    expect(outcome).toEqual({ action: 'none', reason: 'main-pid-not-reaped:reclaimable' });
    expect(h.signals).toEqual([]);
    expect(h.restarts).toBe(0);
  });

  it('fails closed when main-process liveness is indeterminate', async () => {
    const h = harness({ liveness: { 1483961: { status: 'unknown', reason: 'proc-stat-unreadable:EACCES' } } });
    const outcome = await recoverFalseActiveDaemonService(h.deps);

    expect(outcome).toEqual({ action: 'none', reason: 'main-pid-not-reaped:unknown:proc-stat-unreadable:EACCES' });
    expect(h.restarts).toBe(0);
  });

  it('defers to systemd when the unit is not active', async () => {
    for (const activeState of ['inactive', 'failed', 'activating']) {
      const h = harness({ unit: { activeState, subState: 'dead', mainPid: 1483961 } });
      const outcome = await recoverFalseActiveDaemonService(h.deps);
      expect(outcome).toEqual({ action: 'none', reason: `unit-not-active:${activeState}` });
      expect(h.restarts).toBe(0);
    }
  });

  it('does nothing when the unit reports no main process', async () => {
    const h = harness({ unit: { activeState: 'active', subState: 'running', mainPid: 0 } });
    expect(await recoverFalseActiveDaemonService(h.deps))
      .toEqual({ action: 'none', reason: 'unit-has-no-main-pid' });
    expect(h.restarts).toBe(0);
  });

  it('does nothing when unit state cannot be read', async () => {
    const h = harness({ unit: null });
    expect(await recoverFalseActiveDaemonService(h.deps))
      .toEqual({ action: 'none', reason: 'unit-state-unavailable' });
  });

  it('cannot storm: the same zombie owner is never retried', async () => {
    const h = harness({ cgroupPids: [1484002] });
    const first = await recoverFalseActiveDaemonService(h.deps);
    expect(first.action).toBe('recovered');
    expect(h.restarts).toBe(1);

    // Even after many timer intervals, the exact PID+start token is attempted once.
    h.deps.now = () => 10_000_000 + RECOVERY_MIN_INTERVAL_MS * 10;
    const second = await recoverFalseActiveDaemonService(h.deps);
    expect(second).toEqual({ action: 'none', reason: 'recovery-already-attempted-for-owner' });
    expect(h.restarts).toBe(1);
  });

  it('allows a different zombie owner only after the spacing window elapses', async () => {
    const now = 10_000_000;
    const h = harness({
      recoveryStamp: { attemptedAt: now - RECOVERY_MIN_INTERVAL_MS - 1, pid: 7, startToken: 'linux:7' },
      now,
      cgroupPids: [],
    });
    expect((await recoverFalseActiveDaemonService(h.deps)).action).toBe('recovered');
    expect(h.restarts).toBe(1);
  });

  it('clears lock artifacts only when they name the exact reaped owner', async () => {
    const h = harness({
      lock: {
        version: 1, pid: 777777, startToken: 'linux:1', acquiredAt: 1,
        socketPath: '/tmp/daemon.sock', sessionIds: [], residualResources: [],
      },
    });
    const outcome = await recoverFalseActiveDaemonService(h.deps);

    expect(outcome).toMatchObject({ action: 'recovered', clearedLockArtifacts: false });
    expect(h.removedLock).toBe(0);
    expect(h.restarts).toBe(1);
  });

  it('does not clear a reused PID lock whose start token differs', async () => {
    const h = harness({
      lock: {
        version: 1, pid: 1483961, startToken: 'linux:older-incarnation', acquiredAt: 1,
        socketPath: '/tmp/daemon.sock', sessionIds: [], residualResources: [],
      },
    });
    const outcome = await recoverFalseActiveDaemonService(h.deps);

    expect(outcome).toMatchObject({ action: 'recovered', clearedLockArtifacts: false });
    expect(h.removedLock).toBe(0);
  });

  it('fails closed when exact cgroup membership cannot be read', async () => {
    const h = harness({ cgroupPids: null });
    expect(await recoverFalseActiveDaemonService(h.deps))
      .toEqual({ action: 'none', reason: 'cgroup-members-unavailable' });
    expect(h.signals).toEqual([]);
    expect(h.restarts).toBe(0);
  });

  it('recovers with an empty cgroup without signalling anything', async () => {
    const h = harness({ cgroupPids: [] });
    const outcome = await recoverFalseActiveDaemonService(h.deps);
    expect(outcome).toMatchObject({ action: 'recovered', terminatedPids: [] });
    expect(h.signals).toEqual([]);
    expect(h.restarts).toBe(1);
  });

  it('persists the exact attempted owner atomically and reads legacy timestamps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-recovery-stamp-'));
    const path = join(dir, 'stamp');
    try {
      const stamp = { attemptedAt: 10_000_000, pid: 1483961, startToken: 'linux:45316174' };
      writeRecoveryStamp(stamp, path);
      expect(readRecoveryStamp(path)).toEqual(stamp);
      writeFileSync(path, '9000000\n');
      expect(readRecoveryStamp(path)).toEqual({ attemptedAt: 9_000_000, pid: 0, startToken: '' });
      writeFileSync(path, '{broken');
      expect(readRecoveryStamp(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
