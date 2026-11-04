import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { HISTORY_RETENTION } from '../../src/store/history-retention.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
let home: string | undefined;
let shutdown: (() => Promise<unknown>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  vi.useRealTimers();
  vi.doUnmock('node:worker_threads');
  vi.doUnmock('node:fs');
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function fixture(keepDays: number | null) {
  home = mkdtempSync(join(tmpdir(), 'imcodes-retention-schedule-'));
  mkdirSync(join(home, 'timeline'));
  const now = new Date(2040, 0, 5, 2, 59, 59).getTime();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(now);
  const path = join(home, HISTORY_RETENTION.fileName);
  const config = (days: number | null) => writeFileSync(path, JSON.stringify({ keepDays: days, enabledAt: now }));
  config(keepDays);
  let notify: (event: string, file: string) => void = () => {};
  vi.doMock('node:fs', async () => ({ ...await vi.importActual('node:fs'),
    watch: (_path: string, _opts: unknown, cb: typeof notify) => { notify = cb; return { on: vi.fn(), close: vi.fn() }; },
  }));
  let handler: (request: any) => Promise<void> = async () => {};
  const responses = new Map<number, any>();
  vi.doMock('node:worker_threads', () => ({ workerData: {
    dbPath: join(home!, 'timeline.sqlite'), stateDir: home,
    retention: { ...HISTORY_RETENTION, configPath: path },
  }, parentPort: { on: (_event: string, cb: typeof handler) => { handler = cb; }, postMessage: (r: any) => responses.set(r.id, r), close: vi.fn() } }));
  await import('../../src/daemon/timeline-projection-worker.js');
  let id = 0;
  const request = async (type: string, payload: object = {}) => {
    const current = ++id;
    await handler({ id: current, type, payload });
    expect(responses.get(current).ok).toBe(true);
    return responses.get(current).result;
  };
  shutdown = () => request('shutdown');
  return { now, config, request, notify: () => notify('rename', HISTORY_RETENTION.fileName),
    state: () => { const db = new DatabaseSync(join(home!, 'timeline.sqlite')); try {
      return db.prepare('SELECT * FROM timeline_retention').get() as any;
    } finally { db.close(); } },
  };
}

describe('retention production timer', () => {
  it('fires at 03:00, not on enable/read/write; one next-slot timer; disabling cancels it', async () => {
    const f = await fixture(3);
    writeFileSync(join(home!, 'timeline', 'deck_timer.jsonl'), JSON.stringify({ sessionId: 'deck_timer',
      eventId: 'old', epoch: 1, seq: 1, ts: 1, type: 'user.message', source: 'daemon', confidence: 'high', payload: { text: 'old' } }) + '\n');
    await f.request('rebuildSession', { sessionId: 'deck_timer' });
    expect(f.state().runs).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.state().runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 20 && f.state().runs !== 1; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.state()).toMatchObject({ runs: 1, deleted: 1 });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.state().runs).toBe(1);
    f.config(null); f.notify();
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HISTORY_RETENTION.dayMs);
    expect(f.state().runs).toBe(1);
  });

  it('off has no scheduled timer; an atomic config notification enables only the next slot', async () => {
    const f = await fixture(null);
    expect(vi.getTimerCount()).toBe(0);
    f.config(1); f.notify();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.state()).toMatchObject({ runs: 0, next_run: f.now + 1000 });
    expect(vi.getTimerCount()).toBe(1);
  });
});
