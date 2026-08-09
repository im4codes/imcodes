import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLLED_NODE_HEALTH_LEASE_VERSION,
  controlledNodeHealthLeasePath,
  createControlledNodeHealthLeasePublisher,
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
});
