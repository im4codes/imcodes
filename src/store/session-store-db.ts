/**
 * SQLite persistence for the daemon session store.
 *
 * One row per session (`name` primary key, the whole record as a JSON payload,
 * plus the columns a reader filters on), so a change rewrites only the rows
 * that changed, in one transaction, instead of the whole store. WAL mode lets
 * other processes (cli, the memory MCP server) read while the daemon writes.
 *
 * This module knows nothing about the in-memory store, write authority or
 * test-session hygiene: `session-store.ts` decides WHAT to write and WHO may;
 * this file only reads and writes rows.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

import {
  SESSION_DB_META_IDENTITY_SCRUB,
  SESSION_DB_VACUUM_MIN_FREE_BYTES,
  SESSION_DB_WAL_SIZE_LIMIT_BYTES,
  SESSION_IDENTITY_PROMPT_FIELD,
  SESSION_IDENTITY_PROMPT_MARKER,
  SESSION_IDENTITY_PROMPT_REF_FIELD,
} from '../../shared/session-store-compat.js';
import { removeStoredIdentity, type SessionBlob } from './session-record-blobs.js';
const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const sqlite = require('node:sqlite') as typeof import('node:sqlite');
const { DatabaseSync } = sqlite;
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export const SESSION_DB_FILE = 'sessions.sqlite';
export const SESSION_DB_SCHEMA_VERSION = 1;
export const SESSION_DB_BLOB_TABLE = 'session_blobs';
export const SESSION_DB_META_LEGACY_IMPORT = 'legacy_json_import';
export const SESSION_DB_LEGACY_IMPORT_DONE = 'done';
const BUSY_TIMEOUT_MS = 5_000;

export interface SessionDbRow {
  name: string;
  projectName: string;
  parentSession: string | null;
  agentType: string;
  state: string;
  updatedAt: number;
  /** The whole record as compact JSON: the one source of truth for the fields. */
  payload: string;
  /** Large string fields the payload refers to by hash (see session-record-blobs.ts); stored once, not per row. */
  blobs?: SessionBlob[];
}

export interface SessionDbHandle {
  db: DatabaseSyncInstance;
  path: string;
  readOnly: boolean;
}

/**
 * Test seam: called before every row write in a transaction with the 1-based
 * count of writes so far in it. Throwing simulates a failed write; killing the
 * process simulates a crash mid-transaction.
 */
