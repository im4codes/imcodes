import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { TimelineEvent, TimelineEventType } from './timeline-event.js';
import type {
  ProjectionSessionMeta,
  ProjectionWorkerEnvelope,
  ProjectionWorkerRequestType,
  ProjectionWorkerResponse,
} from './timeline-projection-types.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

type ProjectionStatus = 'missing' | 'building' | 'ready' | 'stale' | 'corrupt';
type WorkerRequest = {
  [K in ProjectionWorkerRequestType]: ProjectionWorkerEnvelope<K>;
}[ProjectionWorkerRequestType];

const PROJECTION_VERSION = 1;
const TIMELINE_DIR = join(homedir(), '.imcodes', 'timeline');
const dbPath = typeof workerData?.dbPath === 'string' && workerData.dbPath
  ? workerData.dbPath
  : join(homedir(), '.imcodes', 'timeline.sqlite');

let db: DatabaseSyncInstance | null = null;
const rebuildPromises = new Map<string, Promise<boolean>>();
let writesSinceCheckpoint = 0;

function sessionFilePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(TIMELINE_DIR, `${safe}.jsonl`);
}

function ensureDb(): DatabaseSyncInstance {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  const instance = new DatabaseSync(dbPath);
  instance.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
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
    CREATE INDEX IF NOT EXISTS idx_timeline_projection_events_session_ts
      ON timeline_projection_events(session_id, ts DESC, append_ordinal DESC);
    CREATE INDEX IF NOT EXISTS idx_timeline_projection_events_session_type_ts
      ON timeline_projection_events(session_id, type, ts DESC, append_ordinal DESC);
    CREATE INDEX IF NOT EXISTS idx_timeline_projection_events_session_streaming_ts
      ON timeline_projection_events(session_id, streaming, ts DESC, append_ordinal DESC);

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
  db = instance;
  return instance;
}

function runInTransaction(work: () => void): void {
  const database = ensureDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    work();
    database.exec('COMMIT');
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // ignore rollback failures
    }
    throw err;
  }
}

function readSessionMeta(sessionId: string): ProjectionSessionMeta | null {
  const row = ensureDb().prepare(`
    SELECT session_id, last_projected_append_ordinal, source_file_size_bytes, source_file_mtime_ms, projection_version, status, last_rebuilt_at
    FROM timeline_projection_sessions
    WHERE session_id = ?
  `).get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    lastProjectedAppendOrdinal: Number(row.last_projected_append_ordinal),
    sourceFileSizeBytes: Number(row.source_file_size_bytes),
    sourceFileMtimeMs: Number(row.source_file_mtime_ms),
    projectionVersion: Number(row.projection_version),
    status: String(row.status) as ProjectionStatus,
    lastRebuiltAt: typeof row.last_rebuilt_at === 'number' ? row.last_rebuilt_at : null,
  };
}

function upsertSessionMeta(sessionId: string, meta: {
  lastProjectedAppendOrdinal: number;
  sourceFileSizeBytes: number;
  sourceFileMtimeMs: number;
  status: ProjectionStatus;
  lastRebuiltAt?: number | null;
}): void {
  ensureDb().prepare(`
    INSERT INTO timeline_projection_sessions (
      session_id, last_projected_append_ordinal, source_file_size_bytes, source_file_mtime_ms, projection_version, status, last_rebuilt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_projected_append_ordinal = excluded.last_projected_append_ordinal,
      source_file_size_bytes = excluded.source_file_size_bytes,
      source_file_mtime_ms = excluded.source_file_mtime_ms,
      projection_version = excluded.projection_version,
      status = excluded.status,
      last_rebuilt_at = excluded.last_rebuilt_at
  `).run(
    sessionId,
    meta.lastProjectedAppendOrdinal,
    meta.sourceFileSizeBytes,
    meta.sourceFileMtimeMs,
    PROJECTION_VERSION,
    meta.status,
    meta.lastRebuiltAt ?? null,
  );
}

function deleteSessionRows(sessionId: string): void {
  const database = ensureDb();
  database.prepare('DELETE FROM timeline_projection_events WHERE session_id = ?').run(sessionId);
  database.prepare('DELETE FROM timeline_projection_sessions WHERE session_id = ?').run(sessionId);
}

