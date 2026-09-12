/**
 * Backoff overflow regression.
 *
 * Both self-heal fault domains computed their delay with a bitwise shift:
 *
 *     Math.min(timeoutBackoffBaseMs << (respawns - 1), respawnCooldownMs)
 *     Math.min(warmupBackoffBaseMs  << (failures - 2), warmupBackoffMaxMs)
 *
 * `<<` coerces to a SIGNED 32-bit integer, so the product wraps negative:
 *
 *     1000 << 22 === -100663296   (timeout respawn 23)
 *      500 << 23 === -100663296   (warmup/crash failure 25)
 *
 * `Math.min` keeps the negative value, `retryDelayRemainingMs()` clamps it to 0,
 * and `isRespawnThrottled()` becomes false. A persistently failing worker
 * therefore ESCAPES the advertised 60s cap at exactly the point the cap matters
 * most, and enters immediate respawn churn.
 *
 * These regressions drive the real client past both thresholds and assert the
 * throttle is still armed: `retryInMs` stays positive and bounded by the cap, and
 * no extra generation is spawned before the cap window elapses.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedExponentialBackoffMs,
  CONTEXT_STORE_RPC_ERROR,
  CONTEXT_STORE_RPC_SELF_HEAL,
  CONTEXT_STORE_WORKER_HEALTH,
  type ContextStoreRpcRequest,
} from '../../shared/context-store-rpc.js';
import { ContextStoreWorkerClient } from '../../src/store/context-store-worker-client.js';

const {
  consecutiveTimeoutsBeforeRespawn,
  respawnCooldownMs,
  timeoutBackoffBaseMs,
  warmupBackoffBaseMs,
  warmupBackoffMaxMs,
} = CONTEXT_STORE_RPC_SELF_HEAL;

/** First attempt whose shifted product exceeds the signed 32-bit range. */
const TIMEOUT_OVERFLOW_RESPAWN = 23;
const WARMUP_OVERFLOW_FAILURE = 25;

class FakeWorker extends EventEmitter {
  readonly unref = vi.fn();
  readonly terminate = vi.fn(async () => 0);
  readonly postMessage = vi.fn((_message: ContextStoreRpcRequest) => {});
}

function createHarness() {
  const workers: FakeWorker[] = [];
  const client = new ContextStoreWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as never;
  });
  return { client, workers };
}

