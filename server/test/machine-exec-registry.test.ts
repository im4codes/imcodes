import { describe, it, expect } from 'vitest';
import {
  registerPendingExec,
  resolvePendingExecChunk,
  resolvePendingExec,
  abandonPriorGenerations,
  abandonAllForTarget,
  cancelPendingExec,
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

  it('delivers live chunks only for the exact target, generation, correlation, and next sequence', async () => {
    const chunks: Array<{ seq: number; stream: string; chunk: string }> = [];
    const p = registerPendingExec('srv-stream', 'corr-stream', 4, 5000, (chunk) => chunks.push(chunk));
    const frame = (seq: number, chunk: string) => ({
      correlationId: 'corr-stream', seq, stream: 'stdout' as const, chunk,
    });
    const before = machineExecRegistryStats().droppedChunks;

    expect(resolvePendingExecChunk('other', 4, frame(0, 'wrong-target'))).toBe(false);
    expect(resolvePendingExecChunk('srv-stream', 5, frame(0, 'wrong-generation'))).toBe(false);
    expect(resolvePendingExecChunk('srv-stream', 4, frame(1, 'out-of-order'))).toBe(false);
    expect(resolvePendingExecChunk('srv-stream', 4, frame(0, 'first'))).toBe(true);
    expect(resolvePendingExecChunk('srv-stream', 4, frame(0, 'duplicate'))).toBe(false);
    expect(resolvePendingExecChunk('srv-stream', 4, { ...frame(1, 'warn'), stream: 'stderr' })).toBe(true);

    expect(chunks).toEqual([
      { seq: 0, stream: 'stdout', chunk: 'first' },
      { seq: 1, stream: 'stderr', chunk: 'warn' },
    ]);
    expect(machineExecRegistryStats().droppedChunks - before).toBe(4);
    expect(resolvePendingExec('srv-stream', 4, result('corr-stream'))).toBe(true);
    await expect(p).resolves.toMatchObject({ correlationId: 'corr-stream' });
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

  it('cancelPendingExec removes the entry, clears its timer, and resolves null (send-failure path)', async () => {
    const before = machineExecRegistryStats().inFlight;
    const p = registerPendingExec('srv4', 'corr-D', 2, 60_000);
    expect(machineExecRegistryStats().inFlight).toBe(before + 1);
    expect(cancelPendingExec('corr-D')).toBe(true);
    expect(machineExecRegistryStats().inFlight).toBe(before);
    await expect(p).resolves.toBeNull();
    // A late result for a cancelled correlation is dropped (no double-resolve).
    expect(resolvePendingExec('srv4', 2, result('corr-D'))).toBe(false);
    // Idempotent: cancelling an unknown/gone correlation is a no-op.
    expect(cancelPendingExec('corr-D')).toBe(false);
  });

  it('abandonAllForTarget abandons EVERY pending for a target (all generations) as indeterminate', async () => {
    const p1 = registerPendingExec('srv5', 'corr-E1', 1, 60_000);
    const p2 = registerPendingExec('srv5', 'corr-E2', 2, 60_000);
    const pOther = registerPendingExec('srv6', 'corr-F', 1, 60_000);
    const abandoned = abandonAllForTarget('srv5');
    expect(abandoned).toBe(2);
    await expect(p1).resolves.toBeNull(); // → dispatched_no_result (indeterminate)
    await expect(p2).resolves.toBeNull();
    // A different target is untouched.
    expect(resolvePendingExec('srv6', 1, result('corr-F'))).toBe(true);
    await expect(pOther).resolves.toMatchObject({ correlationId: 'corr-F' });
  });
});
