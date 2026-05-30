import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readDaemonRuntimeStatus,
  readProcessRssBytes,
  recordDaemonServerLinkStatus,
  recordDaemonStart,
} from '../../src/util/daemon-status.js';

describe('daemon heap snapshot (rides existing writes — no dedicated timer)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'imcodes-resource-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('recordDaemonStart captures a heap snapshot with sane byte fields', () => {
    recordDaemonStart({ pid: process.pid, nowMs: 1_000, baseDir: dir, version: '1.0.0' });
    const r = readDaemonRuntimeStatus(dir)?.resources;
    expect(r).toBeDefined();
    expect(r!.capturedAt).toBe(1_000);
    expect(r!.heapTotalBytes).toBeGreaterThan(0);
    expect(r!.heapUsedBytes).toBeGreaterThan(0);
    expect(r!.heapUsedBytes).toBeLessThanOrEqual(r!.heapTotalBytes);
    expect(r!.rssBytes).toBeGreaterThan(0);
    expect(r!.externalBytes).toBeGreaterThanOrEqual(0);
  });

  it('heartbeat write (recordDaemonServerLinkStatus) refreshes the heap snapshot', () => {
    recordDaemonStart({ pid: process.pid, nowMs: 1_000, baseDir: dir, version: '1.0.0' });
    recordDaemonServerLinkStatus({
      state: 'connected',
      pid: process.pid,
      nowMs: 11_000,
      baseDir: dir,
      lastConnectedAt: 11_000,
    });
    const status = readDaemonRuntimeStatus(dir);
    // resource snapshot moved forward with the heartbeat-driven write
    expect(status?.resources?.capturedAt).toBe(11_000);
    expect(status?.serverLink?.state).toBe('connected');
    // pid/uptime accounting preserved
    expect(status?.startedAt).toBe(1_000);
  });
});

describe('readProcessRssBytes (status reads RSS live, no daemon dependency)', () => {
  it('returns a positive byte count for the current process', () => {
    const rss = readProcessRssBytes(process.pid);
    // On the host CI this should succeed; if `ps` is unavailable it returns null
    // rather than throwing — assert that contract.
    if (rss !== null) {
      expect(rss).toBeGreaterThan(0);
      expect(Number.isSafeInteger(rss)).toBe(true);
    }
  });

  it('returns null for an invalid pid without throwing', () => {
    expect(readProcessRssBytes(-1)).toBeNull();
    expect(readProcessRssBytes(0)).toBeNull();
  });

  it('parses ps kilobytes into bytes via an injected runner', () => {
    const fakePs = ((_file: string, _args: string[]) => '20480\n') as never;
    expect(readProcessRssBytes(1234, fakePs, 'linux')).toBe(20480 * 1024);
  });
});
