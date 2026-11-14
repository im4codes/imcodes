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

describe('TimelineOutboundQueue backlog coalescing, trim, and gap semantics', () => {
  it('replaces coalescible frames in-place preserving A-old, B, A-new -> A-new, B order and frees slot after pop', () => {
    const queue = new TimelineOutboundQueue();
    const sent: string[] = [];
    const pendingCallbacks: Array<(error?: Error) => void> = [];
    const ws = {
      readyState: 1,
      bufferedAmount: 0,
      send(data: string, _opts: unknown, callback?: (error?: Error) => void) {
        sent.push(JSON.parse(data).tag);
        if (callback) pendingCallbacks.push(callback);
      },
    };
    const make = (tag: string, seq: number, coalesceKey?: string) => ({
      data: JSON.stringify({ tag }),
      sessionId: 's',
      epoch: 1,
      seq,
      priority: 'coalescible' as const,
      ...(coalesceKey ? { coalesceKey } : {}),
    });

    let coalesced = 0;
    queue.enqueue(ws as never, make('inflight', 1), () => {});
    queue.enqueue(ws as never, make('A-old', 2, 'kA'), () => {}, () => { coalesced += 1; });
    queue.enqueue(ws as never, make('B', 3, 'kB'), () => {}, () => { coalesced += 1; });
    queue.enqueue(ws as never, make('A-new', 4, 'kA'), () => {}, () => { coalesced += 1; });
    expect(coalesced).toBe(1);
    expect(queue.statsForTests().pending).toBe(2);

    // Pop inflight -> A-new starts sending, freeing kA slot so a subsequent A-after queues behind B.
    pendingCallbacks.shift()!();
    queue.enqueue(ws as never, make('A-after', 5, 'kA'), () => {}, () => { coalesced += 1; });
    expect(coalesced).toBe(1);

    while (pendingCallbacks.length > 0) pendingCallbacks.shift()!();
    expect(sent).toEqual(['inflight', 'A-new', 'B', 'A-after']);
    expect(queue.isIdle()).toBe(true);
    expect(queue.statsForTests().bytes).toBe(0);
    queue.dispose();
  });

  it('bounds physical nodes and tracked bytes under 5000 sustained slow-socket same-key updates', () => {
    const queue = new TimelineOutboundQueue();
    const pendingCallbacks: Array<(error?: Error) => void> = [];
    const sent: string[] = [];
    const ws = {
      readyState: 1,
      bufferedAmount: 0,
      send(data: string, _opts: unknown, callback?: (error?: Error) => void) {
        sent.push(data);
        if (callback) pendingCallbacks.push(callback);
      },
    };
    queue.enqueue(ws as never, { data: 'hold', sessionId: 's', epoch: 1, seq: 1, priority: 'durable' }, () => {});
    const durablePayload = JSON.stringify({ tag: 'durable' });
    for (let seq = 2; seq <= 51; seq += 1) {
      queue.enqueue(ws as never, {
        data: durablePayload,
        byteLength: Buffer.byteLength(durablePayload, 'utf8'),
        sessionId: 's',
        epoch: 1,
        seq,
        priority: 'durable',
      }, () => {});
    }
    let lastCoalescedPayload = '';
    for (let seq = 100; seq < 5100; seq += 1) {
      lastCoalescedPayload = JSON.stringify({ status: `s-${seq}` });
      queue.enqueue(ws as never, {
        data: lastCoalescedPayload,
        sessionId: 's',
        epoch: 1,
        seq,
        priority: 'coalescible',
        coalesceKey: 's\0agent.status',
      }, () => {});
    }
    const expectedBytes = 50 * Buffer.byteLength(durablePayload, 'utf8') + Buffer.byteLength(lastCoalescedPayload, 'utf8');
    expect(queue.statsForTests()).toEqual({ bytes: expectedBytes, pending: 51, pendingGaps: 0 });

    while (pendingCallbacks.length > 0) pendingCallbacks.shift()!();
    expect(sent).toHaveLength(52);
    expect(sent[sent.length - 1]).toBe(lastCoalescedPayload);
    expect(queue.isIdle()).toBe(true);
    queue.dispose();
  });

  it('trims only coalescible head over 64 MiB, merges seq gaps when pressured, preserves final->durable->coalescible order, and closes 1013 when non-coalescible exceeds cap', async () => {
    const queue = new TimelineOutboundQueue();
    const sent: string[] = [];
    const gaps: Array<{ from?: number; to?: number }> = [];
    const pendingCallbacks: Array<(error?: Error) => void> = [];
    let closedWith: { code?: number; reason?: string } | null = null;
    const ws = {
      readyState: 1,
      bufferedAmount: 32 * 1024 * 1024,
      send(data: string, _opts: unknown, callback?: (error?: Error) => void) {
        sent.push(JSON.parse(data).tag);
        if (callback) pendingCallbacks.push(callback);
      },
      close(code?: number, reason?: string) {
        closedWith = { code, reason };
      },
    };

    const big1MiB = (tag: string) => JSON.stringify({ tag, pad: 'a'.repeat(1024 * 1024) });
    const onGap = (dropped: { gapFromSeq?: number; gapToSeq?: number; seq: number }) => {
      gaps.push({ from: dropped.gapFromSeq ?? dropped.seq, to: dropped.gapToSeq ?? dropped.seq });
    };
    queue.enqueue(ws as never, { data: JSON.stringify({ tag: 'inflight' }), sessionId: 's', epoch: 1, seq: 1, priority: 'durable' }, onGap);
    // Enqueue 70 x ~1MiB coalescible frames interspersed with 2 durable and 1 final frame.
    // Frames with seq 2, 3, 4 share key k1 (coalesced), seq 5..73 are distinct coalescible frames.
    queue.enqueue(ws as never, { data: big1MiB('c-k1-2'), sessionId: 's', epoch: 1, seq: 2, priority: 'coalescible', coalesceKey: 'k1' }, onGap);
    queue.enqueue(ws as never, { data: big1MiB('c-k1-3'), sessionId: 's', epoch: 1, seq: 3, priority: 'coalescible', coalesceKey: 'k1' }, onGap);
    for (let seq = 4; seq <= 70; seq += 1) {
      queue.enqueue(ws as never, { data: big1MiB(`c-${seq}`), sessionId: 's', epoch: 1, seq, priority: 'coalescible' }, onGap);
    }
    queue.enqueue(ws as never, { data: JSON.stringify({ tag: 'd-71' }), sessionId: 's', epoch: 1, seq: 71, priority: 'durable' }, onGap);
    queue.enqueue(ws as never, { data: JSON.stringify({ tag: 'f-72' }), sessionId: 's', epoch: 1, seq: 72, priority: 'final' }, onGap);
    queue.enqueue(ws as never, { data: JSON.stringify({ tag: 'd-73' }), sessionId: 's', epoch: 1, seq: 73, priority: 'durable' }, onGap);

    expect(closedWith).toBeNull();
    expect(queue.statsForTests().bytes).toBeLessThanOrEqual(64 * 1024 * 1024);

    // Flush scheduled gap timer/setImmediate
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.from).toBe(2);
    expect(gaps[0]!.to).toBeGreaterThanOrEqual(7);

    // Drain remaining queued frames and verify strict priority order: final -> durable -> surviving coalescible
    while (pendingCallbacks.length > 0) pendingCallbacks.shift()!();
    expect(sent.slice(0, 4)).toEqual(['inflight', 'f-72', 'd-71', 'd-73']);
    // Surviving coalescible starts after the trimmed head (~seq >= 8..10) up to seq 70
    expect(sent[sent.length - 1]).toBe('c-70');
    expect(queue.isIdle()).toBe(true);

    // Now force 1013 close when only durable frames exceed 64 MiB (no coalescible to evict)
    queue.enqueue(ws as never, { data: JSON.stringify({ tag: 'hold2' }), sessionId: 's', epoch: 1, seq: 100, priority: 'durable' }, onGap);
    for (let seq = 101; seq <= 170; seq += 1) {
      queue.enqueue(ws as never, { data: big1MiB(`d-${seq}`), sessionId: 's', epoch: 1, seq, priority: 'durable' }, onGap);
      if (closedWith) break;
    }
    expect(closedWith).toEqual({ code: 1013, reason: 'timeline_backpressure_resync' });
    expect(queue.statsForTests()).toEqual({ bytes: 0, pending: 0, pendingGaps: 0 });
    queue.dispose();
  });

  it('does not manufacture seq_gap when trimming coalescible frames on a non-pressured socket', async () => {
    const queue = new TimelineOutboundQueue();
    const gaps: unknown[] = [];
    const pendingCallbacks: Array<(error?: Error) => void> = [];
    const ws = {
      readyState: 1,
      bufferedAmount: 0,
      send(_data: string, _opts: unknown, callback?: (error?: Error) => void) {
        if (callback) pendingCallbacks.push(callback);
      },
    };
    const big1MiB = JSON.stringify({ pad: 'b'.repeat(1024 * 1024) });
    for (let seq = 1; seq <= 68; seq += 1) {
      queue.enqueue(ws as never, { data: big1MiB, sessionId: 's', epoch: 1, seq, priority: 'coalescible' }, (g) => { gaps.push(g); });
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(gaps).toHaveLength(0);
    expect(queue.statsForTests().bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    while (pendingCallbacks.length > 0) pendingCallbacks.shift()!();
    expect(queue.isIdle()).toBe(true);
    queue.dispose();
  });
});
