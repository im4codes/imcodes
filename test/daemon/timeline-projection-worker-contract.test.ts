import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import { HISTORY_RETENTION } from '../../src/store/history-retention.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

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

  async function loadWorker(options?: {
    prepareDb?: (dbPath: string) => void;
    retention?: { configPath: string; dayMs: number; maxDays: number; retryMs: number; batchSize: number };
  }) {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-projection-worker-'));
    const dbPath = join(tempHome, 'projection.sqlite');
    options?.prepareDb?.(dbPath);
    const postMessage = vi.fn();
    const close = vi.fn();
    let handler: WorkerHandler | null = null;

    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => tempHome! };
    });
    vi.doMock('node:worker_threads', () => ({
      workerData: {
        dbPath,
        stateDir: join(tempHome!, '.imcodes'),
        ...(options?.retention ? { retention: options.retention } : {}),
      },
      parentPort: {
        on: vi.fn((_event: string, cb: WorkerHandler) => {
          handler = cb;
        }),
        postMessage,
        close,
      },
    }));

    const workerMod = await import('../../src/daemon/timeline-projection-worker.js');
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

    return { request, close, dbPath, workerMod };
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

  it('enables INCREMENTAL auto_vacuum for new DBs and reclaims free pages after prune and delete', async () => {
    const { request, dbPath } = await loadWorker();
    const sessionA = 'vac_session_a';
    const sessionB = 'vac_session_b';
    const timelineDir = join(tempHome!, '.imcodes', 'timeline');
    mkdirSync(timelineDir, { recursive: true });
    const bigText = 'payload-'.repeat(120);

    const buildEvents = (sessionId: string, count: number) =>
      Array.from({ length: count }, (_, idx) =>
        makeEvent(sessionId, idx + 1, 'assistant.text', { text: `${idx}-${bigText}`, streaming: false }, 10_000 + idx),
      );
    const eventsA = buildEvents(sessionA, 300);
    const eventsB = buildEvents(sessionB, 300);
    writeFileSync(join(timelineDir, `${sessionA}.jsonl`), eventsA.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(join(timelineDir, `${sessionB}.jsonl`), eventsB.map((e) => JSON.stringify(e)).join('\n') + '\n');

    expect((await request({ id: 'r-a', type: 'rebuildSession', payload: { sessionId: sessionA } })).ok).toBe(true);
    expect((await request({ id: 'r-b', type: 'rebuildSession', payload: { sessionId: sessionB } })).ok).toBe(true);
    expect((await request({ id: 'ckpt-1', type: 'checkpointIfNeeded', payload: {} })).ok).toBe(true);

    const inspectDb = new DatabaseSync(dbPath, { readOnly: true });
    expect(Number((inspectDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number | bigint }).auto_vacuum)).toBe(2);
    inspectDb.close();

    // Force WAL truncation before measuring baseline size.
    const adminDb = new DatabaseSync(dbPath);
    adminDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const sizeBeforePrune = statSync(dbPath).size;
    adminDb.close();

    expect((await request({
      id: 'prune-a',
      type: 'pruneSessionToAuthoritative',
      payload: { sessionId: sessionA, keepLast: 5 },
    })).ok).toBe(true);
    expect((await request({ id: 'ckpt-prune', type: 'checkpointIfNeeded', payload: {} })).ok).toBe(true);

    const afterPruneDb = new DatabaseSync(dbPath, { readOnly: true });
    const freelistAfterPrune = Number((afterPruneDb.prepare('PRAGMA freelist_count').get() as { freelist_count: number | bigint }).freelist_count);
    afterPruneDb.close();
    const sizeAfterPrune = statSync(dbPath).size;
    expect(freelistAfterPrune).toBeLessThan(64);
    expect(sizeAfterPrune).toBeLessThan(sizeBeforePrune);

    expect((await request({ id: 'del-b', type: 'deleteSession', payload: { sessionId: sessionB } })).ok).toBe(true);
    expect((await request({ id: 'ckpt-del', type: 'checkpointIfNeeded', payload: {} })).ok).toBe(true);
    const afterDeleteDb = new DatabaseSync(dbPath, { readOnly: true });
    const freelistAfterDelete = Number((afterDeleteDb.prepare('PRAGMA freelist_count').get() as { freelist_count: number | bigint }).freelist_count);
    afterDeleteDb.close();
    const sizeAfterDelete = statSync(dbPath).size;
    expect(freelistAfterDelete).toBeLessThan(64);
    expect(sizeAfterDelete).toBeLessThan(sizeAfterPrune);
  });

  it('does not run over-budget synchronous WAL checkpoints while a reader holds a large WAL, then shrinks on maintenance', async () => {
    const configPath = join(tmpdir(), `imcodes-ret-large-wal-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const dayMs = HISTORY_RETENTION.dayMs;
    const enabledAt = Date.now() - 2 * dayMs;
    writeFileSync(configPath, JSON.stringify({ keepDays: 1, enabledAt }));
    try {
      const { request, dbPath } = await loadWorker({
        retention: { configPath, dayMs, maxDays: HISTORY_RETENTION.maxDays, retryMs: 60_000, batchSize: 500 },
      });
      // Ensure schema & wal_autocheckpoint=0 are initialized.
      expect((await request({ id: 'init', type: 'queryHistory', payload: { sessionId: 'none', limit: 1 } })).ok).toBe(true);

      const bigText = 'backlog-'.repeat(180);
      const nowMs = Date.now();
      const oldTs = enabledAt - 10 * dayMs;
      const freshTs = nowMs + 10 * dayMs;
      const seeder = new DatabaseSync(dbPath);
      seeder.exec('PRAGMA wal_autocheckpoint = 0;');
      const insert = seeder.prepare(`INSERT INTO timeline_projection_events
        (session_id, append_ordinal, event_id, ts, seq, epoch, type, source, confidence, text, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 'assistant.text', 'daemon', 'high', ?, ?, ?, ?)`);
      seeder.prepare(`INSERT INTO timeline_projection_sessions VALUES ('s_del', 1200, 0, 0, 1, 'ready', NULL)`).run();
      seeder.prepare(`INSERT INTO timeline_projection_sessions VALUES ('s_ret', 1200, 0, 0, 1, 'ready', NULL)`).run();
      seeder.exec('BEGIN');
      for (let i = 1; i <= 1200; i += 1) {
        insert.run('s_del', i, `del-${i}`, freshTs + i, i, bigText, JSON.stringify({ text: bigText }), freshTs + i, freshTs + i);
        insert.run('s_ret', i, `ret-${i}`, oldTs + i, i, bigText, JSON.stringify({ text: bigText }), oldTs + i, oldTs + i);
      }
      seeder.exec('COMMIT');
      seeder.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      const dbSizeBaseline = statSync(dbPath).size;

      // Build a large >1500-frame WAL backlog while holding an active reader snapshot.
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      reader.exec('BEGIN; SELECT count(*) FROM timeline_projection_events;');
      seeder.prepare(`INSERT INTO timeline_projection_sessions VALUES ('s_wal', 1500, 0, 0, 1, 'ready', NULL)`).run();
      seeder.exec('BEGIN');
      for (let i = 1; i <= 1500; i += 1) {
        insert.run('s_wal', i, `wal-${i}`, freshTs + 10_000 + i, i, bigText, JSON.stringify({ text: bigText }), freshTs + i, freshTs + i);
      }
      seeder.exec('COMMIT');
      seeder.close();

      const walPath = `${dbPath}-wal`;
      const walBytesBeforeCleanup = statSync(walPath).size;
      expect(walBytesBeforeCleanup).toBeGreaterThan(1500 * 4096);

      // Cleanup requests (deleteSession + retentionTick) must NOT copy/truncate the large WAL while reader holds snapshot.
      expect((await request({ id: 'del-large', type: 'deleteSession', payload: { sessionId: 's_del' } })).ok).toBe(true);
      expect(statSync(walPath).size).toBeGreaterThanOrEqual(walBytesBeforeCleanup);

      const retRes = await request({ id: 'tick-large', type: 'retentionTick', payload: { now: nowMs + dayMs } });
      expect(retRes.ok).toBe(true);
      expect((retRes.result as { deleted: number }).deleted).toBe(1200);
      expect(statSync(walPath).size).toBeGreaterThanOrEqual(walBytesBeforeCleanup);

      // Release reader snapshot, then run another prune step: worker wal_autocheckpoint=0 and small-WAL guard
      // must STILL avoid an unbudgeted inline checkpoint until explicit maintenance runs.
      reader.exec('COMMIT');
      reader.close();
      expect((await request({ id: 'prune-wal', type: 'pruneSessionToAuthoritative', payload: { sessionId: 's_wal', keepLast: 10 } })).ok).toBe(true);
      expect(statSync(walPath).size).toBeGreaterThanOrEqual(walBytesBeforeCleanup);

      // Now run explicit maintenance path (`checkpointIfNeeded`): WAL truncates and main DB shrinks on disk.
      expect((await request({ id: 'maint-ckpt', type: 'checkpointIfNeeded', payload: {} })).ok).toBe(true);
      expect(statSync(walPath).size).toBe(0);
      expect(statSync(dbPath).size).toBeLessThan(dbSizeBaseline);
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('reclaims space after retentionTick and tolerates busy locks without blocking readers', async () => {
    const configPath = join(tmpdir(), `imcodes-ret-cfg-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const dayMs = HISTORY_RETENTION.dayMs;
    const enabledAt = Date.now() - 2 * dayMs;
    writeFileSync(configPath, JSON.stringify({ keepDays: 1, enabledAt }));
    try {
      const { request, dbPath, workerMod } = await loadWorker({
        retention: { configPath, dayMs, maxDays: HISTORY_RETENTION.maxDays, retryMs: 60_000, batchSize: 500 },
      });
      const sessionId = 'vac_retention_session';
      const timelineDir = join(tempHome!, '.imcodes', 'timeline');
      mkdirSync(timelineDir, { recursive: true });
      const bigText = 'retention-'.repeat(120);
      const oldTs = enabledAt - 10 * dayMs;
      const lines = Array.from({ length: 700 }, (_, idx) =>
        JSON.stringify(makeEvent(sessionId, idx + 1, 'assistant.text', { text: `${idx}-${bigText}`, streaming: false }, oldTs + idx)),
      ).join('\n') + '\n';
      writeFileSync(join(timelineDir, `${sessionId}.jsonl`), lines);
      expect((await request({ id: 'r-ret', type: 'rebuildSession', payload: { sessionId } })).ok).toBe(true);

      const adminDb = new DatabaseSync(dbPath);
      adminDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      const sizeBeforeRetention = statSync(dbPath).size;
      adminDb.close();

      const retRes = await request({ id: 'tick', type: 'retentionTick', payload: { now: Date.now() + dayMs } });
      expect(retRes.ok).toBe(true);
      expect((retRes.result as { deleted: number }).deleted).toBe(700);
      expect((await request({ id: 'ckpt-ret', type: 'checkpointIfNeeded', payload: {} })).ok).toBe(true);
      const sizeAfterRetention = statSync(dbPath).size;
      expect(sizeAfterRetention).toBeLessThan(sizeBeforeRetention);

      // Simulate external write contention and verify bounded maybeIncrementalVacuum degrades cleanly.
      const dbConn = new DatabaseSync(dbPath);
      const contender = new DatabaseSync(dbPath);
      try {
        dbConn.exec('BEGIN IMMEDIATE');
        for (let i = 0; i < 400; i += 1) {
          dbConn.prepare(`INSERT INTO timeline_projection_events
            (session_id, append_ordinal, event_id, ts, seq, epoch, type, source, confidence, text, payload_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, 'assistant.text', 'daemon', 'high', ?, ?, ?, ?)`)
            .run('busy_s', i + 1, `e-${i}`, oldTs, i + 1, bigText, JSON.stringify({ text: bigText }), oldTs, oldTs);
        }
        dbConn.exec("DELETE FROM timeline_projection_events WHERE session_id = 'busy_s'");
        dbConn.exec('COMMIT');

        contender.exec('BEGIN IMMEDIATE');
        expect(() => workerMod.maybeIncrementalVacuum(dbConn, 64, 1)).not.toThrow();
        contender.exec('ROLLBACK');
        const timeoutRow = dbConn.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>;
        expect(Number(timeoutRow.timeout ?? timeoutRow.busy_timeout)).toBe(5000);
      } finally {
        try { contender.close(); } catch { /* ignore */ }
        dbConn.close();
      }
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('preserves full backward compatibility with legacy auto_vacuum=0 databases', async () => {
    const legacySession = 'legacy_vac_0';
    const { request, dbPath } = await loadWorker({
      prepareDb: (path) => {
        const seed = new DatabaseSync(path);
        seed.exec(`
          PRAGMA auto_vacuum = NONE;
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS timeline_projection_events (
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
          CREATE TABLE IF NOT EXISTS timeline_projection_sessions (
            session_id TEXT PRIMARY KEY,
            last_projected_append_ordinal INTEGER NOT NULL,
            source_file_size_bytes INTEGER NOT NULL,
            source_file_mtime_ms INTEGER NOT NULL,
            projection_version INTEGER NOT NULL,
            status TEXT NOT NULL,
            last_rebuilt_at INTEGER
          );
        `);
        seed.close();
      },
    });

    const timelineDir = join(tempHome!, '.imcodes', 'timeline');
    mkdirSync(timelineDir, { recursive: true });
    const events = Array.from({ length: 200 }, (_, idx) =>
      makeEvent(legacySession, idx + 1, 'assistant.text', { text: `legacy-${idx}`, streaming: false }, 100 + idx),
    );
    writeFileSync(join(timelineDir, `${legacySession}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    expect((await request({ id: 'leg-rebuild', type: 'rebuildSession', payload: { sessionId: legacySession } })).ok).toBe(true);
    expect((await request({ id: 'leg-prune', type: 'pruneSessionToAuthoritative', payload: { sessionId: legacySession, keepLast: 10 } })).ok).toBe(true);
    expect((await request({ id: 'leg-delete', type: 'deleteSession', payload: { sessionId: legacySession } })).ok).toBe(true);

    const checkDb = new DatabaseSync(dbPath, { readOnly: true });
    expect(Number((checkDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number | bigint }).auto_vacuum)).toBe(0);
    checkDb.close();
  });
});
