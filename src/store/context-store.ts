import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
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
  ContextMemoryProjectView,
  LocalContextEvent,
  ProcessedContextProjection,
  ProcessedContextClass,
  ProcessedContextProjectionStatus,
  ContextScope,
} from '../../shared/context-types.js';
import { classifyTimestampFreshness } from '../../shared/context-freshness.js';
import { serializeContextNamespace, serializeContextTarget } from '../context/context-keys.js';
import { isMemoryNoiseSummary } from '../../shared/memory-noise-patterns.js';
import { computeFingerprint, normalizeSummaryForFingerprint } from '../../shared/memory-fingerprint.js';
import { memoryTextMatchesQuery } from '../../shared/memory-search-text.js';
import { countTokens } from '../context/tokenizer.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';
import { mergeSourceIds } from './source-id-merge.js';
import { computeProjectionContentHash, projectionSemanticContent } from '../../shared/memory-content-hash.js';
import {
  isMemoryScope,
  isOwnerPrivateMemoryScope,
  isSharedProjectionScope,
  type MemoryScope,
  canPromoteMemoryScope,
} from '../../shared/memory-scope.js';
import {
  contextNamespaceToBinding,
  createContextNamespaceBinding,
  LEGACY_DAEMON_LOCAL_USER_ID,
  parseNamespaceKey,
  type CanonicalNamespaceInput,
  type ContextNamespaceBinding,
} from '../../shared/memory-namespace.js';
// Re-export relocated runtime values so existing importers keep resolving them
// from `context-store.js`. Definitions now live in `shared/memory-namespace.ts`.
export { LEGACY_DAEMON_LOCAL_USER_ID, parseNamespaceKey } from '../../shared/memory-namespace.js';
import {
  assertValidObservationInput,
  isObservationClass,
  isObservationState,
  normalizeObservationText,
  normalizeObservationSourceIds,
  type ContextObservationInput,
  type ObservationClass,
  type ObservationState,
} from '../../shared/memory-observation.js';
import { isMemoryOrigin, requireExplicitMemoryOrigin, type MemoryOrigin } from '../../shared/memory-origin.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';
import {
  USAGE_ANALYTICS_SCHEMA_VERSION,
  USAGE_FACT_STATUSES,
  USAGE_SYNC_STATUSES,
  computeTotalTokens,
  createCanonicalUsagePayloadHash,
  normalizeCostUsdMicros,
  type UsageFact,
  type UsageFactStatus,
  type UsageMetadataCompleteness,
  type UsagePrivacySafeDiagnostics,
  type UsageSessionKind,
  type UsageSyncStatus,
} from '../../shared/usage-analytics.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
export type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'shared-agent-context.sqlite');
const DEFAULT_LOCAL_PROCESSED_FRESH_MS = 6 * 60 * 60 * 1000;

let db: DatabaseSyncInstance | null = null;
let currentDbPath: string | null = null;
let stagedReconciledForPath: string | null = null;
let materializationRepairRanForPath: string | null = null;
let archiveBackfillTimer: ReturnType<typeof setTimeout> | null = null;
let archiveBackfillScheduledForPath: string | null = null;
// Whether THIS module instance may schedule the archive-backfill timer. Default
// enabled so tests, the CLI, and the context-store worker run it. The daemon
// MAIN thread disables it once it spawns the context-store worker, so the
// backfill runs EXCLUSIVELY in the worker (the single long-lived owner) and the
// main-thread connection never schedules it.
// The scheduling flag now lives in a no-DB module (`archive-backfill-scheduling`)
// so the daemon main thread can toggle it WITHOUT importing this synchronous
// store (task 4.5 import guard). Imported here for the `ensureDb` check + reset,
// and re-exported for back-compat with existing importers (tests).
import {
  isArchiveBackfillSchedulingEnabled,
  resetArchiveBackfillSchedulingForTests,
} from './archive-backfill-scheduling.js';
export { setArchiveBackfillSchedulingEnabled } from './archive-backfill-scheduling.js';

function getDbPath(): string {
  return process.env.IMCODES_CONTEXT_DB_PATH?.trim() || DEFAULT_DB_PATH;
}


export const CONTEXT_META_SENTINELS = [
  'migration_archive_backfilled',
  'migration_fingerprint_backfilled_at',
  'last_archive_sweep_at',
  'fts_backfilled',
  'fts_tokenizer',
  'migration_archive_backfill_cursor',
  'last_materialization_repair_at',
  'migration_namespace_observation_backfilled',
  'last_observation_repair_at',
  'migration_namespace_filter_columns_backfilled',
  'usage_authority_id',
] as const;

export function tryAlter(database: DatabaseSyncInstance, sql: string): boolean {
  try {
    database.exec(sql);
    return true;
  } catch {
    return false;
  }
}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, end - Date.now()));
}

