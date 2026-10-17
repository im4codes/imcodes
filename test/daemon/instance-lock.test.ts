import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstanceLock,
  daemonProcessAppearsRunning,
  isReapedProcessState,
  linuxProcStatLiveness,
  ownerRemainsAuthoritative,
  psLiveness,
  releaseInstanceLock,
  updateInstanceLockDiagnostics,
  type InstanceLockHandle,
  type ProcessLiveness,
} from '../../src/daemon/instance-lock.js';

/** Real `/proc/<pid>/stat` shape: `pid (comm) state ppid ...`, starttime is field 22. */
function procStat(state: string, startTicks: string, comm = 'imcodes'): string {
  const tail = ['1', '2411', '2411', '0', '-1', '4194560', '0', '0', '0', '0',
    '12', '4', '0', '0', '20', '0', '1', '0', startTicks, '0', '0'];
  return `2411 (${comm}) ${state} ${tail.join(' ')}\n`;
}

function paths(): { socketPath: string; metadataPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-lock-test-'));
  return { socketPath: join(dir, 'daemon.sock'), metadataPath: join(dir, 'daemon.lock.json') };
}

const handles: InstanceLockHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => releaseInstanceLock(handle)));
});

describe('single-instance authority', () => {
  it('rejects a live owner and reports its exact process identity and residual resources', async () => {
    const lockPaths = paths();
    const first = await acquireInstanceLock({
      ...lockPaths,
      currentIdentity: { pid: 111, startToken: 'boot-a:100' },
      probeProcessStartToken: () => 'boot-a:100',
    });
    handles.push(first);
    updateInstanceLockDiagnostics(first, {
      sessionIds: ['deck_prod_brain'],
      residualResources: ['browser:cdp-9222', 'container:worker-a'],
    });

    await expect(acquireInstanceLock({
      ...lockPaths,
      currentIdentity: { pid: 222, startToken: 'boot-a:200' },
      probeProcessStartToken: () => 'boot-a:100',
    })).rejects.toMatchObject({
      code: 'DAEMON_ALREADY_RUNNING',
      owner: expect.objectContaining({
        pid: 111,
        startToken: 'boot-a:100',
        sessionIds: ['deck_prod_brain'],
        residualResources: ['browser:cdp-9222', 'container:worker-a'],
      }),
    });
  });

  it('reclaims a stale socket only after proving the recorded PID no longer exists', async () => {
    const lockPaths = paths();
    writeFileSync(lockPaths.socketPath, 'stale');
    writeFileSync(lockPaths.metadataPath, JSON.stringify({
      version: 1, pid: 333, startToken: 'boot-old:1', acquiredAt: 1,
      socketPath: lockPaths.socketPath, sessionIds: [], residualResources: [],
    }));

    const handle = await acquireInstanceLock({
      ...lockPaths,
      currentIdentity: { pid: 444, startToken: 'boot-new:1' },
      probeProcessStartToken: () => null,
    });
    handles.push(handle);
    expect(handle.identity).toEqual({ pid: 444, startToken: 'boot-new:1' });
  });

  it('reclaims a stale socket when the PID was reused by a different process start', async () => {
    const lockPaths = paths();
    writeFileSync(lockPaths.socketPath, 'stale');
    writeFileSync(lockPaths.metadataPath, JSON.stringify({
      version: 1, pid: 333, startToken: 'boot-old:1', acquiredAt: 1,
      socketPath: lockPaths.socketPath, sessionIds: ['deck_old_brain'], residualResources: ['container:old'],
    }));

    const handle = await acquireInstanceLock({
      ...lockPaths,
      currentIdentity: { pid: 444, startToken: 'boot-new:1' },
      probeProcessStartToken: (pid) => pid === 333 ? 'boot-new:99' : null,
    });
    handles.push(handle);
    expect(handle.identity.pid).toBe(444);
  });

  it('fails closed instead of unlinking an unreachable lock whose exact owner is alive', async () => {
    const lockPaths = paths();
    writeFileSync(lockPaths.socketPath, 'not-a-socket');
    writeFileSync(lockPaths.metadataPath, JSON.stringify({
      version: 1, pid: 333, startToken: 'boot-a:1', acquiredAt: 1,
      socketPath: lockPaths.socketPath, sessionIds: ['deck_live_brain'], residualResources: ['socket:busy'],
    }));

    await expect(acquireInstanceLock({
      ...lockPaths,
      currentIdentity: { pid: 444, startToken: 'boot-a:2' },
      probeProcessStartToken: () => 'boot-a:1',
    })).rejects.toMatchObject({ code: 'DAEMON_LOCK_OWNER_UNREACHABLE' });
    expect(existsSync(lockPaths.socketPath)).toBe(true);
  });

  it('serializes concurrent stale recovery so exactly one contender becomes authoritative', async () => {
    const lockPaths = paths();
    writeFileSync(lockPaths.socketPath, 'stale');
    const options = {
      ...lockPaths,
      currentIdentity: { pid: 444, startToken: 'same-process:1' },
      probeProcessStartToken: () => 'same-process:1',
    };
    const outcomes = await Promise.allSettled([
      acquireInstanceLock(options),
      acquireInstanceLock(options),
    ]);
    const acquired = outcomes.filter((outcome): outcome is PromiseFulfilledResult<InstanceLockHandle> => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    handles.push(acquired[0].value);
  });

  it('survives 100 acquire/release cycles without socket or metadata residue', async () => {
    const lockPaths = paths();
    for (let i = 0; i < 100; i++) {
      const handle = await acquireInstanceLock({
        ...lockPaths,
        currentIdentity: { pid: 500 + i, startToken: `stress:${i}` },
        probeProcessStartToken: () => null,
      });
      await releaseInstanceLock(handle);
      expect(existsSync(lockPaths.socketPath)).toBe(false);
      expect(existsSync(lockPaths.metadataPath)).toBe(false);
      expect(existsSync(handle.pidPath)).toBe(false);
    }
  });
});



describe('reaped-process liveness', () => {
  it('reports a zombie as reclaimable even though its starttime is unchanged', () => {
    // A zombie keeps /proc/<pid>/stat and the identical starttime it had while
    // running, so a starttime-only probe matched the recorded owner forever.
    expect(linuxProcStatLiveness(procStat('S', '8267715')))
      .toEqual({ status: 'alive', startToken: 'linux:8267715' });
    expect(linuxProcStatLiveness(procStat('Z', '8267715')))
      .toEqual({ status: 'reclaimable', reason: 'reaped', startToken: 'linux:8267715' });
    expect(linuxProcStatLiveness(procStat('X', '8267715')))
      .toEqual({ status: 'reclaimable', reason: 'reaped', startToken: 'linux:8267715' });
  });

  it('classifies ps output the same way', () => {
    expect(psLiveness('S Mon Sep  7 17:49:32 2026'))
      .toEqual({ status: 'alive', startToken: 'ps:Mon Sep 7 17:49:32 2026' });
    expect(psLiveness('Z Mon Sep  7 17:49:32 2026'))
      .toEqual({ status: 'reclaimable', reason: 'reaped', startToken: 'ps:Mon Sep 7 17:49:32 2026' });
    expect(psLiveness('   ')).toEqual({ status: 'reclaimable', reason: 'absent' });
  });

  it('parses a comm containing spaces and parentheses', () => {
    expect(linuxProcStatLiveness(procStat('S', '8267715', 'node (worker) x')))
      .toEqual({ status: 'alive', startToken: 'linux:8267715' });
    expect(linuxProcStatLiveness(procStat('Z', '8267715', 'node (worker) x')))
      .toEqual({ status: 'reclaimable', reason: 'reaped', startToken: 'linux:8267715' });
  });

  it('does not mistake a live state for a reaped one', () => {
    for (const reaped of ['Z', 'Z+', 'X', 'x']) expect(isReapedProcessState(reaped)).toBe(true);
    for (const live of ['S', 'Ss', 'R', 'D', 'I', 'T']) expect(isReapedProcessState(live)).toBe(false);
  });
});

describe('fail-closed liveness', () => {
  // Every one of these is indeterminate. Reporting death would authorise lock
  // theft from a process that may well be alive, admitting a second daemon.
  const indeterminate: Array<[string, string]> = [
    ['malformed stat with no comm parens', 'garbage-without-parens'],
    ['stat truncated before starttime', '2411 (imcodes) S 1 2'],
    ['nonnumeric starttime', procStat('S', 'not-a-number')],
  ];

  it.each(indeterminate)('treats %s as unknown rather than dead', (_label, statText) => {
    const liveness = linuxProcStatLiveness(statText);
    expect(liveness.status).toBe('unknown');
    expect(ownerRemainsAuthoritative({ startToken: 'linux:8267715' }, liveness)).toBe(true);
  });

  it('treats malformed ps output as unknown rather than dead', () => {
    const liveness = psLiveness('Zonly-one-token');
    expect(liveness.status).toBe('unknown');
    expect(ownerRemainsAuthoritative({ startToken: 'ps:x' }, liveness)).toBe(true);
  });

  it('refuses to reclaim when the recorded and observed token schemes differ', () => {
    // Same PID measured in two incomparable units. A naive string compare would
    // read this as PID reuse and steal the lock from a live daemon.
    const observed: ProcessLiveness = { status: 'alive', startToken: 'linux:8267715' };
    expect(ownerRemainsAuthoritative({ startToken: 'ps:Mon Sep 7 17:49:32 2026' }, observed)).toBe(true);
    expect(ownerRemainsAuthoritative({ startToken: 'windows:638000' }, observed)).toBe(true);
  });

  it('still reclaims on a genuine same-scheme start mismatch', () => {
    expect(ownerRemainsAuthoritative(
      { startToken: 'linux:111' },
      { status: 'alive', startToken: 'linux:222' },
    )).toBe(false);
  });

  it('only reclaims on positive proof', () => {
    expect(ownerRemainsAuthoritative(
      { startToken: 'linux:1' },
      { status: 'reclaimable', reason: 'reaped', startToken: 'linux:1' },
    )).toBe(false);
    expect(ownerRemainsAuthoritative({ startToken: 'linux:1' }, { status: 'reclaimable', reason: 'absent' })).toBe(false);
    expect(ownerRemainsAuthoritative({ startToken: 'linux:1' }, { status: 'unknown', reason: 'proc-stat-unreadable:EACCES' })).toBe(true);
  });

  it('refuses lock reclaim when the owner probe is indeterminate', async () => {
    const lockPaths = paths();
    writeFileSync(lockPaths.socketPath, 'stale');
    writeFileSync(lockPaths.metadataPath, JSON.stringify({
      version: 1, pid: 2411, startToken: 'linux:8267715', acquiredAt: 1,
      socketPath: lockPaths.socketPath, sessionIds: [], residualResources: [],
    }));

    await expect(acquireInstanceLock({
      ...lockPaths,
      currentIdentity: { pid: 4242, startToken: 'linux:9310002' },
      probeProcessLiveness: () => ({ status: 'unknown', reason: 'proc-stat-unreadable:EACCES' }),
    })).rejects.toMatchObject({ code: 'DAEMON_LOCK_OWNER_UNREACHABLE' });
  });

  it('reclaims the lock deterministically when the recorded owner is a zombie', async () => {
    const lockPaths = paths();
    writeFileSync(lockPaths.socketPath, 'stale');
    writeFileSync(lockPaths.metadataPath, JSON.stringify({
      version: 1, pid: 2411, startToken: 'linux:8267715', acquiredAt: 1,
      socketPath: lockPaths.socketPath, sessionIds: [], residualResources: [],
    }));

    const handle = await acquireInstanceLock({
      ...lockPaths,
      currentIdentity: { pid: 4242, startToken: 'linux:9310002' },
      probeProcessLiveness: (pid) => (pid === 2411
        ? linuxProcStatLiveness(procStat('Z', '8267715'))
        : { status: 'reclaimable', reason: 'absent' }),
    });
    handles.push(handle);
    expect(handle.identity.pid).toBe(4242);
    expect(existsSync(lockPaths.socketPath)).toBe(true);
  });
});

describe('daemon running presentation', () => {
  it('does not present a zombie main process as a running daemon', () => {
    const zombie = (): ProcessLiveness => linuxProcStatLiveness(procStat('Z', '8267715'));
    expect(daemonProcessAppearsRunning(2411, zombie)).toBe(false);
  });

  it('presents a live process as running', () => {
    const live = (): ProcessLiveness => linuxProcStatLiveness(procStat('S', '8267715'));
    expect(daemonProcessAppearsRunning(2411, live)).toBe(true);
  });

  it('does not present an absent process as running', () => {
    expect(daemonProcessAppearsRunning(2411, () => ({ status: 'reclaimable', reason: 'absent' }))).toBe(false);
  });

  it('keeps presenting an uninspectable process as running', () => {
    // Windows daemons launched in another security context land here; calling
    // them stopped made `imcodes status` lie in the opposite direction.
    expect(daemonProcessAppearsRunning(2411, () => ({ status: 'unknown', reason: 'powershell-failed' }))).toBe(true);
  });
});
