import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLLED_NODE_LIVENESS_ACTIVITY_WINDOW_MS,
  CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MAX_MS,
  CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MS,
  controlledNodeLivenessBackstopMs,
  CONTROLLED_NODE_UNREACHABLE_WARN_AFTER_MS,
} from '../../shared/controlled-node-service.js';
import {
  CONTROLLED_NODE_HEALTH_LEASE_VERSION,
  controlledNodeHealthLeasePath,
  controlledNodeHealthWatchdogStatePath,
  createControlledNodeHealthLeasePublisher,
  controlledNodeLivenessBackstopStatePath,
  controlledNodeLivenessLeasePath,
  createControlledNodeLivenessPublisher,
  readLivenessBackstopLevel,
  writeLivenessBackstopLevel,
  runMacosControlledNodeHealthWatchdog,
  waitForControlledNodeOnlineLease,
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

  it('keeps lease throttling monotonic when the wall clock moves backward after resume', async () => {
    let wallNow = 1_000_000;
    let monotonicNow = 10_000;
    const writeLease = vi.fn(async () => {});
    const publisher = createControlledNodeHealthLeasePublisher('lease.json', {
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
      intervalMs: 15_000,
      writeLease,
    });

    publisher.recordAuthenticatedHeartbeat();
    await publisher.flush();
    wallNow -= 60 * 60_000;
    monotonicNow += 15_000;
    publisher.recordAuthenticatedHeartbeat();
    await publisher.flush();

    expect(writeLease).toHaveBeenCalledTimes(2);
    expect(writeLease).toHaveBeenLastCalledWith('lease.json', wallNow, process.pid);
  });

  it('accepts install success only after the new service generation publishes an authenticated lease', async () => {
    let monotonicNow = 0;
    let reads = 0;
    await expect(waitForControlledNodeOnlineLease('lease.json', {
      timeoutMs: 1_000,
      pollMs: 100,
      wallNow: () => 50_000,
      monotonicNow: () => monotonicNow,
      sleep: async (ms) => { monotonicNow += ms; },
      processExists: (pid) => pid === 88,
      readLease: async () => {
        reads += 1;
        return reads < 3 ? null : { version: 1, pid: 88, updatedAt: 50_000 };
      },
    })).resolves.toEqual({ version: 1, pid: 88, updatedAt: 50_000 });
  });

  it('fails visibly instead of reporting reinstall success without an authenticated lease', async () => {
    let monotonicNow = 0;
    await expect(waitForControlledNodeOnlineLease('lease.json', {
      timeoutMs: 200,
      pollMs: 100,
      wallNow: () => 50_000,
      monotonicNow: () => monotonicNow,
      sleep: async (ms) => { monotonicNow += ms; },
      readLease: async () => null,
    })).rejects.toThrow('did not authenticate after installation');
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

  it('judges a macOS node by its liveness lease: a long-stale authenticated lease does not restart a node that is still retrying', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-health-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    await writeControlledNodeHealthLease(controlledNodeHealthLeasePath(journalPath), 1_000, 55);
    await writeControlledNodeHealthLease(controlledNodeLivenessLeasePath(journalPath), 999_000, 55);
    const restartService = vi.fn();
    await expect(runMacosControlledNodeHealthWatchdog({
      journalPath, now: () => 1_000_000, processExists: () => true, restartService,
    })).resolves.toEqual({ healthy: true, restarted: false, reason: 'healthy' });
    expect(restartService).not.toHaveBeenCalled();
  });

  it('still restarts a live macOS process when neither lease is fresh (the process is stuck, not offline)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-health-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    await writeControlledNodeHealthLease(controlledNodeHealthLeasePath(journalPath), 1_000, 55);
    await writeControlledNodeHealthLease(controlledNodeLivenessLeasePath(journalPath), 700_000, 55);
    const restartService = vi.fn();
    await expect(runMacosControlledNodeHealthWatchdog({
      journalPath, now: () => 1_000_000, processExists: () => true, restartService,
    })).resolves.toEqual({ healthy: false, restarted: true, reason: 'lease_stale' });
    expect(restartService).toHaveBeenCalledOnce();
  });

  it('a node that predates the liveness lease is still judged by its authenticated lease', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-health-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    await writeControlledNodeHealthLease(controlledNodeHealthLeasePath(journalPath), 999_000, 66);
    const restartService = vi.fn();
    await expect(runMacosControlledNodeHealthWatchdog({
      journalPath, now: () => 1_000_000, processExists: (pid) => pid === 66, restartService,
    })).resolves.toEqual({ healthy: true, restarted: false, reason: 'healthy' });
  });
});

