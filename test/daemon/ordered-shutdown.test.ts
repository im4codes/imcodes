import { describe, expect, it, vi } from 'vitest';
import { runOrderedDaemonShutdown } from '../../src/daemon/ordered-shutdown.js';

describe('ordered daemon shutdown', () => {
  it('closes session, MCP, browser, then container authority in strict order', async () => {
    const order: string[] = [];
    const result = await runOrderedDaemonShutdown({
      session: async () => { order.push('session'); },
      mcp: async () => { order.push('mcp'); },
      browser: async () => { order.push('browser'); },
      container: async () => { order.push('container'); },
    }, { phaseTimeoutMs: 100 });

    expect(order).toEqual(['session', 'mcp', 'browser', 'container']);
    expect(result).toEqual(expect.objectContaining({ ok: true, exitCode: 0, failures: [] }));
  });

  it('bounds a hung phase, force-cleans it, continues in order, and fails closed', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const forceKill = vi.fn(async (phase: string) => { order.push(`force:${phase}`); });
    const promise = runOrderedDaemonShutdown({
      session: () => new Promise<void>(() => {}),
      mcp: async () => { order.push('mcp'); },
      browser: async () => { order.push('browser'); },
      container: async () => { order.push('container'); },
    }, { phaseTimeoutMs: 50, forceKill });
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;
    vi.useRealTimers();

    expect(order).toEqual(['force:session', 'mcp', 'browser', 'container']);
    expect(forceKill).toHaveBeenCalledWith('session', expect.objectContaining({ kind: 'timeout' }));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual([expect.objectContaining({ phase: 'session', kind: 'timeout' })]);
  });

  it('runs 100 complete startup/shutdown-shaped cycles without retaining phase work', async () => {
    let liveResources = 0;
    for (let i = 0; i < 100; i++) {
      liveResources = 4;
      const result = await runOrderedDaemonShutdown({
        session: async () => { liveResources--; },
        mcp: async () => { liveResources--; },
        browser: async () => { liveResources--; },
        container: async () => { liveResources--; },
      }, { phaseTimeoutMs: 100 });
      expect(result.ok).toBe(true);
      expect(liveResources).toBe(0);
    }
  });
});
