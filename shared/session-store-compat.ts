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
 * database's blob table (keyed by its hash) and the record keeps only a reference. 158 (2026-10-07): 117 of
 * 180 records each carried their own 250-550 KB copy of one of nine user identity contracts (`identityPrompt`),
 * so the store grew from 8.4 MB (sessions.json, which de-duplicated them in `identityPrompts`) to 84 MB after the
 * SQLite migration (payload per row, no de-duplication), and every sweep / export serialised 45 MB.
 */
export const SESSION_RECORD_INLINE_STRING_MAX_CHARS = 4096;

/** The compatibility export is skipped (the file stays as it was) past this size; its cost is main-thread time. */
export const SESSIONS_JSON_COMPAT_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

/** After a checkpoint the write-ahead log is truncated to at most this much (it sat at 84 MB beside an 86 MB database). */
export const SESSION_DB_WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;
