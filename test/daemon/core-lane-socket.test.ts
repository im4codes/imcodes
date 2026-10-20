import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { FakeWorker, workers } = vi.hoisted(() => {
  class FakeWorker {
    readonly messages: unknown[] = [];
    private readonly listeners = new Map<string, ((value: any) => void)[]>();
    postMessage(value: unknown): void { this.messages.push(value); }
    on(name: string, listener: (value: any) => void): this {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    }
    emit(name: string, value: { event: string; bytes?: number; inboundId?: string }): void {
      for (const listener of this.listeners.get(name) ?? []) listener(value);
    }
    terminate(): Promise<void> { return Promise.resolve(); }
  }
  return { FakeWorker, workers: [] as InstanceType<typeof FakeWorker>[] };
});

vi.mock('node:worker_threads', () => ({
  Worker: class extends FakeWorker {
    constructor() { super(); workers.push(this); }
  },
}));

import { CoreLaneSocket, coreLaneWorkerEnabled } from '../../src/daemon/core-lane-socket.js';

describe('CoreLaneSocket', () => {
  const oldSwitch = process.env.IMCODES_CORE_LINK_WORKER;
  beforeEach(() => { workers.length = 0; delete process.env.IMCODES_CORE_LINK_WORKER; });
  afterEach(() => {
    if (oldSwitch === undefined) delete process.env.IMCODES_CORE_LINK_WORKER;
    else process.env.IMCODES_CORE_LINK_WORKER = oldSwitch;
  });

  it('keeps bounded control messages in order while the worker reconnects', () => {
    const socket = new CoreLaneSocket('ws://test');
    socket.send('first');
    socket.send('second');
    expect(workers[0].messages).toEqual([]);
    workers[0].emit('message', { event: 'open' });
    expect(workers[0].messages).toEqual([
      { type: 'send', payload: 'first' },
      { type: 'send', payload: 'second' },
    ]);
  });

  it('rejects an unbounded producer and accounts for worker drain acknowledgements', () => {
    const socket = new CoreLaneSocket('ws://test');
    expect(() => socket.send('x'.repeat(8 * 1024 * 1024 + 1))).toThrow(/queue is full/);
    workers[0].emit('message', { event: 'open' });
    socket.send('small');
    expect(socket.bufferedAmount).toBeGreaterThan(0);
    workers[0].emit('message', { event: 'drained', bytes: 5 });
    expect(socket.bufferedAmount).toBe(0);
  });

  it('forwards main-thread lag to the worker and has a field kill switch', () => {
    const socket = new CoreLaneSocket('ws://test');
    socket.updateMainLag(37.9);
    expect(workers[0].messages).toContainEqual({ type: 'lag', lagMs: 37 });
    process.env.IMCODES_CORE_LINK_WORKER = '0';
    expect(coreLaneWorkerEnabled()).toBe(false);
  });

  it('reserves capacity for priority control traffic and respawns a crashed worker', () => {
    vi.useFakeTimers();
    const socket = new CoreLaneSocket('ws://test', { maxQueueBytes: 64 * 1024, priorityReserveBytes: 1024 });
    socket.send('n'.repeat(63 * 1024));
    expect(() => socket.send('n'.repeat(2 * 1024))).toThrow(/normal queue is full/);
    expect(() => socket.send('p'.repeat(1024), 'priority')).not.toThrow();
    const close = vi.fn();
    socket.addEventListener('close', close);
    workers[0].emit('error', { message: 'worker crashed' });
    expect(close).toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(workers).toHaveLength(2);
    socket.terminate();
    vi.useRealTimers();
  });

  it('keeps the priority reserve available after the socket is already open', () => {
    const socket = new CoreLaneSocket('ws://test', { maxQueueBytes: 64 * 1024, priorityReserveBytes: 1024 });
    workers[0].emit('message', { event: 'open' });
    socket.send('n'.repeat(63 * 1024));
    expect(() => socket.send('n'.repeat(2 * 1024))).toThrow(/normal queue is full/);
    expect(() => socket.send('p'.repeat(1024), 'priority')).not.toThrow();
    socket.terminate();
  });

  it('replays an unconfirmed inbound commit to a replacement worker', () => {
    vi.useFakeTimers();
    const socket = new CoreLaneSocket('ws://test');
    workers[0].emit('message', { event: 'open' });

    socket.commitInbound('inbound-1');
    expect(workers[0].messages).toContainEqual({ type: 'inbound_commit', inboundId: 'inbound-1' });

    workers[0].emit('error', { event: 'error' });
    vi.advanceTimersByTime(250);
    expect(workers).toHaveLength(2);
    expect(workers[1].messages).toContainEqual({ type: 'inbound_commit', inboundId: 'inbound-1' });

    // Once the replacement confirms the durable ack, a later worker restart
    // must not resend it, while a new inbound commit remains independent.
    workers[1].emit('message', { event: 'inbound_committed', inboundId: 'inbound-1' });
    workers[1].emit('error', { event: 'error' });
    vi.advanceTimersByTime(500);
    expect(workers).toHaveLength(3);
    expect(workers[2].messages).not.toContainEqual({ type: 'inbound_commit', inboundId: 'inbound-1' });

    socket.terminate();
    vi.useRealTimers();
  });
});
