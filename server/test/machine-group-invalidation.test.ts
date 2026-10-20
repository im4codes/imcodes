import { afterEach, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import { MachineGroupInvalidationRuntime, machineGroupInvalidationReady } from '../src/services/machine-group-invalidation.js';
import { MACHINE_GROUP_INVALIDATION as POLICY } from '../../shared/machine-group-invalidation.js';
import { REMOTE_DESKTOP_LIMITS } from '../../shared/remote-desktop.js';
afterEach(() => vi.useRealTimers());
it('shutdown fences before its bounded stalled-DB cleanup and cannot revert to embedded authority', async () => {
  vi.useFakeTimers();
  const invalid = vi.fn(), error = vi.fn();
  const db = { execute: vi.fn(async () => ({changes:1})), query: vi.fn(async () => []),
    transaction: vi.fn(async () => new Promise(() => {})) } as unknown as Database;
  const runtime = new MachineGroupInvalidationRuntime(db, async () => {}, invalid, undefined, error);
  await runtime.start(); expect(machineGroupInvalidationReady(db)).toBe(true);
  const stopped = runtime.stop(); expect(invalid).toHaveBeenCalledTimes(1);
  expect(machineGroupInvalidationReady(db)).toBe(false);
  await vi.advanceTimersByTimeAsync(POLICY.APPLY_TIMEOUT_MS+1);await stopped;
  expect(error).toHaveBeenCalledTimes(1);expect(machineGroupInvalidationReady(db)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('receiver liveness cannot expire before an outstanding desktop lease plus accepted clock skew', () => {
  expect(POLICY.RECEIVER_LEASE_MS).toBeGreaterThan(REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS+REMOTE_DESKTOP_LIMITS.CLOCK_SKEW_TOLERANCE_MS);
  expect(POLICY.AUTHORITY_HEALTH_MS).toBeLessThan(POLICY.RECEIVER_LEASE_MS);
});
