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
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  LEGACY_JSON_BACKUP_COUNT,
  SESSIONS_JSON_COMPAT_EXPORT_TMP_PATTERN,
  SESSION_DB_BACKUP_COUNT,
  SESSION_DB_BACKUP_INFIX,
  SESSION_DB_BACKUP_TMP_SUFFIX,
  SESSION_IDENTITY_PROMPT_MARKER,
} from '../../shared/session-store-compat.js';

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
