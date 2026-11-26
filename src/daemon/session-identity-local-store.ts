import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import { assertNotRealImcodesPathInTests } from '../util/test-home-guard.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';
import logger from '../util/logger.js';
import {
  normalizeSessionIdentityContent,
  sessionIdentityContentError,
  sessionIdentityContentLength,
  type SessionIdentityProfile,
  type SessionIdentityScope,
} from '../../shared/session-identity.js';
import { SESSION_IDENTITY_WS } from '../../shared/session-identity-ws.js';
import { registerMemoryProbe } from './memory-probes.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/**
 * Set once at daemon startup (lifecycle.ts, where the server WS connection
 * is available) so a local write can report itself to the server -- keeping
 * its metadata row (PROJECT/SESSION) or its content (USER) in step. Never
 * required for the write itself to succeed: the local write is already
 * durable by the time this fires, and a report that fails to send (daemon
 * offline) is simply caught up by the next MIGRATE/PUSH cycle or the next
 * write's report. Fire-and-forget by design -- this is not the daemon->server
 * HTTP path the owner rule eliminates, it is its WS replacement.
 */
export type SessionIdentityReportSender = (report: Record<string, unknown>) => void;
let reportSender: SessionIdentityReportSender | null = null;
export function setSessionIdentityReportSender(sender: SessionIdentityReportSender | null): void {
  reportSender = sender;
}
function report(payload: Record<string, unknown>): void {
  try {
    reportSender?.(payload);
  } catch {
    // Best-effort; the local write already succeeded.
  }
}

const STORE_FILE = 'session-identities.json';
const DB_FILE = 'session-identities.sqlite';
const WAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const WAL_TRUNCATE_RETRY_COOLDOWN_MS = 250;
const WAL_TRUNCATE_INITIAL_DELAY_MS = 150;
const WAL_TRUNCATE_STEADY_INTERVAL_MS = 5_000;

interface DiskProfile extends Omit<SessionIdentityProfile, 'content'> {
  content: string;
}

interface DiskStore {
  version: number;
  profiles: Record<string, DiskProfile>;
  /** Set once the one-time server->daemon content migration has run. */
  migratedAt?: number;
}

interface ProfileRow {
  scope: SessionIdentityScope;
  scope_key: string;
  content: string;
  content_hash: string;
  revision: number;
  updated_at: number;
  source: 'web' | 'mcp';
  source_file: string | null;
}

function rowToProfile(row: ProfileRow): SessionIdentityProfile {
  return {
    scope: row.scope,
    scopeKey: row.scope_key,
    content: row.content,
    contentHash: row.content_hash,
    revision: row.revision,
    updatedAt: row.updated_at,
    source: row.source,
    ...(row.source_file ? { sourceFile: row.source_file } : {}),
  };
}

export function localSessionIdentityStorePath(): string {
  return join(resolveImcodesHome(), STORE_FILE);
}