function internalGetContextMeta(database: DatabaseSyncInstance, key: string): string | undefined {
  const row = database.prepare('SELECT value FROM context_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return typeof row?.value === 'string' ? row.value : undefined;
}

function internalSetContextMeta(database: DatabaseSyncInstance, key: string, value: string, now = Date.now()): void {
  database.prepare(`
    INSERT INTO context_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

function getLocalProcessedFreshMs(): number {
  const raw = process.env.IMCODES_LOCAL_PROCESSED_FRESH_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOCAL_PROCESSED_FRESH_MS;
}

interface NamespaceFilterColumns {
  scope: string;
  enterpriseId: string | null;
  workspaceId: string | null;
  userId: string | null;
  projectId: string | null;
}

function nullableNamespacePart(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function namespaceFilterColumns(namespace: ContextNamespace): NamespaceFilterColumns {
  return {
    scope: namespace.scope,
    enterpriseId: nullableNamespacePart(namespace.enterpriseId),
    workspaceId: nullableNamespacePart(namespace.workspaceId),
    userId: nullableNamespacePart(namespace.userId),
    projectId: nullableNamespacePart(namespace.projectId),
  };
}

function namespaceFilterColumnValues(namespace: ContextNamespace): [string, string | null, string | null, string | null, string | null] {
  const columns = namespaceFilterColumns(namespace);
  return [columns.scope, columns.enterpriseId, columns.workspaceId, columns.userId, columns.projectId];
}

function appendNamespaceFilterSql(
  conditions: string[],
  params: (string | number)[],
  filters: Pick<ProcessedProjectionQuery, 'scope' | 'enterpriseId' | 'workspaceId' | 'userId' | 'projectId' | 'includeLegacyPersonalOwner'>,
): void {
  if (hasFilterValue(filters.scope)) {
    conditions.push('scope = ?');
    params.push(filters.scope);
  }
  if (hasFilterValue(filters.enterpriseId)) {
    conditions.push('enterprise_id = ?');
    params.push(filters.enterpriseId);
  }
  if (hasFilterValue(filters.workspaceId)) {
    conditions.push('workspace_id = ?');
    params.push(filters.workspaceId);
  }
  if (hasFilterValue(filters.userId)) {
    if (filters.includeLegacyPersonalOwner && (!hasFilterValue(filters.scope) || filters.scope === 'personal')) {
      conditions.push("(user_id = ? OR user_id IS NULL OR TRIM(user_id) = '' OR user_id = ?)");
      params.push(filters.userId, LEGACY_DAEMON_LOCAL_USER_ID);
    } else {
      conditions.push('user_id = ?');
      params.push(filters.userId);
    }
  } else if (filters.userId !== undefined) {
    conditions.push("user_id = '__imcodes_empty_user_filter_never_matches__'");
  }
  if (hasFilterValue(filters.projectId)) {
    conditions.push('project_id = ?');
    params.push(filters.projectId);
  } else if (filters.projectId !== undefined) {
    conditions.push("project_id = '__imcodes_empty_project_filter_never_matches__'");
  }
}

function hasFilterValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isLegacyPersonalOwner(userId: string | undefined): boolean {
  return !userId?.trim() || userId === LEGACY_DAEMON_LOCAL_USER_ID;
}

function namespaceMatchesFilters(
  namespace: ContextNamespace,
  filters: Pick<ProcessedProjectionQuery, 'scope' | 'enterpriseId' | 'workspaceId' | 'userId' | 'projectId' | 'includeLegacyPersonalOwner'>,
): boolean {
  if (hasFilterValue(filters.scope) && namespace.scope !== filters.scope) return false;
  if (hasFilterValue(filters.enterpriseId) && namespace.enterpriseId !== filters.enterpriseId) return false;
  if (hasFilterValue(filters.workspaceId) && namespace.workspaceId !== filters.workspaceId) return false;
  if (filters.userId !== undefined) {
    if (!hasFilterValue(filters.userId)) return false;
    if (namespace.userId !== filters.userId) {
      if (!(filters.includeLegacyPersonalOwner && namespace.scope === 'personal' && isLegacyPersonalOwner(namespace.userId))) {
        return false;
      }
    }
  }
  if (filters.projectId !== undefined) {
    if (!hasFilterValue(filters.projectId)) return false;
    if (namespace.projectId !== filters.projectId) return false;
  }
  return true;
}

function backfillNamespaceFilterColumnsForTable(
  database: DatabaseSyncInstance,
  table: 'context_staged_events' | 'context_dirty_targets' | 'context_jobs' | 'context_processed_local',
  idColumn: 'id' | 'target_key',
): number {
  const rows = database.prepare(`
    SELECT ${idColumn} AS row_id, namespace_key
    FROM ${table}
    WHERE scope IS NULL
       OR scope = ''
  `).all() as Array<{ row_id: string; namespace_key: string }>;
  if (rows.length === 0) return 0;
  const update = database.prepare(`
    UPDATE ${table}
    SET scope = ?,
        enterprise_id = ?,
        workspace_id = ?,
        user_id = ?,
        project_id = ?
    WHERE ${idColumn} = ?
  `);
  let updated = 0;
  for (const row of rows) {
    const values = namespaceFilterColumnValues(parseNamespaceKey(String(row.namespace_key)));
    const result = update.run(...values, String(row.row_id)) as { changes?: number };
    updated += result.changes ?? 0;
  }
  return updated;
}

function backfillNamespaceFilterColumnsForDb(database: DatabaseSyncInstance): void {
  try {
    database.exec('BEGIN IMMEDIATE');
    const updated =
      backfillNamespaceFilterColumnsForTable(database, 'context_staged_events', 'id') +
      backfillNamespaceFilterColumnsForTable(database, 'context_dirty_targets', 'target_key') +
      backfillNamespaceFilterColumnsForTable(database, 'context_jobs', 'id') +
      backfillNamespaceFilterColumnsForTable(database, 'context_processed_local', 'id');
    if (updated > 0) {
      internalSetContextMeta(database, 'migration_namespace_filter_columns_backfilled', String(Date.now()));
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    incrementCounter('mem.startup.silent_failure', { source: 'namespace-filter-column-backfill' });
    warnOncePerHour('mem.startup.silent_failure.namespace-filter-column-backfill', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function ensureDb(): DatabaseSyncInstance {
  const dbPath = getDbPath();
  if (db && currentDbPath === dbPath) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  currentDbPath = dbPath;
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 1000;
    CREATE TABLE IF NOT EXISTS context_staged_events (
      id TEXT PRIMARY KEY,
      namespace_key TEXT NOT NULL,
      scope TEXT,
      enterprise_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      project_id TEXT,
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
      scope TEXT,
      enterprise_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      project_id TEXT,
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
      scope TEXT,
      enterprise_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      project_id TEXT,
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
      scope TEXT,
      enterprise_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      project_id TEXT,
      class TEXT NOT NULL,
      source_event_ids_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      content_json TEXT NOT NULL,
      content_hash TEXT,
      origin TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      summary_fingerprint TEXT,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      -- Normalized feature-extraction embedding of the summary, encoded as
      -- little-endian Float32 bytes. NULL when the model was unavailable at
      -- write time; recall lazy-fills these on first read.
      embedding BLOB,
      -- Source text used to compute the embedding — comparing against this
      -- tells us whether the stored blob is still current when the summary
      -- gets edited.
      embedding_source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_context_processed_local_namespace
      ON context_processed_local(namespace_key, class, updated_at DESC);

    CREATE TABLE IF NOT EXISTS context_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_event_archive (
      id TEXT PRIMARY KEY,
      namespace_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      token_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_archive_target_created
      ON context_event_archive(target_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_archive_archived_at
      ON context_event_archive(archived_at);

    CREATE TABLE IF NOT EXISTS context_projection_sources (
      projection_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (projection_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cps_event ON context_projection_sources(event_id);

    CREATE TABLE IF NOT EXISTS context_pinned_notes (
      id TEXT PRIMARY KEY,
      namespace_key TEXT NOT NULL,
      content TEXT NOT NULL,
      origin TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pinned_namespace ON context_pinned_notes(namespace_key);

    CREATE TABLE IF NOT EXISTS context_replication_state (
      namespace_key TEXT PRIMARY KEY,
      pending_projection_ids_json TEXT NOT NULL,
      last_replicated_at INTEGER,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS context_namespaces (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      local_tenant TEXT NOT NULL,
      scope TEXT NOT NULL,
      user_id TEXT,
      root_session_id TEXT,
      session_tree_id TEXT,
      session_id TEXT,
      workspace_id TEXT,
      project_id TEXT,
      org_id TEXT,
      key TEXT NOT NULL,
      visibility TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (scope IN ('user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_context_namespaces_tenant_scope_key
      ON context_namespaces(local_tenant, scope, key);
    CREATE INDEX IF NOT EXISTS idx_context_namespaces_lookup
      ON context_namespaces(local_tenant, scope, user_id, project_id, workspace_id, org_id);
    CREATE INDEX IF NOT EXISTS idx_context_namespaces_session_tree
      ON context_namespaces(root_session_id, session_tree_id, session_id);

    CREATE TABLE IF NOT EXISTS context_observations (
      id TEXT PRIMARY KEY,
      namespace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      class TEXT NOT NULL,
      origin TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      content_json TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      source_event_ids_json TEXT NOT NULL,
      projection_id TEXT,
      state TEXT NOT NULL,
      confidence REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      promoted_at INTEGER,
      CHECK (scope IN ('user_private', 'personal', 'project_shared', 'workspace_shared', 'org_shared')),
      CHECK (class IN ('fact', 'decision', 'bugfix', 'feature', 'refactor', 'discovery', 'preference', 'skill_candidate', 'workflow', 'code_pattern', 'note')),
      CHECK (origin IN ('chat_compacted', 'user_note', 'skill_import', 'manual_pin', 'agent_learned', 'md_ingest')),
      FOREIGN KEY(namespace_id) REFERENCES context_namespaces(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_context_observations_idempotency
      ON context_observations(namespace_id, class, fingerprint, text_hash);
    CREATE INDEX IF NOT EXISTS idx_context_observations_projection
      ON context_observations(projection_id);
    CREATE INDEX IF NOT EXISTS idx_context_observations_scope_state
      ON context_observations(scope, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_observations_namespace_state
      ON context_observations(namespace_id, state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS observation_promotion_audit (
      id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_scope TEXT NOT NULL,
      to_scope TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(observation_id) REFERENCES context_observations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_observation_promotion_audit_observation
      ON observation_promotion_audit(observation_id, created_at);

    -- ── Compression runs — telemetry for memory-compression cost analysis ──
    --
    -- One row per call to compressWithSdk(). Persists which model/backend was
    -- used, how many tokens were spent, and how long it took, so operators can
    -- query later: "which sessions burn the most input tokens", "is qwen3
    -- producing materially shorter outputs than claude-sonnet", "how often
    -- does primary fail-over to backup", etc. Row insert is best-effort —
    -- a recording failure must never block compression itself.
    --
    -- Retention is governed by the same archiveRetentionDays config knob as
    -- the event archive; -1 keeps forever.
    CREATE TABLE IF NOT EXISTS context_compression_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      INTEGER NOT NULL,
      backend         TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      used_backup     INTEGER NOT NULL,
      from_sdk        INTEGER NOT NULL,
      namespace_key   TEXT,
      target_kind     TEXT,
      session_name    TEXT,
      trigger         TEXT,
      mode            TEXT,
      event_count     INTEGER NOT NULL,
      input_tokens    INTEGER NOT NULL,
      output_tokens   INTEGER NOT NULL,
      target_tokens   INTEGER NOT NULL,
      duration_ms     INTEGER NOT NULL,
      outcome         TEXT    NOT NULL,
      error_code      TEXT,
      error_message   TEXT,
      projection_id   TEXT,
      CHECK (outcome IN ('success', 'fallback', 'admission_closed', 'error', 'noop'))
    );
    CREATE INDEX IF NOT EXISTS idx_compression_runs_created
      ON context_compression_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compression_runs_backend_created
      ON context_compression_runs(backend, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compression_runs_namespace_created
      ON context_compression_runs(namespace_key, created_at DESC);

    -- Per-turn SDK token usage telemetry. Every time a transport provider
    -- emits a usage.update timeline event with token data, the emitter writes
    -- a row here. Inserts are best-effort: a recording failure MUST NOT
    -- escape the timeline emit hot path. Retention follows the same
    -- archiveRetentionDays as the event archive.
    CREATE TABLE IF NOT EXISTS context_turn_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      INTEGER NOT NULL,
      session_name    TEXT    NOT NULL,
      agent_type      TEXT,
      model           TEXT,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      context_window  INTEGER,
      cost_usd        REAL
    );
    CREATE INDEX IF NOT EXISTS idx_turn_usage_created
      ON context_turn_usage(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_turn_usage_session_created
      ON context_turn_usage(session_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_turn_usage_agent_model_created
      ON context_turn_usage(agent_type, model, created_at DESC);

    CREATE TABLE IF NOT EXISTS context_turn_usage_sync (
      turn_usage_rowid      INTEGER PRIMARY KEY REFERENCES context_turn_usage(id) ON DELETE CASCADE,
      usage_authority_id    TEXT    NOT NULL,
      usage_fact_id         TEXT    NOT NULL,
      payload_hash          TEXT    NOT NULL,
      sync_status           TEXT    NOT NULL,
      retry_count           INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms    INTEGER,
      last_attempt_at_ms    INTEGER,
      synced_at_ms          INTEGER,
      last_error_reason     TEXT,
      terminal_reason       TEXT,
      metadata_completeness TEXT    NOT NULL,
      created_at_ms         INTEGER NOT NULL,
      updated_at_ms         INTEGER NOT NULL,
      CHECK (sync_status IN (
        'pending',
        'retryable_failed',
        'in_flight',
        'accepted',
        'duplicate',
        'conflict_terminal',
        'invalid_terminal',
        'too_old_terminal',
        'clock_skew_terminal',
        'local_pruned_unsynced'
      )),
      CHECK (metadata_completeness IN ('complete', 'partial'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_turn_usage_sync_fact
      ON context_turn_usage_sync(usage_authority_id, usage_fact_id);
    CREATE INDEX IF NOT EXISTS idx_turn_usage_sync_status_attempt
      ON context_turn_usage_sync(sync_status, next_attempt_at_ms, created_at_ms);
  `);
  // Round-2 audit (0699ea64-3e6 finding A1): every daemon restart re-emits
  // historical `usage.update` events from JSONL replay (gemini-watcher's
  // deterministic stableId AND jsonl-watcher's final-usage emit). Without a
  // unique key on event_id, recordTurnUsage inflates SUM(input_tokens) by N×
  // every restart. Partial index excludes legacy rows (event_id IS NULL) so
  // the migration is idempotent on existing databases.
  tryAlter(db, 'ALTER TABLE context_turn_usage ADD COLUMN event_id TEXT');
  tryAlter(db, 'ALTER TABLE context_turn_usage ADD COLUMN provider TEXT');
  tryAlter(db, "ALTER TABLE context_turn_usage ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'main'");
  tryAlter(db, 'ALTER TABLE context_turn_usage ADD COLUMN parent_session_name TEXT');
  tryAlter(db, "ALTER TABLE context_turn_usage ADD COLUMN metadata_completeness TEXT NOT NULL DEFAULT 'partial'");
  tryAlter(db, 'ALTER TABLE context_turn_usage ADD COLUMN cost_usd_micros INTEGER');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_turn_usage_event ON context_turn_usage(session_name, event_id) WHERE event_id IS NOT NULL'
  );
  // Migrate existing DBs — add columns if missing
  tryAlter(db, 'ALTER TABLE context_processed_local ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0');
  tryAlter(db, 'ALTER TABLE context_processed_local ADD COLUMN last_used_at INTEGER');
  tryAlter(db, "ALTER TABLE context_processed_local ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  tryAlter(db, 'ALTER TABLE context_processed_local ADD COLUMN embedding BLOB');
  tryAlter(db, 'ALTER TABLE context_processed_local ADD COLUMN embedding_source TEXT');
  tryAlter(db, 'ALTER TABLE context_processed_local ADD COLUMN summary_fingerprint TEXT');
  tryAlter(db, 'ALTER TABLE context_processed_local ADD COLUMN content_hash TEXT');
  tryAlter(db, 'ALTER TABLE context_processed_local ADD COLUMN origin TEXT');
  for (const table of ['context_staged_events', 'context_dirty_targets', 'context_jobs', 'context_processed_local']) {
    tryAlter(db, `ALTER TABLE ${table} ADD COLUMN scope TEXT`);
    tryAlter(db, `ALTER TABLE ${table} ADD COLUMN enterprise_id TEXT`);
    tryAlter(db, `ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
    tryAlter(db, `ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
    tryAlter(db, `ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_proj_fp ON context_processed_local(namespace_key, class, summary_fingerprint) WHERE summary_fingerprint IS NOT NULL');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_processed_local_scope_project
      ON context_processed_local(scope, project_id, status, class, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_processed_local_scope_owner_project
      ON context_processed_local(scope, user_id, project_id, status, class, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_processed_local_project
      ON context_processed_local(project_id, status, class, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_staged_events_scope_project
      ON context_staged_events(scope, project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_staged_events_scope_owner_project
      ON context_staged_events(scope, user_id, project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_staged_events_project_created
      ON context_staged_events(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_staged_events_namespace_created
      ON context_staged_events(namespace_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_dirty_targets_scope_project
      ON context_dirty_targets(scope, project_id, newest_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_dirty_targets_scope_owner_project
      ON context_dirty_targets(scope, user_id, project_id, newest_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_dirty_targets_project_newest
      ON context_dirty_targets(project_id, newest_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_dirty_targets_namespace_newest
      ON context_dirty_targets(namespace_key, newest_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_jobs_status_scope_project
      ON context_jobs(status, scope, project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_context_jobs_status_scope_owner_project
      ON context_jobs(status, scope, user_id, project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_context_jobs_status_project_created
      ON context_jobs(status, project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_context_jobs_namespace_status_created
      ON context_jobs(namespace_key, status, created_at);
  `);
  backfillNamespaceFilterColumnsForDb(db);
  // FTS5 setup MUST NOT crash daemon startup. `setupArchiveFts` already
  // detects unavailable FTS5 (e.g. Node 23.11.0's built-in SQLite) and
  // skips the virtual table + triggers when so. This outer try-catch is
  // defense-in-depth so any unforeseen exception (driver mismatch, perms,
  // disk pressure during virtual-table creation) leaves the daemon in a
  // working state rather than degraded with no server connection.
  // The chat_search_fts read tool falls back to bounded LIKE in this case.
  try {
    setupArchiveFts(db);
  } catch (error) {
    incrementCounter('mem.archive_fts.unavailable', { source: 'setupArchiveFts.outer' });
    warnOncePerHour('mem.archive_fts.unavailable', {
      reason: 'setupArchiveFts threw at startup; daemon continues without FTS index',
      error: error instanceof Error ? error.message : String(error),
    });
    try { internalSetContextMeta(db, 'fts_tokenizer', 'unavailable'); } catch { /* ignore */ }
  }
  if (stagedReconciledForPath !== dbPath) {
    reconcileMaterializedStagedEvents(db);
    purgeMemoryNoiseProjections(db);
    stagedReconciledForPath = dbPath;
  }
  if (materializationRepairRanForPath !== dbPath) {
    repairMaterializationStateForDb(db, { now: Date.now() });
    materializationRepairRanForPath = dbPath;
  }
  scheduleArchiveBackfillIfNeeded(db, dbPath);
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

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function canonicalScopeFromNamespace(namespace: ContextNamespace): MemoryScope {
  const scope = namespace.scope as string;
  if (isMemoryScope(scope)) return scope;
  return 'personal';
}

function canPromoteScope(fromScope: MemoryScope, toScope: MemoryScope, explicitAuthorizedAction: boolean): boolean {
  if (
    isOwnerPrivateMemoryScope(fromScope)
    && isSharedProjectionScope(toScope)
    && !explicitAuthorizedAction
  ) {
    return false;
  }
  return canPromoteMemoryScope(fromScope, toScope);
}

function canonicalizeContextNamespace(namespace: ContextNamespace): ContextNamespace {
  if (namespace.scope === 'personal' && !namespace.userId?.trim()) {
    return namespace;
  }
  const binding = contextNamespaceToBinding(namespace);
  return {
    scope: binding.scope as ContextNamespace['scope'],
    projectId: binding.projectId ?? '',
    userId: binding.userId,
    workspaceId: binding.workspaceId,
    enterpriseId: binding.orgId,
  };
}

function namespaceBindingId(binding: Pick<ContextNamespaceBinding, 'localTenant' | 'scope' | 'key'>): string {
  return computeFingerprint(`ctxns:v1:${binding.localTenant}:${binding.scope}:${binding.key}`);
}

function observationIdFor(namespaceId: string, observationClass: ObservationClass, fingerprint: string, textHash: string): string {
  return computeFingerprint(`ctxobs:v1:${namespaceId}:${observationClass}:${fingerprint}:${textHash}`);
}

function computeObservationTextHash(text: string): string {
  return `sha256:${computeFingerprint(normalizeObservationText(text))}`;
}

function normalizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function metadataUserId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function applyImplicitOwnerMetadata(namespace: ContextNamespace, content: Record<string, unknown>): Record<string, unknown> {
  if (!isOwnerPrivateMemoryScope(namespace.scope)) return content;
  const ownerUserId = metadataUserId(namespace.userId);
  if (!ownerUserId) return content;
  return {
    ...content,
    ownerUserId: metadataUserId(content.ownerUserId) ?? metadataUserId(content.ownedByUserId) ?? ownerUserId,
    createdByUserId: metadataUserId(content.createdByUserId) ?? metadataUserId(content.authorUserId) ?? ownerUserId,
    updatedByUserId: metadataUserId(content.updatedByUserId) ?? metadataUserId(content.createdByUserId) ?? metadataUserId(content.authorUserId) ?? ownerUserId,
  };
}

function isCanonicalNamespaceInput(input: CanonicalNamespaceInput | ContextNamespace): input is CanonicalNamespaceInput {
  return input.scope === 'user_private'
    || 'canonicalRepoId' in input
    || 'localTenant' in input
    || 'tenantId' in input
    || 'key' in input
    || 'visibility' in input
    || 'orgId' in input
    || 'rootSessionId' in input
    || 'sessionTreeId' in input
    || 'sessionId' in input
    || 'name' in input;
}

function contextNamespaceToStoreBinding(namespace: ContextNamespace): ContextNamespaceBinding {
  return createContextNamespaceBinding({
    scope: namespace.scope as MemoryScope,
    userId: namespace.userId ?? (namespace.scope === 'personal' ? LEGACY_DAEMON_LOCAL_USER_ID : undefined),
    workspaceId: namespace.workspaceId,
    projectId: namespace.projectId,
    orgId: namespace.enterpriseId,
    enterpriseId: namespace.enterpriseId,
  });
}

function ensureContextNamespaceForDb(
  database: DatabaseSyncInstance,
  input: CanonicalNamespaceInput | ContextNamespace,
  now = Date.now(),
): ContextNamespaceRow {
  const binding = isCanonicalNamespaceInput(input)
    ? createContextNamespaceBinding(input)
    : contextNamespaceToStoreBinding(input as ContextNamespace);
  const id = namespaceBindingId(binding);
  database.prepare(`
    INSERT INTO context_namespaces (
      id, tenant_id, local_tenant, scope, user_id, root_session_id, session_tree_id,
      session_id, workspace_id, project_id, org_id, key, visibility, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_tenant, scope, key) DO UPDATE SET
      user_id = excluded.user_id,
      root_session_id = excluded.root_session_id,
      session_tree_id = excluded.session_tree_id,
      session_id = excluded.session_id,
      workspace_id = excluded.workspace_id,
      project_id = excluded.project_id,
      org_id = excluded.org_id,
      visibility = excluded.visibility,
      updated_at = excluded.updated_at
  `).run(
    id,
    binding.localTenant,
    binding.scope,
    normalizeOptional(binding.userId),
    normalizeOptional(binding.rootSessionId),
    normalizeOptional(binding.sessionTreeId),
    normalizeOptional(binding.sessionId),
    normalizeOptional(binding.workspaceId),
    normalizeOptional(binding.projectId),
    normalizeOptional(binding.orgId),
    binding.key,
    binding.visibility,
    now,
    now,
  );
  const row = database.prepare('SELECT * FROM context_namespaces WHERE local_tenant = ? AND scope = ? AND key = ?')
    .get(binding.localTenant, binding.scope, binding.key) as Record<string, unknown> | undefined;
  if (!row) throw new Error('failed to create context namespace');
  return namespaceRowFromDb(row);
}

function inferObservationClass(content: Record<string, unknown>, projectionClass?: ProcessedContextClass): ObservationClass {
  const explicit = content.observationClass ?? content.memoryClass;
  if (isObservationClass(explicit)) return explicit;
  if (projectionClass === 'durable_memory_candidate') return 'note';
  if (projectionClass === 'master_summary') return 'workflow';
  return 'note';
}

function inferObservationOrigin(content: Record<string, unknown>, fallback: MemoryOrigin): MemoryOrigin {
  const explicit = content.origin ?? content.memoryOrigin;
  return explicit == null ? fallback : requireExplicitMemoryOrigin(explicit, 'observation');
}

function projectionOriginForInput(input: { origin?: MemoryOrigin; content: Record<string, unknown> }): MemoryOrigin {
  return input.origin ?? inferObservationOrigin(input.content, 'chat_compacted');
}

function upsertContextObservationForDb(database: DatabaseSyncInstance, input: ContextObservationInput): ContextObservationRow {
  assertValidObservationInput(input);
  if (!isMemoryScope(input.scope)) throw new Error(`invalid observation scope: ${String(input.scope)}`);
  const namespaceScopeRow = database.prepare('SELECT scope, user_id, project_id, workspace_id, org_id FROM context_namespaces WHERE id = ?')
    .get(input.namespaceId) as { scope: string; user_id?: string | null; project_id?: string | null; workspace_id?: string | null; org_id?: string | null } | undefined;
  if (!namespaceScopeRow) throw new Error(`namespace not found for observation: ${input.namespaceId}`);
  if (namespaceScopeRow.scope !== input.scope) {
    throw new Error(`observation scope ${input.scope} does not match namespace scope ${namespaceScopeRow.scope}`);
  }
  const observationNamespace: ContextNamespace = {
    scope: input.scope,
    userId: typeof namespaceScopeRow.user_id === 'string' ? namespaceScopeRow.user_id : undefined,
    projectId: typeof namespaceScopeRow.project_id === 'string' ? namespaceScopeRow.project_id : undefined,
    workspaceId: typeof namespaceScopeRow.workspace_id === 'string' ? namespaceScopeRow.workspace_id : undefined,
    enterpriseId: typeof namespaceScopeRow.org_id === 'string' ? namespaceScopeRow.org_id : undefined,
  };
  const contentForDb = applyImplicitOwnerMetadata(observationNamespace, input.content);
  const now = input.now ?? Date.now();
  const sourceEventIds = normalizeObservationSourceIds(input.sourceEventIds);
  const textHash = input.textHash ?? computeObservationTextHash(input.text ?? JSON.stringify(contentForDb));
  const id = input.id ?? observationIdFor(input.namespaceId, input.class, input.fingerprint, textHash);
  const prior = database.prepare(`
    SELECT id, source_event_ids_json, created_at, projection_id, state
    FROM context_observations
    WHERE namespace_id = ? AND class = ? AND fingerprint = ? AND text_hash = ?
    LIMIT 1
  `).get(input.namespaceId, input.class, input.fingerprint, textHash) as
    | { id: string; source_event_ids_json: string; created_at: number; projection_id: string | null; state: string }
    | undefined;
  const mergedSourceIds = mergeSourceIds(parseJson<string[]>(prior?.source_event_ids_json, []), sourceEventIds);
  const state = input.state ?? (prior?.state as ObservationState | undefined) ?? 'active';
  database.prepare(`
    INSERT INTO context_observations (
      id, namespace_id, scope, class, origin, fingerprint, content_json, text_hash,
      source_event_ids_json, projection_id, state, confidence, created_at, updated_at, promoted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(namespace_id, class, fingerprint, text_hash) DO UPDATE SET
      scope = excluded.scope,
      origin = excluded.origin,
      content_json = excluded.content_json,
      source_event_ids_json = excluded.source_event_ids_json,
      projection_id = COALESCE(excluded.projection_id, context_observations.projection_id),
      state = excluded.state,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `).run(
    prior?.id ?? id,
    input.namespaceId,
    input.scope,
    input.class,
    input.origin,
    input.fingerprint,
    JSON.stringify(contentForDb),
    textHash,
    JSON.stringify(mergedSourceIds),
    input.projectionId ?? prior?.projection_id ?? null,
    state,
    input.confidence ?? null,
    prior?.created_at ?? now,
    now,
  );
  const row = database.prepare('SELECT * FROM context_observations WHERE namespace_id = ? AND class = ? AND fingerprint = ? AND text_hash = ?')
    .get(input.namespaceId, input.class, input.fingerprint, textHash) as Record<string, unknown> | undefined;
  if (!row) throw new Error('failed to upsert context observation');
  return observationRowFromDb(row);
}

function upsertProjectionObservationForDb(
  database: DatabaseSyncInstance,
  input: {
    namespace: ContextNamespace;
    projectionId: string;
    projectionClass: ProcessedContextClass;
    sourceEventIds: readonly string[];
    summary: string;
    content: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
    fingerprint: string;
    origin: MemoryOrigin;
  },
): ContextObservationRow {
  const namespace = ensureContextNamespaceForDb(database, input.namespace, input.updatedAt);
  const observationClass = inferObservationClass(input.content, input.projectionClass);
  const provenanceFingerprint = typeof input.content.provenanceFingerprint === 'string' && input.content.provenanceFingerprint.trim()
    ? computeFingerprint(input.content.provenanceFingerprint.trim())
    : input.fingerprint;
  return upsertContextObservationForDb(database, {
    namespaceId: namespace.id,
    scope: canonicalScopeFromNamespace(input.namespace),
    class: observationClass,
    origin: input.origin,
    fingerprint: provenanceFingerprint,
    content: {
      ...input.content,
      text: typeof input.content.text === 'string' ? input.content.text : input.summary,
      projectionClass: input.projectionClass,
    },
    text: input.summary,
    sourceEventIds: [...input.sourceEventIds],
    projectionId: input.projectionId,
    state: 'active',
    now: input.updatedAt,
  });
}


export function getContextMeta(key: string): string | undefined {
  return internalGetContextMeta(ensureDb(), key);
}

export function setContextMeta(key: string, value: string): void {
  internalSetContextMeta(ensureDb(), key, value);
}

/** WAL byte size above which an idle checkpoint escalates from PASSIVE to
 *  TRUNCATE. TRUNCATE only actually shrinks the WAL file once the context-store
 *  worker is the single long-lived connection (see the design's WAL-scope
 *  coupling); while other connections still hold locks it is best-effort. */
export const WAL_TRUNCATE_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** Resolve the WAL TRUNCATE threshold, allowing a test/ops override via
 *  `IMCODES_CONTEXT_WAL_TRUNCATE_BYTES` (default {@link WAL_TRUNCATE_THRESHOLD_BYTES}). */
function walTruncateThresholdBytes(): number {
  const raw = process.env.IMCODES_CONTEXT_WAL_TRUNCATE_BYTES?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return WAL_TRUNCATE_THRESHOLD_BYTES;
}

export type WalCheckpointMode = 'PASSIVE' | 'TRUNCATE';

export interface WalCheckpointResult {
  mode: WalCheckpointMode;
  /** WAL file size in bytes observed immediately before the checkpoint. */
  walBytesBefore: number;
  /** WAL file size in bytes observed immediately after the checkpoint. */
  walBytesAfter: number;
}

/** Run a WAL checkpoint on the context store. Defaults to a steady-state
 *  PASSIVE checkpoint and escalates to TRUNCATE only when the WAL has grown past
 *  {@link WAL_TRUNCATE_THRESHOLD_BYTES}. This is intended to be called ONLY from
 *  the context-store worker (the daemon main thread must never checkpoint). */
export function checkpointWal(): WalCheckpointResult {
  const database = ensureDb();
  const walPath = `${currentDbPath ?? getDbPath()}-wal`;
  const walBytes = (): number => {
    try {
      return statSync(walPath).size;
    } catch {
      return 0;
    }
  };
  const walBytesBefore = walBytes();
  const mode: WalCheckpointMode =
    walBytesBefore > walTruncateThresholdBytes() ? 'TRUNCATE' : 'PASSIVE';
  // node:sqlite has no parameter binding for PRAGMA; mode is a fixed literal
  // from the union above, never user input.
  database.exec(`PRAGMA wal_checkpoint(${mode});`);
  return { mode, walBytesBefore, walBytesAfter: walBytes() };
}

function projectionFingerprint(summary: string): string {
  return computeFingerprint(normalizeSummaryForFingerprint(summary));
}

function projectionContentHash(summary: string, content: unknown): string {
  return computeProjectionContentHash({ summary, content });
}

const ARCHIVE_BACKFILL_BATCH_SIZE = 1000;
const ARCHIVE_BACKFILL_CURSOR_KEY = 'migration_archive_backfill_cursor';

type ArchiveBackfillCursor = { updatedAt: number; id: string };

interface ArchiveBackfillRow {
  id: string;
  namespace_key: string;
  class: string;
  source_event_ids_json: string;
  summary: string;
  updated_at: number;
  summary_fingerprint: string | null;
}

function parseArchiveBackfillCursor(raw: string | undefined): ArchiveBackfillCursor | undefined {
  const parsed = parseJson<Partial<ArchiveBackfillCursor> | null>(raw, null);
  if (!parsed) return undefined;
  if (typeof parsed.id !== 'string' || !parsed.id) return undefined;
  if (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) return undefined;
  return { id: parsed.id, updatedAt: parsed.updatedAt };
}

function scheduleArchiveBackfillIfNeeded(database: DatabaseSyncInstance, dbPath: string, delayMs = 0): void {
  // Runs EXCLUSIVELY in the context-store worker once the daemon disables it on
  // the main thread; tests/CLI (the sole connection) keep it enabled.
  if (!isArchiveBackfillSchedulingEnabled()) return;
  if (internalGetContextMeta(database, 'migration_archive_backfilled') === '1') return;
  if (archiveBackfillScheduledForPath === dbPath) return;
  archiveBackfillScheduledForPath = dbPath;
  archiveBackfillTimer = setTimeout(() => {
    archiveBackfillTimer = null;
    archiveBackfillScheduledForPath = null;
    if (currentDbPath !== dbPath || !db) return;
    runArchiveBackfillScheduledBatch(dbPath);
  }, delayMs);
  archiveBackfillTimer.unref?.();
}

function runArchiveBackfillScheduledBatch(dbPath: string): void {
  if (currentDbPath !== dbPath || !db) return;
  const result = runArchiveBackfillBatchForDb(db, ARCHIVE_BACKFILL_BATCH_SIZE);
  if (!result.done && currentDbPath === dbPath && db) {
    scheduleArchiveBackfillIfNeeded(db, dbPath, result.processed > 0 ? 0 : 60_000);
  }
}

function runArchiveBackfillBatchForDb(database: DatabaseSyncInstance, batchSize: number): { processed: number; done: boolean } {
  if (internalGetContextMeta(database, 'migration_archive_backfilled') === '1') {
    return { processed: 0, done: true };
  }
  const requestedBatchSize = Math.floor(batchSize);
  const safeBatchSize = Number.isFinite(requestedBatchSize) ? Math.max(1, Math.min(10_000, requestedBatchSize)) : ARCHIVE_BACKFILL_BATCH_SIZE;
  const cursor = parseArchiveBackfillCursor(internalGetContextMeta(database, ARCHIVE_BACKFILL_CURSOR_KEY));
  try {
    database.exec('BEGIN IMMEDIATE');
    const rows = cursor
      ? database.prepare(`
          SELECT id, namespace_key, class, source_event_ids_json, summary, updated_at, summary_fingerprint
          FROM context_processed_local
          WHERE updated_at < ? OR (updated_at = ? AND id < ?)
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(cursor.updatedAt, cursor.updatedAt, cursor.id, safeBatchSize) as unknown as ArchiveBackfillRow[]
      : database.prepare(`
          SELECT id, namespace_key, class, source_event_ids_json, summary, updated_at, summary_fingerprint
          FROM context_processed_local
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(safeBatchSize) as unknown as ArchiveBackfillRow[];

    const sourceStmt = database.prepare('INSERT OR IGNORE INTO context_projection_sources (projection_id, event_id) VALUES (?, ?)');
    const existingFingerprintStmt = database.prepare(`
      SELECT id, updated_at
      FROM context_processed_local
      WHERE namespace_key = ? AND class = ? AND summary_fingerprint = ? AND id <> ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `);
    const fpStmt = database.prepare('UPDATE context_processed_local SET summary_fingerprint = ? WHERE id = ?');
    const archiveDupStmt = database.prepare("UPDATE context_processed_local SET status = 'archived_dedup', summary_fingerprint = NULL WHERE id = ?");

    for (const row of rows) {
      for (const eventId of parseJson<string[]>(row.source_event_ids_json, [])) {
        if (eventId) sourceStmt.run(row.id, eventId);
      }
      if (row.summary_fingerprint) continue;

      const fingerprint = projectionFingerprint(row.summary);
      const existing = existingFingerprintStmt.get(row.namespace_key, row.class, fingerprint, row.id) as
        | { id: string; updated_at: number }
        | undefined;
      if (existing && Number(existing.updated_at) >= Number(row.updated_at)) {
        archiveDupStmt.run(row.id);
        continue;
      }
      if (existing) {
        archiveDupStmt.run(existing.id);
      }
      fpStmt.run(fingerprint, row.id);
    }

    if (rows.length < safeBatchSize) {
      internalSetContextMeta(database, 'migration_archive_backfilled', '1');
      internalSetContextMeta(database, 'migration_fingerprint_backfilled_at', String(Date.now()));
      database.prepare('DELETE FROM context_meta WHERE key = ?').run(ARCHIVE_BACKFILL_CURSOR_KEY);
    } else {
      const last = rows[rows.length - 1];
      internalSetContextMeta(database, ARCHIVE_BACKFILL_CURSOR_KEY, JSON.stringify({ updatedAt: Number(last.updated_at), id: last.id }));
    }
    database.exec('COMMIT');
    return { processed: rows.length, done: rows.length < safeBatchSize };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    incrementCounter('mem.startup.silent_failure', { source: 'archive-backfill' });
    warnOncePerHour('mem.startup.silent_failure.archive-backfill', { error: error instanceof Error ? error.message : String(error) });
    return { processed: 0, done: false };
  }
}

export function runArchiveBackfillBatch(batchSize = ARCHIVE_BACKFILL_BATCH_SIZE): { processed: number; done: boolean } {
  return runArchiveBackfillBatchForDb(ensureDb(), batchSize);
}

function sqliteVersionAtLeast(version: string, major: number, minor: number): boolean {
  const [rawMajor, rawMinor] = version.split('.').map((part) => Number(part));
  if (!Number.isFinite(rawMajor) || !Number.isFinite(rawMinor)) return false;
  return rawMajor > major || (rawMajor === major && rawMinor >= minor);
}

function chooseFtsTokenizer(database: DatabaseSyncInstance): 'trigram' | 'unicode61' {
  const existing = internalGetContextMeta(database, 'fts_tokenizer');
  if (existing === 'trigram' || existing === 'unicode61') return existing;
  const versionRow = database.prepare('SELECT sqlite_version() AS version').get() as { version: string } | undefined;
  const compileRows = database.prepare('PRAGMA compile_options').all() as Array<Record<string, unknown>>;
  const compileText = compileRows.map((row) => Object.values(row).join(' ')).join('\n');
  const preferred: 'trigram' | 'unicode61' = (compileText.includes('ENABLE_FTS5_TRIGRAM') || sqliteVersionAtLeast(versionRow?.version ?? '', 3, 34)) ? 'trigram' : 'unicode61';
  internalSetContextMeta(database, 'fts_tokenizer', preferred);
  return preferred;
}

/**
 * FTS5 is not always available in the host SQLite build. Some Node.js
 * builds (notably Node 23.11.0's bundled SQLite at the time of writing)
 * ship without FTS5 compiled in. We MUST detect that and degrade
 * gracefully — the virtual table AND the AFTER INSERT/UPDATE/DELETE
 * triggers all reference `context_event_archive_fts`. If FTS5 is missing
 * and we install the triggers anyway, every archive write fails with
 * "no such table" because the trigger body is lazily resolved at fire
 * time, breaking the entire memory pipeline (`archiveEventsForMaterialization`,
 * materialization, `/compact` etc).
 *
 * Strategy: probe with a throwaway temp FTS5 table. If that succeeds,
 * install the real virtual table + triggers + backfill. If it fails,
 * record an 'unavailable' sentinel in context_meta, warn-once, and do
 * NOT create the virtual table or triggers. `searchArchiveFts` already
 * falls back to a bounded LIKE scan when the FTS query fails for any
 * reason — including "no such table" — so read-side tools keep working.
 */
function isFtsAvailable(database: DatabaseSyncInstance): boolean {
  try {
    database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __imc_fts_probe USING fts5(content)");
    database.exec('DROP TABLE IF EXISTS __imc_fts_probe');
    return true;
  } catch {
    return false;
  }
}


function disableArchiveFts(database: DatabaseSyncInstance, source: string, reason: string, error?: unknown): void {
  for (const ddl of [
    'DROP TRIGGER IF EXISTS context_event_archive_ai',
    'DROP TRIGGER IF EXISTS context_event_archive_ad',
    'DROP TRIGGER IF EXISTS context_event_archive_au',
    'DROP TABLE IF EXISTS context_event_archive_fts',
  ]) {
    try { database.exec(ddl); } catch { /* best-effort cleanup */ }
  }
  internalSetContextMeta(database, 'fts_tokenizer', 'unavailable');
  incrementCounter('mem.archive_fts.unavailable', { source });
  warnOncePerHour('mem.archive_fts.unavailable', {
    reason,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  });
}

function setupArchiveFts(database: DatabaseSyncInstance): void {
  if (!isFtsAvailable(database)) {
    disableArchiveFts(database, 'setupArchiveFts', 'host SQLite build lacks FTS5; chat_search_fts will use LIKE fallback');
    return;
  }
  const tokenizer = chooseFtsTokenizer(database);
  const tokenizerSql = tokenizer === 'trigram' ? "tokenize='trigram'" : "tokenize='unicode61 remove_diacritics 2'";
  try {
    database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS context_event_archive_fts USING fts5(content, content='context_event_archive', content_rowid='rowid', ${tokenizerSql})`);
  } catch (error) {
    try {
      database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS context_event_archive_fts USING fts5(content, content='context_event_archive', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')");
      internalSetContextMeta(database, 'fts_tokenizer', 'unicode61');
    } catch (fallbackError) {
      // Even the simpler tokenizer failed — treat as unavailable. (The
      // probe should have caught this; this catch is defense-in-depth.)
      disableArchiveFts(database, 'setupArchiveFts.fallback', 'FTS5 probe passed but virtual table creation failed', fallbackError ?? error);
      return;
    }
  }
  try {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS context_event_archive_ai AFTER INSERT ON context_event_archive BEGIN
        INSERT INTO context_event_archive_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS context_event_archive_ad AFTER DELETE ON context_event_archive BEGIN
        INSERT INTO context_event_archive_fts(context_event_archive_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS context_event_archive_au AFTER UPDATE ON context_event_archive BEGIN
        INSERT INTO context_event_archive_fts(context_event_archive_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO context_event_archive_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  } catch (error) {
    disableArchiveFts(database, 'setupArchiveFts.triggers', 'FTS5 trigger creation failed; using LIKE fallback', error);
    return;
  }
  if (internalGetContextMeta(database, 'fts_backfilled') !== '1') {
    try {
      database.exec("INSERT INTO context_event_archive_fts(context_event_archive_fts) VALUES('rebuild')");
      internalSetContextMeta(database, 'fts_backfilled', '1');
    } catch (error) {
      disableArchiveFts(database, 'setupArchiveFts.rebuild', 'FTS5 rebuild failed; cleaned up partial FTS objects and will use LIKE fallback', error);
    }
  }
}

function normalizeSourceEventIds(eventIds: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const eventId of eventIds) {
    if (!eventId || seen.has(eventId)) continue;
    seen.add(eventId);
    normalized.push(eventId);
  }
  return normalized;
}

function syncProjectionSourcesForDb(database: DatabaseSyncInstance, projectionId: string, eventIds: readonly string[]): string[] {
  const normalized = normalizeSourceEventIds(eventIds);
  database.prepare('DELETE FROM context_projection_sources WHERE projection_id = ?').run(projectionId);
  const stmt = database.prepare('INSERT OR IGNORE INTO context_projection_sources (projection_id, event_id) VALUES (?, ?)');
  for (const eventId of normalized) {
    stmt.run(projectionId, eventId);
  }
  return normalized;
}

function parseTargetKey(targetKey: string): ContextTargetRef {
  const parts = targetKey.split('::');
  const namespace = parseNamespaceKey(parts.slice(0, 5).join('::'));
  return {
    namespace,
    kind: (parts[5] || 'session') as ContextTargetRef['kind'],
    sessionName: parts[6] || undefined,
  };
}


function removeProjectionIdsFromReplicationState(database: DatabaseSyncInstance, projectionIds: string[]): void {
  if (projectionIds.length === 0) return;
  const projectionIdSet = new Set(projectionIds);
  const replicationRows = database.prepare('SELECT namespace_key, pending_projection_ids_json, last_replicated_at, last_error FROM context_replication_state').all() as Array<Record<string, unknown>>;
  for (const row of replicationRows) {
    const pending = parseJson<string[]>(row.pending_projection_ids_json, []);
    const filtered = pending.filter((id) => !projectionIdSet.has(id));
    if (filtered.length === pending.length) continue;
    database.prepare(`
      UPDATE context_replication_state
      SET pending_projection_ids_json = ?, last_replicated_at = ?, last_error = ?
      WHERE namespace_key = ?
    `).run(
      JSON.stringify(filtered),
      toNullableNumber(row.last_replicated_at),
      toNullableString(row.last_error),
      String(row.namespace_key),
    );
  }
}

function purgeMemoryNoiseProjections(database: DatabaseSyncInstance): number {
  const rows = database.prepare('SELECT id, summary FROM context_processed_local').all() as Array<{ id: string; summary: string }>;
  const badIds = rows.filter((row) => isMemoryNoiseSummary(row.summary)).map((row) => row.id);
  if (badIds.length === 0) return 0;
  const placeholders = badIds.map(() => '?').join(', ');
  database.prepare(`DELETE FROM context_processed_local WHERE id IN (${placeholders})`).run(...badIds);
  removeProjectionIdsFromReplicationState(database, badIds);
  return badIds.length;
}

export function removeMemoryNoiseProjections(): number {
  return purgeMemoryNoiseProjections(ensureDb());
}

export interface MaterializationRepairOptions {
  now?: number;
  /** Running jobs older than this are from a dead daemon/process and are reset. */
  staleRunningMs?: number;
  /** Keep this many failed materialization jobs per target/job_type for diagnostics. */
  failedJobsRetainPerTarget?: number;
  /** Never retain failed materialization jobs older than this window, except for the newest retained rows. */
  failedJobRetentionMs?: number;
}

export interface MaterializationRepairStats {
  staleRunningReset: number;
  dirtyPendingRefsCleared: number;
  pollutedFallbackArchived: number;
  failedJobsPruned: number;
}

const DEFAULT_STALE_RUNNING_JOB_MS = 10 * 60_000;
const DEFAULT_FAILED_JOB_RETAIN_PER_TARGET = 20;
const DEFAULT_FAILED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isPollutedFallbackProjection(row: { summary: string; content_json: string }): boolean {
  const content = parseJson<Record<string, unknown>>(row.content_json, {});
  const compressionFromSdk = content.compressionFromSdk;
  const fromSdkFalse = compressionFromSdk === false || compressionFromSdk === 0;
  const compressionModel = typeof content.compressionModel === 'string' ? content.compressionModel : '';
  const compressionBackend = typeof content.compressionBackend === 'string' ? content.compressionBackend : '';
  return row.summary.includes('Structured summary unavailable')
    || row.summary.includes('--- Updated ---')
    || (fromSdkFalse && (compressionModel === 'local-fallback' || compressionBackend === 'none'))
    || isLegacyRawTranscriptProjection(row.summary, content);
}

const RAW_TRANSCRIPT_PREFIX_RE = /^(assistant\.(?:turn|text|thinking)|user\.(?:turn|message)|tool\.(?:call|result)|system\.(?:event|message)|decision|constraint|preference):\s/m;

function isLegacyRawTranscriptProjection(summary: string, content: Record<string, unknown>): boolean {
  const trimmed = summary.trimStart();
  if (!RAW_TRANSCRIPT_PREFIX_RE.test(trimmed)) return false;
  if (trimmed.startsWith('## ')) return false;
  const hasCompressionProvenance =
    Object.prototype.hasOwnProperty.call(content, 'compressionFromSdk')
    || Object.prototype.hasOwnProperty.call(content, 'compressionBackend')
    || Object.prototype.hasOwnProperty.call(content, 'compressionModel');
  if (hasCompressionProvenance) return false;
  return content.targetKind === 'session' || content.targetKind === 'project';
}

function repairMaterializationStateForDb(
  database: DatabaseSyncInstance,
  options: MaterializationRepairOptions = {},
): MaterializationRepairStats {
  const now = options.now ?? Date.now();
  const staleRunningMs = options.staleRunningMs ?? DEFAULT_STALE_RUNNING_JOB_MS;
  const failedJobsRetainPerTarget = Math.max(0, options.failedJobsRetainPerTarget ?? DEFAULT_FAILED_JOB_RETAIN_PER_TARGET);
  const failedJobRetentionMs = Math.max(0, options.failedJobRetentionMs ?? DEFAULT_FAILED_JOB_RETENTION_MS);

  const staleCutoff = now - staleRunningMs;
  const staleRunningResult = database.prepare(`
    UPDATE context_jobs
    SET status = 'materialization_failed',
        updated_at = ?,
        error = COALESCE(error, 'stale running materialization job reset on daemon startup/repair')
    WHERE status = 'running'
      AND job_type IN ('materialize_session', 'materialize_project')
      AND updated_at < ?
  `).run(now, staleCutoff) as { changes?: number };

  const dirtyRows = database.prepare(`
    SELECT d.target_key, d.pending_job_id, j.status
    FROM context_dirty_targets d
    LEFT JOIN context_jobs j ON j.id = d.pending_job_id
    WHERE d.pending_job_id IS NOT NULL
  `).all() as Array<{ target_key: string; pending_job_id: string | null; status: string | null }>;
  let dirtyPendingRefsCleared = 0;
  const clearDirtyStmt = database.prepare('UPDATE context_dirty_targets SET pending_job_id = NULL WHERE target_key = ?');
  for (const row of dirtyRows) {
    if (row.status === 'pending' || row.status === 'running') continue;
    clearDirtyStmt.run(row.target_key);
    dirtyPendingRefsCleared += 1;
  }

  const pollutedRows = database.prepare(`
    SELECT id, summary, content_json
    FROM context_processed_local
    WHERE status = 'active'
  `).all() as Array<{ id: string; summary: string; content_json: string }>;
  const pollutedIds = pollutedRows
    .filter(isPollutedFallbackProjection)
    .map((row) => row.id);
  let pollutedFallbackArchived = 0;
  if (pollutedIds.length > 0) {
    const placeholders = pollutedIds.map(() => '?').join(', ');
    const archiveResult = database.prepare(`
      UPDATE context_processed_local
      SET status = 'archived'
      WHERE id IN (${placeholders}) AND status = 'active'
    `).run(...pollutedIds) as { changes?: number };
    removeProjectionIdsFromReplicationState(database, pollutedIds);
    pollutedFallbackArchived = archiveResult.changes ?? 0;
  }

  const failedRows = database.prepare(`
    SELECT id, target_key, job_type, updated_at
    FROM context_jobs
    WHERE status = 'materialization_failed'
      AND job_type IN ('materialize_session', 'materialize_project')
    ORDER BY target_key ASC, job_type ASC, updated_at DESC
  `).all() as Array<{ id: string; target_key: string; job_type: string; updated_at: number }>;
  const failedCutoff = now - failedJobRetentionMs;
  const seenByTarget = new Map<string, number>();
  const deleteIds: string[] = [];
  for (const row of failedRows) {
    const key = `${row.target_key}\u0000${row.job_type}`;
    const seen = seenByTarget.get(key) ?? 0;
    seenByTarget.set(key, seen + 1);
    if (seen < failedJobsRetainPerTarget && row.updated_at >= failedCutoff) continue;
    deleteIds.push(row.id);
  }
  let failedJobsPruned = 0;
  if (deleteIds.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < deleteIds.length; i += chunkSize) {
      const chunk = deleteIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = database.prepare(`DELETE FROM context_jobs WHERE id IN (${placeholders})`).run(...chunk) as { changes?: number };
      failedJobsPruned += result.changes ?? 0;
    }
  }

  internalSetContextMeta(database, 'last_materialization_repair_at', String(now));
  return {
    staleRunningReset: staleRunningResult.changes ?? 0,
    dirtyPendingRefsCleared,
    pollutedFallbackArchived,
    failedJobsPruned,
  };
}

export function repairMaterializationState(options: MaterializationRepairOptions = {}): MaterializationRepairStats {
  return repairMaterializationStateForDb(ensureDb(), options);
}

export function resetContextStoreForTests(): void {
  if (archiveBackfillTimer) {
    clearTimeout(archiveBackfillTimer);
  }
  archiveBackfillTimer = null;
  archiveBackfillScheduledForPath = null;
  resetArchiveBackfillSchedulingForTests();
  if (db) db.close();
  db = null;
  currentDbPath = null;
  stagedReconciledForPath = null;
  materializationRepairRanForPath = null;
}


/**
 * Transaction-free body of {@link archiveEventsForMaterialization}: archives
 * `events` directly on `database` with NO BEGIN/COMMIT/ensureDb. The caller
 * MUST run this inside a transaction.
 */
export function archiveEventsForMaterializationForDb(database: DatabaseSyncInstance, events: LocalContextEvent[], archivedAt: number): void {
  if (events.length === 0) return;
  // Content / metadata stay byte-identical to the first archive write per the
  // foundations spec ("archive content is byte-identical to original event
  // content"). `token_count` is the only field that may legitimately change
  // between writes — for example if `countTokens()` is upgraded — so we
  // refresh it on conflict while leaving the rest untouched.
  // (memory-system-1.1-foundations P6)
  const stmt = database.prepare(`
    INSERT INTO context_event_archive (
      id, namespace_key, target_key, event_type, content, metadata_json, created_at, archived_at, token_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET token_count = excluded.token_count
  `);
  for (const event of events) {
    const content = event.content ?? '';
    stmt.run(
      event.id,
      serializeContextNamespace(event.target.namespace),
      serializeContextTarget(event.target),
      event.eventType,
      content,
      JSON.stringify(event.metadata ?? null),
      event.createdAt,
      archivedAt,
      countTokens(content),
    );
  }
}

export function archiveEventsForMaterialization(events: LocalContextEvent[], archivedAt = Date.now()): void {
  if (events.length === 0) return;
  const database = ensureDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    archiveEventsForMaterializationForDb(database, events, archivedAt);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    incrementCounter('mem.startup.silent_failure', { source: 'archive-events' });
    warnOncePerHour('mem.startup.silent_failure.archive-events', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function archiveRowToEvent(row: Record<string, unknown>): LocalContextEvent {
  return {
    id: String(row.id),
    target: parseTargetKey(String(row.target_key)),
    eventType: String(row.event_type),
    content: String(row.content),
    metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null) ?? undefined,
    createdAt: Number(row.created_at),
  };
}

export function getArchivedEvent(id: string): LocalContextEvent | undefined {
  const database = ensureDb();
  const row = database.prepare('SELECT * FROM context_event_archive WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? archiveRowToEvent(row) : undefined;
}

export function listArchivedEventsForTarget(target: ContextTargetRef, since = 0, limit = 200): LocalContextEvent[] {
  const database = ensureDb();
  const targetKey = serializeContextTarget(target);
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = database.prepare(`
    SELECT * FROM context_event_archive
    WHERE target_key = ? AND created_at > ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(targetKey, since, safeLimit) as Array<Record<string, unknown>>;
  return rows.reverse().map(archiveRowToEvent);
}

export function insertProjectionSources(projectionId: string, eventIds: string[]): void {
  const database = ensureDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const stmt = database.prepare('INSERT OR IGNORE INTO context_projection_sources (projection_id, event_id) VALUES (?, ?)');
    for (const eventId of normalizeSourceEventIds(eventIds)) {
      stmt.run(projectionId, eventId);
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

export function pruneArchive(retentionDays: number, now = Date.now()): { deleted: number } {
  if (retentionDays === -1) return { deleted: 0 };
  // Defense-in-depth against an out-of-domain `archiveRetentionDays`. The
  // `.imc/memory.yaml` loader normally clamps invalid values to the default,
  // but a direct caller (test, future scheduler) MUST NOT be able to wipe
  // every uncited archive row by passing `0` or a negative non-sentinel value.
  // (memory-system-1.1-foundations P1)
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    incrementCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' });
    warnOncePerHour('memory_config_invalid_retention', {
      retentionDays,
      action: 'skipped sweep',
    });
    return { deleted: 0 };
  }
  const database = ensureDb();
  const cutoff = now - retentionDays * 86_400_000;
  const result = database.prepare(`
    DELETE FROM context_event_archive
    WHERE archived_at < ?
      AND id NOT IN (SELECT event_id FROM context_projection_sources)
  `).run(cutoff) as { changes?: number };
  internalSetContextMeta(database, 'last_archive_sweep_at', String(now), now);
  return { deleted: result.changes ?? 0 };
}

export function pruneArchiveIfDue(retentionDays: number, now = Date.now()): { deleted: number; skipped: boolean } {
  if (retentionDays === -1) return { deleted: 0, skipped: true };
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    incrementCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' });
    warnOncePerHour('memory_config_invalid_retention', {
      retentionDays,
      action: 'skipped due-check',
    });
    return { deleted: 0, skipped: true };
  }
  const database = ensureDb();
  const lastRaw = internalGetContextMeta(database, 'last_archive_sweep_at');
  const last = lastRaw ? Number(lastRaw) : Number.NaN;
  if (Number.isFinite(last) && now - last < 86_400_000) return { deleted: 0, skipped: true };
  return { ...pruneArchive(retentionDays, now), skipped: false };
}

// ── Compression-run telemetry ────────────────────────────────────────────────
//
// Persisted log of every compressWithSdk() call so operators can later run
// queries like:
//
//   -- which sessions burn the most input tokens
//   SELECT session_name, sum(input_tokens) AS total
//   FROM context_compression_runs WHERE created_at > ? GROUP BY session_name
//   ORDER BY total DESC LIMIT 10;
//
//   -- compression ratio per backend
//   SELECT backend, model, count(*), avg(output_tokens*1.0/input_tokens)
//   FROM context_compression_runs WHERE input_tokens > 0 GROUP BY backend, model;
//
//   -- failover frequency
//   SELECT backend, used_backup, outcome, count(*)
//   FROM context_compression_runs GROUP BY backend, used_backup, outcome;
//
// Inserts are best-effort: a recording failure MUST NOT break the
// compression caller. Retention follows the same `archiveRetentionDays`
// knob as `context_event_archive` (sentinel `last_compression_run_sweep_at`).

export type CompressionRunOutcome = 'success' | 'fallback' | 'admission_closed' | 'error' | 'noop';

export interface CompressionRunRecord {
  /** Unix ms when the row is inserted (defaults to now). */
  createdAt?: number;
  backend: string;
  model: string;
  usedBackup: boolean;
  fromSdk: boolean;
  /** Optional context — null when the call is a master summary spanning many. */
  namespaceKey?: string | null;
  targetKind?: string | null;
  sessionName?: string | null;
  trigger?: string | null;
  /** Compression mode the caller passed to compressWithSdk. */
  mode?: 'auto' | 'manual' | null;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  targetTokens: number;
  durationMs: number;
  outcome: CompressionRunOutcome;
  /** Classified compression error code when outcome ≠ 'success'. */
  errorCode?: string | null;
  /** Truncated last error message (max 500 chars at insert time). */
  errorMessage?: string | null;
  /** Linked projection id when the run produced a durable projection. */
  projectionId?: string | null;
}

export function recordCompressionRun(input: CompressionRunRecord): void {
  // Hard-bound the error message so a runaway provider error never bloats
  // the table. Slice on the insert side as defense-in-depth — the caller
  // is supposed to slice too, but we don't trust that.
  const errMsg = input.errorMessage ? input.errorMessage.slice(0, 500) : null;
  try {
    const database = ensureDb();
    database.prepare(`
      INSERT INTO context_compression_runs (
        created_at, backend, model, used_backup, from_sdk,
        namespace_key, target_kind, session_name, trigger, mode,
        event_count, input_tokens, output_tokens, target_tokens, duration_ms,
        outcome, error_code, error_message, projection_id
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      input.createdAt ?? Date.now(),
      input.backend,
      input.model,
      input.usedBackup ? 1 : 0,
      input.fromSdk ? 1 : 0,
      input.namespaceKey ?? null,
      input.targetKind ?? null,
      input.sessionName ?? null,
      input.trigger ?? null,
      input.mode ?? null,
      input.eventCount,
      input.inputTokens,
      input.outputTokens,
      input.targetTokens,
      input.durationMs,
      input.outcome,
      input.errorCode ?? null,
      errMsg,
      input.projectionId ?? null,
    );
  } catch (err) {
    // Never break compression because of telemetry — log + counter only.
    incrementCounter('mem.compression_run.record_failed', {});
    warnOncePerHour('mem.compression_run.record_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface CompressionRunSummary {
  /** Number of rows scanned (within the optional time window). */
  total: number;
  /** Aggregate input/output token sums per backend+model. */
  byBackendModel: Array<{
    backend: string;
    model: string;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    totalDurationMs: number;
    successes: number;
    fallbacks: number;
    errors: number;
  }>;
}

export function summarizeCompressionRuns(input: { since?: number; until?: number } = {}): CompressionRunSummary {
  const database = ensureDb();
  const since = input.since ?? 0;
  const until = input.until ?? Date.now();
  const totalRow = database.prepare(`
    SELECT count(*) AS n FROM context_compression_runs
    WHERE created_at >= ? AND created_at <= ?
  `).get(since, until) as { n: number };
  const rows = database.prepare(`
    SELECT
      backend,
      model,
      count(*)                                                AS runs,
      coalesce(sum(input_tokens), 0)                          AS input_tokens,
      coalesce(sum(output_tokens), 0)                         AS output_tokens,
      coalesce(sum(duration_ms), 0)                           AS total_duration_ms,
      coalesce(sum(CASE WHEN outcome = 'success'  THEN 1 ELSE 0 END), 0) AS successes,
      coalesce(sum(CASE WHEN outcome = 'fallback' THEN 1 ELSE 0 END), 0) AS fallbacks,
      coalesce(sum(CASE WHEN outcome = 'error'    THEN 1 ELSE 0 END), 0) AS errors
    FROM context_compression_runs
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY backend, model
    ORDER BY input_tokens DESC
  `).all(since, until) as Array<{
    backend: string; model: string; runs: number;
    input_tokens: number; output_tokens: number; total_duration_ms: number;
    successes: number; fallbacks: number; errors: number;
  }>;
  return {
    total: totalRow?.n ?? 0,
    byBackendModel: rows.map((r) => ({
      backend: r.backend,
      model: r.model,
      runs: r.runs,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalDurationMs: r.total_duration_ms,
      successes: r.successes,
      fallbacks: r.fallbacks,
      errors: r.errors,
    })),
  };
}

export function pruneCompressionRuns(retentionDays: number, now = Date.now()): { deleted: number } {
  if (retentionDays === -1) return { deleted: 0 };
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    incrementCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' });
    return { deleted: 0 };
  }
  const database = ensureDb();
  const cutoff = now - retentionDays * 86_400_000;
  const result = database.prepare(
    'DELETE FROM context_compression_runs WHERE created_at < ?',
  ).run(cutoff) as { changes?: number };
  internalSetContextMeta(database, 'last_compression_run_sweep_at', String(now), now);
  return { deleted: result.changes ?? 0 };
}

// ── Per-turn SDK token usage telemetry ───────────────────────────────────────
//
// Mirrors `context_compression_runs` but for the user-facing SDK turns
// (claude-code-sdk, codex-sdk, qwen, gemini-sdk, copilot-sdk, cursor-headless).
// Hooked from the timeline emitter so every `usage.update` event with token
// fields lands here too — operators get JSONL history (existing) + structured
// SQLite analytics (new) without each provider needing its own recording call.

export interface TurnUsageRecord {
  /** Unix ms when the row is inserted (defaults to now). */
  createdAt?: number;
  /** Session name the turn belongs to. */
  sessionName: string;
  /** Transport agent type, e.g. 'claude-code-sdk' / 'codex-sdk'. Optional
   *  because some emitters (e.g. usage.update from `command-handler.ts`
   *  on model switch) only know `model`. */
  agentType?: string | null;
  provider?: string | null;
  model?: string | null;
  sessionKind?: UsageSessionKind;
  parentSessionName?: string | null;
  metadataCompleteness?: UsageMetadataCompleteness;
  inputTokens?: number;
  cacheTokens?: number;
  outputTokens?: number;
  contextWindow?: number | null;
  costUsd?: number | null;
  /** Idempotency key. Pass the timeline event's `eventId` to make this row
   *  unique per `(session_name, event_id)`. Without it, daemon restart +
   *  JSONL history replay (gemini-watcher's deterministic stableId, the
   *  jsonl-watcher final-usage emit) inflate SUM(input_tokens) by N× per
   *  restart. The UNIQUE partial index `uq_turn_usage_event` swallows the
   *  duplicates via INSERT OR IGNORE; legacy rows with NULL event_id are
   *  unaffected. */
  eventId?: string | null;
}

export interface TurnUsageSyncRecord {
  turnUsageRowid: number;
  usageAuthorityId: string;
  usageFactId: string;
  payloadHash: string;
  syncStatus: UsageSyncStatus;
  retryCount: number;
  nextAttemptAtMs: number | null;
  lastAttemptAtMs: number | null;
  syncedAtMs: number | null;
  lastErrorReason: string | null;
  terminalReason: string | null;
  metadataCompleteness: UsageMetadataCompleteness;
  createdAtMs: number;
  updatedAtMs: number;
  fact: UsageFact;
}

export interface TurnUsageSyncResultInput {
  usageFactId: string;
  status: UsageFactStatus;
  reason?: string | null;
}

export interface TurnUsageSyncRequestFailureInput {
  usageFactIds: string[];
  retryable: boolean;
  reason: string;
  nextAttemptAtMs?: number | null;
  now?: number;
}

const USAGE_AUTHORITY_META_KEY = 'usage_authority_id';
const TERMINAL_USAGE_SYNC_STATUSES = new Set<UsageSyncStatus>([
  'accepted',
  'duplicate',
  'conflict_terminal',
  'invalid_terminal',
  'too_old_terminal',
  'clock_skew_terminal',
  'local_pruned_unsynced',
]);
const PROTECTED_USAGE_SYNC_STATUSES = new Set<UsageSyncStatus>([
  'pending',
  'retryable_failed',
  'in_flight',
]);
export const DEFAULT_USAGE_SYNC_IN_FLIGHT_LEASE_MS = 5 * 60 * 1000;

export function getOrCreateUsageAuthorityId(): string {
  const database = ensureDb();
  const existing = internalGetContextMeta(database, USAGE_AUTHORITY_META_KEY);
  if (existing) return existing;
  const id = `usage-authority-${randomUUID()}`;
  internalSetContextMeta(database, USAGE_AUTHORITY_META_KEY, id);
  return id;
}

function getOrCreateUsageAuthorityIdForDb(database: DatabaseSyncInstance, now = Date.now()): string {
  const existing = internalGetContextMeta(database, USAGE_AUTHORITY_META_KEY);
  if (existing) return existing;
  const id = `usage-authority-${randomUUID()}`;
  internalSetContextMeta(database, USAGE_AUTHORITY_META_KEY, id, now);
  return id;
}

function buildUsageFactFromRow(row: {
  id: number;
  created_at: number;
  session_name: string;
  session_kind: string | null;
  parent_session_name: string | null;
  metadata_completeness: string | null;
  provider: string | null;
  agent_type: string | null;
  model: string | null;
  input_tokens: number;
  cache_tokens: number;
  output_tokens: number;
  context_window: number | null;
  cost_usd_micros: number | null;
  event_id: string | null;
}, usageAuthorityId: string): UsageFact {
  const inputTokens = Math.max(0, Math.trunc(row.input_tokens ?? 0));
  const cacheTokens = Math.max(0, Math.trunc(row.cache_tokens ?? 0));
  const outputTokens = Math.max(0, Math.trunc(row.output_tokens ?? 0));
  const sessionKind: UsageSessionKind = row.session_kind === 'sub' ? 'sub' : 'main';
  const metadataCompleteness: UsageMetadataCompleteness = row.metadata_completeness === 'complete' ? 'complete' : 'partial';
  return {
    usageFactId: `usage:${usageAuthorityId}:${row.id}`,
    createdAtMs: row.created_at,
    sessionName: row.session_name,
    sessionKind,
    parentSessionName: row.parent_session_name ?? null,
    metadataCompleteness,
    provider: row.provider ?? null,
    agentType: row.agent_type ?? null,
    model: row.model ?? null,
    inputTokens,
    cacheTokens,
    outputTokens,
    totalTokens: computeTotalTokens(inputTokens, cacheTokens, outputTokens),
    contextWindow: row.context_window ?? null,
    costUsdMicros: row.cost_usd_micros ?? null,
    sourceEventId: row.event_id ?? null,
  };
}

function readTurnUsageRow(database: DatabaseSyncInstance, rowid: number): Parameters<typeof buildUsageFactFromRow>[0] | null {
  return database.prepare(`
    SELECT
      id,
      created_at,
      session_name,
      session_kind,
      parent_session_name,
      metadata_completeness,
      provider,
      agent_type,
      model,
      input_tokens,
      cache_tokens,
      output_tokens,
      context_window,
      cost_usd_micros,
      event_id
    FROM context_turn_usage
    WHERE id = ?
  `).get(rowid) as Parameters<typeof buildUsageFactFromRow>[0] | undefined ?? null;
}

function ensureTurnUsageSyncMetadataForDb(database: DatabaseSyncInstance, rowid: number, now = Date.now()): TurnUsageSyncRecord | null {
  const row = readTurnUsageRow(database, rowid);
  if (!row) return null;
  const usageAuthorityId = getOrCreateUsageAuthorityIdForDb(database, now);
  const fact = buildUsageFactFromRow(row, usageAuthorityId);
  const payloadHash = createCanonicalUsagePayloadHash(fact);
  database.prepare(`
    INSERT INTO context_turn_usage_sync (
      turn_usage_rowid,
      usage_authority_id,
      usage_fact_id,
      payload_hash,
      sync_status,
      retry_count,
      next_attempt_at_ms,
      metadata_completeness,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, ?)
    ON CONFLICT(turn_usage_rowid) DO UPDATE SET
      usage_authority_id = excluded.usage_authority_id,
      usage_fact_id = excluded.usage_fact_id,
      payload_hash = excluded.payload_hash,
      metadata_completeness = excluded.metadata_completeness,
      updated_at_ms = excluded.updated_at_ms
  `).run(
    rowid,
    usageAuthorityId,
    fact.usageFactId,
    payloadHash,
    fact.metadataCompleteness,
    fact.createdAtMs,
    now,
  );
  return readTurnUsageSyncRecordForDb(database, rowid);
}

export function ensureTurnUsageSyncMetadata(rowid: number): TurnUsageSyncRecord | null {
  return ensureTurnUsageSyncMetadataForDb(ensureDb(), rowid);
}

function readTurnUsageSyncRecordForDb(database: DatabaseSyncInstance, rowid: number): TurnUsageSyncRecord | null {
  const row = database.prepare(`
    SELECT
      s.turn_usage_rowid,
      s.usage_authority_id,
      s.usage_fact_id,
      s.payload_hash,
      s.sync_status,
      s.retry_count,
      s.next_attempt_at_ms,
      s.last_attempt_at_ms,
      s.synced_at_ms,
      s.last_error_reason,
      s.terminal_reason,
      s.metadata_completeness,
      s.created_at_ms,
      s.updated_at_ms,
      u.id,
      u.created_at,
      u.session_name,
      u.session_kind,
      u.parent_session_name,
      u.provider,
      u.agent_type,
      u.model,
      u.input_tokens,
      u.cache_tokens,
      u.output_tokens,
      u.context_window,
      u.cost_usd_micros,
      u.event_id
    FROM context_turn_usage_sync s
    JOIN context_turn_usage u ON u.id = s.turn_usage_rowid
    WHERE s.turn_usage_rowid = ?
  `).get(rowid) as {
    turn_usage_rowid: number;
    usage_authority_id: string;
    usage_fact_id: string;
    payload_hash: string;
    sync_status: UsageSyncStatus;
    retry_count: number;
    next_attempt_at_ms: number | null;
    last_attempt_at_ms: number | null;
    synced_at_ms: number | null;
    last_error_reason: string | null;
    terminal_reason: string | null;
    metadata_completeness: UsageMetadataCompleteness;
    created_at_ms: number;
    updated_at_ms: number;
    id: number;
    created_at: number;
    session_name: string;
    session_kind: string | null;
    parent_session_name: string | null;
    provider: string | null;
    agent_type: string | null;
    model: string | null;
    input_tokens: number;
    cache_tokens: number;
    output_tokens: number;
    context_window: number | null;
    cost_usd_micros: number | null;
    event_id: string | null;
  } | undefined;
  if (!row) return null;
  const fact = buildUsageFactFromRow({
    id: row.id,
    created_at: row.created_at,
    session_name: row.session_name,
    session_kind: row.session_kind,
    parent_session_name: row.parent_session_name,
    metadata_completeness: row.metadata_completeness,
    provider: row.provider,
    agent_type: row.agent_type,
    model: row.model,
    input_tokens: row.input_tokens,
    cache_tokens: row.cache_tokens,
    output_tokens: row.output_tokens,
    context_window: row.context_window,
    cost_usd_micros: row.cost_usd_micros,
    event_id: row.event_id,
  }, row.usage_authority_id);
  return {
    turnUsageRowid: row.turn_usage_rowid,
    usageAuthorityId: row.usage_authority_id,
    usageFactId: row.usage_fact_id,
    payloadHash: row.payload_hash,
    syncStatus: row.sync_status,
    retryCount: row.retry_count,
    nextAttemptAtMs: row.next_attempt_at_ms,
    lastAttemptAtMs: row.last_attempt_at_ms,
    syncedAtMs: row.synced_at_ms,
    lastErrorReason: row.last_error_reason,
    terminalReason: row.terminal_reason,
    metadataCompleteness: row.metadata_completeness,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    fact,
  };
}

export function backfillTurnUsageSyncMetadata(limit = 500): { backfilled: number } {
  const database = ensureDb();
  const rows = database.prepare(`
    SELECT u.id
    FROM context_turn_usage u
    LEFT JOIN context_turn_usage_sync s ON s.turn_usage_rowid = u.id
    WHERE s.turn_usage_rowid IS NULL
    ORDER BY u.id ASC
    LIMIT ?
  `).all(Math.max(1, Math.min(5000, Math.trunc(limit)))) as Array<{ id: number }>;
  let backfilled = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (ensureTurnUsageSyncMetadataForDb(database, row.id)) {
        backfilled += 1;
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { backfilled };
}

export function recoverStaleTurnUsageSyncInFlight(input: { now?: number; leaseMs?: number } = {}): { recovered: number } {
  const database = ensureDb();
  const now = input.now ?? Date.now();
  const leaseMs = Math.max(1, Math.trunc(input.leaseMs ?? DEFAULT_USAGE_SYNC_IN_FLIGHT_LEASE_MS));
  const staleBefore = now - leaseMs;
  const result = database.prepare(`
    UPDATE context_turn_usage_sync
    SET sync_status = 'retryable_failed',
        next_attempt_at_ms = NULL,
        last_error_reason = 'in_flight_stale',
        updated_at_ms = ?
    WHERE sync_status = 'in_flight'
      AND COALESCE(last_attempt_at_ms, updated_at_ms, created_at_ms) <= ?
  `).run(now, staleBefore) as { changes?: number };
  return { recovered: result.changes ?? 0 };
}

export function selectTurnUsageSyncBatch(input: { limit?: number; now?: number; inFlightLeaseMs?: number } = {}): TurnUsageSyncRecord[] {
  const database = ensureDb();
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const now = input.now ?? Date.now();
  backfillTurnUsageSyncMetadata(limit);
  recoverStaleTurnUsageSyncInFlight({ now, leaseMs: input.inFlightLeaseMs });
  database.exec('BEGIN IMMEDIATE');
  try {
    const rows = database.prepare(`
      SELECT turn_usage_rowid
      FROM context_turn_usage_sync
      WHERE sync_status IN ('pending', 'retryable_failed')
        AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
      ORDER BY created_at_ms ASC, turn_usage_rowid ASC
      LIMIT ?
    `).all(now, limit) as Array<{ turn_usage_rowid: number }>;
    for (const row of rows) {
      database.prepare(`
        UPDATE context_turn_usage_sync
        SET sync_status = 'in_flight',
            last_attempt_at_ms = ?,
            updated_at_ms = ?
        WHERE turn_usage_rowid = ?
      `).run(now, now, row.turn_usage_rowid);
    }
    database.exec('COMMIT');
    return rows
      .map((row) => readTurnUsageSyncRecordForDb(database, row.turn_usage_rowid))
      .filter((row): row is TurnUsageSyncRecord => row !== null);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function recordTurnUsageSyncResults(input: { results: TurnUsageSyncResultInput[]; now?: number }): { updated: number } {
  const database = ensureDb();
  const now = input.now ?? Date.now();
  let updated = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const result of input.results) {
      const mapped = mapUsageFactStatusToSyncStatus(result.status);
      const runResult = database.prepare(`
        UPDATE context_turn_usage_sync
        SET sync_status = ?,
            synced_at_ms = CASE WHEN ? IN ('accepted', 'duplicate') THEN ? ELSE synced_at_ms END,
            terminal_reason = CASE WHEN ? NOT IN ('accepted', 'duplicate') THEN ? ELSE terminal_reason END,
            last_error_reason = ?,
            updated_at_ms = ?
        WHERE usage_fact_id = ?
      `).run(
        mapped,
        mapped,
        now,
        mapped,
        result.reason ?? result.status,
        result.reason ?? null,
        now,
        result.usageFactId,
      ) as { changes?: number };
      updated += runResult.changes ?? 0;
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { updated };
}

export function recordTurnUsageSyncRequestFailure(input: TurnUsageSyncRequestFailureInput): { updated: number } {
  const database = ensureDb();
  const now = input.now ?? Date.now();
  const status: UsageSyncStatus = input.retryable ? 'retryable_failed' : 'invalid_terminal';
  let updated = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const usageFactId of input.usageFactIds) {
      const result = database.prepare(`
        UPDATE context_turn_usage_sync
        SET sync_status = ?,
            retry_count = CASE WHEN ? = 'retryable_failed' THEN retry_count + 1 ELSE retry_count END,
            next_attempt_at_ms = ?,
            last_error_reason = ?,
            terminal_reason = CASE WHEN ? = 'retryable_failed' THEN terminal_reason ELSE ? END,
            updated_at_ms = ?
        WHERE usage_fact_id = ?
      `).run(
        status,
        status,
        input.retryable ? input.nextAttemptAtMs ?? now + 60_000 : null,
        input.reason,
        status,
        input.reason,
        now,
        usageFactId,
      ) as { changes?: number };
      updated += result.changes ?? 0;
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { updated };
}

export function getTurnUsageSyncDiagnostics(now = Date.now()): UsagePrivacySafeDiagnostics {
  const database = ensureDb();
  const counts = database.prepare(`
    SELECT sync_status, count(*) AS count
    FROM context_turn_usage_sync
    GROUP BY sync_status
  `).all() as Array<{ sync_status: UsageSyncStatus; count: number }>;
  const byStatus = new Map(counts.map((row) => [row.sync_status, row.count]));
  const lagRow = database.prepare(`
    SELECT min(created_at_ms) AS oldest
    FROM context_turn_usage_sync
    WHERE sync_status IN ('pending', 'retryable_failed', 'in_flight')
  `).get() as { oldest: number | null } | undefined;
  const lastSuccessRow = database.prepare(`
    SELECT max(synced_at_ms) AS last_success
    FROM context_turn_usage_sync
    WHERE sync_status IN ('accepted', 'duplicate')
  `).get() as { last_success: number | null } | undefined;
  const lastErrorRow = database.prepare(`
    SELECT last_error_reason
    FROM context_turn_usage_sync
    WHERE last_error_reason IS NOT NULL
    ORDER BY updated_at_ms DESC
    LIMIT 1
  `).get() as { last_error_reason: string | null } | undefined;
  return {
    pendingCount: (byStatus.get('pending') ?? 0) + (byStatus.get('in_flight') ?? 0),
    retryCount: byStatus.get('retryable_failed') ?? 0,
    syncLagMs: typeof lagRow?.oldest === 'number' ? Math.max(0, now - lagRow.oldest) : 0,
    lastSuccessAtMs: lastSuccessRow?.last_success ?? undefined,
    acceptedCount: byStatus.get('accepted') ?? 0,
    duplicateCount: byStatus.get('duplicate') ?? 0,
    conflictCount: byStatus.get('conflict_terminal') ?? 0,
    invalidCount: (byStatus.get('invalid_terminal') ?? 0) + (byStatus.get('local_pruned_unsynced') ?? 0),
    tooOldCount: byStatus.get('too_old_terminal') ?? 0,
    clockSkewCount: byStatus.get('clock_skew_terminal') ?? 0,
    lastErrorReason: lastErrorRow?.last_error_reason ?? undefined,
  };
}

function mapUsageFactStatusToSyncStatus(status: UsageFactStatus): UsageSyncStatus {
  switch (status) {
    case 'accepted':
      return 'accepted';
    case 'duplicate':
      return 'duplicate';
    case 'conflict':
      return 'conflict_terminal';
    case 'invalid':
      return 'invalid_terminal';
    case 'too_old':
      return 'too_old_terminal';
    case 'clock_skew_too_far':
      return 'clock_skew_terminal';
  }
}

export function recordTurnUsage(input: TurnUsageRecord): void {
  // Skip rows that carry no token information at all — pure model-switch
  // events fire `usage.update` with only `{ model, contextWindow }` and would
  // pollute the analytics table without being useful for cost stats.
  const inputTokens = input.inputTokens ?? 0;
  const cacheTokens = input.cacheTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  if (inputTokens === 0 && cacheTokens === 0 && outputTokens === 0 && input.costUsd == null) {
    return;
  }
  try {
    const database = ensureDb();
    const createdAt = input.createdAt ?? Date.now();
    const costUsdMicros = normalizeCostUsdMicros(input.costUsd ?? null);
    const sessionKind = input.sessionKind ?? 'main';
    const parentSessionName = input.parentSessionName ?? null;
    const metadataCompleteness = input.metadataCompleteness ?? (sessionKind === 'sub' && !parentSessionName ? 'partial' : 'complete');
    database.prepare(`
      INSERT OR IGNORE INTO context_turn_usage (
        created_at, session_name, agent_type, model,
        input_tokens, cache_tokens, output_tokens, context_window, cost_usd, event_id,
        provider, session_kind, parent_session_name, metadata_completeness, cost_usd_micros
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createdAt,
      input.sessionName,
      input.agentType ?? null,
      input.model ?? null,
      inputTokens,
      cacheTokens,
      outputTokens,
      input.contextWindow ?? null,
      input.costUsd ?? null,
      input.eventId ?? null,
      input.provider ?? null,
      sessionKind,
      parentSessionName,
      metadataCompleteness,
      costUsdMicros,
    );
    let rowid: number | null = null;
    if (input.eventId) {
      const existing = database.prepare(
        'SELECT id FROM context_turn_usage WHERE session_name = ? AND event_id = ?',
      ).get(input.sessionName, input.eventId) as { id: number } | undefined;
      rowid = existing?.id ?? null;
    } else {
      const latest = database.prepare(
        'SELECT id FROM context_turn_usage WHERE session_name = ? ORDER BY id DESC LIMIT 1',
      ).get(input.sessionName) as { id: number } | undefined;
      rowid = latest?.id ?? null;
    }
    if (rowid != null) {
      ensureTurnUsageSyncMetadataForDb(database, rowid);
    }
  } catch (err) {
    // Never break the timeline emitter — log + counter only.
    incrementCounter('mem.turn_usage.record_failed', {});
    warnOncePerHour('mem.turn_usage.record_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface TurnUsageSummary {
  total: number;
  byAgentModel: Array<{
    agentType: string | null;
    model: string | null;
    turns: number;
    inputTokens: number;
    cacheTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }>;
}

export function summarizeTurnUsage(input: { since?: number; until?: number; sessionName?: string } = {}): TurnUsageSummary {
  const database = ensureDb();
  const since = input.since ?? 0;
  const until = input.until ?? Date.now();
  const sessionFilter = input.sessionName ? ' AND session_name = ?' : '';
  const args: (string | number)[] = [since, until];
  if (input.sessionName) args.push(input.sessionName);

  const totalRow = database.prepare(
    `SELECT count(*) AS n FROM context_turn_usage
     WHERE created_at >= ? AND created_at <= ?${sessionFilter}`,
  ).get(...args) as { n: number } | undefined;

  const rows = database.prepare(
    `SELECT
        agent_type,
        model,
        count(*)                          AS turns,
        coalesce(sum(input_tokens), 0)    AS input_tokens,
        coalesce(sum(cache_tokens), 0)    AS cache_tokens,
        coalesce(sum(output_tokens), 0)   AS output_tokens,
        sum(cost_usd)                     AS cost_usd
      FROM context_turn_usage
      WHERE created_at >= ? AND created_at <= ?${sessionFilter}
      GROUP BY agent_type, model
      ORDER BY input_tokens + output_tokens DESC`,
  ).all(...args) as Array<{
    agent_type: string | null; model: string | null; turns: number;
    input_tokens: number; cache_tokens: number; output_tokens: number;
    cost_usd: number | null;
  }>;

  return {
    total: totalRow?.n ?? 0,
    byAgentModel: rows.map((r) => ({
      agentType: r.agent_type,
      model: r.model,
      turns: r.turns,
      inputTokens: r.input_tokens,
      cacheTokens: r.cache_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
    })),
  };
}

export function pruneTurnUsage(retentionDays: number, now = Date.now()): { deleted: number } {
  if (retentionDays === -1) return { deleted: 0 };
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    incrementCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' });
    return { deleted: 0 };
  }
  const database = ensureDb();
  const cutoff = now - retentionDays * 86_400_000;
  const result = database.prepare(
    `DELETE FROM context_turn_usage
     WHERE created_at < ?
       AND (
         id NOT IN (SELECT turn_usage_rowid FROM context_turn_usage_sync)
         OR id IN (
           SELECT turn_usage_rowid
           FROM context_turn_usage_sync
           WHERE sync_status IN (
             'accepted',
             'duplicate',
             'conflict_terminal',
             'invalid_terminal',
             'too_old_terminal',
             'clock_skew_terminal',
             'local_pruned_unsynced'
           )
         )
       )`,
  ).run(cutoff) as { changes?: number };
  internalSetContextMeta(database, 'last_turn_usage_sweep_at', String(now), now);
  return { deleted: result.changes ?? 0 };
}

export interface PinnedNote {
  id: string;
  namespaceKey: string;
  content: string;
  origin: MemoryOrigin;
  createdAt: number;
  updatedAt: number;
}

export interface ContextNamespaceRow {
  id: string;
  tenantId?: string;
  localTenant: string;
  scope: MemoryScope;
  userId?: string;
  rootSessionId?: string;
  sessionTreeId?: string;
  sessionId?: string;
  workspaceId?: string;
  projectId?: string;
  orgId?: string;
  key: string;
  visibility: 'private' | 'shared';
  createdAt: number;
  updatedAt: number;
}

export interface ContextObservationRow {
  id: string;
  namespaceId: string;
  scope: MemoryScope;
  class: ObservationClass;
  origin: MemoryOrigin;
  fingerprint: string;
  content: Record<string, unknown>;
  textHash: string;
  sourceEventIds: string[];
  projectionId?: string;
  state: ObservationState;
  confidence?: number;
  createdAt: number;
  updatedAt: number;
  promotedAt?: number;
}

export interface ObservationPromotionAuditRow {
  id: string;
  observationId: string;
  actorId: string;
  action: string;
  fromScope: MemoryScope;
  toScope: MemoryScope;
  reason?: string;
  createdAt: number;
}

const OBSERVATION_PROMOTION_ACTIONS = new Set(['web_ui_promote', 'cli_mem_promote', 'admin_api_promote']);

function namespaceRowFromDb(row: Record<string, unknown>): ContextNamespaceRow {
  const scope = String(row.scope);
  if (!isMemoryScope(scope)) throw new Error(`invalid stored namespace scope: ${scope}`);
  return {
    id: String(row.id),
    tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : undefined,
    localTenant: String(row.local_tenant),
    scope,
    userId: typeof row.user_id === 'string' ? row.user_id : undefined,
    rootSessionId: typeof row.root_session_id === 'string' ? row.root_session_id : undefined,
    sessionTreeId: typeof row.session_tree_id === 'string' ? row.session_tree_id : undefined,
    sessionId: typeof row.session_id === 'string' ? row.session_id : undefined,
    workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : undefined,
    projectId: typeof row.project_id === 'string' ? row.project_id : undefined,
    orgId: typeof row.org_id === 'string' ? row.org_id : undefined,
    key: String(row.key),
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function observationRowFromDb(row: Record<string, unknown>): ContextObservationRow {
  const scope = String(row.scope);
  if (!isMemoryScope(scope)) throw new Error(`invalid stored observation scope: ${scope}`);
  const observationClass = String(row.class);
  if (!isObservationClass(observationClass)) throw new Error(`invalid stored observation class: ${observationClass}`);
  const origin = String(row.origin);
  if (!isMemoryOrigin(origin)) throw new Error(`invalid stored observation origin: ${origin}`);
  const state = String(row.state);
  if (!isObservationState(state)) throw new Error(`invalid stored observation state: ${state}`);
  return {
    id: String(row.id),
    namespaceId: String(row.namespace_id),
    scope,
    class: observationClass,
    origin,
    fingerprint: String(row.fingerprint),
    content: parseJson<Record<string, unknown>>(row.content_json, {}),
    textHash: String(row.text_hash),
    sourceEventIds: parseJson<string[]>(row.source_event_ids_json, []),
    projectionId: typeof row.projection_id === 'string' ? row.projection_id : undefined,
    state,
    confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    promotedAt: typeof row.promoted_at === 'number' ? row.promoted_at : undefined,
  };
}

function auditRowFromDb(row: Record<string, unknown>): ObservationPromotionAuditRow {
  const fromScope = String(row.from_scope);
  const toScope = String(row.to_scope);
  if (!isMemoryScope(fromScope) || !isMemoryScope(toScope)) throw new Error('invalid stored promotion audit scope');
  return {
    id: String(row.id),
    observationId: String(row.observation_id),
    actorId: String(row.actor_id),
    action: String(row.action),
    fromScope,
    toScope,
    reason: typeof row.reason === 'string' ? row.reason : undefined,
    createdAt: Number(row.created_at),
  };
}

export function addPinnedNote(input: { namespaceKey: string; content: string; origin: MemoryOrigin; id?: string; now?: number }): PinnedNote {
  const database = ensureDb();
  const now = input.now ?? Date.now();
  const origin = requireExplicitMemoryOrigin(input.origin, 'pinned note');
  const note: PinnedNote = {
    id: input.id ?? randomUUID(),
    namespaceKey: input.namespaceKey,
    content: input.content,
    origin,
    createdAt: now,
    updatedAt: now,
  };
  database.prepare(`
    INSERT INTO context_pinned_notes (id, namespace_key, content, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(note.id, note.namespaceKey, note.content, note.origin ?? null, note.createdAt, note.updatedAt);
  return note;
}

export function upsertPinnedNote(input: { namespaceKey: string; content: string; origin: MemoryOrigin; id?: string; now?: number }): PinnedNote {
  const database = ensureDb();
  const now = input.now ?? Date.now();
  const origin = requireExplicitMemoryOrigin(input.origin, 'pinned note');
  const id = input.id ?? randomUUID();
  const content = input.content.trim();
  if (!content) throw new Error('pinned note content is required');
  database.prepare(`
    INSERT INTO context_pinned_notes (id, namespace_key, content, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      namespace_key = excluded.namespace_key,
      content = excluded.content,
      origin = excluded.origin,
      updated_at = excluded.updated_at
  `).run(id, input.namespaceKey, content, origin, now, now);
  const row = database.prepare('SELECT * FROM context_pinned_notes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('failed to upsert pinned note');
  return {
    id: String(row.id),
    namespaceKey: String(row.namespace_key),
    content: String(row.content),
    origin: isMemoryOrigin(row.origin) ? row.origin : origin,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function removePinnedNote(id: string): boolean {
  const database = ensureDb();
  const result = database.prepare('DELETE FROM context_pinned_notes WHERE id = ?').run(id) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export function listPinnedNotes(namespaceKey: string): PinnedNote[] {
  const database = ensureDb();
  const rows = database.prepare('SELECT * FROM context_pinned_notes WHERE namespace_key = ? ORDER BY created_at ASC').all(namespaceKey) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    namespaceKey: String(row.namespace_key),
    content: String(row.content),
    origin: isMemoryOrigin(row.origin) ? row.origin : 'manual_pin',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export function getStagedEvent(id: string): LocalContextEvent | undefined {
  const database = ensureDb();
  const row = database.prepare('SELECT * FROM context_staged_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    target: parseTargetKey(String(row.target_key)),
    eventType: String(row.event_type),
    content: typeof row.content === 'string' ? row.content : undefined,
    metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null) ?? undefined,
    createdAt: Number(row.created_at),
  };
}

function processedProjectionFromRow(row: Record<string, unknown>, namespace?: ContextNamespace): ProcessedContextProjection {
  const resolvedNamespace = namespace ?? parseNamespaceKey(String(row.namespace_key));
  return {
    id: String(row.id),
    namespace: resolvedNamespace,
    class: String(row.class) as ProcessedContextClass,
    origin: isMemoryOrigin(row.origin) ? row.origin : undefined,
    sourceEventIds: parseJson<string[]>(row.source_event_ids_json, []),
    summary: String(row.summary),
    content: parseJson<Record<string, unknown>>(row.content_json, {}),
    contentHash: typeof row.content_hash === 'string' && row.content_hash ? row.content_hash : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    hitCount: typeof row.hit_count === 'number' ? row.hit_count : 0,
    lastUsedAt: typeof row.last_used_at === 'number' ? row.last_used_at : undefined,
    status: typeof row.status === 'string' ? row.status as ProcessedContextProjectionStatus : 'active',
  };
}

export function getProcessedProjectionById(projectionId: string): ProcessedContextProjection | undefined {
  const database = ensureDb();
  const row = database.prepare('SELECT * FROM context_processed_local WHERE id = ?').get(projectionId) as Record<string, unknown> | undefined;
  return row ? processedProjectionFromRow(row) : undefined;
}

export interface ProjectionSourceRow {
  eventId: string;
  event?: LocalContextEvent;
  status: 'archived' | 'staged' | 'missing';
}

export function listProjectionSources(projectionId: string): ProjectionSourceRow[] {
  const database = ensureDb();
  const rows = database.prepare(`
    SELECT cps.event_id, a.id AS archive_id, a.target_key, a.event_type, a.content, a.metadata_json, a.created_at
    FROM context_projection_sources cps
    LEFT JOIN context_event_archive a ON a.id = cps.event_id
    WHERE cps.projection_id = ?
    ORDER BY cps.rowid ASC
  `).all(projectionId) as Array<Record<string, unknown>>;
  const eventIds = rows.length > 0
    ? rows.map((row) => String(row.event_id))
    : (() => {
        const projection = database.prepare('SELECT source_event_ids_json FROM context_processed_local WHERE id = ?').get(projectionId) as { source_event_ids_json: string } | undefined;
        return parseJson<string[]>(projection?.source_event_ids_json, []);
      })();
  if (rows.length === 0) return eventIds.map((eventId) => {
    const archived = getArchivedEvent(eventId);
    const staged = archived ? undefined : getStagedEvent(eventId);
    return { eventId, event: archived ?? staged, status: archived ? 'archived' : staged ? 'staged' : 'missing' };
  });
  return rows.map((row) => {
    const eventId = String(row.event_id);
    if (typeof row.archive_id === 'string') {
      return {
        eventId,
        status: 'archived' as const,
        event: {
          id: eventId,
          target: parseTargetKey(String(row.target_key)),
          eventType: String(row.event_type),
          content: String(row.content),
          metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null) ?? undefined,
          createdAt: Number(row.created_at),
        },
      };
    }
    const staged = getStagedEvent(eventId);
    return { eventId, event: staged, status: staged ? 'staged' as const : 'missing' as const };
  });
}

export interface ArchiveSearchResult {
  id: string;
  eventType: string;
  content: string;
  createdAt: number;
  target: ContextTargetRef;
}

export interface ArchiveSearchFilters {
  namespace?: ContextNamespace;
  userId?: string;
}

function archiveSearchRowToResult(row: Record<string, unknown>): ArchiveSearchResult {
  return {
    id: String(row.id),
    target: parseTargetKey(String(row.target_key)),
    eventType: String(row.event_type),
    content: String(row.content),
    createdAt: Number(row.created_at),
  };
}

function rowsToArchiveSearchResults(rows: Array<Record<string, unknown>>, filters: ArchiveSearchFilters, limit: number): ArchiveSearchResult[] {
  const results: ArchiveSearchResult[] = [];
  for (const row of rows) {
    const result = archiveSearchRowToResult(row);
    if (filters.userId && result.target.namespace.userId !== filters.userId) continue;
    results.push(result);
    if (results.length >= limit) break;
  }
  return results;
}

export function searchArchiveFts(query: string, limit = 20, filters: ArchiveSearchFilters = {}): ArchiveSearchResult[] {
  const database = ensureDb();
  const trimmed = query.trim();
  if (!trimmed) return [];
  const requestedLimit = Math.floor(limit);
  const safeLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 20;
  const namespaceKey = filters.namespace ? serializeContextNamespace(filters.namespace) : undefined;
  const namespacePredicate = namespaceKey ? 'AND a.namespace_key = ?' : '';
  const fetchLimit = filters.userId && !namespaceKey ? Math.min(1000, safeLimit * 10) : safeLimit;
  let rows: Array<Record<string, unknown>> = [];
  // Fast path: skip the FTS attempt entirely when setupArchiveFts recorded
  // FTS5 as unavailable on this host. Falling straight through to literal substring search
  // avoids spamming `mem.archive_fts.match_failure` on every search call.
  const ftsTokenizer = internalGetContextMeta(database, 'fts_tokenizer');
  const ftsAvailable = ftsTokenizer !== 'unavailable';
  if (ftsAvailable) {
    try {
      rows = database.prepare(`
        SELECT a.id, a.target_key, a.event_type, a.content, a.created_at
        FROM context_event_archive_fts f
        JOIN context_event_archive a ON a.rowid = f.rowid
        WHERE context_event_archive_fts MATCH ?
          ${namespacePredicate}
        ORDER BY rank
        LIMIT ?
      `).all(...(namespaceKey ? [trimmed, namespaceKey, fetchLimit] : [trimmed, fetchLimit])) as Array<Record<string, unknown>>;
    } catch (error) {
      incrementCounter('mem.archive_fts.match_failure', { source: 'searchArchiveFts' });
      warnOncePerHour('mem.archive_fts.match_failure', { error: error instanceof Error ? error.message : String(error) });
      rows = [];
    }
  }
  let results = rowsToArchiveSearchResults(rows, filters, safeLimit);
  // FTS5 trigram does not match short two-codepoint CJK queries reliably.
  // Keep FTS as the primary index path, then fall back to bounded literal substring search so
  // read-side tools still return honest CJK hits on all SQLite builds. This
  // path also safely contains malformed FTS5 syntax (for example unmatched quotes).
  if (results.length === 0) {
    const likeNamespacePredicate = namespaceKey ? 'AND namespace_key = ?' : '';
    rows = database.prepare(`
      SELECT id, target_key, event_type, content, created_at
      FROM context_event_archive
      WHERE instr(content, ?) > 0
        ${likeNamespacePredicate}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...(namespaceKey ? [trimmed, namespaceKey, fetchLimit] : [trimmed, fetchLimit])) as Array<Record<string, unknown>>;
    results = rowsToArchiveSearchResults(rows, filters, safeLimit);
  }
  return results;
}

export function countStagedTokens(target: ContextTargetRef): number {
  return listContextEvents(target).reduce((sum, event) => sum + countTokens(event.content ?? ''), 0);
}

export function estimateStagedTokenUpperBound(target: ContextTargetRef): number {
  const database = ensureDb();
  const targetKey = serializeContextTarget(target);
  const row = database.prepare(`
    SELECT coalesce(sum(length(coalesce(content, ''))), 0) AS chars
      FROM context_staged_events
     WHERE target_key = ?
  `).get(targetKey) as { chars?: number } | undefined;
  const chars = Number(row?.chars ?? 0);
  return Number.isFinite(chars) && chars > 0 ? Math.ceil(chars) : 0;
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
  const namespaceColumns = namespaceFilterColumnValues(event.target.namespace);
  database.exec('BEGIN IMMEDIATE');
  try {
    const insertResult = database.prepare(`
      INSERT INTO context_staged_events (
        id, namespace_key, scope, enterprise_id, workspace_id, user_id, project_id,
        target_key, target_kind, session_name, event_type, content, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      event.id,
      namespaceKey,
      ...namespaceColumns,
      targetKey,
      event.target.kind,
      event.target.sessionName ?? null,
      event.eventType,
      event.content ?? null,
      JSON.stringify(event.metadata ?? null),
      event.createdAt,
    );
    if (insertResult.changes === 0) {
      // Duplicate stable id = idempotent replay. The insert was a no-op and dirty/staged
      // counts must NOT double-increment (the ON CONFLICT DO NOTHING idempotency stands).
      // For observability only, detect a stable-id collision whose payload disagrees with
      // the already-staged row — this would mean an upstream provider reused one eventId for
      // two genuinely different logical events, silently dropping the second. Count a metric
      // and emit a low-frequency warn so the contract violation is visible, WITHOUT logging
      // any chat content.
      const existingRow = database.prepare(
        'SELECT event_type, content FROM context_staged_events WHERE id = ?',
      ).get(event.id) as { event_type?: string; content?: string | null } | undefined;
      if (existingRow) {
        const existingEventType = existingRow.event_type ?? null;
        const existingContent = existingRow.content ?? null;
        const incomingContent = event.content ?? null;
        if (existingEventType !== event.eventType || existingContent !== incomingContent) {
          incrementCounter('mem.ingest.duplicate_id_mismatch', { source: 'recordContextEvent' });
          warnOncePerHour('mem.ingest.duplicate_id_mismatch.recordContextEvent', {
            id: event.id,
            existingEventType,
            incomingEventType: event.eventType,
          });
        }
      }
      database.exec('COMMIT');
      return event;
    }
    database.prepare(`
      INSERT INTO context_dirty_targets (
        target_key, namespace_key, scope, enterprise_id, workspace_id, user_id, project_id,
        target_kind, session_name, event_count, oldest_event_at, newest_event_at, last_trigger, pending_job_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
      ON CONFLICT(target_key) DO UPDATE SET
        event_count = context_dirty_targets.event_count + 1,
        oldest_event_at = MIN(context_dirty_targets.oldest_event_at, excluded.oldest_event_at),
        newest_event_at = MAX(context_dirty_targets.newest_event_at, excluded.newest_event_at),
        namespace_key = excluded.namespace_key,
        scope = excluded.scope,
        enterprise_id = excluded.enterprise_id,
        workspace_id = excluded.workspace_id,
        user_id = excluded.user_id,
        project_id = excluded.project_id,
        target_kind = excluded.target_kind,
        session_name = excluded.session_name
    `).run(
      targetKey,
      namespaceKey,
      ...namespaceColumns,
      event.target.kind,
      event.target.sessionName ?? null,
      event.createdAt,
      event.createdAt,
    );
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
  return event;
}

export interface IngestContextEventResult {
  event: LocalContextEvent;
  dirtyTarget?: ContextDirtyTarget;
  stagedTokenUpperBound: number;
  latestSummaryUpdatedAt?: number;
}

/** Aggregate ingest RPC: record the event and, when `computeTriggerData` is set
 *  (memory-eligible events), read everything the coordinator needs to decide a
 *  materialization trigger — the dirty target, the staged-token upper bound, and
 *  the latest recent-summary timestamp — in ONE round trip, so per-event
 *  ingestion makes a single worker call instead of 2–3. The trigger DECISION
 *  stays on the caller (it needs in-memory rate-limit/threshold state). */
export function ingestContextEvent(
  input: Omit<LocalContextEvent, 'id' | 'createdAt'> & Partial<Pick<LocalContextEvent, 'id' | 'createdAt'>>,
  computeTriggerData: boolean,
): IngestContextEventResult {
  const event = recordContextEvent(input);
  if (!computeTriggerData) return { event, stagedTokenUpperBound: 0 };
  const dirtyTarget = listDirtyTargets(input.target.namespace).find(
    (entry) => entry.target.kind === input.target.kind && entry.target.sessionName === input.target.sessionName,
  );
  if (!dirtyTarget) return { event, stagedTokenUpperBound: 0 };
  return {
    event,
    dirtyTarget,
    stagedTokenUpperBound: estimateStagedTokenUpperBound(input.target),
    latestSummaryUpdatedAt: getLatestRecentSummaryUpdatedAtForTarget(input.target),
  };
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

/**
 * Transaction-free body of {@link deleteStagedEventsByIds}: deletes staged
 * events by id directly on `database` with NO ensureDb. This function does not
 * itself open a transaction (the public wrapper did not either).
 */
export function deleteStagedEventsByIdsForDb(database: DatabaseSyncInstance, eventIds: string[]): void {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => '?').join(', ');
  database.prepare(`DELETE FROM context_staged_events WHERE id IN (${placeholders})`).run(...eventIds);
}

export function deleteStagedEventsByIds(eventIds: string[]): void {
  if (eventIds.length === 0) return;
  const database = ensureDb();
  deleteStagedEventsByIdsForDb(database, eventIds);
}

export function queryPendingContextEvents(filters: {
  scope?: ContextScope | MemoryScope;
  enterpriseId?: string;
  workspaceId?: string;
  userId?: string;
  projectId?: string;
  includeLegacyPersonalOwner?: boolean;
  query?: string;
  limit?: number;
} = {}): ContextPendingEventView[] {
  const database = ensureDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  appendNamespaceFilterSql(conditions, params, filters);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = database.prepare(`
    SELECT id, namespace_key, session_name, event_type, content, created_at
    FROM context_staged_events
    ${where}
    ORDER BY created_at DESC
  `).all(...params) as Array<Record<string, unknown>>;
  const normalizedQuery = filters.query?.trim().toLowerCase() ?? '';
  const limit = typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 50;
  return rows
    .map((row) => {
      const namespace = parseNamespaceKey(String(row.namespace_key));
      return {
        id: String(row.id),
        namespace,
        projectId: namespace.projectId ?? '',
        sessionName: typeof row.session_name === 'string' ? row.session_name : undefined,
        eventType: String(row.event_type),
        content: typeof row.content === 'string' ? row.content : undefined,
        createdAt: Number(row.created_at),
      };
    })
    .filter((row) => {
      return namespaceMatchesFilters(row.namespace, filters);
    })
    .filter((row) => {
      if (!normalizedQuery) return true;
      const haystack = `${row.eventType}\n${row.content ?? ''}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, limit)
    .map(({ namespace: _namespace, ...row }) => row);
}

export function enqueueContextJob(target: ContextTargetRef, jobType: ContextJobType, trigger: ContextJobTrigger, now = Date.now()): ContextJobRecord {
  const database = ensureDb();
  const targetKey = serializeContextTarget(target);
  const namespaceColumns = namespaceFilterColumnValues(target.namespace);
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
      id, namespace_key, scope, enterprise_id, workspace_id, user_id, project_id,
      target_key, target_kind, session_name, job_type, trigger, status, created_at, updated_at, attempt_count, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    job.id,
    serializeContextNamespace(target.namespace),
    ...namespaceColumns,
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

/**
 * Transaction-free body of {@link updateContextJob}: updates a context job row
 * directly on `database` with NO ensureDb. This function does not itself open a
 * transaction (the public wrapper did not either).
 */
export function updateContextJobForDb(database: DatabaseSyncInstance, jobId: string, status: ContextJobStatus, updates?: { error?: string; attemptIncrement?: boolean; now?: number }): void {
  const now = updates?.now ?? Date.now();
  database.prepare(`
    UPDATE context_jobs
    SET status = ?, updated_at = ?, error = ?, attempt_count = attempt_count + ?
    WHERE id = ?
  `).run(status, now, updates?.error ?? null, updates?.attemptIncrement ? 1 : 0, jobId);
}

export function updateContextJob(jobId: string, status: ContextJobStatus, updates?: { error?: string; attemptIncrement?: boolean; now?: number }): void {
  const database = ensureDb();
  updateContextJobForDb(database, jobId, status, updates);
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

/**
 * Transaction-free body of {@link writeProcessedProjection}. Performs the
 * prior-read + INSERT…ON CONFLICT + source/observation sync (branching on
 * `input.id`) directly on `database` with NO BEGIN/COMMIT/ROLLBACK, retry, or
 * `ensureDb`. The caller MUST run this inside a `BEGIN IMMEDIATE` transaction.
 */
export function writeProcessedProjectionForDb(
  database: DatabaseSyncInstance,
  input: WriteProcessedProjectionInput,
): ProcessedContextProjection {
  const now = Date.now();
  const canonicalNamespace = canonicalizeContextNamespace(input.namespace);
  const namespaceKey = serializeContextNamespace(canonicalNamespace);
  const namespaceColumns = namespaceFilterColumnValues(canonicalNamespace);
  // Store is not a project-aware redaction boundary. Callers that have
  // namespace/project context must redact before write; replication/import
  // callers pass already-redacted payloads from the producing daemon/server.
  // This avoids a second pass using process.cwd()-derived rules from the wrong
  // project and preserves explicit pinned-note byte identity.
  const summaryForDb = input.summary;
  const contentForDb = input.content;
  const contentJsonForDb = JSON.stringify(contentForDb);
  const contentHashForDb = projectionContentHash(summaryForDb, contentForDb);
  const originForDb = projectionOriginForInput(input);

  // Explicit ids are used by replication/import paths and stable singleton
  // projections (for example per-session master summaries). They must remain
  // distinct from fingerprint-based local rows, so keep summary_fingerprint
  // NULL, but still upsert by id and merge provenance on repeated writes.
  if (input.id) {
    const prior = database.prepare('SELECT source_event_ids_json, created_at FROM context_processed_local WHERE id = ?')
      .get(input.id) as { source_event_ids_json: string; created_at: number } | undefined;
    const sourceEventIds = mergeSourceIds(parseJson<string[]>(prior?.source_event_ids_json, []), input.sourceEventIds);
    const projection: ProcessedContextProjection = {
      id: input.id,
      namespace: canonicalNamespace,
      class: input.class,
      sourceEventIds,
      summary: summaryForDb,
      content: parseJson<Record<string, unknown>>(contentJsonForDb, contentForDb),
      contentHash: contentHashForDb,
      origin: originForDb,
      createdAt: prior?.created_at ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    database.prepare(`
      INSERT INTO context_processed_local (
        id, namespace_key, scope, enterprise_id, workspace_id, user_id, project_id,
        class, source_event_ids_json, summary, content_json, content_hash, origin, created_at, updated_at, summary_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        namespace_key = excluded.namespace_key,
        scope = excluded.scope,
        enterprise_id = excluded.enterprise_id,
        workspace_id = excluded.workspace_id,
        user_id = excluded.user_id,
        project_id = excluded.project_id,
        class = excluded.class,
        source_event_ids_json = excluded.source_event_ids_json,
        summary = excluded.summary,
        content_json = excluded.content_json,
        content_hash = excluded.content_hash,
        origin = excluded.origin,
        updated_at = excluded.updated_at,
        summary_fingerprint = NULL
    `).run(
      projection.id,
      namespaceKey,
      ...namespaceColumns,
      projection.class,
      JSON.stringify(projection.sourceEventIds),
      projection.summary,
      contentJsonForDb,
      contentHashForDb,
      originForDb,
      projection.createdAt,
      projection.updatedAt,
    );
    syncProjectionSourcesForDb(database, projection.id, projection.sourceEventIds);
    upsertProjectionObservationForDb(database, {
      namespace: projection.namespace,
      projectionId: projection.id,
      projectionClass: projection.class,
      sourceEventIds: projection.sourceEventIds,
      summary: projection.summary,
      content: projection.content,
      createdAt: projection.createdAt,
      updatedAt: projection.updatedAt,
      fingerprint: projectionFingerprint(projection.summary),
      origin: projection.origin ?? originForDb,
    });
    return projection;
  }

  const fingerprint = projectionFingerprint(summaryForDb);
  const prior = database.prepare(`
    SELECT id, source_event_ids_json, created_at
    FROM context_processed_local
    WHERE namespace_key = ? AND class = ? AND summary_fingerprint = ?
    LIMIT 1
  `).get(namespaceKey, input.class, fingerprint) as { id: string; source_event_ids_json: string; created_at: number } | undefined;
  const mergedIds = mergeSourceIds(parseJson<string[]>(prior?.source_event_ids_json, []), input.sourceEventIds);
  const projectionId = prior?.id ?? randomUUID();
  const createdAt = prior?.created_at ?? input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;
  const row = database.prepare(`
    INSERT INTO context_processed_local (
      id, namespace_key, scope, enterprise_id, workspace_id, user_id, project_id,
      class, source_event_ids_json, summary, content_json, content_hash, origin, created_at, updated_at, summary_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(namespace_key, class, summary_fingerprint) WHERE summary_fingerprint IS NOT NULL DO UPDATE SET
      scope = excluded.scope,
      enterprise_id = excluded.enterprise_id,
      workspace_id = excluded.workspace_id,
      user_id = excluded.user_id,
      project_id = excluded.project_id,
      source_event_ids_json = excluded.source_event_ids_json,
      summary = excluded.summary,
      content_json = excluded.content_json,
      content_hash = excluded.content_hash,
      origin = excluded.origin,
      updated_at = excluded.updated_at
    RETURNING id, source_event_ids_json, summary, content_json, content_hash, origin, created_at, updated_at
  `).get(
    projectionId,
    namespaceKey,
    ...namespaceColumns,
    input.class,
    JSON.stringify(mergedIds),
    summaryForDb,
    contentJsonForDb,
    contentHashForDb,
    originForDb,
    createdAt,
    updatedAt,
    fingerprint,
  ) as { id: string; source_event_ids_json: string; summary: string; content_json: string; content_hash: string | null; origin: string | null; created_at: number; updated_at: number };
  const returnedIds = parseJson<string[]>(row.source_event_ids_json, mergedIds);
  const returnedOrigin = isMemoryOrigin(row.origin) ? row.origin : originForDb;
  syncProjectionSourcesForDb(database, row.id, returnedIds);
  upsertProjectionObservationForDb(database, {
    namespace: canonicalNamespace,
    projectionId: row.id,
    projectionClass: input.class,
    sourceEventIds: returnedIds,
    summary: row.summary,
    content: parseJson<Record<string, unknown>>(row.content_json, contentForDb),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    fingerprint,
    origin: returnedOrigin,
  });
  return {
    id: row.id,
    namespace: canonicalNamespace,
    class: input.class,
    origin: returnedOrigin,
    sourceEventIds: returnedIds,
    summary: row.summary,
    content: parseJson<Record<string, unknown>>(row.content_json, contentForDb),
    contentHash: typeof row.content_hash === 'string' && row.content_hash ? row.content_hash : contentHashForDb,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function writeProcessedProjection(input: WriteProcessedProjectionInput): ProcessedContextProjection {
  const database = ensureDb();

  // The explicit-id and fingerprint-upsert paths keep separate busy-retry
  // counters/warnings so their telemetry sources stay distinct, but both run
  // the same transaction-free body via writeProcessedProjectionForDb.
  if (input.id) {
    let lastExplicitBusyError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        database.exec('BEGIN IMMEDIATE');
        const projection = writeProcessedProjectionForDb(database, input);
        database.exec('COMMIT');
        return projection;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* ignore */ }
        if (!isSqliteBusy(error)) throw error;
        lastExplicitBusyError = error;
        if (attempt === 2) break;
        sleepSync(25 * (attempt + 1));
      }
    }
    incrementCounter('mem.write.retry_exhausted', { source: 'writeProcessedProjection.explicit_id' });
    warnOncePerHour('writeProcessedProjection.explicit_id.sqlite_busy', { error: lastExplicitBusyError instanceof Error ? lastExplicitBusyError.message : String(lastExplicitBusyError) });
    throw lastExplicitBusyError instanceof Error ? lastExplicitBusyError : new Error(String(lastExplicitBusyError));
  }

  let lastBusyError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      database.exec('BEGIN IMMEDIATE');
      const projection = writeProcessedProjectionForDb(database, input);
      database.exec('COMMIT');
      return projection;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* ignore */ }
      if (!isSqliteBusy(error)) throw error;
      lastBusyError = error;
      if (attempt === 2) break;
      sleepSync(25 * (attempt + 1));
    }
  }
  incrementCounter('mem.write.retry_exhausted', { source: 'writeProcessedProjection' });
  warnOncePerHour('writeProcessedProjection.sqlite_busy', { error: lastBusyError instanceof Error ? lastBusyError.message : String(lastBusyError) });
  throw lastBusyError instanceof Error ? lastBusyError : new Error(String(lastBusyError));
}

export type WriteProcessedProjectionInput = Omit<ProcessedContextProjection, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<ProcessedContextProjection, 'id' | 'createdAt' | 'updatedAt'>>;

export interface MaterializationCommitInput {
  archiveEvents: LocalContextEvent[];
  archivedAt: number;
  summaryProjection: WriteProcessedProjectionInput;
  durableProjection?: WriteProcessedProjectionInput;
  /** The freshly-written summary (and durable) projection ids are APPENDED to
   *  `priorPendingProjectionIds` inside the transaction (their ids are generated
   *  during the write, so the caller cannot know them up front). */
  replication: {
    namespace: ContextNamespace;
    priorPendingProjectionIds: string[];
    lastReplicatedAt?: number;
    lastError?: string;
  };
  deleteStagedEventIds: string[];
  completeJobId: string;
  completedAt: number;
  clearDirty: ContextTargetRef;
}

export interface MaterializationCommitResult {
  summaryProjection: ProcessedContextProjection;
  durableProjection?: ProcessedContextProjection;
}

/** Run the post-SDK materialization commit bundle as ONE atomic transaction:
 *  archive events + write summary projection (+ optional durable) + set
 *  replication state + delete staged events + complete job + clear dirty. A
 *  crash mid-bundle leaves NO half-committed state (no duplicate projection,
 *  no lost/orphaned staged events). `compressWithSdk` runs BEFORE this, outside
 *  any transaction. */
export function commitMaterialization(input: MaterializationCommitInput): MaterializationCommitResult {
  const database = ensureDb();
  let lastBusyError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      database.exec('BEGIN IMMEDIATE');
      archiveEventsForMaterializationForDb(database, input.archiveEvents, input.archivedAt);
      const summary = writeProcessedProjectionForDb(database, input.summaryProjection);
      const durable = input.durableProjection ? writeProcessedProjectionForDb(database, input.durableProjection) : undefined;
      const pendingProjectionIds = Array.from(new Set([
        ...input.replication.priorPendingProjectionIds,
        summary.id,
        ...(durable ? [durable.id] : []),
      ]));
      setReplicationStateForDb(database, input.replication.namespace, {
        pendingProjectionIds,
        lastReplicatedAt: input.replication.lastReplicatedAt,
        lastError: input.replication.lastError,
      });
      deleteStagedEventsByIdsForDb(database, input.deleteStagedEventIds);
      updateContextJobForDb(database, input.completeJobId, 'completed', { now: input.completedAt });
      clearDirtyTargetForDb(database, input.clearDirty);
      database.exec('COMMIT');
      return { summaryProjection: summary, durableProjection: durable };
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* ignore */ }
      if (!isSqliteBusy(error)) throw error;
      lastBusyError = error;
      if (attempt === 2) break;
      sleepSync(25 * (attempt + 1));
    }
  }
  incrementCounter('mem.write.retry_exhausted', { source: 'commitMaterialization' });
  warnOncePerHour('commitMaterialization.sqlite_busy', { error: lastBusyError instanceof Error ? lastBusyError.message : String(lastBusyError) });
  throw lastBusyError instanceof Error ? lastBusyError : new Error(String(lastBusyError));
}

export function ensureContextNamespace(input: CanonicalNamespaceInput | ContextNamespace, now = Date.now()): ContextNamespaceRow {
  const database = ensureDb();
  return ensureContextNamespaceForDb(database, input, now);
}

export function listContextNamespaces(filters: {
  scope?: MemoryScope;
  userId?: string;
  projectId?: string;
  rootSessionId?: string;
  sessionTreeId?: string;
} = {}): ContextNamespaceRow[] {
  const database = ensureDb();
  const rows = database.prepare('SELECT * FROM context_namespaces ORDER BY created_at ASC, id ASC').all() as Array<Record<string, unknown>>;
  return rows
    .map(namespaceRowFromDb)
    .filter((row) => !filters.scope || row.scope === filters.scope)
    .filter((row) => !filters.userId || row.userId === filters.userId)
    .filter((row) => !filters.projectId || row.projectId === filters.projectId)
    .filter((row) => !filters.rootSessionId || row.rootSessionId === filters.rootSessionId)
    .filter((row) => !filters.sessionTreeId || row.sessionTreeId === filters.sessionTreeId);
}

export function writeContextObservation(input: ContextObservationInput): ContextObservationRow {
  const database = ensureDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = upsertContextObservationForDb(database, input);
    database.exec('COMMIT');
    return row;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

export function listContextObservations(filters: {
  namespaceId?: string;
  scope?: MemoryScope;
  class?: ObservationClass;
  state?: ObservationState | readonly ObservationState[];
  projectionId?: string;
} = {}): ContextObservationRow[] {
  const database = ensureDb();
  const rows = database.prepare('SELECT * FROM context_observations ORDER BY updated_at DESC, id ASC').all() as Array<Record<string, unknown>>;
  const states = Array.isArray(filters.state) ? new Set(filters.state) : undefined;
  const state = typeof filters.state === 'string' ? filters.state : undefined;
  return rows
    .map(observationRowFromDb)
    .filter((row) => !filters.namespaceId || row.namespaceId === filters.namespaceId)
    .filter((row) => !filters.scope || row.scope === filters.scope)
    .filter((row) => !filters.class || row.class === filters.class)
    .filter((row) => !filters.state || (states ? states.has(row.state) : row.state === state))
    .filter((row) => !filters.projectionId || row.projectionId === filters.projectionId);
}

export function listStartupContextObservations(namespaceIds: readonly string[], limit: number): ContextObservationRow[] {
  const ids = [...new Set(namespaceIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const safeLimit = Math.max(0, Math.min(100, Math.floor(limit)));
  if (ids.length === 0 || safeLimit === 0) return [];
  const database = ensureDb();
  const rows: ContextObservationRow[] = [];
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const chunkRows = database.prepare(`
      SELECT *
        FROM context_observations
       WHERE namespace_id IN (${placeholders})
         AND state IN ('active', 'promoted')
         AND projection_id IS NULL
         AND class <> 'skill_candidate'
       ORDER BY updated_at DESC, id ASC
       LIMIT ?
    `).all(...chunk, safeLimit) as Array<Record<string, unknown>>;
    rows.push(...chunkRows.map(observationRowFromDb));
  }
  return rows
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, safeLimit);
}

export function getContextObservationById(id: string): ContextObservationRow | null {
  const database = ensureDb();
  const row = database.prepare('SELECT * FROM context_observations WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? observationRowFromDb(row) : null;
}

export function updateContextObservationText(input: {
  observationId: string;
  text: string;
  fingerprint?: string;
  observationClass?: ObservationClass;
  ownerUserId?: string;
  createdByUserId?: string;
  updatedByUserId?: string;
  now?: number;
}): ContextObservationRow | null {
  const database = ensureDb();
  const now = input.now ?? Date.now();
  const text = input.text.trim();
  if (!text) throw new Error('observation text is required');
  database.exec('BEGIN IMMEDIATE');
  try {
    const existingRow = database.prepare('SELECT * FROM context_observations WHERE id = ?')
      .get(input.observationId) as Record<string, unknown> | undefined;
    if (!existingRow) {
      database.exec('COMMIT');
      return null;
    }
    const existing = observationRowFromDb(existingRow);
    const observationClass = input.observationClass ?? existing.class;
    const content = {
      ...existing.content,
      text,
      ...(input.ownerUserId && typeof existing.content.ownerUserId !== 'string' ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.createdByUserId && typeof existing.content.createdByUserId !== 'string' ? { createdByUserId: input.createdByUserId } : {}),
      ...(input.updatedByUserId ? { updatedByUserId: input.updatedByUserId } : {}),
    };
    const fingerprint = input.fingerprint ?? existing.fingerprint;
    const textHash = computeObservationTextHash(text);
    assertValidObservationInput({
      namespaceId: existing.namespaceId,
      scope: existing.scope,
      class: observationClass,
      origin: existing.origin,
      fingerprint,
      content,
      text,
      textHash,
      sourceEventIds: existing.sourceEventIds,
      projectionId: existing.projectionId,
      state: existing.state,
      confidence: existing.confidence,
    });
    const conflict = database.prepare(`
      SELECT id FROM context_observations
      WHERE namespace_id = ? AND class = ? AND fingerprint = ? AND text_hash = ? AND id <> ?
      LIMIT 1
    `).get(existing.namespaceId, observationClass, fingerprint, textHash, input.observationId) as { id: string } | undefined;
    if (conflict) throw new Error(`observation update conflicts with existing observation ${conflict.id}`);
    database.prepare(`
      UPDATE context_observations
      SET class = ?, fingerprint = ?, content_json = ?, text_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(observationClass, fingerprint, JSON.stringify(content), textHash, now, input.observationId);
    if (existing.projectionId) {
      const projection = database.prepare(`
        SELECT id, namespace_key, class, content_json, summary_fingerprint
        FROM context_processed_local
        WHERE id = ?
      `).get(existing.projectionId) as {
        id: string;
        namespace_key: string;
        class: string;
        content_json: string;
        summary_fingerprint: string | null;
      } | undefined;
      if (projection) {
        const projectionContent = parseJson<Record<string, unknown>>(projection.content_json, {});
        const nextProjectionContent = {
          ...projectionContent,
          text,
          summary: text,
          ...(input.ownerUserId && typeof projectionContent.ownerUserId !== 'string' ? { ownerUserId: input.ownerUserId } : {}),
          ...(input.createdByUserId && typeof projectionContent.createdByUserId !== 'string' ? { createdByUserId: input.createdByUserId } : {}),
          ...(input.updatedByUserId ? { updatedByUserId: input.updatedByUserId } : {}),
        };
        const nextSummaryFingerprint = projection.summary_fingerprint ? projectionFingerprint(text) : null;
        if (nextSummaryFingerprint) {
          const projectionConflict = database.prepare(`
            SELECT id FROM context_processed_local
            WHERE namespace_key = ? AND class = ? AND summary_fingerprint = ? AND id <> ?
            LIMIT 1
          `).get(projection.namespace_key, projection.class, nextSummaryFingerprint, projection.id) as { id: string } | undefined;
          if (projectionConflict) throw new Error(`projection update conflicts with existing projection ${projectionConflict.id}`);
        }
        database.prepare(`
          UPDATE context_processed_local
          SET summary = ?,
              content_json = ?,
              content_hash = ?,
              updated_at = ?,
              summary_fingerprint = ?,
              embedding = NULL,
              embedding_source = NULL
          WHERE id = ?
        `).run(
          text,
          JSON.stringify(nextProjectionContent),
          projectionContentHash(text, nextProjectionContent),
          now,
          nextSummaryFingerprint,
          projection.id,
        );
      }
    }
    const updatedRow = database.prepare('SELECT * FROM context_observations WHERE id = ?')
      .get(input.observationId) as Record<string, unknown> | undefined;
    database.exec('COMMIT');
    return updatedRow ? observationRowFromDb(updatedRow) : null;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

export function updateProcessedProjectionSummary(input: {
  projectionId: string;
  summary: string;
  ownerUserId?: string;
  createdByUserId?: string;
  updatedByUserId?: string;
  now?: number;
}): ProcessedContextProjection | null {
  const database = ensureDb();
  const now = input.now ?? Date.now();
  const summary = input.summary.trim();
  if (!summary) throw new Error('memory summary is required');
  database.exec('BEGIN IMMEDIATE');
  try {
    const existingRow = database.prepare('SELECT * FROM context_processed_local WHERE id = ?')
      .get(input.projectionId) as Record<string, unknown> | undefined;
    if (!existingRow) {
      database.exec('COMMIT');
      return null;
    }
    const projectionClass = String(existingRow.class) as ProcessedContextClass;
    const namespaceKey = String(existingRow.namespace_key);
    const priorContent = parseJson<Record<string, unknown>>(existingRow.content_json, {});
    const nextContent = {
      ...priorContent,
      summary,
      text: summary,
      manuallyEdited: true,
      ...(input.ownerUserId && typeof priorContent.ownerUserId !== 'string' ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.createdByUserId && typeof priorContent.createdByUserId !== 'string' ? { createdByUserId: input.createdByUserId } : {}),
      ...(input.updatedByUserId ? { updatedByUserId: input.updatedByUserId } : {}),
    };
    const nextSummaryFingerprint = typeof existingRow.summary_fingerprint === 'string' && existingRow.summary_fingerprint
      ? projectionFingerprint(summary)
      : null;
    if (nextSummaryFingerprint) {
      const conflict = database.prepare(`
        SELECT id FROM context_processed_local
        WHERE namespace_key = ? AND class = ? AND summary_fingerprint = ? AND id <> ?
        LIMIT 1
      `).get(namespaceKey, projectionClass, nextSummaryFingerprint, input.projectionId) as { id: string } | undefined;
      if (conflict) throw new Error(`projection update conflicts with existing projection ${conflict.id}`);
    }
    const nextContentJson = JSON.stringify(nextContent);
    database.prepare(`
      UPDATE context_processed_local
      SET summary = ?,
          content_json = ?,
          content_hash = ?,
          updated_at = ?,
          summary_fingerprint = ?,
          embedding = NULL,
          embedding_source = NULL
      WHERE id = ?
    `).run(
      summary,
      nextContentJson,
      projectionContentHash(summary, nextContent),
      now,
      nextSummaryFingerprint,
      input.projectionId,
    );

    const observationRows = database.prepare('SELECT * FROM context_observations WHERE projection_id = ?')
      .all(input.projectionId) as Array<Record<string, unknown>>;
    for (const observationRow of observationRows) {
      const observation = observationRowFromDb(observationRow);
      const nextObservationContent = {
        ...observation.content,
        summary,
        text: summary,
        projectionClass,
        ...(input.ownerUserId && typeof observation.content.ownerUserId !== 'string' ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.createdByUserId && typeof observation.content.createdByUserId !== 'string' ? { createdByUserId: input.createdByUserId } : {}),
        ...(input.updatedByUserId ? { updatedByUserId: input.updatedByUserId } : {}),
      };
      const observationFingerprint = projectionFingerprint(summary);
      const textHash = computeObservationTextHash(summary);
      const conflict = database.prepare(`
        SELECT id FROM context_observations
        WHERE namespace_id = ? AND class = ? AND fingerprint = ? AND text_hash = ? AND id <> ?
        LIMIT 1
      `).get(observation.namespaceId, observation.class, observationFingerprint, textHash, observation.id) as { id: string } | undefined;
      if (conflict) throw new Error(`observation update conflicts with existing observation ${conflict.id}`);
      database.prepare(`
        UPDATE context_observations
        SET fingerprint = ?, content_json = ?, text_hash = ?, updated_at = ?
        WHERE id = ?
      `).run(observationFingerprint, JSON.stringify(nextObservationContent), textHash, now, observation.id);
    }

    const updatedRow = database.prepare('SELECT * FROM context_processed_local WHERE id = ?')
      .get(input.projectionId) as Record<string, unknown> | undefined;
    database.exec('COMMIT');
    return updatedRow ? processedProjectionFromRow(updatedRow) : null;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

export function promoteContextObservation(input: {
  observationId: string;
  actorId: string;
  action: 'web_ui_promote' | 'cli_mem_promote' | 'admin_api_promote';
  toScope: MemoryScope;
  reason?: string;
  actorRole?: 'user' | 'workspace_admin' | 'org_admin';
  expectedFromScope?: MemoryScope;
  now?: number;
}): ObservationPromotionAuditRow {
  const database = ensureDb();
  const now = input.now ?? Date.now();
  if (!OBSERVATION_PROMOTION_ACTIONS.has(input.action)) {
    throw new Error(`unauthorized observation promotion action: ${String(input.action)}`);
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const observation = database.prepare('SELECT * FROM context_observations WHERE id = ?').get(input.observationId) as Record<string, unknown> | undefined;
    if (!observation) throw new Error('observation not found');
    const fromScope = String(observation.scope);
    if (!isMemoryScope(fromScope)) throw new Error(`invalid observation scope: ${fromScope}`);
    if (input.expectedFromScope && fromScope !== input.expectedFromScope) {
      throw new Error(`observation scope changed from expected ${input.expectedFromScope} to ${fromScope}`);
    }
    if (isOwnerPrivateMemoryScope(fromScope) && isSharedProjectionScope(input.toScope) && input.actorRole !== 'workspace_admin' && input.actorRole !== 'org_admin') {
      incrementCounter('mem.observation.cross_scope_promotion_blocked', { source: input.action });
      throw new Error(`promotion from ${fromScope} to ${input.toScope} requires administrator authorization`);
    }
    if (!canPromoteScope(fromScope, input.toScope, true)) {
      throw new Error(`promotion from ${fromScope} to ${input.toScope} is not allowed`);
    }
    const auditId = randomUUID();
    database.prepare(`
      INSERT INTO observation_promotion_audit (id, observation_id, actor_id, action, from_scope, to_scope, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(auditId, input.observationId, input.actorId, input.action, fromScope, input.toScope, input.reason ?? null, now);
    database.prepare('UPDATE context_observations SET state = ?, promoted_at = ?, updated_at = ? WHERE id = ?')
      .run('promoted', now, now, input.observationId);
    database.exec('COMMIT');
    return {
      id: auditId,
      observationId: input.observationId,
      actorId: input.actorId,
      action: input.action,
      fromScope,
      toScope: input.toScope,
      reason: input.reason,
      createdAt: now,
    };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

export function rejectAutomaticObservationPromotion(fromScope: MemoryScope, toScope: MemoryScope): void {
  if (!canPromoteScope(fromScope, toScope, false)) {
    throw new Error(`automatic promotion from ${fromScope} to ${toScope} is forbidden`);
  }
}

export function listObservationPromotionAudits(observationId?: string): ObservationPromotionAuditRow[] {
  const database = ensureDb();
  const rows = observationId
    ? database.prepare('SELECT * FROM observation_promotion_audit WHERE observation_id = ? ORDER BY created_at ASC').all(observationId)
    : database.prepare('SELECT * FROM observation_promotion_audit ORDER BY created_at ASC').all();
  return (rows as Array<Record<string, unknown>>).map(auditRowFromDb);
}
export function deleteContextObservation(observationId: string): boolean {
  const database = ensureDb();
  const result = database.prepare('DELETE FROM context_observations WHERE id = ?').run(observationId);
  return ((result as { changes: number }).changes ?? 0) > 0;
}


export interface ObservationRepairStats {
  namespacesBackfilled: number;
  observationsBackfilled: number;
  orphanProjectionSourcesRepaired: number;
}

function backfillNamespacesAndObservationsForDb(
  database: DatabaseSyncInstance,
  options: { limit?: number; now?: number } = {},
): ObservationRepairStats {
  const now = options.now ?? Date.now();
  const safeLimit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 1000)));
  const projectionRows = database.prepare(`
    SELECT id, namespace_key, class, source_event_ids_json, summary, content_json, origin, created_at, updated_at, summary_fingerprint
    FROM context_processed_local
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(safeLimit) as Array<Record<string, unknown>>;
  let namespacesBackfilled = 0;
  let observationsBackfilled = 0;
  for (const row of projectionRows) {
    const beforeNamespaceCount = (database.prepare('SELECT COUNT(*) AS count FROM context_namespaces').get() as { count: number }).count;
    const namespace = parseNamespaceKey(String(row.namespace_key));
    const namespaceRow = ensureContextNamespaceForDb(database, namespace, now);
    const afterNamespaceCount = (database.prepare('SELECT COUNT(*) AS count FROM context_namespaces').get() as { count: number }).count;
    if (afterNamespaceCount > beforeNamespaceCount) namespacesBackfilled += 1;
    const content = parseJson<Record<string, unknown>>(row.content_json, {});
    const origin = isMemoryOrigin(row.origin) ? row.origin : inferObservationOrigin(content, 'chat_compacted');
    const beforeObservationCount = (database.prepare('SELECT COUNT(*) AS count FROM context_observations').get() as { count: number }).count;
    upsertProjectionObservationForDb(database, {
      namespace,
      projectionId: String(row.id),
      projectionClass: String(row.class) as ProcessedContextClass,
      sourceEventIds: parseJson<string[]>(row.source_event_ids_json, []),
      summary: String(row.summary),
      content,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      fingerprint: typeof row.summary_fingerprint === 'string' && row.summary_fingerprint
        ? row.summary_fingerprint
        : projectionFingerprint(String(row.summary)),
      origin,
    });
    const afterObservationCount = (database.prepare('SELECT COUNT(*) AS count FROM context_observations').get() as { count: number }).count;
    if (afterObservationCount > beforeObservationCount) observationsBackfilled += 1;
    // namespaceRow is intentionally touched so backfill validates the legacy
    // row's policy binding; old personal rows remain personal/project-bound.
    void namespaceRow;
  }
  if (projectionRows.length < safeLimit) {
    internalSetContextMeta(database, 'migration_namespace_observation_backfilled', '1', now);
  }
  return { namespacesBackfilled, observationsBackfilled, orphanProjectionSourcesRepaired: 0 };
}

function repairObservationStoreForDb(
  database: DatabaseSyncInstance,
  options: { limit?: number; now?: number } = {},
): ObservationRepairStats {
  const stats = backfillNamespacesAndObservationsForDb(database, options);
  const now = options.now ?? Date.now();
  const sourceRows = database.prepare(`
    SELECT id, source_event_ids_json FROM context_processed_local
    WHERE id NOT IN (SELECT DISTINCT projection_id FROM context_projection_sources WHERE projection_id IS NOT NULL)
    LIMIT ?
  `).all(Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 1000)))) as Array<{ id: string; source_event_ids_json: string }>;
  let orphanProjectionSourcesRepaired = 0;
  for (const row of sourceRows) {
    const sourceIds = parseJson<string[]>(row.source_event_ids_json, []);
    if (sourceIds.length === 0) continue;
    syncProjectionSourcesForDb(database, row.id, sourceIds);
    orphanProjectionSourcesRepaired += 1;
  }
  internalSetContextMeta(database, 'last_observation_repair_at', String(now), now);
  return {
    ...stats,
    orphanProjectionSourcesRepaired,
  };
}

export function backfillNamespacesAndObservations(options: { limit?: number; now?: number } = {}): ObservationRepairStats {
  const database = ensureDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const stats = backfillNamespacesAndObservationsForDb(database, options);
    database.exec('COMMIT');
    return stats;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

export function repairObservationStore(options: { limit?: number; now?: number } = {}): ObservationRepairStats {
  const database = ensureDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const stats = repairObservationStoreForDb(database, options);
    database.exec('COMMIT');
    return stats;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

// ── Persistent per-projection embeddings ──────────────────────────────────────
//
// The daemon-side recall path used to recompute a Float32Array for every
// candidate's summary on every query (~7 ms × 40 candidates = ~300 ms of pure
// model inference per recall). The server side already stores embeddings
// in pgvector; the daemon needs the same treatment against local SQLite.
//
// These helpers take opaque BLOBs — the embedding.ts module owns encoding
// via encodeEmbedding / decodeEmbedding so the store layer does not depend
// on the model implementation.

export interface ProjectionEmbeddingRow {
  id: string;
  summary: string;
  embedding: Buffer | null;
  /** Summary text used when `embedding` was computed, for staleness checks. */
  embeddingSource: string | null;
}

/** Read the stored embedding BLOB and its source text for a single projection.
 *  Returns `undefined` when the row does not exist. */
export function getProjectionEmbedding(projectionId: string): ProjectionEmbeddingRow | undefined {
  const database = ensureDb();
  const row = database.prepare(
    'SELECT id, summary, embedding, embedding_source FROM context_processed_local WHERE id = ?',
  ).get(projectionId) as
    | { id: string; summary: string; embedding: Buffer | Uint8Array | null; embedding_source: string | null }
    | undefined;
  if (!row) return undefined;
  const embedding = row.embedding == null
    ? null
    : Buffer.isBuffer(row.embedding)
      ? row.embedding
      : Buffer.from(row.embedding);
  return { id: row.id, summary: row.summary, embedding, embeddingSource: row.embedding_source };
}

/** Persist a freshly-computed embedding for an existing projection row.
 *  `source` is the exact text that was embedded — a later write that changes
 *  the summary text invalidates this row on read via the staleness check. */
export function saveProjectionEmbedding(
  projectionId: string,
  embedding: Buffer,
  source: string,
): void {
  const database = ensureDb();
  database.prepare(
    'UPDATE context_processed_local SET embedding = ?, embedding_source = ? WHERE id = ?',
  ).run(embedding, source, projectionId);
}

/** Read stored embeddings for many projections in one query.
 *  Returns a map keyed by projection id; rows with no stored embedding have
 *  `embedding: null` so the caller can lazy-fill them. */
export function getProjectionEmbeddings(projectionIds: string[]): Map<string, ProjectionEmbeddingRow> {
  if (projectionIds.length === 0) return new Map();
  const database = ensureDb();
  const placeholders = projectionIds.map(() => '?').join(',');
  const rows = database.prepare(
    `SELECT id, summary, embedding, embedding_source
       FROM context_processed_local
      WHERE id IN (${placeholders})`,
  ).all(...projectionIds) as Array<{
    id: string;
    summary: string;
    embedding: Buffer | Uint8Array | null;
    embedding_source: string | null;
  }>;
  const out = new Map<string, ProjectionEmbeddingRow>();
  for (const row of rows) {
    const embedding = row.embedding == null
      ? null
      : Buffer.isBuffer(row.embedding)
        ? row.embedding
        : Buffer.from(row.embedding);
    out.set(row.id, { id: row.id, summary: row.summary, embedding, embeddingSource: row.embedding_source });
  }
  return out;
}

/** A projection row that still needs an embedding computed, with just the
 *  fields the backfill needs to derive the embed-source text. */
export interface ProjectionMissingEmbeddingRow {
  id: string;
  namespace: ContextNamespace;
  summary: string;
  content: Record<string, unknown>;
}

/** List projections that have no persisted embedding yet, newest first.
 *  Drives the one-time startup backfill so the recall hot path can rely on
 *  pre-computed candidate vectors instead of recomputing during recall. */
export function listProjectionsMissingEmbedding(limit: number): ProjectionMissingEmbeddingRow[] {
  const database = ensureDb();
  const rows = database.prepare(
    `SELECT id, namespace_key, summary, content_json
       FROM context_processed_local
      WHERE embedding IS NULL
      ORDER BY updated_at DESC
      LIMIT ?`,
  ).all(limit) as Array<{ id: string; namespace_key: string; summary: string; content_json: string | null }>;
  return rows.map((row) => ({
    id: row.id,
    namespace: parseNamespaceKey(String(row.namespace_key)),
    summary: row.summary,
    content: parseJson<Record<string, unknown>>(row.content_json, {}),
  }));
}

/** Count projections with no persisted embedding. Cheap aggregate (no row
 *  materialization) — used by the backfill to report accurate `remaining`. */
export function countProjectionsMissingEmbedding(): number {
  const database = ensureDb();
  const row = database.prepare(
    'SELECT COUNT(*) AS n FROM context_processed_local WHERE embedding IS NULL',
  ).get() as { n: number } | undefined;
  return row?.n ?? 0;
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
    origin: isMemoryOrigin(row.origin) ? row.origin : undefined,
    sourceEventIds: parseJson<string[]>(row.source_event_ids_json, []),
    summary: String(row.summary),
    content: parseJson<Record<string, unknown>>(row.content_json, {}),
    contentHash: typeof row.content_hash === 'string' && row.content_hash ? row.content_hash : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    hitCount: typeof row.hit_count === 'number' ? row.hit_count : 0,
    lastUsedAt: typeof row.last_used_at === 'number' ? row.last_used_at : undefined,
    status: typeof row.status === 'string' ? row.status as ProcessedContextProjectionStatus : 'active',
  })).filter((projection) => !isMemoryNoiseSummary(projection.summary));
}

export function hasProcessedProjectionsInNamespace(namespace: ContextNamespace): boolean {
  const database = ensureDb();
  const namespaceKey = serializeContextNamespace(namespace);
  const rows = database.prepare(`
    SELECT summary
      FROM context_processed_local
     WHERE namespace_key = ?
     ORDER BY updated_at DESC
  `).all(namespaceKey) as Array<{ summary?: string }>;
  return rows.some((row) => !isMemoryNoiseSummary(row.summary));
}

export function listProcessedProjectionsByIds(namespace: ContextNamespace, projectionIds: readonly string[]): ProcessedContextProjection[] {
  if (projectionIds.length === 0) return [];
  const database = ensureDb();
  const namespaceKey = serializeContextNamespace(namespace);
  const orderedIds = [...new Set(projectionIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const byId = new Map<string, ProcessedContextProjection>();
  const chunkSize = 500;
  for (let i = 0; i < orderedIds.length; i += chunkSize) {
    const chunk = orderedIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = database.prepare(
      `SELECT * FROM context_processed_local WHERE namespace_key = ? AND id IN (${placeholders})`,
    ).all(namespaceKey, ...chunk) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const projection = processedProjectionFromRow(row, namespace);
      if (!isMemoryNoiseSummary(projection.summary)) byId.set(projection.id, projection);
    }
  }
  return orderedIds.flatMap((id) => {
    const projection = byId.get(id);
    return projection ? [projection] : [];
  });
}

export function getLatestRecentSummaryUpdatedAtForTarget(target: ContextTargetRef): number | undefined {
  const database = ensureDb();
  const namespaceKey = serializeContextNamespace(target.namespace);
  let rows: Array<Record<string, unknown>>;
  if (target.kind === 'project') {
    rows = database.prepare(`
        SELECT updated_at, summary
          FROM context_processed_local
         WHERE namespace_key = ?
           AND class = 'recent_summary'
           AND status NOT IN ('archived', 'archived_dedup')
           AND json_extract(content_json, '$.targetKind') = 'project'
         ORDER BY updated_at DESC
      `).all(namespaceKey) as Array<Record<string, unknown>>;
  } else {
    const sessionName = target.sessionName;
    if (!sessionName) return undefined;
    rows = database.prepare(`
        SELECT updated_at, summary
          FROM context_processed_local
         WHERE namespace_key = ?
           AND class = 'recent_summary'
           AND status NOT IN ('archived', 'archived_dedup')
           AND json_extract(content_json, '$.targetKind') = 'session'
           AND json_extract(content_json, '$.sessionName') = ?
         ORDER BY updated_at DESC
      `).all(namespaceKey, sessionName) as Array<Record<string, unknown>>;
  }
  for (const row of rows as Array<{ updated_at: unknown; summary: unknown }>) {
    if (isMemoryNoiseSummary(typeof row.summary === 'string' ? row.summary : undefined)) continue;
    const updatedAt = Number(row.updated_at);
    if (Number.isFinite(updatedAt)) return updatedAt;
  }
  return undefined;
}

export interface LatestRecentSummarySession {
  sessionName: string;
  namespace: ContextNamespace;
  updatedAt: number;
}

export function listLatestRecentSummarySessions(limit = 1000): LatestRecentSummarySession[] {
  const safeLimit = Math.max(0, Math.min(5000, Math.floor(limit)));
  if (safeLimit === 0) return [];
  const database = ensureDb();
  const rows = database.prepare(`
    SELECT namespace_key,
           summary,
           json_extract(content_json, '$.sessionName') AS session_name,
           updated_at
      FROM context_processed_local
     WHERE class = 'recent_summary'
       AND status NOT IN ('archived', 'archived_dedup')
       AND json_extract(content_json, '$.sessionName') IS NOT NULL
     ORDER BY updated_at DESC
  `).all() as Array<Record<string, unknown>>;
  const result: LatestRecentSummarySession[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (isMemoryNoiseSummary(typeof row.summary === 'string' ? row.summary : undefined)) continue;
    const sessionName = typeof row.session_name === 'string' ? row.session_name : undefined;
    const updatedAt = Number(row.updated_at);
    if (!sessionName || !Number.isFinite(updatedAt)) continue;
    const namespaceKey = String(row.namespace_key);
    const key = `${namespaceKey}\0${sessionName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      sessionName,
      namespace: parseNamespaceKey(namespaceKey),
      updatedAt,
    });
    if (result.length >= safeLimit) break;
  }
  return result;
}

export function getLatestMasterSummaryUpdatedAt(sessionName: string, namespace: ContextNamespace): number | undefined {
  const database = ensureDb();
  const namespaceKey = serializeContextNamespace(namespace);
  const rows = database.prepare(`
    SELECT updated_at, summary
      FROM context_processed_local
     WHERE namespace_key = ?
       AND class = 'master_summary'
       AND status NOT IN ('archived', 'archived_dedup')
       AND json_extract(content_json, '$.sessionName') = ?
     ORDER BY updated_at DESC
  `).all(namespaceKey, sessionName) as Array<{ updated_at?: number; summary?: string }>;
  for (const row of rows) {
    if (isMemoryNoiseSummary(row.summary)) continue;
    const updatedAt = Number(row.updated_at);
    if (Number.isFinite(updatedAt)) return updatedAt;
  }
  return undefined;
}

/** Returns a map of namespace_key → projection IDs for all local projections. */
export function listAllProcessedProjectionsByNamespace(): Map<string, string[]> {
  const database = ensureDb();
  const rows = database.prepare('SELECT namespace_key, id FROM context_processed_local').all() as Array<{ namespace_key: string; id: string }>;
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const ids = result.get(row.namespace_key) ?? [];
    ids.push(row.id);
    result.set(row.namespace_key, ids);
  }
  return result;
}

export interface ProcessedProjectionQuery {
  scope?: ContextScope | MemoryScope;
  enterpriseId?: string;
  workspaceId?: string;
  userId?: string;
  projectId?: string;
  /**
   * Explicit management/read compatibility for legacy local personal rows that
   * were written before durable owner ids were available. This widens only
   * `personal` owner matching to include missing/daemon-local owners; different
   * real users remain excluded.
   */
  includeLegacyPersonalOwner?: boolean;
  projectionClass?: ProcessedContextClass;
  query?: string;
  limit?: number;
  includeArchived?: boolean;
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
  const normalizedQuery = filters.query?.trim().toLowerCase() ?? '';

  const limit = typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 50;

  // Build indexed WHERE predicates. Namespace filter columns are denormalized
  // from namespace_key so owner/project management queries do not have to scan
  // every row and then parse/filter in JS.
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (!filters.includeArchived) {
    conditions.push("status = 'active'");
  }

  appendNamespaceFilterSql(conditions, params, filters);

  if (filters.projectionClass) {
    conditions.push('class = ?');
    params.push(filters.projectionClass);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // Apply pagination after all namespace/query/noise filters. The previous
  // limit-before-filter shape could hide older matching project rows behind
  // newer rows from other projects and made exact projection/source lookups
  // unreliable for privacy-safe read tools.
  const sql = `SELECT * FROM context_processed_local ${where} ORDER BY updated_at DESC`;
  const rows = database.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  const filtered = rows
    .map((row) => {
      const namespace = parseNamespaceKey(String(row.namespace_key));
      return {
        id: String(row.id),
        namespace,
        class: String(row.class) as ProcessedContextClass,
        origin: isMemoryOrigin(row.origin) ? row.origin : undefined,
        sourceEventIds: parseJson<string[]>(row.source_event_ids_json, []),
        summary: String(row.summary),
        content: parseJson<Record<string, unknown>>(row.content_json, {}),
        contentHash: typeof row.content_hash === 'string' && row.content_hash ? row.content_hash : undefined,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        hitCount: typeof row.hit_count === 'number' ? row.hit_count : 0,
        lastUsedAt: typeof row.last_used_at === 'number' ? row.last_used_at : undefined,
        status: typeof row.status === 'string' ? row.status as ProcessedContextProjectionStatus : 'active',
      } satisfies ProcessedContextProjection;
    })
    .filter((projection) => {
      // Namespace + class JS filters — applied regardless of SQL predicate coverage.
      if (!namespaceMatchesFilters(projection.namespace, filters)) return false;
      // Class was already in SQL (when provided); still safe to double-check.
      if (filters.projectionClass && projection.class !== filters.projectionClass) return false;
      if (isMemoryNoiseSummary(projection.summary)) return false;
      if (normalizedQuery) {
        const haystack = `${projection.summary}\n${JSON.stringify(projectionSemanticContent(projection.content))}`;
        if (!memoryTextMatchesQuery(haystack, normalizedQuery)) return false;
      }
      return true;
    });

  return filtered.slice(0, limit);
}

/** Increment hit_count and update last_used_at for a list of recalled projection IDs. */
export function recordMemoryHits(ids: string[]): void {
  if (ids.length === 0) return;
  const database = ensureDb();
  const now = Date.now();
  const stmt = database.prepare('UPDATE context_processed_local SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?');
  for (const id of ids) {
    stmt.run(now, id);
  }
}

export function getProcessedProjectionStats(filters: ProcessedProjectionQuery = {}): ProcessedProjectionStats {
  const database = ensureDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (!filters.includeArchived) {
    conditions.push("status = 'active'");
  }
  appendNamespaceFilterSql(conditions, params, filters);
  if (filters.projectionClass) {
    conditions.push('class = ?');
    params.push(filters.projectionClass);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = database.prepare(`
    SELECT namespace_key, class, summary, content_json, status
    FROM context_processed_local
    ${where}
  `).all(...params) as Array<Record<string, unknown>>;
  const normalizedQuery = filters.query?.trim().toLowerCase() ?? '';
  let totalRecords = 0;
  let matchedRecords = 0;
  let recentSummaryCount = 0;
  let durableCandidateCount = 0;
  const projectIds = new Set<string>();
  for (const row of rows) {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    if (!namespaceMatchesFilters(namespace, filters)) continue;
    const status = typeof row.status === 'string' ? row.status : 'active';
    if (!filters.includeArchived && status !== 'active') continue;
    const projectionClass = String(row.class) as ProcessedContextClass;
    if (filters.projectionClass && projectionClass !== filters.projectionClass) continue;
    if (isMemoryNoiseSummary(String(row.summary))) continue;
    totalRecords += 1;
    if (namespace.projectId) projectIds.add(namespace.projectId);
    if (projectionClass === 'recent_summary') recentSummaryCount += 1;
    if (projectionClass === 'durable_memory_candidate') durableCandidateCount += 1;
    if (!normalizedQuery) {
      matchedRecords += 1;
      continue;
    }
    const haystack = `${String(row.summary)}\n${JSON.stringify(projectionSemanticContent(parseJson<Record<string, unknown>>(row.content_json, {})))}`.toLowerCase();
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

export function listMemoryProjectSummaries(filters: ProcessedProjectionQuery = {}): ContextMemoryProjectView[] {
  const database = ensureDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (!filters.includeArchived) {
    conditions.push("status = 'active'");
  }
  appendNamespaceFilterSql(conditions, params, filters);
  if (filters.projectionClass) {
    conditions.push('class = ?');
    params.push(filters.projectionClass);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = database.prepare(`
    SELECT namespace_key, project_id, class, summary, updated_at, status
    FROM context_processed_local
    ${where}
  `).all(...params) as Array<Record<string, unknown>>;

  const projects = new Map<string, ContextMemoryProjectView>();
  for (const row of rows) {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    if (!namespaceMatchesFilters(namespace, filters)) continue;
    const status = typeof row.status === 'string' ? row.status : 'active';
    if (!filters.includeArchived && status !== 'active') continue;
    if (isMemoryNoiseSummary(String(row.summary))) continue;
    const projectId = namespace.projectId || (typeof row.project_id === 'string' ? row.project_id.trim() : '');
    if (!projectId) continue;
    const projectionClass = String(row.class) as ProcessedContextClass;
    const updatedAt = Number(row.updated_at) || undefined;
    const current = projects.get(projectId) ?? {
      projectId,
      displayName: projectId,
      totalRecords: 0,
      recentSummaryCount: 0,
      durableCandidateCount: 0,
      pendingEventCount: 0,
      updatedAt,
    };
    current.totalRecords += 1;
    if (projectionClass === 'recent_summary') current.recentSummaryCount += 1;
    if (projectionClass === 'durable_memory_candidate') current.durableCandidateCount += 1;
    current.updatedAt = Math.max(current.updatedAt ?? 0, updatedAt ?? 0) || undefined;
    projects.set(projectId, current);
  }

  const pendingConditions: string[] = [];
  const pendingParams: (string | number)[] = [];
  appendNamespaceFilterSql(pendingConditions, pendingParams, filters);
  const pendingWhere = pendingConditions.length > 0 ? `WHERE ${pendingConditions.join(' AND ')}` : '';
  const pendingRows = database.prepare(`
    SELECT namespace_key
    FROM context_staged_events
    ${pendingWhere}
  `).all(...pendingParams) as Array<Record<string, unknown>>;
  for (const row of pendingRows) {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    if (!namespaceMatchesFilters(namespace, filters)) continue;
    const projectId = namespace.projectId;
    if (!projectId) continue;
    const current = projects.get(projectId) ?? {
      projectId,
      displayName: projectId,
      totalRecords: 0,
      recentSummaryCount: 0,
      durableCandidateCount: 0,
      pendingEventCount: 0,
    };
    current.pendingEventCount = (current.pendingEventCount ?? 0) + 1;
    projects.set(projectId, current);
  }

  return Array.from(projects.values())
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.totalRecords - a.totalRecords || a.projectId.localeCompare(b.projectId))
    .slice(0, 200);
}

function getPendingContextStats(filters: ProcessedProjectionQuery): {
  stagedEventCount: number;
  dirtyTargetCount: number;
  pendingJobCount: number;
  projectIds: Set<string>;
} {
  const database = ensureDb();
  const dirtyConditions: string[] = [];
  const dirtyParams: (string | number)[] = [];
  appendNamespaceFilterSql(dirtyConditions, dirtyParams, filters);
  const dirtyWhere = dirtyConditions.length > 0 ? `WHERE ${dirtyConditions.join(' AND ')}` : '';
  const dirtyRows = database.prepare(`
    SELECT namespace_key, event_count
    FROM context_dirty_targets
    ${dirtyWhere}
  `).all(...dirtyParams) as Array<Record<string, unknown>>;
  const jobConditions: string[] = ["status IN ('pending', 'running')"];
  const jobParams: (string | number)[] = [];
  appendNamespaceFilterSql(jobConditions, jobParams, filters);
  const pendingJobRows = database.prepare(`
    SELECT namespace_key
    FROM context_jobs
    WHERE ${jobConditions.join(' AND ')}
  `).all(...jobParams) as Array<Record<string, unknown>>;

  let stagedEventCount = 0;
  let dirtyTargetCount = 0;
  let pendingJobCount = 0;
  const projectIds = new Set<string>();

  for (const row of dirtyRows) {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    if (!namespaceMatchesFilters(namespace, filters)) continue;
    stagedEventCount += Number(row.event_count);
    dirtyTargetCount += 1;
    if (namespace.projectId) projectIds.add(namespace.projectId);
  }

  for (const row of pendingJobRows) {
    const namespace = parseNamespaceKey(String(row.namespace_key));
    if (!namespaceMatchesFilters(namespace, filters)) continue;
    pendingJobCount += 1;
    if (namespace.projectId) projectIds.add(namespace.projectId);
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

/**
 * Transaction-free body of {@link setReplicationState}: upserts replication
 * state directly on `database` with NO ensureDb. This function does not itself
 * open a transaction (the public wrapper did not either). Returns the same
 * constructed {@link ContextReplicationState} value as the public function.
 */
export function setReplicationStateForDb(database: DatabaseSyncInstance, namespace: ContextNamespace, state: Omit<ContextReplicationState, 'namespace'>): ContextReplicationState {
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

export function setReplicationState(namespace: ContextNamespace, state: Omit<ContextReplicationState, 'namespace'>): ContextReplicationState {
  const database = ensureDb();
  return setReplicationStateForDb(database, namespace, state);
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

/**
 * Transaction-free body of {@link clearDirtyTarget}: clears a dirty-target row
 * directly on `database` with NO ensureDb. This function does not itself open a
 * transaction (the public wrapper did not either).
 */
export function clearDirtyTargetForDb(database: DatabaseSyncInstance, target: ContextTargetRef): void {
  database.prepare('DELETE FROM context_dirty_targets WHERE target_key = ?').run(serializeContextTarget(target));
}

export function clearDirtyTarget(target: ContextTargetRef): void {
  const database = ensureDb();
  clearDirtyTargetForDb(database, target);
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

const RECENT_SUMMARY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Archive stale local memories:
 * - recent_summary older than 30 days with hit_count=0 → status='archived'
 * - durable_memory_candidate NEVER auto-archived
 * - Age measured from last_used_at (falls back to updated_at if never used)
 */
export function pruneLocalMemory(now = Date.now()): { archived: number } {
  const database = ensureDb();
  const cutoff = now - RECENT_SUMMARY_MAX_AGE_MS;

  const result = database.prepare(`
    UPDATE context_processed_local
    SET status = 'archived'
    WHERE class = 'recent_summary'
      AND status = 'active'
      AND hit_count = 0
      AND COALESCE(last_used_at, updated_at) < ?
  `).run(cutoff);

  const archived = (result as { changes: number }).changes ?? 0;
  return { archived };
}

/**
 * Restore a previously archived projection back to active status.
 */
export function restoreArchivedMemory(id: string): boolean {
  const database = ensureDb();
  const result = database.prepare(`
    UPDATE context_processed_local
    SET status = 'active'
    WHERE id = ? AND status = 'archived'
  `).run(id);

  return ((result as { changes: number }).changes ?? 0) > 0;
}

/**
 * Archive an active projection (manual archive by user).
 */
export function archiveMemory(id: string): boolean {
  const database = ensureDb();
  const result = database.prepare(`
    UPDATE context_processed_local
    SET status = 'archived'
    WHERE id = ? AND status = 'active'
  `).run(id);

  return ((result as { changes: number }).changes ?? 0) > 0;
}


/**
 * Permanently delete a local processed projection.
 * Also removes the projection id from pending replication state so deleted items are not re-uploaded.
 */
export function deleteMemory(id: string): boolean {
  const database = ensureDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = database.prepare('DELETE FROM context_processed_local WHERE id = ?').run(id);
    const deleted = ((result as { changes: number }).changes ?? 0) > 0;
    if (deleted) {
      database.prepare('DELETE FROM context_observations WHERE projection_id = ?').run(id);
      removeProjectionIdsFromReplicationState(database, [id]);
    }
    database.exec('COMMIT');
    return deleted;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}
