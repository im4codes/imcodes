/**
 * Removal of the copies of the identity prompt that the DAEMON'S OWN rotation left beside the session database.
 *
 * Earlier builds stored the rendered identity prompt (250-550 KB per session) in the database and in sessions.json, and
 * every online snapshot (`sessions.sqlite.bak.N`), pre-SQLite rotation (`sessions.json.N`) and export temp file carries
 * it. The prompt is derived data, so those copies are deleted once the live database no longer has any, and the daemon
 * writes clean ones on its normal schedule.
 *
 * Only names the daemon itself produces (the constants of shared/session-store-compat.ts) are ever deleted, and only
 * when their bytes still hold a stored prompt. Everything else that looks like a session file -- a hand-made
 * `sessions.json.backup-*`, `*.empty-at-*`, the one-time `.migrated-to-sqlite` freeze -- is left alone and only listed
 * (name, size) so the owner decides.
 */
import { existsSync } from 'node:fs';
import { chmod, lstat, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  LEGACY_JSON_BACKUP_COUNT,
  SESSIONS_JSON_COMPAT_EXPORT_TMP_PATTERN,
  SESSION_DB_BACKUP_COUNT,
  SESSION_DB_BACKUP_INFIX,
  SESSION_DB_BACKUP_TMP_SUFFIX,
  SESSION_DB_META_TRANSPORT_CREDENTIAL_SCRUB,
  SESSION_HOOK_CREDENTIAL_FIELD,
  SESSION_HOOK_CREDENTIAL_MARKER,
  SESSION_IDENTITY_PROMPT_MARKER,
} from '../../shared/session-store-compat.js';
import {
  closeSessionDb,
  openSessionDbForWrite,
  openSessionDbReadOnly,
  readSessionDbMeta,
  scrubTransportHookCredentialRows,
} from './session-store-db.js';

const SCAN_CHUNK_BYTES = 1024 * 1024;

export interface IdentityBackupCleanupResult {
  /** Rotation products that held a stored prompt and were deleted. */
  removed: Array<{ name: string; bytes: number }>;
  /** Rotation products that held a stored prompt and could NOT be deleted (they stay; the next start retries). */
  failed: Array<{ name: string; error: string }>;
  /** Files that look like session files but are not the daemon's rotation: never touched. */
  untouched: Array<{ name: string; bytes: number }>;
}

export interface IdentityBackupCleanupDeps {
  removeFile?: (path: string) => Promise<void>;
}