export function localSessionIdentityDbPath(): string {
  const envPath = process.env.IMCODES_SESSION_IDENTITIES_DB_PATH?.trim();
  if (envPath) return envPath;
  return join(resolveImcodesHome(), DB_FILE);
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const readStats = {
  loads: 0,
  cacheHits: 0,
  sharedLoads: 0,
  pkReads: 0,
  listScans: 0,
  walCheckpoints: 0,
};

registerMemoryProbe('identityStore', () => ({
  loads: readStats.loads,
  pkReads: readStats.pkReads,
  listScans: readStats.listScans,
  walCheckpoints: readStats.walCheckpoints,
  cachedBytes: 0,
}));

let activeDb: DatabaseSyncInstance | null = null;
let activeDbPath: string | null = null;
let pendingWalTruncatePath: string | null = null;
let lastWalTruncateAttemptAt = 0;
let walTruncateRetryTimer: ReturnType<typeof setTimeout> | null = null;
let walTruncateTimerAttempts = 0;

function clearWalMaintenanceTimer(): void {
  if (walTruncateRetryTimer) {
    clearTimeout(walTruncateRetryTimer);
    walTruncateRetryTimer = null;
  }
}

function clearWalMaintenanceState(): void {
  pendingWalTruncatePath = null;
  walTruncateTimerAttempts = 0;
  clearWalMaintenanceTimer();
}

function isLegacyJsonMigrated(db: DatabaseSyncInstance): boolean {
  const check = db.prepare(`SELECT value FROM session_identity_meta WHERE key = 'legacy_json_migrated'`).get() as { value: string } | undefined;
  return check?.value === '1';
}

function markLegacyJsonMigrated(db: DatabaseSyncInstance): void {
  db.prepare(`INSERT OR REPLACE INTO session_identity_meta (key, value) VALUES ('legacy_json_migrated', '1')`).run();
}

function migrateLegacyJson(db: DatabaseSyncInstance): void {
  if (isLegacyJsonMigrated(db)) return;

  const jsonPath = localSessionIdentityStorePath();
  if (!existsSync(jsonPath)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!isLegacyJsonMigrated(db)) {
        markLegacyJsonMigrated(db);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf8');
  } catch (err) {
    logger.warn({ err, jsonPath }, 'Could not read legacy session-identities.json for migration');
    throw err;
  }

  readStats.loads += 1;

  let parsed: Partial<DiskStore>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!isLegacyJsonMigrated(db)) {
        markLegacyJsonMigrated(db);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    if (isLegacyJsonMigrated(db)) {
      db.exec('COMMIT');
      return;
    }
    if (parsed && typeof parsed === 'object' && parsed.profiles && typeof parsed.profiles === 'object') {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO session_identity_profiles
          (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const profile of Object.values(parsed.profiles)) {
        if (!profile || typeof profile !== 'object') continue;
        insert.run(
          profile.scope,
          profile.scopeKey,
          profile.content,
          profile.contentHash,
          profile.revision,
          profile.updatedAt,
          profile.source,
          profile.sourceFile ?? null,
        );
      }
      if (typeof parsed.migratedAt === 'number') {
        db.prepare(`INSERT OR REPLACE INTO session_identity_meta (key, value) VALUES ('migrated_at', ?)`).run(String(parsed.migratedAt));
      }
      markLegacyJsonMigrated(db);
      db.exec('COMMIT');
      logger.info({ profiles: Object.keys(parsed.profiles).length }, 'Migrated session-identities.json to SQLite');
      return;
    }
    markLegacyJsonMigrated(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function walFileSizeBytes(dbPath: string): number {
  if (dbPath === ':memory:') return 0;
  try {
    const walPath = `${dbPath}-wal`;
    return existsSync(walPath) ? statSync(walPath).size : 0;
  } catch {
    return 0;
  }
}

function runWalCheckpoint(
  db: DatabaseSyncInstance,
  mode: 'PASSIVE' | 'TRUNCATE',
): { busy: number; log: number; checkpointed: number } {
  try {
    if (mode === 'TRUNCATE') {
      db.exec('PRAGMA busy_timeout = 0');
    }
    const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;
    return {
      busy: Number(row?.busy ?? 0),
      log: Number(row?.log ?? 0),
      checkpointed: Number(row?.checkpointed ?? 0),
    };
  } catch {
    return { busy: 1, log: 0, checkpointed: 0 };
  } finally {
    if (mode === 'TRUNCATE') {
      try {
        db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
      } catch {
        // ignore if closing
      }
    }
  }
}

function scheduleWalTruncateMaintenance(dbPath: string): void {
  if (dbPath === ':memory:' || walTruncateRetryTimer) return;
  // Back off up to a low-frequency steady-state interval without ever permanently stopping while bloated WAL remains.
  const delayMs = Math.min(
    WAL_TRUNCATE_STEADY_INTERVAL_MS,
    WAL_TRUNCATE_INITIAL_DELAY_MS * Math.pow(2, walTruncateTimerAttempts),
  );
  walTruncateTimerAttempts = Math.min(10, walTruncateTimerAttempts + 1);
  walTruncateRetryTimer = setTimeout(() => {
    walTruncateRetryTimer = null;
    if (!activeDb || activeDbPath !== dbPath || pendingWalTruncatePath !== dbPath) return;
    tryBoundedWalTruncate(activeDb, dbPath, true);
  }, delayMs);
  walTruncateRetryTimer.unref?.();
}

function tryBoundedWalTruncate(db: DatabaseSyncInstance, dbPath: string, forceNow = false): void {
  if (dbPath === ':memory:') return;
  const walBytes = walFileSizeBytes(dbPath);
  if (walBytes <= WAL_SIZE_LIMIT_BYTES) {
    if (pendingWalTruncatePath === dbPath) {
      clearWalMaintenanceState();
    }
    return;
  }

  const now = Date.now();
  if (!forceNow && now - lastWalTruncateAttemptAt < WAL_TRUNCATE_RETRY_COOLDOWN_MS) {
    pendingWalTruncatePath = dbPath;
    scheduleWalTruncateMaintenance(dbPath);
    return;
  }

  lastWalTruncateAttemptAt = now;
  const result = runWalCheckpoint(db, 'TRUNCATE');
  const remainingBytes = walFileSizeBytes(dbPath);
  if (result.busy === 0 && remainingBytes <= WAL_SIZE_LIMIT_BYTES) {
    clearWalMaintenanceState();
    readStats.walCheckpoints += 1;
    return;
  }

  pendingWalTruncatePath = dbPath;
  scheduleWalTruncateMaintenance(dbPath);
}

function checkpointWal(db: DatabaseSyncInstance, dbPath: string, reason: 'startup' | 'write'): void {
  if (dbPath === ':memory:') return;
  if (reason === 'startup') {
    tryBoundedWalTruncate(db, dbPath, true);
    return;
  }
  if (walFileSizeBytes(dbPath) > WAL_SIZE_LIMIT_BYTES) {
    tryBoundedWalTruncate(db, dbPath);
    return;
  }
  const result = runWalCheckpoint(db, 'PASSIVE');
  if (result.busy === 0 && pendingWalTruncatePath === dbPath && walFileSizeBytes(dbPath) <= WAL_SIZE_LIMIT_BYTES) {
    clearWalMaintenanceState();
  }
  readStats.walCheckpoints += 1;
}

function getDb(): DatabaseSyncInstance {
  const dbPath = localSessionIdentityDbPath();
  if (activeDb && activeDbPath === dbPath) {
    if (dbPath !== ':memory:' && !existsSync(dbPath)) {
      clearWalMaintenanceState();
      try { activeDb.close(); } catch { /* ignore */ }
      activeDb = null;
    } else {
      if (pendingWalTruncatePath === dbPath) {
        tryBoundedWalTruncate(activeDb, dbPath);
      }
      return activeDb;
    }
  }

  if (activeDb) {
    clearWalMaintenanceState();
    try { activeDb.close(); } catch { /* ignore */ }
    activeDb = null;
  }

  assertNotRealImcodesPathInTests(dbPath, DB_FILE);
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};
      PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};

      CREATE TABLE IF NOT EXISTS session_identity_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_identity_profiles (
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        source_file TEXT,
        PRIMARY KEY (scope, scope_key)
      );

      CREATE INDEX IF NOT EXISTS idx_session_identity_scope
        ON session_identity_profiles(scope);
    `);

    migrateLegacyJson(db);
    checkpointWal(db, dbPath, 'startup');

    activeDb = db;
    activeDbPath = dbPath;
    return db;
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    throw err;
  }
}

export async function isSessionIdentityMigrated(): Promise<boolean> {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM session_identity_meta WHERE key = 'migrated_at'`).get() as { value: string } | undefined;
  return row !== undefined && Number.isFinite(Number(row.value));
}