/** One timeout episode on a READY generation, ending in a timeout respawn. */
async function tripTimeoutRespawn(client: ContextStoreWorkerClient, tag: string): Promise<void> {
  for (let i = 0; i < consecutiveTimeoutsBeforeRespawn; i += 1) {
    const pending = client.run('getContextMeta', [`${tag}-${i}`], { timeoutMs: 1 });
    const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('boundedExponentialBackoffMs', () => {
  it('never returns a negative delay where the shift wrapped', () => {
    // The exact reported wrap points.
    expect(timeoutBackoffBaseMs << (TIMEOUT_OVERFLOW_RESPAWN - 1)).toBeLessThan(0);
    expect(warmupBackoffBaseMs << (WARMUP_OVERFLOW_FAILURE - 2)).toBeLessThan(0);

    expect(boundedExponentialBackoffMs(timeoutBackoffBaseMs, TIMEOUT_OVERFLOW_RESPAWN, respawnCooldownMs))
      .toBe(respawnCooldownMs);
    expect(boundedExponentialBackoffMs(warmupBackoffBaseMs, WARMUP_OVERFLOW_FAILURE - 1, warmupBackoffMaxMs))
      .toBe(warmupBackoffMaxMs);
  });

  it('stays clamped for absurd attempt counts, including float overflow to Infinity', () => {
    for (const attempt of [30, 64, 1_023, 1_024, 5_000, Number.MAX_SAFE_INTEGER]) {
      const delay = boundedExponentialBackoffMs(timeoutBackoffBaseMs, attempt, respawnCooldownMs);
      expect(delay).toBe(respawnCooldownMs);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it('keeps the intended ramp below the cap and rejects degenerate inputs', () => {
    expect(boundedExponentialBackoffMs(1000, 1, 60_000)).toBe(1000);
    expect(boundedExponentialBackoffMs(1000, 2, 60_000)).toBe(2000);
    expect(boundedExponentialBackoffMs(1000, 3, 60_000)).toBe(4000);
    expect(boundedExponentialBackoffMs(1000, 0, 60_000)).toBe(0);
    expect(boundedExponentialBackoffMs(1000, -5, 60_000)).toBe(0);
    expect(boundedExponentialBackoffMs(0, 5, 60_000)).toBe(0);
    expect(boundedExponentialBackoffMs(Number.NaN, 5, 60_000)).toBe(0);
    expect(boundedExponentialBackoffMs(1000, Number.NaN, 60_000)).toBe(0);
  });
});

describe('timeout-domain backoff past the 32-bit wrap point', () => {
  it(`stays throttled at respawn ${TIMEOUT_OVERFLOW_RESPAWN} and beyond`, async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    // Drive consecutive timeout respawns with no served op in between, so the
    // escalation counter keeps climbing.
    for (let respawn = 1; respawn <= TIMEOUT_OVERFLOW_RESPAWN + 1; respawn += 1) {
      await tripTimeoutRespawn(client, `r${respawn}`);

      const snapshot = client.getHealthSnapshot();
      expect(snapshot.consecutiveTimeoutRespawns).toBe(respawn);
      expect(snapshot.state).toBe(CONTEXT_STORE_WORKER_HEALTH.backoff);
      // The property the wrap destroyed: a positive, capped delay.
      expect(snapshot.retryInMs).toBeGreaterThan(0);
      expect(snapshot.retryInMs).toBeLessThanOrEqual(respawnCooldownMs);

      const generations = workers.length;
      // No new generation before the window elapses.
      await vi.advanceTimersByTimeAsync(snapshot.retryInMs - 1);
      expect(workers).toHaveLength(generations);
      expect(client.getHealthSnapshot().retryInMs).toBeGreaterThan(0);

      // Exactly one new generation once it does.
      await vi.advanceTimersByTimeAsync(1);
      expect(workers).toHaveLength(generations + 1);
      workers[generations].emit('message', { type: 'ready' });
      await client.whenReady();
    }

    // Past the wrap the delay must be pinned at the cap, not zero or negative.
    expect(client.getHealthSnapshot().consecutiveTimeoutRespawns)
      .toBeGreaterThan(TIMEOUT_OVERFLOW_RESPAWN);
    client.dispose();
  });

  it('does not churn generations in a single long window past the wrap point', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    for (let respawn = 1; respawn <= TIMEOUT_OVERFLOW_RESPAWN; respawn += 1) {
      await tripTimeoutRespawn(client, `c${respawn}`);
      if (respawn === TIMEOUT_OVERFLOW_RESPAWN) break;
      await vi.advanceTimersByTimeAsync(client.getHealthSnapshot().retryInMs);
      workers[workers.length - 1].emit('message', { type: 'ready' });
      await client.whenReady();
    }

    // Sitting at the wrap point, a very long jump must yield exactly ONE
    // generation, not one per elapsed (wrapped) interval.
    const generations = workers.length;
    await vi.advanceTimersByTimeAsync(respawnCooldownMs * 20);
    expect(workers).toHaveLength(generations + 1);
    client.dispose();
  });
});

describe('warmup/crash-domain backoff past the 32-bit wrap point', () => {
  it(`stays throttled at failure ${WARMUP_OVERFLOW_FAILURE} and beyond`, async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();

    // Every generation dies during warmup, so `consecutiveWorkerFailures` climbs
    // monotonically (no generation ever serves an op).
    for (let failure = 1; failure <= WARMUP_OVERFLOW_FAILURE + 1; failure += 1) {
      workers[workers.length - 1].emit('message', { type: 'ready', warmupError: `boom ${failure}` });

      const snapshot = client.getHealthSnapshot();
      expect(snapshot.consecutiveWorkerFailures).toBe(failure);

      if (failure === 1) {
        // Documented fast-recovery: the first failure retries immediately.
        expect(snapshot.retryInMs).toBe(0);
      } else {
        expect(snapshot.retryInMs).toBeGreaterThan(0);
        expect(snapshot.retryInMs).toBeLessThanOrEqual(warmupBackoffMaxMs);
        const generations = workers.length;
        await vi.advanceTimersByTimeAsync(snapshot.retryInMs - 1);
        expect(workers).toHaveLength(generations);
      }

      const generations = workers.length;
      await vi.advanceTimersByTimeAsync(Math.max(snapshot.retryInMs, 1));
      expect(workers).toHaveLength(generations + 1);
    }

    expect(client.getHealthSnapshot().consecutiveWorkerFailures)
      .toBeGreaterThan(WARMUP_OVERFLOW_FAILURE);
    client.dispose();
  });
});
