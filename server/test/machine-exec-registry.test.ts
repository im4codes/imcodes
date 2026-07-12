import { describe, it, expect } from 'vitest';
import {
  registerPendingExec,
  resolvePendingExec,
  abandonPriorGenerations,
  machineExecRegistryStats,
} from '../src/ws/machine-exec-registry.js';

const result = (correlationId: string) => ({ requestId: 'x', correlationId, ok: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 });

describe('machine-exec pending registry (10.6)', () => {
  it('delivers a result only for the matching (serverId, generation, correlationId)', async () => {
    const p = registerPendingExec('srv1', 'corr-A', 7, 5000);
    // Wrong server, wrong generation, and unknown correlationId are all dropped.
    expect(resolvePendingExec('other', 7, result('corr-A'))).toBe(false);
    expect(resolvePendingExec('srv1', 8, result('corr-A'))).toBe(false);
    expect(resolvePendingExec('srv1', 7, result('corr-UNKNOWN'))).toBe(false);
    // Exact match delivers.
    expect(resolvePendingExec('srv1', 7, result('corr-A'))).toBe(true);
    await expect(p).resolves.toMatchObject({ ok: true, correlationId: 'corr-A' });
  });

  it('a forged result without a matching in-flight entry is dropped and counted', async () => {
    const before = machineExecRegistryStats().droppedResults;
    expect(resolvePendingExec('srvX', 1, result('nope'))).toBe(false);
    expect(machineExecRegistryStats().droppedResults).toBeGreaterThan(before);
  });

  it('a new generation abandons prior-generation pendings as indeterminate (null)', async () => {
    const p = registerPendingExec('srv2', 'corr-B', 3, 5000);
    const abandoned = abandonPriorGenerations('srv2', 4); // reconnect bumps generation to 4
    expect(abandoned).toBe(1);
    await expect(p).resolves.toBeNull(); // → relay reports dispatched_no_result
  });

  it('resolves to null when the deadline elapses', async () => {
    await expect(registerPendingExec('srv3', 'corr-C', 1, 10)).resolves.toBeNull();
  });
});