function currentFileMeta(sessionId: string): { exists: boolean; size: number; mtimeMs: number } {
  const filePath = sessionFilePath(sessionId);
  if (!existsSync(filePath)) return { exists: false, size: 0, mtimeMs: 0 };
  const stat = statSync(filePath);
  return { exists: true, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function parseLinesAscending(sessionId: string): TimelineEvent[] {
  const filePath = sessionFilePath(sessionId);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  const events: TimelineEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as TimelineEvent;
      if (event.sessionId === sessionId) events.push(event);
    } catch {
      // preserve JSONL tolerance: corrupt lines are skipped
    }
  }
  return events;
}

function parseAppendedEvents(sessionId: string, startOffset: number, endOffset: number): TimelineEvent[] | null {
  const filePath = sessionFilePath(sessionId);
  if (!existsSync(filePath)) return [];
  if (endOffset <= startOffset) return [];

  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const expectedLength = endOffset - startOffset;
    const buf = Buffer.alloc(expectedLength);
    let totalRead = 0;
    while (totalRead < expectedLength) {
      const bytesRead = readSync(fd, buf, totalRead, expectedLength - totalRead, startOffset + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    if (totalRead !== expectedLength) return null;

    const raw = buf.toString('utf8');
    if (!raw.trim()) return [];

    const events: TimelineEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as TimelineEvent;
        if (event.sessionId === sessionId) events.push(event);
      } catch {
        return null;
      }
    }
    return events;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function extractTextAndStreaming(event: TimelineEvent): { text: string | null; streaming: number } {
  const text = typeof event.payload?.text === 'string' ? event.payload.text : null;
  const streaming = event.payload?.streaming === true ? 1 : 0;
  return { text, streaming };
}

function insertProjectedEvent(database: DatabaseSyncInstance, sessionId: string, appendOrdinal: number, event: TimelineEvent): void {
  const { text, streaming } = extractTextAndStreaming(event);
  database.prepare(`
    INSERT INTO timeline_projection_events (
      session_id, append_ordinal, event_id, ts, seq, epoch, type, source, confidence, streaming, hidden, text, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    appendOrdinal,
    event.eventId,
    event.ts,
    event.seq,
    event.epoch,
    event.type,
    event.source,
    event.confidence,
    streaming,
    event.hidden === true ? 1 : 0,
    text,
    JSON.stringify(event.payload),
    event.ts,
    Date.now(),
  );
}

async function rebuildSessionInternal(sessionId: string): Promise<boolean> {
  const existing = rebuildPromises.get(sessionId);
  if (existing) return existing;
  const promise = Promise.resolve().then(() => {
    const database = ensureDb();
    const fileMeta = currentFileMeta(sessionId);
    if (!fileMeta.exists) {
      deleteSessionRows(sessionId);
      return true;
    }
    upsertSessionMeta(sessionId, {
      lastProjectedAppendOrdinal: 0,
      sourceFileSizeBytes: fileMeta.size,
      sourceFileMtimeMs: fileMeta.mtimeMs,
      status: 'building',
      lastRebuiltAt: Date.now(),
    });
    const events = parseLinesAscending(sessionId);
    runInTransaction(() => {
      database.prepare('DELETE FROM timeline_projection_events WHERE session_id = ?').run(sessionId);
      let appendOrdinal = 0;
      for (const event of events) {
        appendOrdinal += 1;
        insertProjectedEvent(database, sessionId, appendOrdinal, event);
      }
      upsertSessionMeta(sessionId, {
        lastProjectedAppendOrdinal: appendOrdinal,
        sourceFileSizeBytes: fileMeta.size,
        sourceFileMtimeMs: fileMeta.mtimeMs,
        status: 'ready',
        lastRebuiltAt: Date.now(),
      });
    });
    writesSinceCheckpoint += Math.max(events.length, 1);
    maybeCheckpoint();
    return true;
  }).finally(() => {
    rebuildPromises.delete(sessionId);
  });
  rebuildPromises.set(sessionId, promise);
  return promise;
}

function scheduleSessionRebuild(sessionId: string): void {
  setImmediate(() => {
    void rebuildSessionInternal(sessionId).catch(() => {
      // Query paths must stay fast and fail-open; an explicit rebuild request or
      // the next append/query can retry projection repair.
    });
  });
}

function markSessionReady(
  sessionId: string,
  meta: ProjectionSessionMeta | null,
  fileMeta: { exists: boolean; size: number; mtimeMs: number },
): void {
  upsertSessionMeta(sessionId, {
    lastProjectedAppendOrdinal: meta?.lastProjectedAppendOrdinal ?? 0,
    sourceFileSizeBytes: fileMeta.size,
    sourceFileMtimeMs: fileMeta.mtimeMs,
    status: fileMeta.exists ? 'ready' : 'missing',
    lastRebuiltAt: meta?.lastRebuiltAt ?? null,
  });
}

async function syncSessionDelta(sessionId: string, meta: ProjectionSessionMeta): Promise<boolean> {
  const fileMeta = currentFileMeta(sessionId);
  if (!fileMeta.exists) {
    deleteSessionRows(sessionId);
    return false;
  }

  if (fileMeta.size === meta.sourceFileSizeBytes) {
    // JSONL is append-only. If only mtime drifted, just refresh the tracked
    // source metadata instead of rebuilding the full projection.
    if (fileMeta.mtimeMs !== meta.sourceFileMtimeMs) {
      markSessionReady(sessionId, meta, fileMeta);
    }
    return true;
  }

  if (fileMeta.size < meta.sourceFileSizeBytes || fileMeta.mtimeMs < meta.sourceFileMtimeMs) {
    await rebuildSessionInternal(sessionId);
    return true;
  }

  const appendedEvents = parseAppendedEvents(sessionId, meta.sourceFileSizeBytes, fileMeta.size);
  if (appendedEvents === null) {
    await rebuildSessionInternal(sessionId);
    return true;
  }

  if (appendedEvents.length === 0) {
    markSessionReady(sessionId, meta, fileMeta);
    return true;
  }

  const database = ensureDb();
  runInTransaction(() => {
    let appendOrdinal = meta.lastProjectedAppendOrdinal;
    for (const event of appendedEvents) {
      appendOrdinal += 1;
      insertProjectedEvent(database, sessionId, appendOrdinal, event);
    }
    upsertSessionMeta(sessionId, {
      lastProjectedAppendOrdinal: appendOrdinal,
      sourceFileSizeBytes: fileMeta.size,
      sourceFileMtimeMs: fileMeta.mtimeMs,
      status: 'ready',
      lastRebuiltAt: meta.lastRebuiltAt,
    });
  });
  writesSinceCheckpoint += appendedEvents.length;
  maybeCheckpoint();
  return true;
}

function prepareSqliteRead(sessionId: string): boolean {
  const meta = readSessionMeta(sessionId);
  const fileMeta = currentFileMeta(sessionId);
  if (!fileMeta.exists) {
    deleteSessionRows(sessionId);
    return false;
  }
  if (!meta) {
    scheduleSessionRebuild(sessionId);
    return false;
  }
  if (meta.status !== 'ready' || meta.projectionVersion !== PROJECTION_VERSION) {
    scheduleSessionRebuild(sessionId);
    return true;
  }
  if (meta.sourceFileSizeBytes === fileMeta.size && meta.sourceFileMtimeMs !== fileMeta.mtimeMs) {
    markSessionReady(sessionId, meta, fileMeta);
    return true;
  }
  if (meta.sourceFileSizeBytes !== fileMeta.size || meta.sourceFileMtimeMs !== fileMeta.mtimeMs) {
    scheduleSessionRebuild(sessionId);
  }
  return true;
}

function rowToEvent(row: Record<string, unknown>): TimelineEvent {
  const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  return {
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    ts: Number(row.ts),
    seq: Number(row.seq),
    epoch: Number(row.epoch),
    source: String(row.source) as TimelineEvent['source'],
    confidence: String(row.confidence) as TimelineEvent['confidence'],
    type: String(row.type) as TimelineEvent['type'],
    payload,
    ...(Number(row.hidden) === 1 ? { hidden: true } : {}),
  };
}

function maybeCheckpoint(): void {
  if (writesSinceCheckpoint < 256) return;
  writesSinceCheckpoint = 0;
  ensureDb().exec('PRAGMA wal_checkpoint(TRUNCATE);');
}

async function handleRecordAppendedEvent(event: TimelineEvent): Promise<boolean> {
  const fileMeta = currentFileMeta(event.sessionId);
  if (!fileMeta.exists) return false;
  const meta = readSessionMeta(event.sessionId);
  const serializedEvent = JSON.stringify(event) + '\n';
  const appendedBytes = Buffer.byteLength(serializedEvent);
  if (
    !meta
    || meta.status !== 'ready'
    || meta.projectionVersion !== PROJECTION_VERSION
    || fileMeta.size !== meta.sourceFileSizeBytes + appendedBytes
    || fileMeta.mtimeMs < meta.sourceFileMtimeMs
  ) {
    if (meta && meta.status === 'ready' && meta.projectionVersion === PROJECTION_VERSION) {
      await syncSessionDelta(event.sessionId, meta);
    } else {
      await rebuildSessionInternal(event.sessionId);
    }
    return true;
  }
  const database = ensureDb();
  const nextOrdinal = (meta?.lastProjectedAppendOrdinal ?? 0) + 1;
  runInTransaction(() => {
    insertProjectedEvent(database, event.sessionId, nextOrdinal, event);
    upsertSessionMeta(event.sessionId, {
      lastProjectedAppendOrdinal: nextOrdinal,
      sourceFileSizeBytes: fileMeta.size,
      sourceFileMtimeMs: fileMeta.mtimeMs,
      status: 'ready',
      lastRebuiltAt: meta?.lastRebuiltAt ?? null,
    });
  });
  writesSinceCheckpoint += 1;
  maybeCheckpoint();
  return true;
}

function buildRangeSql(base: string, afterTs?: number, beforeTs?: number): { sql: string; params: unknown[] } {
  const clauses = [base];
  const params: unknown[] = [];
  if (afterTs !== undefined) {
    clauses.push('AND ts > ?');
    params.push(afterTs);
  }
  if (beforeTs !== undefined) {
    clauses.push('AND ts < ?');
    params.push(beforeTs);
  }
  return { sql: clauses.join(' '), params };
}

async function handleQueryHistory(sessionId: string, afterTs?: number, beforeTs?: number, limit = 500): Promise<{ source: 'sqlite'; events: TimelineEvent[] }> {
  if (!prepareSqliteRead(sessionId)) return { source: 'sqlite', events: [] };
  const boundedLimit = Math.max(1, Math.min(limit, 10_000));
  const { sql, params } = buildRangeSql(
    'SELECT * FROM timeline_projection_events WHERE session_id = ?',
    afterTs,
    beforeTs,
  );
  const rows = ensureDb().prepare(`${sql} ORDER BY ts DESC, append_ordinal DESC LIMIT ?`).all(...([sessionId, ...params, boundedLimit] as any[])) as Array<Record<string, unknown>>;
  return { source: 'sqlite', events: rows.reverse().map(rowToEvent) };
}

async function handleQueryLatest(sessionId: string): Promise<{ epoch: number; seq: number } | null> {
  if (!prepareSqliteRead(sessionId)) return null;
  const row = ensureDb().prepare(`
    SELECT epoch, seq
    FROM timeline_projection_events
    WHERE session_id = ?
    ORDER BY append_ordinal DESC
    LIMIT 1
  `).get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { epoch: Number(row.epoch), seq: Number(row.seq) };
}

async function handleQueryCompletedTextTail(sessionId: string, limit = 50): Promise<{ source: 'sqlite'; events: TimelineEvent[] }> {
  if (!prepareSqliteRead(sessionId)) return { source: 'sqlite', events: [] };
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const rows = ensureDb().prepare(`
    SELECT *
    FROM timeline_projection_events
    WHERE session_id = ?
      AND (
        (type = 'user.message' AND text IS NOT NULL AND trim(text) <> '')
        OR
        (type = 'assistant.text' AND streaming = 0 AND text IS NOT NULL AND trim(text) <> '')
      )
    ORDER BY ts DESC, append_ordinal DESC
    LIMIT ?
  `).all(sessionId, boundedLimit) as Array<Record<string, unknown>>;
  return { source: 'sqlite', events: rows.reverse().map(rowToEvent) };
}

async function handleQueryByTypes(sessionId: string, types: TimelineEventType[], afterTs?: number, beforeTs?: number, limit = 500): Promise<{ source: 'sqlite'; events: TimelineEvent[] }> {
  if (!prepareSqliteRead(sessionId)) return { source: 'sqlite', events: [] };
  if (types.length === 0) return { source: 'sqlite', events: [] };
  const boundedLimit = Math.max(1, Math.min(limit, 10_000));
  const placeholders = types.map(() => '?').join(', ');
  const { sql, params } = buildRangeSql(
    `SELECT * FROM timeline_projection_events WHERE session_id = ? AND type IN (${placeholders})`,
    afterTs,
    beforeTs,
  );
  const rows = ensureDb().prepare(`${sql} ORDER BY ts DESC, append_ordinal DESC LIMIT ?`)
    .all(...([sessionId, ...types, ...params, boundedLimit] as any[])) as Array<Record<string, unknown>>;
  return { source: 'sqlite', events: rows.reverse().map(rowToEvent) };
}

async function handlePruneSessionToAuthoritative(sessionId: string, keepLast: number): Promise<boolean> {
  const database = ensureDb();
  const boundedKeep = Math.max(1, keepLast);
  database.prepare(`
    DELETE FROM timeline_projection_events
    WHERE session_id = ?
      AND append_ordinal NOT IN (
        SELECT append_ordinal
        FROM timeline_projection_events
        WHERE session_id = ?
        ORDER BY append_ordinal DESC
        LIMIT ?
      )
  `).run(sessionId, sessionId, boundedKeep);
  const meta = readSessionMeta(sessionId);
  if (meta) {
    const fileMeta = currentFileMeta(sessionId);
    const latestRow = database.prepare(`
      SELECT append_ordinal
      FROM timeline_projection_events
      WHERE session_id = ?
      ORDER BY append_ordinal DESC
      LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;
    upsertSessionMeta(sessionId, {
      lastProjectedAppendOrdinal: latestRow ? Number(latestRow.append_ordinal) : 0,
      sourceFileSizeBytes: fileMeta.size,
      sourceFileMtimeMs: fileMeta.mtimeMs,
      status: fileMeta.exists ? 'ready' : 'missing',
      lastRebuiltAt: meta.lastRebuiltAt,
    });
  }
  writesSinceCheckpoint += 1;
  maybeCheckpoint();
  return true;
}

async function handleDeleteSession(sessionId: string): Promise<boolean> {
  deleteSessionRows(sessionId);
  writesSinceCheckpoint += 1;
  maybeCheckpoint();
  return true;
}

async function handleCheckpointIfNeeded(): Promise<boolean> {
  maybeCheckpoint();
  return true;
}

async function handleShutdown(): Promise<true> {
  parentPort?.close();
  return true;
}

async function handleRequest(message: WorkerRequest): Promise<unknown> {
  switch (message.type) {
    case 'recordAppendedEvent':
      return handleRecordAppendedEvent(message.payload.event);
    case 'queryHistory':
      return handleQueryHistory(message.payload.sessionId, message.payload.afterTs, message.payload.beforeTs, message.payload.limit);
    case 'queryLatest':
      return handleQueryLatest(message.payload.sessionId);
    case 'queryCompletedTextTail':
      return handleQueryCompletedTextTail(message.payload.sessionId, message.payload.limit);
    case 'queryByTypes':
      return handleQueryByTypes(message.payload.sessionId, message.payload.types, message.payload.afterTs, message.payload.beforeTs, message.payload.limit);
    case 'rebuildSession': {
      const existing = rebuildPromises.get(message.payload.sessionId);
      if (existing) return existing;
      try {
        return rebuildSessionInternal(message.payload.sessionId);
      } catch (result) {
        if (result instanceof Promise) return result;
        throw result;
      }
    }
    case 'pruneSessionToAuthoritative':
      return handlePruneSessionToAuthoritative(message.payload.sessionId, message.payload.keepLast);
    case 'deleteSession':
      return handleDeleteSession(message.payload.sessionId);
    case 'checkpointIfNeeded':
      return handleCheckpointIfNeeded();
    case 'shutdown':
      return handleShutdown();
  }
}

if (!parentPort) {
  throw new Error('timeline-projection-worker requires parentPort');
}

parentPort.on('message', async (message: WorkerRequest) => {
  try {
    const result = await handleRequest(message);
    const response: ProjectionWorkerResponse = { id: message.id, type: message.type, ok: true, result } as ProjectionWorkerResponse;
    parentPort?.postMessage(response);
  } catch (err) {
    const response: ProjectionWorkerResponse = {
      id: message.id,
      type: message.type,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort?.postMessage(response);
  }
});
