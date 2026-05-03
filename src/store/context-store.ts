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
  type CanonicalNamespaceInput,
  type ContextNamespaceBinding,
} from '../../shared/memory-namespace.js';
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

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
export type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'shared-agent-context.sqlite');
const DEFAULT_LOCAL_PROCESSED_FRESH_MS = 6 * 60 * 60 * 1000;
export const LEGACY_DAEMON_LOCAL_USER_ID = 'daemon-local';

let db: DatabaseSyncInstance | null = null;
let currentDbPath: string | null = null;
let stagedReconciledForPath: string | null = null;
let materializationRepairRanForPath: string | null = null;
let archiveBackfillTimer: ReturnType<typeof setTimeout> | null = null;
let archiveBackfillScheduledForPath: string | null = null;

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
  `);
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
  if (db) db.close();
  db = null;
  currentDbPath = null;
  stagedReconciledForPath = null;
  materializationRepairRanForPath = null;
}


export function archiveEventsForMaterialization(events: LocalContextEvent[], archivedAt = Date.now()): void {
  if (events.length === 0) return;
  const database = ensureDb();
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
  database.exec('BEGIN IMMEDIATE');
  try {
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
  database.prepare(`
    INSERT INTO context_staged_events (
      id, namespace_key, scope, enterprise_id, workspace_id, user_id, project_id,
      target_key, target_kind, session_name, event_type, content, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    let lastExplicitBusyError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        database.exec('BEGIN IMMEDIATE');
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

  const fingerprint = projectionFingerprint(summaryForDb);
  let lastBusyError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      database.exec('BEGIN IMMEDIATE');
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
      database.exec('COMMIT');
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
  projectionId?: string;
} = {}): ContextObservationRow[] {
  const database = ensureDb();
  const rows = database.prepare('SELECT * FROM context_observations ORDER BY updated_at DESC, id ASC').all() as Array<Record<string, unknown>>;
  return rows
    .map(observationRowFromDb)
    .filter((row) => !filters.namespaceId || row.namespaceId === filters.namespaceId)
    .filter((row) => !filters.scope || row.scope === filters.scope)
    .filter((row) => !filters.class || row.class === filters.class)
    .filter((row) => !filters.projectionId || row.projectionId === filters.projectionId);
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
        const haystack = `${projection.summary}\n${JSON.stringify(projectionSemanticContent(projection.content))}`.toLowerCase();
        if (!haystack.includes(normalizedQuery)) return false;
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

export function parseNamespaceKey(namespaceKey: string): ContextNamespace {
  const [scope, enterpriseId, workspaceId, userId, projectId] = namespaceKey.split('::');
  return {
    scope: scope as ContextNamespace['scope'],
    enterpriseId: enterpriseId || undefined,
    workspaceId: workspaceId || undefined,
    userId: userId || undefined,
    projectId,
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
