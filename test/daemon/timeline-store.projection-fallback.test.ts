import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const projectionMocks = vi.hoisted(() => ({
  queryHistory: vi.fn(),
  queryByTypes: vi.fn(),
  queryCompletedTextTail: vi.fn(),
  getLatest: vi.fn(),
  recordAppendedEvent: vi.fn(),
  pruneSessionToAuthoritative: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('../../src/daemon/timeline-projection.js', () => ({
  timelineProjection: projectionMocks,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('timeline-store SQLite-preferred reads', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | null = null;

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    tempHome = null;
  });

  async function loadStoreWithHistory(lines: Array<Record<string, unknown>>, sessionId = 'fallback-session') {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-fallback-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const filePath = join(tempHome, '.imcodes', 'timeline', `${sessionId}.jsonl`);
    mkdirSync(join(tempHome, '.imcodes', 'timeline'), { recursive: true });
    writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    return { timelineStore, sessionId };
  }

  it('does not mirror into the projection when the authoritative JSONL append fails', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-fallback-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // `timelineStore.append` is now async (uses `fs/promises.appendFile`).
    // Mock the promise-based module so the write rejects and the
    // projection mirror call is skipped by the catch block in
    // `appendOne`.
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return {
        ...actual,
        appendFile: vi.fn(async () => {
          throw new Error('append failed');
        }),
      };
    });

    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    await timelineStore.append({
      eventId: 'evt-fail',
      sessionId: 'append-failure',
      ts: 1,
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'nope', streaming: false },
    });

    expect(projectionMocks.recordAppendedEvent).not.toHaveBeenCalled();
  });

  it('returns an empty history when the SQLite projection is unavailable', async () => {
    projectionMocks.queryHistory.mockResolvedValue(null);
    const sessionId = 'fallback-session';
    const { timelineStore } = await loadStoreWithHistory([
      {
        eventId: 'evt-1',
        sessionId,
        ts: 1,
        seq: 1,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'user.message',
        payload: { text: 'hi' },
      },
      {
        eventId: 'evt-2',
        sessionId,
        ts: 2,
        seq: 2,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'hello', streaming: false },
      },
    ], sessionId);

    await expect(timelineStore.readPreferred(sessionId, { limit: 10 })).rejects.toMatchObject({
      reason: 'projection_unavailable',
      source: 'main_sqlite',
    });
    expect(projectionMocks.queryHistory).toHaveBeenCalledWith({
      sessionId,
      afterTs: undefined,
      beforeTs: undefined,
      limit: 10,
    });
  });

  it('returns empty typed reads and completed text tails when the SQLite projection is unavailable', async () => {
    projectionMocks.queryByTypes.mockResolvedValue(null);
    projectionMocks.queryCompletedTextTail.mockResolvedValue(null);

    const sessionId = 'fallback-session';
    const { timelineStore } = await loadStoreWithHistory([
      {
        eventId: 'evt-1',
        sessionId,
        ts: 10,
        seq: 1,
        epoch: 7,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: { tool: 'Read' },
      },
      {
        eventId: 'evt-2',
        sessionId,
        ts: 11,
        seq: 2,
        epoch: 7,
        source: 'daemon',
        confidence: 'high',
        type: 'user.message',
        payload: { text: 'question' },
      },
      {
        eventId: 'evt-3',
        sessionId,
        ts: 12,
        seq: 3,
        epoch: 7,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'answer', streaming: false },
      },
    ], sessionId);

    await expect(timelineStore.readByTypesPreferred(sessionId, ['assistant.text'], { limit: 10 })).rejects.toMatchObject({
      reason: 'projection_unavailable',
      source: 'main_sqlite',
    });

    await expect(timelineStore.readCompletedTextTail(sessionId, 10)).rejects.toMatchObject({
      reason: 'projection_unavailable',
      source: 'main_sqlite',
    });
  });

  it('returns null latest markers when the SQLite projection returns null', async () => {
    projectionMocks.getLatest.mockResolvedValue(null);
    const sessionId = 'fallback-session';
    const { timelineStore } = await loadStoreWithHistory([
      {
        eventId: 'evt-1',
        sessionId,
        ts: 10,
        seq: 1,
        epoch: 7,
        source: 'daemon',
        confidence: 'high',
        type: 'user.message',
        payload: { text: 'question' },
      },
      {
        eventId: 'evt-3',
        sessionId,
        ts: 12,
        seq: 3,
        epoch: 7,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'answer', streaming: false },
      },
    ], sessionId);
    const latest = await timelineStore.getLatestPreferred(sessionId);
    expect(latest).toBeNull();
  });
});
