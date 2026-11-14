import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CALLBACK_MAX_RELATED_TASK_ID_CHARS,
  CALLBACK_MAX_SUMMARY_CHARS,
  isCallbackStatus,
  isCallbackUpdateStatus,
  isValidCallbackId,
  normalizeCallbackSource,
  validateCallbackMetadata,
  type CallbackSource,
  type CallbackStatus,
  type CallbackTaskRecord,
} from '../../shared/callback-types.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';
import { assertNotRealImcodesPathInTests, isUnderTestRunner } from '../util/test-home-guard.js';
import logger from '../util/logger.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export const CALLBACK_TASKS_DB_PATH_ENV = 'IMCODES_CALLBACK_TASKS_DB_PATH' as const;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export function resolveCallbackTasksDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[CALLBACK_TASKS_DB_PATH_ENV]?.trim();
  if (explicit) return explicit;
  if (isUnderTestRunner(env)) return ':memory:';
  return join(imcodesStateDir(env), 'callback-tasks.sqlite');
}

export interface CreateCallbackTaskInput {
  callbackId: string;
  source: CallbackSource;
  eventType: string;
  scopeKey: string;
  entityKey: string;
  dedupKey: string;
  title: string;
  url?: string;
  targetSession: string;
  status?: CallbackStatus;
  summary?: string;
  relatedTaskId?: string;
  metadata?: Record<string, unknown>;
  lastError?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface UpdateCallbackTaskInput {
  callbackId: string;
  status: CallbackStatus;
  summary?: string;
  source?: string;
  relatedTaskId?: string;
  metadata?: Record<string, unknown>;
  lastError?: string;
  updatedAt?: number;
}

export type UpdateCallbackTaskResult =
  | { ok: true; record: CallbackTaskRecord }
  | { ok: false; reason: 'not_found' | 'source_mismatch' | 'validation_failed'; error: string };

export type CallbackUpdatedListener = (record: CallbackTaskRecord) => void;

export interface CallbackPendingSeqEntry {
  seq: number;
  createdAt?: number;
}

export interface CallbackCiRunStateRecord {
  source: string;
  scopeKey: string;
  runId: number;
  generation: number;
  sawPending: boolean;
  lastTerminalStatus: string | null;
  lastUpdatedAt: number;
  updatedAt: number;
}

export interface CallbackCheckpointRecord {
  source: string;
  scopeKey: string;
  eventType: string;
  baselineComplete: boolean;
  baselineNextPage: number;
  watermarkSeq: number | null;
  syncNextPage: number;
  syncHighSeq: number | null;
  pendingSeqs: CallbackPendingSeqEntry[];
  updatedAt: number;
}

interface CallbackCheckpointRow {
  source: string;
  scope_key: string;
  event_type: string;
  baseline_complete: number;
  baseline_next_page: number;
  watermark_seq: number | null;
  sync_next_page: number;
  sync_high_seq: number | null;
  pending_seqs_json: string | null;
  updated_at: number;
}

interface CallbackTaskRow {
  callback_id: string;
  source: string;
  event_type: string;
  scope_key: string;
  entity_key: string;
  dedup_key: string;
  title: string;
  url: string | null;
  target_session: string;
  status: string;
  summary: string;
  related_task_id: string | null;
  metadata_json: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToRecord(row: CallbackTaskRow): CallbackTaskRecord {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = undefined;
    }
  }
  return {
    callbackId: row.callback_id,
    source: row.source,
    eventType: row.event_type,
    scopeKey: row.scope_key,
    entityKey: row.entity_key,
    dedupKey: row.dedup_key,
    title: row.title,
    ...(row.url ? { url: row.url } : {}),
    targetSession: row.target_session,
    status: isCallbackStatus(row.status) ? row.status : 'pending',
    summary: row.summary,
    ...(row.related_task_id ? { relatedTaskId: row.related_task_id } : {}),
    ...(metadata ? { metadata } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CallbackTaskStore {
  private readonly db: DatabaseSyncInstance;
  private readonly listeners = new Map<string, Set<CallbackUpdatedListener>>();
  private closed = false;

  constructor(dbPath: string = resolveCallbackTasksDbPath()) {
    assertNotRealImcodesPathInTests(dbPath, 'callback-tasks store');
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS callback_tasks (
        callback_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        target_session TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        related_task_id TEXT,
        metadata_json TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_callback_tasks_scope_updated
        ON callback_tasks (source, scope_key, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_callback_tasks_dedup
        ON callback_tasks (source, dedup_key);
      CREATE TABLE IF NOT EXISTS callback_seen (
        source TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (source, dedup_key)
      );
      CREATE INDEX IF NOT EXISTS idx_callback_seen_scope
        ON callback_seen (source, scope_key);
      CREATE TABLE IF NOT EXISTS callback_checkpoints (
        source TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        baseline_complete INTEGER NOT NULL DEFAULT 0,
        baseline_next_page INTEGER NOT NULL DEFAULT 1,
        watermark_seq INTEGER,
        sync_next_page INTEGER NOT NULL DEFAULT 1,
        sync_high_seq INTEGER,
        pending_seqs_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, scope_key, event_type)
      );
      CREATE TABLE IF NOT EXISTS callback_ci_run_states (
        source TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        run_id INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        saw_pending INTEGER NOT NULL DEFAULT 0,
        last_terminal_status TEXT,
        last_updated_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, scope_key, run_id)
      );
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.db.close();
  }

  onCallbackUpdated(source: CallbackSource | '*', listener: CallbackUpdatedListener): () => void {
    const key = source === '*' ? '*' : (normalizeCallbackSource(source) ?? source);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(key);
    };
  }

  private emitUpdated(record: CallbackTaskRecord): void {
    const targets = [
      ...(this.listeners.get(record.source) ?? []),
      ...(this.listeners.get('*') ?? []),
    ];
    for (const listener of targets) {
      try {
        listener(record);
      } catch (err) {
        logger.warn({ err, callbackId: record.callbackId, source: record.source }, 'callback update listener threw');
      }
    }
  }

  createCallback(input: CreateCallbackTaskInput): CallbackTaskRecord {
    if (!isValidCallbackId(input.callbackId)) {
      throw new Error(`Invalid callbackId: ${input.callbackId}`);
    }
    const source = normalizeCallbackSource(input.source);
    if (!source) {
      throw new Error(`Invalid callback source: ${input.source}`);
    }
    const status: CallbackStatus = input.status ?? 'pending';
    if (!isCallbackStatus(status)) {
      throw new Error(`Invalid callback status: ${input.status}`);
    }
    const summary = (input.summary ?? '').slice(0, CALLBACK_MAX_SUMMARY_CHARS);
    const metaCheck = validateCallbackMetadata(input.metadata);
    if (!metaCheck.ok) {
      throw new Error(metaCheck.error);
    }
    const relatedTaskId = input.relatedTaskId?.trim().slice(0, CALLBACK_MAX_RELATED_TASK_ID_CHARS) || null;
    const now = input.createdAt ?? Date.now();
    const updatedAt = input.updatedAt ?? now;
    const metadataJson = metaCheck.value ? JSON.stringify(metaCheck.value) : null;

    this.db.prepare(`
      INSERT INTO callback_tasks (
        callback_id, source, event_type, scope_key, entity_key, dedup_key,
        title, url, target_session, status, summary, related_task_id,
        metadata_json, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.callbackId,
      source,
      input.eventType.trim(),
      input.scopeKey,
      input.entityKey,
      input.dedupKey,
      input.title,
      input.url ?? null,
      input.targetSession,
      status,
      summary,
      relatedTaskId,
      metadataJson,
      input.lastError ?? null,
      now,
      updatedAt,
    );

    const created = this.getCallback(input.callbackId);
    if (!created) {
      throw new Error(`Failed to read back created callback ${input.callbackId}`);
    }
    this.emitUpdated(created);
    return created;
  }

  getCallback(callbackId: string): CallbackTaskRecord | null {
    if (!isValidCallbackId(callbackId)) return null;
    const row = this.db.prepare('SELECT * FROM callback_tasks WHERE callback_id = ?').get(callbackId) as CallbackTaskRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByDedupKey(source: CallbackSource, dedupKey: string): CallbackTaskRecord | null {
    const normalized = normalizeCallbackSource(source) ?? source;
    const row = this.db.prepare(
      'SELECT * FROM callback_tasks WHERE source = ? AND dedup_key = ? ORDER BY updated_at DESC LIMIT 1',
    ).get(normalized, dedupKey) as CallbackTaskRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listCallbacks(filter: {
    source?: CallbackSource;
    scopeKey?: string;
    status?: CallbackStatus;
    limit?: number;
  } = {}): CallbackTaskRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.source) {
      clauses.push('source = ?');
      params.push(normalizeCallbackSource(filter.source) ?? filter.source);
    }
    if (filter.scopeKey !== undefined) {
      clauses.push('scope_key = ?');
      params.push(filter.scopeKey);
    }
    if (filter.status && isCallbackStatus(filter.status)) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const rawLimit = typeof filter.limit === 'number' && Number.isFinite(filter.limit)
      ? Math.trunc(filter.limit)
      : DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, rawLimit));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT * FROM callback_tasks ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as CallbackTaskRow[];
    return rows.map(rowToRecord);
  }

  updateCallback(input: UpdateCallbackTaskInput): UpdateCallbackTaskResult {
    if (!isValidCallbackId(input.callbackId)) {
      return { ok: false, reason: 'validation_failed', error: 'invalid callbackId format' };
    }
    if (!isCallbackStatus(input.status)) {
      return { ok: false, reason: 'validation_failed', error: 'invalid callback status' };
    }
    const existing = this.getCallback(input.callbackId);
    if (!existing) {
      return { ok: false, reason: 'not_found', error: `callback ${input.callbackId} not found` };
    }
    if (input.source !== undefined) {
      const normalized = normalizeCallbackSource(input.source);
      if (!normalized || normalized !== existing.source) {
        return {
          ok: false,
          reason: 'source_mismatch',
          error: `callback ${input.callbackId} belongs to source "${existing.source}", not "${input.source}"`,
        };
      }
    }

    let nextSummary = existing.summary;
    if (input.summary !== undefined) {
      if (typeof input.summary !== 'string' || input.summary.length > CALLBACK_MAX_SUMMARY_CHARS) {
        return {
          ok: false,
          reason: 'validation_failed',
          error: `summary must be a string up to ${CALLBACK_MAX_SUMMARY_CHARS} characters`,
        };
      }
      nextSummary = input.summary;
    }

    let nextRelatedTaskId = existing.relatedTaskId;
    if (input.relatedTaskId !== undefined) {
      const trimmed = input.relatedTaskId.trim();
      if (trimmed.length > CALLBACK_MAX_RELATED_TASK_ID_CHARS) {
        return {
          ok: false,
          reason: 'validation_failed',
          error: `relatedTaskId must be at most ${CALLBACK_MAX_RELATED_TASK_ID_CHARS} characters`,
        };
      }
      nextRelatedTaskId = trimmed || undefined;
    }

    let nextMetadata = existing.metadata;
    if (input.metadata !== undefined) {
      const metaCheck = validateCallbackMetadata(input.metadata);
      if (!metaCheck.ok) {
        return { ok: false, reason: 'validation_failed', error: metaCheck.error };
      }
      nextMetadata = metaCheck.value;
    }

    const nextLastError = input.lastError !== undefined
      ? (input.lastError || undefined)
      : (isCallbackUpdateStatus(input.status) && input.status !== 'failed' ? undefined : existing.lastError);
    const updatedAt = input.updatedAt ?? Date.now();

    this.db.prepare(`
      UPDATE callback_tasks
         SET status = ?,
             summary = ?,
             related_task_id = ?,
             metadata_json = ?,
             last_error = ?,
             updated_at = ?
       WHERE callback_id = ?
    `).run(
      input.status,
      nextSummary,
      nextRelatedTaskId ?? null,
      nextMetadata ? JSON.stringify(nextMetadata) : null,
      nextLastError ?? null,
      updatedAt,
      input.callbackId,
    );

    const updated = this.getCallback(input.callbackId)!;
    this.emitUpdated(updated);
    return { ok: true, record: updated };
  }

  hasSeenDedupKey(source: CallbackSource, dedupKey: string): boolean {
    const normalized = normalizeCallbackSource(source) ?? source;
    const row = this.db.prepare(
      'SELECT 1 AS ok FROM callback_seen WHERE source = ? AND dedup_key = ? LIMIT 1',
    ).get(normalized, dedupKey) as { ok: number } | undefined;
    return row !== undefined;
  }

  hasAnySeenForScope(source: CallbackSource, scopeKey: string): boolean {
    const normalized = normalizeCallbackSource(source) ?? source;
    const row = this.db.prepare(
      'SELECT 1 AS ok FROM callback_seen WHERE source = ? AND scope_key = ? LIMIT 1',
    ).get(normalized, scopeKey) as { ok: number } | undefined;
    return row !== undefined;
  }

  markSeenDedupKeys(source: CallbackSource, scopeKey: string, dedupKeys: readonly string[], seenAt = Date.now()): void {
    if (dedupKeys.length === 0) return;
    const normalized = normalizeCallbackSource(source) ?? source;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO callback_seen (source, dedup_key, scope_key, first_seen_at) VALUES (?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const dedupKey of dedupKeys) {
        stmt.run(normalized, dedupKey, scopeKey, seenAt);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getCheckpoint(source: CallbackSource, scopeKey: string, eventType: string): CallbackCheckpointRecord | null {
    const normalized = normalizeCallbackSource(source) ?? source;
    const row = this.db.prepare(`
      SELECT source, scope_key, event_type, baseline_complete, baseline_next_page,
             watermark_seq, sync_next_page, sync_high_seq, pending_seqs_json, updated_at
        FROM callback_checkpoints
       WHERE source = ? AND scope_key = ? AND event_type = ?
       LIMIT 1
    `).get(normalized, scopeKey, eventType) as CallbackCheckpointRow | undefined;
    if (!row) return null;
    let pendingSeqs: CallbackPendingSeqEntry[] = [];
    if (row.pending_seqs_json) {
      try {
        const parsed = JSON.parse(row.pending_seqs_json) as unknown;
        if (Array.isArray(parsed)) {
          pendingSeqs = parsed.filter(
            (entry): entry is CallbackPendingSeqEntry =>
              Boolean(entry && typeof entry === 'object' && typeof (entry as { seq?: unknown }).seq === 'number' && Number.isFinite((entry as { seq: number }).seq)),
          );
        }
      } catch {
        pendingSeqs = [];
      }
    }
    return {
      source: row.source,
      scopeKey: row.scope_key,
      eventType: row.event_type,
      baselineComplete: row.baseline_complete === 1,
      baselineNextPage: Math.max(1, row.baseline_next_page),
      watermarkSeq: row.watermark_seq ?? null,
      syncNextPage: Math.max(1, row.sync_next_page),
      syncHighSeq: row.sync_high_seq ?? null,
      pendingSeqs,
      updatedAt: row.updated_at,
    };
  }

  saveCheckpointProgress(
    checkpoint: CallbackCheckpointRecord,
    dedupKeysToMark: readonly string[] = [],
  ): void {
    const normalized = normalizeCallbackSource(checkpoint.source) ?? checkpoint.source;
    const seenStmt = this.db.prepare(
      'INSERT OR IGNORE INTO callback_seen (source, dedup_key, scope_key, first_seen_at) VALUES (?, ?, ?, ?)',
    );
    const cpStmt = this.db.prepare(`
      INSERT INTO callback_checkpoints (
        source, scope_key, event_type, baseline_complete, baseline_next_page,
        watermark_seq, sync_next_page, sync_high_seq, pending_seqs_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, scope_key, event_type) DO UPDATE SET
        baseline_complete = excluded.baseline_complete,
        baseline_next_page = excluded.baseline_next_page,
        watermark_seq = excluded.watermark_seq,
        sync_next_page = excluded.sync_next_page,
        sync_high_seq = excluded.sync_high_seq,
        pending_seqs_json = excluded.pending_seqs_json,
        updated_at = excluded.updated_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const dedupKey of dedupKeysToMark) {
        seenStmt.run(normalized, dedupKey, checkpoint.scopeKey, checkpoint.updatedAt);
      }
      cpStmt.run(
        normalized,
        checkpoint.scopeKey,
        checkpoint.eventType,
        checkpoint.baselineComplete ? 1 : 0,
        Math.max(1, checkpoint.baselineNextPage),
        checkpoint.watermarkSeq,
        Math.max(1, checkpoint.syncNextPage),
        checkpoint.syncHighSeq,
        checkpoint.pendingSeqs.length > 0 ? JSON.stringify(checkpoint.pendingSeqs) : null,
        checkpoint.updatedAt,
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getCiRunStates(
    source: CallbackSource,
    scopeKey: string,
    runIds: readonly number[],
  ): Map<number, CallbackCiRunStateRecord> {
    const out = new Map<number, CallbackCiRunStateRecord>();
    if (runIds.length === 0) return out;
    const normalized = normalizeCallbackSource(source) ?? source;
    const uniqueIds = Array.from(new Set(runIds.filter((id) => Number.isFinite(id))));
    if (uniqueIds.length === 0) return out;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT source, scope_key, run_id, generation, saw_pending, last_terminal_status, last_updated_at, updated_at
        FROM callback_ci_run_states
       WHERE source = ? AND scope_key = ? AND run_id IN (${placeholders})
    `).all(normalized, scopeKey, ...uniqueIds) as Array<{
      source: string;
      scope_key: string;
      run_id: number;
      generation: number;
      saw_pending: number;
      last_terminal_status: string | null;
      last_updated_at: number;
      updated_at: number;
    }>;
    for (const row of rows) {
      out.set(row.run_id, {
        source: row.source,
        scopeKey: row.scope_key,
        runId: row.run_id,
        generation: Math.max(1, row.generation),
        sawPending: row.saw_pending === 1,
        lastTerminalStatus: row.last_terminal_status ?? null,
        lastUpdatedAt: Number.isFinite(row.last_updated_at) ? row.last_updated_at : 0,
        updatedAt: row.updated_at,
      });
    }
    return out;
  }

  upsertCiRunStates(records: readonly CallbackCiRunStateRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO callback_ci_run_states (
        source, scope_key, run_id, generation, saw_pending, last_terminal_status, last_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, scope_key, run_id) DO UPDATE SET
        generation = excluded.generation,
        saw_pending = excluded.saw_pending,
        last_terminal_status = excluded.last_terminal_status,
        last_updated_at = excluded.last_updated_at,
        updated_at = excluded.updated_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const rec of records) {
        const normalized = normalizeCallbackSource(rec.source) ?? rec.source;
        stmt.run(
          normalized,
          rec.scopeKey,
          rec.runId,
          Math.max(1, Math.trunc(rec.generation)),
          rec.sawPending ? 1 : 0,
          rec.lastTerminalStatus,
          Number.isFinite(rec.lastUpdatedAt) ? Math.trunc(rec.lastUpdatedAt) : 0,
          rec.updatedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

let singleton: CallbackTaskStore | null = null;

export function getCallbackTaskStore(): CallbackTaskStore {
  if (!singleton) {
    singleton = new CallbackTaskStore();
  }
  return singleton;
}

export function resetCallbackTaskStoreForTests(dbPath = ':memory:'): CallbackTaskStore {
  if (singleton) {
    singleton.close();
  }
  singleton = new CallbackTaskStore(dbPath);
  return singleton;
}
