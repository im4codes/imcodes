import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/src/index.js';
import { environment, headers } from '../../server/test/helpers/daemon-token-env.js';
import { DAEMON_TOKEN_ROUTE_NOT_ALLOWED } from '../../shared/daemon-token-routes.js';
import { createWorkerSessionSyncRetrier } from '../../src/daemon/worker-session-sync-retrier.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('older daemon calls fail clearly without a retry storm', () => {
  it('unknown routes return stable 403; existing sync retry stays exponential and capped', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp(environment());
    const request = vi.fn(async () => {
      const response = await app.request('/api/old-daemon-unregistered-route', { headers });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED });
      // Old daemons may classify every HTTP failure as retryable. Even in that
      // case the actual daemon retrier, not a test substitute, bounds traffic.
      return { ok: false, retryable: true };
    });
    const delays: number[] = [];
    const retry = createWorkerSessionSyncRetrier({ sync: request, jitterRatio: 0,
      logger: { warn: context => delays.push(context.delayMs as number) } });
    retry.start('old_server_skew');
    expect(request).not.toHaveBeenCalled();
    for (const delay of [10_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(request).toHaveBeenCalledTimes(8);
    expect(delays).toEqual([10_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    retry.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(request).toHaveBeenCalledTimes(8);
  });
});
