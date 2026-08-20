import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLLED_NODE_HEALTH_LEASE_VERSION,
  controlledNodeHealthLeasePath,
  controlledNodeHealthWatchdogStatePath,
  createControlledNodeHealthLeasePublisher,
  createSystemdWatchdogNotifier,
  runMacosControlledNodeHealthWatchdog,
  writeControlledNodeHealthLease,
} from '../../src/node/health-lease.js';

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('controlled-node authenticated health lease', () => {
  it('atomically records one exact process and authenticated heartbeat time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-health-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    const leasePath = controlledNodeHealthLeasePath(journalPath);

    await writeControlledNodeHealthLease(leasePath, 1_786_287_478_406, 3020);

    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toEqual({
      version: CONTROLLED_NODE_HEALTH_LEASE_VERSION,
      pid: 3020,
      updatedAt: 1_786_287_478_406,
    });
  });

  it('throttles heartbeat acknowledgements without losing later renewals', async () => {
    let now = 10_000;
    const writeLease = vi.fn(async () => {});
    const publisher = createControlledNodeHealthLeasePublisher('C:\\ProgramData\\imcodes-node\\health-lease.json', {
      now: () => now,
      pid: 77,
      intervalMs: 15_000,
      writeLease,
    });

    publisher.recordAuthenticatedHeartbeat();
    publisher.recordAuthenticatedHeartbeat();
    await publisher.flush();
    expect(writeLease).toHaveBeenCalledOnce();
    expect(writeLease).toHaveBeenLastCalledWith(expect.any(String), 10_000, 77);

    now += 14_999;
    publisher.recordAuthenticatedHeartbeat();
    await publisher.flush();
    expect(writeLease).toHaveBeenCalledOnce();

    now += 1;
    publisher.recordAuthenticatedHeartbeat();
    await publisher.flush();
    expect(writeLease).toHaveBeenCalledTimes(2);
    expect(writeLease).toHaveBeenLastCalledWith(expect.any(String), 25_000, 77);
  });

  it('reports a failed write and allows the next authenticated heartbeat to retry', async () => {
    let now = 10_000;
    const onError = vi.fn();
    const writeLease = vi.fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined);
    const publisher = createControlledNodeHealthLeasePublisher('lease.json', {
      now: () => now,
      intervalMs: 15_000,
      writeLease,
      onError,
    });

    publisher.recordAuthenticatedHeartbeat();
    await publisher.flush();
    expect(onError).toHaveBeenCalledOnce();

    now += 15_000;
    publisher.recordAuthenticatedHeartbeat();
    await publisher.flush();
    expect(writeLease).toHaveBeenCalledTimes(2);
  });

  it('accepts a fresh PID-bound macOS lease and clears an old failure window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-health-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    await writeControlledNodeHealthLease(controlledNodeHealthLeasePath(journalPath), 999_000, 77);
    await writeFile(controlledNodeHealthWatchdogStatePath(journalPath), JSON.stringify({
      version: 1,
      failureSince: 1,
      reason: 'lease_missing',
    }));
    const restartService = vi.fn();

    await expect(runMacosControlledNodeHealthWatchdog({
      journalPath,
      now: () => 1_000_000,
      processExists: (pid) => pid === 77,
      restartService,
    })).resolves.toEqual({ healthy: true, restarted: false, reason: 'healthy' });
    expect(restartService).not.toHaveBeenCalled();
    await expect(readFile(controlledNodeHealthWatchdogStatePath(journalPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('immediately restarts a live macOS process whose authenticated lease is stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-health-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    await writeControlledNodeHealthLease(controlledNodeHealthLeasePath(journalPath), 819_999, 88);
    const restartService = vi.fn();

    await expect(runMacosControlledNodeHealthWatchdog({
      journalPath,
      now: () => 1_000_000,
      processExists: () => true,
      restartService,
    })).resolves.toEqual({ healthy: false, restarted: true, reason: 'lease_stale' });
    expect(restartService).toHaveBeenCalledOnce();
  });

  it('gives a missing macOS lease one grace window and resets it after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-health-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    let now = 1_000_000;
    const restartService = vi.fn();
    const run = () => runMacosControlledNodeHealthWatchdog({
      journalPath,
      now: () => now,
      processExists: () => false,
      restartService,
    });

    await expect(run()).resolves.toMatchObject({ restarted: false, reason: 'lease_missing' });
    now += 179_999;
    await expect(run()).resolves.toMatchObject({ restarted: false });
    now += 1;
    await expect(run()).resolves.toMatchObject({ restarted: true });
    expect(restartService).toHaveBeenCalledOnce();

    now += 60_000;
    await expect(run()).resolves.toMatchObject({ restarted: false });
    expect(restartService).toHaveBeenCalledOnce();
  });

  it('notifies systemd only from throttled authenticated heartbeat acknowledgements', async () => {
    let now = 50_000;
    const notify = vi.fn(async () => {});
    const notifier = createSystemdWatchdogNotifier({
      now: () => now,
      pid: 4242,
      intervalMs: 15_000,
      notify,
    });

    notifier.recordAuthenticatedHeartbeat();
    notifier.recordAuthenticatedHeartbeat();
    await notifier.flush();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(4242);

    now += 15_000;
    notifier.recordAuthenticatedHeartbeat();
    await notifier.flush();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
