import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const instances: TestWorker[] = [];
class TestWorker extends EventEmitter {
  constructor() { super(); instances.push(this); }
  unref(): void {}
  postMessage(): void {}
  terminate(): Promise<number> { return Promise.resolve(0); }
}
vi.mock('node:worker_threads', () => ({ Worker: TestWorker }));
vi.mock('../../src/util/logger.js', () => ({ default: { warn: vi.fn(), debug: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); vi.resetModules(); instances.length = 0; });

describe('retention writer lifecycle', () => {
  it('respawns an idle crashed writer on bounded backoff, ignores stale exits, and cancels retry on shutdown', async () => {
    vi.useFakeTimers();
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');
    timelineProjection.startRetention();
    expect(instances).toHaveLength(1);
    instances[0].emit('error', new Error('simulated crash'));
    instances[0].emit('exit', 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(2);
    instances[0].emit('exit', 1); // old generation cannot clear the replacement
    timelineProjection.startRetention();
    expect(instances).toHaveLength(2);
    instances[1].emit('exit', 1);
    expect(vi.getTimerCount()).toBe(1);
    await timelineProjection.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
