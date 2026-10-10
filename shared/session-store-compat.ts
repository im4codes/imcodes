/**
 * The write-only `sessions.json` compatibility export.
 *
 * The session store lives in SQLite, and the database is the ONLY source of
 * truth: nothing in a build that has the database reads `sessions.json`, except
 * the one-time migration and the read-only fallback while no migrated database
 * exists. The daemon nevertheless keeps writing a v2-format `sessions.json`
 * beside the database so that processes still running OLDER builds (a memory
 * MCP stdio server inside a long-lived tmux agent, an old cli, a downgraded
 * daemon) keep seeing current sessions instead of a stale rotated backup.
 *
 * Removal is ONE switch: `isSessionsJsonCompatExportEnabled` turns false at the
 * sunset instant. Removing the feature afterwards means deleting the export in
 * `src/store/session-store.ts` (marked with this module's name).
 */

/** Bumped when the export layout changes in a way an older reader must be told about. */
export const SESSIONS_JSON_COMPAT_EXPORT_FORMAT_VERSION = 1;

/** Top-level key carrying the format marker; older readers ignore unknown top-level keys. */
export const SESSIONS_JSON_COMPAT_EXPORT_MARKER_KEY = 'sessionStoreCompatExport';

/** At most one export per this long, and only after a flush that committed changed rows. */
export const SESSIONS_JSON_COMPAT_EXPORT_MIN_INTERVAL_MS = 5_000;

/** Documented transition period: the export stops being written from this instant on. */
export const SESSIONS_JSON_COMPAT_EXPORT_SUNSET_AT_MS = Date.UTC(2027, 0, 1);

export function isSessionsJsonCompatExportEnabled(nowMs: number = Date.now()): boolean {
  return nowMs < SESSIONS_JSON_COMPAT_EXPORT_SUNSET_AT_MS;
}

/**
 * A top-level string field of a session record longer than this many UTF-16 units is stored ONCE in the
 * database's blob table (keyed by its hash) and the record keeps only a reference. This is a bound for any large
 * field; the identity prompt is NOT one of them any more: it is not stored at all (see SESSION_IDENTITY_PROMPT_FIELD).
 * 158 (2026-10-07): 117 of 180 records each carried their own 250-550 KB copy of one of nine user identity contracts, so
 * the store grew from 8.4 MB to 84 MB after the SQLite migration, and every sweep / export serialised 45 MB.
 */
export const SESSION_RECORD_INLINE_STRING_MAX_CHARS = 4096;

/**
 * The rendered identity contract is derived data (user / project / session profiles, rendered at the moment a session
 * launches or its identity is refreshed), never session state: a session record carries none of these fields, a row that
 * still has one is migrated (SESSION_DB_META_IDENTITY_SCRUB) and a record that is read never exposes one.
 */
export const SESSION_IDENTITY_PROMPT_FIELD = 'identityPrompt';
/** The reference name the previous build stored the prompt's blob under. */
export const SESSION_IDENTITY_PROMPT_REF_FIELD = 'identityPromptRef';
/** Substring that is in every payload / file that still holds a stored prompt (inline, reference, or the sessions.json table). */
export const SESSION_IDENTITY_PROMPT_MARKER = `"${SESSION_IDENTITY_PROMPT_FIELD}`;
/** Recorded in session_store_meta once the stored prompts were removed (a rescan on every start still catches an older build's writes). */
export const SESSION_DB_META_IDENTITY_SCRUB = 'identity_prompt_scrub';

// --- Files the daemon itself rotates beside the database ---------------------------------------------------------
// ONLY names built from these are ever deleted by the identity cleanup; every other file is listed, never touched.
/** `sessions.sqlite.bak.1` .. `.bak.N`: online snapshots of the database (newest = 1). */
export const SESSION_DB_BACKUP_INFIX = '.bak.';
export const SESSION_DB_BACKUP_COUNT = 3;
/** A snapshot being written; renamed to `.bak.1` when complete. */
export const SESSION_DB_BACKUP_TMP_SUFFIX = '.bak.tmp';
/** `sessions.json.1` .. `.N`: the pre-SQLite whole-file rotation (newest = 1). */
export const LEGACY_JSON_BACKUP_COUNT = 5;
/** The one-time freeze of the migrated sessions.json. Not a rotation: never deleted automatically. */
export const LEGACY_JSON_FROZEN_SUFFIX = '.migrated-to-sqlite';
/** `sessions.json.<pid>.<uuid>.tmp`: the compatibility export's temporary file (left behind only by a crash mid-write). */
export const SESSIONS_JSON_COMPAT_EXPORT_TMP_PATTERN = /^sessions\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;

/** The session database is compacted (VACUUM) once its free pages exceed this and are at least half the file. */
export const SESSION_DB_VACUUM_MIN_FREE_BYTES = 16 * 1024 * 1024;

/** The compatibility export is skipped (the file stays as it was) past this size; its cost is main-thread time. */
export const SESSIONS_JSON_COMPAT_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

/** After a checkpoint the write-ahead log is truncated to at most this much (it sat at 84 MB beside an 86 MB database). */
export const SESSION_DB_WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;