export async function markSessionIdentityMigrated(now = Date.now()): Promise<void> {
  return enqueueMutation(async () => {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO session_identity_meta (key, value) VALUES ('migrated_at', ?)
    `).run(String(now));
    checkpointWal(db, activeDbPath ?? localSessionIdentityDbPath(), 'write');
  });
}

let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(fn, fn);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export interface LocalIdentityWrite {
  scope: SessionIdentityScope;
  scopeKey: string;
  content: string;
  revision?: number;
  source: 'web' | 'mcp';
  sourceFile?: string;
}

export async function listLocalSessionIdentityProfiles(): Promise<SessionIdentityProfile[]> {
  try {
    const db = getDb();
    readStats.listScans += 1;
    const rows = db.prepare(`
      SELECT scope, scope_key, content, content_hash, revision, updated_at, source, source_file
      FROM session_identity_profiles
      ORDER BY rowid ASC
    `).all() as unknown as ProfileRow[];
    return rows.map(rowToProfile);
  } catch {
    return [];
  }
}

export async function getLocalSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<SessionIdentityProfile | null> {
  try {
    const db = getDb();
    readStats.pkReads += 1;
    const row = db.prepare(`
      SELECT scope, scope_key, content, content_hash, revision, updated_at, source, source_file
      FROM session_identity_profiles
      WHERE scope = ? AND scope_key = ?
    `).get(scope, scopeKey) as unknown as ProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  } catch {
    return null;
  }
}

export async function putLocalSessionIdentityProfile(input: LocalIdentityWrite): Promise<SessionIdentityProfile> {
  const content = normalizeSessionIdentityContent(input.content);
  const error = sessionIdentityContentError(content, input.scope);
  if (error) throw new Error(error);

  const profile = await enqueueMutation(async () => {
    const hash = contentHash(content);
    const now = Date.now();
    const db = getDb();
    let revision = 1;

    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare(`
        SELECT revision FROM session_identity_profiles WHERE scope = ? AND scope_key = ?
      `).get(input.scope, input.scopeKey) as { revision: number } | undefined;
      revision = Math.max(previous?.revision ?? 0, input.revision ?? 0) + 1;
      db.prepare(`
        INSERT OR REPLACE INTO session_identity_profiles
          (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.scope,
        input.scopeKey,
        content,
        hash,
        revision,
        now,
        input.source,
        input.sourceFile ?? null,
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    checkpointWal(db, activeDbPath ?? localSessionIdentityDbPath(), 'write');

    const next: DiskProfile = {
      scope: input.scope,
      scopeKey: input.scopeKey,
      content,
      contentHash: hash,
      revision,
      updatedAt: now,
      source: input.source,
      ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
    };
    return next;
  });

  if (profile.scope === 'user') {
    report({
      type: SESSION_IDENTITY_WS.USER_REPORT, content: profile.content,
      source: profile.source, sourceFile: profile.sourceFile,
    });
  } else {
    report({
      type: SESSION_IDENTITY_WS.LOCAL_REPORT, scope: profile.scope, scopeKey: profile.scopeKey,
      contentHash: profile.contentHash, contentLength: sessionIdentityContentLength(profile.content),
      revision: profile.revision, updatedAt: profile.updatedAt,
      source: profile.source, sourceFile: profile.sourceFile,
    });
  }
  return { ...profile };
}

export async function putLocalSessionIdentityProfileExact(input: {
  scope: SessionIdentityScope;
  scopeKey: string;
  content: string;
  contentHash: string;
  revision: number;
  updatedAt: number;
  source: 'web' | 'mcp';
  sourceFile?: string;
}): Promise<SessionIdentityProfile> {
  const content = normalizeSessionIdentityContent(input.content);
  return enqueueMutation(async () => {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO session_identity_profiles
        (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.scope,
      input.scopeKey,
      content,
      input.contentHash,
      input.revision,
      input.updatedAt,
      input.source,
      input.sourceFile ?? null,
    );

    checkpointWal(db, activeDbPath ?? localSessionIdentityDbPath(), 'write');

    return {
      scope: input.scope,
      scopeKey: input.scopeKey,
      content,
      contentHash: input.contentHash,
      revision: input.revision,
      updatedAt: input.updatedAt,
      source: input.source,
      ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
    };
  });
}

export async function removeLocalSessionIdentityProfileQuiet(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<boolean> {
  return enqueueMutation(async () => {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM session_identity_profiles WHERE scope = ? AND scope_key = ?
    `).run(scope, scopeKey);
    const existed = Number(result.changes) > 0;
    if (existed) {
      checkpointWal(db, activeDbPath ?? localSessionIdentityDbPath(), 'write');
    }
    return existed;
  });
}

export async function removeLocalSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<boolean> {
  const existed = await removeLocalSessionIdentityProfileQuiet(scope, scopeKey);
  if (existed) {
    report(scope === 'user'
      ? { type: SESSION_IDENTITY_WS.USER_REPORT, deleted: true }
      : { type: SESSION_IDENTITY_WS.LOCAL_REPORT, scope, scopeKey, deleted: true });
  }
  return existed;
}

/**
 * Immediately purges all session-scoped identity profiles for the specified session name.
 * Handles both `${serverId}:${sessionName}` and `${sessionName}` scopeKey formats.
 */
export async function removeSessionIdentitiesForSession(sessionName: string): Promise<number> {
  if (!sessionName || !sessionName.trim()) return 0;
  const name = sessionName.trim();
  return enqueueMutation(async () => {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM session_identity_profiles
      WHERE scope = 'session'
        AND (scope_key = ? OR scope_key LIKE '%:' || ?)
    `).run(name, name);
    const deleted = Number(result.changes);
    if (deleted > 0) {
      checkpointWal(db, activeDbPath ?? localSessionIdentityDbPath(), 'write');
      logger.info({ sessionName: name, deleted }, 'Removed session-scoped identity profiles');
    }
    return deleted;
  });
}

/**
 * Drops session-scoped profiles whose sessionName is not among the active sessions.
 * User, project and pair profiles are preserved.
 */
export async function pruneOrphanedSessionIdentityProfiles(
  activeSessionNames: ReadonlySet<string>,
): Promise<number> {
  return enqueueMutation(async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT scope_key FROM session_identity_profiles WHERE scope = 'session'
    `).all() as Array<{ scope_key: string }>;

    const toDelete: string[] = [];
    for (const row of rows) {
      const parts = row.scope_key.split(':');
      const sessionName = parts.length > 1 ? parts.slice(1).join(':') : parts[0];
      if (!activeSessionNames.has(sessionName)) {
        toDelete.push(row.scope_key);
      }
    }

    if (toDelete.length === 0) return 0;

    const del = db.prepare(`DELETE FROM session_identity_profiles WHERE scope = 'session' AND scope_key = ?`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const scopeKey of toDelete) {
        del.run(scopeKey);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    checkpointWal(db, activeDbPath ?? localSessionIdentityDbPath(), 'write');
    return toDelete.length;
  });
}

export function identityStoreReadStatsForTests(): {
  loads: number;
  cacheHits: number;
  sharedLoads: number;
  pkReads: number;
  listScans: number;
  walCheckpoints: number;
} {
  return {
    loads: readStats.loads,
    cacheHits: readStats.cacheHits,
    sharedLoads: readStats.sharedLoads,
    pkReads: readStats.pkReads,
    listScans: readStats.listScans,
    walCheckpoints: readStats.walCheckpoints,
  };
}

export function resetIdentityStoreCacheForTests(): void {
  clearWalMaintenanceState();
  lastWalTruncateAttemptAt = 0;
  if (activeDb) {
    try { activeDb.close(); } catch { /* ignore */ }
    activeDb = null;
  }
  activeDbPath = null;
  readStats.loads = 0;
  readStats.cacheHits = 0;
  readStats.sharedLoads = 0;
  readStats.pkReads = 0;
  readStats.listScans = 0;
  readStats.walCheckpoints = 0;
}
