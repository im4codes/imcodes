import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regression for the win-201 retry storm: the worker used to reset its
// reconnect attempt counter on socket `open`, so a server that accepts the
// upgrade and then closes with auth_failed (4001) was retried at the base
// delay forever. The counter must only reset once the server has answered.

const h = vi.hoisted(() => {
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 1;
    bufferedAmount = 0;
    private readonly listeners = new Map<string, ((...args: any[]) => void)[]>();
    constructor(readonly url: string) { FakeSocket.instances.push(this); }
    on(name: string, listener: (...args: any[]) => void): this {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    }
    emit(name: string, ...args: any[]): void {
      for (const listener of this.listeners.get(name) ?? []) listener(...args);
    }
    send(): void { /* auth / heartbeat frames are irrelevant here */ }
    close(): void { /* noop */ }
    terminate(): void { /* noop */ }
  }
  return { FakeSocket, posted: [] as Array<Record<string, unknown>>, dir: '' };
});

vi.mock('ws', () => ({ default: h.FakeSocket }));
vi.mock('node:worker_threads', () => ({
  parentPort: { postMessage: (event: Record<string, unknown>) => { h.posted.push(event); }, on: () => {} },
  workerData: { url: 'wss://test.invalid/ws', auth: '{}', inboundInboxPath: '' },
}));

async function loadWorker(): Promise<void> {
  const workerThreads = await import('node:worker_threads');
  (workerThreads.workerData as { inboundInboxPath: string }).inboundInboxPath = join(h.dir, 'inbox.jsonl');
  await import('../../src/daemon/server-link-worker.js');
}

const delays = (): number[] => h.posted
  .filter((event) => event.event === 'reconnecting')
  .map((event) => event.delayMs as number);

function current(): InstanceType<typeof h.FakeSocket> {
  return h.FakeSocket.instances[h.FakeSocket.instances.length - 1];
}

describe('server-link worker reconnect backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    h.posted.length = 0;
    h.FakeSocket.instances.length = 0;
    h.dir = mkdtempSync(join(tmpdir(), 'imc-link-worker-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('keeps growing the delay when the server closes with auth_failed right after open', async () => {
    await loadWorker();
    for (let i = 0; i < 4; i += 1) {
      current().emit('open');
      current().emit('close', 4001, Buffer.from('auth_failed'));
      await vi.runOnlyPendingTimersAsync();
    }
    // Before the fix every entry was 250 (reset on open).
    expect(delays()).toEqual([250, 500, 1000, 2000]);
  });

  it('starts over from the base delay after the server has answered on the socket', async () => {
    await loadWorker();
    for (let i = 0; i < 3; i += 1) {
      current().emit('open');
      current().emit('close', 4001, Buffer.from('auth_failed'));
      await vi.runOnlyPendingTimersAsync();
    }
    expect(delays()).toEqual([250, 500, 1000]);

    // Healthy connection: the server answers, then the network drops.
    current().emit('open');
    current().emit('message', Buffer.from(JSON.stringify({ type: 'heartbeat_ack' })), false);
    current().emit('close', 1006, Buffer.from(''));
    expect(delays()).toEqual([250, 500, 1000, 250]);
  });
});
