import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstanceLock,
  releaseInstanceLock,
  updateInstanceLockDiagnostics,
  type InstanceLockHandle,
} from '../../src/daemon/instance-lock.js';

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
