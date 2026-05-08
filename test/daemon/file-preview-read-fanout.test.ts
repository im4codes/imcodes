import { describe, expect, it, vi } from 'vitest';
import { PreviewReadFanOutDispatcher } from '../../src/daemon/file-preview-read-fanout.js';

class FakeClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(ms: number): void {
    this.current += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.current)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('PreviewReadFanOutDispatcher', () => {
  it('sends exactly one terminal response per request', async () => {
    const clock = new FakeClock();
    const sent: string[] = [];
    const fanout = new PreviewReadFanOutDispatcher<string>({
      clock,
      send: (message) => { sent.push(message); },
    });

    fanout.register({ requestId: 'r1', rawPath: '/a', deadlineAt: 100, onTimeout: () => 'timeout' });
    expect(fanout.sendTerminal('r1', () => 'success')).toBe(true);
    expect(fanout.sendTerminal('r1', () => 'duplicate')).toBe(true);
    await fanout.flush();

    expect(sent).toEqual(['success']);
    expect(fanout.getRequestView('r1')).toBeNull();
  });

  it('times out a request before its queued success send is reached', async () => {
    const clock = new FakeClock();
    const firstSend = deferred<void>();
    const sent: string[] = [];
    const send = vi.fn((message: string) => {
      sent.push(message);
      if (message === 'r1-success') return firstSend.promise;
      return undefined;
    });
    const fanout = new PreviewReadFanOutDispatcher<string>({ clock, send });

    fanout.register({ requestId: 'r1', rawPath: '/a', deadlineAt: 100, onTimeout: () => 'r1-timeout' });
    fanout.register({ requestId: 'r2', rawPath: '/b', deadlineAt: 10, onTimeout: () => 'r2-timeout' });
    fanout.sendTerminal('r1', () => 'r1-success');
    fanout.sendTerminal('r2', () => 'r2-success');
    await Promise.resolve();

    clock.advance(11);
    firstSend.resolve();
    await fanout.flush();

    expect(sent).toEqual(['r1-success', 'r2-timeout']);
    expect(send).not.toHaveBeenCalledWith('r2-success');
  });

  it('serializes fan-out sends in request order', async () => {
    const clock = new FakeClock();
    const sent: string[] = [];
    const fanout = new PreviewReadFanOutDispatcher<string>({
      clock,
      send: async (message) => {
        sent.push(message);
        await Promise.resolve();
      },
    });

    for (const id of ['a', 'b', 'c']) {
      fanout.register({ requestId: id, rawPath: id, deadlineAt: 100, onTimeout: () => `${id}:timeout` });
    }
    fanout.sendTerminalMany(['a', 'b', 'c'], (id) => `${id}:ok`);
    await fanout.flush();

    expect(sent).toEqual(['a:ok', 'b:ok', 'c:ok']);
    expect(['a', 'b', 'c'].map((id) => fanout.has(id))).toEqual([false, false, false]);
  });

  it('removes timed-out records after terminal delivery', async () => {
    const clock = new FakeClock();
    const sent: string[] = [];
    const fanout = new PreviewReadFanOutDispatcher<string>({
      clock,
      send: (message) => { sent.push(message); },
    });

    fanout.register({ requestId: 'late', rawPath: '/late', deadlineAt: 5, onTimeout: () => 'timeout' });
    clock.advance(6);
    await fanout.flush();

    expect(sent).toEqual(['timeout']);
    expect(fanout.has('late')).toBe(false);
  });
});