/** Whether the file's bytes contain `needle`, read in bounded chunks (a backup can be 90 MB; this never holds it whole). */
export async function fileContainsText(path: string, needle: string): Promise<boolean> {
  const wanted = Buffer.from(needle, 'utf8');
  const file = await open(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return false;
      const window = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (window.includes(wanted)) return true;
      carry = Buffer.from(window.subarray(Math.max(0, window.length - (wanted.length - 1))));
    }
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function regularFileSize(path: string): Promise<number | null> {
  try {
    const stat = await lstat(path); // never follow a link out of the state directory
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Names of the daemon's rotation products beside the database, by the naming rules of the constants -- nothing else. */
export function rotationProductNames(dbFile: string, jsonFile: string, directoryEntries: readonly string[]): string[] {
  const names = new Set<string>();
  for (let index = 1; index <= SESSION_DB_BACKUP_COUNT; index += 1) names.add(`${dbFile}${SESSION_DB_BACKUP_INFIX}${index}`);
  names.add(`${dbFile}${SESSION_DB_BACKUP_TMP_SUFFIX}`);
  for (let index = 1; index <= LEGACY_JSON_BACKUP_COUNT; index += 1) names.add(`${jsonFile}.${index}`);
  for (const entry of directoryEntries) if (SESSIONS_JSON_COMPAT_EXPORT_TMP_PATTERN.test(entry)) names.add(entry);
  return [...names];
}

/**
 * Delete the rotation products that still hold a stored prompt. Call it ONLY after the live database was cleaned and
 * committed. A file that cannot be deleted is reported and left; nothing here can throw into startup.
 */
export async function cleanupIdentityBackups(
  databasePath: string,
  jsonPath: string,
  deps: IdentityBackupCleanupDeps = {},
): Promise<IdentityBackupCleanupResult> {
  const result: IdentityBackupCleanupResult = { removed: [], failed: [], untouched: [] };
  const directory = dirname(databasePath);
  const dbFile = basename(databasePath);
  const jsonFile = basename(jsonPath);
  const removeFile = deps.removeFile ?? ((path: string) => rm(path));
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return result;
  }
  const rotation = new Set(rotationProductNames(dbFile, jsonFile, entries));
  for (const name of rotation) {
    const path = join(directory, name);
    const bytes = await regularFileSize(path);
    if (bytes === null) continue;
    try {
      if (!await fileContainsText(path, SESSION_IDENTITY_PROMPT_MARKER)) continue;
      await removeFile(path);
      result.removed.push({ name, bytes });
    } catch (error) {
      result.failed.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const live = new Set([dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`, jsonFile]);
  for (const name of entries) {
    if (live.has(name) || rotation.has(name)) continue;
    if (!name.startsWith(`${dbFile}.`) && !name.startsWith(`${jsonFile}.`) && !name.startsWith(`${dbFile}-`)) continue;
    const bytes = await regularFileSize(join(directory, name));
    if (bytes !== null) result.untouched.push({ name, bytes });
  }
  return result;
}

const SQLITE_MAGIC_HEADER = Buffer.from('SQLite format 3\0', 'ascii');

async function isSqliteDatabaseFile(path: string): Promise<boolean> {
  try {
    const file = await open(path, 'r');
    try {
      const header = Buffer.alloc(SQLITE_MAGIC_HEADER.length);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.equals(SQLITE_MAGIC_HEADER);
    } finally {
      await file.close().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

async function enforceOwnerModeAsync(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600);
}

function readCertifiedCleanSnapshotMeta(path: string): boolean {
  const walExisted = existsSync(`${path}-wal`);
  const shmExisted = existsSync(`${path}-shm`);
  if (walExisted || shmExisted) return false;
  let handle = null as ReturnType<typeof openSessionDbReadOnly>;
  try {
    handle = openSessionDbReadOnly(path);
    return handle !== null && readSessionDbMeta(handle, SESSION_DB_META_TRANSPORT_CREDENTIAL_SCRUB) === 'done';
  } catch {
    return false;
  } finally {
    closeSessionDb(handle);
    if (!walExisted) void rm(`${path}-wal`, { force: true }).catch(() => undefined);
    if (!shmExisted) void rm(`${path}-shm`, { force: true }).catch(() => undefined);
  }
}

async function fileOrWalContainsMarker(path: string, marker: string): Promise<boolean> {
  if (await fileContainsText(path, marker)) return true;
  if (existsSync(`${path}-wal`)) {
    try {
      if (await fileContainsText(`${path}-wal`, marker)) return true;
    } catch { /* ignore unreadable wal probe */ }
  }
  return false;
}

/**
 * Upgrade-only redaction for `sessions.json` and daemon-generated `sessions.json.migrated-to-sqlite`.
 * Runs after a durable SQLite import, independent of normal compat-export sunset/size budgets,
 * stripping `hookCredential` while preserving all recoverable session records and atomic 0o600 mode.
 */
export async function redactLegacyJsonCredentialFile(
  filePath: string,
): Promise<{ redacted: boolean; error?: string }> {
  const bytes = await regularFileSize(filePath);
  if (bytes === null) return { redacted: false };
  try {
    await enforceOwnerModeAsync(filePath);
  } catch (error) {
    return { redacted: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (!await fileContainsText(filePath, SESSION_HOOK_CREDENTIAL_MARKER)) return { redacted: false };
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { redacted: false, error: 'legacy JSON root is not an object' };
    }
    const root = parsed as Record<string, unknown>;
    const sessions = root['sessions'];
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
      return { redacted: false };
    }
    let changed = false;
    for (const entry of Object.values(sessions as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && SESSION_HOOK_CREDENTIAL_FIELD in entry) {
        delete (entry as Record<string, unknown>)[SESSION_HOOK_CREDENTIAL_FIELD];
        changed = true;
      }
    }
    if (!changed) return { redacted: false };
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(root), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await enforceOwnerModeAsync(tmp);
      await rename(tmp, filePath);
      return { redacted: true };
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return { redacted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove daemon rotation files (`sessions.json.*`, `sessions.json.<pid>.<uuid>.tmp`) that still
 * hold any `hookCredential`, sanitize/compact legacy SQLite backup snapshots (`sessions.sqlite.bak.*`,
 * removing transport credentials from rows, free pages, and WAL while preserving process-session
 * backups), and normalize retained daemon rotation copy permissions to `0o600`.
 */
export async function cleanupLegacyCredentialBackups(
  databasePath: string,
  jsonPath: string,
  deps: IdentityBackupCleanupDeps = {},
): Promise<Pick<IdentityBackupCleanupResult, 'removed' | 'failed'> & { sanitized: Array<{ name: string; bytes: number }> }> {
  const result: Pick<IdentityBackupCleanupResult, 'removed' | 'failed'> & { sanitized: Array<{ name: string; bytes: number }> } = {
    removed: [],
    sanitized: [],
    failed: [],
  };
  const directory = dirname(databasePath);
  const dbFile = basename(databasePath);
  const jsonFile = basename(jsonPath);
  const removeFile = deps.removeFile ?? ((path: string) => rm(path));
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return result;
  }
  const dbBackupTmpName = `${dbFile}${SESSION_DB_BACKUP_TMP_SUFFIX}`;
  const dbBackupPrefix = `${dbFile}${SESSION_DB_BACKUP_INFIX}`;
  const rotation = rotationProductNames(dbFile, jsonFile, entries);
  for (const name of rotation) {
    const path = join(directory, name);
    const bytes = await regularFileSize(path);
    if (bytes === null) continue;
    try {
      const isDbSnapshot = name === dbBackupTmpName || name.startsWith(dbBackupPrefix);
      if (!isDbSnapshot) {
        if (await fileContainsText(path, SESSION_HOOK_CREDENTIAL_MARKER)) {
          await removeFile(path);
          result.removed.push({ name, bytes });
        } else {
          await enforceOwnerModeAsync(path);
        }
        continue;
      }

      if (name === dbBackupTmpName) {
        if (await fileOrWalContainsMarker(path, SESSION_HOOK_CREDENTIAL_MARKER)) {
          await removeFile(path);
          await rm(`${path}-wal`, { force: true }).catch(() => undefined);
          await rm(`${path}-shm`, { force: true }).catch(() => undefined);
          result.removed.push({ name, bytes });
        } else {
          await enforceOwnerModeAsync(path);
        }
        continue;
      }

      if (!await isSqliteDatabaseFile(path)) {
        if (await fileOrWalContainsMarker(path, SESSION_HOOK_CREDENTIAL_MARKER)) {
          await removeFile(path);
          result.removed.push({ name, bytes });
        } else {
          await enforceOwnerModeAsync(path);
        }
        continue;
      }

      if (readCertifiedCleanSnapshotMeta(path)) {
        await enforceOwnerModeAsync(path);
        continue;
      }

      // Legacy or uncertified SQLite backup snapshot: enforce 0o600, scrub transport credentials,
      // VACUUM free pages, and verify WAL truncation (busy === 0) while preserving process continuity.
      let bakHandle: ReturnType<typeof openSessionDbForWrite> | null = null;
      let scrubOutcome: { scrubbedRows: number; compacted: boolean } | null = null;
      try {
        bakHandle = openSessionDbForWrite(path);
        scrubOutcome = scrubTransportHookCredentialRows(bakHandle);
      } finally {
        closeSessionDb(bakHandle);
      }
      if (!scrubOutcome.compacted) {
        result.failed.push({ name, error: 'snapshot WAL checkpoint busy; retry deferred' });
        continue;
      }
      await rm(`${path}-wal`, { force: true }).catch(() => undefined);
      await rm(`${path}-shm`, { force: true }).catch(() => undefined);
      await enforceOwnerModeAsync(path);
      result.sanitized.push({ name, bytes });
    } catch (error) {
      result.failed.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