let rowWriteHook: ((writeInTransaction: number) => void) | null = null;
export function setSessionDbRowWriteHookForTests(hook: ((writeInTransaction: number) => void) | null): void {
  rowWriteHook = hook;
}
/** Test seam: the n+1th row write in a transaction fails as a full disk would. */
export function setSessionDbFailAfterRowWritesForTests(count: number | null): void {
  rowWriteHook = count === null ? null : (n) => {
    if (n > count) throw Object.assign(new Error('simulated session-db failure (database or disk is full)'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
  };
}
let rowWritesThisTransaction = 0;
function noteRowWrite(): void {
  rowWritesThisTransaction += 1;
  rowWriteHook?.(rowWritesThisTransaction);
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    name TEXT PRIMARY KEY NOT NULL,
    project_name TEXT NOT NULL DEFAULT '',
    parent_session TEXT,
    agent_type TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS sessions_project_name ON sessions(project_name);
  CREATE INDEX IF NOT EXISTS sessions_parent_session ON sessions(parent_session) WHERE parent_session IS NOT NULL;
  CREATE TABLE IF NOT EXISTS session_store_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS session_blobs (
    hash TEXT PRIMARY KEY NOT NULL,
    text TEXT NOT NULL
  ) WITHOUT ROWID;
`;

/** Open the writer connection, creating the file and schema. */
export function openSessionDbForWrite(path: string): SessionDbHandle {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // A checkpoint can only reuse the log; this bounds what is left on disk afterwards.
    db.exec(`PRAGMA journal_size_limit = ${SESSION_DB_WAL_SIZE_LIMIT_BYTES}`);
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT OR IGNORE INTO session_store_meta (key, value) VALUES (?, ?)').run('schema_version', String(SESSION_DB_SCHEMA_VERSION));
  } catch (error) {
    try { db.close(); } catch { /* already unusable */ }
    throw error;
  }
  return { db, path, readOnly: false };
}

/**
 * Open a read-only connection, or null when there is no database yet (an
 * unmigrated install). A reader never creates, migrates or repairs anything.
 */
export function openSessionDbReadOnly(path: string): SessionDbHandle | null {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (error) {
    try { db.close(); } catch { /* already unusable */ }
    throw error;
  }
  return { db, path, readOnly: true };
}

export function closeSessionDb(handle: SessionDbHandle | null | undefined): void {
  if (!handle) return;
  try { handle.db.close(); } catch { /* already closed */ }
}

export function readSessionDbMeta(handle: SessionDbHandle, key: string): string | null {
  try {
    const row = handle.db.prepare('SELECT value FROM session_store_meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } catch {
    // A database that is not ours (no meta table) has no import marker.
    return null;
  }
}

export function countSessionRows(handle: SessionDbHandle): number {
  try {
    const row = handle.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number | bigint };
    return Number(row.n);
  } catch {
    return 0;
  }
}

/** Every row as name → payload text. Rows are parsed by the caller. */
export function readSessionPayloads(handle: SessionDbHandle): Map<string, string> {
  const rows = handle.db.prepare('SELECT name, payload FROM sessions').all() as Array<{ name: string; payload: string }>;
  const out = new Map<string, string>();
  for (const row of rows) out.set(row.name, row.payload);
  return out;
}

/** Every stored blob as hash -> text (empty on a database written before blobs existed). */
export function readSessionBlobs(handle: SessionDbHandle): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = handle.db.prepare('SELECT hash, text FROM session_blobs').all() as Array<{ hash: string; text: string }>;
    for (const row of rows) out.set(row.hash, row.text);
  } catch {
    // An older database has no blob table: its rows are inline.
  }
  return out;
}

/** The hashes currently in the blob table (so a row write only sends blobs the database does not have yet). */
export function listSessionBlobHashes(handle: SessionDbHandle): Set<string> {
  try {
    const rows = handle.db.prepare('SELECT hash FROM session_blobs').all() as Array<{ hash: string }>;
    return new Set(rows.map((row) => row.hash));
  } catch {
    return new Set();
  }
}

function insertBlobs(handle: SessionDbHandle, rows: readonly SessionDbRow[]): void {
  const insert = handle.db.prepare('INSERT OR IGNORE INTO session_blobs (hash, text) VALUES (?, ?)');
  for (const row of rows) for (const blob of row.blobs ?? []) insert.run(blob.hash, blob.text);
}

/** Drop blobs no row refers to any more (a field edited, a session removed). Uses SQLite's JSON functions on the small payloads. */
function collectUnreferencedBlobs(handle: SessionDbHandle): void {
  try {
    handle.db.exec(`
      DELETE FROM session_blobs WHERE hash NOT IN (
        SELECT je.value FROM sessions, json_each(sessions.payload, '$.blobRefs') AS je
      )`);
  } catch {
    // No JSON functions or an unreadable payload: keep every blob (a leak of a few MB, never a lost reference).
  }
}

const SCRUB_PENDING_VACUUM = 'vacuum_pending';
const SCRUB_DONE = 'done';

/**
 * Remove every stored identity prompt from the database (the previous builds kept one per session, inline and later as a
 * blob reference). The prompt is derived data -- see session-identity-resolver.ts -- so the rows keep only two short digests.
 *
 * ONE transaction: all rows and the blobs only they referred to, or nothing (a crash or a full disk rolls it back and
 * the next start repeats it). Idempotent, and repeated on EVERY start by a cheap substring scan, so rows an older build
 * wrote after a downgrade are cleaned too. The freed pages still hold the old text, so the file is compacted at once
 * (VACUUM, then the log is truncated); when that cannot run (disk space) the marker stays `vacuum_pending` and the next
 * start retries, instead of leaving the text on disk unannounced.
 */
export function scrubStoredIdentityRows(handle: SessionDbHandle): { scrubbedRows: number; compacted: boolean } {
  if (handle.readOnly) return { scrubbedRows: 0, compacted: false };
  const { db } = handle;
  const marker = readSessionDbMeta(handle, SESSION_DB_META_IDENTITY_SCRUB);
  const names = (db.prepare('SELECT name FROM sessions WHERE instr(payload, ?) > 0').all(SESSION_IDENTITY_PROMPT_MARKER) as Array<{ name: string }>)
    .map((row) => row.name);
  let scrubbedRows = 0;
  if (names.length > 0) {
    const read = db.prepare('SELECT payload FROM sessions WHERE name = ?');
    const readBlob = db.prepare('SELECT text FROM session_blobs WHERE hash = ?');
    const write = db.prepare('UPDATE sessions SET payload = ? WHERE name = ?');
    rowWritesThisTransaction = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const name of names) {
        const payload = (read.get(name) as { payload?: string } | undefined)?.payload;
        if (typeof payload !== 'string') continue;
        let record: Record<string, unknown>;
        try { record = JSON.parse(payload) as Record<string, unknown>; } catch { continue; } // not ours to repair
        const inline = record[SESSION_IDENTITY_PROMPT_FIELD];
        const reference = record[SESSION_IDENTITY_PROMPT_REF_FIELD];
        const text = typeof inline === 'string'
          ? inline
          : typeof reference === 'string' ? (readBlob.get(reference) as { text?: string } | undefined)?.text : undefined;
        if (!removeStoredIdentity(record, text)) continue; // the marker was inside some other text
        noteRowWrite();
        write.run(JSON.stringify(record), name);
        scrubbedRows += 1;
      }
      if (scrubbedRows > 0) {
        collectUnreferencedBlobs(handle);
        db.prepare('INSERT OR REPLACE INTO session_store_meta (key, value) VALUES (?, ?)').run(SESSION_DB_META_IDENTITY_SCRUB, SCRUB_PENDING_VACUUM);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the failure already ended the transaction */ }
      throw error;
    }
  }
  if (scrubbedRows === 0 && marker !== SCRUB_PENDING_VACUUM) return { scrubbedRows: 0, compacted: false };
  const compacted = compactSessionDb(handle);
  if (compacted) db.prepare('INSERT OR REPLACE INTO session_store_meta (key, value) VALUES (?, ?)').run(SESSION_DB_META_IDENTITY_SCRUB, SCRUB_DONE);
  return { scrubbedRows, compacted };
}

/** VACUUM and truncate the log, whatever the free-page thresholds; false when it could not run (the caller retries later). */
function compactSessionDb(handle: SessionDbHandle): boolean {
  try {
    handle.db.exec('VACUUM');
    handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  } catch {
    return false;
  }
}

/**
 * Rows and blobs in ONE read transaction: a reader racing the daemon's blob collection must not see rows from before
 * a commit and blobs from after it (a session would transiently lose its identity text).
 */
export function readSessionStoreSnapshot(handle: SessionDbHandle): { payloads: Map<string, string>; blobs: Map<string, string> } {
  let began = false;
  try {
    handle.db.exec('BEGIN');
    began = true;
  } catch {
    // Without a transaction the two reads below are merely two reads, as before.
  }
  try {
    return { payloads: readSessionPayloads(handle), blobs: readSessionBlobs(handle) };
  } finally {
    if (began) { try { handle.db.exec('COMMIT'); } catch { /* read only: nothing to commit */ } }
  }
}

/**
 * After the rows shrink (a store rewritten from 0.5 MB payloads to references) the file keeps its size as free pages, and
 * so does every snapshot taken from it. Compact once the free pages are large and are most of the file.
 */
export function vacuumSessionDbIfFragmented(handle: SessionDbHandle): { vacuumed: boolean; freeBytes: number } {
  if (handle.readOnly) return { vacuumed: false, freeBytes: 0 };
  try {
    const pageSize = Number((handle.db.prepare('PRAGMA page_size').get() as { page_size: number | bigint }).page_size);
    const pages = Number((handle.db.prepare('PRAGMA page_count').get() as { page_count: number | bigint }).page_count);
    const free = Number((handle.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number | bigint }).freelist_count);
    const freeBytes = free * pageSize;
    if (freeBytes < SESSION_DB_VACUUM_MIN_FREE_BYTES || free * 2 < pages) return { vacuumed: false, freeBytes };
    handle.db.exec('VACUUM');
    handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { vacuumed: true, freeBytes };
  } catch {
    return { vacuumed: false, freeBytes: 0 }; // compaction is an optimisation: never a reason to fail a flush
  }
}

function upsertStatement(handle: SessionDbHandle) {
  return handle.db.prepare(
    `INSERT INTO sessions (name, project_name, parent_session, agent_type, state, updated_at, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       project_name = excluded.project_name, parent_session = excluded.parent_session,
       agent_type = excluded.agent_type, state = excluded.state,
       updated_at = excluded.updated_at, payload = excluded.payload`,
  );
}

function bindRow(row: SessionDbRow): [string, string, string | null, string, string, number, string] {
  return [row.name, row.projectName, row.parentSession, row.agentType, row.state, row.updatedAt, row.payload];
}

/**
 * Apply a change set in ONE transaction: all of it or none of it. On any
 * failure (disk full, a locked database, an injected fault) the transaction is
 * rolled back and the error rethrown, so the last committed state stays intact.
 */
export function commitSessionChanges(
  handle: SessionDbHandle,
  changes: { upserts: SessionDbRow[]; deletes: string[]; allowEmpty: boolean; /** Some row stopped referring to a blob it had. */ collectBlobs?: boolean },
): void {
  if (handle.readOnly) throw new Error('session store connection is read-only');
  const { db } = handle;
  rowWritesThisTransaction = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const upsert = upsertStatement(handle);
    const remove = db.prepare('DELETE FROM sessions WHERE name = ?');
    insertBlobs(handle, changes.upserts);
    for (const row of changes.upserts) { noteRowWrite(); upsert.run(...bindRow(row)); }
    for (const name of changes.deletes) { noteRowWrite(); remove.run(name); }
    if (changes.collectBlobs || changes.deletes.length > 0) collectUnreferencedBlobs(handle);
    if (!changes.allowEmpty && changes.deletes.length > 0 && countSessionRows(handle) === 0) {
      // Emptying the store is an explicit administrative act, never a side effect.
      throw new EmptyStoreRefusal();
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the failure already ended the transaction */ }
    throw error;
  }
}

export class EmptyStoreRefusal extends Error {
  constructor() { super('refusing to empty a non-empty session store'); }
}

/**
 * One-time import of legacy records. Atomic and idempotent: the rows and the
 * "imported" marker commit together, so an interrupted import leaves nothing
 * behind and a retry starts clean; a completed one is never repeated.
 *
 * Rows already in the database ALWAYS win: legacy records are inserted only for
 * names the database does not have (`ON CONFLICT DO NOTHING`, never an upsert). That
 * is what keeps a stale file from overwriting live rows, and it is also what lets an
 * unreadable sessions.json that the user repairs LATER still be migrated when the
 * daemon has written sessions in the meantime -- freezing the repaired file
 * unimported would lose every session that only it knew about.
 * Returns how many rows were inserted and how many names the database already had.
 */
export function importLegacySessions(
  handle: SessionDbHandle,
  rows: SessionDbRow[],
): { imported: number; keptExisting: number } | { skipped: 'already_done' } {
  if (handle.readOnly) throw new Error('session store connection is read-only');
  const { db } = handle;
  rowWritesThisTransaction = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (readSessionDbMeta(handle, SESSION_DB_META_LEGACY_IMPORT) === SESSION_DB_LEGACY_IMPORT_DONE) {
      db.exec('ROLLBACK');
      return { skipped: 'already_done' };
    }
    const insertMissing = db.prepare(
      `INSERT INTO sessions (name, project_name, parent_session, agent_type, state, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    );
    insertBlobs(handle, rows);
    let imported = 0;
    for (const row of rows) {
      noteRowWrite();
      imported += Number(insertMissing.run(...bindRow(row)).changes);
    }
    db.prepare('INSERT OR REPLACE INTO session_store_meta (key, value) VALUES (?, ?)').run(SESSION_DB_META_LEGACY_IMPORT, SESSION_DB_LEGACY_IMPORT_DONE);
    db.exec('COMMIT');
    return { imported, keptExisting: rows.length - imported };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the failure already ended the transaction */ }
    throw error;
  }
}

/** Mark the import done without rows (fresh install: nothing to migrate). */
export function markLegacyImportDone(handle: SessionDbHandle): void {
  handle.db.prepare('INSERT OR REPLACE INTO session_store_meta (key, value) VALUES (?, ?)').run(SESSION_DB_META_LEGACY_IMPORT, SESSION_DB_LEGACY_IMPORT_DONE);
}

/**
 * Online snapshot of the live database into `destination`, consistent even
 * while the daemon keeps writing. Uses the SQLite backup API where this Node
 * has it, and VACUUM INTO (also consistent) otherwise.
 */
export async function snapshotSessionDb(handle: SessionDbHandle, destination: string): Promise<void> {
  if (typeof sqlite.backup === 'function') {
    await sqlite.backup(handle.db, destination);
    return;
  }
  handle.db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
}

/** Row count of a snapshot file, or null when it is not a usable session database. */
export function countSnapshotRows(path: string): number | null {
  let handle: SessionDbHandle | null = null;
  try {
    handle = openSessionDbReadOnly(path);
    return handle ? countSessionRows(handle) : null;
  } catch {
    return null;
  } finally {
    closeSessionDb(handle);
  }
}

export function readSnapshotBlobs(path: string): Map<string, string> {
  let handle: SessionDbHandle | null = null;
  try {
    handle = openSessionDbReadOnly(path);
    return handle ? readSessionBlobs(handle) : new Map();
  } catch {
    return new Map();
  } finally {
    closeSessionDb(handle);
  }
}

export function readSnapshotPayloads(path: string): Map<string, string> | null {
  let handle: SessionDbHandle | null = null;
  try {
    handle = openSessionDbReadOnly(path);
    return handle ? readSessionPayloads(handle) : null;
  } catch {
    return null;
  } finally {
    closeSessionDb(handle);
  }
}
