import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type {
  ContextDirtyTarget,
  ContextFreshness,
  ContextJobRecord,
  ContextJobStatus,
  ContextJobTrigger,
  ContextJobType,
  ContextNamespace,
  ContextReplicationState,
  ContextTargetRef,
  ContextPendingEventView,
  LocalContextEvent,
  ProcessedContextProjection,
  ProcessedContextClass,
  ContextScope,
} from '../../shared/context-types.js';
import { classifyTimestampFreshness } from '../../shared/context-freshness.js';
import { serializeContextNamespace, serializeContextTarget } from '../context/context-keys.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'shared-agent-context.sqlite');
const DEFAULT_LOCAL_PROCESSED_FRESH_MS = 6 * 60 * 60 * 1000;

let db: DatabaseSyncInstance | null = null;
let currentDbPath: string | null = null;
let stagedReconciledForPath: string | null = null;

function getDbPath(): string {
  return process.env.IMCODES_CONTEXT_DB_PATH?.trim() || DEFAULT_DB_PATH;
}

function getLocalProcessedFreshMs(): number {
  const raw = process.env.IMCODES_LOCAL_PROCESSED_FRESH_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOCAL_PROCESSED_FRESH_MS;
}

function ensureDb(): DatabaseSyncInstance {
  const dbPath = getDbPath();
  if (db && currentDbPath === dbPath) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  currentDbPath = dbPath;
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS context_staged_events (
      id TEXT PRIMARY KEY,
      namespace_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      session_name TEXT,
      event_type TEXT NOT NULL,
      content TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_staged_events_target_created
      ON context_staged_events(target_key, created_at);

    CREATE TABLE IF NOT EXISTS context_dirty_targets (
      target_key TEXT PRIMARY KEY,
      namespace_key TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      session_name TEXT,
      event_count INTEGER NOT NULL,
      oldest_event_at INTEGER NOT NULL,
      newest_event_at INTEGER NOT NULL,
      last_trigger TEXT,
      pending_job_id TEXT
    );

    CREATE TABLE IF NOT EXISTS context_jobs (
      id TEXT PRIMARY KEY,
      namespace_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      session_name TEXT,
      job_type TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_context_jobs_target_status
      ON context_jobs(target_key, status, created_at);

    CREATE TABLE IF NOT EXISTS context_processed_local (
      id TEXT PRIMARY KEY,
      namespace_key TEXT NOT NULL,
      class TEXT NOT NULL,
      source_event_ids_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_processed_local_namespace
      ON context_processed_local(namespace_key, class, updated_at DESC);

    CREATE TABLE IF NOT EXISTS context_replication_state (
      namespace_key TEXT PRIMARY KEY,
      pending_projection_ids_json TEXT NOT NULL,
      last_replicated_at INTEGER,
      last_error TEXT
    );
  `);
  if (stagedReconciledForPath !== dbPath) {
    reconcileMaterializedStagedEvents(db);
    stagedReconciledForPath = dbPath;
  }
  return db;
}

function decodeTarget(row: Record<string, unknown>, namespace: ContextNamespace): ContextTargetRef {
  return {
    namespace,
    kind: String(row.target_kind) as ContextTargetRef['kind'],
    sessionName: typeof row.session_name === 'string' && row.session_name ? row.session_name : undefined,
  };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function resetContextStoreForTests(): void {
  if (db) db.close();
  db = null;
  currentDbPath = null;
  stagedReconciledForPath = null;
}

export function recordContextEvent(input: Omit<LocalContextEvent, 'id' | 'createdAt'> & Partial<Pick<LocalContextEvent, 'id' | 'createdAt'>>): LocalContextEvent {
  const database = ensureDb();
  const event: LocalContextEvent = {
    id: input.id ?? randomUUID(),
    target: input.target,
    eventType: input.eventType,
    content: input.content,
    metadata: input.metadata,
    createdAt: input.createdAt ?? Date.now(),
  };
  const namespaceKey = serializeContextNamespace(event.target.namespace);
  const targetKey = serializeContextTarget(event.target);
  database.prepare(`
    INSERT INTO context_staged_events (
      id, namespace_key, target_key, target_kind, session_name, event_type, content, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    namespaceKey,
    targetKey,
    event.target.kind,
    event.target.sessionName ?? null,
    event.eventType,
    event.content ?? null,
    JSON.stringify(event.metadata ?? null),
    event.createdAt,
  );
  database.prepare(`
    INSERT INTO context_dirty_targets (
      target_key, namespace_key, target_kind, session_name, event_count, oldest_event_at, newest_event_at, last_trigger, pending_job_id
    ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL)
    ON CONFLICT(target_key) DO UPDATE SET
      event_count = context_dirty_targets.event_count + 1,
      oldest_event_at = MIN(context_dirty_targets.oldest_event_at, excluded.oldest_event_at),
      newest_event_at = MAX(context_dirty_targets.newest_event_at, excluded.newest_event_at),
      namespace_key = excluded.namespace_key,
      target_kind = excluded.target_kind,
      session_name = excluded.session_name
  `).run(
    targetKey,
    namespaceKey,
    event.target.kind,
    event.target.sessionName ?? null,
    event.createdAt,
    event.createdAt,
  );
  return event;
}

export function listDirtyTargets(namespace?: ContextNamespace): ContextDirtyTarget[] {
  const database = ensureDb();
  const rows = namespace
    ? database.prepare('SELECT * FROM context_dirty_targets WHERE namespace_key = ? ORDER BY newest_event_at DESC').all(serializeContextNamespace(namespace))
    : database.prepare('SELECT * FROM context_dirty_targets ORDER BY newest_event_at DESC').all();
  return (rows as Array<Record<string, unknown>>).map((row) => {
    const namespaceKey = String(row.namespace_key);
    const resolvedNamespace = namespace ?? parseNamespaceKey(namespaceKey);
    return {
      target: decodeTarget(row as Record<string, unknown>, resolvedNamespace),
      eventCount: Number(row.event_count),
      oldestEventAt: Number(row.oldest_event_at),
      newestEventAt: Number(row.newest_event_at),
      lastTrigger: typeof row.last_trigger === 'string' ? row.last_trigger as ContextJobTrigger : undefined,
      pendingJobId: typeof row.pending_job_id === 'string' ? row.pending_job_id : undefined,
    };
  });
}

export function listContextEvents(target: ContextTargetRef): LocalContextEvent[] {
  const database = ensureDb();
  const targetKey = serializeContextTarget(target);
  const rows = database.prepare('SELECT * FROM context_staged_events WHERE target_key = ? ORDER BY created_at ASC').all(targetKey);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    target,
    eventType: String(row.event_type),
    content: typeof row.content === 'string' ? row.content : undefined,
    metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null) ?? undefined,
    createdAt: Number(row.created_at),
  }));
}

