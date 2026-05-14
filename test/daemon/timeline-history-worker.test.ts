import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import type { TimelineHistoryWorkerRequest } from '../../src/daemon/timeline-history-worker-types.js';
import { TIMELINE_HISTORY_DETAIL_CANDIDATE_RESPONSE_MAX_BYTES } from '../../src/daemon/timeline-history-sanitize.js';
import { TIMELINE_HISTORY_WORKER_ERROR_REASONS } from '../../shared/timeline-history-errors.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

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

function createProjectionSchema(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE timeline_projection_events (
      session_id TEXT NOT NULL,
      append_ordinal INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence TEXT NOT NULL,
      streaming INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      text TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, append_ordinal)
    );
    CREATE INDEX idx_timeline_projection_events_session_type_ts
      ON timeline_projection_events(session_id, type, ts DESC, append_ordinal DESC);
    CREATE TABLE timeline_projection_sessions (
      session_id TEXT PRIMARY KEY,
      last_projected_append_ordinal INTEGER NOT NULL,
      source_file_size_bytes INTEGER NOT NULL,
      source_file_mtime_ms INTEGER NOT NULL,
      projection_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      last_rebuilt_at INTEGER
    );
  `);
}

function insertSession(db: DatabaseSyncInstance, sessionId: string, status = 'ready'): void {
  db.prepare(`
    INSERT INTO timeline_projection_sessions (
      session_id, last_projected_append_ordinal, source_file_size_bytes,
      source_file_mtime_ms, projection_version, status, last_rebuilt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, 0, 1, 1, 1, status, Date.now());
}

function insertEvent(db: DatabaseSyncInstance, appendOrdinal: number, event: TimelineEvent): void {
  db.prepare(`
    INSERT INTO timeline_projection_events (
      session_id, append_ordinal, event_id, ts, seq, epoch, type, source,
      confidence, streaming, hidden, text, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.sessionId,
    appendOrdinal,
    event.eventId,
    event.ts,
    event.seq,
    event.epoch,
    event.type,
    event.source,
    event.confidence,
    event.payload.streaming === true ? 1 : 0,
    event.hidden === true ? 1 : 0,
    typeof event.payload.text === 'string' ? event.payload.text : null,
    JSON.stringify(event.payload),
    Date.now(),
    Date.now(),
  );
}

describe('timeline history worker', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('node:worker_threads');
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function loadWorker(prepare: (db: DatabaseSyncInstance) => void) {
    tempDir = mkdtempSync(join(tmpdir(), 'imcodes-timeline-history-worker-'));
    const dbPath = join(tempDir, 'timeline.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      createProjectionSchema(db);
      prepare(db);
    } finally {
      db.close();
    }

    vi.doMock('node:worker_threads', () => ({
      workerData: { dbPath },
      parentPort: {
        on: vi.fn(),
        postMessage: vi.fn(),
      },
    }));

    return await import('../../src/daemon/timeline-history-worker.js');
  }

  function request(overrides: Partial<TimelineHistoryWorkerRequest>): TimelineHistoryWorkerRequest {
    return {
      workerRequestId: 1,
      workerSlotId: 1,
      workerGeneration: 1,
      sessionName: 'deck_hist',
      limit: 20,
      contentTypes: ['user.message', 'assistant.text', 'tool.result'],
      stateTypes: ['session.state'],
      ...overrides,
    };
  }

  it('builds history from SQLite, interleaves state events, and caps large tool payloads', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const { handleTimelineHistoryWorkerRequest } = await loadWorker((db) => {
      insertSession(db, 'deck_hist');
      insertEvent(db, 1, makeEvent('deck_hist', 1, 'user.message', { text: 'hello' }, 100));
      insertEvent(db, 2, makeEvent('deck_hist', 2, 'session.state', { state: 'running' }, 101));
      insertEvent(db, 3, makeEvent('deck_hist', 3, 'tool.result', {
        output: huge,
        detail: { output: huge, raw: { aggregatedOutput: huge } },
      }, 102));
      insertEvent(db, 4, makeEvent('deck_hist', 4, 'assistant.text', { text: 'done', streaming: false }, 103));
    });

    const result = await handleTimelineHistoryWorkerRequest(request({}));

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error(result.reason);
    expect(result.events.map((event) => event.eventId)).toEqual([
      'deck_hist-1-user.message',
      'deck_hist-2-session.state',
      'deck_hist-3-tool.result',
      'deck_hist-4-assistant.text',
    ]);
    expect(result.eventsRead).toBe(4);
    expect(result.payloadBytes).toBeLessThan(1024 * 1024);
    const toolEvent = result.events.find((event) => event.type === 'tool.result');
    expect(toolEvent).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(toolEvent), 'utf8')).toBeLessThan(40 * 1024);
    expect(JSON.stringify(toolEvent)).toContain('history truncated');
    expect(result.detailCandidates.every((candidate) => Buffer.byteLength(candidate.value, 'utf8') <= candidate.valueMaxBytes)).toBe(true);
  });

  it('does not send multi-MB raw detail candidates back to the main thread', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const { handleTimelineHistoryWorkerRequest } = await loadWorker((db) => {
      insertSession(db, 'deck_hist');
      insertEvent(db, 1, makeEvent('deck_hist', 1, 'tool.result', {
        output: huge,
        detail: { output: huge },
      }, 100));
    });

    const result = await handleTimelineHistoryWorkerRequest(request({}));

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error(result.reason);
    expect(result.detailCandidates).toEqual([]);
  });

  it('caps aggregate detail candidate bytes returned from the worker', async () => {
    const medium = 'x'.repeat(80 * 1024);
    const { handleTimelineHistoryWorkerRequest } = await loadWorker((db) => {
      insertSession(db, 'deck_hist');
      for (let seq = 1; seq <= 8; seq += 1) {
        insertEvent(db, seq, makeEvent('deck_hist', seq, 'tool.result', {
          output: `${medium}-${seq}`,
        }, 100 + seq));
      }
    });

    const result = await handleTimelineHistoryWorkerRequest(request({ maxResponseBytes: 512 * 1024 }));

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error(result.reason);
    const aggregateBytes = result.detailCandidates.reduce((total, candidate) => total + candidate.valueBytes, 0);
    expect(aggregateBytes).toBeLessThanOrEqual(TIMELINE_HISTORY_DETAIL_CANDIDATE_RESPONSE_MAX_BYTES);
  });

  it('returns projection_unavailable instead of doing main-thread fallback work inside the worker', async () => {
    const { handleTimelineHistoryWorkerRequest } = await loadWorker((db) => {
      insertSession(db, 'deck_hist', 'building');
    });

    const result = await handleTimelineHistoryWorkerRequest(request({}));

    expect(result).toMatchObject({
      kind: 'error',
      reason: TIMELINE_HISTORY_WORKER_ERROR_REASONS.PROJECTION_UNAVAILABLE,
      sanitized: true,
    });
  });
});
