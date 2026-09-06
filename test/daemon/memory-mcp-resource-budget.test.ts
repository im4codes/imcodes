import { describe, expect, it, vi } from 'vitest';
import {
  MemoryMcpResourceGuard,
  evaluateDaemonTaskAdmission,
} from '../../src/daemon/memory-mcp-resource-guard.js';

describe('memory MCP resource budget', () => {
  it('rejects above the per-process RSS budget and bounds concurrent requests', async () => {
    let rss = 10;
    const guard = new MemoryMcpResourceGuard({ maxConcurrent: 1, maxRssBytes: 20, requestTimeoutMs: 1_000, memoryUsage: () => ({ rss }) });
    let release!: () => void;
    const first = guard.run('first', () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(guard.run('second', async () => 'no')).rejects.toThrow('memory_mcp_concurrency_limit');
    release();
    await first;
    rss = 21;
    expect(guard.memoryLimitExceeded()).toBe(true);
    await expect(guard.run('rss', async () => 'no')).rejects.toThrow('memory_mcp_memory_limit');
  });

  it('times out a request without releasing its concurrency slot until underlying work settles', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const guard = new MemoryMcpResourceGuard({ maxConcurrent: 1, maxRssBytes: 100, requestTimeoutMs: 50, memoryUsage: () => ({ rss: 1 }) });
      const timed = guard.run('slow', () => new Promise<void>((resolve) => { release = resolve; }));
      const rejected = expect(timed).rejects.toThrow('memory_mcp_request_timeout');
      await vi.advanceTimersByTimeAsync(51);
      await rejected;
      await expect(guard.run('next', async () => 'no')).rejects.toThrow('memory_mcp_concurrency_limit');
      release();
      await vi.runAllTimersAsync();
      await expect(guard.run('next', async () => 'ok')).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports sustained single-core CPU and daemon/session memory backpressure deterministically', () => {
    const alarm = vi.fn();
    const guard = new MemoryMcpResourceGuard({ maxConcurrent: 1, maxRssBytes: 100, requestTimeoutMs: 50, memoryUsage: () => ({ rss: 1 }), cpuStrikeLimit: 2, onSustainedCpu: alarm });
    guard.observeCpuWindow(950_000, 1_000);
    expect(alarm).not.toHaveBeenCalled();
    guard.observeCpuWindow(960_000, 1_000);
    expect(alarm).toHaveBeenCalledOnce();

    expect(evaluateDaemonTaskAdmission({ daemonRssBytes: 101, daemonMaxRssBytes: 100, sessionReservedBytes: 0, sessionMaxBytes: 50, systemFreeBytes: 1_000, systemMinFreeBytes: 10 })).toBe('reject');
    expect(evaluateDaemonTaskAdmission({ daemonRssBytes: 85, daemonMaxRssBytes: 100, sessionReservedBytes: 45, sessionMaxBytes: 50, systemFreeBytes: 20, systemMinFreeBytes: 10 })).toBe('queue');
    expect(evaluateDaemonTaskAdmission({ daemonRssBytes: 20, daemonMaxRssBytes: 100, sessionReservedBytes: 10, sessionMaxBytes: 50, systemFreeBytes: 1_000, systemMinFreeBytes: 10 })).toBe('accept');
  });
});
