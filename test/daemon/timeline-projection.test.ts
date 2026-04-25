import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalDbPath = process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;

function makeEvent(sessionId: string, seq: number, type: TimelineEvent['type'], payload: Record<string, unknown>, ts = seq): TimelineEvent {
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

describe('timeline projection', () => {
  let tempHome: string | null = null;
  let dbPath: string | null = null;
  let importedProjection: typeof import('../../src/daemon/timeline-projection.js').timelineProjection | null = null;

  afterEach(async () => {
    if (importedProjection) {
      await importedProjection.shutdown();
    }
    importedProjection = null;
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalDbPath === undefined) delete process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;
    else process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = originalDbPath;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
    dbPath = null;
  });

  async function loadModules(prepareDb?: (path: string) => void) {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-'));
    dbPath = join(tempHome, '.imcodes', 'timeline-projection.sqlite');
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = dbPath;
    prepareDb?.(dbPath);
    const [{ timelineProjection }, { timelineStore }] = await Promise.all([
      import('../../src/daemon/timeline-projection.js'),
      import('../../src/daemon/timeline-store.js'),
    ]);
    importedProjection = timelineProjection;
    return { timelineProjection, timelineStore };
  }

  function readSessionMeta(sessionId: string): { lastRebuiltAt: number | null; status: string; lastProjectedAppendOrdinal: number } {
    const db = new DatabaseSync(dbPath!, { readonly: true });
    try {
      const row = db.prepare(`
        SELECT last_rebuilt_at, status, last_projected_append_ordinal
        FROM timeline_projection_sessions
        WHERE session_id = ?
      `).get(sessionId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`missing projection session row for ${sessionId}`);
      return {
        lastRebuiltAt: typeof row.last_rebuilt_at === 'number' ? row.last_rebuilt_at : null,
        status: String(row.status),
        lastProjectedAppendOrdinal: Number(row.last_projected_append_ordinal),
      };
    } finally {
      db.close();
    }
  }

  function listProjectionEventIndexes(): string[] {
    const db = new DatabaseSync(dbPath!, { readonly: true });
    try {
      return (db.prepare(`PRAGMA index_list('timeline_projection_events')`).all() as Array<Record<string, unknown>>)
        .map((row) => String(row.name))
        .sort();
    } finally {
      db.close();
    }
  }

  function createLegacyProjectionDbWithoutIndexes(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
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
    } finally {
      db.close();
    }
  }

  it('preserves append order for equal-ts events and honors afterTs / beforeTs exclusivity', async () => {
    const { timelineProjection, timelineStore } = await loadModules();
    const sessionId = 'projection_order';
    timelineStore.append(makeEvent(sessionId, 1, 'assistant.text', { text: 'first' }, 1000));
    timelineStore.append(makeEvent(sessionId, 2, 'assistant.text', { text: 'second' }, 1000));
    timelineStore.append(makeEvent(sessionId, 3, 'assistant.text', { text: 'third' }, 1000));
    timelineStore.append(makeEvent(sessionId, 4, 'assistant.text', { text: 'fourth' }, 1001));

    await timelineProjection.rebuildSession(sessionId);

    const full = await timelineStore.readPreferred(sessionId, { limit: 10 });
    expect(full.map((event) => event.seq)).toEqual([1, 2, 3, 4]);

    const after = await timelineStore.readPreferred(sessionId, { afterTs: 1000, limit: 10 });
    expect(after.map((event) => event.seq)).toEqual([4]);

    const before = await timelineStore.readPreferred(sessionId, { beforeTs: 1001, limit: 10 });
    expect(before.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('migrates an existing SQLite projection database by creating missing query indexes', async () => {
    const { timelineProjection } = await loadModules(createLegacyProjectionDbWithoutIndexes);

    expect(listProjectionEventIndexes()).not.toContain('idx_timeline_projection_events_session_type_ts');

    await timelineProjection.queryHistory({ sessionId: 'legacy_missing_session', limit: 1 });

    expect(listProjectionEventIndexes()).toEqual(expect.arrayContaining([
      'idx_timeline_projection_events_session_streaming_ts',
      'idx_timeline_projection_events_session_ts',
      'idx_timeline_projection_events_session_type_ts',
      'sqlite_autoindex_timeline_projection_events_1',
    ]));
  });

  it('returns completed text tail only for non-empty completed text events', async () => {
    const { timelineProjection, timelineStore } = await loadModules();
    const sessionId = 'projection_text_tail';
    timelineStore.append(makeEvent(sessionId, 1, 'user.message', { text: 'hello user' }, 1000));
    timelineStore.append(makeEvent(sessionId, 2, 'assistant.text', { text: 'typing', streaming: true }, 1001));
    timelineStore.append(makeEvent(sessionId, 3, 'assistant.text', { text: 'done', streaming: false }, 1002));
    timelineStore.append(makeEvent(sessionId, 4, 'assistant.text', { text: '   ', streaming: false }, 1003));
    timelineStore.append(makeEvent(sessionId, 5, 'tool.call', { tool: 'search' }, 1004));

    await timelineProjection.rebuildSession(sessionId);

    const tail = await timelineStore.readCompletedTextTail(sessionId, 10);
    expect(tail.map((event) => `${event.type}:${String(event.payload.text ?? '')}`)).toEqual([
      'user.message:hello user',
      'assistant.text:done',
    ]);

    const typed = await timelineStore.readByTypesPreferred(sessionId, ['tool.call', 'assistant.text'], { limit: 10 });
    expect(typed.map((event) => event.seq)).toEqual([2, 3, 4, 5]);
  });

  it('serves stale SQLite rows quickly and prunes to authoritative truncation', async () => {
    const { timelineProjection, timelineStore } = await loadModules();
    const sessionId = 'projection_stale';
    const timelineFile = timelineStore.filePath(sessionId);
    mkdirSync(join(tempHome!, '.imcodes', 'timeline'), { recursive: true });

    timelineStore.append(makeEvent(sessionId, 1, 'assistant.text', { text: 'one' }, 1000));
    timelineStore.append(makeEvent(sessionId, 2, 'assistant.text', { text: 'two' }, 1001));
    await timelineProjection.rebuildSession(sessionId);

    appendFileSync(timelineFile, `${JSON.stringify(makeEvent(sessionId, 3, 'assistant.text', { text: 'three' }, 1002))}\n`);
    const stale = await timelineStore.readPreferred(sessionId, { limit: 10 });
    expect(stale.map((event) => event.seq)).toEqual([1, 2]);

    await timelineProjection.rebuildSession(sessionId);
    const rebuilt = await timelineStore.readPreferred(sessionId, { limit: 10 });
    expect(rebuilt.map((event) => event.seq)).toEqual([1, 2, 3]);

    timelineStore.truncate(sessionId, 2);
    await timelineProjection.pruneSessionToAuthoritative(sessionId, 2);

    const pruned = await timelineStore.readPreferred(sessionId, { limit: 10 });
    expect(pruned.map((event) => event.seq)).toEqual([2, 3]);

    await timelineProjection.deleteSession(sessionId);
    const rebuiltFromAuthoritative = await timelineProjection.queryHistory({ sessionId, limit: 10 });
    expect(rebuiltFromAuthoritative?.map((event) => event.seq)).toEqual([]);
    await timelineProjection.rebuildSession(sessionId);
    const explicitlyRebuilt = await timelineProjection.queryHistory({ sessionId, limit: 10 });
    expect(explicitlyRebuilt?.map((event) => event.seq)).toEqual([2, 3]);
  });

  it('does not parse appended JSONL tails on the read path', async () => {
    const { timelineProjection, timelineStore } = await loadModules();
    const sessionId = 'projection_incremental_tail';
    const timelineFile = timelineStore.filePath(sessionId);
    mkdirSync(join(tempHome!, '.imcodes', 'timeline'), { recursive: true });

    timelineStore.append(makeEvent(sessionId, 1, 'assistant.text', { text: 'one' }, 1000));
    timelineStore.append(makeEvent(sessionId, 2, 'assistant.text', { text: 'two' }, 1001));
    await timelineProjection.rebuildSession(sessionId);

    appendFileSync(timelineFile, `${JSON.stringify(makeEvent(sessionId, 3, 'assistant.text', { text: 'three' }, 1002))}\n`);

    const synced = await timelineStore.readPreferred(sessionId, { limit: 10 });

    expect(synced.map((event) => event.seq)).toEqual([1, 2]);

    await timelineProjection.rebuildSession(sessionId);
    const rebuilt = await timelineStore.readPreferred(sessionId, { limit: 10 });
    expect(rebuilt.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('does not rebuild when only timeline file mtime changes', async () => {
    const { timelineProjection, timelineStore } = await loadModules();
    const sessionId = 'projection_mtime_only';
    const timelineFile = timelineStore.filePath(sessionId);

    timelineStore.append(makeEvent(sessionId, 1, 'assistant.text', { text: 'one' }, 1000));
    timelineStore.append(makeEvent(sessionId, 2, 'assistant.text', { text: 'two' }, 1001));
    await timelineProjection.rebuildSession(sessionId);

    const before = readSessionMeta(sessionId);
    const bumpedAt = new Date(Date.now() + 5_000);
    utimesSync(timelineFile, bumpedAt, bumpedAt);

    const read = await timelineStore.readPreferred(sessionId, { limit: 10 });
    const after = readSessionMeta(sessionId);

    expect(read.map((event) => event.seq)).toEqual([1, 2]);
    expect(after.status).toBe('ready');
    expect(after.lastProjectedAppendOrdinal).toBe(2);
    expect(after.lastRebuiltAt).toBe(before.lastRebuiltAt);
  });
});
