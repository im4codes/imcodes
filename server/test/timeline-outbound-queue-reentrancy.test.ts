/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
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
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(yielded).toBe(true);
    expect(ws.sends).toBe(5000);
    expect(queue.isIdle()).toBe(true);
    queue.dispose();
  });
});
