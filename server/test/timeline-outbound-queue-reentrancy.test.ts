/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { TimelineOutboundQueue } from '../src/ws/bridge.js';

class ReentrantWs {
  readyState = 1;
  bufferedAmount = 0;
  sends = 0;
  onFirstSend?: () => void;

  send(_data: string, _opts: unknown, callback?: (error?: Error) => void): void {
    this.sends += 1;
    if (this.sends === 1) this.onFirstSend?.();
    callback?.();
  }
}

describe('TimelineOutboundQueue re-entrant send completions', () => {
  it('drains thousands of frames without recursive stack growth and yields to the event loop', async () => {
    const queue = new TimelineOutboundQueue();
    const ws = new ReentrantWs();
    const frame = (seq: number) => ({
      data: JSON.stringify({ type: 'timeline.event', event: { sessionId: 's', epoch: 1, seq } }),
      sessionId: 's', epoch: 1, seq, priority: 'coalescible' as const,
    });
    let yielded = false;
    ws.onFirstSend = () => {
      for (let seq = 2; seq <= 5000; seq += 1) queue.enqueue(ws as never, frame(seq), () => {});
      setTimeout(() => { yielded = true; }, 0);
    };

    queue.enqueue(ws as never, frame(1), () => {});
    // Wait for the drain itself, not a fixed wall-clock budget: coverage
    // instrumentation and loaded CI runners make any fixed sleep flaky.
    await vi.waitFor(() => expect(queue.isIdle()).toBe(true), { timeout: 15_000, interval: 5 });

    expect(yielded).toBe(true);
    expect(ws.sends).toBe(5000);
    queue.dispose();
  });

  it('drains a synchronous backlog in bounded batches instead of one frame per event-loop turn', async () => {
    const queue = new TimelineOutboundQueue();
    const ws = new ReentrantWs();
    const frame = (seq: number) => ({
      data: JSON.stringify({ type: 'timeline.event', event: { sessionId: 's', epoch: 1, seq } }),
      sessionId: 's', epoch: 1, seq, priority: 'coalescible' as const,
    });
    ws.onFirstSend = () => {
      for (let seq = 2; seq <= 2000; seq += 1) queue.enqueue(ws as never, frame(seq), () => {});
    };
    queue.enqueue(ws as never, frame(1), () => {});
    // Count event-loop turns until the backlog drains: one frame per turn
    // would need ~2000 turns; bounded batches need a small fraction of that.
    let turns = 0;
    while (!queue.isIdle() && turns < 2000) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      turns += 1;
    }
    expect(queue.isIdle()).toBe(true);
    expect(ws.sends).toBe(2000);
    expect(turns).toBeLessThan(200);
    queue.dispose();
  });

  it('keeps final and durable frames ahead of queued coalescible frames without re-sorting', () => {
    const queue = new TimelineOutboundQueue();
    const order: string[] = [];
    const ws = {
      readyState: 1,
      bufferedAmount: 0,
      pendingCallbacks: [] as Array<(error?: Error) => void>,
      send(data: string, _opts: unknown, callback?: (error?: Error) => void) {
        order.push(JSON.parse(data).tag);
        if (callback) this.pendingCallbacks.push(callback);
      },
    };
    const make = (tag: string, priority: 'final' | 'durable' | 'coalescible', seq: number) => ({
      data: JSON.stringify({ tag }), sessionId: 's', epoch: 1, seq, priority,
    });
    queue.enqueue(ws as never, make('c1', 'coalescible', 1), () => {});
    queue.enqueue(ws as never, make('c2', 'coalescible', 2), () => {});
    queue.enqueue(ws as never, make('d1', 'durable', 3), () => {});
    queue.enqueue(ws as never, make('f1', 'final', 4), () => {});
    queue.enqueue(ws as never, make('c3', 'coalescible', 5), () => {});
    // c1 is in flight; complete sends one by one asynchronously.
    while (ws.pendingCallbacks.length > 0) ws.pendingCallbacks.shift()!();
    expect(order).toEqual(['c1', 'f1', 'd1', 'c2', 'c3']);
    queue.dispose();
  });
});
