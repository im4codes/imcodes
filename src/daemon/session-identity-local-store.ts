import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

const STORE_VERSION = 1;
const STORE_FILE = 'session-identities.json';
const DB_FILE = 'session-identities.sqlite';

interface DiskProfile extends Omit<SessionIdentityProfile, 'content'> {
  content: string;
}

interface DiskStore {
  version: number;
  profiles: Record<string, DiskProfile>;
  /** Set once the one-time server->daemon content migration has run. */
  migratedAt?: number;
}

function key(scope: SessionIdentityScope, scopeKey: string): string {
  return `${scope}\0${scopeKey}`;
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

function emptyStore(): DiskStore {
  return { version: STORE_VERSION, profiles: {} };
}

interface StoreSnapshot {
  signature: string;
  bytes: number;
  store: DiskStore;
}

let cachedSnapshot: StoreSnapshot | null = null;
let inFlightLoad: { signature: string; promise: Promise<StoreSnapshot | null> } | null = null;
const readStats = { loads: 0, cacheHits: 0, sharedLoads: 0, inFlightLoads: 0 };

registerMemoryProbe('identityStore', () => ({
  loads: readStats.loads,
  cacheHits: readStats.cacheHits,
  sharedLoads: readStats.sharedLoads,
  inFlightLoads: readStats.inFlightLoads,
  cachedBytes: cachedSnapshot?.bytes ?? 0,
}));

let activeDb: DatabaseSyncInstance | null = null;
let activeDbPath: string | null = null;
let lastExportedJsonMtime = 0;

function currentJsonSignature(): string {
  const jsonPath = localSessionIdentityStorePath();
  if (!existsSync(jsonPath)) return '0:0:0';
  try {
    const st = statSync(jsonPath);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return '0:0:0';
  }
}

function migrateLegacyJson(db: DatabaseSyncInstance): void {
  const check = db.prepare(`SELECT value FROM session_identity_meta WHERE key = 'legacy_json_migrated'`).get() as { value: string } | undefined;
  if (check?.value === '1') return;

  const jsonPath = localSessionIdentityStorePath();
  if (!existsSync(jsonPath)) {
    db.prepare(`INSERT OR REPLACE INTO session_identity_meta (key, value) VALUES ('legacy_json_migrated', '1')`).run();
    return;
  }

  try {
    const raw = readFileSync(jsonPath, 'utf8');
    let parsed: Partial<DiskStore>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      db.prepare(`INSERT OR REPLACE INTO session_identity_meta (key, value) VALUES ('legacy_json_migrated', '1')`).run();
      return;
    }

    if (parsed && typeof parsed === 'object' && parsed.profiles && typeof parsed.profiles === 'object') {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO session_identity_profiles
          (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.exec('BEGIN IMMEDIATE');
      try {
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
        db.prepare(`INSERT OR REPLACE INTO session_identity_meta (key, value) VALUES ('legacy_json_migrated', '1')`).run();
        db.exec('COMMIT');
        try {
          lastExportedJsonMtime = statSync(jsonPath).mtimeMs;
        } catch {
          lastExportedJsonMtime = Date.now();
        }
        logger.info({ profiles: Object.keys(parsed.profiles).length }, 'Migrated session-identities.json to SQLite');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else {
      db.prepare(`INSERT OR REPLACE INTO session_identity_meta (key, value) VALUES ('legacy_json_migrated', '1')`).run();
    }
  } catch (err) {
    logger.warn({ err, jsonPath }, 'Could not read legacy session-identities.json for migration');
  }
}

function syncExternalJsonChangesIfAny(db: DatabaseSyncInstance): void {
  const jsonPath = localSessionIdentityStorePath();
  if (!existsSync(jsonPath)) return;
  let st;
  try {
    st = statSync(jsonPath);
  } catch {
    return;
  }
  if (Math.abs(st.mtimeMs - lastExportedJsonMtime) < 1) return;

  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf8');
  } catch (err) {
    throw err;
  }

  let parsed: Partial<DiskStore>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A file that is not JSON reads as empty and is replaced by the next write
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM session_identity_profiles');
      db.exec('COMMIT');
      lastExportedJsonMtime = st.mtimeMs;
    } catch {
      db.exec('ROLLBACK');
    }
    return;
  }

  if (parsed && typeof parsed === 'object' && parsed.profiles && typeof parsed.profiles === 'object') {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO session_identity_profiles
        (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM session_identity_profiles');
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
      } else {
        db.prepare(`DELETE FROM session_identity_meta WHERE key = 'migrated_at'`).run();
      }
      db.exec('COMMIT');
      lastExportedJsonMtime = st.mtimeMs;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function exportCompatJsonSync(db: DatabaseSyncInstance): void {
  const jsonPath = localSessionIdentityStorePath();
  assertNotRealImcodesPathInTests(jsonPath, STORE_FILE);
  mkdirSync(dirname(jsonPath), { recursive: true });

  const rows = db.prepare(`
    SELECT scope, scope_key, content, content_hash, revision, updated_at, source, source_file
    FROM session_identity_profiles
    ORDER BY rowid ASC
  `).all() as Array<{
    scope: SessionIdentityScope;
    scope_key: string;
    content: string;
    content_hash: string;
    revision: number;
    updated_at: number;
    source: 'web' | 'mcp';
    source_file: string | null;
  }>;

  const profiles: Record<string, DiskProfile> = {};
  for (const row of rows) {
    profiles[key(row.scope, row.scope_key)] = {
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

  const metaRow = db.prepare(`SELECT value FROM session_identity_meta WHERE key = 'migrated_at'`).get() as { value: string } | undefined;
  const migratedAt = metaRow ? Number(metaRow.value) : undefined;

  const store: DiskStore = {
    version: STORE_VERSION,
    profiles,
    ...(typeof migratedAt === 'number' && Number.isFinite(migratedAt) ? { migratedAt } : {}),
  };

  const temporary = `${jsonPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  renameSync(temporary, jsonPath);

  try {
    lastExportedJsonMtime = statSync(jsonPath).mtimeMs;
  } catch {
    lastExportedJsonMtime = Date.now();
  }
}

function getDb(): DatabaseSyncInstance {
  const dbPath = localSessionIdentityDbPath();
  if (activeDb && activeDbPath === dbPath) {
    if (!existsSync(dbPath)) {
      try { activeDb.close(); } catch { /* ignore */ }
      activeDb = null;
    } else {
      syncExternalJsonChangesIfAny(activeDb);
      return activeDb;
    }
  }

  if (activeDb) {
    try { activeDb.close(); } catch { /* ignore */ }
    activeDb = null;
  }

  assertNotRealImcodesPathInTests(dbPath, DB_FILE);
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

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

  activeDb = db;
  activeDbPath = dbPath;

  migrateLegacyJson(db);
  syncExternalJsonChangesIfAny(db);

  return db;
}

function fileSignature(): string {
  const dbPath = localSessionIdentityDbPath();
  return `${dbPath}:${currentJsonSignature()}`;
}

async function loadSnapshot(): Promise<StoreSnapshot | null> {
  const jsonPath = localSessionIdentityStorePath();
  if (existsSync(jsonPath)) {
    try {
      const fd = openSync(jsonPath, 'r');
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // file absent
      } else {
        throw error;
      }
    }
  }

  const db = getDb();
  readStats.loads += 1;

  const rows = db.prepare(`
    SELECT scope, scope_key, content, content_hash, revision, updated_at, source, source_file
    FROM session_identity_profiles
    ORDER BY rowid ASC
  `).all() as Array<{
    scope: SessionIdentityScope;
    scope_key: string;
    content: string;
    content_hash: string;
    revision: number;
    updated_at: number;
    source: 'web' | 'mcp';
    source_file: string | null;
  }>;

  const profiles: Record<string, DiskProfile> = {};
  for (const row of rows) {
    profiles[key(row.scope, row.scope_key)] = {
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

  const metaRow = db.prepare(`SELECT value FROM session_identity_meta WHERE key = 'migrated_at'`).get() as { value: string } | undefined;
  const migratedAt = metaRow ? Number(metaRow.value) : undefined;

  const store: DiskStore = {
    version: STORE_VERSION,
    profiles,
    ...(typeof migratedAt === 'number' && Number.isFinite(migratedAt) ? { migratedAt } : {}),
  };

  return {
    signature: fileSignature(),
    bytes: Object.keys(profiles).length * 1024,
    store,
  };
}

async function readSnapshot(): Promise<StoreSnapshot | null> {
  const signature = fileSignature();
  if (cachedSnapshot && cachedSnapshot.signature === signature) {
    readStats.cacheHits += 1;
    return cachedSnapshot;
  }

  if (inFlightLoad && inFlightLoad.signature === signature) {
    readStats.sharedLoads += 1;
    return inFlightLoad.promise;
  }

  readStats.inFlightLoads += 1;
  const entry = {
    signature,
    promise: loadSnapshot().then((snapshot) => {
      cachedSnapshot = snapshot;
      return snapshot;
    }),
  };
  inFlightLoad = entry;
  try {
    return await entry.promise;
  } finally {
    readStats.inFlightLoads -= 1;
    if (inFlightLoad === entry) inFlightLoad = null;
  }
}

async function readStore(): Promise<DiskStore> {
  try {
    return (await readSnapshot())?.store ?? emptyStore();
  } catch {
    return emptyStore();
  }
}

async function readStoreForUpdate(): Promise<DiskStore> {
  const snapshot = await readSnapshot();
  const store = snapshot?.store ?? emptyStore();
  return { ...store, profiles: { ...store.profiles } };
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
    exportCompatJsonSync(db);
    cachedSnapshot = null;
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
  const store = await readStore();
  return Object.values(store.profiles).map((profile) => ({ ...profile }));
}

export async function getLocalSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<SessionIdentityProfile | null> {
  const store = await readStore();
  const profile = store.profiles[key(scope, scopeKey)];
  return profile ? { ...profile } : null;
}

export async function putLocalSessionIdentityProfile(input: LocalIdentityWrite): Promise<SessionIdentityProfile> {
  const content = normalizeSessionIdentityContent(input.content);
  const error = sessionIdentityContentError(content, input.scope);
  if (error) throw new Error(error);

  const profile = await enqueueMutation(async () => {
    const store = await readStoreForUpdate();
    const previous = store.profiles[key(input.scope, input.scopeKey)];
    const revision = Math.max(previous?.revision ?? 0, input.revision ?? 0) + 1;
    const hash = contentHash(content);
    const now = Date.now();

    const db = getDb();
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

    exportCompatJsonSync(db);
    cachedSnapshot = null;

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

    exportCompatJsonSync(db);
    cachedSnapshot = null;

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
      exportCompatJsonSync(db);
      cachedSnapshot = null;
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
      exportCompatJsonSync(db);
      cachedSnapshot = null;
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

    exportCompatJsonSync(db);
    cachedSnapshot = null;
    return toDelete.length;
  });
}

export function identityStoreReadStatsForTests(): { loads: number; cacheHits: number; sharedLoads: number } {
  return { loads: readStats.loads, cacheHits: readStats.cacheHits, sharedLoads: readStats.sharedLoads };
}

export function resetIdentityStoreCacheForTests(): void {
  if (activeDb) {
    try { activeDb.close(); } catch { /* ignore */ }
    activeDb = null;
  }
  activeDbPath = null;
  cachedSnapshot = null;
  inFlightLoad = null;
  lastExportedJsonMtime = 0;
  readStats.loads = 0;
  readStats.cacheHits = 0;
  readStats.sharedLoads = 0;
  readStats.inFlightLoads = 0;
}