describe('controlled-node liveness (the process is alive and working, whether or not the server answers)', () => {
  function rig(extra: Partial<Parameters<typeof createControlledNodeLivenessPublisher>[0]> = {}) {
    let mono = 0;
    let wall = 1_700_000_000_000;
    const written: Array<{ path: string; at: number; pid: number }> = [];
    const notify = vi.fn(async () => {});
    const publisher = createControlledNodeLivenessPublisher({
      path: 'liveness.json',
      pid: 4242,
      notifyWatchdog: notify,
      now: () => wall,
      monotonicNow: () => mono,
      writeLease: async (path, at, pid) => { written.push({ path, at, pid }); },
      ...extra,
    });
    return { publisher, written, notify, advance: (ms: number) => { mono += ms; wall += ms; } };
  }

  it('keeps feeding the watchdog and the lease for as long as the node keeps trying to reach an unreachable server', async () => {
    const { publisher, written, notify, advance } = rig();
    // 3 hours of a server that never answers: a connection attempt / failure / retry about every 25 s, never an ack.
    for (let elapsed = 0; elapsed < 3 * 3_600_000; elapsed += 15_000) {
      advance(15_000);
      if (elapsed % 25_000 < 15_000) publisher.recordConnectionActivity();
      await publisher.tick();
    }
    expect(written.length).toBeGreaterThan(700);
    expect(notify.mock.calls.length).toBe(written.length);
    expect(notify).toHaveBeenCalledWith(4242);
  });

  it('stops feeding when the connection machinery has been silent for longer than the activity window, so a wedged process is still restarted', async () => {
    const { publisher, written, notify, advance } = rig();
    publisher.recordAuthenticatedHeartbeat();
    advance(CONTROLLED_NODE_LIVENESS_ACTIVITY_WINDOW_MS);
    await publisher.tick();
    expect(written).toHaveLength(1);
    advance(1);
    await publisher.tick();
    await publisher.tick();
    expect(written).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    // any sign of life resumes it
    publisher.recordConnectionActivity();
    await publisher.tick();
    expect(written).toHaveLength(2);
  });

  it('counts the start of the process as activity: a node that has just started is fed before it connects', async () => {
    const { publisher, written, advance } = rig();
    advance(20_000);
    await publisher.tick();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ path: 'liveness.json', pid: 4242 });
  });

  it('a failing lease write never stops the watchdog pulse, nor the other way round (both are reported)', async () => {
    const onError = vi.fn();
    const { publisher, notify } = rig({
      writeLease: async () => { throw new Error('disk full'); },
      onError,
    });
    await publisher.tick();
    expect(notify).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    const second = rig({ notifyWatchdog: async () => { throw new Error('no systemd'); }, onError });
    await second.publisher.tick();
    expect(second.written).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('says in the log that the server has not acknowledged the node, at most once per repeat interval, without restarting anything', async () => {
    const onUnreachable = vi.fn();
    const { publisher, advance, notify } = rig({ onUnreachable });
    for (let elapsed = 0; elapsed < 2 * 3_600_000; elapsed += 15_000) {
      advance(15_000);
      publisher.recordConnectionActivity();
      await publisher.tick();
    }
    // first warning once 5 min passed, then every 30 min: 5, 35, 65, 95 min
    expect(onUnreachable).toHaveBeenCalledTimes(4);
    expect(onUnreachable.mock.calls[0]![0]).toBeGreaterThanOrEqual(CONTROLLED_NODE_UNREACHABLE_WARN_AFTER_MS);
    expect(notify.mock.calls.length).toBeGreaterThan(400);
    // an ack resets the clock
    publisher.recordAuthenticatedHeartbeat();
    onUnreachable.mockClear();
    advance(60_000);
    publisher.recordConnectionActivity();
    await publisher.tick();
    expect(onUnreachable).not.toHaveBeenCalled();
  });

  it('stops renewing (once) when sockets keep opening for 45 minutes without a single ack: stuck in the connection handling, not offline', async () => {
    const onBackstop = vi.fn();
    const { publisher, written, notify, advance } = rig({ onBackstop });
    const period = CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MS;
    for (let elapsed = 0; elapsed < period - 15_000; elapsed += 15_000) {
      advance(15_000);
      publisher.recordConnectionActivity(elapsed % 30_000 === 0 ? 'socket_opened' : 'attempt');
      await publisher.tick();
    }
    const before = written.length;
    expect(before).toBeGreaterThan(150);
    expect(onBackstop).not.toHaveBeenCalled();
    advance(30_000);
    publisher.recordConnectionActivity('socket_opened');
    await publisher.tick();
    await publisher.tick();
    expect(written).toHaveLength(before);
    expect(notify.mock.calls.length).toBe(before);
    expect(onBackstop).toHaveBeenCalledTimes(1);
    expect(onBackstop.mock.calls[0]![1]).toBe(1); // the next process starts one level up
    // an acknowledgement ends it
    publisher.recordAuthenticatedHeartbeat();
    await publisher.tick();
    expect(written).toHaveLength(before + 1);
  });

  it('each restart that no ack followed doubles the period, up to the cap; an ack clears the level', async () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 99].map(controlledNodeLivenessBackstopMs)).toEqual([
      45 * 60_000, 90 * 60_000, 180 * 60_000, 360 * 60_000, CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MAX_MS,
      CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MAX_MS, CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MAX_MS,
      CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MAX_MS, CONTROLLED_NODE_LIVENESS_UNACKED_OPEN_BACKSTOP_MAX_MS,
    ]);
    const onBackstop = vi.fn();
    const onBackstopCleared = vi.fn();
    const { publisher, written, advance } = rig({ backstopLevel: 2, onBackstop, onBackstopCleared });
    // level 2 = 3 hours: nothing happens at 2 h 59 min
    for (let elapsed = 0; elapsed < 3 * 3_600_000 - 30_000; elapsed += 15_000) {
      advance(15_000);
      publisher.recordConnectionActivity('socket_opened');
      await publisher.tick();
    }
    expect(onBackstop).not.toHaveBeenCalled();
    const renewed = written.length;
    advance(60_000);
    publisher.recordConnectionActivity('socket_opened');
    await publisher.tick();
    expect(onBackstop).toHaveBeenCalledWith(expect.any(Number), 3);
    expect(written).toHaveLength(renewed);
    publisher.recordAuthenticatedHeartbeat();
    publisher.recordAuthenticatedHeartbeat();
    expect(onBackstopCleared).toHaveBeenCalledTimes(1);
  });

  it('the level survives the restart in a small file, and a missing or damaged file is level 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-backstop-'));
    temporaryDirs.push(dir);
    const path = controlledNodeLivenessBackstopStatePath(join(dir, 'install-journal.json'));
    expect(await readLivenessBackstopLevel(path)).toBe(0);
    await writeLivenessBackstopLevel(path, 3);
    expect(await readLivenessBackstopLevel(path)).toBe(3);
    await writeLivenessBackstopLevel(path, 500);
    expect(await readLivenessBackstopLevel(path)).toBe(20);
    await writeFile(path, 'not json');
    expect(await readLivenessBackstopLevel(path)).toBe(0);
    await writeFile(path, JSON.stringify({ version: 1, level: -4 }));
    expect(await readLivenessBackstopLevel(path)).toBe(0);
    await writeLivenessBackstopLevel(path, 0);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a server that cannot be reached at all never opens a socket and is never restarted, however long it lasts', async () => {
    const onBackstop = vi.fn();
    const { publisher, written, advance } = rig({ onBackstop });
    for (let elapsed = 0; elapsed < 24 * 3_600_000; elapsed += 15_000) {
      advance(15_000);
      publisher.recordConnectionActivity('attempt');
      await publisher.tick();
    }
    expect(onBackstop).not.toHaveBeenCalled();
    expect(written.length).toBe(24 * 3_600_000 / 15_000);
  });

  it('writes the lease file for real, bound to the exact process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-liveness-'));
    temporaryDirs.push(dir);
    const path = controlledNodeLivenessLeasePath(join(dir, 'install-journal.json'));
    const publisher = createControlledNodeLivenessPublisher({ path, pid: 31337, now: () => 123_456 });
    await publisher.tick();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: CONTROLLED_NODE_HEALTH_LEASE_VERSION, pid: 31337, updatedAt: 123_456,
    });
  });
});
