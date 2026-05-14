import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

type WorkerHandler = (message: Record<string, unknown>) => Promise<void>;

function makeEvent(
  sessionId: string,
  seq: number,
  type: TimelineEvent['type'],
  payload: Record<string, unknown>,
  ts = seq,
): TimelineEvent {
  return {
    eventId: `${sessionId}-${seq}-${type}`,
    sessionId,
    ts,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  };
}

describe('timeline projection worker contract', () => {
  let tempHome: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('node:os');
    vi.unmock('node:worker_threads');
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  async function loadWorker() {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-projection-worker-'));
    const dbPath = join(tempHome, 'projection.sqlite');
    const postMessage = vi.fn();
    const close = vi.fn();
    let handler: WorkerHandler | null = null;

    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => tempHome! };
    });
    vi.doMock('node:worker_threads', () => ({
      workerData: { dbPath },
      parentPort: {
        on: vi.fn((_event: string, cb: WorkerHandler) => {
          handler = cb;
        }),
        postMessage,
        close,
      },
    }));

    await import('../../src/daemon/timeline-projection-worker.js');
    if (!handler) throw new Error('timeline projection worker did not register a message handler');

    async function request(message: Record<string, unknown>) {
      postMessage.mockClear();
      await handler!(message);
      expect(postMessage).toHaveBeenCalledTimes(1);
      return postMessage.mock.calls[0]?.[0] as {
        id: string;
        ok: boolean;
        result?: unknown;
        error?: string;
      };
    }

    return { request, close };
  }

  it('rebuilds, queries, appends, prunes, deletes, and shuts down via worker messages', async () => {
    const { request, close } = await loadWorker();
    const sessionId = 'worker_session';
    const timelineDir = join(tempHome!, '.imcodes', 'timeline');
    const timelineFile = join(timelineDir, `${sessionId}.jsonl`);
    mkdirSync(timelineDir, { recursive: true });

    const events = [
      makeEvent(sessionId, 1, 'user.message', { text: 'hello' }, 100),
      makeEvent(sessionId, 2, 'assistant.text', { text: 'typing', streaming: true }, 101),
      { ...makeEvent(sessionId, 3, 'assistant.text', { text: 'done', streaming: false }, 102), hidden: true },
      makeEvent('other_session', 99, 'assistant.text', { text: 'ignored' }, 103),
    ];
    writeFileSync(
      timelineFile,
      [
        JSON.stringify(events[0]),
        'not json',
        JSON.stringify(events[1]),
        JSON.stringify(events[2]),
        JSON.stringify(events[3]),
        '',
      ].join('\n'),
      'utf8',
    );

    expect(await request({ id: 'rebuild', type: 'rebuildSession', payload: { sessionId } }))
      .toMatchObject({ id: 'rebuild', ok: true, result: true });

    const fullHistory = await request({ id: 'history', type: 'queryHistory', payload: { sessionId, limit: 10 } });
    expect(fullHistory.ok).toBe(true);
    expect((fullHistory.result as { events: TimelineEvent[] }).events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((fullHistory.result as { events: TimelineEvent[] }).events[2]).toMatchObject({ hidden: true });

    const rangedHistory = await request({
      id: 'history-range',
      type: 'queryHistory',
      payload: { sessionId, afterTs: 100, beforeTs: 103, limit: 1_000_000 },
    });
    expect((rangedHistory.result as { events: TimelineEvent[] }).events.map((event) => event.seq)).toEqual([2, 3]);

    const completedTail = await request({
      id: 'completed',
      type: 'queryCompletedTextTail',
      payload: { sessionId, limit: 10 },
    });
    expect((completedTail.result as { events: TimelineEvent[] }).events.map((event) => `${event.type}:${event.payload.text}`))
      .toEqual(['user.message:hello', 'assistant.text:done']);

    const byTypes = await request({
      id: 'types',
      type: 'queryByTypes',
      payload: { sessionId, types: ['assistant.text'], limit: 10 },
    });
    expect((byTypes.result as { events: TimelineEvent[] }).events.map((event) => event.seq)).toEqual([2, 3]);

    const appended = makeEvent(sessionId, 4, 'tool.call', { name: 'Read' }, 103);
    appendFileSync(timelineFile, `${JSON.stringify(appended)}\n`, 'utf8');
    expect(await request({
      id: 'append',
      type: 'recordAppendedEvent',
      payload: { event: appended },
    })).toMatchObject({ id: 'append', ok: true, result: true });

    expect(await request({ id: 'latest', type: 'queryLatest', payload: { sessionId } }))
      .toMatchObject({ id: 'latest', ok: true, result: { epoch: 1, seq: 4 } });

    expect(await request({
      id: 'prune',
      type: 'pruneSessionToAuthoritative',
      payload: { sessionId, keepLast: 2 },
    })).toMatchObject({ id: 'prune', ok: true, result: true });
    const pruned = await request({ id: 'pruned-history', type: 'queryHistory', payload: { sessionId, limit: 10 } });
    expect((pruned.result as { events: TimelineEvent[] }).events.map((event) => event.seq)).toEqual([3, 4]);

    expect(await request({ id: 'delete', type: 'deleteSession', payload: { sessionId } }))
      .toMatchObject({ id: 'delete', ok: true, result: true });
    const deleted = await request({ id: 'deleted-history', type: 'queryHistory', payload: { sessionId, limit: 10 } });
    expect((deleted.result as { events: TimelineEvent[] }).events).toEqual([]);

    expect(await request({ id: 'checkpoint', type: 'checkpointIfNeeded', payload: {} }))
      .toMatchObject({ id: 'checkpoint', ok: true, result: true });
    expect(await request({ id: 'shutdown', type: 'shutdown', payload: {} }))
      .toMatchObject({ id: 'shutdown', ok: true, result: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns an error response when a malformed worker request reaches the dispatcher', async () => {
    const { request } = await loadWorker();

    const response = await request({
      id: 'bad-history',
      type: 'queryHistory',
      payload: null,
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/Cannot read/);
  });
});