export function deleteStagedEventsByIds(eventIds: string[]): void {
  if (eventIds.length === 0) return;
  const database = ensureDb();
  const placeholders = eventIds.map(() => '?').join(', ');
  database.prepare(`DELETE FROM context_staged_events WHERE id IN (${placeholders})`).run(...eventIds);
}

export function queryPendingContextEvents(filters: {
  scope?: ContextScope;
  projectId?: string;
  query?: string;
  limit?: number;
} = {}): ContextPendingEventView[] {
  const database = ensureDb();
  const rows = database.prepare(`
    SELECT id, namespace_key, session_name, event_type, content, created_at
    FROM context_staged_events
    ORDER BY created_at DESC
  `).all() as Array<Record<string, unknown>>;
  const normalizedQuery = filters.query?.trim().toLowerCase() ?? '';
  const limit = typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 50;
  return rows
    .map((row) => {
      const namespace = parseNamespaceKey(String(row.namespace_key));
      return {
        id: String(row.id),
        scope: namespace.scope,
        projectId: namespace.projectId,
        sessionName: typeof row.session_name === 'string' ? row.session_name : undefined,
        eventType: String(row.event_type),
        content: typeof row.content === 'string' ? row.content : undefined,
        createdAt: Number(row.created_at),
      };
    })
    .filter((row) => !filters.scope || row.scope === filters.scope)
    .filter((row) => !filters.projectId || row.projectId === filters.projectId)
    .filter((row) => {
      if (!normalizedQuery) return true;
      const haystack = `${row.eventType}\n${row.content ?? ''}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, limit)
    .map(({ scope: _scope, ...row }) => row);
}

export function enqueueContextJob(target: ContextTargetRef, jobType: ContextJobType, trigger: ContextJobTrigger, now = Date.now()): ContextJobRecord {
  const database = ensureDb();
  const targetKey = serializeContextTarget(target);
  const existingPending = database.prepare(`
    SELECT * FROM context_jobs
    WHERE target_key = ? AND job_type = ? AND status IN ('pending', 'running')
    ORDER BY created_at ASC
    LIMIT 1
  `).get(targetKey, jobType) as Record<string, unknown> | undefined;
  if (existingPending) {
    database.prepare(`
      UPDATE context_dirty_targets SET last_trigger = ?, pending_job_id = ? WHERE target_key = ?
    `).run(trigger, String(existingPending.id), targetKey);
    return mapJobRecord(existingPending, target.namespace);
  }
  const job: ContextJobRecord = {
    id: randomUUID(),
    target,
    jobType,
    trigger,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
  };
  database.prepare(`
    INSERT INTO context_jobs (
      id, namespace_key, target_key, target_kind, session_name, job_type, trigger, status, created_at, updated_at, attempt_count, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    job.id,
    serializeContextNamespace(target.namespace),
    targetKey,
    target.kind,
    target.sessionName ?? null,
    jobType,
    trigger,
    job.status,
    now,
    now,
    job.attemptCount,
  );
  database.prepare(`
    UPDATE context_dirty_targets SET last_trigger = ?, pending_job_id = ? WHERE target_key = ?
  `).run(trigger, job.id, targetKey);
  return job;
}

export function updateContextJob(jobId: string, status: ContextJobStatus, updates?: { error?: string; attemptIncrement?: boolean; now?: number }): void {
  const database = ensureDb();
  const now = updates?.now ?? Date.now();
  database.prepare(`
    UPDATE context_jobs
    SET status = ?, updated_at = ?, error = ?, attempt_count = attempt_count + ?
    WHERE id = ?
  `).run(status, now, updates?.error ?? null, updates?.attemptIncrement ? 1 : 0, jobId);
}

/**
 * Count consecutive materialization_failed jobs for a target since the last
 * completed job. Used to decide when to give up retrying SDK compression.
 */
export function countConsecutiveFailedJobs(target: ContextTargetRef): number {
  const database = ensureDb();
  const targetKey = serializeContextTarget(target);
  // Get all jobs for this target in descending order; count failed ones until
  // we hit a completed/non-failed job or the end.
  const rows = database.prepare(`
    SELECT status FROM context_jobs
    WHERE target_key = ? AND job_type IN ('materialize_session', 'materialize_project')
    ORDER BY created_at DESC
    LIMIT 20
  `).all(targetKey) as Array<{ status: string }>;
  let count = 0;
  for (const row of rows) {
    if (row.status === 'materialization_failed') count++;
    else if (row.status === 'completed') break;
    // 'pending' / 'running' states are skipped (shouldn't count as failure yet)
  }
  return count;
}

/**
 * Delete tentative (retry-pending) projections for a namespace+class.
 * Called before committing a successful SDK compression to remove the
 * placeholder local-fallback summary from prior failed attempts.
 */
export function deleteTentativeProjections(namespace: ContextNamespace, projectionClass: ProcessedContextClass): number {
  const database = ensureDb();
  const namespaceKey = serializeContextNamespace(namespace);
  // Scan matching rows and delete those with content.tentative === true
  const rows = database.prepare(
    'SELECT id, content_json FROM context_processed_local WHERE namespace_key = ? AND class = ?',
  ).all(namespaceKey, projectionClass) as Array<{ id: string; content_json: string }>;
  let deleted = 0;
  for (const row of rows) {
    const content = parseJson<Record<string, unknown>>(row.content_json, {});
    if (content.tentative === true) {
      database.prepare('DELETE FROM context_processed_local WHERE id = ?').run(row.id);
      deleted++;
    }
  }
  return deleted;
}

export function writeProcessedProjection(input: Omit<ProcessedContextProjection, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<ProcessedContextProjection, 'id' | 'createdAt' | 'updatedAt'>>): ProcessedContextProjection {
  const database = ensureDb();
  const now = Date.now();
  const projection: ProcessedContextProjection = {
    id: input.id ?? randomUUID(),
    namespace: input.namespace,
    class: input.class,
    sourceEventIds: input.sourceEventIds,
    summary: input.summary,
    content: input.content,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  database.prepare(`
    INSERT INTO context_processed_local (
      id, namespace_key, class, source_event_ids_json, summary, content_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projection.id,
    serializeContextNamespace(projection.namespace),
    projection.class,
    JSON.stringify(projection.sourceEventIds),
    projection.summary,
    JSON.stringify(projection.content),
    projection.createdAt,
    projection.updatedAt,
  );
  return projection;
}

export function listProcessedProjections(namespace: ContextNamespace, projectionClass?: ProcessedContextClass): ProcessedContextProjection[] {
  const database = ensureDb();
  const namespaceKey = serializeContextNamespace(namespace);
  const rows = projectionClass
    ? database.prepare('SELECT * FROM context_processed_local WHERE namespace_key = ? AND class = ? ORDER BY updated_at DESC').all(namespaceKey, projectionClass)
    : database.prepare('SELECT * FROM context_processed_local WHERE namespace_key = ? ORDER BY updated_at DESC').all(namespaceKey);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    namespace,
    class: String(row.class) as ProcessedContextClass,
    sourceEventIds: parseJson<string[]>(row.source_event_ids_json, []),
    summary: String(row.summary),
    content: parseJson<Record<string, unknown>>(row.content_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export interface ProcessedProjectionQuery {
  scope?: ContextScope;
  projectId?: string;
  projectionClass?: ProcessedContextClass;
  query?: string;
  limit?: number;
}

export interface ProcessedProjectionStats {
  totalRecords: number;
  matchedRecords: number;
  recentSummaryCount: number;
  durableCandidateCount: number;
  projectCount: number;
  stagedEventCount: number;
  dirtyTargetCount: number;
  pendingJobCount: number;
}

export function queryProcessedProjections(filters: ProcessedProjectionQuery = {}): ProcessedContextProjection[] {
  const database = ensureDb();
  const rows = database.prepare('SELECT * FROM context_processed_local ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
  const normalizedQuery = filters.query?.trim().toLowerCase() ?? '';
  const filtered = rows
    .map((row) => {
      const namespace = parseNamespaceKey(String(row.namespace_key));
      return {
        id: String(row.id),
        namespace,
        class: String(row.class) as ProcessedContextClass,
        sourceEventIds: parseJson<string[]>(row.source_event_ids_json, []),
        summary: String(row.summary),
        content: parseJson<Record<string, unknown>>(row.content_json, {}),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      } satisfies ProcessedContextProjection;
    })
    .filter((projection) => !filters.scope || projection.namespace.scope === filters.scope)
    .filter((projection) => !filters.projectId || projection.namespace.projectId === filters.projectId)
    .filter((projection) => !filters.projectionClass || projection.class === filters.projectionClass)
    .filter((projection) => {
      if (!normalizedQuery) return true;
      const haystack = `${projection.summary}\n${JSON.stringify(projection.content)}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  const limit = typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 50;
  return filtered.slice(0, limit);
}

export function getProcessedProjectionStats(filters: ProcessedProjectionQuery = {}): ProcessedProjectionStats {
  const database = ensureDb();
  const rows = database.prepare('SELECT namespace_key, class, summary, content_json FROM context_processed_local').all() as Array<Record<string, unknown>>;
  const normalizedQuery = filters.query?.trim().toLowerCase() ?? '';
  let totalRecords = 0;
  let matchedRecords = 0;
  let recentSummaryCount = 0;
  let durableCandidateCount = 0;
  const projectIds = new Set<string>();
  for (const row of rows) {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    if (filters.scope && namespace.scope !== filters.scope) continue;
    if (filters.projectId && namespace.projectId !== filters.projectId) continue;
    const projectionClass = String(row.class) as ProcessedContextClass;
    if (filters.projectionClass && projectionClass !== filters.projectionClass) continue;
    totalRecords += 1;
    projectIds.add(namespace.projectId);
    if (projectionClass === 'recent_summary') recentSummaryCount += 1;
    if (projectionClass === 'durable_memory_candidate') durableCandidateCount += 1;
    if (!normalizedQuery) {
      matchedRecords += 1;
      continue;
    }
    const haystack = `${String(row.summary)}\n${JSON.stringify(parseJson<Record<string, unknown>>(row.content_json, {}))}`.toLowerCase();
    if (haystack.includes(normalizedQuery)) matchedRecords += 1;
  }
  const pending = getPendingContextStats(filters);
  for (const projectId of pending.projectIds) projectIds.add(projectId);
  return {
    totalRecords,
    matchedRecords,
    recentSummaryCount,
    durableCandidateCount,
    projectCount: projectIds.size,
    stagedEventCount: pending.stagedEventCount,
    dirtyTargetCount: pending.dirtyTargetCount,
    pendingJobCount: pending.pendingJobCount,
  };
}

function getPendingContextStats(filters: ProcessedProjectionQuery): {
  stagedEventCount: number;
  dirtyTargetCount: number;
  pendingJobCount: number;
  projectIds: Set<string>;
} {
  const database = ensureDb();
  const dirtyRows = database.prepare('SELECT namespace_key, event_count FROM context_dirty_targets').all() as Array<Record<string, unknown>>;
  const pendingJobRows = database.prepare(
    "SELECT namespace_key FROM context_jobs WHERE status IN ('pending', 'running')",
  ).all() as Array<Record<string, unknown>>;

  let stagedEventCount = 0;
  let dirtyTargetCount = 0;
  let pendingJobCount = 0;
  const projectIds = new Set<string>();

  for (const row of dirtyRows) {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    if (filters.scope && namespace.scope !== filters.scope) continue;
    if (filters.projectId && namespace.projectId !== filters.projectId) continue;
    stagedEventCount += Number(row.event_count);
    dirtyTargetCount += 1;
    projectIds.add(namespace.projectId);
  }

  for (const row of pendingJobRows) {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    if (filters.scope && namespace.scope !== filters.scope) continue;
    if (filters.projectId && namespace.projectId !== filters.projectId) continue;
    pendingJobCount += 1;
    projectIds.add(namespace.projectId);
  }

  return {
    stagedEventCount,
    dirtyTargetCount,
    pendingJobCount,
    projectIds,
  };
}

function reconcileMaterializedStagedEvents(database: DatabaseSyncInstance): void {
  const stagedRows = database.prepare('SELECT id FROM context_staged_events').all() as Array<Record<string, unknown>>;
  if (stagedRows.length === 0) return;
  const stagedIds = new Set(stagedRows.map((row) => String(row.id)));
  const projectionRows = database.prepare('SELECT source_event_ids_json FROM context_processed_local').all() as Array<Record<string, unknown>>;
  const matchedIds: string[] = [];
  for (const row of projectionRows) {
    const sourceIds = parseJson<string[]>(row.source_event_ids_json, []);
    for (const sourceId of sourceIds) {
      if (stagedIds.has(sourceId)) matchedIds.push(sourceId);
    }
  }
  if (matchedIds.length === 0) return;
  const uniqueIds = Array.from(new Set(matchedIds));
  const placeholders = uniqueIds.map(() => '?').join(', ');
  database.prepare(`DELETE FROM context_staged_events WHERE id IN (${placeholders})`).run(...uniqueIds);
}

export function getLocalProcessedFreshness(namespace: ContextNamespace, now = Date.now()): ContextFreshness {
  const database = ensureDb();
  const namespaceKey = serializeContextNamespace(namespace);
  const row = database.prepare(
    'SELECT updated_at FROM context_processed_local WHERE namespace_key = ? ORDER BY updated_at DESC LIMIT 1',
  ).get(namespaceKey) as Record<string, unknown> | undefined;
  const baseFreshness = classifyTimestampFreshness(
    row ? Number(row.updated_at) : undefined,
    now,
    getLocalProcessedFreshMs(),
  );
  // If base freshness is 'fresh', also check replication state for staleness signals
  if (baseFreshness === 'fresh') {
    const replState = getReplicationState(namespace);
    if (replState) {
      // Pending projections indicate incomplete replication → stale
      if (replState.pendingProjectionIds && replState.pendingProjectionIds.length > 0) return 'stale';
      // Replication error indicates unhealthy pipeline → stale
      if (replState.lastError) return 'stale';
    }
  }
  return baseFreshness;
}

export function setReplicationState(namespace: ContextNamespace, state: Omit<ContextReplicationState, 'namespace'>): ContextReplicationState {
  const database = ensureDb();
  const namespaceKey = serializeContextNamespace(namespace);
  const value: ContextReplicationState = {
    namespace,
    lastReplicatedAt: state.lastReplicatedAt,
    pendingProjectionIds: state.pendingProjectionIds,
    lastError: state.lastError,
  };
  database.prepare(`
    INSERT INTO context_replication_state (namespace_key, pending_projection_ids_json, last_replicated_at, last_error)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace_key) DO UPDATE SET
      pending_projection_ids_json = excluded.pending_projection_ids_json,
      last_replicated_at = excluded.last_replicated_at,
      last_error = excluded.last_error
  `).run(namespaceKey, JSON.stringify(value.pendingProjectionIds), value.lastReplicatedAt ?? null, value.lastError ?? null);
  return value;
}

export function getReplicationState(namespace: ContextNamespace): ContextReplicationState | undefined {
  const database = ensureDb();
  const row = database.prepare('SELECT * FROM context_replication_state WHERE namespace_key = ?').get(serializeContextNamespace(namespace)) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    namespace,
    lastReplicatedAt: typeof row.last_replicated_at === 'number' ? row.last_replicated_at : undefined,
    pendingProjectionIds: parseJson<string[]>(row.pending_projection_ids_json, []),
    lastError: typeof row.last_error === 'string' ? row.last_error : undefined,
  };
}

export function listReplicationStates(): ContextReplicationState[] {
  const database = ensureDb();
  const rows = database.prepare('SELECT * FROM context_replication_state ORDER BY namespace_key ASC').all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    return {
      namespace,
      lastReplicatedAt: typeof row.last_replicated_at === 'number' ? row.last_replicated_at : undefined,
      pendingProjectionIds: parseJson<string[]>(row.pending_projection_ids_json, []),
      lastError: typeof row.last_error === 'string' ? row.last_error : undefined,
    };
  });
}

export function clearDirtyTarget(target: ContextTargetRef): void {
  const database = ensureDb();
  database.prepare('DELETE FROM context_dirty_targets WHERE target_key = ?').run(serializeContextTarget(target));
}

function mapJobRecord(row: Record<string, unknown>, namespace: ContextNamespace): ContextJobRecord {
  return {
    id: String(row.id),
    target: decodeTarget(row, namespace),
    jobType: String(row.job_type) as ContextJobType,
    trigger: String(row.trigger) as ContextJobTrigger,
    status: String(row.status) as ContextJobStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    attemptCount: Number(row.attempt_count),
    error: typeof row.error === 'string' ? row.error : undefined,
  };
}

function parseNamespaceKey(namespaceKey: string): ContextNamespace {
  const [scope, enterpriseId, workspaceId, userId, projectId] = namespaceKey.split('::');
  return {
    scope: scope as ContextNamespace['scope'],
    enterpriseId: enterpriseId || undefined,
    workspaceId: workspaceId || undefined,
    userId: userId || undefined,
    projectId,
  };
}
